/**
 * 可选择的请求时钟上下文。符合条件的步骤会向请求历史追加持久化的、
 * 标注来源的计时读数。
 *
 * @module @deepseek-ai/dsh-time-context
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'time-context': { kind: 'time-context' } & ContextFormed
  }
}

import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import {
  deriveBrowserTimeZoneContext,
  renderBrowserTimeZoneContext,
} from './request-zone.ts'
import type { BrowserTimeZoneContext } from './request-zone.ts'
import { createTimestampFormatter, formatTimestamp } from './timestamp.ts'

/** 供加载器诊断使用的 Cordis 插件名称。 */
export const name = 'time-context'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** 最新的 time-context 读数。 */
    timeContext: TimeContextProjection
  }
}

const timeContextStateSchema = zod.object({
  /** 最新一次模型可见事件（user/assistant 消息、tool 结果）的时间，或 null。 */
  lastMessageTime: zod.number().nullable(),
  /** 本插件最新一次持久化注入的时间，或 null。 */
  lastInjectionTime: zod.number().nullable(),
  /** 当前开放轮次中最新一次注入的时间，或在该轮次收到注入之前为 null。 */
  lastTurnInjectionTime: zod.number().nullable(),
})

/** Folded time-context readings. */
type TimeContextProjection = zod.infer<typeof timeContextStateSchema>

/** 拥有预步骤处理的代理注册表。 */
export const inject = ['agents', 'sessionProjections']

/** 请求准备阶段的时钟格式化与追加调度。无效值会使插件加载失败。 */
export interface Config {
  /** 当开放轮次没有唯一浏览器时区时的回退显示时区。省略则使用进程时区。 */
  timeZone?: string
  /** 同一会话内两次持久化注入之间的最小毫秒数。默认 600000（10 分钟）；0 表示每个符合条件的步骤都注入。 */
  refreshIntervalMs?: number
}

/** 针对 {@link Config} 的 Schemastery 校验。 */
export const Config: z<Config> = z.object({
  timeZone: z.string(),
  refreshIntervalMs: z.number(),
})

/** 将非负、已流逝的毫秒计数格式化为紧凑的整秒单位。 */
function formatDuration(elapsedMs: number): string {
  let seconds = Math.floor(Math.max(0, elapsedMs) / 1000)
  const days = Math.floor(seconds / 86_400)
  seconds %= 86_400
  const hours = Math.floor(seconds / 3600)
  seconds %= 3600
  const minutes = Math.floor(seconds / 60)
  seconds %= 60
  const parts: string[] = []
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0) parts.push(`${minutes}m`)
  parts.push(`${seconds}s`)
  return parts.join(' ')
}

/** 收集已输入与提议的、属于某个开放轮次的 user 消息。 */
function requestMessages(agent: Agent, turn: number, proposed: readonly UserMessage[]): UserMessage[] {
  const entered: UserMessage[] = []
  for (let seq = agent.session.seq - 1; seq >= 0; seq -= 1) {
    // oxlint-disable-next-line typescript/no-deprecated -- 既有 Session 历史读取；迁移暂缓。
    const event = agent.session.eventAt(SessionSeq(seq))
    if (event?.type === 'turn/start' && event.data.turn === turn) {
      return [...entered.reverse(), ...proposed]
    }
    if (event?.type === 'user/message') entered.push(event.data)
  }
  return [...proposed]
}

function renderText(
  now: number,
  turn: number,
  step: number,
  previous: number | undefined,
  formatter: Intl.DateTimeFormat,
  timeZone: string,
  browserContext: BrowserTimeZoneContext,
): string {
  const elapsed = previous === undefined ? 'unavailable' : formatDuration(now - previous)
  const baseline = step === 1 ? 'model-visible message' : 'step context'
  const browserText = renderBrowserTimeZoneContext(browserContext)
  return `Time sampled while preparing turn ${turn}, step ${step}: ${formatTimestamp(now, formatter, timeZone)}\n`
    + `${browserText}\n`
    + `Elapsed since the preceding ${baseline}: ${elapsed}.`
}

