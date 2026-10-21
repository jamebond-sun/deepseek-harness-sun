/**
 * `sessionStats` 投影单元：一个纯折叠，把步骤边界、流内嵌流、工具对以及
 * 已组装的 assistant 消息折叠成整日志的计数与墙钟时间。
 *
 * 被计数的步骤事件是 `step/end` 而非 `assistant/message`，因为它是步骤
 * 生命周期的权威：循环在每个进入的步骤中、于 `finally` 里恰好追加一个，
 * 因此已完成、失败、已取消与触达最大 token 的步骤都会恰好落地一个。改为
 * 统计已组装的 assistant 消息会高估触达最大 token 用量宿主消息（内容为空、
 * 被排除在 surface 之外），并低估已取消的步骤（在消息组装前就中止了）。
 *
 * 墙钟时间的折叠逐字段与客户端窗口折叠镜像对应（dsh-client-ui-conversation
 * 中的 `deriveStats`，即那个折叠的整窗口回退角色）：模型时间是
 * `step/start` → `assistant/message`，首 token 是第一个非空 delta 分块，
 * 且能挺过步骤内的 `llm/retry`，解码跨度为首 token → 已组装消息（在那些也
 * 上报输出 token 的步骤上），工具时间按 callId 把 `tool/call` → `tool/result`
 * 配对。一个被取消的步骤不组装消息，因此其部分流时间在每个时间数字中都
 * 不被计入——这与窗口一致，窗口把它渲染成一个无计时的中断节点。
 *
 * @module @deepseek-ai/dsh-session-stats/projection
 */

import { z } from 'zod'
import { assistantStreamFirstTokenTime } from '@deepseek-ai/dsh-llm'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'


/** 累积的整日志数字（视图恰好就是这些合计）。 */
interface SessionStatsTotals {
  /** 到目前为止、至少含一个已关闭步骤的不同回合。 */
  turns: number
  /** 到目前为止的已关闭步骤。 */
  steps: number
  /** 在组装了消息的步骤上，模型墙钟时间合计，单位 ms。 */
  llmMs: number
  /** 已匹配的、工具调用→结果墙钟时间合计，单位 ms。 */
  toolMs: number
  /** 在 `ttftSteps` 上、首 token 延迟合计，单位 ms。 */
  ttftMs: number
  /** 携带了被记录的首 token 的步骤数。 */
  ttftSteps: number
  /** 在报告用量的步骤上，解码墙钟时间合计，单位 ms。 */
  decodeMs: number
  /** 在同一批步骤上、提供方输出 token 合计。 */
  decodeTokens: number
}

/**
 * 折叠状态：合计，加上它们从中累积的、在途的边界。回合号由主机分配，
 * 且每会话单调，因此单独一个 `lastTurn` 槽位就能决定“新回合的第一个
 * 已关闭步骤”；按单元契约，该状态为纯 JSON（持久化缓存的前提条件）。
 */
interface SessionStatsState extends SessionStatsTotals {
  /** 最后一个被计数的 `step/end` 的回合；在首个之前为 null。 */
  lastTurn: number | null
  /** 当前打开步骤的边界事实；在步骤之外或其消息已组装之后为 null。 */
  openStep: { turn: number; step: number; startTime: number; firstTokenTime: number | null } | null
  /** 结果尚未落地的工具调用的派发时间，按 callId 索引。 */
  pendingCalls: Record<string, number>
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    sessionStats: SessionStatsState
  }
}

const sessionStatsSchema = z.object({
  turns: z.number().int().nonnegative(),
  steps: z.number().int().nonnegative(),
  llmMs: z.number().nonnegative(),
  toolMs: z.number().nonnegative(),
  ttftMs: z.number().nonnegative(),
  ttftSteps: z.number().int().nonnegative(),
  decodeMs: z.number().nonnegative(),
  decodeTokens: z.number().nonnegative(),
}).strict()

/**
 * 折叠状态的形状（合计加上在途边界），在 `ver` 闸门之后对被持久化缓存的
 * 行做校验——即该单元的输入边界。视图是状态的严格子集，因此本 schema 在
 * `sessionStatsSchema`（wire 输出边界）基础上扩展出边界字段。
 */
const sessionStatsStateSchema = sessionStatsSchema.extend({
  lastTurn: z.number().int().nonnegative().nullable(),
  openStep: z.object({
    turn: z.number().int().nonnegative(),
    step: z.number().int().nonnegative(),
    startTime: z.number().nonnegative(),
    firstTokenTime: z.number().nonnegative().nullable(),
  }).nullable(),
  pendingCalls: z.record(z.string(), z.number().nonnegative()),
})

