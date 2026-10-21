/**
 * 供循环、会话日志与插件使用的、规范的且与提供方无关的消息与流式词汇。
 * 只有适配器负责转换提供方的线格式消息；映射式接口使内容、来源
 * 与结束原因的各个联合类型保持可扩展。
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { MessageId, ToolCallId, ProviderRequestId, ReasoningEffortId } from './brand.ts'
import type { Message, UserMessage } from './message.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * 提供方拓扑发生了变化：某个适配器注册或注销了路由，
     * 或者可配置提供方目录增减了条目。这个无载荷的注册表通知
     * 在每个提交点触发（包括注册被释放时）；消费者重新读取
     * `listProviders()`、`listModels()` 或 `listConfigurableProviders()`
     * 以获取新状态。观察者失败会被隔离，无法否决这次注册表变更。
     * @mode emit
     */
    'llm/adapters-updated'(): void
  }
}

export type {
  AssistantMessage,
  DeveloperMessage,
  AssistantProviderMetadata,
  Message,
  MessageSource,
  MessageSourceMap,
  ModelMessageSource,
  ToolMessageSource,
  ToolResultMessage,
  UserMessage,
} from './message.ts'

/** 可序列化的提供方或传输失败事实；由策略决定是否可重试。 */
export interface LlmFailure {
  /** 面向人类的提供方或传输失败信息。 */
  readonly message: string
  /** 稳定的、与提供方无关的机器路由错误码。 */
  readonly code: string
  /** 提供方返回的 HTTP 状态码，若可得。 */
  readonly status?: number
  /** 提供方要求的延迟，以毫秒计，当有效且可得时。 */
  readonly providerRetryAfterMs?: number
  /** 供诊断使用的、不透明的、由提供方签发的请求标识。 */
  readonly requestId?: ProviderRequestId
  /**
   * 配合错误码 `IMAGE_OFFLOAD_REQUIRED`：在该路由精确的字节核算之下，
   * 同一次请求要放得下，还需要额外卸载多少个最早的被保留图像出现。
   * `dsh-compaction-image-offload` 会在一个 `image/offload` 事件中
   * 记录被选中的出现，并重试该步骤。
   */
  readonly offloadImages?: number
}

/** 对最终用户可见的纯文本。 */
export interface TextBlock {
  type: 'text'
  text: string
}

/** 推理/思考内容，区别于可见文本。 */
export interface ReasoningBlock {
  type: 'reasoning'
  text: string
}

/**
 * 一个持久化的光栅图像引用，在用户或助手内容中都有效。
 * 该块刻意是角色中立的；助手侧的渲染属于前向兼容性——
 * 当前的生产适配器只声明纯文本输出，因此只有用户消息可以携带图像。
 */
export interface ImageBlock {
  type: 'image'
  /** 由附件服务持有的、不可变的字节与内在展示元数据。 */
  attachment: ImageAttachmentRef
  /**
   * 派生自一次持久化的图像卸载决策，或由一次消息重写保留下来。
   * 每条路由都发送指名该图像及其可用只读路径的占位文本，而不是图像字节。
   */
  offloaded?: true
}

/**
 * 一个持久化的逐字文件引用，在用户内容中有效。文件永远不会原生地
 * 到达某个提供方：请求装配把每次出现都投影为确定性的句柄文本
 * （名称、字节大小与只读的保存路径），因此适配器与提供方在它原本的
 * 位置上看到的是文本，而持久化日志为呈现与授权保留结构化引用。
 */
export interface FileBlock {
  type: 'file'
  /** 由附件服务持有的、不可变的逐字字节与展示元数据。 */
  attachment: FileAttachmentRef
}

/** 一次由模型请求的工具调用。 */
export interface ToolCallBlock {
  type: 'tool-call'
  /** 由提供方签发的调用 id；与匹配的工具结果相关联。 */
  id: ToolCallId
  name: string
  /** 模型产出的原始 JSON 字符串。 */
  arguments: string
}

/** 从 developer 事件所引用的请求头中启用一个工具定义。 */
export interface ToolAdditionBlock {
  type: 'tool-addition'
  /** 所引用的历史请求头中恰好一个工具的名称。 */
  toolName: string
  /**
   * 为内联定义保留；schema 由历史请求头持有。
   * @persistenceReserved
   */
  tool?: never
}

/** 记录一次按其会话局部名称标识的工具的动态移除。 */
export interface ToolRemovalBlock {
  type: 'tool-removal'
  toolName: string
}

