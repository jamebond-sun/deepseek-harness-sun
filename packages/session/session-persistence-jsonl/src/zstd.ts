/**
 * JSONL 持久化后端使用的 Zstandard 帧原语。该后端自有一个拼接帧容器，
 * 因此它能追加与恢复批次，而无需通过持久化接缝暴露压缩机制细节。
 * @module dsh-session-persistence-jsonl/zstd
 */

import {
  constants, zstdCompress, zstdDecompress, type ZstdOptions,
} from 'node:zlib'
import { promisify } from 'node:util'
import { NodePrivateZstdFrameDecoder } from './zstd-private-decoder.ts'
import { PublicZstdFrameDecoder } from './zstd-public-decoder.ts'

const ZSTD_MAGIC = 0xFD2FB528
const zstdCompressAsync = promisify(zstdCompress)
const zstdDecompressAsync = promisify(zstdDecompress)
const CHECKSUM_OPTIONS: ZstdOptions = {
  params: { [constants.ZSTD_c_checksumFlag]: 1 },
}
const INCOMPLETE_FRAME_OPTIONS: ZstdOptions = {
  finishFlush: constants.ZSTD_e_flush,
}

/** 一个结构上完整的 Zstandard 帧所占用的字节区间。 */
export interface ZstdFrameRange {
  /** 帧的起始位置（含）。 */
  start: number
  /** 帧的结束位置（不含）。 */
  end: number
}

/** 一个拼接式 Zstandard 流的结构化扫描结果。 */
export interface ZstdFrameScan {
  /** 按文件顺序排列的完整帧。 */
  frames: ZstdFrameRange[]
  /** 当 EOF 打断了末尾帧时，该不完整末尾帧的起始位置。 */
  tornStart?: number
}

/**
 * 在不解压其数据块的前提下定位完整帧。结构完整但无效的内容会被拒绝；
 * 末尾帧内部遇到 EOF 时返回其起始位置以便修复。
 * @param buffer - 会话制品当前存在的完整字节。
 * @param maxFrames - 可选完整帧数量上限，供只读元数据的读取方使用。
 * @returns 完整帧区间，以及可选的末尾不完整帧起始位置。
 */
export function scanZstdFrames(buffer: Buffer, maxFrames = Number.POSITIVE_INFINITY): ZstdFrameScan {
  const frames: ZstdFrameRange[] = []
  let offset = 0

  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4

    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    }

    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes

    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }

    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length === maxFrames) return { frames }
  }

  return { frames }
}

/**
 * 压缩一个可独立解码且带校验和的 Zstandard 帧。
 * @param input - 头部或持久事件批次的 JSONL 字节。
 * @returns 完整的已编码帧。
 */
export async function compressZstdFrame(input: Buffer | string): Promise<Buffer> {
  return zstdCompressAsync(input, CHECKSUM_OPTIONS)
}

/**
 * 解压一个完整帧并校验其校验和。
 * @param input - 一个结构上完整的 Zstandard 帧。
 * @returns 该帧的明文。
 */
export async function decompressZstdFrame(input: Buffer): Promise<Buffer> {
  return zstdDecompressAsync(input)
}

/** 可互换的同步多帧解码器共用的生命周期。 */
export interface ZstdFrameDecoder {
  /**
   * 按源顺序解码并校验完整帧。每次产出的缓冲区只在迭代器前进到下一帧之前有效。
   * @param source - 拼接在一起的 Zstandard 帧字节。
   * @param frames - `source` 中结构上完整的区间。
   * @returns 每帧对应一个明文缓冲区。
   */
  decode(source: Buffer, frames: readonly ZstdFrameRange[]): Generator<Buffer, void, void>
  /** 释放解码器持有的资源；重复调用无害。 */
  close(): void
}

/**
 * 当运行中的 Node 22/24/26 形态兼容时选用共享的私有解码器，
 * 否则用公开的一次性 API 来保持正确性。
 * @returns 一个生命周期与具体实现无关的同步解码器。
 */
export function createZstdFrameDecoder(): ZstdFrameDecoder {
  return NodePrivateZstdFrameDecoder.create() ?? new PublicZstdFrameDecoder()
}

/**
 * 从结构上不完整的末尾帧中恢复可用的明文。`ZSTD_e_flush` 刻意抑制末尾帧与
 * 校验和的补全；调用方在使用本辅助函数之前必须先确定撕裂帧的边界。
 * @param input - 来自一个已知不完整 Zstandard 帧的可用字节。
 * @returns 由可用输入生成的明文。
 */
export async function decompressZstdPrefix(input: Buffer): Promise<Buffer> {
  return zstdDecompressAsync(input, INCOMPLETE_FRAME_OPTIONS)
}
