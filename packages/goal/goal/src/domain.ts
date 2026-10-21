/**
 * goal 领域的宿主侧词汇：实时视图、持久化变更载荷、消息归属、重放折叠，
 * 以及带作用域的 `goal/changed` 事件。与 ./types.ts（纯净的客户端安全出口）
 * 分开维护，因为这些声明会把 dsh-agent、dsh-llm 和 cordis 拉入编译程序——
 * 每侧单程序的布局不允许客户端聚合中出现它们。
 * @module @deepseek-ai/dsh-goal
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GoalId, GoalRef, GoalSnapshot, GoalView } from './types.ts'

/** 记录在持久化源变更中的目标状态变更动词。 */
export type GoalOperation =
  | 'create'
  | 'edit'
  | 'pause'
  | 'resume'
  | 'complete'
  | 'block'
  | 'clear'

/** 由持久化 `goal/change` 事件提交的全量快照式目标变更。 */
export interface GoalSnapshotChangeMeta {
  readonly kind: 'goal/change'
  readonly version: 1
  readonly operation: Exclude<GoalOperation, 'clear'>
  readonly goal: GoalSnapshot
  readonly roundsStarted: number
  readonly createdAt: number
  readonly updatedAt: number
}

/** 清除当前目标时保留的墓碑。 */
export interface GoalClearChangeMeta {
  readonly kind: 'goal/change'
  readonly version: 1
  readonly operation: 'clear'
  readonly cleared: GoalRef
  readonly clearedAt: number
}

/** goal 领域自有会话事件承载的持久化变更联合类型。 */
export type GoalChangeMeta = GoalSnapshotChangeMeta | GoalClearChangeMeta

/** 已准入续跑轮次所用的消息归属。 */
export interface GoalMessageSource {
  readonly kind: 'goal'
  readonly goalId: GoalId
  readonly revision: number
  /** 正的已准入续跑轮次号。 */
  readonly round: number
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    goal: GoalMessageSource
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * 变更提交后的完整目标状态，或清除墓碑。
     */
    'goal/change': GoalChangeMeta
  }
}

/** 持久化目标事实的纯重放折叠。 */
export interface FoldedGoal {
  /** 当前目标；clear 之后或首次 create 之前缺省。 */
  readonly goal?: GoalSnapshot
  /** 当前目标已准入的最高轮次。 */
  readonly roundsStarted: number
  /** 当前目标的创建时间；没有当前目标时缺省。 */
  readonly createdAt?: number
  /** 当前目标的变更时间；没有当前目标时缺省。 */
  readonly updatedAt?: number
  /** 最近一次变更的 ref，包含 clear 墓碑。 */
  readonly lastRef?: GoalRef
}

/** 一次持久化目标变更提交后的实时通知。 */
export interface GoalChanged {
  readonly operation: GoalOperation
  readonly ref: GoalRef
  /** clear 墓碑时缺省。 */
  readonly goal?: GoalView
}

/** 被拒绝的目标读取与变更所对应的稳定错误码。 */
export type GoalErrorCode =
  | 'GOAL_AGENT_NOT_LIVE'
  | 'GOAL_NOT_FOUND'
  | 'GOAL_ALREADY_EXISTS'
  | 'GOAL_STALE_REVISION'
  | 'GOAL_INVALID_OBJECTIVE'
  | 'GOAL_INVALID_MAX_ROUNDS'
  | 'GOAL_INVALID_BLOCK_REASON'
  | 'GOAL_INVALID_EDIT'
  | 'GOAL_INVALID_TRANSITION'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * 某个存活 Agent 接受的目标变更。对应的 `goal/change` 会话事件已提交。
     * 监听器失败会被隔离。
     * 作用域过滤分发（`@deepseek-ai/dsh-scope`）：按 agent 作用域注册的监听器只收到该 agent 的事件。
     * @param payload.agent - 其会话持有该目标的 agent。
     * @param payload.change - 最新的当前投影或 clear 墓碑。
     * @mode emit
     */
    'goal/changed'(this: import('@deepseek-ai/dsh-scope').Scoped<Agent>, payload: { agent: Agent; change: GoalChanged }): void
  }
}