/**
 * 以 `type` 为键的、可合并扩展的内容块。新的核心块必须连同
 * 适配器、UI 与压缩支持一起落地。工具变更块属于 developer 消息；
 * 由 `projectToolUpdates` 选择每条路由收到什么。
 */
export interface ContentBlockMap {
  'text': TextBlock
  'reasoning': ReasoningBlock
  'image': ImageBlock
  'file': FileBlock
  'tool-call': ToolCallBlock
  'tool-addition': ToolAdditionBlock
  'tool-removal': ToolRemovalBlock
}

/** 块 `type` 标签的词汇表；随插件向 {@link ContentBlockMap} 添加条目而扩张。 */
export type ContentBlockType = keyof ContentBlockMap
/** 任意已知的内容块，由 {@link ContentBlockMap} 派生；按 `type` 分支，并对未知值放过（可合并扩展）。 */
export type ContentBlock = ContentBlockMap[ContentBlockType]

/**
 * 一次模型响应为何停止。
 * 可合并扩展，因此适配器可以暴露提供方特有的原因。
 */
export interface FinishReasonMap {
  'stop': { kind: 'stop' }
  'tool-calls': { kind: 'tool-calls' }
  'max-tokens': { kind: 'max-tokens' }
  'aborted': { kind: 'aborted'; failure: LlmFailure }
  'error': { kind: 'error'; failure: LlmFailure }
}

/** 任意已知的结束原因，由 {@link FinishReasonMap} 派生；按 `kind` 分支，并对未知值放过（可合并扩展）。 */
export type FinishReason = FinishReasonMap[keyof FinishReasonMap]

/**
 * 一次模型调用的令牌账目（缓存字段是可选的）。
 *
 * 各个计数是互不相交的：`inputTokens` 只是未缓存的输入；
 * 缓存输入分别报告为 `cacheReadTokens`/`cacheWriteTokens`
 * （计费输入 = 三者之和）。那些提供方把缓存命中折进一个提示总量的
 * 适配器（DeepSeek 的 `prompt_tokens`）会把它们减掉。
 */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  /**
   * 精确的完整调用总计，包含聚合的提示与输出令牌。
   *
   * 适配器会保留一个提供方总计，或从权威的聚合提示/输出计数器派生它；
   * 当它不可用或不一致时则省略。
   */
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/**
 * 在一条精确模型路由的请求投影之下，一次有序图像出现的请求价格。
 * 每次出现都解析成线路上实际承载的那一对：一张被保留图像的
 * 提供方视觉令牌，加上随之发送或取而代之的模型可见文本
 * （请求预览句柄、卸载占位符，或纯文本替换）。调用方用
 * 自己的文本估计器给 `text` 计价，因此提供方定价永远不会固定一种文本分词。
 */
export interface LlmImageRequestPrice {
  /** 被保留的请求图像的提供方视觉令牌；当只有文本表示这次出现时为 0。 */
  visualTokens: number
  /** 为这次出现发送的、模型可见的文本，由调用方的文本估计器计价。 */
  text: string
}

/**
 * 一条精确模型路由的提供方侧请求图像定价。由那些提供方会收取视觉
 * 令牌的适配器实现；消费者（token meter）按每次度量同步解析它，
 * 因此实现不得执行 I/O。
 */
export interface LlmImageRequestPricing {
  /**
   * 为一次请求投影中的每次图像出现计价。
   * @param images - 按请求顺序排列的表面图像块，每次出现一个条目；
   *   一个 `offloaded` 块按它的占位文本计价。
   * @returns 每次出现一个价格，按索引与 `images` 对齐。
   */
  priceImages(images: readonly ImageBlock[]): readonly LlmImageRequestPrice[]
}

/** 一条已注册提供方路由的展示元数据。 */
export interface LlmProviderInfo {
  /** 由 {@link GenerateOptions.provider} 使用的提供方路由键。 */
  id: string
  /** 供选择器与诊断使用的、人类可读的提供方名称。 */
  name: string
}

/** 可合并扩展的提供方模型模态词汇表。 */
export interface ModelModalityMap {
  text: 'text'
  image: 'image'
}

/** 任意已声明的提供方模型模态。 */
export type ModelModality = ModelModalityMap[keyof ModelModalityMap]

/**
 * 适配器插件可以通过配置激活的一条提供方路由，无论该路由当前是否已注册。
 * 各个配置界面把这个目录与 `listProviders()` 合并，从而在展示每个
 * 可配置提供方的同时给出它的活跃/休眠状态。
 */
