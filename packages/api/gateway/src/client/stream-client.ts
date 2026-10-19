/** Gateway 多路复用 Remote 流套接字的 Client 所有者。 */
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { ConnectionWebSocket } from '@deepseek-ai/dsh-client-connection/client'

import {
  parseRemoteStreamServerMessage,
  REMOTE_STREAM_MUX_PATH,
  type RemoteStreamClientMessage,
  type RemoteStreamServerMessage,
} from '../stream-protocol.ts'
import { Deque } from '@deepseek-ai/dsh-deque'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'

/** 可由领域传输重试的物理 Remote 流套接字失败。 */
export class RemoteStreamCarrierError extends Error {
  /**
   * @param message - 物理载体失败的描述。
   * @param options - 可选的原因错误。
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RemoteStreamCarrierError'
  }
}

interface SocketWaiter {
  readonly revision: number
  resolve(socket: ConnectionWebSocket): void
  reject(error: unknown): void
}

interface UplinkPump {
  /** 泵停止发送后即完成。 */
  readonly done: Promise<void>
  /** 中断泵（包括阻塞在调用方迭代器上的读取），并释放该迭代器。 */
  stop(): void
}

/** 一个打开的逻辑流：其下行帧，以及 `open` 帧发出后的上行泵。 */
interface LogicalStream {
  readonly inbox: StreamInbox
  pump: UplinkPump | undefined
}

const UPLINK_DONE: IteratorReturnResult<undefined> = { value: undefined, done: true }

/**
 * 维持一个物理 WebSocket，并在可独立取消的 Remote 流之间共享。
 * 提供进程内流打开器的载体
 * 绝不启动一个。
 */
export class RemoteStreamMuxClient {
  private socket: ConnectionWebSocket | undefined
  private cancelCandidate: ((error: Error) => void) | undefined
  private keepAlive: Promise<void> | undefined
  private revision = 0
  private readonly streams = new Map<string, LogicalStream>()
  private readonly waiters = new Set<SocketWaiter>()
  private readonly socketClosures = new Set<Promise<void>>()
  private running = false
  private disposed = false
  private failure: RemoteStreamCarrierError | undefined

  /**
   * @param openSocket - 选定的已认证载体；省略时使用浏览器套接字。
   * @param waitForReconnect - 应答型 Client 等待 Connection 更换丢失的套接字；被动 Client 使后续打开立即失败。
   */
  constructor(
    private readonly openSocket: (path: string) => ConnectionWebSocket = () => new WebSocket(remoteStreamUrl()),
    private readonly waitForReconnect = false,
  ) {}

  /** 确保存在一个物理尝试，必要时跟随当前尝试一次。 */
  start(): void {
    if (this.disposed) return
    this.running = true
    if (this.socket?.readyState === 1) return
    const pending = this.keepAlive
    if (pending === undefined) this.maintain()
    else void pending.then(() => { this.maintain() })
  }

  /** 取消当前套接字或重试等待，并立即开始全新的尝试。 */
  reconnect(): void {
    if (!this.running || this.disposed) return
    const failure = new RemoteStreamCarrierError('api gateway: Remote stream reconnect requested')
    const pending = this.keepAlive
    this.revision++
    this.failure = undefined
    this.cancelCandidate?.(failure)
    const socket = this.socket
    if (socket !== undefined) {
      this.socket = undefined
      this.failAll(failure)
      socket.close(4000, 'reconnect requested')
    }
    if (pending === undefined) this.maintain()
    else void pending.then(() => { this.maintain() })
  }

