/**
 * pi-ai 适配器的配置 schema 与提供方 profile 校验。各个 profile 是一个以
 * 提供方路由为键的字典，因此组合基座与用户设置层按提供方合并，
 * 而路由集合是结构性的。
 *
 * 一个路由键并不要求指名某个已安装的 pi-ai 提供方。当它指名了，该提供方的
 * 端点、协议、展示名称与模型目录就成为该 profile 的默认值，而该 profile
 * 逐字段覆盖它们；当它没有指名，该 profile 就是整个提供方声明。已存储的
 * 读取会在可服务的模型旁边保留目录诊断信息；写入会在持久化之前校验
 * 每一个发生变化的提供方。两种情况下都适用那些自包含的 profile 约束。
 *
 * @module dsh-llm-pi-ai/config
 */
import type { Volatile } from '@deepseek-ai/cordis'

import type { CacheRetention, ChatTemplateKwargValue, ModelThinkingLevel, Provider, ThinkingBudgets, Transport } from '@earendil-works/pi-ai'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { ResolvedRetryPolicy, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import {
  CACHE_CONTROL_FORMATS,
  CHAT_TEMPLATE_VARS,
  MAX_TOKENS_FIELDS,
  MODALITIES,
  PiAiCatalogError,
  resolveRouteModels,
  SUPPORTED_THINKING_FORMATS,
  THINKING_LEVELS,
  THINKING_TOKEN_BUDGET_FIELDS,
} from './catalog.ts'
import type {
  PiAiCompatProfile,
  PiAiModality,
  PiAiModelOverride,
  PiAiModelProfile,
  PiAiReasoningEfforts,
  RouteCatalog,
} from './catalog.ts'
import { buildProvider, supportedProtocols } from './provider.ts'

/** 一次适配器流式读取处于未完成状态时的默认最大空闲间隔。 */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/**
 * 对 base64 编码图像载荷的默认请求级上限。历史中的每张图像都会被重新编码
 * 进每一个请求体，因此一段无上界的对话最终会超出某个提供方或网关的请求
 * 大小上限，而该会话永远无法再完成一次请求。这个 20MiB 默认值在 base64
 * 展开之后接纳十五个 1MiB 的请求版本，并为系统提示、历史、工具与 JSON
 * 预留请求容量。位于更严格网关之后的部署可以逐路由调低它。
 */
export const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024
/** 默认的总像素预算保留完整的 2048px 已规范化附件。 */
export const DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 2048 * 2048
/** 内联 base64 展开之前默认的原始编码字节目标；当没有质量档位可用时使用最小的质量阶梯输出。 */
export const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 1024 * 1024

/** 对于某个既未被配置、也未被目录给出容量的模型所假定的上下文容量。 */
export const DEFAULT_CONTEXT_WINDOW = 262_144

/** 对于某个既未被配置、也未被目录给出容量的模型所假定的输出能力。 */
export const DEFAULT_MAX_TOKENS = 32_768

/**
 * 对于某个既未被配置、也未被目录声明模态的模型所假定的模态。文本是每一个
 * 受支持协议都确定会承载的底线，因此这是*缺少一份声明*，而不是对端点的一次
 * 猜测：没有任何东西能就一个网关的模态去询问它，而那两个错误答案的代价
 * 并不相同。声明不足会在图像被附上之前就拒绝它，并指名该模型。
 * 声明过头则会接纳一个提供方之后在轮次中途拒绝的东西——而此时该消息
 * 已经持久化，于是该会话只能重复一个不可能成功的请求。
 */
export const DEFAULT_INPUT: readonly PiAiModality[] = ['text']

export type {
  PiAiCompatProfile,
  PiAiModality,
  PiAiModelOverride,
  PiAiModelProfile,
  PiAiReasoningEfforts,
  PiAiThinkingFormat,
} from './catalog.ts'

/** 一条 pi-ai 提供方路由的配置；`providers` 字典的那个键*就是*该路由。 */
export interface PiAiProviderProfile {
  /** 凭据引用（环境变量名），每次请求时通过 `ctx.credentials` 解析。 */
  apiKeyEnv?: string
  /** 由各个配置界面展示的名称；默认为该路由键。 */
  displayName?: string
  /**
   * 本路由上每个模型所说的线协议。省略会保留每个已安装目录模型自己的协议，
   * 而正因如此一条目录路由完全不需要协议；一条目录并不自带的路由则必须指名一个。
   */
  api?: string
  /** 本路由各个模型的端点；默认为已安装目录的端点。 */
  baseURL?: string
  /**
   * 本路由的模型目录。省略会原样提供该路由的已安装目录；一个显式列表会
   * 替换它，其中每个条目从同 id 的已安装模型那里取默认值来补全它未设置的字段。
   */
  models?: PiAiModelProfile[]
  /**
   * 按模型 id 组织的、已安装目录的定制项：每个条目用与某个 {@link models}
   * 条目相同的字段去重塑那一个模型，而目录的其余部分继续原样服务。
   * 只在一个没有 `models` 列表的目录路由上有意义——`models` 已经替换了目录，
   * 因此它旁边的一个覆盖项、在一条目录并不自带的路由上的一个覆盖项，
   * 或指名了一个目录并未描述的模型的覆盖项，都会被拒绝而不是被跳过。
   */
  modelOverrides?: Record<string, PiAiModelOverride>
  /**
   * pi-ai 的线兼容开关，为那些其协议声明了它们的本路由模型提供默认值；
   * 每个模型自己的 `compat` 逐字段覆盖。两者都未设置的，保留已安装目录
   * 条目中的那个值，然后是 pi-ai 自己的检测。一个本路由上没有模型能读取的
   * 开关会被拒绝，而不是看起来已被应用。
   */
  compat?: PiAiCompatProfile
  /**
   * 本路由所列出的、其条目与已安装目录都未给出容量的某个模型的上下文容量
   *（默认 262,144）。按构造它是一次猜测，因此一个其网关服务更小模型的部署
   * 可以在这里改正它。
   */
  defaultContextWindow?: number
  /**
   * 本路由所列出的、其条目与已安装目录都未给出容量的某个模型的输出能力
   *（默认 32,768）。这是给模型定尺寸；它自身从不成为一个按请求的上限。
   */
  defaultMaxTokens?: number
  /**
   * 本路由所列出的、其条目的 {@link PiAiModelProfile.input} 与已安装目录
   * 都未声明的某个模型的请求模态（默认 `[text]`）。与上面那些容量一样是
   * 一次兜底，而不是一次覆盖：一个目录模型保留该目录为它记录的那些模态，
   * 而该值从不收窄它们。一个服务着目录并未描述的视觉模型的网关，
   * 可以在这里一次性声明 `[text, image]`，而不是在每个条目上都声明。
   * 与某个条目的列表不同，这个列表不允许为空——它之下没有任何东西可以代为作答。
   */
  defaultInput?: PiAiModality[]
  /** 提供方请求头，在该 profile 解析时针对 Fetch 校验；保留名称由 Harness 归因胜出。 */
  headers?: Record<string, string>
  /** 与提供方无关的 pi-ai 推理强度。 */
  reasoning?: ModelThinkingLevel
  /** 那些支持它的推理提供方所使用的令牌预算。 */
  thinkingBudgets?: ThinkingBudgets
  /** 提示缓存保留偏好。 */
  cacheRetention?: CacheRetention
  /** 流式传输偏好。 */
  transport?: Transport
  /** HTTP/提供方 SDK 超时，以毫秒计。 */
  timeoutMs?: number
  /** WebSocket 连接超时，以毫秒计。 */
  websocketConnectTimeoutMs?: number
  /** 一次流式读取处于未完成状态时提供方的最大空闲时间。 */
  streamIdleTimeoutMs?: number
  /**
   * 每次请求中 base64 编码图像载荷的上限。当某次请求的图像累计量超出它时，
   * 最早的图像会被文本占位符替换，直到该请求放得下，于是一个很长的会话
   * 能够继续完成请求，而不是被一个请求大小上限拒绝。
   */
  maxRequestImageBytes?: number
  /** 每个确定性的内联请求版本的总像素预算。 */
  requestImagePixelBudget?: number
  /**
   * 每个确定性的内联请求版本的原始编码字节目标；
   * 当没有质量档位可用时使用最小的质量阶梯输出。
   */
  requestImageMaxBytes?: number
  /** 由提供方持有的模型请求重试策略；省略时使用 normal 模式并重试五次。 */
  retryPolicy?: RetryPolicyConfig
}

/** 已校验的 profile，带有它的路由戳，以及每个由适配器持有的默认值都已解析完成。 */
export interface ResolvedPiAiProviderProfile
  extends Omit<PiAiProviderProfile, 'apiKeyEnv' | 'retryPolicy' | 'models' | 'displayName'> {
  /** Harness 路由键，以及那个 `Models` 集合键（即配置字典的那个键）。 */
  provider: string
  /** 供选择器与配置界面使用的已解析展示名称。 */
  displayName: string
  /** 已校验的凭据引用，当配置了一个时。 */
  apiKeyEnv?: CredentialRef
  /** 默认值补全之后的正的有限提供方空闲间隔。 */
  streamIdleTimeoutMs: number
  /** 默认值补全之后的正的请求级 base64 图像载荷上限。 */
  maxRequestImageBytes: number
  /** 默认值补全之后的正的请求版本总像素预算。 */
  requestImagePixelBudget: number
  /** 默认值补全之后的正的请求版本原始字节目标；当没有质量档位可用时使用最小的质量阶梯输出。 */
  requestImageMaxBytes: number
  /** 随本提供方路由一起捕获的不可变重试策略。 */
  retryPolicy: ResolvedRetryPolicy
  /**
   * 含有本路由各个可服务模型的那个 pi-ai 提供方。当一条已存储的路由
   * 无法被构造时缺失；它的配置仍然可编辑。
   */
  piProvider?: Provider
  /** 首个模型诊断信息，或当没有可用的模型诊断信息时该路由的失败。 */
  catalogError?: string
  /** 在尝试请求之前报告的、按模型的失败。 */
  modelErrors: ReadonlyMap<string, string>
  /**
   * 本 profile 显式配置的、按模型 id 组织的按请求输出上限。
   * 该接缝只会把它物化进一次自身未指名任何上限的请求，
   * 因此一个目录能力绝不能出现在这里。
   */
  configuredMaxTokens: ReadonlyMap<string, number>
}

/** 插件配置：本实例所持有的各条提供方路由。 */
export interface Config {
  /**
   * 以提供方为键的各个 pi-ai 提供方路由。一个空的（或被省略的）字典
   * 就是那个由设置驱动的休眠姿态：该适配器以零条路由挂载，
   * 并在某个设置小节提供各个 profile 的那一刻注册它们。
   */
  providers: Volatile<Record<string, PiAiProviderProfile>>
}

/** 由提供方解析器接受的纯选项。 */
export type Options = { [K in keyof Config]?: Config[K] extends Volatile<infer T> ? T : never }

const thinkingBudgets = z.object({
  minimal: z.number(),
  low: z.number(),
  medium: z.number(),
  high: z.number(),
})

/**
 * 一个 `chat_template_kwargs` 或 `chat_template_args` 的值。那个 `$var`
 * 成员是 pi-ai 的占位符，用于让分发从该请求的思考状态填充一个值，
 * 而正是这一点让一个由模板驱动的网关无需复述它的模板就可被配置。
 */
const chatTemplateKwarg: z<ChatTemplateKwargValue> = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.const(null),
  z.object({
    $var: z.union(CHAT_TEMPLATE_VARS).required(),
    omitWhenOff: z.boolean(),
  }),
])

