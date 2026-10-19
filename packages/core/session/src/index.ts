/**
 * 事件溯源的 session 服务：只追加的 session 日志、内存存储，以及派生的 LLM
 * 消息历史。持久化是插件关注点（订阅 `session/event`，在 `session/flush`
 * 时排空）。
 *
 * @module @deepseek-ai/dsh-session
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { isAbsolute } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { assertNever, deepFreeze, snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import { scopeOf, scopeTarget } from '@deepseek-ai/dsh-scope'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import type { Message } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionLogOffset, SessionSeq } from './types.ts'
import type { TypertLookup } from '@deepseek-ai/dsh-typert-protocol'
import type { CreateSessionOptions, EpochHeader, PluginRecord, PluginRecordMap, PluginRecordType, PrepareSessionOptions, RequestContext, SessionEvent, SessionEventMap, SessionEventType, SessionHeader, SessionId, SessionSeedEventState, SurfaceIntent, SurfaceEventType } from './types.ts'
import { SurfaceManager, validateSessionEventData, validateSurfaceMetadata } from './surface.ts'
import type { SessionSurface, SessionMessageProjection } from './surface.ts'
import { foldRequestHeader } from './request-header.ts'
import { ToolHistoryProjection } from './tool-history.ts'
import type { ToolHistory } from '@deepseek-ai/dsh-llm'

import { buildForkSeed } from './fork.ts'

export { buildForkSeed } from './fork.ts'
export * from './types.ts'
export { SessionPreparation } from './preparation.ts'
export type { SessionPreparationOptions } from './preparation.ts'
export type { AssistantMessage, DeveloperMessage, SystemMessage, ToolResultMessage, UserMessage } from '@deepseek-ai/dsh-llm'
export { interruptedTurnClosers, ToolCallRecovery, TOOL_NOT_STARTED, TOOL_OUTCOME_UNKNOWN } from './repair.ts'
export type { SessionSurface, SurfaceFoldReplacement, SurfaceFoldResult, SessionMessageProjection, SessionMessageProjectionContext } from './surface.ts'
export { deriveEventMessage, foldSurface, isAppendSurfaceEvent, isReplacementSurfaceEvent, isSurfaceEvent, isSurfaceEligibleType } from './surface.ts'
export { canonicalHeader, foldRequestHeader, headerEquals } from './request-header.ts'
export { KNOWN_SESSION_EVENT_TYPES } from './known-event-types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessions: SessionStore
  }

  interface Events {
    /**
     * session 发布期间的创建公告。同步抛出会否决并连同配对的释放一起回滚；
     * 派发期间请求的 detach 会被延迟。返回的 Promise 被拒绝只会记录日志，
     * 无法追溯否决这个同步边界。
     * 作用域过滤派发（`@deepseek-ai/dsh-scope`）：agent 作用域的监听器只接
     * 收通过该 agent 上下文进入的 session。
     * @param session - 刚进入并公告的 session。
     * @mode emit
     */
    'session/created'(this: Scoped<Session>, session: Session): void
    /**
     * 在一个已公告 session 离开存储时发出一次，包括发布回滚，但对创建公告
     * 尚未开始的条目从不发出。监听器失败会被记录并包容。
     * 作用域过滤派发（`@deepseek-ai/dsh-scope`）复用所有者作用域。
     * @param session - 在存储中不再活跃的 session。
     * @mode emit
     */
    'session/disposed'(this: Scoped<Session>, session: Session): void
    /**
     * 提交后的即发即忘追加馈送。监听器快照在日志推入之前解析，但回调在其
     * 之后运行；观察者失败被记录并包容，不会使已提交的追加失败。
     * 作用域过滤派发（`@deepseek-ai/dsh-scope`）：agent 作用域的监听器只接
     * 收通过该 agent 上下文进入的 session 的事件。
     * @param session - 日志增长了该事件的 session。
     * @param event - 按记录原样的已追加事件。
     * @mode emit
     */
    'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void
    /**
     * 等待的并行持久化检查点：每个监听器都运行且调用方等待全部完成，没有
     * 瀑布否决。作用域过滤派发（`@deepseek-ai/dsh-scope`）复用 session 的
     * 所有者作用域。
     * @param session - 其缓冲事件必须到达持久存储的 session。
     * @mode parallel
     */
    'session/flush'(this: Scoped<Session>, session: Session): Promise<void> | void
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertLookupMap {
    session: TypertLookup<Session, SessionId>
  }
}

/** 就地验证并冻结一个脱离的创建 header。 */
function validateSessionHeader(id: SessionId, input: unknown): SessionHeader {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('session header is not a plain JSON record')
  }
  const record = input as Record<string, unknown>
  if (Object.hasOwn(record, 'seedLength')) {
    throw new Error('session header has invalid field "seedLength"')
  }
  if (record.version !== SESSION_FORMAT_VERSION) {
    throw new Error(`session header version must be ${SESSION_FORMAT_VERSION}, got ${String(record.version)}`)
  }
  if (record.id !== id) {
    throw new Error(`session header id "${String(record.id)}" does not match session id "${id}"`)
  }
  if (typeof record.createdAt !== 'number'
    || !Number.isSafeInteger(record.createdAt)
    || record.createdAt < 0) {
    throw new Error('session header createdAt must be a non-negative safe integer')
  }
  if (record.cwd !== undefined) {
    if (typeof record.cwd !== 'string') throw new Error('session header cwd must be a string')
    if (!isAbsolute(record.cwd)) {
      throw new Error(`session header cwd must be an absolute path, got "${record.cwd}"`)
    }
  }
  if (record.parentSession !== undefined && typeof record.parentSession !== 'string') {
    throw new Error('session header parentSession must be a string')
  }
  if (typeof record.isSeeded !== 'boolean') {
    throw new Error('session header isSeeded must be a boolean')
  }
  if (record.origin !== undefined && record.origin !== 'subagent') {
    throw new Error('session header origin must be "subagent"')
  }
  if (record.delegationDepth !== undefined
    && (typeof record.delegationDepth !== 'number' || !Number.isSafeInteger(record.delegationDepth) || record.delegationDepth < 0)) {
    throw new Error('session header delegationDepth must be a non-negative safe integer')
  }
  if (record.agentPreset !== undefined && typeof record.agentPreset !== 'string') {
    throw new Error('session header agentPreset must be a string')
  }
  return deepFreeze(record as unknown as SessionHeader)
}

/** 就地验证并冻结一个独占持有的持久化 header。 */
function validateRestoredSessionHeader(id: SessionId, input: unknown): SessionHeader {
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    const prototype = Reflect.getPrototypeOf(input)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('session header is not a plain JSON record')
    }
  }
  return validateSessionHeader(id, input)
}

/** 脱离、验证并冻结 session 发布的创建元数据。 */
function snapshotSessionHeader(id: SessionId, source?: SessionHeader): SessionHeader {
  const input: unknown = source === undefined
    ? { version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), isSeeded: false }
    : source
  const snapshot = snapshotJsonValue(input)
  if (snapshot === undefined) throw new Error('session header is not losslessly JSON-serializable')
  return validateSessionHeader(id, snapshot)
}

/**
 * 验证一个独占持有的事件并深度冻结其已标识消息，不复制事件。调用方转移一
 * 个没有生产者保留、且不与其他事件共享可变子对象的对象图。无法保证独占所
 * 有权时使用 {@link snapshotSessionEvent}。
 * @param event - 经受信边界导入的独占持有事件。
 * @returns 验证过且消息已深冻结的同一事件对象。
 * @throws 当事件局部 surface 元数据、request-header 字段或消息不变量无效
 *   时；不检查历史关系。
 */