  /**
   * 在持久物理连接上打开一个逻辑流。
   * 已建立的套接字丢失后，应答型 Client 等待 Connection 重连或其信号中止；
   * 被动 Client 立即拒绝。
   * 初始套接字失败对两种模式都拒绝。
   * @param endpoint - Typert Remote 流端点。
   * @param payload - 编码到 wire 上的端点请求。
   * @param signal - 此逻辑流的取消信号。
   * @param uplink - Client 的条目：每条作为一个 `item` 帧发送，结束作为 `end`；其 `return()`
   * 在流结束时运行，其失败会取消流并使下行失败。
   * @returns Host 的条目，直至完成、取消或失败。
   */
  async *open(
    endpoint: string,
    payload: unknown,
    signal: AbortSignal,
    uplink?: AsyncIterable<unknown>,
  ): AsyncGenerator {
    signal.throwIfAborted()
    const streamId = randomUUID()
    const inbox = new StreamInbox()
    const stream: LogicalStream = { inbox, pump: undefined }
    let carrier: ConnectionWebSocket | undefined
    let opened = false
    let terminal = false
    const abort = (): void => { inbox.fail(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    try {
      const socket = await this.waitForSocket(signal)
      signal.throwIfAborted()
      carrier = socket
      this.streams.set(streamId, stream)
      this.send(socket, { type: 'open', streamId, endpoint, payload })
      opened = true
      if (uplink !== undefined) stream.pump = this.pumpUplink(socket, streamId, uplink, signal, inbox)
      while (true) {
        const frame = await inbox.next()
        signal.throwIfAborted()
        if (frame.type === 'item') {
          yield frame.value
          continue
        }
        terminal = true
        if (frame.type === 'error') {
          throw new RemoteError(frame.error.code as never, frame.error.message, frame.error.details as never)
        }
        return
      }
    } finally {
      signal.removeEventListener('abort', abort)
      this.streams.delete(streamId)
      stream.pump?.stop()
      if (opened && !terminal && carrier?.readyState === 1) {
        this.send(carrier, { type: 'cancel', streamId })
      }
      // 旧的代的泵已在监管器重新打开下一个之前停止。
      if (stream.pump !== undefined) await stream.pump.done
    }
  }

  /**
   * 在此代的套接字上发送调用方的上行条目。`stop()`
   * 中断阻塞在 `uplink.next()` 上的泵并释放迭代器：句柄的队列
   * 立即关闭，因此从那时起 `send()` 抛出，而任何其他迭代器的
   * `return()` 会被调用但不被等待，因为阻塞在 `next()` 中的
   * 生成器只有让出时才能完成它。
   */
  private pumpUplink(
    socket: ConnectionWebSocket,
    streamId: string,
    uplink: AsyncIterable<unknown>,
    signal: AbortSignal,
    inbox: StreamInbox,
  ): UplinkPump {
    let stopped: PromiseWithResolvers<IteratorReturnResult<undefined>> | undefined
    const interruption: IteratorReturnResult<undefined> = { value: undefined, done: true }
    const uplinkIterator = uplink[Symbol.asyncIterator]()
    const state = { stopping: false, exhausted: false, released: false }
    const release = (): void => {
      if (state.released || state.exhausted) return
      state.released = true
      if (uplink instanceof ClientUplinkQueue) uplink.close()
      void Promise.resolve().then(() => uplinkIterator.return?.()).catch(() => undefined)
    }
    const done = (async (): Promise<void> => {
      try {
        while (true) {
          const stoppingBeforeRead = state.stopping
          if (stoppingBeforeRead) return
          // 停止 promise 属于单次读取，而不是整个上行历史。
          stopped = Promise.withResolvers<IteratorReturnResult<undefined>>()
          const next = await Promise.race([uplinkIterator.next(), stopped.promise])
          stopped = undefined
          if (state.stopping || next === interruption || signal.aborted || this.socket !== socket) return
          if (next.done === true) {
            state.exhausted = true
            break
          }
          this.send(socket, { type: 'item', streamId, value: next.value })
        }
        this.send(socket, { type: 'end', streamId })
      } catch (error) {
        inbox.fail(error)
      } finally {
        stopped = undefined
        release()
      }
    })()
    return {
      done,
      stop: () => {
        if (state.stopping) return
        state.stopping = true
        stopped?.resolve(interruption)
        release()
      },
    }
  }

  /**
   * 永久停止载体，关闭物理套接字，
   * 并使每个活跃逻辑流失败。
   * @returns 连接尝试与每个物理套接字都已关闭之后。
   */
  async close(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true
      this.running = false
      const error = new Error('api gateway: Remote stream client disposed')
      this.failAll(error)
      for (const waiter of [...this.waiters]) waiter.reject(error)
      this.cancelCandidate?.(error)
      const socket = this.socket
      this.socket = undefined
      socket?.close(1000, 'disposed')
    }
    await this.keepAlive
    await Promise.all(this.socketClosures)
  }

  private async connect(): Promise<ConnectionWebSocket> {
    const socket = this.openSocket(REMOTE_STREAM_MUX_PATH)
    const closed = new Promise<void>((resolve) => { socket.addEventListener('close', () => { resolve() }, { once: true }) })
    this.socketClosures.add(closed)
    void closed.then(() => { this.socketClosures.delete(closed) })
    const connecting = new Promise<ConnectionWebSocket>((resolve, reject) => {
      let settled = false
      const rejectCandidate = (error: Error): void => {
        settled = true
        socket.removeEventListener('open', opened)
        socket.removeEventListener('message', received)
        this.cancelCandidate = undefined
        // Node ws 在连接中的套接字关闭时会发出 error。即使已拒绝该尝试，
        // 也将 error 监听器保留到 close。
        if (socket.readyState < 2) socket.close()
        reject(error)
      }
      const opened = (): void => {
        settled = true
        this.cancelCandidate = undefined
        this.socket = socket
        for (const waiter of [...this.waiters]) waiter.resolve(socket)
        resolve(socket)
      }
      const failed = (): void => {
        if (!settled) {
          rejectCandidate(new RemoteStreamCarrierError(
            'api gateway: Remote stream WebSocket failed to open',
          ))
          return
        }
        const error = new RemoteStreamCarrierError('api gateway: Remote stream WebSocket failed')
        this.lost(socket, error)
        if (socket.readyState < 2) socket.close()
      }
      const closed = (): void => {
        socket.removeEventListener('open', opened)
        socket.removeEventListener('error', failed)
        socket.removeEventListener('message', received)
        if (!settled) {
          rejectCandidate(new RemoteStreamCarrierError(
            'api gateway: Remote stream WebSocket closed before opening',
          ))
          return
        }
        this.lost(socket)
      }
      const received = (event: { readonly data: unknown }): void => { this.receive(socket, event.data) }
      this.cancelCandidate = rejectCandidate
      socket.addEventListener('open', opened, { once: true })
      socket.addEventListener('error', failed)
      socket.addEventListener('message', received)
      socket.addEventListener('close', closed, { once: true })
    })
    return connecting
  }

  private waitForSocket(signal: AbortSignal): Promise<ConnectionWebSocket> {
    signal.throwIfAborted()
    if (this.socket?.readyState === 1) return Promise.resolve(this.socket)
    if (this.disposed) return Promise.reject(new Error('api gateway: Remote stream client disposed'))
    if (!this.running) return Promise.reject(new Error('api gateway: Remote stream client not started'))
    if (this.failure !== undefined) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      const aborted = (): void => { waiter.reject(signal.reason) }
      const cleanup = (): void => {
        this.waiters.delete(waiter)
        signal.removeEventListener('abort', aborted)
      }
      const waiter: SocketWaiter = {
        revision: this.revision,
        resolve: (socket) => {
          cleanup()
          resolve(socket)
        },
        reject: (error) => {
          cleanup()
          // AbortSignal.reason 属于调用方，且可能有意为非 Error 的哨兵值。
          // oxlint-disable-next-line typescript/prefer-promise-reject-errors
          reject(error)
        },
      }
      this.waiters.add(waiter)
      signal.addEventListener('abort', aborted, { once: true })
    })
  }

  private receive(socket: ConnectionWebSocket, data: unknown): void {
    if (socket !== this.socket) return
    try {
      if (typeof data !== 'string') throw new Error('api gateway: Remote stream WebSocket requires text messages')
      const frame = parseRemoteStreamServerMessage(data)
      const stream = this.streams.get(frame.streamId)
      if (stream === undefined) return
      stream.inbox.push(frame)
      // 终止帧现在就结束上行，而不是等到消费方的下一次读取。
      if (frame.type !== 'item') stream.pump?.stop()
    } catch (error) {
      const failure = new RemoteStreamCarrierError('api gateway: invalid Remote stream frame', { cause: error })
      this.failAll(failure)
      this.lost(socket, failure)
      socket.close(4002, 'invalid Remote stream frame')
    }
  }

  private lost(
    socket: ConnectionWebSocket,
    error: RemoteStreamCarrierError = new RemoteStreamCarrierError(
      'api gateway: Remote stream WebSocket closed',
    ),
  ): void {
    if (this.socket !== socket) return
    this.socket = undefined
    if (!this.waitForReconnect) this.failure = error
    this.failAll(error)
    if (!this.waitForReconnect) {
      for (const waiter of [...this.waiters]) waiter.reject(error)
    }
  }

  private maintain(): void {
    if (!this.running || this.disposed) return
    if (this.socket?.readyState === 1 || this.keepAlive !== undefined) return
    const revision = this.revision
    this.failure = undefined
    const task = this.connect().then(
      () => undefined,
      (error: unknown) => {
        if (!this.running) return
        const failure = error instanceof RemoteStreamCarrierError ? error
          : new RemoteStreamCarrierError('api gateway: Remote stream WebSocket failed to open', { cause: error })
        if (this.revision === revision) this.failure = failure
        for (const waiter of [...this.waiters]) {
          if (waiter.revision <= revision) waiter.reject(failure)
        }
      },
    )
    this.keepAlive = task
    void task.then(() => {
      this.keepAlive = undefined
    })
  }

  private failAll(error: unknown): void {
    for (const stream of this.streams.values()) {
      stream.inbox.fail(error)
      stream.pump?.stop()
    }
  }

  private send(socket: ConnectionWebSocket, message: RemoteStreamClientMessage): void {
    socket.send(JSON.stringify(message))
  }
}

