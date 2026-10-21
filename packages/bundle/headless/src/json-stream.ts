/**
 * `--json` 运行投影：由一个 Agent 的持久化 Session 事件派生出的有界、有序事件流。
 * 每个被投影的事件都是一个提交点：文本与思考来自已提交的 `assistant/message` 内容，
 * 而绝不来自仍可能被重试或丢弃的实时尝试，因此该流永远不会携带持久化日志之外的内容。
 * @module @deepseek-ai/dsh-headless/json-stream
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { lastAssistantStreamChunk } from '@deepseek-ai/dsh-llm/assistant-stream'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** 应用于每个有界投影负载的默认单字符串与单键上限。 */
export const MAX_STRING_BYTES = 8 * 1024

/** 单个投影事件序列化字节数的默认上限，含换行符；终止性的 `final` 事件不受此限。 */
export const MAX_EVENT_BYTES = 32 * 1024

/** 每个换行分隔写入器在一条序列化事件之后追加的字节数。 */
const LINE_TERMINATOR_BYTES = 1

/** 投影写入换行分隔事件所用的 stdout 目标。 */
export interface JsonSink {
  /** 写入事件流的一个分片。 */
  write(chunk: string): unknown
}

/** {@link projectJsonRun} 的可调项；每个字段都有默认值。 */
export interface JsonProjectionOptions {
  /** 开头的 `session` 事件所上报的工作目录。 */
  cwd?: string
  /** 单字符串与单键的字节上限；更长的值会被截断并打上标记。 */
  maxStringBytes?: number
}

/** 一次 `--json` 投影的实时句柄。 */
export interface JsonProjection {
  /** 写入携带本次运行答复文本的终止事件 `final`。 */
  finish(text: string): void
  /** 停止观察该 Session。 */
  dispose(): void
}

/** 贯穿一次负载裁剪过程的可变截断状态。 */
interface BoundState {
  truncated: boolean
}

/** 把一个 UTF-8 字符串截断到 `maxBytes`，丢弃被切开的尾部字符。 */
function truncateUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8').subarray(0, maxBytes)
  const decoded = buffer.toString('utf8')
  return decoded.endsWith('\uFFFD') ? decoded.slice(0, -1) : decoded
}

/** 限制单个对象键的长度，并在它被截断时给负载打上标记。 */
function boundKey(key: string, maxBytes: number, state: BoundState): string {
  if (Buffer.byteLength(key, 'utf8') <= maxBytes) return key
  state.truncated = true
  return truncateUtf8(key, maxBytes)
}

/** 一个投影负载在尾部被切断之前保留的最大容器深度。 */
const MAX_DEPTH = 64

/** 递归限制一个可 JSON 序列化值中的每个字符串，键名同样受限。 */
function boundValue(value: unknown, maxBytes: number, state: BoundState, depth = 0): unknown {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
    state.truncated = true
    return truncateUtf8(value, maxBytes)
  }
  if (Array.isArray(value)) {
    // 否则一个合法但异常深的参数会一直递归到栈溢出，而这个被隔离的监听器会静默
    // 丢弃该事件；因此在一个真实工具 schema 都达不到的深度处切断尾部。
    if (depth >= MAX_DEPTH) {
      state.truncated = true
      return '[truncated: depth]'
    }
    return value.map(item => boundValue(item, maxBytes, state, depth + 1))
  }
  if (value !== null && typeof value === 'object') {
    if (depth >= MAX_DEPTH) {
      state.truncated = true
      return '[truncated: depth]'
    }
    // 空原型让字面量 `__proto__` 键保持为数据，而不是触发继承来的 setter——后者
    // 会静默丢弃它。共用同一截断前缀的两个键按最后写入者胜出发生碰撞；只有同时
    // 包含两个数 KB 长键的负载才会达到这种情况。
    const bounded = Object.create(null) as Record<string, unknown>
    for (const [key, item] of Object.entries(value)) {
      bounded[boundKey(key, maxBytes, state)] = boundValue(item, maxBytes, state, depth + 1)
    }
    return bounded
  }
  return value
}

/**
 * 限制一个投影负载中每个字符串与键的长度，当有任一项被截断时加上 `truncated: true`。
 * {@link boundJsonLine} 在此基础上再与整行上限组合。
 * @param event - 待裁剪的事件负载。
 * @param maxStringBytes - 单字符串与单键的字节上限。
 * @returns 一个副本，其中所有过长的字符串与键都被截断。
 */