export function adoptSessionEvent<T extends SessionEvent>(event: T): T {
  validateSessionEventData(event, `session event at seq ${event.seq}`)
  validateSurfaceMetadata(event)
  assertMessageEventShape(
    event,
    `session event at seq ${event.seq}`,
  )
  switch (event.type) {
    case 'user/message':
      deepFreeze(event.data)
      break
    case 'developer/message':
    case 'system/message':
    case 'assistant/message':
    case 'tool/result':
      deepFreeze(event.data.message)
      break
    default:
      // SessionEventMap 可合并扩展；插件自有事件不携带核心消息。
      break
  }
  return event
}

/**
 * 脱离一个事件，同时为其已标识消息保持深层不可变。
 * @param event - 经查询或持久化边界导入的事件。
 * @returns 带验证过且深冻结消息的脱离事件快照。
 */
export function snapshotSessionEvent<T extends SessionEvent>(event: T): T {
  return adoptSessionEvent(structuredClone(event))
}

/** 在一次遍历的 JSON 物化之后验证固定的事件信封。 */
function assertSessionEventEnvelope(value: unknown, index: number): asserts value is SessionEvent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`seed event at index ${index} has an invalid event envelope`)
  }
  const event = value as Record<string, unknown>
  for (const key in event) {
    switch (key) {
      case 'type':
      case 'seq':
      case 'time':
      case 'data':
      case 'surfaceOp':
      case 'sourceEventSeqs':
      case 'ignorable':
        break
      default:
        throw new Error(`seed event at index ${index} has an invalid event envelope`)
    }
  }
  const type = event['type']
  const seq = event['seq']
  const time = event['time']
  if (typeof type !== 'string'
    || typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0 || Object.is(seq, -0)
    || typeof time !== 'number' || !Number.isSafeInteger(time)
    || event['data'] === undefined
    || (event['ignorable'] !== undefined && event['ignorable'] !== true)) {
    throw new Error(`seed event at index ${index} has an invalid event envelope`)
  }
  validateSessionEventData(event as SessionEvent, `seed ${type} at index ${index}`)
  switch (type) {
    case 'request/header':
    case 'developer/message':
    case 'system/message':
    case 'user/message':
    case 'assistant/attempt':
    case 'assistant/message':
    case 'tool/result':
      assertCurrentLlmShape(event, index)
      break
  }
}

/** 在 seed/加载边界拒绝过时的请求 header 与畸形消息。 */
function assertCurrentLlmShape(event: Record<string, unknown>, index: number): void {
  const data = event['data']
  const record = typeof data === 'object' && data !== null
    ? data as Record<string, unknown>
    : undefined
  if (event['type'] === 'request/header') {
    const headerRecord = record?.['header'] as Record<string, unknown>
    const config = headerRecord['config']
    if (!hasProviderModel(config)) throw new Error(`seed request/header at index ${index} lacks provider/model`)
    const configRecord = config as Record<string, unknown>
    const reasoningEffort = configRecord['reasoningEffort']
    if (reasoningEffort !== undefined
      && (typeof reasoningEffort !== 'string' || reasoningEffort.length === 0)) {
      throw new Error(`seed request/header at index ${index} has an invalid reasoningEffort`)
    }
    assertAdapterDefaults(headerRecord['adapterDefaults'], configRecord, index)
    const reason = record?.['reason']
    if (reason !== 'initial' && reason !== 'resume' && reason !== 'change' && reason !== 'series') {
      throw new Error(`seed request/header at index ${index} has an invalid reason`)
    }
    if (record?.['startsSeries'] !== undefined && record['startsSeries'] !== true) {
      throw new Error(`seed request/header at index ${index} has an invalid startsSeries marker`)
    }
  }
  const type = event['type']
  if (type === 'assistant/attempt') {
    assertAssistantSettlementShape(record, type, index)
    return
  }
  if (!isMessageEventType(type)) return
  assertMessageEventShape(event, `seed ${type} at index ${index}`)
  if (type === 'assistant/message') {
    assertAssistantSettlementShape(record, type, index)
  }
}

/** 验证恢复的 Session 生命周期逻辑直接使用的字段，不回放内嵌流。 */
function assertAssistantSettlementShape(
  data: Record<string, unknown> | undefined,
  type: 'assistant/attempt' | 'assistant/message',
  index: number,
): void {
  const turn = data?.['turn']
  const step = data?.['step']
  if (typeof turn !== 'number' || !Number.isSafeInteger(turn) || turn < 0 || Object.is(turn, -0)
    || typeof step !== 'number' || !Number.isSafeInteger(step) || step < 0 || Object.is(step, -0)
    || !Array.isArray(data?.['stream'])) {
    throw new Error(`seed ${type} at index ${index} has invalid settlement fields`)
  }
}

const allowedAdapterKeys = new Set(['reasoningEffort', 'maxTokens'])

/** 验证从持久化请求 header 导入的 adapter 默认标记。 */
function assertAdapterDefaults(
  value: unknown,
  config: Record<string, unknown>,
  index: number,
): void {
  if (value === undefined) return
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`seed request/header at index ${index} has invalid adapterDefaults`)
  }
  const defaults = value as Record<string, unknown>
  if (Object.keys(defaults).some(key => !allowedAdapterKeys.has(key))
    || Object.values(defaults).some(marker => marker !== true)
    || defaults['reasoningEffort'] === true && config['reasoningEffort'] === undefined
    || defaults['maxTokens'] === true && config['maxTokens'] === undefined) {
    throw new Error(`seed request/header at index ${index} has invalid adapterDefaults`)
  }
}

/** 其载荷携带已标识消息的 surface 事件类型。 */
function isMessageEventType(type: unknown): type is SurfaceEventType {
  return type === 'developer/message' || type === 'system/message' || type === 'user/message'
    || type === 'assistant/message' || type === 'tool/result'
}

const MESSAGE_ROLE_BY_TYPE: Record<SurfaceEventType, Message['role']> = {
  'system/message': 'system',
  'developer/message': 'developer',
  'user/message': 'user',
  'assistant/message': 'assistant',
  'tool/result': 'tool',
}

/** 只为安全回放一条消息验证事件特定的不变量。 */
function assertMessageEventShape(event: Record<string, unknown>, subject: string): void {
  const type = event['type']
  if (!isMessageEventType(type)) return
  const data = event['data']
  const record = typeof data === 'object' && data !== null
    ? data as Record<string, unknown>
    : undefined
  const message = type === 'user/message' ? record : record?.['message']
  if (typeof message !== 'object' || message === null
    || typeof (message as Record<string, unknown>)['id'] !== 'string'
    || (message as Record<string, unknown>)['id'] === '') {
    throw new Error(`${subject} lacks an identified message`)
  }
  const messageRecord = message as Record<string, unknown>
  const expectedRole = MESSAGE_ROLE_BY_TYPE[type]
  if (messageRecord['role'] !== expectedRole) {
    throw new Error(`${subject} message must have role "${expectedRole}"`)
  }
  const source = messageRecord['source']
  if (typeof source !== 'object' || source === null
    || typeof (source as Record<string, unknown>)['kind'] !== 'string'
    || (source as Record<string, unknown>)['kind'] === '') {
    throw new Error(`${subject} message has invalid source`)
  }
  if (!Array.isArray(messageRecord['content'])) {
    throw new Error(`${subject} message has invalid content`)
  }
  const sourceRecord = source as Record<string, unknown>
  if (type === 'system/message') {
    if (sourceRecord['kind'] !== 'system-prompt') {
      throw new Error(`${subject} message must have system-prompt source`)
    }
    return
  }
  if (type === 'assistant/message') {
    if (sourceRecord['kind'] !== 'model' || !hasProviderModel(sourceRecord)) {
      throw new Error(`${subject} message must have model source`)
    }
    return
  }
  if (type !== 'tool/result') return
  if (sourceRecord['kind'] !== 'tool'
    || typeof sourceRecord['callId'] !== 'string'
    || sourceRecord['callId'] === '') {
    throw new Error(`${subject} message must have tool source`)
  }
  if (messageRecord['toolCallId'] !== sourceRecord['callId']) {
    throw new Error(`${subject} message has mismatched tool call ids`)
  }
}

