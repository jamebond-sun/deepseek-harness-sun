/**
 * session 事件日志之上的 surface 层：产生 LLM 消息的事件的有序视图。
 * 只追加的日志仍是权威来源。
 *
 * 浏览器安全：web 客户端消费此子路径导出，因此必须保持不含 `node:` 导入
 * （它们会破坏 vite 打包）。
 *
 * @module @deepseek-ai/dsh-session/surface
 */

import type { Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import { SessionLogOffset, SessionSeq } from './types.ts'
import { KNOWN_SESSION_EVENT_TYPES, MESSAGE_PROJECTION_EVENT_TYPES } from './known-event-types.ts'
import type {
  SessionEvent,
  SessionEventType,
  SessionSeqCursor,
  SurfaceEvent,
  SurfaceOp,
} from './types.ts'

/** 产消息投影事件之前紧邻的只读历史。 */
export interface SessionMessageProjectionContext {
  /** 按模型可见顺序排列的当前产消息事件序列。 */
  nodes: readonly SessionSeq[]
  /** 连续事件窗口；位于候选 seq 处或之后的条目不是已提交输入。 */
  events: readonly SessionEvent[]
  /** 窗口第一个事件的绝对序号。 */
  baseSeq: SessionLogOffset
  /** 按其原事件序号为键的先前已投影消息。 */
  messages: ReadonlyMap<SessionSeq, Message>
}

/** 对一个更改既有消息内容的插件自有事件的纯解释。 */
export interface SessionMessageProjection<T extends SessionEventType = SessionEventType> {
  /** 由本定义解释的事件；在 SessionEventMap 中用 `@messageProjection` 声明它。 */
  type: T
  /**
   * 在返回任何更新之前验证完整的持久化决策。保留消息身份并发布不可变副本，
   * 不修改输入。
   * @param event - 候选事件，尚未应用到所提供的历史。
   * @param context - 该决策之前的历史。
   * @returns 以其原序号为键的已变更当前消息。
   * @throws 当该持久化决策无法应用到该历史时。
   */
  project(event: SessionEvent<T>, context: SessionMessageProjectionContext): ReadonlyMap<SessionSeq, Message>
}

/** 产消息事件联合的运行时对应物。 */
const SURFACE_EVENT_TYPES = new Set<string>([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

/**
 * 事件类型能否加入模型可见 surface。
 * @param type - 要测试的事件类型。
 * @returns 是产消息事件类型之一时为 true。
 */
export function isSurfaceEligibleType(type: string): boolean {
  return SURFACE_EVENT_TYPES.has(type)
}

/**
 * 把事件收窄为携带其必需标记的 surface 合格事件。
 * @param event - 要测试的事件。
 * @returns 类型和标记都标识一个 surface 事件时为 true。
 */
export function isSurfaceEvent(event: SessionEvent): event is SurfaceEvent {
  if (!SURFACE_EVENT_TYPES.has(event.type)) return false
  const candidate: { surfaceOp?: unknown } = event
  return candidate.surfaceOp !== undefined
}

/**
 * 把事件收窄为追加来源的 surface 事件：在其自身日志位置进入 surface、且其
 * 本身从不是替换副本的事件。
 *
 * 模型可见 surface 刻意遮蔽被替换的范围，因此它是人类对话记录的错误来源——
 * 一次落地的替换会抹掉用户已看到的对话。追加来源事件是该记录的持久来源素
 * 材；替换副本仅面向模型。
 * @param event - 要测试的事件。
 * @returns 事件追加到 surface 尾部时为 true。
 */
export function isAppendSurfaceEvent(
  event: SessionEvent,
): event is SurfaceEvent & { surfaceOp: 'append' } {
  return isSurfaceEvent(event) && event.surfaceOp === 'append'
}

/**
 * 把事件收窄为 surface 替换：一个遮蔽既有 surface 范围而非追加到尾部的节
 * 点。{@link isAppendSurfaceEvent} 在两个 {@link SurfaceOp} 变体上的对应物。
 * @param event - 要测试的事件。
 * @returns 事件替换了一个 surface 范围时为 true。
 */
export function isReplacementSurfaceEvent(
  event: SessionEvent,
): event is SurfaceEvent & { surfaceOp: Extract<SurfaceOp, { op: 'replace' }> } {
  return isSurfaceEvent(event) && event.surfaceOp !== 'append'
}

/**
 * 把单个事件投影到它派生出的 LLM 消息；不产生消息时为 null——非 surface
 * 事件（attempt、边界、仅存于日志的记录）或内容为空的 system、developer、
 * assistant 消息。重建模型输入的调用方提供同一前缀在 {@link foldSurface} 得
 * 到的 `projectedMessages`；没有该 map 时，本函数读取原始事件内容。Session
 * 实例方法应用活跃投影。消息不可变，未变化的内容保留其持久身份。
 * @param event - 要投影的事件。
 * @param projectedMessages - 同一日志前缀 surface 折叠的消息投影。
 * @returns 派生消息；事件不产生消息时为 null。
 */
export function deriveEventMessage(
  event: SessionEvent,
  projectedMessages?: ReadonlyMap<SessionSeq, Message>,
): Message | null {
  const projected = projectedMessages?.get(event.seq)
  if (projected !== undefined) return projected
  // 刻意不做穷尽：只有产消息事件派生历史；turn/step 边界、失败 attempt 与
  // 错误是追踪/回放数据。
  switch (event.type) {
    // 普通提示词与注入上下文保留生产者自有的框架。
    // 参见 packages/core/session/README.md 的 Derived history。
    case 'user/message': {
      return event.data
    }
    // 空的 system 与 developer 节点保留其 surface 位置而不产生 wire 消息。
    // 空的 assistant 事件承载 max-tokens step 的 usage，绝不能向 provider
    // 对话注入无内容的 turn。
    case 'system/message':
    case 'developer/message':
    case 'assistant/message': {
      if (event.data.message.content.length === 0) return null
      return event.data.message
    }
    case 'tool/result': {
      return event.data.message
    }
    default:
      // 非 surface 事件（边界、attempt、仅存于日志的记录）不投影任何消息。
      // 可合并扩展联合：此处不用 assertNever。
      return null
  }
}

/** 载荷字段是 JSON 对象而非数组或标量时为 true。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 拒绝非规范的 request-header 字段、developer 角色与内容，以及矛盾的工具失
 * 败元数据。这不验证完整事件载荷或内嵌的 provider 流。
 * @param event - 检查其局部相关载荷字段的事件。
 * @param subject - 计入验证错误的事件位置。
 * @throws 当 request-header 字段、developer 角色与内容或工具失败元数据无
 *   效时。
 */
export function validateSessionEventData(
  event: Pick<SessionEvent, 'type' | 'data'>,
  subject: string,
): void {
  const data: unknown = event.data
  if (SURFACE_EVENT_TYPES.has(event.type) && isRecord(data)) {
    const message = event.type === 'user/message' ? data : data['message']
    if (isRecord(message)) {
      if ((event.type === 'developer/message') !== (message['role'] === 'developer')) {
        throw new Error(`${subject} developer/message and developer role must occur together`)
      }
      if (message['role'] !== 'developer' && Array.isArray(message['content'])
        && message['content'].some((block: unknown) => isRecord(block)
          && (block['type'] === 'tool-addition' || block['type'] === 'tool-removal'))) {
        throw new Error(`${subject} tool-change blocks require developer role`)
      }
      if (event.type === 'developer/message' && Array.isArray(message['content'])) {
        let hasAdditions = false
        for (const block of message['content']) {
          if (!isRecord(block) || (block['type'] !== 'tool-addition' && block['type'] !== 'tool-removal')) continue
          if (typeof block['toolName'] !== 'string' || block['toolName'].length === 0) {
            throw new Error(`${subject} ${block['type']} requires a nonempty toolName`)
          }
          if (block['type'] === 'tool-addition') {
            hasAdditions = true
            if (Object.hasOwn(block, 'tool')) throw new Error(`${subject} tool-addition must omit inline tool definitions`)
          }
        }
        if (hasAdditions ? !isEventSeq(data['headerSeq']) : Object.hasOwn(data, 'headerSeq')) {
          throw new Error(`${subject} requires headerSeq exactly when tool additions are present`)
        }
      }
    }
  }
  if (event.type === 'request/header') {
    if (!isRecord(data)) throw new Error(`${subject} data must be an object`)
    const header = data['header']
    if (!isRecord(header)) throw new Error(`${subject} header must be an object`)
    if (Object.hasOwn(header, 'system')) throw new Error(`${subject} must omit header.system; use system/message`)
    if (Array.isArray(header['tools']) && header['tools'].length === 0) {
      throw new Error(`${subject} must omit empty tools`)
    }
    const defaults = header['adapterDefaults']
    if (isRecord(defaults) && Object.keys(defaults).length === 0) {
      throw new Error(`${subject} must omit empty adapterDefaults`)
    }
  } else if (event.type === 'tool/result') {
    if (!isRecord(data)) throw new Error(`${subject} data must be an object`)
    if (data['error'] === undefined) return
    const message = data['message']
    if (!isRecord(message) || message['isError'] !== true) {
      throw new Error(`${subject} error requires message.isError === true`)
    }
  }
}

/** 折叠 session surface 期间观察到的一次替换操作。 */
export interface SurfaceFoldReplacement {
  /** 替换先前 surface 范围的事件的 seq。 */
  seq: SessionSeq
  /** 声明的被替换 surface 范围的含端点起始 seq。 */
  start: SessionSeq
  /** 声明的被替换 surface 范围的含端点结束 seq。 */
  end: SessionSeq
  /** 该操作按 surface 顺序移除的实际 surface 条目。 */
  shadowedSeqs: SessionSeq[]
}

/** 回放 session 日志中 surface 操作的完整结果。 */
export interface SurfaceFoldResult {
  /** 按模型可见顺序排列的当前 surface 事件序列。 */
  nodes: SessionSeq[]
  /** 按事件顺序排列的替换操作。 */
  replacements: SurfaceFoldReplacement[]
  /** 按其原事件序号为键的不可变已投影消息。 */
  projectedMessages: ReadonlyMap<SessionSeq, Message>
}

/** 产消息 session 事件的只读活跃投影。 */
export interface SessionSurface {
  /** 按模型可见顺序排列的当前 surface 事件序列。 */
  readonly nodes: readonly SessionSeq[]
  /** 已提交位置替换的单调计数。 */
  readonly replaceGeneration: number
  /** 已提交替换与插件自有消息变更的单调计数。 */
  readonly contentGeneration: number
}

/** 完整折叠与增量折叠共享的可变状态。 */
interface SurfaceFoldState {
  nodes: SessionSeq[]
  replaceGeneration: number
  contentGeneration: number
  projectedMessages: Map<SessionSeq, Message>
  projections: Set<SessionMessageProjection>
}

/** 已验证但尚未改变折叠状态的替换过渡。 */
interface SurfaceReplacePlan extends SurfaceFoldReplacement {
  kind: 'replace'
  startIdx: number
  endIdx: number
}

/** 已验证但尚未改变折叠状态的一个 surface 过渡。 */
type SurfacePlan =
  | { kind: 'append'; seq: SessionSeq }
  | SurfaceReplacePlan
  | { kind: 'project'; projection: SessionMessageProjection; messages: ReadonlyMap<SessionSeq, Message> }

/** 创建空的 surface 折叠状态。 */
function createFoldState(): SurfaceFoldState {
  return { nodes: [], replaceGeneration: 0, contentGeneration: 0, projectedMessages: new Map(), projections: new Set() }
}

/** 运行时值是否为非负安全事件序号。 */
function isEventSeq(value: unknown): value is SessionSeq {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && !Object.is(value, -0)
}

/** 运行时值是否为确切的位置替换形状。 */
function isReplaceOp(value: object): value is Extract<SurfaceOp, { op: 'replace' }> {
  const op = value as Record<string, unknown>
  return Object.keys(op).length === 3
    && Object.hasOwn(op, 'op')
    && Object.hasOwn(op, 'startSeq')
    && Object.hasOwn(op, 'endSeq')
    && op['op'] === 'replace'
    && isEventSeq(op['startSeq'])
    && isEventSeq(op['endSeq'])
}

/** 验证事件局部的 surface 合格性并返回其操作。 */
function surfaceOpOf(event: SessionEvent): SurfaceOp | undefined {
  const raw: { surfaceOp?: unknown; sourceEventSeqs?: unknown } = event
  if (!isSurfaceEligibleType(event.type)) {
    // 未知的可忽略记录保留不透明元数据，不影响历史。
    if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable === true) return
    if (raw.surfaceOp !== undefined) {
      throw new Error(`session event "${event.type}" is not surface-eligible and cannot carry surfaceOp`)
    }
    if (raw.sourceEventSeqs !== undefined) {
      throw new Error(`session event "${event.type}" is not surface-eligible and cannot carry sourceEventSeqs`)
    }
    return
  }
  const op = raw.surfaceOp
  if (op === undefined) {
    throw new Error(`session event "${event.type}" is surface-eligible and requires a surfaceOp marker`)
  }
  if (op === 'append') return op
  if (op === null || typeof op !== 'object' || Array.isArray(op)) {
    throw new Error(`session event "${event.type}" carries an invalid surfaceOp`)
  }
  if (!isReplaceOp(op)) {
    throw new Error(`session event "${event.type}" carries an invalid replace surfaceOp`)
  }
  return op
}

/** 相对先前日志条目与替换范围验证引用的来源事件 seq。 */
function assertSourceEventReferences(
  event: SessionEvent,
  shadowedSeqs: readonly SessionSeq[],
): void {
  const raw: unknown = event.sourceEventSeqs
  if (event.type === 'assistant/message' && raw !== undefined) {
    throw new Error('assistant/message embeds its source stream and cannot carry sourceEventSeqs')
  }
  const sources = new Set<SessionSeq>()
  if (raw !== undefined) {
    if (!Array.isArray(raw)) {
      throw new Error(`sourceEventSeqs on event at seq ${event.seq} must be an array when present`)
    }
    if (raw.length === 0) {
      throw new Error('sourceEventSeqs must not be empty')
    }
    let nonEarlierSource: SessionSeq | undefined
    for (const source of raw) {
      if (!isEventSeq(source)) {
        throw new Error(`session event "${event.type}" sourceEventSeqs must densely contain non-negative safe integers`)
      }
      sources.add(source)
      if (nonEarlierSource === undefined && source >= event.seq) nonEarlierSource = source
    }
    if (sources.size !== raw.length) {
      throw new Error('sourceEventSeqs must not contain duplicates')
    }
    if (nonEarlierSource !== undefined) {
      throw new Error(`sourceEventSeqs must reference earlier events: ${nonEarlierSource} >= current seq ${event.seq}`)
    }
  }
  const missing = shadowedSeqs.filter(seq => !sources.has(seq))
  if (missing.length > 0) {
    throw new Error(`surface replace: sourceEventSeqs must include every shadowed surface node; missing ${missing.join(', ')}`)
  }
}

/** 相对其不可变历史请求 header 解析工具新增。 */
function assertDeveloperHeader(
  event: SessionEvent,
  events: readonly SessionEvent[],
  baseSeq: SessionLogOffset,
): void {
  if (event.type !== 'developer/message') return
  validateSessionEventData(event, `developer/message at seq ${event.seq}`)
  if (event.data.headerSeq === undefined) return
  const headerSeq = event.data.headerSeq
  const headerEvent = events[headerSeq - baseSeq]
  if (headerSeq >= event.seq || headerEvent?.type !== 'request/header') {
    throw new Error('developer/message headerSeq must reference an earlier request/header')
  }
  for (const block of event.data.message.content) {
    if (block.type !== 'tool-addition') continue
    const definitions = headerEvent.data.header.tools?.filter(tool => tool.name === block.toolName) ?? []
    if (definitions.length !== 1) {
      throw new Error(`developer/message tool-addition "${block.toolName}" must name exactly one tool in headerSeq ${headerSeq}`)
    }
    const definition = definitions[0] as ToolSchema
    if (typeof definition.description !== 'string' || !isRecord(definition.parameters)) {
      throw new Error(`developer/message tool-addition "${block.toolName}" requires a complete tool definition in headerSeq ${headerSeq}`)
    }
    if (Object.hasOwn(definition, 'deferLoading') && definition.deferLoading !== true) {
      throw new Error('developer/message referenced tool deferLoading must be true when present')
    }
  }
}

/**
 * 验证一个事件的 surface 元数据，不检查它在日志或 surface 中的成员资格。
 * @param event - 检查其标记与来源 seq 值的事件。
 * 未知的可忽略记录保留不透明元数据，从不改变 surface。
 * @returns 验证通过的操作；仅存于日志或未知可忽略事件为 undefined。
 * @throws 当元数据违反事件局部合格性、标记或来源 seq 规则时。
 */
export function validateSurfaceMetadata(event: SessionEvent): SurfaceOp | undefined {
  const op = surfaceOpOf(event)
  if (op !== undefined && op !== 'append'
    && (op.startSeq >= event.seq || op.endSeq >= event.seq)) {
    throw new Error(`surface replace at seq ${event.seq}: startSeq and endSeq must reference earlier events`)
  }
  if (op !== undefined) assertSourceEventReferences(event, [])
  return op
}

/** 不改变当前折叠状态地定位一个替换范围。 */
function replacementRange(
  state: SurfaceFoldState,
  op: Extract<SurfaceOp, { op: 'replace' }>,
): Pick<SurfaceReplacePlan, 'startIdx' | 'endIdx' | 'shadowedSeqs'> {
  const startIdx = state.nodes.indexOf(op.startSeq)
  if (startIdx === -1) {
    throw new Error(`surface replace: start seq ${op.startSeq} not found in surface`)
  }
  const endIdx = state.nodes.indexOf(op.endSeq)
  if (endIdx === -1) {
    throw new Error(`surface replace: end seq ${op.endSeq} not found in surface`)
  }
  if (startIdx > endIdx) {
    throw new Error(`surface replace: start seq ${op.startSeq} (index ${startIdx}) is after end seq ${op.endSeq} (index ${endIdx})`)
  }
  return {
    startIdx,
    endIdx,
    shadowedSeqs: state.nodes.slice(startIdx, endIdx + 1),
  }
}

/**
 * session 事件 JSON 值域（null/布尔/数值/字符串、数组、普通对象）上的深层
 * 结构相等。替代 `node:util` 的 isDeepStrictEqual，以保持本模块浏览器安全。
 */
function isDeepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, i) => isDeepEqualJson(item, b[i]))
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const aKeys = Object.keys(a)
  const bRecord = b as Record<string, unknown>
  if (aKeys.length !== Object.keys(b).length) return false
  return aKeys.every(key => Object.hasOwn(b, key) && isDeepEqualJson((a as Record<string, unknown>)[key], bRecord[key]))
}