const compatProfile: z<PiAiCompatProfile> = z.object({
  supportsStore: z.boolean(),
  supportsDeveloperRole: z.boolean(),
  supportsReasoningEffort: z.boolean(),
  supportsUsageInStreaming: z.boolean(),
  supportsFinishReason: z.boolean(),
  maxTokensField: z.union(MAX_TOKENS_FIELDS),
  requiresToolResultName: z.boolean(),
  requiresAssistantAfterToolResult: z.boolean(),
  requiresThinkingAsText: z.boolean(),
  requiresReasoningContentOnAssistantMessages: z.boolean(),
  thinkingFormat: z.union(SUPPORTED_THINKING_FORMATS),
  chatTemplateKwargs: z.dict(chatTemplateKwarg),
  chatTemplateArgs: z.dict(chatTemplateKwarg),
  supportsThinkingTokenBudget: z.boolean(),
  thinkingTokenBudgetField: z.union(THINKING_TOKEN_BUDGET_FIELDS),
  vllmPriority: z.number().step(1),
  supportsMaxOutputTokens: z.boolean(),
  supportsStrictMode: z.boolean(),
  cacheControlFormat: z.union(CACHE_CONTROL_FORMATS),
  supportsLongCacheRetention: z.boolean(),
  supportsEagerToolInputStreaming: z.boolean(),
  supportsCacheControlOnTools: z.boolean(),
  supportsTemperature: z.boolean(),
  forceAdaptiveThinking: z.boolean(),
  allowEmptySignature: z.boolean(),
  supportsStrictTools: z.boolean(),
})

