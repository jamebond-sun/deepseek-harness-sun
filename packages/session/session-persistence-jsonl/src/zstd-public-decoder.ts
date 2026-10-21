/**
 * 基于公开 API 的同步 Zstandard 帧解码器回退实现。
 * @module dsh-session-persistence-jsonl/zstd-public-decoder
 */

import { zstdDecompressSync } from 'node:zlib'
import type { ZstdFrameDecoder, ZstdFrameRange } from './zstd.ts'

/** 完全基于 Node 受支持的一次性 API 构建的多帧适配器。 */
export class PublicZstdFrameDecoder implements ZstdFrameDecoder {
  private started = false
  private closed = false

  /** @inheritdoc */
  public *decode(source: Buffer, frames: readonly ZstdFrameRange[]): Generator<Buffer, void, void> {
    if (this.started) throw new Error('Zstandard frame decoder was already started')
    if (this.closed) throw new Error('cannot start a closed Zstandard frame decoder')
    this.started = true
    try {
      for (const { start, end } of frames) {
        let decoded: Buffer
        try {
          decoded = zstdDecompressSync(source.subarray(start, end))
        } catch (error) {
          throw new Error(`corrupt Zstandard session log: frame at byte ${start} failed validation`, {
            cause: error,
          })
        }
        yield decoded
      }
    } finally {
      this.close()
    }
  }

  /** @inheritdoc */
  close(): void {
    this.closed = true
  }
}