/** 把 tool-result 替换限制为单个当前结果的内容。 */
function assertToolResultRewrite(
  event: SessionEvent,
  shadowedSeqs: readonly SessionSeq[],
  events: readonly SessionEvent[],
  baseSeq: SessionLogOffset,
): void {
  if (event.type !== 'tool/result') return
  if (shadowedSeqs.length !== 1) {
    throw new Error('tool/result surface replacement must rewrite exactly one current node')
  }
  for (const originalSeq of shadowedSeqs) {
    const original = events[originalSeq - baseSeq]
    if (original?.type !== 'tool/result') {
      throw new Error('tool/result surface replacement must target a current tool/result')
    }
    const originalRest = { ...original.data } as Record<string, unknown>
    const replacementRest = { ...event.data } as Record<string, unknown>
    originalRest['message'] = {
      ...original.data.message,
      content: null,
    }
    replacementRest['message'] = {
      ...event.data.message,
      content: null,
    }
    if (!isDeepEqualJson(originalRest, replacementRest)) {
      throw new Error('tool/result surface replacement may change only content')
    }
  }
}

/**
 * 保护 surface 节点 0 处的系统提示词。当节点 0 是 `system/message` 时，覆盖
 * 它的替换本身必须是恰好覆盖该节点的 `system/message`；后续系统节点不受保
 * 护，压缩范围可以遮蔽它们。
 */
