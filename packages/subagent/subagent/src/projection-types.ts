/**
 * 纯客户端安全的子代理投影词汇。
 *
 * @module @deepseek-ai/dsh-subagent/projection-types
 */

import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'

/** 从父事实具现出的一条当前直接子代理发现行。 */
export type SubagentCatalogEntry =
  & {
    readonly id: SessionId
    readonly createdAt: number
  }
  & (
    | { readonly mode: 'one-shot'; readonly label?: string }
    | { readonly mode: 'external'; readonly label?: string }
    | { readonly mode: 'continuable'; readonly label: string }
    | { readonly mode: 'unknown'; readonly label?: string }
  )

/** 一个由描述符支撑的子 session 的持久化活跃轮次计时。 */
export interface SubagentTimingProjection {
  /** 在子代理自身描述符之后的已完成轮次所累计的毫秒数。 */
  settledMs: number
  /** 当前开启轮次的同一切分边界，当某个轮次尚未到达 `turn/end` 时存在。 */
  active?: {
    /** 已开启轮次的开始时间。 */
    since: number
    /** 折叠进本投影切分的最新事件时间。 */
    through: number
  }
  /**
   * 子代理自身描述符之后最近一个已关闭轮次是否正常完成；
   * 当有轮次开启时或在一个轮次关闭之前则不存在。
   */
  lastTurnCompleted?: boolean
}

/**
 * 一个由描述符支撑的子代理 session 的持久化身份：生命周期模式加创建标签，
 * 从 `subagent/descriptor` 事件按后到者胜出折叠。标签强度遵循描述符模式：
 * 可续跑子代理总是带有一个，一次性子代理可以省略。
 */
export type SubagentIdentityProjection =
  | {
    /** 一个终止型一次性子代理。 */
    mode: 'one-shot'
    /** 来自子代理描述符的可选持久化创建标签。 */
    label?: string
    /**
     * 本身份所折叠自的 `subagent/descriptor` 事件的 seq。
     * `session.isOwnSeq(seq)` 证明该身份来自子代理自有的日志后缀 ——
     * 描述符一旦追加即不可变 —— 而非来自 fork seed 重放的祖先描述符。
     */
    seq: SessionSeq
  }
  | {
    /** 一个可恢复的对话。 */
    mode: 'continuable'
    /** 来自子代理描述符的持久化创建标签。 */
    label: string
    /** 被折叠的描述符事件的 seq；关于自有后缀的证明见一次性分支。 */
    seq: SessionSeq
  }

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** 按父目录事件顺序排列的直接子代理，排除 fork 继承来的 fact。 */
    subagentCatalog: SubagentCatalogEntry[]
    /** 由描述符支撑的子代理 session 的活跃轮次时长与最近已关闭轮次的完成情况。 */
    subagentTiming: SubagentTimingProjection
    /**
     * 由描述符支撑的子代理 session 的身份。`null` ⟺ 没有有效描述符
     * （缺失、畸形或版本无法识别 —— 有意不作区分）。该哨兵值有意可序列化：
     * 通过 JSON 传输推送的值必须无损地挺过 `JSON.stringify`，而 `undefined`
     * 字段会被丢弃，接收端会保留一个陈旧身份。条目本身保持非可选。
     */
    subagent: SubagentIdentityProjection | null
  }
}