/**
 * 各个键是被提供的强度，各个值是它们的线路拼写。一个无值的键（`off:`）
 * 能够存活下来，是因为 schemastery 会在任何成员 schema 运行之前把可空数据
 * 原样放过——`z.const(null)` 只控制对于非 null 错误值的报错，
 * 以及某个配置 UI 渲染什么。只有解析才会决定哪些强度可以让该值为空，
 * 因此那条诊断信息才能指名该路由与模型。该断言收窄了 schemastery 的
 * `Dict`，后者把每个字面量键都类型化为必填；字典校验只检查存在的键，
 * 因此运行期的值是一个部分记录。
 */
const reasoningEfforts = z.dict(
  z.union([z.string(), z.const(null)]),
  z.union(THINKING_LEVELS),
) as unknown as z<PiAiReasoningEfforts>

/** 一个 `models` 条目与一个 `modelOverrides` 值所共享的那些字段；只有 id 的归属不同。 */
const modelFields = {
  name: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  // 没有显式的默认值，这与该路由的 `defaultInput` 不同：schemastery 会把一个
  // 缺失的数组物化为 `[]`，而解析把它读作“这里没有答案”，
  // 于是下面的目录条目仍然适用。
  input: z.array(z.union(MODALITIES)),
  // 用这个联合，而不是一个裸字典：schemastery 把一个缺失的字典物化为 `{}`，
  // 而缺失必须保持可区分——它意味着“继承已安装目录的能力”，
  // 而 `false` 则是禁用推理。
  reasoningEfforts: z.union([z.const(false), reasoningEfforts]),
  compat: compatProfile,
}