function assertSystemHeadRewrite(
  event: SessionEvent,
  state: SurfaceFoldState,
  startIdx: number,
  shadowedSeqs: readonly SessionSeq[],
  events: readonly SessionEvent[],
  baseSeq: SessionLogOffset,
): void {
  if (startIdx !== 0) return
  const head = events[state.nodes[0] as number - baseSeq]
  if (head?.type !== 'system/message') return
  if (event.type !== 'system/message' || shadowedSeqs.length !== 1) {
    throw new Error('surface replace: node 0 holds the system prompt and may be rewritten only by a system/message over exactly that node')
  }
}

/** 在事件的回放边界验证它并准备其原子折叠过渡。 */
function planSurfaceEvent(
  state: SurfaceFoldState,
  event: SessionEvent,
  expectedSeq: SessionSeq,
  events: readonly SessionEvent[],
  baseSeq: SessionLogOffset,
  projections: readonly SessionMessageProjection[],
): SurfacePlan | undefined {
  if (event.seq !== expectedSeq) {
    throw new Error(`session event seq ${event.seq} is not contiguous; expected ${expectedSeq}`)
  }
  const surfaceOp = validateSurfaceMetadata(event)
  assertDeveloperHeader(event, events, baseSeq)
  const projection = projections.find(item => item.type === event.type)
  if (projection !== undefined) {
    return { kind: 'project', projection, messages: projection.project(event, {
      nodes: state.nodes, events, baseSeq, messages: state.projectedMessages,
    }) }
  }
  if (MESSAGE_PROJECTION_EVENT_TYPES.has(event.type)) {
    throw new Error(`session event "${event.type}" requires a message projection; load its owning plugin or supply its projection definition`)
  }
  if (surfaceOp === undefined) return
  if (surfaceOp === 'append') {
    return { kind: 'append', seq: event.seq }
  }
  const range = replacementRange(state, surfaceOp)
  assertSourceEventReferences(event, range.shadowedSeqs)
  assertToolResultRewrite(event, range.shadowedSeqs, events, baseSeq)
  assertSystemHeadRewrite(event, state, range.startIdx, range.shadowedSeqs, events, baseSeq)
  return {
    kind: 'replace',
    seq: event.seq,
    start: surfaceOp.startSeq,
    end: surfaceOp.endSeq,
    ...range,
  }
}

