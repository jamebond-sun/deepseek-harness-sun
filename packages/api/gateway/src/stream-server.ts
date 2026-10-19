/** 承载多路复用 Typert Remote 流的 Host WebSocket 所有者。 */

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { Deque } from '@deepseek-ai/dsh-deque'
import { RemoteError, remoteErrorOf, type PeerScope, type RemoteUplinkWindow } from '@deepseek-ai/dsh-typert-protocol'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import {
  parseRemoteStreamClientMessage,
  type RemoteStreamClientMessage,
  type RemoteStreamFailure,
  type RemoteStreamServerMessage,
} from './stream-protocol.ts'

/**
 * 代表一个 Peer，为已解码的 wire 请求打开一个经过校验的 Remote 流。
 * `uplink` 携带 Client 的条目；`control` 取消逻辑流，
 * 且以 Remote 失败作为原因中止它时，会把该失败交付给 Client。
 * `window` 描述此流的完整帧收件箱预算。
 */
export type RemoteStreamOpener = (
  endpoint: string,
  payload: unknown,
  uplink: AsyncIterable<unknown>,
  peer: PeerScope,
  control: AbortController,
  window: RemoteUplinkWindow,
) => Promise<AsyncIterable<unknown>>

/** 单个套接字使用的打开器：其 Peer 在升级时固定。 */
type BoundStreamOpener = (
  endpoint: string,
  payload: unknown,
  uplink: AsyncIterable<unknown>,
  control: AbortController,
  window: RemoteUplinkWindow,
) => Promise<AsyncIterable<unknown>>

/** 将调用或载体失败转换为稳定的 wire 值。 */
export type RemoteStreamFailureMapper = (error: unknown) => RemoteStreamFailure

const MAX_MISSED_HEARTBEATS = 2

/** 持有 no-server WebSocket 接受器与每个活跃的逻辑流。 */
export class RemoteStreamMuxServer {
  private readonly server = new WebSocketServer({ noServer: true })
  private readonly connections = new Set<Promise<void>>()
  private readonly missedHeartbeats = new WeakMap<WebSocket, number>()
  private heartbeatTimer: NodeJS.Timeout | undefined

  /**
   * @param open - Gateway 流分发器。
   * @param failure - Gateway 的错误到 wire 映射器。
   * @param heartbeatIntervalMs - WebSocket Ping 控制帧之间的间隔。
   * @param streamInboxBytes - 单个逻辑流在失败前可缓冲的上行帧字节数。
   */
  constructor(
    private readonly open: RemoteStreamOpener,
    private readonly failure: RemoteStreamFailureMapper,
    private readonly heartbeatIntervalMs: number,
    private readonly streamInboxBytes: number,
  ) {}

  /**
   * 升级一个已获准的请求并开始服务其逻辑流。
   * 套接字打开的每个流都代表升级时获准的 Peer，
   * 且当该 Peer 的 scope 被释放时套接字关闭。
   * @param req - 已通过身份验证的 HTTP 升级请求。
   * @param socket - 移交给 WebSocket 服务端的载体套接字。
   * @param head - HTTP 升级头之后已读取的字节。
   * @param peer - 升级获准所代表的 Peer。
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, peer: PeerScope): void {
    this.server.handleUpgrade(req, socket, head, (websocket) => {
      const release = bindPeer(websocket, peer)
      if (release === undefined) return
      const alive = (): void => { this.missedHeartbeats.set(websocket, 0) }
      alive()
      this.startHeartbeat()
      const bound: BoundStreamOpener = (endpoint, payload, uplink, control, window) =>
        this.open(endpoint, payload, uplink, peer, control, window)
      const connection = new RemoteStreamMuxConnection(websocket, bound, this.failure, this.streamInboxBytes, alive)
      const done = connection.run().catch((error: unknown) => {
        console.error('[api-gateway] Remote stream connection failed:', error)
      }).then(async () => { await release() }).catch((error: unknown) => {
        console.error('[api-gateway] Remote stream scope cleanup failed:', error)
      })
      this.connections.add(done)
      void done.then(() => { this.connections.delete(done) })
    })
  }

  /** 终止所有套接字，并等待每个迭代器都已返回。 */
  async close(): Promise<void> {
    clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
    for (const socket of this.server.clients) socket.terminate()
    const closed = Promise.withResolvers<void>()
    this.server.close((error) => {
      if (error === undefined) closed.resolve()
      else closed.reject(error)
    })
    await closed.promise
    await Promise.all(this.connections)
  }