/** 未知值是否携带当前的 provider/model 对。 */
function hasProviderModel(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const pair = value as Record<string, unknown>
  return typeof pair['provider'] === 'string' && pair['provider'].length > 0
    && typeof pair['model'] === 'string' && pair['model'].length > 0
}

type SessionCallback = (...args: unknown[]) => unknown

/** 解析一个监听器快照，包括 Cordis 的内部派发检查。 */
function collectSessionCallbacks(ctx: Context, args: unknown[]): SessionCallback[] {
  return [...ctx.events.dispatch('emit', args)] as SessionCallback[]
}

/** 以逐监听器包容的方式调用一个已解析的仅观察监听器快照。 */
function invokeContainedSessionObservers(
  ctx: Context,
  name: 'session/event' | 'session/disposed',
  id: SessionId,
  args: unknown[],
  callbacks: SessionCallback[],
): void {
  for (const callback of callbacks) {
    try {
      const returned: unknown = callback(...args)
      void Promise.resolve(returned).catch((error: unknown) => {
        ctx.logger.warn(`session "${id}": ${name} listener rejected: ${String(error)}`)
      })
    } catch (error: unknown) {
      ctx.logger.warn(`session "${id}": ${name} listener threw: ${String(error)}`)
    }
  }
}

/** 一个确切存储条目的全部可变生命周期状态。 */
interface SessionEntry {
  readonly id: SessionId
  readonly session: Session
  readonly carrier: Scoped<Session>
  readonly emitCtx: Context
  announced: boolean
  announcing: boolean
  appending: boolean
  detachRequested: boolean
  detach(): void
}

/** 追加路径的存储附件；模块私有，公开上保持 Session 与存储无关。 */
const attachments = new WeakMap<Session, SessionEntry>()

/**
 * {@link PluginRecordType} 的文法：`plugin:` 后跟以斜杠分隔的段，段由小写
 * 字母、数字、`.`、`_` 与 `-` 组成，每段以字母或数字开头。
 */