function boundJsonEvent(
  event: Record<string, unknown>,
  maxStringBytes: number = MAX_STRING_BYTES,
): Record<string, unknown> {
  const state: BoundState = { truncated: false }
  const bounded = boundValue(event, maxStringBytes, state) as Record<string, unknown>
  if (state.truncated) bounded.truncated = true
  return bounded
}

/**
 * 在两重限制下序列化一个投影负载：每个字符串与键不超过 `maxStringBytes`，
 * 序列化后的行不超过 `maxEventBytes`。行上限为写入器追加的换行符预留了空间，
 * 因此完整记录仍落在限制之内。当行依旧过长时，标量字段保留而结构化字段被丢弃；
 * 当连这些字段都过长时，只剩下 `type` 与 `truncated`。
 * @param event - 待序列化的事件负载。
 * @param maxStringBytes - 单字符串与单键的字节上限。
 * @param maxEventBytes - 序列化行及其尾随换行符的上限。
 * @returns 有界的 JSON 行，不含尾随换行符。
 */
export function boundJsonLine(
  event: Record<string, unknown>,
  maxStringBytes: number = MAX_STRING_BYTES,
  maxEventBytes: number = MAX_EVENT_BYTES,
): string {
  const limit = maxEventBytes - LINE_TERMINATOR_BYTES
  const bounded = boundJsonEvent(event, maxStringBytes)
  const line = JSON.stringify(bounded)
  if (Buffer.byteLength(line, 'utf8') <= limit) return line
  const scalars = Object.create(null) as Record<string, unknown>
  for (const [key, value] of Object.entries(bounded)) {
    if (value === null || typeof value !== 'object') scalars[key] = value
  }
  scalars.truncated = true
  const short = JSON.stringify(scalars)
  if (Buffer.byteLength(short, 'utf8') <= limit) return short
  return JSON.stringify({ type: bounded.type, truncated: true })
}

/**
 * 像执行器那样解析原始的工具调用参数：空输入是 `{}`，非法或无法往返的 JSON
 * （非有限数值）保持为文本。
 */
function parseArguments(raw: string): unknown {
  if (raw === '') return {}
  const seen = { nonFinite: false }
  try {
    const parsed: unknown = JSON.parse(raw, (_key, value: unknown) => {
      // `1e400` 是合法 JSON，但会解析为 Infinity，而 JSON.stringify 会把它报成
      // null；保留原始文本，以免错误描述这次调用。
      if (typeof value === 'number' && !Number.isFinite(value)) seen.nonFinite = true
      return value
    })
    return seen.nonFinite ? raw : parsed
  } catch {
    return raw
  }
}

