/**
 * 基于字节流的换行分隔 JSON-RPC 2.0。同时带 `id` 与 `method` 的帧是请求，
 * 只有 `id` 的是响应，只有 `method` 的是通知。格式错误的行被忽略；
 * 处理器失败会变成错误帧。
 *
 * @module @deepseek-ai/dsh-sdk-protocol/transport
 */

import { randomUUID } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'

type JsonRpcId = string | number
type RequestHandler = (method: string, params: Record<string, unknown>) => Promise<unknown>
type NotificationHandler = (method: string, params: Record<string, unknown>) => void

/** 一条 JSON-RPC 错误响应，保留线上的 `code` 与可选的 `data`。 */
export class JsonRpcResponseError extends Error {
  /**
   * @param code - 线上的错误码；当对端未发送时为 `undefined`。
   * @param message - 线上的错误消息。
   * @param data - 可选的结构化错误载荷，原样保留。
   */
  constructor(readonly code: number | undefined, message: string, readonly data?: unknown) {
    super(message)
    this.name = 'JsonRpcResponseError'
  }
}

/**
 * 运行时服务端与 SDK 客户端所使用的出站请求与通知接口。
 */
export interface JsonRpcTransportPeer {
  /**
   * 发送一个请求并等待其响应。
   * @param method - JSON-RPC 方法名。
   * @param params - 请求参数对象。
   * @returns 结果；收到错误响应时以 {@link JsonRpcResponseError} reject，
   *   写入失败或关闭时以普通 `Error` reject。
   */
  request(method: string, params: object): Promise<unknown>
  /**
   * 发送一条通知；省略 params 时不产生 `params` 成员。
   * @param method - JSON-RPC 方法名。
   * @param params - 可选的通知参数对象。
   */
  notify(method: string, params?: object): void
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/**
 * 调用方自有流之上的按行分隔端点。{@link start} 挂载监听器；{@link close}
 * 卸载它们并 reject 待定请求，而不销毁这些流。缺少请求处理器时返回 `-32601`；
 * 处理器失败时返回 `-32603`。没有处理器的通知被丢弃。
 */
export class JsonRpcLineTransport implements JsonRpcTransportPeer {
  private buffer = ''
  private readonly decoder = new StringDecoder('utf8')
  private started = false
  private requestHandler: RequestHandler | undefined
  private notificationHandler: NotificationHandler | undefined
  private readonly pending = new Map<JsonRpcId, PendingRequest>()

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
  ) {}

  /** 挂载输入监听器并开始读取帧。幂等。 */
  start(): void {
    if (this.started) return
    this.started = true
    this.input.on('data', this.onData)
    this.input.on('error', this.onInputError)
    this.input.on('end', this.onInputEnd)
  }

  /**
   * 卸载监听器并 reject 待定请求。在 {@link start} 之前调用也是安全的。
   */
  close(): void {
    this.input.off('data', this.onData)
    this.input.off('error', this.onInputError)
    this.input.off('end', this.onInputEnd)
    this.failPending(new Error('JSON-RPC transport closed'))
  }

  /**
   * 安装请求处理器，替换先前的处理器。
   * @param handler - 解析为响应的 `result`；reject 会变成携带该消息的
   *   `-32603` 错误响应。
   */
  onRequest(handler: RequestHandler): void {
    this.requestHandler = handler
  }

  /**
   * 安装通知处理器，替换先前的处理器。
   * @param handler - 每条通知调用一次，传入方法名与归一化后的 params 对象。
   */
  onNotification(handler: NotificationHandler): void {
    this.notificationHandler = handler
  }