  /** 在首次升级后启动一个 `unref()` 定时器；它横跨无客户端的时段，直到 close()。 */
  private startHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) return
    this.heartbeatTimer = setInterval(() => {
      for (const socket of this.server.clients) {
        if (socket.readyState !== WebSocket.OPEN) continue
        const missed = this.missedHeartbeats.get(socket) as number
        if (missed >= MAX_MISSED_HEARTBEATS) {
          setImmediate(() => {
            if ((this.missedHeartbeats.get(socket) as number) >= MAX_MISSED_HEARTBEATS) {
              socket.terminate()
            }
          })
          continue
        }
        this.missedHeartbeats.set(socket, missed + 1)
        socket.ping()
      }
    }, this.heartbeatIntervalMs)
    this.heartbeatTimer.unref()
  }
}

interface ActiveStream {
  readonly abort: AbortController
  readonly inbox: UplinkInbox
  /** 取消逻辑流，并结束仍在等待其上行的任何 Host 读取。 */
  readonly stop: (reason: Error) => void
  done: Promise<void>
}

class RemoteStreamMuxConnection {
  private readonly streams = new Map<string, ActiveStream>()
  private writes = Promise.resolve()

  constructor(
    private readonly socket: WebSocket,
    private readonly open: BoundStreamOpener,
    private readonly failure: RemoteStreamFailureMapper,
    private readonly streamInboxBytes: number,
    private readonly alive: () => void,
  ) {}

  /**
   * 服务帧直到套接字关闭。Pong、任何收到的帧，以及一个先在本地
   * 发送缓冲区中等待然后才完成的下行写入，都算作对端活动，
   * 因此拥塞链路即便 Pong 被数据延后也能保住其套接字。
   * 立即完成的写入不能证明对端的任何状态，
   * 因此不计入。
   */
  async run(): Promise<void> {
    const closed = new Promise<void>((resolve) => {
      this.socket.once('close', resolve)
      this.socket.once('error', () => { this.socket.terminate() })
      this.socket.on('pong', this.alive)
      this.socket.on('message', (data, isBinary) => {
        this.alive()
        if (isBinary) {
          this.socket.close(1003, 'text messages required')
          return
        }
        try {
          this.receive(rawText(data))
        } catch {
          this.socket.close(1008, 'invalid Remote stream request')
        }
      })
    })
    await closed
    const active = [...this.streams.values()]
    for (const stream of active) stream.stop(new Error('Remote stream socket closed'))
    await Promise.all(active.map(stream => stream.done))
  }

  /**
   * 分发一个帧。此连接不再拥有的流的 `item`、`end` 和 `cancel` 会被丢弃：
   * 已结束的流在 Client 的在途帧仍在抵达时便已移出表。
   * 重复的 `open`
   * 是唯一会关闭套接字的协议违规。
   */
  private receive(text: string): void {
    const message = parseRemoteStreamClientMessage(text)
    switch (message.type) {
      case 'open': {
        this.openStream(message)
        return
      }
      case 'item': {
        this.streams.get(message.streamId)?.inbox.push(message.value, Buffer.byteLength(text, 'utf8'))
        return
      }
      case 'end': {
        this.streams.get(message.streamId)?.inbox.end()
        return
      }
      case 'cancel': {
        this.streams.get(message.streamId)?.stop(new Error('Remote stream cancelled'))
        return
      }
      /* v8 ignore next 4 -- parseRemoteStreamClientMessage admits only the four frame types above. */
      default: {
        const unknown: never = message
        throw new Error(`api gateway: unknown Remote stream client message ${JSON.stringify(unknown)}`)
      }
    }
  }

