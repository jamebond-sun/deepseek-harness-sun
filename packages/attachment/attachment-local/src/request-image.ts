/** 面向模型请求的确定性缓存图像版本。 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Sharp } from 'sharp'
import { AttachmentError, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type {
  ImageMediaType,
  ImageAttachmentRef,
  ImageRequestTarget,
  RequestImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import {
  IMAGE_ENCODING_QUALITIES,
  WEBP_ENCODING_EFFORT,
  encodeFirstWithinLimit,
  encodingLadder,
  isExhaustedEncoding,
} from './encoding.ts'
import { detectImage, encodedAlphaIsCompatible, probeImage } from './image.ts'
import { requireSharp } from './sharp.ts'

/** 包含在每个缓存与上传索引标识中的变换版本。 */
export const REQUEST_IMAGE_TRANSFORM_VERSION = 'request-image-v6'

interface EncodedRequestImage {
  data: Uint8Array
  mediaType: ImageMediaType
  width: number
  height: number
}

interface VerifiedRequestImage extends EncodedRequestImage {
  hasAlpha: boolean
}

function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function checkedInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AttachmentError(`${name} must be a positive integer.`, 'INVALID_ATTACHMENT_REF')
  }
  return value
}

function validateTarget(target: ImageRequestTarget): void {
  checkedInteger(target.width, 'Image request width')
  checkedInteger(target.height, 'Image request height')
  checkedInteger(target.maxBytes, 'Image request maxBytes')
}

function descriptor(attachment: ImageAttachmentRef, target: ImageRequestTarget): string {
  return JSON.stringify({
    transformVersion: REQUEST_IMAGE_TRANSFORM_VERSION,
    attachmentId: attachment.attachmentId,
    targetWidth: target.width,
    targetHeight: target.height,
    encodedByteBudget: target.maxBytes,
    encoding: {
      webpQualities: IMAGE_ENCODING_QUALITIES,
      webpEffort: WEBP_ENCODING_EFFORT,
      jpegQualities: IMAGE_ENCODING_QUALITIES,
      order: ['alpha:webp', 'opaque:jpeg'],
      colourspace: 'srgb',
    },
  })
}

/**
 * 一个附件与路由所选请求目标的完整确定性标识。
 * @param attachment - 与提供方无关的持久归一化附件引用。
 * @param target - 路由所选的尺寸与字节目标。
 * @returns 覆盖全部请求变换输入的 branded 摘要。
 */
export function requestImageVariantId(
  attachment: ImageAttachmentRef,
  target: ImageRequestTarget,
): ReturnType<typeof ImageVariantId> {
  return ImageVariantId(`sha256:${digest(descriptor(attachment, target))}`)
}

/** 仅按源长边缩放，使编码器按路由预测的方式推导短边。 */
function pipeline(attachment: StoredImageAttachment, target: ImageRequestTarget): Sharp {
  const byWidth = attachment.ref.width >= attachment.ref.height
  return sourcePipeline(attachment)
    .resize({ ...byWidth ? { width: target.width } : { height: target.height }, withoutEnlargement: true })
}

function sourcePipeline(attachment: StoredImageAttachment): Sharp {
  const sharp = requireSharp()
  return sharp(attachment.data, { failOn: 'error', limitInputPixels: false }).toColourspace('srgb')
}

async function createRequestImage(
  attachment: StoredImageAttachment,
  target: ImageRequestTarget,
  hasAlpha: boolean,
): Promise<EncodedRequestImage> {
  if (target.width >= attachment.ref.width
    && target.height >= attachment.ref.height
    && attachment.data.byteLength <= target.maxBytes) {
    return {
      data: attachment.data,
      mediaType: attachment.ref.mediaType,
      width: attachment.ref.width,
      height: attachment.ref.height,
    }
  }
  const encodedVersion = await encodeFirstWithinLimit(
    encodingLadder(pipeline(attachment, target), hasAlpha),
    target.maxBytes,
  )
  return isExhaustedEncoding(encodedVersion) ? encodedVersion.smallest : encodedVersion
}

function cachePath(root: string, hash: string): string {
  return join(root, 'request-images', hash.slice(0, 2), hash)
}

async function readCached(
  path: string,
  target: ImageRequestTarget,
  expectedAlpha: boolean,
  signal?: AbortSignal,
): Promise<VerifiedRequestImage | undefined> {
  try {
    const data = new Uint8Array(await readFile(path, { signal }))
    const detected = await probeImage(data)
    if (detected.depth !== 'uchar' || detected.space !== 'srgb'
      || detected.width > target.width || detected.height > target.height
      || !encodedAlphaIsCompatible(expectedAlpha, detected)) return undefined
    return { data, mediaType: detected.mediaType, width: detected.width, height: detected.height, hasAlpha: detected.hasAlpha }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined
    signal?.throwIfAborted()
    return undefined
  }
}

async function verifyRequestImage(
  image: EncodedRequestImage,
  expectedAlpha: boolean,
): Promise<VerifiedRequestImage> {
  const detected = await detectImage(image.data)
  if (detected.depth !== 'uchar' || detected.space !== 'srgb'
    || detected.width !== image.width || detected.height !== image.height
    || detected.mediaType !== image.mediaType || !encodedAlphaIsCompatible(expectedAlpha, detected)) {
    throw new AttachmentError(
      'Encoded model-request image does not match its verified 8-bit sRGB metadata.',
      'ATTACHMENT_WRITE_FAILED',
    )
  }
  return { ...image, hasAlpha: detected.hasAlpha }
}

async function writeCached(path: string, data: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, data, { mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

/**
 * 在本地附件缓存根目录下生成或复用一张请求图像。
 * @param root - 绝对的附件缓存根目录；变体使用其 `request-images` 子目录。
 * @param attachment - 已校验的归一化附件字节与引用。
 * @param target - 确切的路由所选尺寸与字节目标；目标大于源尺寸时保持源尺寸。
 * @param signal - 可选的取消信号，作用于缓存 I/O 与图像变换。
 * @returns 校验通过的请求字节与确定性变体标识。
 */
export async function readRequestImageFile(
  root: string,
  attachment: StoredImageAttachment,
  target: ImageRequestTarget,
  signal?: AbortSignal,
): Promise<RequestImageAttachment> {
  signal?.throwIfAborted()
  validateTarget(target)
  const source = await probeImage(attachment.data)
  const variantId = requestImageVariantId(attachment.ref, target)
  const hash = String(variantId).slice('sha256:'.length)
  const path = cachePath(root, hash)
  const cached = await readCached(path, target, source.hasAlpha, signal)
  const created = cached ?? await createRequestImage(attachment, target, source.hasAlpha)
  const version = cached ?? (created.data === attachment.data
    ? { ...created, hasAlpha: source.hasAlpha }
    : await verifyRequestImage(created, source.hasAlpha))
  signal?.throwIfAborted()
  if (cached === undefined && version.data !== attachment.data) await writeCached(path, version.data)
  return {
    variantId,
    attachment: attachment.ref,
    data: version.data,
    mediaType: version.mediaType,
    bytes: version.data.byteLength,
    width: version.width,
    height: version.height,
    depth: 'uchar',
    space: 'srgb',
    hasAlpha: version.hasAlpha,
  }
}
