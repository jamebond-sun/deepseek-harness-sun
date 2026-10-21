/**
 * 回放令牌计量的公开配置与度量词汇。
 *
 * @module @deepseek-ai/dsh-token-meter/types
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session/types'

export type { ContextBreakdownProjection, ContextPressureProjection, TokenUsageProjection } from './projection.ts'

/** token-meter 插件配置；这个固定的估计器没有任何设置项。 */
export type TokenMeterConfig = Record<string, never>

/** 带符号的表面增量据以产生当前压力的基线。 */
export type TokenMeasurementBaseline =
  | { readonly kind: 'none'; readonly tokens: 0 }
  | { readonly kind: 'estimated'; readonly tokens: number }
  | { readonly kind: 'usage'; readonly tokens: number; readonly usage: Readonly<TokenUsage> }

/** 在某个已消费日志版本上的、已分离的不可变请求压力与表面快照。 */
export interface TokenMeasurement {
  /** 已消费的持久化事件数量；等于下一个未读事件的 seq。 */
  readonly logRevision: SessionLogOffset
  /** 本次度量所使用的提供方或启发式锚点。 */
  readonly baseline: TokenMeasurementBaseline
  /** 当前表面内容相对基线锚点的带符号重新计价。 */
  readonly surfaceDeltaTokens: number
  /** 非负的当前请求与响应压力。 */
  readonly totalTokens: number
  /** 当前表面上按路由定价的请求令牌总计；等于各节点价格之和。 */
  readonly surfaceTokens: number
  /** 按从头到尾的位置顺序排列的当前表面节点。 */
  readonly nodes: readonly TokenSurfaceNode[]
}

/** 当前有序会话表面中的一个已计价令牌节点。 */
export interface TokenSurfaceNode {
  /** 该表面事件的持久化序号。 */
  readonly seq: SessionSeq
  /**
   * 在所度量路由之下，本节点所投影的那条精确消息的请求压力令牌数：
   * 当被路由的适配器宣告了视觉价格时，图像出现携带该路由宣告的视觉价格，
   * 否则使用固定的启发式。触发、保留与区间选择都读取这个价格。
   */
  readonly tokens: number
  /**
   * 同一条消息的固定启发式令牌数，与任何路由无关。
   * 影子价格协议用这个值给替换项定价，从而使 O(1) 的投影折叠
   * 与它自己的追加保持一致。
   */
  readonly heuristicTokens: number
}
