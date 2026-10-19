/** 转发 Remote Event 订阅与交付的 Client 所有者。 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  ConnectionGenerationSource,
  ConnectionHostInfo,
  ConnectionHandle,
} from '@deepseek-ai/dsh-client-connection/client'
import type {
  TypertClientEventListener,
  TypertOwnedValue,
  TypertRemoteEvent,
} from '@deepseek-ai/dsh-typert-protocol'
import { isRemoteJsonValue, isTypertOwnedValue } from '@deepseek-ai/dsh-typert-protocol'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import {
  REMOTE_EVENT_RESULT_ENDPOINT,
  REMOTE_EVENT_STREAM_ENDPOINT,
  REMOTE_EVENT_STREAM_PAYLOAD,
  isRemoteEventAgentId,
  isRemoteEventClientId,
  isRemoteEventId,
  projectRemoteEventRejection,
  type RemoteEventClientId,
  type RemoteEventDownlinkFrame,
  type RemoteEventEmitFrame,
  type RemoteEventInvocationFrame,
  type RemoteEventResult,
} from '../stream-protocol.ts'

/** 在选定的载体上打开 Gateway 内部转发事件流。 */
export type RemoteEventStreamOpener = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
) => AsyncIterable<unknown>

/** 抹去事件特定签名之后的一个已订阅监听器。 */
type RemoteEventListener = (this: Context, ...args: unknown[]) => unknown

/** 仅用于实例私有 Cordis 事件键的非类型化访问。 */
interface PrivateEventContext {
  on(name: string, listener: RemoteEventListener): () => boolean
  parallel(name: string, ...args: unknown[]): Promise<void>
  waterfall(
    thisArg: Context,
    name: string,
    request: Readonly<Record<string, unknown>>,
    next: () => Promise<symbol>,
  ): unknown
}

/** 一个 Client 监听器链认领或委托之后的传输结果。 */
type RemoteEventReplyOutcome =
  | { readonly kind: 'result'; readonly value: unknown }
  | { readonly kind: 'next' }
  | { readonly kind: 'rejected'; readonly error: ReturnType<typeof projectRemoteEventRejection> }

/** 私有的链尾标记，不会与 JSON 监听器结果冲突。 */
const REMOTE_EVENT_NEXT = Symbol('api-gateway.remote-event.next')

/** 持有 Cordis 注册、代泵送、瀑布分发与 HTTP 回复。 */
export class ClientRemoteEvents {
  private readonly eventPrefix = `internal/api-gateway/remote-event/${randomUUID()}/`
  private readonly unregisterGeneration: () => void
  private activeGeneration: Promise<void> | undefined

  /**
   * @param ownerCtx - 用于 Agent 上下文解析的 Client Gateway 根。
   * @param connection - 用于 HTTP 结果调用的 Connection 载体。
   * @param openStream - 选定的进程内或 WebSocket 流打开器。
   */
  constructor(
    private readonly ownerCtx: Context,
    private readonly connection: ConnectionHandle,
    private readonly openStream: RemoteEventStreamOpener,
  ) {
    this.unregisterGeneration = connection.registerGenerationSource(this.runGeneration)
  }

  /**
   * 在调用方的 fiber 中注册一个类型化 Remote Event 监听器。
   * @param callerCtx - 拥有该注册的 fiber 上下文。
   * @param event - 选定的转发事件。
   * @param listener - 由该事件声明派生的监听器。
   * @returns 此确切注册的释放器。
   */
  subscribe<Event extends TypertRemoteEvent>(
    callerCtx: Context,
    event: Event,
    listener: TypertClientEventListener<Event>,
  ): () => void {
    const dispose = privateEvents(callerCtx).on(
      this.eventKey(event),
      listener as RemoteEventListener,
    )
    return () => { dispose() }
  }

  /** 撤回代源，并等待活跃的监听器工作归于静止。 */
  async dispose(): Promise<void> {
    this.unregisterGeneration()
    await Promise.allSettled([this.activeGeneration])
  }