const PLUGIN_RECORD_TYPE = /^plugin:[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/u

/**
 * 某个事件类型名是否遵循插件记录文法。
 * @param type - 一个事件类型名。
 * @returns 该名字是否为 {@link PluginRecordType}。
 */
function isPluginRecordType(type: string): type is PluginRecordType {
  return PLUGIN_RECORD_TYPE.test(type)
}

/**
 * 在对照插件记录文法检查其类型之后，把一个构造好的插件记录类型化为日志事
 * 件。已恢复的 Session 在事件被标记为可忽略时，已经持有类型在
 * `SessionEventMap` 之外的事件；插件记录就是这样一个事件。
 * @param value - 由 {@link Session} 构建的冻结记录信封。
 * @throws 当记录类型在插件记录文法之外时。
 */
function assertPluginRecordEvent(value: unknown): asserts value is SessionEvent {
  const { type } = value as { readonly type: string }
  if (!isPluginRecordType(type)) {
    throw new Error(`plugin record type "${type}" must be "plugin:" followed by lowercase slash-separated segments`)
  }
}

/** 对 {@link Session} 记录提交的模块私有访问，由其静态块赋值一次。 */
let commitPluginRecord: (session: Session, type: PluginRecordType, data: unknown) => SessionSeq

/**
 * 追加一条实验性插件记录：一个标记为 `ignorable` 的事件，其类型声明在
 * {@link PluginRecordMap} 中、在 {@link SessionEventMap} 之外。插件记录目
 * 录把它与已发布的事件 schema 分开列出。不识别该类型的读取方保留并跳过该
 * 记录，它从不进入模型可见 surface，分叉与恢复会连同日志其余部分一起携带
 * 它。Session 格式迁移尽力保留记录，因此记录持有其所有者可以丢失而不改变
 * 日志其余部分解读方式的插件自有状态。
 *
 * 只有 `packages/experimental/` 下的生产源码可以调用此函数；
 * `verify-plugin-record-callers` 门禁拒绝本仓库中任何其他生产调用方。用
 * {@link pluginRecordOf} 读回记录。
 * @param session - 接收该记录的日志的 Session。
 * @param type - 声明的记录名：`plugin:` 后跟以斜杠分隔的段，段由小写字母、
 *   数字、`.`、`_` 与 `-` 组成，每段以字母或数字开头。
 * @param data - JSON 载荷，进入日志前先做快照。
 * @returns 已提交记录的序号。
 * @throws 当 `type` 在该文法之外、`data` 不能无损 JSON 序列化，或调用重入
 *   另一个追加的发布时；被拒绝的记录不改变日志。
 */
export function appendPluginRecord<K extends Extract<keyof PluginRecordMap, PluginRecordType>>(
  session: Session,
  type: K,
  data: NoInfer<PluginRecordMap[K]>,
): SessionSeq {
  return commitPluginRecord(session, type, data)
}

/**
 * 把一条已提交事件读作插件记录。V3 到 V4 的格式边还把每个未知的可忽略 V3
 * 事件重命名进 `plugin:` 命名空间，因此所有者在自己的包名下命名其记录并验
 * 证 `data`。
 * @param event - 任意已提交的 Session 事件，活跃或恢复的。
 * @returns 该记录；当事件不是类型遵循插件记录文法的可忽略事件时为
 *   undefined。
 */
export function pluginRecordOf(event: SessionEvent): PluginRecord | undefined {
  const type: string = event.type
  if (event.ignorable !== true || !isPluginRecordType(type)) return undefined
  return { type, seq: event.seq, time: event.time, data: event.data }
}

/**
 * 一个事件溯源的 session：{@link SessionEvent} 的只追加日志。
 *
 * 普通类（非 Service）——通过 `ctx.sessions.create()` 创建活跃实例，通过
 * {@link create} 创建脱离实例。以既有事件日志播种会回放/分叉一个 session。
 * @typert object
 */
export class Session {
  private log: SessionEvent[] = []
  /** surface 接纳与投影状态的唯一增量所有者。 */
  private readonly surfaceManager: SurfaceManager

  /** 本 session 事件日志之上的有序 surface。 */
  get surface(): SessionSurface {
    return this.surfaceManager
  }

  /**
   * 脱离且深冻结的创建元数据（格式版本、cwd、谱系，以及是否存在分叉历
   * 史）。由存储通过 `ctx.sessions.create()` 提供。不带存储持有的 header
   * 创建 `Session` 时，会合成一个最小 header（盖入当前
   * {@link SESSION_FORMAT_VERSION}），因此 `session.header` 始终存在。它
   * 不进入事件日志——它是存储关注点，不是可回放的会话状态。
   */
  readonly header: SessionHeader

  /** 从本 Session 的分叉父级继承的前导事件数量。 */
  readonly inheritedEventCount: SessionLogOffset

  /** session 身份，取自其持久 header 的单一副本。 */
  get id(): SessionId {
    return this.header.id
  }

  /**
   * 构造器 seed 长度（无 seed 时为 0），在任何构造期间追加的 marker 之前。
   * seed 事件从不在 `session/event` 上发布。在存储附加之前追加的 marker 占
   * 用该 seq 且同样不发布；否则该 seq 可供下一次追加使用。
   *
   * 该进程内偏移不持久化。分叉 seed 可以已包含子级的继承 marker 与合成收尾
   * 事件，因此其子级自有历史从 {@link inheritedEventCount} 开始、在此偏移之
   * 前。恢复的 Session 的 seed 包含其完整存储日志，而其继承计数保留持久分
   * 叉切点。需要完整规范历史的消费方从 seq 0 开始。
   */
  readonly firstLiveSeq: SessionLogOffset

  /**
   * 为本对象生命周期产生的第一个事件。新分叉包含其子级自有的 seed marker
   * 与收尾事件；恢复的 Session 从其完整存储前缀之后开始。该进程内捕获偏移
   * 不持久化。
   */
  readonly firstLifecycleSeq: SessionLogOffset

  /**
   * 通过验证并对借来的 seed 事件与存储元数据做快照来创建脱离 session。
   * @param id - session 身份。
   * @param seed - 可选的借来的回放或分叉事件。
   * @param header - 可选的借来的存储元数据。
   * @param inheritedEventCount - 有 seed header 时的确切分叉继承前缀长度。
   * @param projections - 插件自有消息变更的纯解释器。
   * @returns 一个脱离 session。
   * @throws 当 seed 事件需要缺失的消息解释器或验证失败时。
   */
  static create(
    id: SessionId,
    seed?: readonly SessionEvent[],
    header?: SessionHeader,
    inheritedEventCount?: SessionLogOffset,
    projections?: readonly SessionMessageProjection[],
  ): Session {
    return new Session(id, seed, header, 'snapshot', inheritedEventCount, projections)
  }

  /**
   * 通过采纳独立持有或深度冻结的 seed 来恢复脱离 session。
   * 运行时必需的事件字段、事件信封、序号连续性、surface 过渡与 header 字段
   * 都被验证，不复制或冻结事件。内嵌的 Assistant 流保持不透明，直到流消费
   * 方或存储验证器读取它们。
   * @param id - 恢复的 session 身份。
   * @param seed - 独立持有或深度冻结的事件。
   * @param header - 独立持有的存储元数据。
   * @param inheritedEventCount - 从存储解码出的确切分叉继承前缀长度。
   * @param eventState - 由产生 seed 的操作携带的别名状态。
   * @param projections - 插件自有消息变更的纯解释器。
   * @returns 恢复的脱离 session。
   * @throws 当 seed 事件需要缺失的消息解释器或验证失败时。
   */
  static fromRestore(
    id: SessionId,
    seed: readonly SessionEvent[],
    header: SessionHeader,
    inheritedEventCount: SessionLogOffset,
    eventState: SessionSeedEventState,
    projections?: readonly SessionMessageProjection[],
  ): Session {
    return new Session(
      id,
      seed,
      header,
      eventState,
      inheritedEventCount,
      projections,
    )
  }

  private constructor(
    id: SessionId,
    seed?: readonly SessionEvent[],
    header?: SessionHeader,
    mode: 'snapshot' | SessionSeedEventState = 'snapshot',
    suppliedInheritedEventCount?: SessionLogOffset,
    projections: readonly SessionMessageProjection[] = [],
  ) {
    this.surfaceManager = new SurfaceManager(this.log, SessionLogOffset(0), projections)
    const restoredHeader = mode === 'snapshot' ? undefined : validateRestoredSessionHeader(id, header)
    if (seed !== undefined) {
      // 以与 `append` 相同的不变量验证 seed，使回放/分叉
      // （`ctx.sessions.create(id, { seed })`）不能构造出任何持久化后端都无
      // 法存储的活跃日志：每个事件的 `data` 必须可 JSON 序列化，且 `seq` 必
      // 须从 0 开始连续（整个系统依赖的 `seq = log.length` 约定）。没有这
      // 一验证，坏 seed 只会在之后以后端拒绝或活跃日志与磁盘静默分叉的形式
      // 显现。
      for (const [index, source] of seed.entries()) {
        // seed 是持久化/回放边界：在一次无损 JSON 遍历中验证并脱离完整事件。
        const snapshot = mode === 'snapshot' ? snapshotJsonValue(source) : source
        if (snapshot === undefined) {
          throw new Error(`seed event at index ${index} is not losslessly JSON-serializable`)
        }
        assertSessionEventEnvelope(snapshot, index)
        if (snapshot.seq !== index) {
          throw new Error(`seed event at index ${index} has seq ${snapshot.seq} (expected ${index}); seed must be contiguous from 0`)
        }
        // seed 通过与活跃追加和完整日志折叠相同的过渡增量接纳。候选在进入
        // `log` 之前先做规划，因此失败不可能部分改变 surface。
        try {
          this.surfaceManager.validateNext(snapshot)
        } catch (error: unknown) {
          throw new Error(`invalid seed event at index ${index}: ${error instanceof Error ? error.message : 'invalid surface metadata'}`)
        }
        this.log.push(mode === 'snapshot' ? deepFreeze(snapshot) : snapshot)
      }
    }
    this.firstLiveSeq = SessionLogOffset(this.log.length)
    this.header = restoredHeader ?? snapshotSessionHeader(id, header)
    if (this.header.isSeeded && seed === undefined) {
      throw new Error('seeded session requires an explicit constructor seed')
    }
    if (this.header.isSeeded && suppliedInheritedEventCount === undefined) {
      throw new Error('seeded session requires an inherited event count')
    }
    const inheritedEventCount = SessionLogOffset(suppliedInheritedEventCount ?? 0)
    if (!this.header.isSeeded && inheritedEventCount !== 0) {
      throw new Error('unseeded session inherited event count must be 0')
    }
    if (inheritedEventCount > this.log.length) {
      throw new Error('session inherited event count exceeds its event log')
    }
    const seedMarker = this.log[inheritedEventCount]
    const markedSeed = seedMarker?.type === 'session/end-seed' && seedMarker.data.inherited === true
    if (mode === 'snapshot' && this.header.isSeeded && inheritedEventCount !== this.log.length && !markedSeed) {
      throw new Error('seeded session constructor seed must equal its inherited prefix or mark its inherited cut')
    }
    if (markedSeed && this.log.slice(inheritedEventCount + 1).some(event => event.type === 'session/end-seed' && event.data.inherited === true)) {
      throw new Error('session inherited event count must identify the final inherited marker')
    }
    this.inheritedEventCount = inheritedEventCount
    this.firstLifecycleSeq = mode === 'snapshot' && this.header.isSeeded ? inheritedEventCount : this.firstLiveSeq
    // 新播种的子级总是在其继承切点处拥有一个带标记 marker，即使复制的前缀
    // 已经以祖先 marker 结尾。恢复保留该持久 marker，只追加普通的恢复
    // marker。
    if (seed !== undefined && mode === 'snapshot' && this.header.isSeeded && !markedSeed) {
      this.append('session/end-seed', { inherited: true })
    } else if (seed !== undefined && !(mode === 'snapshot' && this.header.isSeeded) && this.log.at(-1)?.type !== 'session/end-seed') {
      this.append('session/end-seed', {})
    }
  }

  /** 私有只追加日志的缓存不可变完整快照。 */
  private eventsSnapshot: readonly SessionEvent[] | undefined

  /**
   * 返回存储在一个确切序号处的不可变事件。
   * @deprecated 现有逻辑可暂不迁移，但禁止新调用。
   * 参见 [Agent Note](../../../../.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md)。
   * @param seq - 事件序号。
   * @returns 已接受的事件；日志不含该序号时为 undefined。
   */
  eventAt(seq: SessionSeq): SessionEvent | undefined {
    return this.log[seq]
  }

  /**
   * 物化一个半开事件序号范围的不可变快照。
   * 完整的当前快照会复用到下一次追加；每个先前返回的快照在后续追加之后仍保
   * 持稳定。
   * @deprecated 现有逻辑可暂不迁移，但禁止新调用。
   * 参见 [Agent Note](../../../../.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md)。
   * @param fromSeq - 非负含端点序号；缺省为日志开头。
   * @param toSeqExclusive - 非负开端点序号；缺省为当前末尾。
   * @returns 所选深冻结事件的冻结数组。
   */
  snapshotEvents(
    fromSeq: SessionLogOffset = SessionLogOffset(0),
    toSeqExclusive: SessionLogOffset = this.seq,
  ): readonly SessionEvent[] {
    if (fromSeq === 0 && toSeqExclusive === this.log.length) {
      this.eventsSnapshot ??= Object.freeze([...this.log])
      return this.eventsSnapshot
    }
    return Object.freeze(this.log.slice(fromSeq, toSeqExclusive))
  }

  /**
   * 返回本 Session 在其分叉继承前缀之后的事件。
   * @deprecated 现有逻辑可暂不迁移，但禁止新调用。
   * 参见 [Agent Note](../../../../.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md)。
   * @returns 按日志顺序包含子级自有事件的新数组。
   */
  ownEvents(): readonly SessionEvent[] {
    // oxlint-disable-next-line typescript/no-deprecated -- Deprecated reader delegates to the deprecated range read.
    return this.snapshotEvents(this.inheritedEventCount)
  }

  /**
   * 某个已存在事件位置是否在分叉继承前缀之外。
   * @param seq - 本 Session 中的事件位置。
   * @returns 事件属于本 Session 而非其父级时为 true。
   */
  isOwnSeq(seq: SessionSeq): boolean {
    return seq >= this.inheritedEventCount && seq < this.seq
  }

  /** 下一个事件的序号——总是日志长度（`seq = log.length` 连续性约定）。 */
  get seq(): SessionLogOffset {
    return SessionLogOffset(this.log.length)
  }

  /**
   * 把一个类型化事件追加到日志，并通过存储持有的模块私有发布钩子同步通知
   * 观察者。热路径从不在 I/O 上阻塞——持久化插件异步缓冲。事件一旦进入日
   * 志，追加即已提交：观察者失败按监听器记录并包容，因此不会改变返回值，
   * 也不会阻止后续监听器观察到同一已接受事件。
   *
   * @param type - 事件类型（{@link SessionEventMap} 的键）。
   * @param data - 事件载荷；必须可 JSON 序列化。
   * @param opts - surface 元数据：`surfaceOp` 控制事件如何进入有序 surface；
   *   `sourceEventSeqs` 列出本事件派生自的更早事件的序号。{@link
   *   SurfaceEventType} 事件必填（每个产消息事件都必须声明它如何加入
   *   surface——派生模型历史的唯一来源），而编译器对 `turn/start` 或
   *   `assistant/attempt` 等非 surface 类型拒绝它。assistant 消息内嵌其精确
   *   的 provider 流，不能引用顶层来源事件。
   * @returns 已记录的事件——其分配的 `seq`/`time` 加上进入日志的 `data` 快
   *   照，因此读回 `event.data` 看到的是已记录值，绝不是调用方仍可变的输入。
   * @throws 当 `data` 或 surface 元数据不能无损 JSON 序列化（BigInt、函数、
   *   symbol、undefined、负零、非有限数值、循环引用、稀疏数组或
   *   Map/Set/Date/类实例等异类对象），或候选违反 request-header 空字段或
   *   工具错误一致性规则，或规范 surface 约定（标记形状与合格性、唯一的更
   *   早来源事件引用、位置替换有效性，以及完整的被遮蔽节点覆盖）时。一次
   *   迭代遍历对每个嵌套值只读取、验证并复制一次，因此有状态的 getter 不能
   *   向验证提供一值、向存储提供另一值。事件日志是持久权威来源，因此坏事件
   *   在追加点失败，而不是之后在后端刷新时失败。同步内部派发验证失败，或
   *   在本接纳/发布边界打开时重入的追加，同样在日志改变前拒绝。
   */
  append<T extends SessionEventType>(
    type: T,
    data: SessionEventMap[T],
    ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent<T>] : []
  ): SessionEvent<T> {
    const surfaceOpts: SurfaceIntent | undefined = opts[0]
    const surfaceMetadata = {
      ...surfaceOpts?.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: surfaceOpts.sourceEventSeqs },
      ...surfaceOpts?.surfaceOp === undefined ? {} : { surfaceOp: surfaceOpts.surfaceOp },
    }
    const dataSnapshot = snapshotJsonValue(data)
    if (dataSnapshot === undefined) {
      throw new Error(`session event "${type}" carries non-JSON-serializable data`)
    }
    const surfaceMetadataSnapshot = snapshotJsonValue(surfaceMetadata)
    if (surfaceMetadataSnapshot === undefined) {
      throw new Error(`session event "${type}" carries non-JSON-serializable surface metadata`)
    }
    const entry = this.publicationEntry()
    const event = deepFreeze({
      type,
      seq: SessionSeq(this.log.length),
      time: Date.now(),
      data: dataSnapshot,
      ...(surfaceMetadataSnapshot as { surfaceOp?: unknown; sourceEventSeqs?: unknown }),
    } as unknown as SessionEvent<T>)
    validateSessionEventData(event, `session event "${type}" at seq ${event.seq}`)
    this.commit(event as SessionEvent, entry)
    return event
  }

  static {
    commitPluginRecord = (session, type, data) => session.#appendRecord(type, data)
  }

  /**
   * 提交一条插件记录；{@link appendPluginRecord} 是唯一调用方。
   * @param type - 记录类型，对照插件记录文法检查。
   * @param data - JSON 载荷，进入日志前先做快照。
   * @returns 该记录的序号。
   */
  #appendRecord(type: PluginRecordType, data: unknown): SessionSeq {
    const dataSnapshot = snapshotJsonValue(data)
    if (dataSnapshot === undefined) {
      throw new Error(`plugin record "${type}" carries non-JSON-serializable data`)
    }
    const entry = this.publicationEntry()
    const record: unknown = deepFreeze({
      type,
      seq: SessionSeq(this.log.length),
      time: Date.now(),
      data: dataSnapshot,
      ignorable: true,
    })
    assertPluginRecordEvent(record)
    this.commit(record, entry)
    return record.seq
  }

  /**
   * 读取一次追加的存储附件，拒绝在另一个追加正在发布时重入的追加。
   * @returns 该附件；脱离 Session 为 undefined。
   */
  private publicationEntry(): SessionEntry | undefined {
    const entry = attachments.get(this)
    if (entry?.appending) {
      throw new Error('session append cannot reenter while another append is being published')
    }
    return entry
  }

  /**
   * 在下一个序号处接受一个冻结候选，进入日志，并以逐监听器包容的方式通知
   * `session/event` 观察者。
   * @param event - 在当前日志长度处构建的候选。
   * @param entry - 在候选构建之前读取的附件。
   */
  private commit(event: SessionEvent, entry: SessionEntry | undefined): void {
    this.surfaceManager.validateNext(event)

    if (entry !== undefined) entry.appending = true
    try {
      let callbacks: SessionCallback[] | undefined
      const callbackArgs: unknown[] = [this, event]
      if (entry !== undefined) {
        callbacks = collectSessionCallbacks(entry.emitCtx, [entry.carrier, 'session/event', ...callbackArgs])
      }
      this.log.push(event)
      this.eventsSnapshot = undefined
      if (callbacks !== undefined && entry !== undefined) {
        invokeContainedSessionObservers(entry.emitCtx, 'session/event', entry.id, callbackArgs, callbacks)
      }
    } finally {
      if (entry !== undefined) {
        entry.appending = false
        if (entry.detachRequested && !entry.announcing) entry.detach()
      }
    }
  }

  /** request-header 事件的缓存折叠——见 {@link requestHeader}。 */
  private headerFold: EpochHeader | undefined
  /** header 折叠已到达的日志位置（已消费事件数）。 */
  private headerFoldSeq = 0

  /**
   * 日志最后一个 header 事件之后生效的 {@link EpochHeader}——下一个请求将
   * 与之比较的 header——或第一个 `request/header` 快照之前为 undefined。
   * `foldRequestHeader(session.snapshotEvents())` 的活跃增量维护形式：每个
   * header 事件只在首次见到时折叠一次，因此逐步读取的代价为 O(新事件)。
   * @returns 折叠后的 header；尚无 header 事件时为 undefined。
   */
  requestHeader(): EpochHeader | undefined {
    if (this.headerFoldSeq < this.log.length) {
      // 更新时冻结：折叠是以引用暴露的 session 状态——就地修改它（而非构
      // 建替换）会使之后所有与日志的比较失同步，因此修改会抛出。
      this.headerFold = deepFreeze(foldRequestHeader(this.log.slice(this.headerFoldSeq), this.headerFold))
      this.headerFoldSeq = this.log.length
    }
    return this.headerFold
  }

  /** `request/context` 事件的缓存折叠。 */
  private contextFold: RequestContext | undefined
  private contextFoldSeq = 0

  /**
   * 返回最新解析的路由元数据，或第一个 `request/context` 事件之前为
   * `undefined`。每个事件折叠一次。
   * @returns 最新的不可变路由元数据。
   */
  requestContext(): RequestContext | undefined {
    if (this.contextFoldSeq < this.log.length) {
      for (const event of this.log.slice(this.contextFoldSeq)) {
        if (event.type === 'request/context') this.contextFold = deepFreeze({ ...event.data })
      }
      this.contextFoldSeq = this.log.length
    }
    return this.contextFold
  }

  /** 面向请求投影的缓存历史工具定义与更新。 */
  private readonly toolHistoryProjection = new ToolHistoryProjection()
  /** 工具历史折叠尚未消费的下一个已提交事件的索引。 */
  private toolHistorySeq = 0

  /**
   * 把未见过的已提交事件折叠进与能力无关的工具历史。
   * 首次访问重建继承历史；后续读取只消费新事件。
   * @returns 面向 LLM 请求投影的不可变快照，包括历史新增定义。
   */
  toolHistory(): ToolHistory {
    for (const event of this.log.slice(this.toolHistorySeq)) this.toolHistoryProjection.apply(event)
    this.toolHistorySeq = this.log.length
    return this.toolHistoryProjection.snapshot()
  }

  /** 派生消息缓存：冻结的投影，按未见节点扩展。 */
  private derived: Message[] = []
  /** 缓存已到达的 surface 位置（已投影节点数）。 */
  private derivedNodes = 0
  /** 缓存构建时所依据的 {@link SurfaceManager.contentGeneration}。 */
  private derivedGeneration = 0

  /**
   * 通过遍历由 `surfaceOp` 标记维护的产消息事件有序序列来派生 LLM 消息历
   * 史。surface 是派生历史的唯一来源：每个产消息追加都记录其 `surfaceOp`，
   * 因此没有标记的原始事件（一个分片、一个 turn 边界）正确地缺席，压缩
   * `replace` 会从派生中删除被遮蔽的节点。投影规则是 {@link
   * deriveEventMessage}，记录的消息投影在应用时不改变节点成员或消息身份。
   *
   * 已缓存：纯尾部增长代价为 O(新节点)；替换或消息投影
   * （{@link SessionSurface.contentGeneration}）会重建。返回的数组是每次调
   * 用的全新快照（后续追加从不增长调用方已持有的数组）；其中的 `Message`
   * 对象是共享的且**深冻结**。未变化的内容复用冻结的事件数据；投影块是冻
   * 结的派生副本。消费方无法通过任一形式修改日志。
   * @returns 共享、冻结的派生历史的全新数组。
   */
  deriveMessages(): Message[] {
    const surface = this.surface
    const nodes = surface.nodes
    const generation = surface.contentGeneration
    if (generation !== this.derivedGeneration) {
      this.derived = []
      this.derivedNodes = 0
      this.derivedGeneration = generation
    }
    for (const seq of nodes.slice(this.derivedNodes)) {
      // surface 序列由 this.log 构建——按构造 seq 总是有效索引。非空断言
      // 表达该不变量。
      // oxlint-disable-next-line typescript/no-non-null-assertion
      const msg = this.deriveEventMessage(this.log[seq]!)
      // surface 节点是五种产消息类型之一，但空内容的 assistant/message（仅
      // 承载 usage 的 max-tokens step）派生为 null，绝不能进入对话记录。
      if (msg) this.derived.push(msg)
    }
    this.derivedNodes = nodes.length
    return [...this.derived]
  }

  /**
   * 在应用所有已提交消息投影后投影一个事件。
   * 原始持久事件保持不变。
   * @param event - 要投影的事件。
   * @returns 派生消息；事件不产生消息时为 null。
   */
  deriveEventMessage(event: SessionEvent): Message | null {
    return this.surfaceManager.deriveEventMessage(event)
  }
}

