/**
 * 一条提供方路由的模型目录的物化。已安装的 pi-ai 目录提供以模型 id 为键的
 * 默认值，而某个 profile 自己的各个模型条目逐字段覆盖它们，于是一条指名了
 * 某个目录提供方的路由保持无需配置，而一条 pi-ai 从未听说过的路由则完全
 * 可以从 `cordis.patch.yml` 描述出来。
 *
 * 严格解析会在设置写入之前拒绝那些无法被服务的模型。
 * 延后解析保留它们的诊断信息，因此已存储的目录漂移不会妨碍检查、
 * 修复，或对那些独立有效的模型发出请求。
 *
 * @module dsh-llm-pi-ai/catalog
 */

import { builtinProviders, getAllBuiltinModels, getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import type { BuiltinProvider } from '@earendil-works/pi-ai/providers/all'
import type {
  AnthropicMessagesCompat,
  Api,
  BedrockCompat,
  ChatTemplateKwargValue,
  KnownApi,
  MistralConversationsCompat,
  Model,
  ModelCost,
  ModelThinkingLevel,
  OpenAICompletionsCompat,
  OpenAIResponsesCompat,
  Provider,
  ThinkingLevelMap,
} from '@earendil-works/pi-ai'

/**
 * 某个已安装目录并未描述的模型的计价。harness 从不读取 pi-ai 的成本元数据——
 * `replay.ts` 把它归零，也没有任何消费者报告花费——因此这是*缺少一个事实*，
 * 而不是一个可配置的费率。
 */
const NO_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/** 一个 pi-ai 模型可以接受的单一请求模态。 */
export type PiAiModality = Model<Api>['input'][number]

/**
 * 每个 pi-ai 请求模态。这个 `Record` 键类型是一道漂移闸门：一次新增或移除
 * 某个模态的 pi-ai 升级会让编译在这里失败并指名那个漂移的键，
 * 而不是静默收窄某个 profile 所能声明的内容。
 */
const MODALITY_GATE: Record<PiAiModality, true> = {
  text: true,
  image: true,
}

/** 一个 profile 可以声明的每个请求模态。 */
export const MODALITIES = Object.keys(MODALITY_GATE) as readonly PiAiModality[]

/**
 * 某个条目的模态列表，或当它没有给出任何答案时为 `undefined`。缺失与空
 * 意味着同一件事——`[]` 描述的是一个什么都不接受的模型，而它服务不了
 * 任何请求——而正因如此，一个指名了某个目录模型却未声明模态的条目
 * 会保留该目录的模态，因为配置 schema 会为一个缺失的数组物化出 `[]`。
 * @param configured - 某个 `models` 或 `modelOverrides` 条目所提供的列表。
 * @returns 已声明的各个模态，或 `undefined` 以询问下一层。
 */
function declaredInput(configured: readonly PiAiModality[] | undefined): Model<Api>['input'] | undefined {
  return configured === undefined || configured.length === 0 ? undefined : [...configured]
}

/**
 * 每个 pi-ai 思考强度，按 pi-ai 的规范递增顺序排列。这个 `Record`
 * 键类型是一道漂移闸门：一次新增或移除某个强度的 pi-ai 升级会让编译
 * 在这里失败并指名那个漂移的键，而不是静默收窄某个 profile 所能声明的内容。
 */
const THINKING_LEVEL_GATE: Record<ModelThinkingLevel, true> = {
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
}

/** 一个 profile 可以声明的每个 pi-ai 思考强度，按递增顺序排列。 */
export const THINKING_LEVELS = Object.keys(THINKING_LEVEL_GATE) as readonly ModelThinkingLevel[]

/** 一个 profile 可以指名的单一推理分派线格式。 */
export type PiAiThinkingFormat = NonNullable<OpenAICompletionsCompat['thinkingFormat']>

/**
 * 可以被指名的各个推理分派格式，被最常到达的排在最前。这个 `Record`
 * 键类型是一道漂移闸门：上游新增一个格式会让编译在这里失败直到它被指名，
 * 因此这份提供绝不会静默落后于上游集合。那两个 `chat-template` 变体
 * 可以被指名，是因为 {@link PiAiCompatProfile.chatTemplateKwargs} 承载了
 * 它们的 kwargs；`baseten` 可以被指名，是因为
 * {@link PiAiCompatProfile.chatTemplateArgs} 承载了它的各个参数。
 */
const THINKING_FORMAT_GATE: Record<PiAiThinkingFormat, true> = {
  'openai': true,
  'deepseek': true,
  'openrouter': true,
  'together': true,
  'baseten': true,
  'zai': true,
  'qwen': true,
  'chat-template': true,
  'qwen-chat-template': true,
  'string-thinking': true,
  'ant-ling': true,
}

/** 一个 profile 可以指名的各个推理分派线格式，被最常到达的排在最前。 */
export const SUPPORTED_THINKING_FORMATS = Object.keys(THINKING_FORMAT_GATE) as readonly PiAiThinkingFormat[]

/** pi-ai 所接受的各个输出上限字段拼写。 */
export type PiAiMaxTokensField = NonNullable<OpenAICompletionsCompat['maxTokensField']>

/** 覆盖 {@link PiAiMaxTokensField} 的漂移闸门；上游新增一个拼写会让编译失败直到被指名。 */
const MAX_TOKENS_FIELD_GATE: Record<PiAiMaxTokensField, true> = {
  max_completion_tokens: true,
  max_tokens: true,
}

/** 一个 profile 可以指名的各个输出上限字段拼写。 */
export const MAX_TOKENS_FIELDS = Object.keys(MAX_TOKENS_FIELD_GATE) as readonly PiAiMaxTokensField[]

/** pi-ai 所接受的各个推理预算字段拼写。 */
export type PiAiThinkingTokenBudgetField = NonNullable<OpenAICompletionsCompat['thinkingTokenBudgetField']>

/** 上游的一个推理预算拼写必须先被归类，然后才能被配置。 */
const THINKING_TOKEN_BUDGET_FIELD_GATE: Record<PiAiThinkingTokenBudgetField, true> = {
  thinking_token_budget: true,
  thinking_budget: true,
  thinking_budget_tokens: true,
}

/** 一个 profile 可以指名的各个推理预算字段拼写。 */
export const THINKING_TOKEN_BUDGET_FIELDS = Object.keys(THINKING_TOKEN_BUDGET_FIELD_GATE) as readonly PiAiThinkingTokenBudgetField[]

/** pi-ai 所接受的各个提示缓存标记约定。 */
export type PiAiCacheControlFormat = NonNullable<OpenAICompletionsCompat['cacheControlFormat']>

/** 覆盖 {@link PiAiCacheControlFormat} 的漂移闸门；上游新增一个约定会让编译失败直到被指名。 */
const CACHE_CONTROL_FORMAT_GATE: Record<PiAiCacheControlFormat, true> = {
  anthropic: true,
}

/** 一个 profile 可以指名的各个提示缓存标记约定。 */
export const CACHE_CONTROL_FORMATS = Object.keys(CACHE_CONTROL_FORMAT_GATE) as readonly PiAiCacheControlFormat[]

/** 一个 `chat_template_kwargs` 值可以指名的各个请求状态占位符。 */
export type PiAiChatTemplateVar = Extract<ChatTemplateKwargValue, { $var: string }>['$var']

/** 覆盖 {@link PiAiChatTemplateVar} 的漂移闸门；上游新增一个占位符会让编译失败直到被指名。 */
const CHAT_TEMPLATE_VAR_GATE: Record<PiAiChatTemplateVar, true> = {
  'thinking.enabled': true,
  'thinking.effort': true,
  'thinking.budget': true,
}

/** 一个 profile 可以指名的各个请求状态占位符。 */
export const CHAT_TEMPLATE_VARS = Object.keys(CHAT_TEMPLATE_VAR_GATE) as readonly PiAiChatTemplateVar[]

let providerIndex: Map<string, Provider> | undefined

/**
 * 本适配器是否服务某个已安装的目录提供方。它只分派聊天请求，
 * 因此一个其目录列出了模型却没有任何聊天模型的提供方
 * （只有图像生成或分类模型）不是一条目录路由；
 * 而一个其目录完全没有列出任何模型的提供方仍然是。
 * @param provider - 那个已安装的提供方。
 * @returns 该提供方是否自带一个聊天模型，或没有列出任何模型。
 */
function servesChat(provider: Provider): boolean {
  const id = provider.id as BuiltinProvider
  return getBuiltinModels(id).length > 0 || getAllBuiltinModels(id).length === 0
}

/**
 * 本适配器所服务的各个已安装目录提供方，按 id 组织，且只构造一次。
 * 每个条目都持有它自己那些模型的 API 实现，而正因如此一条目录路由
 * 会复用这个提供方，而不是从零件被重建出来。
 * @returns 按目录顺序排列的那个目录提供方索引。
 */
function catalogProviders(): Map<string, Provider> {
  providerIndex ??= new Map(builtinProviders().filter(servesChat).map(provider => [provider.id, provider]))
  return providerIndex
}

/**
 * 当 pi-ai 自带一个本适配器所服务的提供方时，某条路由所对应的那个已安装
 * 目录提供方。
 * @param provider - 提供方路由键。
 * @returns 那个目录提供方，或对于一条 pi-ai 并不自带、
 *   或自带却没有聊天模型的路由为 `undefined`。
 */
export function catalogProvider(provider: string): Provider | undefined {
  return catalogProviders().get(provider)
}

/**
 * 已安装的 pi-ai 目录自带、且本适配器所服务的每条提供方路由：
 * 一个其目录列出了模型却没有聊天模型的提供方会被排除。
 * @returns 按目录顺序排列的各个目录提供方 id。
 */
export function catalogProviderIds(): readonly string[] {
  return [...catalogProviders().keys()]
}

/**
 * 某条路由的已安装目录模型，按模型 id 索引。
 * @param provider - 提供方路由键。
 * @returns 按 id 组织的各个目录模型；对于一条 {@link catalogProvider}
 *   不会返回任何东西的路由为空。
 */
export function catalogModels(provider: string): Map<string, Model<Api>> {
  if (!catalogProviders().has(provider)) return new Map()
  const models = getBuiltinModels(provider as BuiltinProvider) as Model<Api>[]
  return new Map(models.map(model => [model.id, model]))
}

/**
 * 某个模型的可选推理强度：每个键是该模型提供的一个强度（并且各个
 * 选择器会展示它），而它的值是分派为它所发送的线路拼写。只有 `off`
 * 可以让它的值为空——“受支持，但不发送任何东西”——因为对大多数提供方
 * 而言，不思考就是那个参数的缺席；其他每个被声明的强度都必须指名一个
 * 线路值。字典中缺席的强度不会被提供。
 */
export type PiAiReasoningEfforts = Partial<Record<ModelThinkingLevel, string | null>>

/**
 * 某个 pi-ai 兼容字段是否可以在一个 profile 上配置。
 *
 * `withhold` 是这样一个字段的处置方式：pi-ai 的已安装目录已经为某个
 * 指名厂商设置了它。在一条手工声明的路由上去够其中一个，意味着去配置
 * 一个本应被指名为一条目录路由的提供方——而在那里，那条已安装条目
 * 已经携带了正确的值。
 */
type CompatDisposition = 'offer' | 'withhold'

/**
 * 每个 `OpenAICompletionsCompat` 字段的处置方式。这个 `Record` 键类型
 * 是一道漂移闸门：一次新增某个字段的 pi-ai 升级会让编译在这里失败
 * 直到它被归类，因此这份提供绝不会静默落后于上游集合。
 */
const COMPLETIONS_COMPAT_GATE = {
  supportsStore: 'offer',
  supportsDeveloperRole: 'offer',
  supportsReasoningEffort: 'offer',
  supportsUsageInStreaming: 'offer',
  supportsFinishReason: 'offer',
  maxTokensField: 'offer',
  requiresToolResultName: 'offer',
  requiresAssistantAfterToolResult: 'offer',
  requiresThinkingAsText: 'offer',
  requiresReasoningContentOnAssistantMessages: 'offer',
  thinkingFormat: 'offer',
  chatTemplateKwargs: 'offer',
  chatTemplateArgs: 'offer',
  supportsThinkingTokenBudget: 'offer',
  thinkingTokenBudgetField: 'offer',
  vllmPriority: 'offer',
  supportsStrictMode: 'offer',
  cacheControlFormat: 'offer',
  supportsLongCacheRetention: 'offer',
  openRouterRouting: 'withhold',
  vercelGatewayRouting: 'withhold',
  zaiToolStream: 'withhold',
  supportsOpenAIGrammarTools: 'withhold',
  sendSessionAffinityHeaders: 'withhold',
  supportsMidConvoSystemMessages: 'withhold',
  supportsMidConvoToolAdditions: 'withhold',
  sessionAffinityFormat: 'withhold',
} as const satisfies Record<keyof OpenAICompletionsCompat, CompatDisposition>

/** 每个 `OpenAIResponsesCompat` 字段的处置方式；与上面那道闸门一样。 */
const RESPONSES_COMPAT_GATE = {
  supportsDeveloperRole: 'offer',
  supportsMaxOutputTokens: 'offer',
  supportsStrictMode: 'offer',
  supportsLongCacheRetention: 'offer',
  sessionAffinityFormat: 'withhold',
  supportsOpenAIGrammarTools: 'withhold',
  supportsAdditionalTools: 'withhold',
  supportsToolSearch: 'withhold',
  supportsExplicitPromptCacheMode: 'withhold',
  supportsMidConvoSystemMessages: 'withhold',
} as const satisfies Record<keyof OpenAIResponsesCompat, CompatDisposition>

/** 每个 `AnthropicMessagesCompat` 字段的处置方式；与上面那道闸门一样。 */
const ANTHROPIC_COMPAT_GATE = {
  supportsEagerToolInputStreaming: 'offer',
  supportsLongCacheRetention: 'offer',
  supportsCacheControlOnTools: 'offer',
  supportsTemperature: 'offer',
  forceAdaptiveThinking: 'offer',
  allowEmptySignature: 'offer',
  supportsStrictTools: 'offer',
  sendSessionAffinityHeaders: 'withhold',
  sessionAffinityFormat: 'withhold',
  supportsMidConvoSystemMessages: 'withhold',
  supportsMidConvoToolChanges: 'withhold',
  supportsMidConvoEffort: 'withhold',
  allowedFallbackModels: 'withhold',
} as const satisfies Record<keyof AnthropicMessagesCompat, CompatDisposition>

/** 每个 `BedrockCompat` 字段的处置方式；与上面那道闸门一样。 */
const BEDROCK_COMPAT_GATE = {
  supportsStrictMode: 'offer',
} as const satisfies Record<keyof BedrockCompat, CompatDisposition>

/** 每个 `MistralConversationsCompat` 字段的处置方式。 */
const MISTRAL_COMPAT_GATE = {
  supportsMidConvoSystemMessages: 'withhold',
} as const satisfies Record<keyof MistralConversationsCompat, CompatDisposition>

/**
 * pi-ai 为其提供了一个兼容类型的每一个线协议。它派生自 `Model.compat`
 * 自己的条件类型，而不是被手工列出，因此一个为某个进一步协议提供了
 * 兼容类型的 pi-ai 发布，会让 {@link COMPAT_GATES} 那个条目列表失败，
 * 直到有人归类它的各个字段。一个 pi-ai 没有提供兼容类型的协议
 * 会在这里解析掉，并且完全不接受任何已配置的 compat。
 */
type ApiWithCompat = { [K in KnownApi]: NonNullable<Model<K>['compat']> extends never ? never : K }[KnownApi]

/**
 * 一个 profile 可以配置的每一个线协议的 compat 闸门。
 *
 * 以协议为键，却按 pi-ai 的 compat *类型*分组：那三个 Responses 协议
 * 共享 `OpenAIResponsesCompat`，因此一个可以在其中某一个上设置的开关
 * 在所有三个上都可设置。仅仅以协议为键，会拒绝 `azure-openai-responses`
 * 与 `openai-codex-responses` 它们自己的模型所声明的那些字段。
 */
const COMPAT_GATES: Readonly<Record<ApiWithCompat, Readonly<Record<string, CompatDisposition>>>> = {
  'mistral-conversations': MISTRAL_COMPAT_GATE,
  'openai-completions': COMPLETIONS_COMPAT_GATE,
  'openai-responses': RESPONSES_COMPAT_GATE,
  'azure-openai-responses': RESPONSES_COMPAT_GATE,
  'openai-codex-responses': RESPONSES_COMPAT_GATE,
  'anthropic-messages': ANTHROPIC_COMPAT_GATE,
  'bedrock-converse-stream': BEDROCK_COMPAT_GATE,
}

/**
 * 某一个已解析协议的 compat 闸门。一次 `string` 查找，而不是一次带键的
 * 读取：某条路由的 `api` 是配置，因此它可能指名一个 pi-ai 没有提供
 * 兼容类型的协议——或者根本不指名。
 * @param api - 已解析的线协议。
 * @returns 该协议的字段闸门，或当它不接受任何 compat 时为 `undefined`。
 */
function compatGate(api: string): Readonly<Record<string, CompatDisposition>> | undefined {
  return (COMPAT_GATES as Readonly<Record<string, Readonly<Record<string, CompatDisposition>>>>)[api]
}

/** 某道闸门所提供的那些字段名。 */
type OfferedIn<G> = { [K in keyof G]: G[K] extends 'offer' ? K : never }[keyof G]

/** 一个 profile 可以设置、且在接收它的任一协议上的每一个 compat 字段名。 */
type OfferedCompatField =
  | OfferedIn<typeof COMPLETIONS_COMPAT_GATE>
  | OfferedIn<typeof RESPONSES_COMPAT_GATE>
  | OfferedIn<typeof ANTHROPIC_COMPAT_GATE>
  | OfferedIn<typeof BEDROCK_COMPAT_GATE>
  // oxlint-disable-next-line typescript/no-redundant-type-constituents -- Include gates whose current offering is empty.
  | OfferedIn<typeof MISTRAL_COMPAT_GATE>

/**
 * pi-ai 的线兼容开关，设置在路由上（作为它各个模型的默认值）
 * 或按模型设置（逐字段胜出路由）。
 *
 * 当没有任何一层设置它们时，pi-ai 会依据提供方 id 与 baseURL
 * 来判定其中每一个，而一个私有网关的 URL 什么都说明不了：
 * 对于一个它不认识的端点，那份检测会像面对 OpenAI 自己那样作答，
 * 而这几乎对每一个 OpenAI 兼容网关都是错的。因此这里每个字段都是一个
 * 部署必须能够陈述的——因为没有任何东西可以推断它——而那些 pi-ai
 * 的目录为某个指名厂商所设置的字段则保持被保留。
 *
 * 一个字段属于那些其上游 compat 类型声明了它的协议：一个其协议并不接收
 * 的模型级开关会让解析失败，而一个路由级的开关会跳过那些它适配不上的
 * 模型。下面“那三个 Responses 协议”指的是 `openai-responses`、
 * `azure-openai-responses` 与 `openai-codex-responses`，
 * pi-ai 为它们提供了一个共享的 compat 类型，因此一个可以在其中某一个上
 * 设置的开关在所有三个上都可设置。
 */
export interface PiAiCompatProfile {
  /** 该端点是否接受 `store`；`openai-completions`。 */
  supportsStore?: boolean
  /**
   * 该端点是否接受系统提示的 `developer` 角色，而 pi-ai 只会把它发给一个
   * 推理模型；`false` 会保留 `system`。
   * `openai-completions` 与那三个 Responses 协议。
   */
  supportsDeveloperRole?: boolean
  /** 该端点是否接受 `reasoning_effort`；`openai-completions`。 */
  supportsReasoningEffort?: boolean
  /** 该端点是否接受 `stream_options: {include_usage: true}`；`openai-completions`。 */
  supportsUsageInStreaming?: boolean
  /**
   * 各个流是否包含 `finish_reason`；`false` 会让 pi-ai 在流结束时
   * 推断那个终止性原因；`openai-completions`。
   */
  supportsFinishReason?: boolean
  /** 该端点读取哪个输出上限字段；`openai-completions`。 */
  maxTokensField?: NonNullable<OpenAICompletionsCompat['maxTokensField']>
  /** 各个工具结果是否必须携带 `name`；`openai-completions`。 */
  requiresToolResultName?: boolean
  /** 工具结果之后的一条用户消息是否需要在两者之间有一条助手消息；`openai-completions`。 */
  requiresAssistantAfterToolResult?: boolean
  /** 思考块是否必须以文本形式在 `<thinking>` 分隔符中传输；`openai-completions`。 */
  requiresThinkingAsText?: boolean
  /** 在推理开启时，被回放的助手消息是否需要一个空的 `reasoning_content`；`openai-completions`。 */
  requiresReasoningContentOnAssistantMessages?: boolean
  /** 该端点所期望的推理参数格式；`openai-completions`。 */
  thinkingFormat?: PiAiThinkingFormat
  /**
   * 作为 `chat_template_kwargs` 发送的各个 kwargs，而 pi-ai 只在那两个
   * `chat-template` 思考格式之下读取它们；`openai-completions`。
   * 没有任何东西检查这个配对：生效的那个格式可能来自已安装目录条目，
   * 也可能来自 pi-ai 自己的 baseURL 检测，两者解析都读不到，
   * 因此设置在另一个格式旁边的 kwargs 不会被发送到任何地方。
   */
  chatTemplateKwargs?: NonNullable<OpenAICompletionsCompat['chatTemplateKwargs']>
  /** 在 `baseten` 思考格式之下作为 `chat_template_args` 发送的各个参数；`openai-completions`。 */
  chatTemplateArgs?: NonNullable<OpenAICompletionsCompat['chatTemplateArgs']>
  /** `thinkingTokenBudgetField: "thinking_token_budget"` 的别名；一个显式的字段胜出。`openai-completions`。 */
  supportsThinkingTokenBudget?: boolean
  /** 承载来自 `thinkingBudgets` 的推理预算的请求字段；除非已配置否则被省略。`openai-completions`。 */
  thinkingTokenBudgetField?: PiAiThinkingTokenBudgetField
  /** vLLM 调度器的 `priority`；数值越小越早执行，且服务器必须启用优先级调度。除非已配置否则被省略。 */
  vllmPriority?: number
  /** `openai-responses` 是否接受 `max_output_tokens`；`false` 会省略它。Azure 与 Codex 会忽略这个共享 compat 字段。 */
  supportsMaxOutputTokens?: boolean
  /**
   * 该端点是否在各个工具定义中接受 `strict`；
   * `openai-completions`、那三个 Responses 协议、`bedrock-converse-stream`。
   */
  supportsStrictMode?: boolean
  /** 提示缓存标记约定；`openai-completions`。 */
  cacheControlFormat?: NonNullable<OpenAICompletionsCompat['cacheControlFormat']>
  /**
   * 该端点是否接受长提示缓存保留；
   * `openai-completions`、那三个 Responses 协议、`anthropic-messages`。
   */
  supportsLongCacheRetention?: boolean
  /** 该端点是否在各个工具上接受 `eager_input_streaming`；`anthropic-messages`。 */
  supportsEagerToolInputStreaming?: boolean
  /** 该端点是否在各个工具定义上接受 `cache_control`；`anthropic-messages`。 */
  supportsCacheControlOnTools?: boolean
  /** 该端点是否接受 `temperature` 请求字段；`anthropic-messages`。 */
  supportsTemperature?: boolean
  /** 是否无视模型 id 强制启用自适应思考；`anthropic-messages`。 */
  forceAdaptiveThinking?: boolean
  /** 是否回放一个空的思考签名，而不是把思考转换为文本；`anthropic-messages`。 */
  allowEmptySignature?: boolean
  /** 该端点是否接受 Anthropic 严格工具 schema；`anthropic-messages`。 */
  supportsStrictTools?: boolean
}

/** 约束 `T` 为 `never` 的编译期断言。 */
type AssertNever<T extends never> = T

/**
 * 证明每个已被文档化的字段都是某道闸门所提供的。一个该 profile 声明到
 * 那些闸门之外的字段，会让编译失败并在错误中带上它自己的名字。
 */
export type EveryProfileFieldIsOffered = AssertNever<Exclude<keyof PiAiCompatProfile, OfferedCompatField>>

/**
 * 证明每个被提供的字段都已被文档化。一个被翻成 `offer` 却没有对应 profile
 * 字段的闸门条目，会让编译失败并在错误中带上它自己的名字——
 * 而这一半是单靠一个 schema 抓不到的。
 */
export type EveryOfferedFieldIsDocumented = AssertNever<Exclude<OfferedCompatField, keyof PiAiCompatProfile>>

/** 约束 `T` 为 `true` 的编译期断言。 */
type AssertTrue<T extends true> = T

/** 某道闸门所归类的每个兼容类型，合并起来因此一次 `Pick` 就能到达所有被提供的字段。 */
type UpstreamCompat = OpenAICompletionsCompat & OpenAIResponsesCompat & AnthropicMessagesCompat & BedrockCompat & MistralConversationsCompat

/**
 * 证明每个已被文档化的字段都携带它的上游类型，而不是对它的手工复述。
 * 上面那些名字闸门钉住的是*存在哪些*字段；这一个钉住的是它们的类型，
 * 而且是双向的，因为每一向抓到的是不同的漂移。一个比上游更宽的 profile
 * 字段会接受一个提供方会拒绝的值，而 `resolveModelCompat` 到
 * `ModelCompat` 的那个断言会把它藏起来；一个更窄的字段则会拒绝一个
 * 提供方会接受的值，而这正是一次放宽某个联合的上游升级
 * 原本会把配置悄悄甩在后面的方式。
 */
export type EveryProfileFieldMatchesUpstream = AssertTrue<
  PiAiCompatProfile extends Partial<Pick<UpstreamCompat, OfferedCompatField>>
    ? Partial<Pick<UpstreamCompat, OfferedCompatField>> extends PiAiCompatProfile ? true : false
    : false
>

/**
 * 某个 profile 真正设置了的那些 compat 条目。
 *
 * schemastery 会把一个缺失的字典物化为 `{}`——正是
 * `reasoningEfforts` 用一个联合去绕开的那个行为——因此每个已解析的
 * profile 都携带两个模板参数键，无论是否有人写过它们。一个空的在这里
 * 什么都没陈述：它不会发送任何参数，而这正与省略该字段完全一样，
 * 所以缺失与空是同一个请求，并且两者都不得让一条路由看起来配置了某个开关。
 * 一个无值的标量是 schemastery 放过的另一样东西，而它会在本函数运行
 * 之前被 {@link assertOfferedCompatFields} 拒绝，而不是被过滤掉。
 * @param compat - 已配置的各个开关，当有任何时。
 * @returns 携带一个值的那些条目，按声明顺序排列。
 */
function configuredCompatEntries(compat: PiAiCompatProfile | undefined): readonly (readonly [string, unknown])[] {
  return Object.entries(compat ?? {}).flatMap(([field, value]) => {
    const empty = typeof value === 'object' && value !== null && !Array.isArray(value)
      && Object.keys(value as object).length === 0
    return empty ? [] : [[field, value] as const]
  })
}

/**
 * 提供某个 compat 字段的那些协议，按 {@link COMPAT_GATES} 的顺序排列。
 * @param field - 已配置的 compat 字段名。
 * @returns 其 compat 接收它的那些协议；当没有协议接收它时为空，
 *   而那要么是一个被保留的字段，要么是一个没有任何上游兼容类型声明的名字。
 */
function compatProtocols(field: string): readonly string[] {
  return Object.entries(COMPAT_GATES).flatMap(([api, gate]) => gate[field] === 'offer' ? [api] : [])
}

/**
 * 某个协议所提供的各个 compat 字段，用于那条必须展示当时可用的是什么、
 * 而不是展示那个未命中的名字的诊断信息。
 * @param api - 线协议。
 * @returns 被提供的各个字段名，或对于一个不接受任何 compat 的协议为一个空列表。
 */
function offeredCompatFields(api: string): readonly string[] {
  return Object.entries(compatGate(api) ?? {}).flatMap(([field, disposition]) => disposition === 'offer' ? [field] : [])
}

/**
 * 每个被提供的字段名，去重之后，用于那条无法按协议收窄的诊断信息：
 * 那个词汇表检查在任何协议被解析之前运行，而正因这一点，
 * 它能在一个其各个模型永远到不了那个声明了预期字段的协议的路由上，
 * 拒绝一次拼写错误。
 * @returns 跨每个协议的、按闸门顺序排列的各个被提供字段名。
 */
function allOfferedCompatFields(): readonly string[] {
  const fields = new Set<string>()
  for (const api of Object.keys(COMPAT_GATES)) {
    for (const field of offeredCompatFields(api)) fields.add(field)
  }
  return [...fields]
}

/**
 * 拒绝一个没有任何协议提供的 compat 键。它在任何协议被解析之前运行，
 * 因此一个被保留的字段或一次拼写错误，即使在一个其各个模型永远到不了
 * 那个本会接收它的协议的路由上也会失败——另一种做法就是那个
 * 让一个无法读取的开关看起来已被应用的静默丢弃。
 * @param provider - 提供方路由键，用于诊断。
 * @param site - 该配置位置，用于诊断。
 * @param compat - 已配置的各个开关，当有任何时。
 * @throws Error 指名那个有问题的键。
 */
function assertOfferedCompatFields(
  provider: string,
  site: string,
  compat: PiAiCompatProfile | undefined,
): void {
  // 每一个键，而不只是那些携带值的：一个被保留的或未被声明的名字
  // 从不在 schema 中，因此 schemastery 不可能物化出它——
  // 无论它的值是什么，都是某个人写了它并期望它做点什么。
  for (const [field, value] of Object.entries(compat ?? {})) {
    // 名字先于值被判定，因此一个被裸写下来的被保留或拼错的键，
    // 是因为它是那个名字而被拒绝，而不是因为它是空的：
    // 另一种顺序会把人送去补一个该键照样会被拒绝的值。
    if (compatProtocols(field).length === 0) {
      const declared = Object.values(COMPAT_GATES).some(gate => gate[field] !== undefined)
      if (declared) {
        invalid(provider, `${site} sets compat "${field}", which is not configurable here: pi-ai's installed`
          + ' catalog sets it for the vendors that need it, so name that provider as the route instead')
      }
      invalid(provider, `${site} sets compat "${field}", which no wire protocol declares; the configurable`
        + ` switches are ${allOfferedCompatFields().join(', ')}`)
    }
    // 一个无值的键（`supportsDeveloperRole:`）能存活于 schemastery——
    // 它在任何成员 schema 运行之前就把可空数据原样放过，
    // 与 `reasoningEfforts` 所记录的同一个行为——而一个 `cordis.yml`
    // 条目也可能通过 `!!js undefined` 到达同一个状态。无论哪种方式
    // 该键都被保留，因此带着它往前走不会覆盖下一层所解析出的任何东西，
    // 从而把 pi-ai 的 `??` 留在它的 baseURL 检测上：
    // 那正是本界面存在所要拒绝的那个“已写入却未应用”的结果。
    if (value == null) {
      invalid(provider, `${site} sets compat "${field}" with no value; give it one, or remove the key to`
        + ' leave the field to the next layer — the installed catalog entry, then pi-ai\'s own detection')
    }
  }
}

/** 一个已配置的模型条目：一个 id，加上它覆盖的各个目录字段。 */
export interface PiAiModelProfile {
  /** 发送给该提供方、且被 {@link GenerateOptions.model} 接受的模型 id。 */
  id: string
  /** 供选择器使用的展示名称；默认为目录名称，然后是该 id。 */
  name?: string
  /** 以令牌计的请求与响应合计上下文上限。 */
  contextWindow?: number
  /**
   * 最大输出令牌数。配置一个同时也让它成为本模型的按请求默认值；
   * 一个从已安装目录、或该路由的兜底继承而来的值只是模型的能力，
   * 并且永远不会自行变成一个请求默认值。
   */
  maxTokens?: number
  /**
   * 本模型所接受的各个请求模态。缺席——或为空，那描述的是一个什么都不
   * 接受的模型，因而同样没有给出任何答案——会保留已安装目录条目的模态，
   * 然后是该路由的 `defaultInput`。声明图像正是让一个手工声明的视觉模型
   * 可用的方式，而只声明文本则能纠正一个其网关并不服务目录所记录内容的
   * 目录模型。这是关于该端点的一项声明，而不是对它的一次检查：
   * 没有任何东西会就一个网关接受什么去询问它，因此一个声称图像、
   * 而它的端点会拒绝的模型，会被该提供方在轮次中途拒绝。
   */
  input?: PiAiModality[]
  /**
   * 可选的推理强度。缺席会继承已安装目录条目的能力
   *（一个手工声明的模型没有任何能力，也不会推理）；
   * `false` 声明一个非推理模型，这正是某个 profile 从其网关无法服务的
   * 目录模型上剥离推理的方式；一个非空字典则声明被提供的各个强度
   * 及其线路拼写。
   */
  reasoningEfforts?: false | PiAiReasoningEfforts
  /** 本模型的 pi-ai 线兼容开关，逐字段胜出该路由的；一个其协议并未声明的开关会被拒绝。 */
  compat?: PiAiCompatProfile
}

/**
 * 对某个已安装目录模型的一项定制，以它的 id 作为该路由
 * `modelOverrides` 字典中的键——与某个 `models` 条目可以设置的字段相同，
 * 只是那个 id 位于键中。与一个 `models` 列表不同，各个覆盖项让目录的
 * 其余部分继续原样服务，而正因这一点，“改正一个模型，保留其余三十七个”
 * 是一次三行的编辑。
 */
export type PiAiModelOverride = Omit<PiAiModelProfile, 'id'>

/** 模型物化所读取的那些路由级事实。 */
export interface RouteCatalogRequest {
  /** 提供方路由键，被盖到每个已物化的模型上。 */
  provider: string
  /** 线协议覆盖；缺席会顺从每个目录模型自己的 API。 */
  api?: string
  /** 端点覆盖；缺席会顺从该目录模型，然后是该目录提供方。 */
  baseURL?: string
  /** 已配置的目录；缺席意味着本路由的整个已安装目录。 */
  models?: readonly PiAiModelProfile[]
  /** 按模型 id 组织的已安装目录定制项；只在 `models` 缺席时有意义。 */
  modelOverrides?: Readonly<Record<string, PiAiModelOverride>>
  /** 路由级的线兼容开关，落在那些其协议声明了它们的模型上；各个条目逐字段覆盖。 */
  compat?: PiAiCompatProfile
  /** 对于某个其条目与目录都未给出容量的模型的上下文容量。 */
  defaultContextWindow: number
  /** 对于某个其条目与目录都未给出容量的模型的输出能力。 */
  defaultMaxTokens: number
  /** 对于某个其条目与目录都未声明的模型的各个模态。 */
  defaultInput: Model<Api>['input']
}

/** 一次预期的配置失败，已存储的目录读取可以为了修复而保留它。 */
export class PiAiCatalogError extends Error {}

/** 报告一条该部署无法服务的路由，并指名那个有问题的设置键。 */
function invalid(provider: string, detail: string): never {
  throw new PiAiCatalogError(`llm-pi-ai: provider "${provider}" ${detail}`)
}

/**
 * 某条目录路由那些自带模型所共同认可的、唯一的线协议。而正是这一点，
 * 让一个部署可以添加一个已安装目录尚未跟上的模型——某个提供方的最新发布——
 * 而不必复述它的各个同级模型已经在用的那个协议。一条其自带模型意见不一
 * 的路由（一个横跨 Responses 与 Chat Completions 的 OpenAI 风格目录）
 * 没有这样的答案，因此一个它并未描述的模型必须在该路由上指名它的协议。
 */
function sharedCatalogApi(defaults: ReadonlyMap<string, Model<Api>>): string | undefined {
  const apis = new Set<string>()
  for (const model of defaults.values()) apis.add(model.api)
  return apis.size === 1 ? [...apis][0] : undefined
}

/** 一个已物化模型所携带的那些推理字段。 */
interface ModelReasoning {
  /** 该模型是否推理；`false` 会让 pi-ai 忽略那个映射。 */
  reasoning: boolean
  /** 分派所读取的那个映射；只有当已安装条目的（或没有）适用时才缺席。 */
  thinkingLevelMap?: ThinkingLevelMap
}

/**
 * 从某个模型已声明的各个强度解析它的推理能力。
 *
 * 一个已声明的字典会被翻译为 pi-ai 的 `thinkingLevelMap`，其中每个强度
 * 都被显式地判定：被声明的强度携带它们的线路拼写，未被声明的强度被钉在
 * `null`（不受支持）。钉住这一点很重要，因为 pi-ai 自己的默认值补全
 * 是不对称的——一个缺席的键对那五个基础强度意味着“受支持”，
 * 但对 `xhigh`/`max` 意味着“不受支持”——而一个 profile 的作者
 * 不应该需要知道这一点。一个被声明的无值 `off` 是唯一的例外：它保持
 * 缺席于该映射之外，而 pi-ai 把它读作“受支持，但不发送任何东西”——
 * 在不思考就是那个参数缺席之处所应有的分派——而带有一个值的 `off`
 * 则会发送那个值。
 * @param provider - 提供方路由键，用于诊断。
 * @param entry - 已配置的模型条目。
 * @param base - 同 id 的已安装目录条目，当存在时。
 * @returns 该已物化模型所携带的那些推理字段。
 */
function resolveModelReasoning(
  provider: string,
  entry: PiAiModelProfile,
  base: Model<Api> | undefined,
): ModelReasoning {
  const efforts = entry.reasoningEfforts
  if (efforts === undefined) {
    // 推理搭已安装条目的车，或干脆缺席：一个光秃秃的能力标记会让 pi-ai
    // 宣传各个强度，却没有 `thinkingLevelMap` 去拼写它们，
    // 而没有任何列表端点会报告某个模型的推理协议。该条目的映射
    //（当有时）会通过模型字面量中的 `...base` 展开到达。
    return { reasoning: base?.reasoning ?? false }
  }
  // 已安装条目的映射可能通过 `...base` 搭车过来；pi-ai 从不在
  // 一个非推理模型上读取它，因此在这里剥掉它不值得一次字段枚举。
  if (efforts === false) return { reasoning: false }
  // 一个被留成无值的 YAML `reasoningEfforts:` 会通过那个 schema 联合
  // 以 null 到达——在该字段的声明类型之外，因此需要这次放宽——
  // 而一个显式的 `{}` 则以一个空字典到达。两者都什么也没声明，
  // 并且两者都不是“继承”或“禁用”的一种拼写。
  if ((efforts as unknown) === null || Object.keys(efforts).length === 0) {
    invalid(provider, `model "${entry.id}" has an empty reasoningEfforts; declare the offered levels, set`
      + ' false for a non-reasoning model, or omit the field to keep the installed catalog\'s capability')
  }
  const declared = THINKING_LEVELS.flatMap((level) => {
    const wire = efforts[level]
    return wire === undefined ? [] : [[level, wire] as const]
  })
  for (const [level, wire] of declared) {
    if (wire === null) {
      if (level !== 'off') {
        invalid(provider, `model "${entry.id}" reasoningEfforts.${level} needs the wire value dispatch`
          + ' should send; only "off" may leave it empty')
      }
    } else if (wire.length === 0) {
      invalid(provider, `model "${entry.id}" reasoningEfforts.${level} must not be an empty string`)
    }
  }
  if (!declared.some(([level]) => level !== 'off')) {
    invalid(provider, `model "${entry.id}" reasoningEfforts offers no level beyond "off"; declare a thinking`
      + ' level, or set reasoningEfforts to false for a non-reasoning model')
  }
  const map: ThinkingLevelMap = {}
  for (const level of THINKING_LEVELS) {
    const wire = efforts[level]
    if (wire === undefined) {
      map[level] = null
    } else if (wire !== null) {
      map[level] = wire
    }
  }
  return { reasoning: true, thinkingLevelMap: map }
}

/** 一个已物化模型所携带的那个 compat 块，无论它说的是哪个协议。 */
type ModelCompat = OpenAICompletionsCompat | OpenAIResponsesCompat | AnthropicMessagesCompat | BedrockCompat | MistralConversationsCompat

/**
 * 从该 profile 的各个开关解析某个模型的 compat 块。
 *
 * 一个模型开关逐字段胜出那个路由开关；两者都未设置的保留已安装条目的值，
 * 而一个没有任何一层判定的字段则落到 pi-ai 自己的检测上。一个其协议
 * 并不接收的模型级开关会让解析失败——关于某个被指名的模型，它只能是
 * 一次失误——而一个路由级的开关会跳过这样的模型，因为一个路由默认值
 * 必须在一条其各个模型并不都说同一种协议的路由上保持可设置。
 * 到达这里的每个字段都由某个协议提供；{@link assertOfferedCompatFields}
 * 已经拒绝掉其余的。
 * @param provider - 提供方路由键，用于诊断。
 * @param entry - 已配置的模型条目。
 * @param route - 路由级的各个开关，当有任何时。
 * @param base - 同 id 的已安装目录条目，当存在时。
 * @param api - 该模型已解析的线协议。
 * @returns 一个要展开进该模型的 `compat` 字段，或什么都没有。
 */
function resolveModelCompat(
  provider: string,
  entry: PiAiModelProfile,
  route: PiAiCompatProfile | undefined,
  base: Model<Api> | undefined,
  api: string,
): { compat: ModelCompat } | Record<string, never> {
  const gate = compatGate(api)
  const configured: Record<string, unknown> = {}
  for (const [field, value] of configuredCompatEntries(route)) {
    if (gate?.[field] !== 'offer') continue
    configured[field] = value
  }
  for (const [field, value] of configuredCompatEntries(entry.compat)) {
    if (gate?.[field] !== 'offer') {
      const offered = offeredCompatFields(api)
      invalid(provider, `model "${entry.id}" sets compat "${field}", but its api is "${api}", which does not`
        + ` take it; that switch exists on ${compatProtocols(field).join(', ')}, and "${api}" offers`
        + ` ${offered.length === 0 ? 'no configurable compat' : offered.join(', ')}`)
    }
    configured[field] = value
  }
  if (Object.keys(configured).length === 0) return {}
  // 已安装条目的 compat 匹配该条目*自己*的 api——一次路由级的 `api`
  // 重定向（一个通过 OpenAI 兼容网关服务的 anthropic 目录）会把
  // `base.compat` 留在另一个协议的形状里，因此它只在已解析的 api
  // 仍然是该条目的 api 时才被继承。一个被重定向的模型改为从 pi-ai
  // 基于 baseURL 派生出的检测出发，而对其他每个 compat 字段而言，
  // 这也同样是一次协议变更的含义。
  const inherited = base?.api === api ? base.compat : undefined
  return { compat: { ...inherited, ...configured } as ModelCompat }
}

/** 一条路由的已物化目录，以及它的 profile 所选择的各个请求上限。 */
export interface RouteCatalog {
  /** 按配置顺序排列的各个已物化模型。 */
  models: readonly Model<Api>[]
  /** 无法被解析的各个模型，在已存储配置的读取期间作为诊断信息被保留。 */
  modelErrors: ReadonlyMap<string, string>
  /**
   * 本 profile 显式配置的、按模型 id 组织的各个按请求输出上限。
   *
   * 与 `Model.maxTokens` 分开，是因为两者回答的是不同的问题：
   * pi-ai 要求 `maxTokens` 作为该模型的输出*能力*，
   * 而 harness 接缝的 `defaultMaxTokens` 则是该部署选择要在那些
   * 未指名任何上限的请求上发送的一个上限。把某个目录能力物化为一个请求
   * 默认值，会让每次请求都被一个没有人挑过的数字限住，
   * 因此只有一次显式的配置才会落到这里。
   */
  configuredMaxTokens: ReadonlyMap<string, number>
}

/**
 * 把已安装的目录默认值合并到各个已配置条目之下，从而物化一条路由的目录。
 * 一条没有配置任何 `models` 的路由会原样提供已安装目录，
 * 而正是这一点让一份已有的 `providers: { deepseek: { apiKeyEnv: … } }`
 * profile 无需改动就能工作。
 * @param request - 路由级的各个目录事实。
 * @param validation - 严格写入拒绝每一个错误；延后读取保留各个模型诊断信息。
 * @returns 已物化的各个模型，以及被显式配置的各个请求上限。
 */
export function resolveRouteModels(
  request: RouteCatalogRequest,
  validation: 'strict' | 'deferred' = 'strict',
): RouteCatalog {
  const { provider } = request
  const defaults = catalogModels(provider)
  const providerBaseUrl = catalogProvider(provider)?.baseUrl
  // 一个缺席的 `models` 键与一个空的键是同一个请求：配置 schema 会为
  // 那个缺席的情形物化出 `[]`，而一个空目录无论如何服务不了任何请求，
  // 因此两者都意味着“提供已安装目录”。
  const configured = request.models ?? []
  const overrides = request.modelOverrides ?? {}
  const modelErrors = new Map<string, string>()
  // 写入会拒绝缺失的所指对象。已存储的各个覆盖项会在某次目录移除之后
  // 保留一条诊断信息，而不是静默消失。
  for (const [id, override] of Object.entries(overrides)) {
    if (id.length === 0) invalid(provider, 'has a modelOverrides entry with an empty model id')
    if (defaults.size === 0) {
      invalid(provider, `sets modelOverrides for "${id}", but the installed catalog does not describe this route;`
        + ' a declared route spells every model out in its models list')
    }
    if (configured.length > 0) {
      invalid(provider, `sets modelOverrides for "${id}" beside a models list; models already replaces the served`
        + ' catalog, so declare the fields on its entries')
    }
    if (!defaults.has(id)) {
      const message = `modelOverrides names "${id}", which the installed catalog does not describe`
      if (validation === 'strict') invalid(provider, message)
      modelErrors.set(id, `llm-pi-ai: provider "${provider}" ${message}`)
    }
    // 那个 id 位于字典键中；一个携带自己 id 的值会悄悄重命名它本想定制的
    // 那个模型。那个静态形状已经省略了它——这一步守卫的是那个 schema
    // 边界，而它会把未知的键原样放过。
    if ('id' in override) {
      invalid(provider, `modelOverrides entry "${id}" sets "id", which is the dict key`)
    }
  }
  // 一个覆盖项成为该目录条目的配置，因此某个 models 条目可以声明的
  // 一切——容量、强度、compat——都经由同一条路径、带着同样的诊断信息
  // 与请求默认值语义来解析。
  const entries: readonly PiAiModelProfile[] = configured.length > 0
    ? configured
    : [...defaults.values()].map(model => ({ id: model.id, ...overrides[model.id] }))
  if (entries.length === 0) {
    invalid(provider, 'resolves no models; the installed catalog does not describe this route, so its models'
      + ' must be listed in configuration')
  }
  const routeApi = sharedCatalogApi(defaults)
  // 词汇表先于协议：一个被保留的或未被声明的开关，无论它被写在哪里
  // 都会被拒绝，因此它无法在一个其各个模型永远到不了那个本会接收它的
  // 协议的路由上看起来已被应用。
  assertOfferedCompatFields(provider, 'route', request.compat)
  const seen = new Set<string>()
  const configuredMaxTokens = new Map<string, number>()
  const resolveEntry = (entry: PiAiModelProfile): Model<Api> => {
    assertOfferedCompatFields(provider, `model "${entry.id}"`, entry.compat)
    if (entry.id.length === 0) invalid(provider, 'has a model with an empty id')
    if (seen.has(entry.id)) invalid(provider, `lists model "${entry.id}" more than once`)
    seen.add(entry.id)
    const base = defaults.get(entry.id)
    const api = request.api ?? base?.api ?? routeApi
    if (api === undefined) {
      invalid(provider, `model "${entry.id}" needs an api; the installed catalog does not describe it, so set the`
        + ' route\'s api to the wire protocol its endpoint speaks')
    }
    const baseUrl = request.baseURL ?? base?.baseUrl ?? providerBaseUrl
    if (baseUrl === undefined) {
      invalid(provider, `model "${entry.id}" needs a baseURL; the installed catalog does not describe this route`)
    }
    // 各个容量会回退到该路由自己的默认值，因此一个只披露了 id、
    // 别的什么都没有的模型列表，仍然得出一条可服务的路由。
    // 这个兜底按构造就是一次猜测，而正因如此它是一个可配置的路由字段，
    // 而不是一个被埋在这里的常量。
    const contextWindow = entry.contextWindow ?? base?.contextWindow ?? request.defaultContextWindow
    if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
      invalid(provider, `model "${entry.id}" contextWindow must be a positive integer`)
    }
    const maxTokens = entry.maxTokens ?? base?.maxTokens ?? request.defaultMaxTokens
    if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
      invalid(provider, `model "${entry.id}" maxTokens must be a positive integer`)
    }
    // 只有该 profile 指名过的值才是部署的选择；目录的那个只是模型的能力，
    // 并且不进入请求默认值。
    if (entry.maxTokens !== undefined) configuredMaxTokens.set(entry.id, entry.maxTokens)
    return {
      // 已安装条目铺底，而下面这些字段覆盖它。逐字段枚举反而会静默丢掉
      // 本包并未建模的每一个 `Model` 字段——推理强度的拼写、兼容性怪癖、
      // 模型请求头，以及一次 pi-ai 升级将来会加上的任何东西。展开，绝不枚举。
      ...base,
      id: entry.id,
      name: entry.name ?? base?.name ?? entry.id,
      api,
      provider,
      baseUrl,
      input: declaredInput(entry.input) ?? base?.input ?? [...request.defaultInput],
      cost: base?.cost ?? NO_COST,
      contextWindow,
      maxTokens,
      ...resolveModelReasoning(provider, entry, base),
      ...resolveModelCompat(provider, entry, request.compat, base, api),
    }
  }
  const models: Model<Api>[] = []
  for (const entry of entries) {
    let model: Model<Api>
    try {
      model = resolveEntry(entry)
    } catch (error) {
      if (validation === 'strict' || !(error instanceof PiAiCatalogError)) throw error
      modelErrors.set(entry.id, error.message)
      continue
    }
    models.push(model)
  }
  // 一个较晚出现的重复项会让那个 id 失效，包括一个更早的已解析条目。
  const serviceableModels = models.filter(model => !modelErrors.has(model.id))
  // 逐字段，而不是逐块：一条路由可以默认一个它的 completions 模型接收的
  // 开关，同时又默认一个只有它的 anthropic 模型接收的开关，
  // 而两者都不应为了对方而失败。会被拒绝的是这样一个路由默认值：
  // 该路由上没有任何模型能读取它，因为那是一条不会按所写那样表现的路由。
  for (const [field] of configuredCompatEntries(request.compat)) {
    const takers = compatProtocols(field)
    if (serviceableModels.some(model => takers.includes(model.api))) continue
    invalid(provider, `sets compat "${field}", but no model on the route speaks a protocol that takes it;`
      + ` it exists on ${takers.join(', ')}`)
  }
  return { models: serviceableModels, configuredMaxTokens, modelErrors }
}