class StreamInbox {
  private readonly frames = new Deque<RemoteStreamServerMessage>()
  private wake: (() => void) | undefined
  private failure: Error | undefined

  push(frame: RemoteStreamServerMessage): void {
    if (this.failure !== undefined) return
    this.frames.pushBack(frame)
    this.wake?.()
    this.wake = undefined
  }

  fail(error: unknown): void {
    if (this.failure !== undefined) return
    this.failure = error instanceof Error ? error : new Error(String(error), { cause: error })
    this.frames.clear()
    this.wake?.()
    this.wake = undefined
  }

  async next(): Promise<RemoteStreamServerMessage> {
    while (this.frames.size === 0) {
      if (this.failure !== undefined) throw this.failure
      await new Promise<void>((resolve) => { this.wake = resolve })
    }
    return this.frames.popFront() as RemoteStreamServerMessage
  }
}

/**
 * 流句柄为其载体排队的上行条目：多路复用泵或进程内 Host 解码器
 * 将其作为流的上行来迭代。`end()` 是 Client 半关闭；`close()`
 * 标记流已终止，此后 `push()` 抛出。一个消费方读取它，
 * 且一次只有一个读取。
 */
export class ClientUplinkQueue implements AsyncIterable<unknown>, AsyncIterator<unknown> {
  private readonly items = new Deque<unknown>()
  private ended = false
  private closed = false
  private wake: (() => void) | undefined

