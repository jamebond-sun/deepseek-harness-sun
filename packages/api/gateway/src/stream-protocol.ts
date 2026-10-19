/** Gateway 自有的 Remote 流与事件结果 RPC 的 wire 消息。 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import { isRemoteJsonValue } from '@deepseek-ai/dsh-typert-protocol'

/** 承载所有 Typert Remote 流的确切 WebSocket 路由。 */
export const REMOTE_STREAM_MUX_PATH = '/api/remote.mux'

/** 携带应用选定 Cordis 事件的 Gateway 内部逻辑流。 */
export const REMOTE_EVENT_STREAM_ENDPOINT = '$events'

/** 返回单个 Client Remote Event 结果的 Gateway 内部一元端点。 */
export const REMOTE_EVENT_RESULT_ENDPOINT = '$events/result'

/** 用于打开转发事件流的空标准 Remote 载荷。 */
export const REMOTE_EVENT_STREAM_PAYLOAD = { args: {} } as const

/** 证明 Host 事件源已就绪的首个条目的判别符。 */
export const REMOTE_EVENT_STREAM_READY = { type: 'ready' } as const

/** 一个活跃 Client Remote Event 代的不透明身份。 */
export type RemoteEventClientId = Branded<'RemoteEventClientId'>

/** 一条挂起的 Host 到 Client Remote Event 的不透明关联 id。 */
export type RemoteEventId = Branded<'RemoteEventId'>

/** 随每个已建立的 Client 事件代发布的稳定 Host 事实。 */
export interface RemoteEventHostInfo {
  /** Host 账户主目录，仅用于缩略显示的文件系统路径。 */
  readonly home: string
}

/** 将后续 HTTP 结果绑定到此活跃事件流的起始条目。 */
export interface RemoteEventReadyFrame {
  readonly type: 'ready'
  readonly clientId: RemoteEventClientId
  /** 附加到此连接代的稳定 Host 事实。 */
  readonly host: RemoteEventHostInfo
}

/** 一个作用域 Remote Event 携带的不透明 Agent 身份。 */
export type RemoteEventAgentId = Branded<'RemoteEventAgentId'>

/** 交付给一个 Client 代的一条 Host 通知。 */
export interface RemoteEventEmitFrame {
  readonly type: 'emit'
  readonly event: string
  readonly args: readonly unknown[]
}

/** 交付给一个 Client 代的一条挂起的 Agent 作用域瀑布。 */
export interface RemoteEventInvocationFrame {
  readonly type: 'waterfall'
  readonly event: string
  readonly eventId: RemoteEventId
  readonly agentId: RemoteEventAgentId
  readonly request: Readonly<Record<string, unknown>>
}

/** 之前以相同 id 交付的挂起瀑布的取消。 */
export interface RemoteEventCancellationFrame {
  readonly type: 'cancel'
  readonly eventId: RemoteEventId
}

/** Gateway 内部转发事件流承载的每一种条目。 */
export type RemoteEventDownlinkFrame =
  | RemoteEventReadyFrame
  | RemoteEventEmitFrame
  | RemoteEventInvocationFrame
  | RemoteEventCancellationFrame

/** JSON 请求字段，加上为传输而移除的 Host 取消生命周期。 */
export interface ProjectedRemoteEventRequest {
  readonly request: Readonly<Record<string, unknown>>
  readonly signal?: AbortSignal
}

/** Client 监听器拒绝 Host 瀑布时保留的错误字段。 */
export interface RemoteEventRejection {
  readonly name: string
  readonly message: string
  readonly code?: string
  readonly details?: unknown
}

/** Client 对一次作用域 Remote Event 交付的响应。 */
export interface RemoteEventResult {
  readonly clientId: RemoteEventClientId
  readonly eventId: RemoteEventId
  readonly outcome:
    | { readonly kind: 'next' }
    | { readonly kind: 'result'; readonly value?: unknown }
    | { readonly kind: 'rejected'; readonly error: RemoteEventRejection }
}

/**
 * 解析通过 Client 的 `$events/result` HTTP RPC 发送的一条结果。
 * @param value - 不受信任的结果载荷。
 * @returns 校验后的事件关联与结果字段。
 */
