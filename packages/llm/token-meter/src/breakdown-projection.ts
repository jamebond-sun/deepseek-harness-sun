/**
 * 当前保留表面的启发式构成，与路由图像定价和提供方用量无关。
 * 该状态按表面顺序保存存活的系统提示，外加一个滚动的表面总计；
 * 其余每个节点只按增量计价，因此状态规模随系统提示而非消息数量增长。
 */

import { z } from 'zod'
import { canonicalHeader, deriveEventMessage, isSurfaceEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SurfaceEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
// 仅类型：那些 `compaction/*` SessionEventMap 合并（影子价格事件）。
import type {} from '@deepseek-ai/dsh-compaction'
import { estimateMessage, estimateToolsTokens } from './estimate.ts'
// 为 `contextBreakdown` SessionProjectionStateMap 键合并而导入。
import type {} from './projection.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    contextBreakdown: ContextBreakdownState
  }
}

const tokenCount = z.number().int().nonnegative()
const sessionSeq = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(SessionSeq)

const breakdownSchema = z.object({
  systemTokens: tokenCount,
  toolsTokens: tokenCount,
  messageTokens: tokenCount,
}).strict()

/** 一个存活的 `system/message` 节点及其启发式价格。 */
const systemNodeSchema = z.object({
  seq: sessionSeq,
  tokens: tokenCount,
}).strict()

/**
 * 紧邻一次替换之前由 `compaction/summary` 或 `compaction/prune`
 * 事件装备的影子价格：被替换的区间、它的启发式价格，
 * 以及该区间内存活的系统提示。
 */
const claimSchema = z.object({
  start: sessionSeq,
  end: sessionSeq,
  tokens: tokenCount,
  systemSeqs: z.array(sessionSeq),
}).strict()

/** 纯 JSON 检查点：按表面顺序排列的存活系统提示、表面总计，以及一个已装备的声明。 */
const contextBreakdownStateSchema = z.object({
  systems: z.array(systemNodeSchema),
  surfaceTokens: tokenCount,
  claim: claimSchema.optional(),
  breakdown: breakdownSchema,
}).strict()
type ContextBreakdownState = z.infer<typeof contextBreakdownStateSchema>
type SystemNode = ContextBreakdownState['systems'][number]
type BreakdownClaim = z.infer<typeof claimSchema>

/** 一个表面事件之后的系统提示与表面总计。 */
interface SurfaceTotals {
  readonly systems: SystemNode[]
  readonly surfaceTokens: number
}

/**
 * 放置一个表面事件的已计价节点。
 * @param state - 该事件之前的状态，不含其已装备的声明。
 * @param claim - 由紧邻的上一个事件装备的影子价格，若有。
 * @param event - 该表面事件。
 * @param tokens - 该事件消息的启发式价格。
 * @returns 该事件之后的系统提示与表面总计。
 * @throws 当一次已计量的替换指名了与其声明不同的区间，
 *   或把一个系统消息放在一个已计量区间的位置上时。
 */
function placeSurfaceEvent(
  state: ContextBreakdownState,
  claim: BreakdownClaim | undefined,
  event: SurfaceEvent,
  tokens: number,
): SurfaceTotals {
  const op = event.surfaceOp
  const node: SystemNode = { seq: event.seq, tokens }
  const isSystem = event.type === 'system/message'
  if (op === 'append') {
    return { systems: isSystem ? [...state.systems, node] : state.systems, surfaceTokens: state.surfaceTokens + tokens }
  }
  if (claim !== undefined) {
    if (claim.start !== op.startSeq || claim.end !== op.endSeq) {
      throw new Error(
        `context breakdown: replace at seq ${event.seq} over range ${op.startSeq}-${op.endSeq} has no adjacent shadow price`
        + ` (armed claim covers ${claim.start}-${claim.end})`,
      )
    }
    if (isSystem) {
      throw new Error(
        `context breakdown: replace at seq ${event.seq} puts a system message in place of a metered range;`
        + ' its order among the surviving system prompts is unknown',
      )
    }
    const shadowed = new Set<number>(claim.systemSeqs)
    return {
      systems: state.systems.filter(system => !shadowed.has(system.seq)),
      surfaceTokens: state.surfaceTokens + tokens - claim.tokens,
    }
  }
  const index = op.startSeq === op.endSeq ? state.systems.findIndex(system => system.seq === op.startSeq) : -1
  const replaced = state.systems[index]
  if (replaced === undefined) {
    // 有界状态无法为一个未计量的非系统区间定价，因此它以零增量折叠；
    // 当前的生产者会为每一个这样的替换计量。
    return { systems: state.systems, surfaceTokens: state.surfaceTokens }
  }
  return {
    systems: isSystem ? state.systems.with(index, node) : state.systems.toSpliced(index, 1),
    surfaceTokens: state.surfaceTokens + tokens - replaced.tokens,
  }
}

