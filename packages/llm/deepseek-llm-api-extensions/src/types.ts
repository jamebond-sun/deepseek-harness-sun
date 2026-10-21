/** DeepSeek 请求扩展的提供方 JSON 类型与贡献类型。 */

/** DeepSeek 请求体可接受的无损 JSON 值。 */
export type DeepSeekLlmApiJson =
  | null
  | boolean
  | number
  | string
  | DeepSeekLlmApiJson[]
  | { [key: string]: DeepSeekLlmApiJson }

/**
 * DeepSeek 顶层请求扩展字段的可合并扩展表。
 * 贡献方包通过声明合并持有自己拥有的字段。
 */
export interface DeepSeekLlmApiExtensionMap {}

/** 扩展提供方可见的、精确的序列化请求事实。 */
export interface DeepSeekLlmApiExtensionRequest {
  /** 合并扩展字段之前的基础 DeepSeek 请求体。 */
  readonly body: Readonly<Record<string, DeepSeekLlmApiJson>>
  /** 模型请求携带的会话标识，若存在。 */
  readonly sessionId?: string
  /** 辅助的请求分类，若存在。 */
  readonly purpose?: 'compaction' | 'session-title'
  /** 请求准备的取消信号；提供方必须在 abort 之后立即停止。 */
  readonly signal: AbortSignal
}

/** 一个已准备的字段值，以及它可选的 2xx 之后提交动作。 */
export interface PreparedDeepSeekLlmApiExtension<T extends DeepSeekLlmApiJson> {
  /** 合并到提供方已注册字段下的、已分离的值。 */
  readonly value: T
  /** 依赖于提供方确认接受的提交状态。 */
  accept?(): void | Promise<void>
}

/** 注册在 {@link DeepSeekLlmApiExtensionMap} 某个键之下的提供方。 */
export interface DeepSeekLlmApiExtensionProvider<T extends DeepSeekLlmApiJson> {
  /**
   * 为一次精确的序列化请求准备一个字段。
   * @param request - 不可变的基础请求事实。
   * @returns 已准备的字段；当本次请求没有该字段的值时为 `undefined`。
   */
  prepare(
    request: DeepSeekLlmApiExtensionRequest,
  ): PreparedDeepSeekLlmApiExtension<T> | undefined | Promise<PreparedDeepSeekLlmApiExtension<T> | undefined>
}

/** 为一次请求准备的全部字段，以及它们的联合接受事务。 */
export interface PreparedDeepSeekLlmApiExtensions {
  /** 要合并进基础请求的、已分离的顶层字段。 */
  readonly fields: Readonly<Partial<DeepSeekLlmApiExtensionMap>>
  /**
   * 在 HTTP 2xx 之后提交所有已捕获的提供方。重复调用会加入同一次落定。
   * @returns 所有提交都成功之后的兑现。
   */
  accept(): Promise<void>
}