export interface LlmConfigurableProvider {
  /** 本条目在被配置时所激活的提供方路由键。 */
  provider: string
  /** 供配置界面使用的、人类可读的提供方名称。 */
  displayName: string
  /** 其中某个小节配置本提供方的用户设置命名空间。 */
  settingsNs: string
  /**
   * 从该命名空间的那个小节根到本提供方 profile 对象的路径；
   * 当整个小节就是该 profile 时为空。
   */
  settingsPath: readonly string[]
  /**
   * 持有它的适配器是否仅仅因为配置声明才知道这条路由——
   * 即一个它对之一无所知的网关或自托管服务器。
   * 缺失意味着该适配器不做这种区分；false 意味着它做，而这条路由
   * 属于它自己的路由之一。只有适配器能回答：从外部看，
   * 一个用户新增的路由与一个被修正过的内置路由是一样的。
   */
  declared?: boolean
  /**
   * 当 profile 没有设置 `baseURL` 时适配器使用的路由端点；
   * 适配器仍然可能把某个单独模型发往该模型自己的端点。
   * 当该路由没有固定端点时缺失。
   */
  defaultBaseURL?: string
  /** 用于构造提供方端点的环境变量；当没有可报告的变量时缺失。 */
  baseURLEnv?: readonly string[]
  /** 当 profile 没有指名凭据引用时适配器所执行的认证；当它没有报告任何认证时缺失。 */
  nativeAuth?: LlmNativeAuth
  /** 供修复使用的配置诊断信息；未受影响的模型可能仍然可用。 */
  error?: string
}

/** 一条提供方路由在其 profile 中没有凭据引用时执行的认证。 */
export interface LlmNativeAuth {
  /** 该路由的认证所读取的环境变量，按查找顺序排列；当它不读取任何变量时为空。 */
  env: readonly string[]
  /** 一次已存储的 OAuth 登录是否能够认证该路由。 */
  oauth: boolean
}

/**
 * 对某个尚未被配置存储的提供方端点的一次探查。配置界面发送用户
 * 仍在编辑的草稿，因此该请求直接携带端点与凭据，而不是指名一条路由：
 * 一个正在被添加的提供方还没有可以指名的路由。
 */
export interface LlmModelDiscoveryRequest {
  /**
   * 草稿正在编辑的路由，当它编辑的是一条已存在的路由时。
   * 一个其适配器已经知道其模型的路由会用那份知识作答，而不是去询问端点——
   * 适配器自己的注册表是更好的答案，而且它不产生任何网络调用。
   */
  provider?: string
  /**
   * 要探查的端点。之所以可选，是因为一个适配器已经描述过的路由
   * 不需要端点；而一个它没有描述过的路由必须提供一个。
   */
  baseURL?: string
  /** 该端点所说的线格式协议，当草稿指名了一个时。 */
  api?: string
  /** 仅用于本次探查的凭据；harness 从不存储它。 */
  apiKey?: string
}

/** 附带操作级取消信号的提供方侧发现请求。 */
export interface LlmModelDiscoveryOperation extends LlmModelDiscoveryRequest {
  /** 调用方的取消信号；实现必须在它中止之后迅速落定。 */
  signal?: AbortSignal
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** 一次草稿提供方探查被拒绝或失败。 */
    'llm/model-discovery-rejected': {
      readonly settingsNs: string
      readonly baseURL?: string
    }
  }
}

/**
 * 端点关于自身所报告的一个模型。除 id 之外每个字段都是可选的，
 * 因为大多数提供方列表只披露一个 id，别的都没有；
 * 一个采纳了其中某个条目的界面仍然需要提供其适配器所需的那些容量。
 */
export interface LlmDiscoveredModel {
  /** 该端点接受的模型 id。 */
  id: string
  /** 当端点提供了名称时的人类可读名称。 */
  name?: string
  /** 请求与响应的合计上下文上限，当被披露时。 */
  contextWindow?: number
  /** 输出令牌上限，当被披露时。 */
  maxTokens?: number
  /** 当目录或端点披露了可接受的输入类型时；缺失意味着未知。 */
  inputModalities?: readonly ModelModality[]
}

/** 一个由适配器发现的模型；目录成员身份只是参考性的，不构成请求校验。 */
export interface LlmModelInfo {
  /** 持有该模型条目的提供方路由。 */
  provider: string
  /** 传给 {@link GenerateOptions.model} 的模型 id。 */
  id: string
  /** 供选择器使用的、人类可读的模型名称。 */
  name: string
  /** 可选的、面向用户的与相近模型之间的区分说明。 */
  description?: string
  /** 可接受的请求模态；缺失意味着未知，而显式的遗漏表示否定能力。 */
  inputModalities?: readonly ModelModality[]
}

