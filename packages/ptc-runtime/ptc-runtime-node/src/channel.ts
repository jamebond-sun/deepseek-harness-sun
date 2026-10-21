/** 带长度前缀的 JSON 传输，输入有界、写入排队。 */
import { Buffer } from 'node:buffer'
import type { Duplex } from 'node:stream'
import type { PtcJsonValue } from '@deepseek-ai/dsh-ptc-runtime'
import { jsonValueBytesUpTo } from './output-json.ts'

const stringify = JSON.stringify
const parse = JSON.parse

interface PendingWrite {
  promise: Promise<void>
  finish(error?: Error): void
}

/** 一条随包一起发布的进程通道；帧校验与终结结果由消费者负责。 */
export class JsonChannel {
  private readonly stream: Duplex
  private readonly maxBytes: number
  private readonly receive: (message: unknown, bytes: number) => void
  private readonly failure: (error: Error, kind: 'io' | 'protocol') => void
  private readonly header = Buffer.alloc(4)
  private headerBytes = 0
  private payload: Buffer | undefined
  private payloadBytes = 0
  private queuedBytes = 0
  private closed = false
  private readonly writes = new Set<PendingWrite>()

  constructor(
    stream: Duplex,
    maxBytes: number,
    receive: (message: unknown, bytes: number) => void,
    failure: (error: Error, kind: 'io' | 'protocol') => void,
  ) {
    this.stream = stream
    this.maxBytes = maxBytes
    this.receive = receive
    this.failure = failure
    stream.on('data', this.onData)
    stream.on('error', this.onError)
    stream.on('end', this.onEnd)
    stream.on('close', this.onClose)
  }

  private readonly onError = (error: Error): void => {
    this.finishWrites(error)
    if (!this.closed) this.failure(error, 'io')
  }
  private readonly onClose = (): void => { this.finishWrites(new Error('control channel closed during a write')) }
  private readonly onEnd = (): void => { if (!this.closed) this.failure(new Error('control channel ended before the program settled'), 'io') }
  private readonly onData = (chunk: Buffer): void => {
    if (this.closed) return
    try {
      let offset = 0
      // receive 在派发前一帧时可以同步关闭通道。
      // oxlint-disable-next-line typescript/no-unnecessary-condition
      while (offset < chunk.length && !this.closed) {
        if (this.payload === undefined) {
          const bytes = Math.min(4 - this.headerBytes, chunk.length - offset)
          chunk.copy(this.header, this.headerBytes, offset, offset + bytes)
          this.headerBytes += bytes
          offset += bytes
          if (this.headerBytes !== 4) continue
          const length = this.header.readUInt32BE(0)
          if (length === 0 || length > this.maxBytes) throw new Error(`control frame exceeds ${this.maxBytes} bytes or is empty`)
          this.payload = Buffer.allocUnsafe(length)
          this.payloadBytes = 0
          this.headerBytes = 0
        }
        const bytes = Math.min(this.payload.length - this.payloadBytes, chunk.length - offset)
        chunk.copy(this.payload, this.payloadBytes, offset, offset + bytes)
        this.payloadBytes += bytes
        offset += bytes
        if (this.payloadBytes !== this.payload.length) continue
        const frame = this.payload
        this.payload = undefined
        this.payloadBytes = 0
        this.receive(parse(new TextDecoder('utf-8', { fatal: true }).decode(frame)), frame.length)
      }
    } catch (error: unknown) {
      this.failure(error instanceof Error ? error : new Error(String(error)), 'protocol')
    }
  }

  /**
   * 立即提交一帧有界数据，并等待流的写入回执。
   * @param message - 随包发布的纯 JSON 协议值。
   * @returns 本帧写入完成时决议，或在传输失败后拒绝。
   */
  send(message: unknown): Promise<void> {
    if (this.closed) return Promise.reject(new Error('control channel is closed'))
    const size = jsonValueBytesUpTo(message as PtcJsonValue, this.maxBytes)
    if (size === undefined || this.queuedBytes + size > this.maxBytes) {
      return Promise.reject(new Error(`control output exceeds ${this.maxBytes} queued bytes`))
    }
    const body = Buffer.from(stringify(message), 'utf8')
    const header = Buffer.alloc(4)
    header.writeUInt32BE(body.length)
    this.queuedBytes += body.length
    const completion = Promise.withResolvers<void>()
    const write: PendingWrite = {
      promise: completion.promise,
      finish: (error) => {
        if (!this.writes.delete(write)) return
        this.queuedBytes -= body.length
        if (error) completion.reject(error)
        else completion.resolve()
      },
    }
    this.writes.add(write)
    try {
      // Writable 会保持帧序；若改用 Promise 队列，日志会被模型的热循环堵在后面。
      this.stream.cork()
      this.stream.write(header)
      this.stream.write(body, (error) => { write.finish(error ?? undefined) })
      this.stream.uncork()
    } catch (error: unknown) {
      write.finish(error instanceof Error ? error : new Error(String(error)))
    }
    return completion.promise
  }

  private finishWrites(error: Error): void {
    for (const write of this.writes) write.finish(error)
  }

  /** 停止读取并关闭自己持有的端点；挂起的写入在关闭时拒绝。 */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.payload = undefined
    this.finishWrites(new Error('control channel is closed'))
    this.stream.off('data', this.onData)
    this.stream.off('end', this.onEnd)
    this.stream.destroy()
  }

  /** 等待已受理的写入完成或失败。 */
  async drain(): Promise<void> { await Promise.allSettled([...this.writes].map(write => write.promise)) }
}