/**
 * 提供方报告的完成 token，以窗口折叠守护节点用量的方式来守护。
 * @param usage - assistant/message 事件的可选用量记录。
 * @returns 输出 token 计数；当未报告或无效时为 null。
 */
function usageOutputTokens(usage: unknown): number | null {
  if (typeof usage !== 'object' || usage === null) return null
  const value = (usage as { outputTokens?: unknown }).outputTokens
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** The `sessionStats` unit registered on `ctx.sessionProjections` (exported for the unit spec). */
export const sessionStatsProjectionDefinition = {
  key: 'sessionStats',
  stateVersion: 1,
  stateSchema: sessionStatsStateSchema,
  init: () => ({
    turns: 0,
    steps: 0,
    llmMs: 0,
    toolMs: 0,
    ttftMs: 0,
    ttftSteps: 0,
    decodeMs: 0,
    decodeTokens: 0,
    lastTurn: null,
    openStep: null,
    pendingCalls: {},
  }),
  apply: (state, event) => {
    // 每个无趣的事件都返回同一个引用（Object.is 把住变更流闸门）。
    switch (event.type) {
      case 'step/start':
        return {
          ...state,
          openStep: { turn: event.data.turn, step: event.data.step, startTime: event.time, firstTokenTime: null },
        }
      case 'assistant/attempt': {
        const open = state.openStep
        if (open === null || open.turn !== event.data.turn || open.step !== event.data.step) return state
        const first = assistantStreamFirstTokenTime(event.data.stream) ?? null
        if (open.firstTokenTime !== null || first === null) return state
        return { ...state, openStep: { ...open, firstTokenTime: first } }
      }
      case 'assistant/message': {
        const open = state.openStep
        if (open === null || open.turn !== event.data.turn || open.step !== event.data.step) return state
        const firstToken = open.firstTokenTime ?? assistantStreamFirstTokenTime(event.data.stream) ?? null
        // 每个步骤只有一个已组装消息：关闭边界意味着防御性的重复不会
        // 被计入两次。
        const next: SessionStatsState = {
          ...state,
          llmMs: state.llmMs + Math.max(0, event.time - open.startTime),
          openStep: null,
        }
        if (firstToken !== null) {
          next.ttftMs += Math.max(0, firstToken - open.startTime)
          next.ttftSteps += 1
          const outputTokens = usageOutputTokens(event.data.usage)
          if (outputTokens !== null) {
            next.decodeMs += Math.max(0, event.time - firstToken)
            next.decodeTokens += outputTokens
          }
        }
        return next
      }
      case 'tool/call':
        return { ...state, pendingCalls: { ...state.pendingCalls, [event.data.callId]: event.time } }
      case 'tool/result': {
        // Own-key check: callId is provider-minted (model/tool JSON boundary),
        // so a prototype property name ('constructor', 'toString') on a result
        // with no recorded call must read as unmatched, not as an inherited
        // function that would poison toolMs with NaN.
        const callId = event.data.message.source.callId
        const dispatched = Object.hasOwn(state.pendingCalls, callId) ? state.pendingCalls[callId] : undefined
        if (dispatched === undefined) return state
        const pendingCalls = Object.fromEntries(
          Object.entries(state.pendingCalls).filter(([id]) => id !== callId),
        )
        return { ...state, toolMs: state.toolMs + Math.max(0, event.time - dispatched), pendingCalls }
      }
      case 'step/end':
        return {
          ...state,
          turns: state.lastTurn === event.data.turn ? state.turns : state.turns + 1,
          steps: state.steps + 1,
          lastTurn: event.data.turn,
          openStep: null,
        }
      case 'turn/end':
        // 一个结果从未落地的调用属于某个被取消或失败的回合；结果总是在
        // 其回合内落地，因此丢弃这些残留，而非让持久化状态永远增长。
        return Object.keys(state.pendingCalls).length === 0 ? state : { ...state, pendingCalls: {} }
      default:
        return state
    }
  },
  wire: {
    viewSchema: sessionStatsSchema,
    view: state => ({
      turns: state.turns,
      steps: state.steps,
      llmMs: state.llmMs,
      toolMs: state.toolMs,
      ttftMs: state.ttftMs,
      ttftSteps: state.ttftSteps,
      decodeMs: state.decodeMs,
      decodeTokens: state.decodeTokens,
    }),
  },
} satisfies ProjectionDefinition<'sessionStats', SessionStatsState>
