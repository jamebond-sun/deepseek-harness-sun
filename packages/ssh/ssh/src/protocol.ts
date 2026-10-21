/** SSH 客户端与其私有远端 helper 之间有界的、带版本的请求协议。 */

import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { Readable, Writable } from 'node:stream'
import { z } from 'zod'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** 已安装 helper 与客户端包共用的线路版本。 */
export const SSH_PROTOCOL_VERSION = 2

/** 单个 helper 可持有的、已准备或正在运行的进程句柄上限。 */
export const SSH_MAX_PROCESS_HANDLES = 128
/** 单个 helper 可持有的、已打开的文本迭代器上限。 */
export const SSH_MAX_TEXT_STREAMS = 128

const managementLimits = {
  heartbeat: 1,
  close: 1,
  'process.terminate': SSH_MAX_PROCESS_HANDLES,
  'fs.streamClose': SSH_MAX_TEXT_STREAMS,
} as const
type RequestClass = 'ordinary' | keyof typeof managementLimits

function requestClass(method: string): RequestClass {
  switch (method) {
    case 'heartbeat': case 'close': case 'process.terminate': case 'fs.streamClose': return method
    // 其余所有私有操作共用已配置的请求额度。
    default: return 'ordinary'
  }
}

const errorSchema = z.object({ name: z.string(), message: z.string(), code: z.string().optional() }).strict()
type SshRpcRequestId = Branded<'SshRpcRequestId'>
const requestIdSchema = z.string().transform((value): SshRpcRequestId => value as SshRpcRequestId)
const frameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('request'), id: requestIdSchema, method: z.string(), params: z.unknown() }).strict(),
  z.object({ type: z.literal('result'), id: requestIdSchema, value: z.unknown() }).strict(),
  z.object({ type: z.literal('error'), id: requestIdSchema, error: errorSchema }).strict(),
  z.object({ type: z.literal('cancel'), id: requestIdSchema }).strict(),
])
type Frame = z.infer<typeof frameSchema>
type RequestHandler = (method: string, params: unknown, signal: AbortSignal) => Promise<unknown>

function operationError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/** 远端错误会保留其带类型的文件系统或沙箱错误码。 */
export class RemoteOperationError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message)
    this.name = 'RemoteOperationError'
  }
}