  /** @param endpoint - 失败中指名的规范 Remote 端点。 */
  constructor(private readonly endpoint: string) {}

  /**
   * 为载体排队一个条目。
   * @param item - 由 Host 依据方法上行编解码器校验的条目。
   * @throws {Error} 在 `end()` 之后或流已终止之后抛出。
   */
  push(item: unknown): void {
    if (this.closed) throw new Error(`client api: ${this.endpoint} stream has terminated`)
    if (this.ended) throw new Error(`client api: ${this.endpoint} uplink was ended`)
    this.items.pushBack(item)
    this.signal()
  }

  /** 半关闭：载体读取排队的条目，然后是 `end`。幂等；终止后忽略。 */
  end(): void {
    if (this.ended || this.closed) return
    this.ended = true
    this.signal()
  }

  /** 载体已停止读取：逻辑流已终止或被释放。幂等。 */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.items.clear()
    this.signal()
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this
  }

  /**
   * 取出下一个排队的条目，必要时等待；在 `end()` 或 `close()` 之后结束。
   * @returns 下一个条目，或上行的结束。
   * @throws {Error} 已有一个读取挂起时抛出。
   */
  async next(): Promise<IteratorResult<unknown>> {
    while (true) {
      if (this.closed) return UPLINK_DONE
      if (this.items.size > 0) return { value: this.items.popFront(), done: false }
      if (this.ended) return UPLINK_DONE
      if (this.wake !== undefined) throw new Error(`client api: ${this.endpoint} uplink has one pending read`)
      await new Promise<void>((resolve) => { this.wake = resolve })
    }
  }

  /**
   * 载体已用完上行：将其关闭。
   * @returns 上行的结束。
   */
  return(): Promise<IteratorResult<unknown>> {
    this.close()
    return Promise.resolve(UPLINK_DONE)
  }

  private signal(): void {
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }
}

function remoteStreamUrl(): string {
  // 多路复用路由以绝对形式注册；页面以其自身的文档基址解析
  // 其文档相对形式。另一来源上由 shell 持有的 Host
  // 通过传输提供该基址。
  const globals = globalThis as { __DSH_TRANSPORT__?: { streamBaseUrl?: string } }
  const url = new URL(REMOTE_STREAM_MUX_PATH.slice(1), globals.__DSH_TRANSPORT__?.streamBaseUrl ?? document.baseURI)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.href
}