/** 发布各项总计；当各个数值未发生变化时保留前一个分解对象。 */
function withTotals(state: ContextBreakdownState, totals: SurfaceTotals): ContextBreakdownState {
  const surfaceTokens = Math.max(0, totals.surfaceTokens)
  const systemTokens = totals.systems.findLast(system => system.tokens > 0)?.tokens ?? 0
  const messageTokens = Math.max(0, surfaceTokens - systemTokens)
  const breakdown = systemTokens === state.breakdown.systemTokens && messageTokens === state.breakdown.messageTokens
    ? state.breakdown
    : { systemTokens, toolsTokens: state.breakdown.toolsTokens, messageTokens }
  return { ...state, systems: totals.systems, surfaceTokens, breakdown }
}

/** 丢弃一个已装备的声明；当没有装备任何声明时，状态原样返回。 */
function withoutClaim(state: ContextBreakdownState): ContextBreakdownState {
  if (state.claim === undefined) return state
  const { claim: _expired, ...unclaimed } = state
  return unclaimed
}

/**
 * 上下文构成：表面顺序上最后一个非空且存活的系统被分类为系统令牌；
 * 其余所有可见价格都是消息。追加会加上它自己的价格；一次替换会减去
 * 相邻的 `compaction/summary` 或 `compaction/prune` 事件的影子价格，
 * 该事件的 `shadowedSeqs` 还指名了它所移除的系统提示；而一次系统提示
 * 重写会减去它所替换的那个系统节点保留下来的价格。工具按最新的请求头计价。
 * 没有任何路由定价参与。
 */
export const contextBreakdownProjectionDefinition = {
  key: 'contextBreakdown',
  stateVersion: 6,
  stateSchema: contextBreakdownStateSchema,
  init: (): ContextBreakdownState => ({
    systems: [],
    surfaceTokens: 0,
    breakdown: { systemTokens: 0, toolsTokens: 0, messageTokens: 0 },
  }),
  apply: (state, event) => {
    if (event.type === 'compaction/summary' || event.type === 'compaction/prune') {
      const shadowed = new Set<number>(event.data.shadowedSeqs)
      return {
        ...state,
        claim: {
          start: SessionSeq(event.data.shadowedRange.start),
          end: SessionSeq(event.data.shadowedRange.end),
          tokens: event.data.shadowedTokenCount,
          systemSeqs: state.systems.filter(system => shadowed.has(system.seq)).map(system => system.seq),
        },
      }
    }
    // 一个声明只为其计量事件之后的那个紧邻事件计价。
    const unclaimed = withoutClaim(state)
    if (event.type === 'request/header') {
      const toolsTokens = estimateToolsTokens(canonicalHeader(event.data.header))
      return toolsTokens === unclaimed.breakdown.toolsTokens
        ? unclaimed
        : { ...unclaimed, breakdown: { ...unclaimed.breakdown, toolsTokens } }
    }
    if (!isSurfaceEvent(event)) return unclaimed
    const message = deriveEventMessage(event)
    const tokens = message === null ? 0 : estimateMessage(message)
    return withTotals(unclaimed, placeSurfaceEvent(unclaimed, state.claim, event, tokens))
  },
  wire: {
    viewSchema: breakdownSchema,
    view: state => state.breakdown,
  },
} satisfies ProjectionDefinition<'contextBreakdown', ContextBreakdownState>