/** 拼接工具结果的模型可见内容中的文本块。 */
function resultText(blocks: readonly { type: string; text?: string }[]): string {
  return blocks
    .filter((block): block is { type: string; text: string } =>
      block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

/** 一步之内 provider 上报的 token 计量，由 `assistant/message` 携带。 */
type StepUsage = NonNullable<SessionEvent<'assistant/message'>['data']['usage']>

/** 一步累计的用量，以及是否每次尝试都上报了采样。 */
interface StepUsageState {
  usage: StepUsage | undefined
  /** 一旦该步骤中有任一尝试缺少用量采样即为 false。 */
  complete: boolean
}

/** 一次尝试的流中 provider 上报的用量（若有）。 */
function streamUsage(stream: SessionEvent<'assistant/message'>['data']['stream']): StepUsage | undefined {
  return lastAssistantStreamChunk(stream, 'usage')?.usage
}

/**
 * 在一次步骤的多次尝试之间累计用量。被重试的尝试只在自己的 `assistant/attempt`
 * 流中保留用量，因此仅看已提交的消息会少报计费 token。某次尝试若未上报采样，
 * 该步骤的总量便不可知，因此整个步骤省略用量，而不是把一个部分和当作完整总量发布；
 * 可选字段只有在每次贡献都上报它时才累加。
 * @param state - 累计至今的用量，以及它是否仍然完整。
 * @param next - 下一次尝试上报的用量。
 * @returns 更新后的状态。
 */
function addUsage(state: StepUsageState, next: StepUsage | undefined): StepUsageState {
  if (next === undefined) return { usage: state.usage, complete: false }
  if (state.usage === undefined) return { usage: next, complete: state.complete }
  const total = state.usage
  const sum = (a: number | undefined, b: number | undefined): number | undefined =>
    a === undefined || b === undefined ? undefined : a + b
  const totalTokens = sum(total.totalTokens, next.totalTokens)
  const cacheReadTokens = sum(total.cacheReadTokens, next.cacheReadTokens)
  const cacheWriteTokens = sum(total.cacheWriteTokens, next.cacheWriteTokens)
  const reasoningTokens = sum(total.reasoningTokens, next.reasoningTokens)
  return {
    usage: {
      inputTokens: total.inputTokens + next.inputTokens,
      outputTokens: total.outputTokens + next.outputTokens,
      ...totalTokens === undefined ? {} : { totalTokens },
      ...cacheReadTokens === undefined ? {} : { cacheReadTokens },
      ...cacheWriteTokens === undefined ? {} : { cacheWriteTokens },
      ...reasoningTokens === undefined ? {} : { reasoningTokens },
    },
    complete: state.complete,
  }
}

/**
 * 把一个 Agent 的运行投影为 `sink` 上换行分隔的 JSON。
 *
 * 开头的 `session` 事件在订阅开始之前写入，因此调用方必须在提交任务之前调用本函数。
 * 只有当步骤的 `assistant/message` 提交之后，文本与思考才会被输出；终止性的 `final`
 * 事件携带与默认模式打印内容相同的无损答复（它被刻意不做裁剪）。
 * @param ctx - 承载实时 Session 事件推送的插件上下文。
 * @param agent - 其事件属于本次调用的确切 Agent。
 * @param sink - 接收每行一个 JSON 对象的 stdout 目标。
 * @param options - 投影的可调项。
 * @returns 用于结束或停止该流的投影句柄。
 */
export function projectJsonRun(
  ctx: Context,
  agent: Agent,
  sink: JsonSink,
  options: JsonProjectionOptions = {},
): JsonProjection {
  const maxStringBytes = options.maxStringBytes ?? MAX_STRING_BYTES
  let disposed = false
  let stepUsage: StepUsageState = { usage: undefined, complete: true }

  const write = (event: Record<string, unknown>): void => {
    sink.write(`${boundJsonLine(event, maxStringBytes)}\n`)
  }

  const onSessionEvent = (session: unknown, event: SessionEvent): void => {
    if (session !== agent.session) return
    switch (event.type) {
      case 'turn/start':
        write({ type: 'status', phase: 'turn_start', turn: event.data.turn })
        return
      case 'step/start':
        write({ type: 'status', phase: 'step_start', turn: event.data.turn, step: event.data.step })
        return
      case 'assistant/attempt':
        // 被重试的尝试没有已提交的消息；它的计费 token 只存在于流中，因此把它
        // 们累加进该步骤的总量。
        stepUsage = addUsage(stepUsage, streamUsage(event.data.stream))
        return
      case 'assistant/message':
        stepUsage = addUsage(stepUsage, event.data.usage ?? streamUsage(event.data.stream))
        for (const block of event.data.message.content) {
          if (block.type === 'reasoning') write({ type: 'thinking', text: block.text })
          else if (block.type === 'text') write({ type: 'text', text: block.text })
        }
        return
      case 'step/end': {
        const { usage, complete } = stepUsage
        stepUsage = { usage: undefined, complete: true }
        write({
          type: 'status', phase: 'step_end', turn: event.data.turn, step: event.data.step,
          // 部分和会被读作精确总量，因此当该步骤中有任一尝试未上报用量时，
          // 就完全省略它。
          ...complete && usage !== undefined ? { usage } : {},
        })
        return
      }
      case 'turn/end':
        write({ type: 'status', phase: 'turn_end', turn: event.data.turn, reason: event.data.reason })
        return
      case 'tool/call':
        write({
          type: 'tool_call',
          callId: event.data.callId,
          tool: event.data.name,
          input: parseArguments(event.data.arguments),
        })
        return
      case 'tool/result': {
        // 压缩会替换界面中更早的结果；那些属于历史而非本次运行的输出，否则会
        // 重复同一个 callId。
        if (event.surfaceOp !== 'append') return
        const message = event.data.message
        write({
          type: 'tool_result',
          callId: message.toolCallId,
          status: message.isError === true ? 'error' : 'completed',
          result: resultText(message.content),
        })
        return
      }
      default:
        return
    }
  }

  write({ type: 'session', sessionId: agent.id, cwd: options.cwd ?? process.cwd() })
  const stopSession = ctx.on('session/event', onSessionEvent)

  return {
    finish(text: string): void {
      // 答复是无损的终态契约，因此不做截断。
      if (disposed) return
      sink.write(`${JSON.stringify({ type: 'final', text })}\n`)
    },
    dispose(): void {
      disposed = true
      stopSession()
    },
  }
}