  /**
   * 发送一个请求并等待其响应。
   * @param method - JSON-RPC 方法名。
   * @param params - 请求参数对象。
   * @param signal - 可选的放弃信号：中止会移除待定条目（不会为一个可能
   *   永不抵达的响应保留状态），并以该信号的 reason reject。
   * @returns 结果；reject 行为同 {@link JsonRpcTransportPeer.request}。
   */
  request(method: string, params: object, signal?: AbortSignal): Promise<unknown> {
    const id = `req_${randomUUID().replaceAll('-', '')}`
    const message = { jsonrpc: '2.0', id, method, params }
    return new Promise((resolve, reject) => {
      let detach = (): void => {}
      if (signal !== undefined) {
        if (signal.aborted) {
          reject(abortError(signal.reason))
          return
        }
        const onAbort = (): void => {
          this.pending.delete(id)
          reject(abortError(signal.reason))
        }
        signal.addEventListener('abort', onAbort, { once: true })
        detach = () => { signal.removeEventListener('abort', onAbort) }
      }
      this.pending.set(id, {
        resolve: (value) => {
          detach()
          resolve(value)
        },
        reject: (error) => {
          detach()
          reject(error)
        },
      })
      try {
        this.write(message)
      } catch (error) {
        this.pending.delete(id)
        detach()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  notify(method: string, params?: object): void {
    this.write(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params })
  }

  /**
   * 等待先前的帧写入回调。这个空屏障不发出任何字节。
   * @returns 一个随输出写入回调 settle 的 promise。
   */
  flush(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.output.write('', (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  private readonly onData = (chunk: Buffer | string): void => {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    this.drainLines()
  }

  private drainLines(): void {
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) break
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      void this.handleLine(line)
    }
  }

  private readonly onInputError = (error: Error): void => {
    this.failPending(error)
  }

  private readonly onInputEnd = (): void => {
    this.buffer += this.decoder.end()
    this.drainLines()
    this.failPending(new Error('JSON-RPC input closed'))
  }

  private async handleLine(line: string): Promise<void> {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      // 只有 JSON 语法错误会进入此处；对端的畸形行被忽略。
      return
    }
    if (!message || typeof message !== 'object') return
    const frame = message as Record<string, unknown>
    const id = frame.id
    const method = frame.method
    if ((typeof id === 'string' || typeof id === 'number') && typeof method === 'string') {
      await this.handleIncomingRequest(id, method, objectParams(frame.params))
      return
    }
    if (typeof id === 'string' || typeof id === 'number') {
      this.handleIncomingResponse(id, frame)
      return
    }
    if (typeof method === 'string') {
      this.notificationHandler?.(method, objectParams(frame.params))
    }
  }

  private async handleIncomingRequest(id: JsonRpcId, method: string, params: Record<string, unknown>): Promise<void> {
    const handler = this.requestHandler
    if (!handler) {
      this.writeError(id, -32601, `method not found: ${method}`)
      return
    }
    try {
      const result = await handler(method, params)
      this.write({ jsonrpc: '2.0', id, result })
    } catch (error) {
      this.writeError(id, -32603, error instanceof Error ? error.message : String(error))
    }
  }

  private handleIncomingResponse(id: JsonRpcId, frame: Record<string, unknown>): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    if (frame.error && typeof frame.error === 'object') {
      const error = frame.error as Record<string, unknown>
      pending.reject(new JsonRpcResponseError(
        typeof error.code === 'number' ? error.code : undefined,
        typeof error.message === 'string' ? error.message : 'JSON-RPC error',
        error.data,
      ))
      return
    }
    pending.resolve(frame.result)
  }

  private writeError(id: JsonRpcId, code: number, message: string): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message } })
  }

  private write(message: Record<string, unknown>): void {
    this.output.write(`${JSON.stringify(message)}\n`)
  }

  private failPending(error: Error): void {
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const waiter of pending) waiter.reject(error)
  }
}

/** 将 JSON-RPC `params` 归一化为普通对象（数组与标量都收敛为 `{}`）。 */
function objectParams(params: unknown): Record<string, unknown> {
  return params && typeof params === 'object' && !Array.isArray(params) ? params as Record<string, unknown> : {}
}

/** 将中止原因归一化为用于 reject 的 Error（非 Error 的原因会被字符串化）。 */
function abortError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(`JSON-RPC request aborted: ${String(reason)}`)
}