const modelProfile: z<PiAiModelProfile> = z.object({
  id: z.string().required(),
  ...modelFields,
})

/** 一个其 id 位于 `modelOverrides` 字典键中的 {@link modelProfile}。 */
const modelOverride: z<PiAiModelOverride> = z.object(modelFields)

const profile = z.object({
  apiKeyEnv: z.string().role('credential-ref'),
  displayName: z.string(),
  api: z.union(supportedProtocols()),
  baseURL: z.string(),
  models: z.array(modelProfile),
  modelOverrides: z.dict(modelOverride),
  compat: compatProfile,
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  defaultMaxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
  defaultInput: z.array(z.union(MODALITIES)).default([...DEFAULT_INPUT]),
  headers: z.dict(z.string()),
  reasoning: z.union(THINKING_LEVELS),
  thinkingBudgets,
  cacheRetention: z.union(['none', 'short', 'long']),
  transport: z.union(['sse', 'websocket', 'websocket-cached', 'auto']),
  timeoutMs: z.natural(),
  websocketConnectTimeoutMs: z.natural(),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  maxRequestImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_REQUEST_IMAGE_BYTES),
  requestImagePixelBudget: z.number().step(1).min(1).default(DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET),
  requestImageMaxBytes: z.number().step(1).min(1).default(DEFAULT_REQUEST_IMAGE_MAX_BYTES),
  retryPolicy: RetryPolicySchema,
})