/** 应用一个事件；仅当发生替换时返回替换元数据。 */
function applySurfaceEvent(
  state: SurfaceFoldState,
  event: SessionEvent,
  expectedSeq: SessionSeq,
  events: readonly SessionEvent[],
  baseSeq: SessionLogOffset,
  projections: readonly SessionMessageProjection[],
): SurfaceFoldReplacement | undefined {
  const plan = planSurfaceEvent(state, event, expectedSeq, events, baseSeq, projections)
  return applySurfacePlan(state, plan)
}

/** 提交一个此前已验证的 surface 过渡。 */
function applySurfacePlan(
  state: SurfaceFoldState,
  plan: SurfacePlan | undefined,
): SurfaceFoldReplacement | undefined {
  if (plan?.kind === 'append') {
    state.nodes.push(plan.seq)
  } else if (plan?.kind === 'replace') {
    state.nodes.splice(plan.startIdx, plan.endIdx - plan.startIdx + 1, plan.seq)
    state.replaceGeneration += 1
    state.contentGeneration += 1
  } else if (plan?.kind === 'project') {
    for (const [seq, message] of plan.messages) state.projectedMessages.set(seq, message)
    state.projections.add(plan.projection)
    state.contentGeneration += 1
  }
  if (plan?.kind !== 'replace') return
  return {
    seq: plan.seq,
    start: plan.start,
    end: plan.end,
    shadowedSeqs: plan.shadowedSeqs,
  }
}