/** 一条精确提供方/模型路由的、由提供方持有的上下文容量。 */
export interface LlmModelContext {
  /** 请求与响应的合计上下文上限，以令牌计。 */
  contextWindow: number
}

/**
 * 一条精确且具备图像能力的路由在那些被保留出现的、精确的请求版本
 * 字节之上强制执行的请求图像预算；对于 `base64` 表示形式，
 * 每个字节数会展开为它的编码后长度。当一条路由的被保留出现超出预算时，
 * 该请求会以 `IMAGE_OFFLOAD_REQUIRED` 失败，并指名还需卸载的出现数量。
 */
export interface LlmImageRequestBudget {
  /** 该路由核算的是原始文件字节还是内联 base64 长度。 */
  representation: 'raw' | 'base64'
  /** 该路由接受的、已表示的图像字节累计量；缺失使字节无上界。 */
  maxBytes?: number
  /** 该路由接受的图像出现次数；缺失使数量无上界。 */
  maxImages?: number
  /** 作为一次确定性前进步长而被移除的已表示字节；缺失时移除最小值。 */
  byteQuantum?: number
  /** 作为一次确定性前进步长而被移除的出现次数；缺失时移除最小值。 */
  countQuantum?: number
}

/** 一个由适配器持有的推理强度的展示元数据。 */
export interface LlmReasoningEffortInfo {
  /** 由 {@link GenerateOptions.reasoningEffort} 接受的、不透明的稳定值。 */
  id: ReasoningEffortId
  /** 供选择器与诊断使用的、人类可读的强度名称。 */
  name: string
  /** 可选的、面向用户的与相近强度之间的区分说明。 */
  description?: string
}

/** 一条精确提供方/模型路由的可选推理强度。 */
export interface LlmModelReasoningInfo {
  /** 按可选推理强度由低到高排列，而不是按预测的令牌用量或延迟。 */
  efforts: readonly LlmReasoningEffortInfo[]
  /**
   * 当调用方省略强度时被物化进请求的、由适配器配置的默认值。
   * 缺失时保留提供方自己的默认值。
   */
  defaultEffort?: ReasoningEffortId
}

/**
 * 一个模型如何应用在对话中途发生变化的系统提示。
 * `'in-history'`：该模型把 `messages` 中任意位置最新的 `system`
 * 消息当作完整生效的系统提示，因此一次变更后的提示可以跟在
 * 已缓存的历史之后，而不必重写第 0 条消息。
 */
export type SystemPromptUpdate = 'in-history'

/**
 * 一个模型如何接受在对话中途发生变化的原生工具声明。
 * `'addition-only'`：该模型把较晚出现的 developer 消息中的一个
 * `tool-addition` 块读作启用一个以 `deferLoading` 声明的工具，
 * 因此一个被添加的工具可以跟在已缓存的历史之后，而不必重写声明列表。
 * `'in-history'`：该模型还会读取 `tool-removal` 块，因此一个被移除的
 * 工具保留它的声明，而移除动作跟随历史。缺失意味着每次请求都声明
 * 完整的当前工具列表。
 */
export type ToolUpdate = 'in-history' | 'addition-only'

/** 由其持有方适配器解析出的、精确路由的模型元数据。 */
export interface LlmResolvedModelInfo extends LlmModelInfo {
  /** 由提供方持有的上下文容量，若已知。 */
  context?: LlmModelContext
  /** 当调用方省略输出上限时被物化的、由适配器配置的按请求输出上限。 */
  defaultMaxTokens?: number
  /** 当被暴露时，由适配器持有的可选推理等级。 */
  reasoning?: LlmModelReasoningInfo
  /** 已声明的对话中途系统提示处理方式；缺失意味着只读取开头的系统消息。 */
  systemPromptUpdate?: SystemPromptUpdate
  /** 已声明的对话中途工具声明处理方式；缺失意味着每次请求都声明完整的工具列表。 */
  toolUpdate?: ToolUpdate
}

/**
 * 供回放一次成功响应使用的、适配器私有的无损 JSON 状态，
 * 由一个终止性 `finish` 块携带，并存储在已装配助手消息的模型来源上。
 * 两半对 harness 都是不透明的；只有这个切分是共享词汇，
 * 因此装配可以在不读取任一半的前提下，让已存储的元数据与
 * 已存储的内容保持对齐。
 */
