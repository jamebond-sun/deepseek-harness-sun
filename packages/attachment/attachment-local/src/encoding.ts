/** 归一化与请求图像编码器共用的质量阶梯与惰性候选执行。 */

import type { Sharp } from 'sharp'

/** 两个编码器共用的阶梯：间距设计使每一步都换来实际的体积缩减。 */
export const IMAGE_ENCODING_QUALITIES = [85, 75, 60] as const
/** 固定的有损 WebP effort；更深的搜索以 3-4 倍编码时间换来约 5% 的体积缩减。 */
export const WEBP_ENCODING_EFFORT = 0

/** 携带完整字节与确切事实的单个阶梯输出。 */
export interface EncodedImage {
  data: Uint8Array
  mediaType: 'image/jpeg' | 'image/webp'
  width: number
  height: number
}

async function encode(pipeline: Sharp, mediaType: EncodedImage['mediaType'], quality: number): Promise<EncodedImage> {
  const encoded = mediaType === 'image/webp'
    ? pipeline.webp({ quality, effort: WEBP_ENCODING_EFFORT })
    : pipeline.jpeg({ quality })
  const { data, info } = await encoded.toBuffer({ resolveWithObject: true })
  return { data: new Uint8Array(data), mediaType, width: info.width, height: info.height }
}

/**
 * 为一个准备好的流水线构建惰性质量阶梯：WebP 保留源 alpha 通道，
 * 其余情况均为 JPEG。
 * @param prepared - 已定尺寸的 sRGB 流水线；每个候选拷贝一次。
 * @param hasAlpha - 解码出的源 alpha 事实，用于选择编码器。
 * @returns 按阶梯质量从高到低排序的编码器。
 */
export function encodingLadder(prepared: Sharp, hasAlpha: boolean): Array<() => Promise<EncodedImage>> {
  const mediaType = hasAlpha ? 'image/webp' : 'image/jpeg'
  return IMAGE_ENCODING_QUALITIES.map(quality => (
    () => encode(prepared.clone(), mediaType, quality)
  ))
}

/** 携带完整字节的单个编码候选。 */
export interface EncodedCandidate {
  data: Uint8Array
}

/** 在一个栅格尺寸下穷尽所有候选且无符合目标的输出时的结果。 */
export interface ExhaustedEncoding<T extends EncodedCandidate> {
  smallest: T
}

/**
 * 按优先顺序执行编码候选，并在首个符合目标的输出后停止。
 * @param attempts - 按从首选到回退表示排序的惰性编码器。
 * @param maxBytes - 正的编码字节目标。
 * @returns 首个符合目标的候选，否则为已完成的最小回退结果。
 */
export async function encodeFirstWithinLimit<T extends EncodedCandidate>(
  attempts: readonly (() => Promise<T>)[],
  maxBytes: number,
): Promise<T | ExhaustedEncoding<T>> {
  const [first, ...remaining] = attempts
  if (first === undefined) throw new Error('image encoding requires at least one candidate')
  let smallest = await first()
  if (smallest.data.byteLength <= maxBytes) return smallest
  for (const attempt of remaining) {
    const candidate = await attempt()
    if (candidate.data.byteLength <= maxBytes) return candidate
    if (candidate.data.byteLength < smallest.data.byteLength) {
      smallest = candidate
    }
  }
  return { smallest }
}

/**
 * 惰性编码结果是否在一个尺寸下穷尽了所有候选。
 * @param result - 首个符合目标的候选或穷尽结果。
 * @returns 是否所有候选都超出了字节目标。
 */
export function isExhaustedEncoding<T extends EncodedCandidate>(
  result: T | ExhaustedEncoding<T>,
): result is ExhaustedEncoding<T> {
  return 'smallest' in result
}