/**
 * 通过规范 surface 折叠回放完整的 session 日志。
 * @param events - 按连续 seq 顺序排列的 session 事件。
 * @param projections - 插件自有消息变更的纯解释器；必需的定义必须提供。
 * @returns 脱离的当前序列与替换历史。
 * @throws 当缺少解释器，或事件违反其投影、surface 元数据、来源归属或替换
 *   规则时。
 */
export function foldSurface(events: readonly SessionEvent[], projections: readonly SessionMessageProjection[] = []): SurfaceFoldResult {
  const state = createFoldState()
  const replacements: SurfaceFoldReplacement[] = []
  for (const [index, event] of events.entries()) {
    const replacement = applySurfaceEvent(
      state,
      event,
      SessionSeq(index),
      events,
      SessionLogOffset(0),
      projections,
    )
    if (replacement !== undefined) replacements.push(replacement)
  }
  return { nodes: [...state.nodes], replacements, projectedMessages: new Map(state.projectedMessages) }
}

/** 增量有序 surface 视图与追加边界验证器。 */
export class SurfaceManager implements SessionSurface {
  /** 共享过渡状态；不保留替换历史。 */
  private _state = createFoldState()
  /** 上次处理的绝对 seq。 */
  private _lastProcessedSeq: SessionSeqCursor
  /** 已由 `validateNext` 验证的候选，等待确切的日志接纳。 */
  private _pendingPlan: { event: SessionEvent; expectedSeq: SessionSeq; plan: SurfacePlan | undefined } | undefined