/** 分叉来源：活跃 session 对象或其活跃存储 id。 */
export type SessionForkSource = Session | SessionId

/**
 * session 分叉的拒绝码：活跃存储不知道分叉来源 id（`SESSION_NOT_FOUND`），
 * 或该 id 指名的不是存储的活跃实例（`SESSION_NOT_LIVE`）；请求的子级 id 已
 * 被占用（`SESSION_ALREADY_EXISTS`）；或边界不是连续的已存在 seq
 * （`INVALID_BOUNDARY`）。
 */
export type SessionForkErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'SESSION_NOT_LIVE'
  | 'SESSION_ALREADY_EXISTS'
  | 'INVALID_BOUNDARY'

/** session 分叉拒绝的类型化错误。 */
export class SessionForkError extends Error {
  constructor(message: string, public readonly code: SessionForkErrorCode) {
    super(message)
    this.name = 'SessionForkError'
  }
}

/**
 * 内存中的 session 存储（`ctx.sessions`）。
 *
 * 持久化刻意不在此实现——agent 生命周期把 session 日志写入器附加到每个已
 * 发布 session 的写句柄上；在该生命周期之外发布的 session 什么都不持久化。
 */
export class SessionStore extends Service {
  private store = new Map<SessionId, SessionEntry>()
  private counter = 0
  private readonly projections: SessionMessageProjection[] = []