  private openStream(message: Extract<RemoteStreamClientMessage, { readonly type: 'open' }>): void {
    if (this.streams.has(message.streamId)) {
      throw new Error(`api gateway: duplicate Remote stream id ${JSON.stringify(message.streamId)}`)
    }
    const abort = new AbortController()
    // 在打开器 resolve 之前创建，使 Client 紧随 `open` 之后发送的
    // 条目在收件箱中等待而不是丢失。
    const inbox = new UplinkInbox(this.streamInboxBytes, message.endpoint, (error) => { abort.abort(error) })
    const active: ActiveStream = {
      abort,
      inbox,
      stop: (reason) => {
        abort.abort(reason)
        inbox.fail(reason)
      },
      done: Promise.resolve(),
    }
    this.streams.set(message.streamId, active)
    const done = this.pump(message.streamId, message.endpoint, message.payload, active)
    active.done = done
    const remove = (): void => { this.streams.delete(message.streamId) }
    void done.then(remove, remove)
  }

  private async pump(
    streamId: string,
    endpoint: string,
    payload: unknown,
    active: ActiveStream,
  ): Promise<void> {
    let outcome: { readonly failed: false } | { readonly failed: true; readonly error: unknown }
    try {
      const source = await this.open(endpoint, payload, active.inbox, active.abort, {
        maxBytes: this.streamInboxBytes,
        frameOverheadBytes: Buffer.byteLength(JSON.stringify({ type: 'item', streamId, value: null }), 'utf8') - 'null'.length,
      })
      for await (const value of source) {
        await this.send({ type: 'item', streamId, value })
      }
      outcome = { failed: false }
    } catch (error) {
      outcome = { failed: true, error }
    }
    // 下行已尘埃落定；之后的上行帧无法改变结果。
    active.inbox.fail(new Error('Remote stream ended'))
    if (active.abort.signal.aborted) {
      // 以 Remote 失败作为中止原因，表示 Gateway 或此多路复用器使流失败
      // （被拒绝或溢出的上行条目，或 `end` 之后的条目）；
      // Client 仍在等待那个终止帧。
      // 任何其他中止都是取消。
      const reason: unknown = active.abort.signal.reason
      if (remoteErrorOf(reason) !== undefined) await this.sendFailure(streamId, reason)
      return
    }
    if (outcome.failed) {
      await this.sendFailure(streamId, outcome.error)
      return
    }
    try {
      await this.send({ type: 'end', streamId })
    } catch (error) {
      await this.sendFailure(streamId, error)
    }
  }

  private async sendFailure(streamId: string, error: unknown): Promise<void> {
    if (this.socket.readyState !== WebSocket.OPEN) return
    try {
      await this.send({ type: 'error', streamId, error: this.failure(error) })
    } catch {
      // 无法编码或写入的终止帧会让逻辑流处于未定状态，
      // 因此使物理代失败。
      this.socket.close(1011, 'Remote stream failure could not be delivered')
    }
  }

  private send(message: RemoteStreamServerMessage): Promise<void> {
    let text: string
    try {
      text = JSON.stringify(message)
    } catch (cause) {
      return Promise.reject(new Error('api gateway: Remote stream item is not JSON serializable', { cause }))
    }
    const delivery = this.writes.then(() => new Promise<void>((resolve, reject) => {
      if (this.socket.readyState !== WebSocket.OPEN) {
        reject(new Error('api gateway: Remote stream socket is closed'))
        return
      }
      let queued = false
      this.socket.send(text, (error) => {
        if (error) {
          reject(error)
          return
        }
        if (queued) this.alive()
        resolve()
      })
      // 在 send() 之后读取：仍有缓冲字节意味着本地发送缓冲区已满，
      // 其完成需要对端确认数据。
      queued = this.socket.bufferedAmount > 0
    }))
    this.writes = delivery.catch(() => undefined)
    return delivery
  }
}

interface UplinkEntry {
  readonly value: unknown
  readonly bytes: number
}

const UPLINK_DONE: IteratorReturnResult<undefined> = { value: undefined, done: true }

/**
 * 一个逻辑流的有界单消费方上行队列，即 Host 方法通过
 * `invocation.uplink()` 读取的源。缓冲的帧字节数有上限：溢出，
 * 以及 Client `end` 之后的条目，都会使队列失败，并报告一个
 * 由连接用来使逻辑流失败的 Remote 失败。
 */
