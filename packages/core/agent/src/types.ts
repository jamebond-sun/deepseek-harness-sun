/**
 * 与仅类型消费方共享的持久 agent session 事件词汇表。
 *
 * @module @deepseek-ai/dsh-agent/types
 */

import type { UserMessage } from '@deepseek-ai/dsh-llm/types'
// 仅类型导入：本注册表将 `turn` 合并进 Workspace 注册表的 archive-admission 家族映射。
import type {} from '@deepseek-ai/dsh-workspace/types'
import type { OptionalSessionSeq, SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { TypertContext, TypertLookup } from '@deepseek-ai/dsh-typert-protocol'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** 公开的活跃 agent 句柄；运行时侧在其上扩展活跃能力。 */
export interface Agent {
  /** 以 session 为后端的 Agent 身份。 */
  readonly id: SessionId
}

declare module '@deepseek-ai/dsh-workspace/types' {
  interface SessionActivityKindMap {
    /** session 自身的 Agent 正处于一个 turn 中，包括正在等待审批或答复的 turn。 */
    turn: true
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertLookupMap {
    agent: TypertLookup<Agent, SessionId>
  }

  interface TypertContextMap {
    /** Host 与 Client 适配器共享的 Agent 上下文身份。 */
    agent: TypertContext<SessionId>
  }
}

/** agent 拥有的两个有序待处理消息列表之一。 */
export type InboxTarget = 'next-turn' | 'next-step'

/** 由持久 splice 重建的完整待处理 Inbox 值。 */
export interface InboxState {
  readonly 'next-turn': readonly UserMessage[]
  readonly 'next-step': readonly UserMessage[]
}

/**
 * 线路 JSON 形式的待处理 Inbox 值。每条消息都能无损地在 session 日志中往返，
 * 但 fold 状态的完整 `UserMessage` 类型无法跨越 typert Remote 边界（其来源
 * 联合类型携带一个 `unknown` 回放字段），因此类型化投影表保留这种 JSON 安全形式。
 */
export interface InboxWireState {
  readonly 'next-turn': readonly JsonValue[]
  readonly 'next-step': readonly JsonValue[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** 由持久 inbox splice 重建的待处理 agent 输入。 */
    inbox: InboxState
  }
  interface SessionProjectionMap {
    /** 由持久 inbox splice 重建的待处理 agent 输入。 */
    inbox: InboxWireState
  }
}

/**
 * 从单个 agent session 日志 fold 出的 turn 与 step 边界。
 *
 * 读取方契约：该键由 `dsh-agent-loop` 注册，否则不存在。没有 agent-loop 就
 * 不会有 turn 事件，因此读取方把缺失的键视为“没有打开的 turn / 没有边界”
 * ——这是能力缺失，而非状态损坏。若某个读取方的行为对这种缺失没有安全的
 * 兜底（例如 step 开启决策），也可以选择显式报错。
 */
export interface TurnBoundaryProjection {
  /** 打开的 turn 的 `turn/start` 的 seq，turn 之间为 null。 */
  readonly openTurnStartSeq: OptionalSessionSeq
  /** 最新 `step/start` 事件的 seq，第一个 step 之前为 null。 */
  readonly lastStepStartSeq: OptionalSessionSeq
  /** 最新的 step 边界（`step/start` 或 `step/end`）及其 seq，第一个 step 边界之前为 null。 */
  readonly lastStepBoundary: { readonly kind: 'start' | 'end'; readonly seq: SessionSeq } | null
  /** 最新 `turn/start` 的 turn 编号；第一个 turn 之前为 0。 */
  readonly lastTurn: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * 对某个 agent 持久待处理消息列表的一次归一化变更。
     * session-projection 注册表会在 `Session.append()` 返回之前应用已提交的
     * 事件；Inbox 的活跃通知随后于该提交到达。
     */
    'agent/inbox/spliced': {
      target: InboxTarget
      start: number
      removedCount?: number
      inserted: UserMessage[]
      outcome?: 'canceled'
    }
  }
}