/** 拒绝无法表示精确已流逝毫秒阈值的刷新间隔。 */
function validateRefreshInterval(refreshIntervalMs: number): void {
  if (!Number.isSafeInteger(refreshIntervalMs) || refreshIntervalMs < 0) {
    throw new TypeError(
      `time-context: refreshIntervalMs must be a non-negative safe integer, got ${String(refreshIntervalMs)}`,
    )
  }
}

/**
 * 为 `ctx` 的整个生命周期注册一个前置的预步骤监听器。
 * @param ctx - 插件上下文；监听器随其一同释放。
 * @param config - 时区与持久化刷新调度配置。
 * @throws 当刷新间隔无效，或所配置或进程的时区无法解析时。
 */
export function apply(ctx: Context, config: Config): void {
  const timeZone = config.timeZone
  const refreshIntervalMs = config.refreshIntervalMs ?? 600_000
  validateRefreshInterval(refreshIntervalMs)
  let fallbackFormatter: Intl.DateTimeFormat
  try {
    fallbackFormatter = createTimestampFormatter(timeZone)
  } catch (error: unknown) {
    const message = timeZone === undefined
      ? 'time-context: failed to resolve the system time zone'
      : `time-context: invalid IANA timeZone ${JSON.stringify(timeZone)}`
    throw new Error(message, { cause: error })
  }
  const fallbackTimeZone = fallbackFormatter.resolvedOptions().timeZone
  const formatters = new Map<string, Intl.DateTimeFormat>([[fallbackTimeZone, fallbackFormatter]])

  /** 解析并缓存一个请求局部的、时间戳格式化器。 */
  const formatterFor = (selectedTimeZone: string): Intl.DateTimeFormat => {
    const existing = formatters.get(selectedTimeZone)
    if (existing !== undefined) return existing
    const created = createTimestampFormatter(selectedTimeZone)
    formatters.set(selectedTimeZone, created)
    return created
  }

  ctx.sessionProjections.register({
    key: 'timeContext',
    stateVersion: 2,
    stateSchema: timeContextStateSchema,
    init: () => ({ lastMessageTime: null, lastInjectionTime: null, lastTurnInjectionTime: null }),  // 投影初始状态：尚无任何读数
    apply: (state, event) => {
      if (event.type === 'turn/start' || event.type === 'turn/end') {
        return state.lastTurnInjectionTime === null ? state : { ...state, lastTurnInjectionTime: null }
      }
      if (event.type === 'user/message') {
        const injected = event.data.source.kind === name
        const withMessage = state.lastMessageTime === event.time
          ? state
          : { ...state, lastMessageTime: event.time }
        if (!injected) return withMessage
        return {
          ...withMessage,
          lastInjectionTime: event.time,
          lastTurnInjectionTime: event.time,
        }
      }
      if (event.type === 'assistant/message' || event.type === 'tool/result') {
        return state.lastMessageTime === event.time ? state : { ...state, lastMessageTime: event.time }
      }
      return state
    },
  })

  ctx.on('agent/pre-step', async (
    { agent, turn, step, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    const now = Date.now()
    const state = ctx.sessionProjections.stateOf(agent.session, 'timeContext') as TimeContextProjection
    if (refreshIntervalMs > 0) {
      const lastInjection = state.lastInjectionTime
      if (lastInjection != null
        && now >= lastInjection
        && now - lastInjection < refreshIntervalMs) return decision
    }
    /* v8 ignore next 6 -- every later step follows a recorded injection in the same turn */
    const previous = step === 1
      ? state.lastMessageTime ?? undefined
      : state.lastTurnInjectionTime ?? undefined
    const messages = requestMessages(agent, turn, decision.messages)
    const browser = deriveBrowserTimeZoneContext(messages)
    const selectedTimeZone = browser.kind === 'resolved' ? browser.timeZone : fallbackTimeZone
    const text = renderText(
      now,
      turn,
      step,
      previous,
      formatterFor(selectedTimeZone),
      selectedTimeZone,
      browser,
    )
    return {
      ...decision,
      messages: [
        ...decision.messages,
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: name, form: 'snapshot', sections: [{ name, text }] },
        }),
      ],
    }
  }, { prepend: true })
}