  /**
   * @param log - 连续完整日志或已加载的事件窗口。
   * @param baseSeq - 窗口第一个事件的绝对序号。
   * @param projections - 活跃借用的定义；移除一个在用定义会使后续读取失效。
   */
  constructor(
    private log: readonly SessionEvent[],
    private readonly baseSeq: SessionLogOffset = SessionLogOffset(0),
    private readonly projections: readonly SessionMessageProjection[] = [],
  ) {
    this._lastProcessedSeq = baseSeq === 0 ? -1 : SessionSeq(baseSeq - 1)
  }

  /**
   * 验证下一个候选，不改变已提交的 surface。
   * @param event - 尚未进入日志的候选事件。
   */
  validateNext(event: SessionEvent): void {
    this._assertProjections()
    if (this._lastProcessedSeq < this.baseSeq + this.log.length - 1) this._processDelta()
    const expectedSeq = SessionSeq(this.baseSeq + this.log.length)
    this._pendingPlan = {
      event,
      expectedSeq,
      plan: planSurfaceEvent(this._state, event, expectedSeq, this.log, this.baseSeq, this.projections),
    }
  }

  /** 已折叠位置替换的单调计数。 */
  get replaceGeneration(): number {
    this._assertProjections()
    if (this._lastProcessedSeq < this.baseSeq + this.log.length - 1) this._processDelta()
    return this._state.replaceGeneration
  }