export function parseRemoteEventResult(value: unknown): RemoteEventResult {
  if (!isRecord(value)
    || !exactKeys(value, ['clientId', 'eventId', 'outcome'])
    || !isRemoteEventClientId(value.clientId)
    || !isRemoteEventId(value.eventId)
    || !isRecord(value.outcome)) {
    throw new Error('api gateway: invalid Remote event result')
  }
  const outcome = value.outcome
  if (outcome.kind === 'next' && exactKeys(outcome, ['kind'])) {
    return {
      clientId: value.clientId,
      eventId: value.eventId,
      outcome: { kind: 'next' },
    }
  }
  if (outcome.kind === 'result'
    && (exactKeys(outcome, ['kind']) || exactKeys(outcome, ['kind', 'value']))
    && (!Object.hasOwn(outcome, 'value') || isRemoteJsonValue(outcome.value))) {
    return {
      clientId: value.clientId,
      eventId: value.eventId,
      outcome: Object.hasOwn(outcome, 'value')
        ? { kind: 'result', value: outcome.value }
        : { kind: 'result' },
    }
  }
  if (outcome.kind === 'rejected'
    && exactKeys(outcome, ['kind', 'error'])) {
    return {
      clientId: value.clientId,
      eventId: value.eventId,
      outcome: { kind: 'rejected', error: parseRemoteEventRejection(outcome.error) },
    }
  }
  throw new Error('api gateway: invalid Remote event result')
}

/**
 * 从一个瀑布请求中移除直接的 Agent 与取消字段。
 * @param value - 瀑布的 `next` 回调之前的请求对象。
 * @param subject - Cordis scope 载体使用的 Agent。
 * @returns JSON 安全的请求字段与可选的 Host 取消信号。
 */
export function projectRemoteEventRequest(
  value: unknown,
  subject: object,
): ProjectedRemoteEventRequest {
  if (!isPlainRecord(value) || !Object.hasOwn(value, 'agent') || value.agent !== subject) {
    throw new TypeError('api gateway: Remote event request must carry its scoped Agent directly')
  }
  const signal = value.signal
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError('api gateway: Remote event request signal must be an AbortSignal')
  }
  const request: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'agent' || key === 'signal') continue
    const descriptor = typeof key === 'string' ? Object.getOwnPropertyDescriptor(value, key) : undefined
    if (typeof key !== 'string' || descriptor?.enumerable !== true) {
      throw new TypeError('api gateway: Remote event request has a non-JSON property')
    }
    request[key] = Reflect.get(value, key)
  }
  if (!isRemoteJsonValue(request)) {
    throw new TypeError('api gateway: Remote event request is not lossless JSON data')
  }
  return {
    request,
    ...(signal === undefined ? {} : { signal }),
  }
}

/**
 * 将任意拒绝投射为稳定且 JSON 安全的错误字段。
 * @param reason - Client 监听器抛出或拒绝的值。
 * @returns wire 安全的拒绝字段。
 */
export function projectRemoteEventRejection(reason: unknown): RemoteEventRejection {
  const record = typeof reason === 'object' && reason !== null ? reason : undefined
  const name = stringProperty(record, 'name') ?? 'Error'
  const message = stringProperty(record, 'message') ?? String(reason)
  const code = stringProperty(record, 'code')
  const details = record === undefined ? undefined : Reflect.get(record, 'details') as unknown
  return {
    name,
    message,
    ...(code === undefined ? {} : { code }),
    ...(details === undefined || !isRemoteJsonValue(details) ? {} : { details }),
  }
}

/**
 * 为 Host 的继续执行重建一个 Client 拒绝。
 * @param rejection - 已校验的 wire 安全错误字段。
 * @returns 一个保留远端 name、code 与 JSON 安全 details 的 Error。
 */
export function restoreRemoteEventRejection(rejection: RemoteEventRejection): Error {
  const error = new Error(rejection.message) as Error & { code?: string; details?: unknown }
  error.name = rejection.name
  if (rejection.code !== undefined) error.code = rejection.code
  if (rejection.details !== undefined) error.details = rejection.details
  return error
}

/**
 * 在 wire 边界识别非空的 Remote Event 关联 id。
 * @param value - 不受信任的 wire 值。
 * @returns 该值是否为有效的 Remote Event id。
 */
export function isRemoteEventId(value: unknown): value is RemoteEventId {
  return typeof value === 'string' && value.length > 0
}

/**
 * 在 wire 边界识别非空的 Remote Event Client id。
 * @param value - 不受信任的 wire 值。
 * @returns 该值是否标识一个事件流代。
 */
export function isRemoteEventClientId(value: unknown): value is RemoteEventClientId {
  return typeof value === 'string' && value.length > 0
}

/**
 * 识别作用域 Remote Event 使用的直接 Agent 身份。
 * @param value - 不受信任的 wire 值。
 * @returns 该值是否为非空的 Agent 身份。
 */
export function isRemoteEventAgentId(value: unknown): value is RemoteEventAgentId {
  return typeof value === 'string' && value.length > 0
}

