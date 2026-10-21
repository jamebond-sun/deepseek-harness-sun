/**
 * goal 领域的纯类型：`goal` 投影键声明的唯一归属，以及它承载的持久化载荷
 * 词汇，不含本包的宿主侧导入（cordis 事件、dsh-agent、dsh-llm、服务本身）。
 * 两个命名空间投影为它服务——`./types` 面向宿主消费者，`./client`（浏览器
 * 半入口的再导出）面向客户端聚合——内容零重复。与宿主耦合的领域词汇（消息
 * 来源、事件、折叠形状）位于 ./domain.ts。
 *
 * @module @deepseek-ai/dsh-goal/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** 跨持久化修订标识同一个目标。 */
export type GoalId = Branded<'GoalId'>

/** 一个精确目标修订的比较并设置（CAS）标识。 */
export interface GoalRef {
  /** 稳定的目标标识。 */
  readonly id: GoalId
  /** 正修订号；每次持久化变更都会递增。 */
  readonly revision: number
}

/** 创建输入；省略轮次上限时由服务配置解析。 */
export interface CreateGoalRequest {
  readonly objective: string
  readonly maxGoalRounds?: number
}

/** 对一个已创建目标的可安全传输确认。 */
export interface CreateGoalResult {
  readonly ref: GoalRef
}

/** 一次编辑所变更的字段；至少须提供一个。 */
export interface EditGoalRequest {
  readonly objective?: string
  readonly maxGoalRounds?: number
}

/** 持久化续跑阶段。激活状态是进程本地的，与此独立。 */
export type GoalPhase =
  | 'active'
  | 'paused'
  | 'blocked'
  | 'complete'

/** 目标被阻塞时可供程序路由、也可供人阅读的说明。 */
export interface GoalBlockReason {
  /** 由阻塞策略选定的稳定小写短横线（lower-kebab-case）分类码。 */
  readonly code: string
  /** 展示给人与模型的非空说明。 */
  readonly message: string
}

/** 每次非 clear 的目标变更写入的完整持久状态。 */
export interface GoalSnapshot extends GoalRef {
  /** 人类请求的完成目标。 */
  readonly objective: string
  /** 持久化生命周期阶段。 */
  readonly phase: GoalPhase
  /** 仅当 `phase` 为 `blocked` 时存在。 */
  readonly blockedReason?: GoalBlockReason
  /** 已准入的 goal 轮次总上限。 */
  readonly maxGoalRounds: number
}

/** 本进程是否可自动续跑一个 active 目标。 */
export type GoalActivation = 'armed' | 'disarmed'

/** 转发给 UI 客户端的进程本地激活状态更新。 */
export interface GoalActivationChanged {
  /** 激活状态发生变化的会话。 */
  readonly sessionId: SessionId
  /** 当前精确的激活状态；没有当前目标时缺省。 */
  readonly goal?: {
    /** 当前目标的精确标识。 */
    readonly id: GoalId
    /** 当前目标的精确修订号。 */
    readonly revision: number
    /** 当前进程本地的续跑状态。 */
    readonly activation: GoalActivation
  }
}

/** 当前目标视图，包含从会话日志派生出的值。 */
export interface GoalView extends GoalSnapshot {
  /** 该目标已准入的最高轮次号。 */
  readonly roundsStarted: number
  /** create 变更的纪元毫秒时间。 */
  readonly createdAt: number
  /** 最近一次变更的纪元毫秒时间。 */
  readonly updatedAt: number
  /** 进程本地的续跑资格；从不持久化。 */
  readonly activation: GoalActivation
}

/**
 * `goal` 投影值：附带重放计数（含已准入的 goal 轮次）的当前持久目标。
 * 激活状态是进程本地的（从不持久化）并刻意缺席——投影只反映持久化阶段。
 */
export interface GoalProjection {
  /** 当前持久目标快照（变更所用的 CAS ref 依附其上）。 */
  readonly goal: GoalSnapshot
  /** 该目标已准入的最高轮次号。 */
  readonly roundsStarted: number
  /** create 变更的纪元毫秒时间。 */
  readonly createdAt: number
  /** 最近一次变更的纪元毫秒时间。 */
  readonly updatedAt: number
}

/** 用于派生当前目标客户端值的严格检查点状态。 */
export interface GoalProjectionState {
  /** 最近有效的当前目标；创建前与 clear 后为 null。 */
  readonly current: GoalProjection | null
  /** 本会话中已创建过的目标标识，保留用于拒绝重复使用。 */
  readonly seenGoalIds: GoalId[]
  /** 首次严格重放失败；持久化事件流有效时为 null。 */
  readonly failure: string | null
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    goal: GoalProjectionState
  }
  interface SessionProjectionMap {
    /**
     * 会话的当前目标与已准入轮次计数；首次 create 之前和 clear 墓碑之后为
     * `null`。`goal/change` 提供完整的生命周期值；匹配的已准入
     * `user/message` 事件推进 `roundsStarted`。
     */
    goal: GoalProjection | null
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * 某个会话的进程本地目标激活状态发生变化。
     * @mode emit
     * @param payload - 会话 id 与当前目标的精确激活状态；clear 之后没有目标。
     */
    'goal/activation-changed'(payload: GoalActivationChanged): void
  }
}