/** {@link Config} 的运行时 schema。 */
export const Config = z.object({
  providers: z.dict(profile).default({}).volatile(),
})

/**
 * 拒绝那些无法被服务的、新增或已变更的提供方 profile。未发生变化的
 * 已存储 profile 在一次目录升级之后可能需要修复，而它们不会阻塞对另一个
 * 提供方的编辑。被移除的 profile 不需要任何目录校验。
 * @param config - 要检查的那个已解析小节。
 * @param previous - 当前的已解析小节；省略时检查每一个提供方。
 * @throws Error 指名那条无法被服务的路由与配置条目。
 */
export function assertServiceable(config: Options, previous?: Options): void {
  const changed = Object.fromEntries(Object.entries(config.providers ?? {}).filter(([provider, profile]) =>
    !deepEqualJson(profile, previous?.providers?.[provider])))
  resolveProfiles(changed)
}

/** 拒绝被移除的预发布 profile 字段，并指名它们的替代项。 */
function rejectRemovedFields(provider: string, source: PiAiProviderProfile): void {
  const legacy = source as PiAiProviderProfile & {
    provider?: unknown
    maxRetries?: unknown
    maxRetryDelayMs?: unknown
  }
  if ('provider' in legacy) {
    throw new Error(`llm-pi-ai: provider "${provider}" sets "provider", which moved to the providers dict key`)
  }
  if ('maxRetries' in legacy || 'maxRetryDelayMs' in legacy) {
    throw new Error(
      `llm-pi-ai: provider "${provider}" sets maxRetries or maxRetryDelayMs, which were removed;`
      + ' compose agent recovery with dsh-llm-retry',
    )
  }
}

/** 拒绝一个 Fetch 无法放到某个提供方请求上的 profile 请求头。 */
function assertValidHeaders(provider: string, headers: Readonly<Record<string, string>> | undefined): void {
  for (const [name, value] of Object.entries(headers ?? {})) {
    try {
      new Headers([[name, value]])
    } catch {
      throw new Error(
        `llm-pi-ai: provider "${provider}" header "${name}" is not valid for Fetch;`
        + ' use a valid HTTP field name and a single-line value representable as bytes',
      )
    }
  }
}

/**
 * 解析各个标量的默认值，并物化每条路由的各个可服务模型。
 * 延后的目录校验保留诊断信息，而不删除已配置的路由。
 * 一个被省略的字典解析为那个空的、处于休眠的路由集合。
 * @param providers - 以路由为键的各个已配置提供方 profile。
 * @param validation - 写入需要一个完整的目录；已存储的读取保留目录诊断信息。
 * @returns 按配置顺序排列的各个已校验 profile。
 */