/** 浏览器发出的一条逻辑流请求：open、一条上行条目、上行半关闭或 cancel。 */
export type RemoteStreamClientMessage =
  | {
    readonly type: 'open'
    readonly streamId: string
    readonly endpoint: string
    readonly payload: unknown
  }
  | { readonly type: 'item'; readonly streamId: string; readonly value?: unknown }
  | { readonly type: 'end'; readonly streamId: string }
  | { readonly type: 'cancel'; readonly streamId: string }

/** Host 交付的对载体安全的失败。 */
export interface RemoteStreamFailure {
  readonly code: string
  readonly message: string
  readonly details: object
}

/** Host 发出的一条逻辑流帧。 */
export type RemoteStreamServerMessage =
  | { readonly type: 'item'; readonly streamId: string; readonly value?: unknown }
  | { readonly type: 'error'; readonly streamId: string; readonly error: RemoteStreamFailure }
  | { readonly type: 'end'; readonly streamId: string }

/**
 * 解析并校验一条浏览器到 Host 的文本消息。
 * @param text - 完整的 WebSocket 文本消息。
 * @returns 校验后的逻辑流请求。
 */
export function parseRemoteStreamClientMessage(text: string): RemoteStreamClientMessage {
  return parseMessage(text, (value) => {
    if ((value.type === 'cancel' || value.type === 'end')
      && exactKeys(value, ['type', 'streamId'])
      && validId(value.streamId)) {
      return value as RemoteStreamClientMessage
    }
    if (value.type === 'item'
      && (exactKeys(value, ['type', 'streamId']) || exactKeys(value, ['type', 'streamId', 'value']))
      && validId(value.streamId)
      && (!Object.hasOwn(value, 'value') || isRemoteJsonValue(value.value))) {
      return value as RemoteStreamClientMessage
    }
    if (value.type === 'open'
      && exactKeys(value, ['type', 'streamId', 'endpoint', 'payload'])
      && validId(value.streamId)
      && typeof value.endpoint === 'string'
      && value.endpoint.length > 0) {
      return value as RemoteStreamClientMessage
    }
    throw new Error('api gateway: invalid Remote stream client message')
  })
}

/**
 * 解析并校验一条 Host 到浏览器的文本消息。
 * @param text - 完整的 WebSocket 文本消息。
 * @returns 校验后的逻辑流帧。
 */
export function parseRemoteStreamServerMessage(text: string): RemoteStreamServerMessage {
  return parseMessage(text, (value) => {
    if (value.type === 'item'
      && (exactKeys(value, ['type', 'streamId']) || exactKeys(value, ['type', 'streamId', 'value']))
      && validId(value.streamId)) {
      return value as RemoteStreamServerMessage
    }
    if (value.type === 'end' && exactKeys(value, ['type', 'streamId']) && validId(value.streamId)) {
      return value as RemoteStreamServerMessage
    }
    if (value.type === 'error'
      && exactKeys(value, ['type', 'streamId', 'error'])
      && validId(value.streamId)
      && isRecord(value.error)
      && exactKeys(value.error, ['code', 'message', 'details'])
      && typeof value.error.code === 'string'
      && typeof value.error.message === 'string'
      && isRecord(value.error.details)) {
      return value as RemoteStreamServerMessage
    }
    throw new Error('api gateway: invalid Remote stream server message')
  })
}

function parseMessage<T>(text: string, validate: (value: Record<string, unknown>) => T): T {
  let decoded: unknown
  try {
    decoded = JSON.parse(text) as unknown
  } catch (cause) {
    throw new Error('api gateway: Remote stream message is not JSON', { cause })
  }
  if (!isRecord(decoded)) throw new Error('api gateway: Remote stream message must be an object')
  return validate(decoded)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value)
  return keys.length === expected.length && expected.every(key => Object.hasOwn(value, key))
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function parseRemoteEventRejection(value: unknown): RemoteEventRejection {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['name', 'message'], ['code', 'details'])
    || typeof value.name !== 'string'
    || value.name.length === 0
    || typeof value.message !== 'string'
    || (Object.hasOwn(value, 'code') && typeof value.code !== 'string')
    || (Object.hasOwn(value, 'details') && !isRemoteJsonValue(value.details))) {
    throw new Error('api gateway: invalid Remote event rejection')
  }
  return {
    name: value.name,
    message: value.message,
    ...(typeof value.code === 'string' ? { code: value.code } : {}),
    ...(Object.hasOwn(value, 'details') ? { details: value.details } : {}),
  }
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value)
  return required.every(key => Object.hasOwn(value, key))
    && keys.every(key => typeof key === 'string' && (required.includes(key) || optional.includes(key)))
}

function stringProperty(value: object | undefined, key: string): string | undefined {
  if (value === undefined) return undefined
  const candidate: unknown = Reflect.get(value, key)
  return typeof candidate === 'string' ? candidate : undefined
}