export interface ReplayEnvelope {
  /** 响应级的、适配器私有的元数据（id、原生停止原因）。 */
  response: unknown
  /**
   * 按块的、适配器私有的元数据，按首次出现的流顺序为每个已发出的块
   * 提供一个条目。当装配丢弃一个块时，它丢弃同一位置上的条目；
   * 长度与已发出块数量不匹配的条目会丢弃整个信封。
   * 一个其元数据与块结构无关的适配器省略该字段，
   * 于是信封会原样穿过装配。
   */
  blocks?: readonly unknown[]
}

/**
 * 适配器发出的原始流式协议。
 * 块索引把交错的增量关联起来，而 `block-end` 携带已装配的块。
 * 适配器在终止性 finish 之前发出用量，之后不再发出任何东西；
 * 工具参数保持为原始 JSON 字符串。一个适配器实现可以抛出，
 * 但 `LlmRuntime.stream()` 会在把该失败暴露给消费者之前，
 * 把它规范化为一个终止性的 `error` 或 `aborted` 结束。
 */
export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: ToolCallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | {
    type: 'finish'
    reason: FinishReason
    /** 一次成功响应的回放元数据；见 {@link ReplayEnvelope}。 */
    replayState?: ReplayEnvelope
  }

/**
 * 一个工具的 JSON schema 描述，按发送给模型的形式。
 *
 * 之所以声明在这里（而不在 dsh-tools），是因为它是 {@link GenerateOptions}
 * 的一部分；dsh-tools 的 ToolDefinition 与 dsh-system-prompt 的
 * PromptAssembly 都从本包导入它。
 */
export interface ToolSchema {
  /**
   * 请求把工具定义延迟加载到模型上下文中，
   * 这与是否有一个 tool-addition 块记录该工具无关。
   * 使用 Anthropic 的 defer_loading 术语。
   */
  deferLoading?: true
  name: string
  description: string
  /** 供参数使用的 JSON Schema 对象。 */
  parameters: Record<string, unknown>
}

/** 一次 LLM 请求的用户输入；它没有持久化的 Session 身份或来源。 */
export interface RequestUserInput {
  readonly role: 'user'
  readonly content: UserMessage['content']
  readonly id?: never
  readonly source?: never
}

/** 一条持久化的对话消息，或仅用于一次请求的用户输入。 */
export type RequestMessage = Message | RequestUserInput

/** 自上次声明重置以来、已记录的工具声明与更新身份。 */
export interface ToolHistory {
  /** 本段历史开始时完整的活跃声明。 */
  readonly tools: readonly ToolSchema[]
  /** 按顺序排列的 developer 消息，其新增项已从各自的历史请求头解析出来。 */
  readonly updates: readonly {
    /** 用于在派生请求历史中定位本次更新的身份。 */
    readonly messageId: MessageId
    /** 从该事件所引用的请求头解析出来的新增定义。 */
    readonly additions: readonly ToolSchema[]
  }[]
}

/** 一次完整装配好的模型请求。 */
export interface GenerateOptions {
  /** 选择适配器实例的已注册提供方路由。 */
  provider: string
  model: string
  /** 为该精确模型选择的、由适配器持有的推理强度。 */
  reasoningEffort?: ReasoningEffortId
  /**
   * 按提供方所见顺序排列的对话消息。一个由循环构建的请求传入
   * 派生出来的历史（dsh-agent-loop），其中开头的 system 角色消息
   * 携带系统提示；一个手工构建的单次调用可以包含无身份的用户输入。
   */
  messages: RequestMessage[]
  /**
   * 供单次调用方使用的系统提示文本；适配器把它映射到提供方
   * 位于 `messages` 之前的 system 槽位。由循环构建的请求让它保持未定义。
   */
  system?: string
  /** 工具 schema（适配器映射到提供方的 `tools` 字段）。 */
  tools?: ToolSchema[]
  /** 供路由投影使用的、按会话折叠的工具历史；省略时发送完整声明而不带工具更新。 */
  toolHistory?: ToolHistory
  temperature?: number
  maxTokens?: number
  /**
   * 停止序列：一旦模型产出其中任意一个字符串，生成就停止
   * （适配器映射到提供方的 stop 字段，例如 OpenAI 的 `stop`）。
   * 停止字符串本身不包含在输出中。
   */
  stop?: string[]
  signal?: AbortSignal
  /**
   * 由循环为请求路由而加盖的会话身份。回放用它来分隔游标；
   * 适配器可以把它映射为对模型隐藏的传输元数据。
   */
  sessionId?: Branded<'SessionId'>
  /**
   * 一次辅助模型调用的、与提供方无关的分类。适配器可以把该用途
   * 映射为对模型隐藏的传输元数据。普通对话请求不设置它。
   */
  purpose?: 'compaction' | 'session-title'
}