  /** 脱离回放借用的定义；贡献在其注册 fiber 卸载前一直存活。 */
  get messageProjections(): readonly SessionMessageProjection[] {
    return this.projections
  }

  /**
   * 为活跃创建、恢复与分叉注册一个事件解释器。
   * 释放该贡献会使使用过它的 session 拒绝继续派生。
   * @param projection - 由该事件的插件拥有的纯定义。
   * @returns fiber 持有的释放器。
   * @throws 当另一个定义已拥有该事件类型时。
   */
  registerMessageProjection(projection: SessionMessageProjection): () => Promise<void> {
    if (this.projections.some(item => item.type === projection.type)) {
      throw new Error(`session message projection "${projection.type}" is already registered`)
    }
    return this.ctx.effect(() => {
      this.projections.push(projection)
      return () => { this.projections.splice(this.projections.indexOf(projection), 1) }
    }, 'sessions.registerMessageProjection()')
  }

  constructor(ctx: Context) {
    super(ctx, 'sessions')
    ctx.inject(['typert'], (typeCtx) => {
      typeCtx.typert.lookups.register('session', {
        parameter: 'session',
        wire: 'sessionId',
        resource: 'session',
        hostTypeSymbol: '@deepseek-ai/dsh-session#Session',
        wireTypeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
        resolve: sessionId => this.get(sessionId),
      })
    })
  }