/** 该 peer 负责管理进行中的调用，并在连接丢失时拒绝语义不明的操作；它从不重放请求。 */
export class SshRpcPeer extends EventEmitter {
  private readonly pending = new Map<SshRpcRequestId, {
    resolve(value: unknown): void
    reject(error: Error): void
    requestClass: RequestClass
  }>()
  private readonly active = new Map<SshRpcRequestId, { controller: AbortController; requestClass: RequestClass }>()
  private writeTail = Promise.resolve()
  private queuedBytes = 0
  private failure: Error | undefined

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly maxFrameBytes: number,
    private readonly maxPending: number,
    private readonly handler?: RequestHandler,
  ) {
    super()
    input.on('error', (error) => { this.close(error) })
    output.on('error', (error) => { this.close(error) })
    output.on('close', () => { this.close() })
    void this.readFrames().catch((error: unknown) => { this.close(operationError(error)) })
  }

  /**
   * 发送一次请求，并在把结果交给调用方之前校验其响应。
   * @param method - 私有 helper 操作名。
   * @param params - JSON 请求字段。
   * @param schema - 远端响应的校验器。
   * @param signal - 取消信号，不会回滚远端副作用。
   * @returns 校验通过的响应，或传输/远端操作失败的拒绝。
   */
  async request<T>(method: string, params: unknown, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    if (this.failure !== undefined) throw this.failure
    const kind = requestClass(method)
    if (this.atCapacity(kind, this.pending.values())) throw new Error('SSH helper pending request limit reached')
    const id = randomUUID() as SshRpcRequestId
    const result = Promise.withResolvers<unknown>()
    void result.promise.catch(() => {})
    this.pending.set(id, { ...result, requestClass: kind })
    const abort = (): void => {
      // 在对端处理器回复之前一直保留配额；取消并不代表远端的资源清理已经完成。
      result.reject(new Error('SSH operation cancelled; a completed remote mutation is not rolled back'))
      void this.send({ type: 'cancel', id }).catch(() => {})
    }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      void this.send({ type: 'request', id, method, params }).catch((error: unknown) => {
        this.pending.delete(id)
        result.reject(operationError(error))
      })
      return schema.parse(await result.promise)
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  }

  /**
   * 让进行中的操作失败并中止远端处理器，但不保证已回滚。
   * @param error - 报告给所有进行中操作的传输层失败原因。
   */
  close(error = new Error('SSH connection lost; remote operation outcome and cleanup are unknown')): void {
    if (this.failure !== undefined) return
    this.failure = error
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    for (const { controller } of this.active.values()) controller.abort(error)
    this.active.clear()
    this.input.destroy()
    this.output.destroy()
    this.emit('closed', error)
  }

  private async send(frame: Frame): Promise<void> {
    if (this.failure !== undefined) return Promise.reject(this.failure)
    const body = Buffer.from(JSON.stringify(frame))
    if (body.length > this.maxFrameBytes || this.queuedBytes + body.length + 4 > this.maxFrameBytes * 2) {
      return Promise.reject(new Error('SSH helper frame or write queue limit exceeded'))
    }
    const header = Buffer.alloc(4)
    header.writeUInt32BE(body.length)
    const bytes = Buffer.concat([header, body])
    this.queuedBytes += bytes.length
    const write = this.writeTail.then(async () => {
      if (this.failure !== undefined) throw this.failure
      if (!this.output.write(bytes)) await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          this.output.off('drain', drained)
          this.off('closed', closed)
        }
        const drained = (): void => { cleanup(); resolve() }
        const closed = (error: Error): void => { cleanup(); reject(error) }
        this.output.once('drain', drained)
        this.once('closed', closed)
        if (this.failure !== undefined) closed(this.failure)
      })
    })
    this.writeTail = write.catch((error: unknown) => { this.close(operationError(error)) })
    return write.finally(() => { this.queuedBytes -= bytes.length })
  }

  private async readFrames(): Promise<void> {
    const header = Buffer.alloc(4)
    let headerBytes = 0
    let payload: Buffer | undefined
    let payloadBytes = 0
    for await (const raw of this.input) {
      const chunk: Buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array)
      let offset = 0
      while (offset < chunk.length) {
        if (payload === undefined) {
          const count = Math.min(4 - headerBytes, chunk.length - offset)
          chunk.copy(header, headerBytes, offset, offset + count)
          headerBytes += count
          offset += count
          if (headerBytes < 4) continue
          const size = header.readUInt32BE(0)
          if (size === 0 || size > this.maxFrameBytes) throw new Error('SSH helper sent an invalid frame length')
          payload = Buffer.alloc(size)
          payloadBytes = 0
        }
        const count = Math.min(payload.length - payloadBytes, chunk.length - offset)
        chunk.copy(payload, payloadBytes, offset, offset + count)
        payloadBytes += count
        offset += count
        if (payloadBytes === payload.length) {
          const frame = frameSchema.parse(JSON.parse(payload.toString('utf8')))
          payload = undefined
          headerBytes = 0
          this.receive(frame)
        }
      }
    }
    throw new Error(headerBytes > 0 || payload !== undefined ? 'SSH helper disconnected during a frame; outcome is unknown' : 'SSH helper disconnected; outcome is unknown')
  }

  private receive(frame: Frame): void {
    if (frame.type === 'result' || frame.type === 'error') {
      const pending = this.pending.get(frame.id)
      if (pending === undefined) return // 一个已取消的请求仍可能在远端完成。
      this.pending.delete(frame.id)
      if (frame.type === 'result') pending.resolve(frame.value)
      else pending.reject(new RemoteOperationError(frame.error.message, frame.error.code))
      return
    }
    if (frame.type === 'cancel') {
      this.active.get(frame.id)?.controller.abort(new Error('SSH caller cancelled the operation'))
      return
    }
    const kind = requestClass(frame.method)
    if (this.handler === undefined || this.active.has(frame.id) || this.atCapacity(kind, this.active.values())) {
      throw new Error('SSH helper received an unexpected or excessive request')
    }
    const controller = new AbortController()
    this.active.set(frame.id, { controller, requestClass: kind })
    void this.handler(frame.method, frame.params, controller.signal).then(
      value => this.send({ type: 'result', id: frame.id, value: value ?? null }),
      (error: unknown) => {
        const detail = operationError(error)
        const code = 'code' in detail && typeof detail.code === 'string' ? detail.code : undefined
        return this.send({ type: 'error', id: frame.id, error: {
          name: detail.name, message: detail.message, ...(code === undefined ? {} : { code }),
        } })
      },
    ).catch((error: unknown) => { this.close(operationError(error)) })
      .finally(() => { this.active.delete(frame.id) })
  }

  private atCapacity(kind: RequestClass, requests: Iterable<{ requestClass: RequestClass }>): boolean {
    const limit = kind === 'ordinary' ? this.maxPending : managementLimits[kind]
    let count = 0
    for (const request of requests) if (request.requestClass === kind) count++
    return count >= limit
  }
}