class UplinkInbox implements AsyncIterable<unknown>, AsyncIterator<unknown> {
  private readonly queue = new Deque<UplinkEntry>()
  private bytes = 0
  private ended = false
  private closed = false
  private taken = false
  private failure: Error | undefined
  private wake: (() => void) | undefined

  constructor(
    private readonly maxBytes: number,
    private readonly endpoint: string,
    private readonly onViolation: (error: RemoteError<'gateway/protocol' | 'gateway/uplink-overflow'>) => void,
  ) {}

  push(value: unknown, frameBytes: number): void {
    if (this.failure !== undefined || this.closed) return
    if (this.ended) {
      this.violate(new RemoteError(
        'gateway/protocol',
        'api gateway: Remote stream uplink item after end',
        { endpoint: this.endpoint },
      ))
      return
    }
    if (this.bytes + frameBytes > this.maxBytes) {
      this.violate(new RemoteError(
        'gateway/uplink-overflow',
        `api gateway: Remote stream uplink exceeded ${String(this.maxBytes)} buffered bytes`,
        { endpoint: this.endpoint },
      ))
      return
    }
    this.queue.pushBack({ value, bytes: frameBytes })
    this.bytes += frameBytes
    this.signal()
  }

  /** Client 半关闭；幂等。 */
  end(): void {
    if (this.ended) return
    this.ended = true
    this.signal()
  }

  /** 以 `error` 结束消费方的下一次读取；幂等，丢弃已缓冲条目。 */
  fail(error: Error): void {
    if (this.failure !== undefined) return
    this.failure = error
    this.queue.clear()
    this.bytes = 0
    this.signal()
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    if (this.taken) throw new Error('api gateway: Remote stream uplink inbox already has a consumer')
    this.taken = true
    return this
  }

  async next(): Promise<IteratorResult<unknown>> {
    while (true) {
      if (this.closed) return UPLINK_DONE
      const entry = this.queue.popFront()
      if (entry !== undefined) {
        this.bytes -= entry.bytes
        return { value: entry.value, done: false }
      }
      if (this.failure !== undefined) throw this.failure
      if (this.ended) return UPLINK_DONE
      if (this.wake !== undefined) throw new Error('api gateway: Remote stream uplink inbox has one pending read')
      await new Promise<void>((resolve) => { this.wake = resolve })
    }
  }

  /** 消费方停止读取：后续条目被丢弃，挂起的读取结束。 */
  return(): Promise<IteratorResult<unknown>> {
    this.closed = true
    this.queue.clear()
    this.bytes = 0
    this.signal()
    return Promise.resolve(UPLINK_DONE)
  }

  private violate(error: RemoteError<'gateway/protocol' | 'gateway/uplink-overflow'>): void {
    this.fail(error)
    this.onViolation(error)
  }

  private signal(): void {
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }
}

/**
 * 当 Peer 的 scope 被释放时关闭套接字。已释放的 scope 不再留下
 * 供套接字代表的 Peer，因此套接字立即关闭。
 * @returns 该注册的释放器，或套接字已关闭时的 `undefined`。
 */
function bindPeer(websocket: WebSocket, peer: PeerScope): (() => unknown) | undefined {
  try {
    return peer.ctx.effect(
      () => () => { websocket.close(1001, 'peer left') },
      'api-gateway: Remote stream socket bound to its Peer',
    )
  } catch {
    websocket.close(1001, 'peer left')
    return undefined
  }
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

/**
 * 拒绝一次升级，而不把套接字所有权移交给 ws。
 * @param socket - 接收 HTTP 拒绝的载体套接字。
 * @param status - 身份验证或浏览器信任的拒绝状态。
 */
export function rejectRemoteStreamUpgrade(socket: Duplex, status: 401 | 403 | 409): void {
  const reason = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Conflict'
  const body = reason.toLowerCase()
  socket.end([
    `HTTP/1.1 ${String(status)} ${reason}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${String(Buffer.byteLength(body))}`,
    '',
    body,
  ].join('\r\n'))
}
