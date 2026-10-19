/** `sourceEventSeqs` 数组面向 JSONL 的无损范围编码。 */

import { SessionSeq } from './types.ts'
import type { SessionSeq as SessionSeqType } from './types.ts'

/** 一个存储的来源序号或含端点连续范围。 */
export type EncodedSeq = number | [number, number]

function isStrictlyIncreasing(values: readonly SessionSeqType[]): boolean {
  return values.every((value, index) => index === 0 || value > (values[index - 1] as SessionSeqType))
}

/**
 * 把有收益的连续运行替换为含端点数对。
 * @param values - 已验证的内存中来源序号。
 * @returns 无损的 JSON 存储形态。
 */
export function encodeSeqRanges(values: readonly SessionSeqType[]): EncodedSeq[] {
  if (!isStrictlyIncreasing(values)) return [...values]
  const encoded: EncodedSeq[] = []
  for (let start = 0; start < values.length;) {
    let end = start
    while (end + 1 < values.length && values[end + 1] === (values[end] as number) + 1) end += 1
    if (end - start >= 2) encoded.push([values[start] as number, values[end] as number])
    else for (let index = start; index <= end; index += 1) encoded.push(values[index] as number)
    start = end + 1
  }
  return encoded
}

/**
 * 展开一个 JSON 存储形态的来源序号数组。
 * @param value - 已解析的存储值。
 * @param maxEntries - 所属事件允许的最大列表长度。
 * @returns 内存中的来源序号。
 */
export function decodeSeqRanges(value: unknown, maxEntries = Number.MAX_SAFE_INTEGER): SessionSeqType[] {
  if (!Array.isArray(value)) throw new TypeError('sourceEventSeqs must be an array')
  const decoded: SessionSeqType[] = []
  let hasRange = false
  for (const entry of value) {
    if (typeof entry === 'number') {
      assertSeq(entry)
      if (decoded.length >= maxEntries) throw new TypeError('sourceEventSeqs exceeds its event sequence')
      decoded.push(SessionSeq(entry))
      continue
    }
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new TypeError('sourceEventSeqs range entries must be [start, end] pairs')
    }
    const start: unknown = entry[0]
    const end: unknown = entry[1]
    assertSeq(start)
    assertSeq(end)
    if (end < start) throw new TypeError('sourceEventSeqs ranges require start <= end')
    const length = end - start + 1
    if (length > maxEntries - decoded.length) {
      throw new TypeError('sourceEventSeqs range exceeds its event sequence')
    }
    for (let seq = start; seq <= end; seq += 1) decoded.push(SessionSeq(seq))
    hasRange = true
  }
  if (hasRange && !isStrictlyIncreasing(decoded)) {
    throw new TypeError('sourceEventSeqs ranges must be strictly increasing')
  }
  return decoded
}

function assertSeq(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError('sourceEventSeqs must contain non-negative safe integers')
  }
}