  /** 跟踪当前代，使插件释放等待监听器工作停止。 */
  private readonly runGeneration: ConnectionGenerationSource = (signal, ready) => {
    const tracked = this.pumpEvents(signal, ready).finally(() => {
      if (this.activeGeneration === tracked) this.activeGeneration = undefined
    })
    this.activeGeneration = tracked
    return tracked
  }

  /** 通过 Cordis 交付一条通知，同时遏制监听器失败。 */
  private deliver(frame: RemoteEventEmitFrame): void {
    void privateEvents(this.ownerCtx)
      .parallel(this.eventKey(frame.event), ...frame.args)
      .catch((error: unknown) => { this.reportError(frame.event, error) })
  }

  /** 在转发事件逻辑流上运行一个 Connection 代。 */
  private async pumpEvents(
    signal: AbortSignal,
    ready: (host: ConnectionHostInfo) => void,
  ): Promise<void> {
    let clientId: RemoteEventClientId | undefined
    const failed = new AbortController()
    const generationSignal = AbortSignal.any([signal, failed.signal])
    const active = new Map<string, AbortController>()
    const tasks = new Set<Promise<void>>()
    const source = this.openStream(
      REMOTE_EVENT_STREAM_ENDPOINT,
      REMOTE_EVENT_STREAM_PAYLOAD,
      generationSignal,
    )
    let streamFailed = false
    let streamError: unknown
    try {
      for await (const value of source) {
        if (clientId === undefined) {
          const opening = parseRemoteEventReady(value)
          clientId = opening.clientId
          ready(opening.host)
          continue
        }
        const frame = parseRemoteEventFrame(value)
        if (frame.type === 'cancel') {
          active.get(frame.eventId)?.abort(new Error('client api: Remote event was cancelled by the Host'))
          continue
        }
        if (frame.type === 'emit') {
          this.deliver(frame)
          continue
        }
        const controller = new AbortController()
        active.set(frame.eventId, controller)
        const deliverySignal = AbortSignal.any([generationSignal, controller.signal])
        const task = this.answer(frame, clientId, deliverySignal)
          .catch((error: unknown) => {
            if (!deliverySignal.aborted) failed.abort(error)
          })
          .finally(() => {
            active.delete(frame.eventId)
            tasks.delete(task)
          })
        tasks.add(task)
      }
    } catch (error) {
      streamFailed = true
      streamError = error
    } finally {
      for (const controller of active.values()) {
        controller.abort(new Error('client api: Remote event generation ended'))
      }
      await Promise.allSettled(tasks)
    }
    if (failed.signal.aborted) {
      throw toError(failed.signal.reason, 'client api: Remote event result delivery failed')
    }
    if (signal.aborted) return
    if (streamFailed) throw streamError
    throw new Error('client api: forwarded Remote event stream ended unexpectedly')
  }

  private async answer(
    frame: RemoteEventInvocationFrame,
    clientId: RemoteEventClientId,
    signal: AbortSignal,
  ): Promise<void> {
    const adapter = this.ownerCtx.typert.contexts.getClient('agent')
    let resolved: Context | TypertOwnedValue<Context> | undefined
    try {
      resolved = adapter?.resolve(frame.agentId)
    } catch (error) {
      this.reportError(frame.event, error)
    }
    const owned = isTypertOwnedValue(resolved) ? resolved : undefined
    try {
      const target = isTypertOwnedValue(resolved) ? resolved.value : resolved
      let outcome: RemoteEventReplyOutcome = { kind: 'next' }
      if (target !== undefined) {
        try {
          outcome = await this.dispatchWaterfall(target, frame, signal)
        } catch (error) {
          if (signal.aborted) return
          outcome = { kind: 'rejected', error: projectRemoteEventRejection(error) }
        }
      }
      if (signal.aborted) return
      const result: RemoteEventResult = {
        clientId,
        eventId: frame.eventId,
        outcome: outcome.kind === 'result' && outcome.value === undefined
          ? { kind: 'result' }
          : outcome,
      }
      const response = await this.connection.rpc.call(
        '/api',
        REMOTE_EVENT_RESULT_ENDPOINT,
        { args: result },
        signal,
      )
      if (!response.ok) throw new Error(response.error.message)
    } finally {
      owned?.[Symbol.dispose]()
    }
  }

