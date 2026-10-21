/**
 * 一个任务背后的有界输出环形缓冲区：位于绝对字节偏移上的块、从不移动已分配偏移的
 * 头部淘汰，以及从任意偏移开始的非消费型读取。
 * @module @deepseek-ai/dsh-jobs-local/ring
 */

import type { JobAppendOptions, JobChannel, JobOutputRead } from '@deepseek-ai/dsh-jobs'

/** 一个保留下来的环形缓冲区条目；`bytes` 缓存该块的 UTF-8 长度。 */
interface RingChunk {
  at: number
  text: string
  bytes: number
  channel?: JobChannel
  gapBefore?: true
}

/**
 * `text` 不超过 `maxBytes` 的 UTF-8 安全尾部：字节切点会跳过续字节，因此存活下来的
 * 文本绝不会从某个码点中间开始。
 * @param text - 超长的块文本。
 * @param maxBytes - 存活尾部的正字节预算。
 * @returns 存活下来的尾部及其精确字节长度。
 */
function utf8Tail(text: string, maxBytes: number): { text: string; bytes: number } {
  const raw = Buffer.from(text, 'utf8')
  let start = raw.length - maxBytes
  // 循环边界已经证明下标在范围内；这里的断言只是为了满足 noUncheckedIndexedAccess。
  while (start < raw.length && ((raw[start] as number) & 0xC0) === 0x80) start += 1
  const tail = raw.subarray(start)
  return { text: tail.toString('utf8'), bytes: tail.length }
}

/** 偏移在淘汰过程中保持绝对：`earliest` 只会向前推进。 */
export class OutputRing {
  /** 按偏移顺序保留的块。 */
  private readonly chunks: RingChunk[] = []
  /** 保留块字节长度之和。 */
  retainedBytes = 0
  /** 曾经追加过的 UTF-8 总字节数——下一个块起始的偏移。 */
  total = 0
  /** 最老的保留字节的偏移（什么都没保留时等于 {@link total}）。 */
  earliest = 0

  /**
   * 追加一个块，并把头部裁剪到 `cap`。
   * @param text - 与产出完全一致的块文本。
   * @param options - 流标签与断点标记。
   * @param cap - 本次追加之后的保留上限，单位 UTF-8 字节。
   * @returns 当块为空且什么都没改变时返回 false。
   */
  append(text: string, options: JobAppendOptions | undefined, cap: number): boolean {
    if (text.length === 0) return false
    const bytes = Buffer.byteLength(text, 'utf8')
    this.chunks.push({
      at: this.total,
      text,
      bytes,
      ...options?.channel !== undefined ? { channel: options.channel } : {},
      ...options?.gapBefore !== undefined ? { gapBefore: options.gapBefore } : {},
    })
    this.total += bytes
    this.retainedBytes += bytes
    this.trim(cap)
    return true
  }

  /**
   * 丢弃保留的头部块，直到环形缓冲区装进 `cap`；单个超大的块只保留其 UTF-8 安全的
   * 尾部，并带上 `gapBefore` 标记。
   * @param cap - 保留上限，单位 UTF-8 字节。
   */
  trim(cap: number): void {
    while (this.retainedBytes > cap && this.chunks.length > 1) {
      const dropped = this.chunks.shift()
      /* v8 ignore next -- 长度守卫已经证明 shift() 会返回一个块；这个检查只是为了满足 noUncheckedIndexedAccess。 */
      if (dropped === undefined) break
      this.retainedBytes -= dropped.bytes
    }
    const single = this.chunks.length === 1 ? this.chunks[0] : undefined
    if (single !== undefined && single.bytes > cap) {
      const tail = utf8Tail(single.text, cap)
      single.at += single.bytes - tail.bytes
      single.text = tail.text
      single.bytes = tail.bytes
      single.gapBefore = true
      this.retainedBytes = tail.bytes
    }
    this.earliest = this.chunks[0]?.at ?? this.total
  }

  /**
   * 与 `[from, total)` 相交的保留块，作为全新的传输块。
   * @param from - 起始绝对字节偏移。
   * @returns 这些块、续读偏移，以及它们之前是否有字节被淘汰。
   */
  readFrom(from: number): JobOutputRead {
    const chunks = []
    for (const chunk of this.chunks) {
      if (chunk.at + chunk.bytes <= from) continue
      chunks.push({
        at: chunk.at,
        text: chunk.text,
        ...chunk.channel !== undefined ? { channel: chunk.channel } : {},
        ...chunk.gapBefore !== undefined ? { gapBefore: chunk.gapBefore } : {},
      })
    }
    return { chunks, next: this.total, lossy: from < this.earliest }
  }
}
