/**
 * turn-outline 领域的纯类型：即 `turnOutline` 投影键声明的唯一出处，不含
 * 本包主机侧的值导入（zod、投影定义）。主机消费方导入 `./types`；客户端
 * 聚合导入 `./client`，后者重新导出本模块。
 *
 * @module @deepseek-ai/dsh-session-turn-outline/types
 */

import type { SessionSeq } from '@deepseek-ai/dsh-session/types'

export {}

/** 一个已启动回合的大纲事实，与客户端已分页进多少无关。 */
export interface TurnOutlineEntry {
  /** 主机分配的回合号（即 `turn/start` 的载荷）。 */
  readonly turn: number
  /** 该回合的 `turn/start` 事件 seq——把一个窗口分页回退穿过这个 seq 即可加载整个回合。 */
  readonly seq: SessionSeq
  /** 有界的首条人类提示预览（一行 rail-card）；在一条合格提示落地之前为 `''`。 */
  readonly prompt: string
  /** 有界的最终响应预览（至多三行 rail-card）；在该回合以 assistant 文本结束之前为 `''`。 */
  readonly response: string
}

/**
 * 折叠状态：被服务的条目，加上打开回合的响应草稿。草稿缓冲最新一条含文本
 * 的 assistant 消息，直到 `turn/end` 提交它；wire 视图只投影 `turns`——
 * 仅草稿的 apply 保留该数组的身份，因此变更流在回合边界之间保持安静。
 */
export interface TurnOutlineState {
  /** 按回合升序排列的、已启动的回合。 */
  readonly turns: readonly TurnOutlineEntry[]
  /** 打开回合最新的、含文本的 assistant 预览；不在该状态时为空字符串。 */
  readonly draft: string
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Whole-log turn outline fold state (entries plus the open turn's response draft). */
    turnOutline: TurnOutlineState
  }
  interface SessionProjectionMap {
    /** Every started turn with its `turn/start` seq and bounded previews, strictly increasing by turn; see {@link TurnOutlineEntry}. */
    turnOutline: readonly TurnOutlineEntry[]
  }
}