  /** 对既有模型可见内容已提交变更的单调计数。 */
  get contentGeneration(): number {
    this._assertProjections()
    if (this._lastProcessedSeq < this.baseSeq + this.log.length - 1) this._processDelta()
    return this._state.contentGeneration
  }

  /**
   * 把一个消息在应用每个已提交消息投影后投影出来。
   * @param event - 产消息或仅存于日志的事件。
   * @returns 其不可变已投影消息，或不产生消息时为 null。
   */
  deriveEventMessage(event: SessionEvent): Message | null {
    this._assertProjections()
    if (this._lastProcessedSeq < this.baseSeq + this.log.length - 1) this._processDelta()
    return deriveEventMessage(event, this._state.projectedMessages)
  }

  /** 按模型可见顺序排列的 surface 事件序列。 */
  get nodes(): readonly SessionSeq[] {
    this._assertProjections()
    if (this._lastProcessedSeq < this.baseSeq + this.log.length - 1) this._processDelta()
    return this._state.nodes
  }

  /** 折叠自上次访问以来追加的事件。 */
  private _processDelta(): void {
    const tailSeq = this.baseSeq + this.log.length - 1
    for (let seq = this._lastProcessedSeq + 1; seq <= tailSeq; seq++) {
      const index = seq - this.baseSeq
      // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded by the loop condition
      const event = this.log[index]!
      const pending = this._pendingPlan
      if (pending?.event === event && pending.expectedSeq === seq) {
        applySurfacePlan(this._state, pending.plan)
      } else {
        applySurfaceEvent(this._state, event, SessionSeq(seq), this.log, this.baseSeq, this.projections)
      }
      if (pending !== undefined && pending.expectedSeq <= seq) this._pendingPlan = undefined
      this._lastProcessedSeq = SessionSeq(seq)
    }
  }

  /** 缓存的消息不能比解释其日志的定义活得久。 */
  private _assertProjections(): void {
    const candidate = this._pendingPlan
    const pending = candidate !== undefined && this.log[candidate.expectedSeq - this.baseSeq] === candidate.event
      ? candidate.plan : undefined
    const required = pending?.kind === 'project'
      ? [...this._state.projections, pending.projection]
      : this._state.projections
    for (const projection of required) {
      if (!this.projections.includes(projection)) {
        throw new Error(`session message projection "${projection.type}" was removed or replaced; restore the session with its owning plugin`)
      }
    }
  }
}
