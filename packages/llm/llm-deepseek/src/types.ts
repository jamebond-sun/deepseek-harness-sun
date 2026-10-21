/** DeepSeek Messages 的模型目录与请求级依赖。 */
import type { LlmModelInfo, ModelModality, SystemPromptUpdate, ToolUpdate, ResolvedRetryPolicy, ImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import type { DeepSeekLlmApiExtensionRequest, PreparedDeepSeekLlmApiExtensions } from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import type { DeepSeekFileStore, DeepSeekFilePolicy } from './file-store.ts'

/** 直接 fetch 适配器宣告的一个可选模型条目。 */
export interface DeepSeekCatalogModel {
  /** 已配置端点可接受的线格式模型 id。 */
  id: string
  /** 选择器标签；默认为 {@link id}。 */
  name?: string
  /** 供具有相似模型变体的部署使用的可选选择器细节。 */
  description?: string
  /** 已知的请求与响应合计上下文容量；当部署元数据不可用时省略。 */
  contextWindow?: number
  /** 该模型的按请求输出上限；省略时回退到 profile 的 {@link DeepSeekConnectionOptions.maxTokens}。 */
  maxTokens?: number
  /** 可接受的请求模态；省略表示仅文本。 */
  inputModalities?: ModelModality[]
  /**
   * 用于替换已公开令牌网格投影、供一次确定性请求预览使用的总像素预算，
   * 或 512×512 的 `low` 预设；省略时投影到令牌网格上。
   */
  imagePixelBudget?: number | 'low'
  /** 一次确定性请求预览的编码字节目标；当没有质量档位可用时使用最小的质量阶梯输出。 */
  imageMaxBytes?: number
  /**
   * `'in-history'` 宣告该端点会把对话中任意位置最新的 `system`
   * 消息当作完整生效的系统提示；省略表示只读取开头的系统消息。
   */
  systemPromptUpdate?: SystemPromptUpdate
  /**
   * `'addition-only'` 宣告该端点会通过较晚出现的 `tool_addition` 块启用一个
   * `defer_loading` 工具；`'in-history'` 还会按对话顺序读取移除通知。
   * 省略表示每次请求都宣告完整的工具列表。
   */
  toolUpdate?: ToolUpdate
}

/**
 * 一次操作所使用的、已校验的连接事实。插件的
 * `resolveAdapterOptions` 是产出这一形状的唯一显式解析步骤；
 * 适配器信任它并在每次操作时重新读取它，这正是配置变更无需重新注册
 * 就能作用于下一次请求的原因。
 */
export interface DeepSeekConnectionOptions {
  /** Messages API 根路径；自定义路径保持不变。 */
  baseURL: string
  /** 施加到每次调用上的请求默认值（thinking 模式、强度）。 */
  defaults: RequestDefaults
  /** 默认的按请求输出上限；显式的请求值优先。 */
  maxTokens: number
  /** 当选中的模型没有精确值时使用的正上下文容量。 */
  defaultContextWindow: number
  /** 暴露给发现消费者的参考模型；请求本身不受限制。 */
  models: readonly DeepSeekCatalogModel[]
  /** 一次流式读取处于未完成状态时提供方的最大空闲时间。 */
  streamIdleTimeoutMs: number
  /** 一次请求中文件引用的图像字节累计上限。 */
  maxRequestFilesBytes: number
  /** Files API 回退之后 base64 图像载荷的累计上限。 */
  maxInlineRequestImageBytes: number
  /** 一次请求中被表示出来的图像的最大数量。 */
  maxImagesPerRequest: number
  /** 超出文件引用上限之后的原始字节移除步长。 */
  imageOffloadByteQuantum: number
  /** 超出内联回退上限之后的 base64 字节移除步长。 */
  inlineImageOffloadByteQuantum: number
  /** 超出数量上限之后的图像数量移除步长。 */
  imageOffloadCountQuantum: number
  /** 一张请求图像通过 Files API 解析的最长时间。 */
  filesApiTimeoutMs: number
  /** 上传过期、刷新与配额恢复策略。 */
  filePolicy: DeepSeekFilePolicy
  /** 由提供方持有、且已解析完成的模型请求重试策略。 */
  retryPolicy: ResolvedRetryPolicy
}

/** 由提供方为一次请求及其文件操作所捕获的认证信息。 */
export interface DeepSeekRequestAuth {
  /** 原样发送到已解析端点的凭据头。 */
  headers: Readonly<Record<string, string>>
  /** 使用所捕获的凭据对一次失败分类；回调失败会保留原始错误。 */
  onRequestError?: (error: unknown) => Promise<unknown>
}

/** {@link DeepSeekAdapter} 的构造选项：由插件持有的、操作级的解析钩子。 */
export interface DeepSeekAdapterOptions<Connection extends DeepSeekConnectionOptions = DeepSeekConnectionOptions> {
  /** 报告不可用的原生 Messages 回放元数据，且不暴露内容或签名。 */
  onReplayDegrade?: (detail: { provider: string; model: string; reason: string }) => void
  /** 报告因合并后的请求无法序列化而从一次请求中省略的扩展字段。 */
  onExtensionsOmitted?: (detail: { provider: string; model: string; fields: readonly string[]; error: unknown }) => void
  /** 在 HTTP 2xx 之后报告一次扩展接受失败；请求会继续。 */
  onExtensionsUnaccepted?: (detail: { provider: string; model: string; error: unknown }) => void
  /** 供选择器使用的提供方标签；省略时使用协议族名称。 */
  providerName?: string
  /** 由提供方持有的目录可用性；省略时不暴露任何发现条目。 */
  discoverModels?: (provider: string) => Promise<LlmModelInfo[]>
  /** 当前的已校验连接事实；每次操作调用一次。 */
  options: () => Connection
  /**
   * 为一次精确模型查询或已准备的调用解析连接，
   * 例如在一次由提供方持有的目录加载之后；必须在 `signal` 中止后迅速落定。
   * 省略时使用 {@link options}。
   */
  connect?: (signal?: AbortSignal) => Promise<Connection>
  /** 在任何网络 I/O 之前通过抛出 `LlmError` 拒绝某个模型；省略时接受所有模型。 */
  admit?: (connection: Connection, model: string) => void
  /** 从本次请求的连接快照解析认证信息；绝不重新读取端点。 */
  resolveAuth: (connection: Connection) => Promise<DeepSeekRequestAuth>
  /** 解析与遥测及反馈共享的、harness 主目录匿名 id。 */
  resolveUserId: () => AnonymousUserId
  /** 解析当前的持久化附件服务；缺失时拒绝图像输入。 */
  resolveAttachments?: () => AttachmentStore | undefined
  /** 把一个附件引用桥接到当前的模型工具执行世界。 */
  resolveImageAccess?: (attachments: AttachmentStore, ref: ImageAttachmentRef) => ImageAttachmentAccess | undefined
  /** 解析进程范围内共享的上传复用存储。 */
  resolveFiles?: () => DeepSeekFileStore
  /** 为一次精确的线格式请求准备官方 API 中由插件贡献的顶层字段。 */
  prepareExtensions: (request: DeepSeekLlmApiExtensionRequest) => Promise<PreparedDeepSeekLlmApiExtensions>
}


/** 适配器级的请求默认值（来自插件配置）。 */
export interface RequestDefaults {
  thinking?: 'enabled' | 'disabled' | undefined
  reasoningEffort?: 'off' | 'low' | 'high' | 'max' | undefined
}