  private async dispatchWaterfall(
    target: Context,
    frame: RemoteEventInvocationFrame,
    signal: AbortSignal,
  ): Promise<RemoteEventReplyOutcome> {
    const request = {
      ...frame.request,
      agent: target,
      signal,
    }
    // 取消会到达处理方，其上下文在尘埃落定之前保持被持有状态。
    const value = await privateEvents(target).waterfall(
      target,
      this.eventKey(frame.event),
      request,
      () => Promise.resolve(REMOTE_EVENT_NEXT),
    )
    if (value !== REMOTE_EVENT_NEXT && value !== undefined && !isRemoteJsonValue(value)) {
      throw new TypeError('Remote event listener result is not lossless JSON data')
    }
    return value === REMOTE_EVENT_NEXT
      ? { kind: 'next' }
      : { kind: 'result', value }
  }

  private eventKey(event: string): string {
    return `${this.eventPrefix}${event}`
  }

  private reportError(event: string, error: unknown): void {
    console.error(`client api: Remote event ${JSON.stringify(event)} listener threw:`, error)
  }
}

/** 校验并返回一个代的 Client 身份与 Host 事实。 */
function parseRemoteEventReady(value: unknown): {
  readonly clientId: RemoteEventClientId
  readonly host: ConnectionHostInfo
} {
  if (!isRemoteEventRecord(value)
    || !hasExactRemoteEventKeys(value, ['type', 'clientId', 'host'])
    || value.type !== 'ready'
    || !isRemoteEventClientId(value.clientId)
    || !isRemoteEventRecord(value.host)
    || !hasExactRemoteEventKeys(value.host, ['home'])
    || typeof value.host.home !== 'string') {
    throw new TypeError('client api: forwarded Remote event stream did not begin with ready')
  }
  return { clientId: value.clientId, host: { home: value.host.home } }
}

/** 校验来自 Gateway 内部转发事件流的一个不受信任的值。 */
function parseRemoteEventFrame(value: unknown): Exclude<RemoteEventDownlinkFrame, { type: 'ready' }> {
  if (!isRemoteEventRecord(value)) invalidRemoteEventFrame()
  if (value.type === 'cancel'
    && hasExactRemoteEventKeys(value, ['type', 'eventId'])
    && isRemoteEventId(value.eventId)) {
    return { type: 'cancel', eventId: value.eventId }
  }
  if (value.type === 'emit'
    && hasExactRemoteEventKeys(value, ['type', 'event', 'args'])
    && validRemoteEventName(value.event)
    && Array.isArray(value.args)
    && isRemoteJsonValue(value.args)) {
    return { type: 'emit', event: value.event, args: value.args }
  }
  if (value.type === 'waterfall'
    && hasExactRemoteEventKeys(value, ['type', 'event', 'eventId', 'agentId', 'request'])
    && validRemoteEventName(value.event)
    && isRemoteEventId(value.eventId)
    && isRemoteEventAgentId(value.agentId)
    && isRemoteEventRecord(value.request)
    && !Object.hasOwn(value.request, 'agent')
    && !Object.hasOwn(value.request, 'signal')
    && isRemoteJsonValue(value.request)) {
    return {
      type: 'waterfall',
      event: value.event,
      eventId: value.eventId,
      agentId: value.agentId,
      request: value.request,
    }
  }
  invalidRemoteEventFrame()
}

function isRemoteEventRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactRemoteEventKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value)
  return ownKeys.length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function validRemoteEventName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function invalidRemoteEventFrame(): never {
  throw new TypeError('client api: invalid forwarded Remote event frame')
}

function privateEvents(ctx: Context): PrivateEventContext {
  return ctx
}

function toError(reason: unknown, message: string): Error {
  return reason instanceof Error ? reason : new Error(message, { cause: reason })
}
