/**
 * session-stats 领域的纯类型：即 `sessionStats` 投影键声明的唯一出处，
 * 不含本包主机侧的值导入（cordis 上下文、zod、llm 分块谓词）。两个命名空间
 * 投影服务于它——主机消费方用 `./types`，客户端聚合用 `./client`——
 * 且零内容重复。
 *
 * @module @deepseek-ai/dsh-session-stats/types
 */

// 把本文件标记为一个模块，以便下面的声明是扩充投影表，而非声明一个
// 环境模块。
export {}

/**
 * 整日志的会话数字，与客户端已分页进多少历史无关。计数与墙钟时间都从
 * 完整的持久日志折叠而来；在各自首个贡献事件落地之前，每个字段都是 0。
 * 字段名与客户端窗口折叠镜像对应，因此没有本单元时也能整体回退到它。
 */
export interface SessionStatsProjection {
  /** 至少携带一个已关闭步骤（`step/end`）的不同回合；被拒绝或空的回合不计入。 */
  turns: number
  /** 已关闭的步骤（`step/end` 事件）——已完成、失败与已取消的步骤都算。 */
  steps: number
  /** 在组装了消息的步骤上，模型墙钟时间（`step/start` → `assistant/message`）的合计。 */
  llmMs: number
  /** 在按 callId 匹配的 `tool/call` → `tool/result` 对上的工具墙钟时间合计。 */
  toolMs: number
  /** 在 `ttftSteps` 上、首 token 延迟（`step/start` → 第一个非空 delta 分块）的合计。 */
  ttftMs: number
  /** 携带了被记录的首 token 的步骤数。 */
  ttftSteps: number
  /** 在那些也上报了输出 token 的步骤上，解码墙钟时间（首 token → `assistant/message`）的合计。 */
  decodeMs: number
  /** 在同一批解码计时步骤上、提供方输出 token 的合计。 */
  decodeTokens: number
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Whole-log turn/step counts and wall times; see {@link SessionStatsProjection}. */
    sessionStats: SessionStatsProjection
  }
}
