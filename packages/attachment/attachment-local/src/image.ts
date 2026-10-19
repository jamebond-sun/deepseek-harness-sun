/** 栅格检查：准入时完整解码，已校验读取时仅探测头部。 */

import type { Sharp } from 'sharp'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { requireSharp } from './sharp.ts'

/** 受支持图像的解码元数据。 */
export interface DetectedImage {
  mediaType: ImageMediaType
  /** 应用 EXIF 方向后的固有宽度——即观看者感知的宽度。 */
  width: number
  /** 应用 EXIF 方向后的固有高度——即观看者感知的高度。 */
  height: number
  /** 容器是否携带多于一帧。 */
  animated: boolean
  /** 字节是否携带描述性元数据、色彩配置文件或方向信息。 */
  carriesMetadata: boolean
  /** Sharp 为解码通道报告的采样位深。 */
  depth: string
  /** Sharp 为解码像素报告的色彩空间。 */
  space: string
  /** 解码像素是否携带 alpha 通道。 */
  hasAlpha: boolean
}

/**
 * 检查本包编码器产出的字节的 alpha 元数据。
 * Sharp/libvips 可能从 WebP 输出中省略完全不透明的 alpha 平面；除此之外
 * 任何新增或移除都表明编码结果与其源事实不兼容。
 * @param sourceHasAlpha - 源字节是否声明 alpha 平面；源帧未指明时为 undefined。
 * @param output - 编码结果解码出的媒体类型与 alpha 元数据。
 * @returns 输出的 alpha 元数据是否与源兼容。
 */
export function encodedAlphaIsCompatible(
  sourceHasAlpha: boolean | undefined,
  output: Pick<DetectedImage, 'mediaType' | 'hasAlpha'>,
): boolean {
  return sourceHasAlpha === undefined
    || output.hasAlpha === sourceHasAlpha
    || (sourceHasAlpha && !output.hasAlpha && output.mediaType === 'image/webp')
}

const MEDIA_TYPES: Readonly<Record<string, ImageMediaType>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

function carriesRetainedMetadata(metadata: Awaited<ReturnType<Sharp['metadata']>>): boolean {
  return metadata.exif !== undefined
    || metadata.xmp !== undefined
    || metadata.iptc !== undefined
    || metadata.icc !== undefined
    || metadata.hasProfile
    || metadata.tifftagPhotoshop !== undefined
    || metadata.comments !== undefined
    || metadata.orientation !== undefined
}

async function imageMetadata(image: Sharp): Promise<DetectedImage> {
  const metadata = await image.metadata()
  const mediaType = MEDIA_TYPES[metadata.format as string]
  if (mediaType === undefined) {
    throw new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE')
  }
  // EXIF 方向 5-8 会转置存储的栅格；报告感知轴，
  // 使限制、源事实与坐标建议共享同一组轴。
  const transposed = metadata.orientation !== undefined && metadata.orientation >= 5
  return {
    mediaType,
    width: transposed ? metadata.height : metadata.width,
    height: transposed ? metadata.width : metadata.height,
    animated: (metadata.pages ?? 1) > 1,
    carriesMetadata: carriesRetainedMetadata(metadata),
    depth: metadata.depth,
    space: metadata.space,
    hasAlpha: metadata.hasAlpha,
  }
}

/**
 * 解析受支持栅格的头部并返回其固有元数据，不解码像素。
 * 经摘要校验的读取使用此方法：准入阶段已证明这些确切字节可完整解码，
 * 因此读取路径只需重新推导引用字段，而不必再次付出完整栅格解码的代价。
 * @param data - 完整的编码图像字节。
 * @returns 校验通过的格式与尺寸。
 */
export async function probeImage(data: Uint8Array): Promise<DetectedImage> {
  const sharp = requireSharp()
  try {
    return await imageMetadata(sharp(data, { failOn: 'error', limitInputPixels: false }))
  } catch (error) {
    if (error instanceof AttachmentError) throw error
    throw new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE', { cause: error })
  }
}

/** 应用于解码栅格固有尺寸的准入限制。 */
export interface DecodedImageLimits {
  /** 解码像素（宽乘高）的准入限制。 */
  maxPixels?: number
  /** 分别应用于宽度与高度的单边准入限制。 */
  maxDimension?: number
}

/**
 * 完整解码一个受支持的栅格并返回其固有元数据。
 * @param data - 完整的编码图像字节。
 * @param limits - 固有尺寸的准入限制。
 * @returns 校验通过的格式与尺寸。
 */
export async function detectImage(data: Uint8Array, limits?: DecodedImageLimits): Promise<DetectedImage> {
  const sharp = requireSharp()
  try {
    const image = sharp(data, { failOn: 'error', limitInputPixels: false })
    const detected = await imageMetadata(image)
    if (limits?.maxPixels !== undefined && detected.width * detected.height > limits.maxPixels) {
      throw new AttachmentError('Image exceeds the configured decoded-pixel limit.', 'IMAGE_TOO_MANY_PIXELS')
    }
    if (limits?.maxDimension !== undefined && Math.max(detected.width, detected.height) > limits.maxDimension) {
      throw new AttachmentError('Image exceeds the configured per-side pixel limit.', 'IMAGE_DIMENSION_TOO_LARGE')
    }
    await image.raw().toBuffer()
    return detected
  } catch (error) {
    if (error instanceof AttachmentError) throw error
    throw new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE', { cause: error })
  }
}