export function resolveProfiles(
  providers: Readonly<Record<string, PiAiProviderProfile>> | undefined,
  validation: 'strict' | 'deferred' = 'strict',
): Map<string, ResolvedPiAiProviderProfile> {
  if (Array.isArray(providers)) {
    throw new Error('llm-pi-ai: providers is now a dict keyed by provider route, not an array of profiles')
  }
  const entries = Object.entries(providers ?? {})
  const resolved = new Map<string, ResolvedPiAiProviderProfile>()
  for (const [provider, source] of entries) {
    rejectRemovedFields(provider, source)
    if (provider.length === 0) throw new Error('llm-pi-ai: provider names must be non-empty')
    if (source.baseURL !== undefined && source.baseURL.length === 0) {
      throw new Error(`llm-pi-ai: provider "${provider}" has an empty baseURL`)
    }
    if (source.displayName !== undefined && source.displayName.length === 0) {
      throw new Error(`llm-pi-ai: provider "${provider}" has an empty displayName`)
    }
    assertValidHeaders(provider, source.headers)
    const streamIdleTimeoutMs = source.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
    if (!Number.isFinite(streamIdleTimeoutMs)
      || streamIdleTimeoutMs <= 0
      || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
      throw new Error(
        `llm-pi-ai: provider "${provider}" streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
      )
    }
    const maxRequestImageBytes = source.maxRequestImageBytes ?? DEFAULT_MAX_REQUEST_IMAGE_BYTES
    if (!Number.isInteger(maxRequestImageBytes) || maxRequestImageBytes <= 0) {
      throw new Error(`llm-pi-ai: provider "${provider}" maxRequestImageBytes must be a positive integer`)
    }
    const requestImagePixelBudget = source.requestImagePixelBudget ?? DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET
    if (!Number.isSafeInteger(requestImagePixelBudget) || requestImagePixelBudget <= 0) {
      throw new Error(`llm-pi-ai: provider "${provider}" requestImagePixelBudget must be a positive safe integer`)
    }
    const requestImageMaxBytes = source.requestImageMaxBytes ?? DEFAULT_REQUEST_IMAGE_MAX_BYTES
    if (!Number.isSafeInteger(requestImageMaxBytes) || requestImageMaxBytes <= 0) {
      throw new Error(`llm-pi-ai: provider "${provider}" requestImageMaxBytes must be a positive safe integer`)
    }
    // 之所以从那个配置对象上分离出来，是因为 pi-ai 把 `Model.input`
    // 类型化为可变的。schema 的显式默认值涵盖了一个缺失的键，
    // 因此这里一个空列表总是某人键入的——而与某个条目的列表不同，
    // 它之下没有任何东西可以代为作答——所以它被拒绝，而不是被读作“没有答案”。
    const defaultInput = [...source.defaultInput ?? DEFAULT_INPUT]
    if (defaultInput.length === 0) {
      throw new Error(`llm-pi-ai: provider "${provider}" defaultInput must name at least one modality`)
    }
    // 用的是那个路由键，而不是已安装提供方自己的名称：目录一直展示的是
    // 路由键，而一条目录路由绝不能仅仅因为它获得了一份 profile，
    // 就在每个配置界面上悄然重命名自己。
    const displayName = source.displayName ?? provider
    let catalog: RouteCatalog | undefined
    let piProvider: Provider | undefined
    let catalogError: string | undefined
    try {
      catalog = resolveRouteModels({
        provider,
        ...source.api === undefined ? {} : { api: source.api },
        ...source.baseURL === undefined ? {} : { baseURL: source.baseURL },
        ...source.models === undefined ? {} : { models: source.models },
        ...source.modelOverrides === undefined ? {} : { modelOverrides: source.modelOverrides },
        ...source.compat === undefined ? {} : { compat: source.compat },
        defaultInput,
        defaultContextWindow: source.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
        defaultMaxTokens: source.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
      }, validation)
      catalogError = catalog.modelErrors.values().next().value
      piProvider = buildProvider({
        provider,
        displayName,
        ...source.api === undefined ? {} : { api: source.api },
        ...source.baseURL === undefined ? {} : { baseURL: source.baseURL },
        models: catalog.models,
        namesCredential: source.apiKeyEnv !== undefined,
      })
    } catch (error) {
      if (validation === 'strict' || !(error instanceof PiAiCatalogError)) throw error
      catalogError ??= error.message
    }
    const { apiKeyEnv, retryPolicy, models: _models, displayName: _displayName, ...rest } = source
    resolved.set(provider, {
      ...rest,
      provider,
      displayName,
      ...apiKeyEnv === undefined ? {} : { apiKeyEnv: credentialRef(apiKeyEnv) },
      streamIdleTimeoutMs,
      maxRequestImageBytes,
      requestImagePixelBudget,
      requestImageMaxBytes,
      retryPolicy: resolveRetryPolicy(retryPolicy, `llm-pi-ai: provider "${provider}" retryPolicy`),
      ...rest.headers === undefined ? {} : { headers: { ...rest.headers } },
      ...rest.thinkingBudgets === undefined ? {} : { thinkingBudgets: { ...rest.thinkingBudgets } },
      configuredMaxTokens: catalog?.configuredMaxTokens ?? new Map(),
      modelErrors: catalog?.modelErrors ?? new Map(),
      ...piProvider === undefined ? {} : { piProvider },
      ...catalogError === undefined ? {} : { catalogError },
    })
  }
  return resolved
}