  /**
   * 创建由调用 fiber 持有的 session：释放该 fiber 会停止事件通知并把
   * session 从存储中移除。`options.seed` 以那些事件的副本填充 session（回
   * 放/分叉）；`options.meta` 把创建元数据（有效的绝对 `cwd`、seed 与父级谱
   * 系，以及委派深度）附加为不可变的 {@link SessionHeader}（存储填写
   * `version`/`id`/`createdAt`）。
   *
   * 对其 session 必须与其 loop 按顺序拆除的 agent（loop 的最终事件在存储附
   * 件结束之前发布），不要使用本方法——通过 {@link prepare} + {@link enter}
   * + {@link announce} 把 session 生命周期折叠进 agent 自己的 effect（见
   * `dsh-agent-loop` 的创建事务）。
   *
   * @param id - session id；缺省时存储铸造 `session-<n>`。
   * @param options - seed 事件和/或 header 的创建元数据。
   * @returns 已进入并公告的活跃 session。
   * @throws 当具有 `id` 的 session 已存在、元数据不是标量字段有效的普通无
   *   损 JSON 记录，或 `meta.cwd` 是非绝对路径（存储后端以它为目录键）时。
   */
  create(id?: SessionId, options?: CreateSessionOptions): Session {
    const session = this.prepare(id, options)
    // 由调用 fiber 持有的单个 effect。在公告之前先产出 detach，使抛出的
    // `session/created` 监听器回滚附加（generator effect 在抛出时释放已产出
    // 的释放器），而不是泄漏存储条目及其发布钩子。
    this.ctx.effect(function* (this: SessionStore) {
      yield this.enter(session)
      this.announce(session)
    }.bind(this), 'sessions.create()')
    return session
  }

