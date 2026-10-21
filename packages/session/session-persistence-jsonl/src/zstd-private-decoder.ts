/**
 * 基于 Node 私有实现的同步 Zstandard 帧解码器优化。
 * @module dsh-session-persistence-jsonl/zstd-private-decoder
 */

import { constants as bufferConstants } from 'node:buffer'
import { createZstdDecompress } from 'node:zlib'
import type { ZstdFrameDecoder, ZstdFrameRange } from './zstd.ts'

const DECODE_CHUNK_SIZE = 1024 * 1024

interface NodeZstdPrivateHandle {
  writeSync(
    flushFlag: number,
    input: Buffer,
    inputOffset: number,
    inputLength: number,
    output: Buffer,
    outputOffset: number,
    outputLength: number,
  ): void
}

type NodeZstdPrivateWriteState = Uint32Array & { 0: number; 1: number }

interface NodeZstdPrivateState {
  [key: symbol]: unknown
  _handle: NodeZstdPrivateHandle | null
  _writeState: NodeZstdPrivateWriteState
  _defaultFlushFlag: number
}

type NodeZstdPrivateStream = ReturnType<typeof createZstdDecompress> & NodeZstdPrivateState

/** 返回该流及其观测到的 Node 私有契约，否则拒绝这一优化。 */
function privateZstdStream(
  stream: ReturnType<typeof createZstdDecompress>,
): { stream: NodeZstdPrivateStream; errorKey: symbol } | undefined {
  const candidate = stream as unknown as Partial<NodeZstdPrivateState>
  const handle = candidate._handle
  const errorKey = Reflect.ownKeys(stream).find((key): key is symbol => (
    typeof key === 'symbol' && key.description === 'kError'
  ))
  /* v8 ignore next -- 单个测试运行时只暴露一种 Node 私有形态；Node 22/24/26 矩阵负责检查兼容性。 */
  if (
    typeof handle !== 'object' || handle === null
    || typeof (handle as { writeSync?: unknown }).writeSync !== 'function'
    || !(candidate._writeState instanceof Uint32Array)
    || candidate._writeState.length < 2
    || typeof candidate._defaultFlushFlag !== 'number'
    || errorKey === undefined
    || candidate[errorKey] !== null
  ) return undefined
  return { stream: stream as NodeZstdPrivateStream, errorKey }
}

/**
 * 由一个 Node Zstd 流句柄支撑的同步多帧解码器。Node 只以一次性 API 的形式
 * 暴露同步解码，因此本适配器使用流的私有句柄契约，以便跨帧复用其原生
 * 上下文与输出块。
 */
export class NodePrivateZstdFrameDecoder implements ZstdFrameDecoder {
  private readonly output = Buffer.allocUnsafe(DECODE_CHUNK_SIZE)
  private decoderError?: Error
  private started = false
  private closed = false

  private constructor(
    private readonly stream: NodeZstdPrivateStream,
    private readonly errorKey: symbol,
  ) {
    this.stream.on('error', (error: Error) => {
      this.decoderError ??= error
    })
  }

  /**
   * 当本 Node 版本暴露出预期的私有流形态时，创建该优化解码器。
   * @returns 一个共享解码器；当调用方必须使用公开回退实现时为 `undefined`。
   */
  static create(): NodePrivateZstdFrameDecoder | undefined {
    const stream = createZstdDecompress({ chunkSize: DECODE_CHUNK_SIZE })
    const privateAccess = privateZstdStream(stream)
    /* v8 ignore next -- 仅当某个受支持的 Node 版本改变了其私有流形态时才会到达。 */
    if (privateAccess !== undefined) {
      return new NodePrivateZstdFrameDecoder(privateAccess.stream, privateAccess.errorKey)
    }
    /* v8 ignore next -- 当前 Node 运行时已通过上面的私有形态探测。 */
    stream.close()
    /* v8 ignore next -- 当前 Node 运行时已通过上面的私有形态探测。 */
    return undefined
  }

  /** @inheritdoc */
  public *decode(source: Buffer, frames: readonly ZstdFrameRange[]): Generator<Buffer, void, void> {
    if (this.started) throw new Error('Zstandard frame decoder was already started')
    if (this.closed) throw new Error('cannot start a closed Zstandard frame decoder')
    this.started = true
    try {
      for (const frame of frames) {
        try {
          yield this.decodeFrame(source.subarray(frame.start, frame.end))
        } catch (error) {
          throw new Error(`corrupt Zstandard session log: frame at byte ${frame.start} failed validation`, {
            cause: error,
          })
        }
      }
    } finally {
      this.close()
    }
  }

  /** 解码一个帧；其返回的临时视图在下次调用之前保持有效。 */
  private decodeFrame(input: Buffer): Buffer {
    const handle = this.stream._handle
    /* v8 ignore next -- decode() 在进入这个私有帧操作之前就会拒绝已关闭的实例。 */
    if (this.closed || handle === null) throw new Error('cannot decode with a closed Zstandard frame decoder')

    let inputOffset = 0
    let inputRemaining = input.length
    let outputBytes = 0
    const fullChunks: Buffer[] = []
    for (;;) {
      handle.writeSync(
        this.stream._defaultFlushFlag,
        input,
        inputOffset,
        inputRemaining,
        this.output,
        0,
        this.output.length,
      )
      if (this.decoderError !== undefined) throw this.decoderError
      const internalError = this.stream[this.errorKey]
      if (internalError !== null) {
        if (internalError instanceof Error) throw internalError
        throw new Error('Zstandard decoder exposed a non-Error internal failure')
      }

      const outputAfter = this.stream._writeState[0]
      const inputAfter = this.stream._writeState[1]
      const consumed = inputRemaining - inputAfter
      const produced = this.output.length - outputAfter
      if (produced > 0) {
        outputBytes += produced
        /* v8 ignore next -- Buffer 无法物化一个超过其自身进程级最大长度的帧。 */
        if (outputBytes > bufferConstants.MAX_LENGTH) {
          throw new Error(`Zstandard frame output exceeds ${bufferConstants.MAX_LENGTH} bytes`)
        }
      }

      if (outputAfter !== 0) {
        /* v8 ignore next -- 结构化扫描出的区间恰好包含一个完整帧，且没有尾随字节。 */
        if (inputAfter !== 0) throw new Error('Zstandard frame decoder left trailing input')
        const finalChunk = this.output.subarray(0, produced)
        if (fullChunks.length === 0) return finalChunk
        if (produced > 0) fullChunks.push(Buffer.from(finalChunk))
        const onlyChunk = fullChunks[0] as Buffer
        return fullChunks.length === 1
          ? onlyChunk
          : Buffer.concat(fullChunks, outputBytes)
      }
      fullChunks.push(Buffer.from(this.output))
      inputOffset += consumed
      inputRemaining = inputAfter
    }
  }

  /** @inheritdoc */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.stream.close()
  }
}
