/** 确定性的、与提供方无关的图像归一化。 */

import type { Sharp } from 'sharp'
import { AttachmentError, requestImageDimensions } from '@deepseek-ai/dsh-attachment'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { encodeFirstWithinLimit, encodingLadder, isExhaustedEncoding } from './encoding.ts'
import { detectImage, encodedAlphaIsCompatible } from './image.ts'
import type { DetectedImage } from './image.ts'
import { requireSharp } from './sharp.ts'

/** 部署时解析的持久化归一化附件策略。 */
export interface NormalizationPolicy {
  /** 总像素预算；更大的源按比例缩小。 */
  maxPixels: number
  /** 在总像素预算之后应用的长边像素上限，约束极端宽高比。 */
  maxDimension: number
  /** 质量阶梯的编码字节目标；没有质量档符合时保留阶梯最小输出。 */
  maxBytes: number
}

/** 归一化字节，以及持久引用所记录的事实。 */
export interface NormalizedImage {
  data: Uint8Array
  mediaType: ImageMediaType
  width: number
  height: number
}

/**
 * 字节是否已满足归一化要求。
 * @param detected - 完整解码的源事实。
 * @param bytes - 编码源的长度。
 * @param policy - 已解析的归一化限制。
 * @returns 源能否逐字节原样通过。
 */
export function canPassThroughNormalization(
  detected: DetectedImage,
  bytes: number,
  policy: NormalizationPolicy,
): boolean {
  return detected.mediaType !== 'image/gif'
    && !detected.animated
    && !detected.carriesMetadata
    && detected.depth === 'uchar'
    && detected.space === 'srgb'
    && bytes <= policy.maxBytes
    && detected.width * detected.height <= policy.maxPixels
    && Math.max(detected.width, detected.height) <= policy.maxDimension
}

/** 断言归一化输出是事实相符的 8-bit sRGB/sRGBA 单帧图像。 */
async function verifyNormalizedImage(
  image: NormalizedImage,
  expectedAlpha: boolean | undefined,
): Promise<NormalizedImage> {
  const detected = await detectImage(image.data)
  if (detected.mediaType !== image.mediaType
    || detected.width !== image.width
    || detected.height !== image.height
    || detected.animated
    || detected.carriesMetadata
    || detected.depth !== 'uchar'
    || detected.space !== 'srgb'
    || !encodedAlphaIsCompatible(expectedAlpha, detected)) {
    throw new AttachmentError(
      'Image normalization did not produce a single-frame 8-bit sRGB image with matching metadata.',
      'ATTACHMENT_WRITE_FAILED',
    )
  }
  return image
}

/** 从提交的字节构建一个固定尺寸、已应用 EXIF 方向、无元数据的 sRGB 流水线。 */
function preparedPipeline(
  sharp: ReturnType<typeof requireSharp>,
  data: Uint8Array,
  width: number,
  height: number,
): Sharp {
  return sharp(data, { failOn: 'error', limitInputPixels: false })
    .rotate()
    .toColourspace('srgb')
    .resize({ width, height, fit: 'inside', withoutEnlargement: true })
}

/** 先按总像素预算、再按长边上限求尺寸，且不改变宽高比。 */
function initialDimensions(detected: DetectedImage, policy: NormalizationPolicy): { width: number; height: number } {
  const budgeted = requestImageDimensions(detected.width, detected.height, policy.maxPixels)
  const longEdge = Math.max(budgeted.width, budgeted.height)
  if (longEdge <= policy.maxDimension) return budgeted
  const scale = policy.maxDimension / longEdge
  return {
    width: Math.max(1, Math.floor(budgeted.width * scale)),
    height: Math.max(1, Math.floor(budgeted.height * scale)),
  }
}

/**
 * 为一个完整解码的源产出持久化的、与提供方无关的归一化版本。
 * 仅当源本身已干净、单帧、8-bit sRGB/sRGBA 且处于所有归一化限制
 * 之内时才原样通过。重新编码绝不会移除透明度。当阶梯的每个
 * 质量档都超出字节目标时，保留阶梯最小输出；提供方字节上限仍由
 * 传输这些字节的路由强制执行。
 * @param data - 完整的已准入源字节。
 * @param detected - 完整解码的源事实。
 * @param policy - 已解析的独立归一化限制。
 * @returns 校验通过的与提供方无关的归一化字节与元数据。
 */
export async function normalizeImage(
  data: Uint8Array,
  detected: DetectedImage,
  policy: NormalizationPolicy,
): Promise<NormalizedImage> {
  if (canPassThroughNormalization(detected, data.byteLength, policy)) {
    return { data, mediaType: detected.mediaType, width: detected.width, height: detected.height }
  }
  const sharp = requireSharp()
  try {
    const { width, height } = initialDimensions(detected, policy)
    const encoded = await encodeFirstWithinLimit(
      encodingLadder(preparedPipeline(sharp, data, width, height), detected.hasAlpha),
      policy.maxBytes,
    )
    const chosen = isExhaustedEncoding(encoded) ? encoded.smallest : encoded
    return await verifyNormalizedImage(chosen, detected.mediaType === 'image/gif' ? undefined : detected.hasAlpha)
  } catch (error) {
    if (error instanceof AttachmentError) throw error
    const source = detected.mediaType === 'image/png' && detected.depth !== 'uchar'
      ? `${detected.depth === 'ushort' ? '16-bit' : detected.depth} PNG`
      : `${detected.depth} ${detected.mediaType.slice('image/'.length).toUpperCase()}`
    throw new AttachmentError(
      `The ${source} could not be converted to the normalized 8-bit sRGB form.`,
      'ATTACHMENT_WRITE_FAILED',
      { cause: error },
    )
  }
}
