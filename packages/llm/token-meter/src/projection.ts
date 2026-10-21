/**
 * 纯客户端安全的令牌投影词汇。
 *
 * @module @deepseek-ai/dsh-token-meter/projection
 */

/**
 * 一份完整会话日志的持久化累计提供方用量。
 *
 * 这四个分桶是互不相交的。特别是推理令牌已经包含在 `outputTokens` 中，
 * 不会被再次累计。
 */
export interface TokenUsageProjection {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/**
 * 供状态展示使用的近似上下文占用量。
 *
 * 这些字段在存在时，刻意不是一次原子性的请求观测：每一个都是
 * 不同时刻的最后写入者记录。因此切换模型可能会把新的容量与此前路由的
 * 压力配对，直到下一次请求报告用量。这是一次有意的取舍——
 * 该值是面向用户的参考，而非计费或门禁输入。完整理由见 token-meter 的 README。
 */
export interface ContextPressureProjection {
  /**
   * 提供方报告的最近一次请求的提示规模：未缓存输入加上缓存读取与写入。
   * 响应的输出被排除在外，因此它不会随当前轮次的流式输出而增长。
   * 在提供方报告用量之前缺失。
   */
  pressureTokens?: number
  /**
   * 下一次请求的提示将会消耗的量：{@link pressureTokens} 加上自该次采样以来
   * 表面新增或丢失内容的启发式重新计价。只有增量是被估计的，因此该数值既
   * 锚定在提供方上，又能在一次压缩遮蔽某个区间的瞬间做出反应——
   * 而这恰恰是 `pressureTokens` 单独做不到的，因为压缩本身不报告任何用量。
   * 在提供方报告用量之前缺失。
   */
  projectedTokens?: number
  /** 最新记录的路由容量；当没有适配器宣告容量时缺失。 */
  contextWindow?: number
}

/**
 * 下一次请求上下文的启发式构成：它由什么组成，而非它花费多少。
 * 这三个数值都使用计量器的固定密度估计，因此它们不会加总为
 * 以提供方为锚的 `projectedTokens`：该估计器系统性地低估 CJK 文本与
 * JSON schema，而这正是 {@link ContextPressureProjection.projectedTokens}
 * 中的锚定要挡在占用量之外的误差。请把它们作为构成的近似值呈现，
 * 绝不要当作一个总量。
 */
export interface ContextBreakdownProjection {
  /** 表面顺序上最后一个非空且仍然存活的系统提示的启发式令牌数；不存在时为 0。 */
  systemTokens: number
  /** 最新请求信封中工具 schema 的启发式令牌数；在任何请求之前为 0。 */
  toolsTokens: number
  /** 其余每个可见表面节点的启发式令牌数，包括已被取代的系统提示。 */
  messageTokens: number
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** 跨完整持久化日志累计的、由提供方报告的用量。 */
    tokenUsage: TokenUsageProjection
    /** 最新请求压力，与最新的已知路由容量配对。 */
    contextPressure: ContextPressureProjection
    /** 下一次请求的系统/工具/消息构成的启发式分解。 */
    contextBreakdown: ContextBreakdownProjection
  }
}
