/**
 * 用于子代理身份（模式/标签）与活跃轮次时长的纯 session 投影。
 *
 * @module @deepseek-ai/dsh-subagent/projection
 */

import { z } from 'zod'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { foldSubagentDescriptor } from './descriptor.ts'
import type { SubagentDescriptorData } from './descriptor.ts'
import type { SubagentIdentityProjection, SubagentTimingProjection } from './projection-types.ts'

/** 子代理最新计时快照的折叠状态。 */
export interface TimingState {
  /** 跨描述符之后的已完成轮次所累计的毫秒数。 */
  settledMs: number
  /** 在折叠内部保持配对的当前开启区间。 */
  active?: { since: number; through: number } | undefined
  /** 最近的描述符前轮次开始时间，在子代理自身描述符到达时被提升。 */
  pendingTurnStart?: number | undefined
  /** 折叠是否已在本逻辑日志中越过一个描述符。 */
  descriptorSeen: boolean
  /** 最近一个已关闭的描述符后轮次是否正常完成；当有轮次开启时或在一个轮次关闭之前则不存在。 */
  lastTurnCompleted?: boolean | undefined
}

const activeIntervalSchema = z.object({
  since: z.number().int().nonnegative(),
  through: z.number().int().nonnegative(),
}).strict()

const projectionSchema: z.ZodType<SubagentTimingProjection> = z.object({
  settledMs: z.number().int().nonnegative(),
  active: activeIntervalSchema.optional(),
  lastTurnCompleted: z.boolean().optional(),
}).strict().transform(({ settledMs, active, lastTurnCompleted }) => ({
  settledMs,
  ...active === undefined ? {} : { active },
  ...lastTurnCompleted === undefined ? {} : { lastTurnCompleted },
}))

const timingStateSchema: z.ZodType<TimingState> = z.object({
  settledMs: z.number().int().nonnegative(),
  active: activeIntervalSchema.optional(),
  pendingTurnStart: z.number().int().nonnegative().optional(),
  descriptorSeen: z.boolean(),
  lastTurnCompleted: z.boolean().optional(),
}).strict()

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    subagentTiming: TimingState
    subagent: IdentityState
  }
}

/**
 * 围绕子代理自身的持久化描述符折叠轮次边界。
 *
 * fork seed 可能包含一个祖先描述符与已完成的轮次。因此每个描述符都会
 * 重置累计状态；健康的目录只接纳在其自有后缀中恰好有一个描述符的子代理，
 * 使得最后一次重置成为子代理权威的计时原点。
 */
export const subagentTimingProjectionDefinition = {
  key: 'subagentTiming',
  stateSchema: timingStateSchema,
  init: () => ({ descriptorSeen: false, settledMs: 0 }),
  apply: (state, event) => {
    if (event.type === 'turn/start') {
      const { lastTurnCompleted: _closed, ...openState } = state
      return state.descriptorSeen
        ? { ...openState, active: { since: event.time, through: event.time } }
        : { ...openState, pendingTurnStart: event.time }
    }
    if (event.type === 'subagent/descriptor') {
      const activeSince = state.active?.since ?? state.pendingTurnStart
      return {
        descriptorSeen: true,
        settledMs: 0,
        ...(activeSince === undefined
          ? {}
          : { active: { since: activeSince, through: event.time } }),
      }
    }
    if (event.type === 'turn/end') {
      if (!state.descriptorSeen) {
        if (state.pendingTurnStart === undefined) return state
        const { pendingTurnStart: _closed, ...next } = state
        return next
      }
      if (state.active === undefined) return state
      const { active, ...rest } = state
      return {
        ...rest,
        settledMs: state.settledMs + Math.max(0, event.time - active.since),
        lastTurnCompleted: event.data.reason.kind === 'completed',
      }
    }
    if (state.active === undefined) return state
    return { ...state, active: { ...state.active, through: event.time } }
  },
  wire: {
    viewSchema: projectionSchema,
    view: state => ({
      settledMs: state.settledMs,
      ...(state.active === undefined ? {} : { active: state.active }),
      ...(state.lastTurnCompleted === undefined ? {} : { lastTurnCompleted: state.lastTurnCompleted }),
    }),
  },
  stateVersion: 3,
} satisfies ProjectionDefinition<'subagentTiming', TimingState>

interface IdentityState {
  /** 来自最后一个有效描述符的身份；在此之前以及遇到无效描述符之后则不存在。 */
  identity?: SubagentIdentityProjection | undefined
}

// 该断言只桥接可选标签分支：Zod 的可选输出包含显式的 `undefined`，
// 而 exactOptionalPropertyTypes 把它从公开接口中排除。无值状态本身是
// 可序列化的 `null` 分支 —— 从不是 `undefined` —— 因此每次注册表读取与
// 推送帧都能无损地挺过 JSON.stringify。
const identityValueSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('one-shot'),
    label: z.string().optional(),
    seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(SessionSeq),
  }).strict(),
  z.object({
    mode: z.literal('continuable'),
    label: z.string(),
    seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(SessionSeq),
  }).strict(),
]) as unknown as z.ZodType<SubagentIdentityProjection>

const identitySchema = identityValueSchema.nullable()

const identityStateSchema: z.ZodType<IdentityState> = z.object({
  identity: identityValueSchema.optional(),
}).strict()

/** 解释一个 `subagent/descriptor` 事件的身份；当载荷不可信时无值。 */
function descriptorIdentity(event: SessionEvent): SubagentIdentityProjection | undefined {
  let descriptor: SubagentDescriptorData | undefined
  try {
    descriptor = foldSubagentDescriptor([event])
  } catch {
    // 只有畸形且当前版本的载荷会在描述符解析中抛出；
    // 投影折叠绝不抛出，因此损坏折叠为无值。
    descriptor = undefined
  }
  if (descriptor === undefined) return undefined
  return descriptor.mode === 'one-shot'
    ? {
      mode: 'one-shot',
      ...descriptor.label !== undefined ? { label: descriptor.label } : {},
      seq: event.seq,
    }
    : { mode: 'continuable', label: descriptor.label, seq: event.seq }
}

/**
 * 从 `subagent/descriptor` 事件折叠持久化的模式/标签身份，后到者胜出：
 * fork seed 可能重放祖先的描述符，而子代理自身的描述符必须覆盖它 ——
 * 与 {@link subagentTimingProjectionDefinition} 相同的重置纪律。畸形或版本
 * 未知的载荷重置为 `null` 哨兵而不抛出，因此一个健康祖先的 fork 永远不会
 * 继承其自身描述符未能建立的身份 —— 且该重置能挺过每一个 JSON 推送帧，
 * 使持有早先身份的消费者替换它而非保留陈旧值；
 * `null` ⟺ 没有有效描述符，其原因有意不作区分。
 */
export const subagentIdentityProjectionDefinition = {
  key: 'subagent',
  stateSchema: identityStateSchema,
  init: () => ({}),
  apply: (state, event) => {
    if (event.type !== 'subagent/descriptor') return state
    const identity = descriptorIdentity(event)
    return identity === undefined ? {} : { identity }
  },
  wire: { viewSchema: identitySchema, view: state => state.identity ?? null },
  // 当身份获得其 `seq` 字段时提升：较旧的检查点行会重放到一个被模式拒绝的
  // 值，因此它必须重新折叠。
  stateVersion: 2,
} satisfies ProjectionDefinition<'subagent', IdentityState>