  /**
   * 构建一个不进入存储的 session——验证 id/cwd 并构造 {@link Session}（含
   * 其不可变的 {@link SessionHeader}）。
   * 与 {@link enter} + {@link announce} 配对：拥有复合 `ctx.effect` 的调用方
   * （agent 工厂）把 session 生命周期折叠进那一个 effect，使 fiber 卸载把
   * session + agent 作为单个有序链拆除，而不是作为相互竞争的兄弟 effect
   * ——后者会在 driver 的收尾事件提交前移除发布钩子，丢掉它们。
   *
   * @param id - session id；缺省时存储铸造 `session-<n>`。
   * @param options - seed 事件和/或 header 的创建元数据。带 `eventState` 时，
   *   每个 seed 事件要么独立持有，要么任何共享值都已深冻结；{@link
   *   Session.fromRestore} 验证并采纳这些值，不复制或冻结它们。
   * @returns 构造好的 session，尚未进入存储。
   * @throws 当具有 `id` 的 session 已存在、元数据不是标量字段有效的普通无
   *   损 JSON 记录，或 `meta.cwd` 是非绝对路径时。
   */
  prepare(id?: SessionId, options?: PrepareSessionOptions): Session {
    let sessionId: SessionId
    if (id === undefined) {
      do sessionId = brandString<SessionId>(`session-${++this.counter}`)
      while (this.store.has(sessionId))
    } else {
      sessionId = brandString<SessionId>(id)
    }
    if (this.store.has(sessionId)) throw new Error(`session "${sessionId}" already exists`)
    if (options !== undefined) {
      const { eventState } = options
      switch (eventState) {
        case 'detached':
        case 'shared-frozen':
          return Session.fromRestore(
            sessionId,
            options.seed,
            options.meta,
            options.inheritedEventCount,
            eventState,
            this.projections,
          )
        case undefined:
          break
        /* v8 ignore next -- 闭联合集的穷尽性守卫 */
        default:
          assertNever(eventState, 'SessionStore.prepare event state')
      }
    }
    const seed = options?.seed
    const meta = options?.meta
    const header: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: sessionId,
      createdAt: meta?.createdAt ?? Date.now(),
      ...meta?.cwd === undefined ? {} : { cwd: meta.cwd },
      ...meta?.parentSession === undefined ? {} : { parentSession: meta.parentSession },
      isSeeded: meta?.isSeeded ?? false,
      ...meta?.origin === undefined ? {} : { origin: meta.origin },
      ...meta?.delegationDepth === undefined ? {} : { delegationDepth: meta.delegationDepth },
      ...meta?.agentPreset === undefined ? {} : { agentPreset: meta.agentPreset },
    }
    return Session.create(sessionId, seed, header, options?.inheritedEventCount, this.projections)
  }

  /**
   * 把 {@link prepare} 过的 session 进入存储：安装模块私有的追加发布钩子并
   * 把它加入存储。返回 DETACH 释放器（钩子 + 存储移除）。不发出
   * `session/created`——调用方在其 effect 内先产出该释放器，然后调用
   * {@link announce}，这样抛出的 `session/created` 监听器会回滚附加而不是
   * 泄漏它。
   *
   * 重新检查 id 是否重复：`prepare` 与 `enter` 是公开的跨包原语，调用方可能
   * 在两者之间交错任意工作（或另一个 create），因此过时的已准备 session 绝
   * 不能覆盖同 id 的活跃存储条目——其 detach 释放器之后会删除真正的
   * session。{@link create} 便捷方法与 agent 工厂背靠背调用两者，所以它们
   * 不会触发此情形，但公开 API 不能做此假设。
   *
   * @param session - 尚未在存储中的 {@link prepare} 过的 session。
   * @returns detach 释放器（发布钩子 + 存储移除）。从同步的
   *   `session/created` 监听器调用时，移除与释放会等待该创建派发放开。
   * @throws 当具有该 id 的 session 已在存储中时。
   */
  enter(session: Session): () => void {
    const id = session.id
    const carrier = scopeTarget(session, scopeOf(this.ctx))
    // 这是在任意未发布准备之后的权威碰撞边界。只有一个确切同 id 的事务能
    // 发布。
    if (this.store.has(id)) throw new Error(`session "${id}" already exists`)
    if (attachments.has(session)) throw new Error(`session "${id}" is already attached to a store`)
    const entry: SessionEntry = {
      id,
      session,
      carrier,
      emitCtx: this.ctx,
      announced: false,
      announcing: false,
      appending: false,
      detachRequested: false,
      detach: () => { this.detachEntered(entry) },
    }
    this.store.set(id, entry)
    attachments.set(session, entry)
    let entered = true
    const detach = (): void => {
      if (!entered) return
      entered = false
      // 生命周期监听器可能拥有先前的 detach 能力。让条目及其发布钩子在同步
      // 创建或追加派发放开之前保持活跃，然后发布配对的释放边。
      if (entry.announcing || entry.appending) {
        entry.detachRequested = true
        return
      }
      entry.detach()
    }
    return detach
  }

  /** 移除一个确切已进入的 session，并在已公告时发出其配对的释放。 */
  private detachEntered(entry: SessionEntry): void {
    entry.detachRequested = false
    // 过时的能力不能移除属于之后同 id 生命周期的观察者或存储。
    /* v8 ignore next -- 在此单次 detach 能力活跃期间，enter() 拒绝替换。 */
    if (this.store.get(entry.id) !== entry) return
    this.store.delete(entry.id)
    attachments.delete(entry.session)
    if (entry.announced) this.emitDisposed(entry)
  }

  /** 为一个 {@link enter} 过的 session 恰好发出一次 `session/created`（随同
   * 捕获的载体 {@link enter}）。与 {@link enter} 分开，使调用方能先产出
   * detach 释放器（回滚安全——见 {@link enter}）。
   * @param session - 要向监听器公告的已进入 session。
   * @throws 当 session 不活跃或其公告已开始时，包括来自创建监听器的重入调
   *   用。 */
  announce(session: Session): void {
    const entry = this.liveEntryFor(session)
    if (entry.announced || entry.announcing) {
      throw new Error(`session "${entry.id}" was already announced`)
    }
    // 先标记后发出：Cordis 的 emit 可能投递给更早的监听器然后抛出。回滚仍
    // 必须把该部分创建与释放配对，且监听器不能递归创建第二个生命周期边。
    entry.announced = true
    const callbackArgs: unknown[] = [session]
    entry.announcing = true
    try {
      const callbacks = collectSessionCallbacks(this.ctx, [entry.carrier, 'session/created', session])
      for (const callback of callbacks) {
        // 同步抛出有意传播并否决发布；随后产出的 detach 发出配对的释放边。
        // 异步函数仍然可以赋给 void 监听器，因此观察其返回的 Promise：拒绝
        // 已来不及回滚，必须改为记录日志。
        const returned: unknown = callback(...callbackArgs)
        void Promise.resolve(returned).catch((error: unknown) => {
          this.ctx.logger.warn(`session "${entry.id}": session/created listener rejected: ${String(error)}`)
        })
      }
    } finally {
      entry.announcing = false
      if (entry.detachRequested && !entry.appending) entry.detach()
    }
  }

  /** 以逐监听器包容的方式发出配对的拆除通知。 */
  private emitDisposed(entry: SessionEntry): void {
    const callbackArgs: unknown[] = [entry.session]
    try {
      const callbacks = collectSessionCallbacks(this.ctx, [entry.carrier, 'session/disposed', entry.session])
      invokeContainedSessionObservers(this.ctx, 'session/disposed', entry.id, callbackArgs, callbacks)
    } catch (error: unknown) {
      this.ctx.logger.warn(`session "${entry.id}": session/disposed dispatch threw: ${String(error)}`)
    }
  }

  /**
   * 为 `session` 派发等待的 `session/flush` 持久化检查点，载体在 {@link
   * enter} 处捕获。唯一的 flush 入口点：存储拥有载体，因此调用方（检查点策
   * 略的按请求屏障、goal 轮 driver 的空闲检查点、拆除排空，以及读取存储前
   * 自行刷新的消费方）必须经由这里，而不是直接派发原始的
   * `ctx.parallel('session/flush', …)`——一个所有者、一种拼写。
   * @param session - 其缓冲事件必须到达持久存储的 session。
   * @returns 在每个监听器都成功落定之后，是否至少有一个持久化监听器参与。
   * @throws 在每个监听器落定之后的第一个已注册监听器失败。
   */
  async flush(session: Session): Promise<boolean> {
    const { carrier } = this.liveEntryFor(session)
    const callbackArgs: unknown[] = [session]
    const callbacks = collectSessionCallbacks(this.ctx, [carrier, 'session/flush', session])
    const results = await Promise.allSettled(callbacks.map((callback) => {
      try {
        return callback(...callbackArgs)
      } catch (error: unknown) {
        // 保留监听器的确切拒绝值；flush 是调用方持有的失败边界，Cordis 监听
        // 器可能抛出任意值。
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors
        return Promise.reject(error)
      }
    }))
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failure !== undefined) throw failure.reason
    return callbacks.length > 0
  }

  /** 返回确切的活跃条目；脱离/已准备对象拒绝。 */
  private liveEntryFor(session: Session): SessionEntry {
    const entry = attachments.get(session)
    if (entry === undefined || this.store.get(entry.id) !== entry) {
      throw new Error(`session "${session.id}" is not live in this store`)
    }
    return entry
  }

  /**
   * 查找一个活跃 session。
   * @param id - 要查找的 session id。
   * @returns 该 session；没有该 id 的活跃 session 时为 undefined。
   */
  get(id: SessionId): Session | undefined {
    return this.store.get(id)?.session
  }

  /**
   * 所有活跃 session，按创建顺序。
   * @returns 一个新数组；修改它不影响存储。
   */
  list(): Session[] {
    return [...this.store.values()].map(entry => entry.session)
  }

  /**
   * 从活跃 source 的确切前缀创建活跃子级 session。
   * `boundary` 是含端点的 source 事件 seq；缺省表示 source 的
   * 当前最后一个事件。打开的尾部会收到带 forked 原因的合成工具结果与
   * step/turn 收尾事件。已关闭的 step 与 turn 保持不变，包括已经缺失结果的
   * 失败工具调用。
   * `inheritedEventCount` 只计入复制的 source 事件，不含这些收尾事件。
   *
   * @param source - 活跃 source session 对象或 id。
   * @param boundary - 要分叉到的含端点 source 事件 seq；缺省表示 source 的
   *   当前最后一个事件，空 source 上缺省则分叉出空子级。
   * @param childSessionId - 可选的子级 session id；缺省时委托给
   *   `SessionStore` 的 id 策略。
   * @returns 创建的活跃子级 session。
   */
  fork(source: SessionForkSource, boundary?: SessionSeq, childSessionId?: SessionId): Session {
    if (childSessionId !== undefined && this.get(childSessionId) !== undefined) {
      throw new SessionForkError(`session "${childSessionId}" already exists`, 'SESSION_ALREADY_EXISTS')
    }
    const liveSource = this._resolveForkSource(source)
    // oxlint-disable-next-line typescript/no-deprecated -- Existing fork snapshot read; migration deferred.
    const events = liveSource.snapshotEvents()
    const resolved = this._forkBoundary(liveSource.id, events, boundary)
    const seed = resolved === undefined ? [] : buildForkSeed(events, resolved)
    return this.create(childSessionId, {
      seed,
      inheritedEventCount: SessionLogOffset(resolved === undefined ? 0 : resolved + 1),
      meta: {
        ...liveSource.header.cwd !== undefined ? { cwd: liveSource.header.cwd } : {},
        parentSession: liveSource.id,
        isSeeded: true,
      },
    })
  }

  private _forkBoundary(
    sessionId: SessionId, events: readonly SessionEvent[], requestedBoundary: SessionSeq | undefined,
  ): SessionSeq | undefined {
    const lastEvent = events.at(-1)
    let boundary: SessionSeq
    if (requestedBoundary !== undefined) {
      boundary = requestedBoundary
    } else {
      if (lastEvent === undefined) return undefined
      boundary = lastEvent.seq
    }
    if (!Number.isSafeInteger(boundary) || boundary < 0) {
      throw new SessionForkError(
        `fork boundary for session "${sessionId}" must be a non-negative safe integer, got ${String(boundary)}`,
        'INVALID_BOUNDARY',
      )
    }
    if (boundary >= events.length) {
      const lastSeq = lastEvent?.seq
      throw new SessionForkError(
        `fork boundary ${boundary} does not exist in session "${sessionId}" (last seq: ${lastSeq ?? 'none'})`,
        'INVALID_BOUNDARY',
      )
    }

    const boundaryEvent = events[boundary]
    if (boundaryEvent === undefined || boundaryEvent.seq !== boundary) {
      throw new SessionForkError(
        `fork boundary ${boundary} does not match a contiguous event seq in session "${sessionId}"`,
        'INVALID_BOUNDARY',
      )
    }
    return boundary
  }

  private _resolveForkSource(source: SessionForkSource): Session {
    if (typeof source === 'string') {
      const session = this.get(source)
      if (session === undefined) throw new SessionForkError(`session "${source}" not found`, 'SESSION_NOT_FOUND')
      return session
    }

    const live = this.get(source.id)
    if (live === undefined) {
      throw new SessionForkError(`session "${source.id}" not found`, 'SESSION_NOT_FOUND')
    }
    if (live !== source) throw new SessionForkError(`session "${source.id}" is not the live store instance`, 'SESSION_NOT_LIVE')
    return source
  }

}

export { decodeSeqRanges, encodeSeqRanges } from './seq-ranges.ts'
export default SessionStore
