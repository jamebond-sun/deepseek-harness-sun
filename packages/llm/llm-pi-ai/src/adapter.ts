/**
 * Harness LLM 接缝的、由 pi-ai 支撑的通用实现。
 *
 * 每次解析都产出一个**不可变的**快照——各个 profile，外加一个持有
 * 每条路由所构建出的 `Provider` 的 `Models` 集合——而一次操作会在它的
 * 第一个 `await` 之前捕获整个快照。一次配置变更会构建一个*新的*集合，
 * 而不是改动正在使用中的那个，因为 `Models.streamSimple()` 是惰性的：
 * 它在流首次被消费时才解析那个提供方，而那时已经在凭据 await 之后，
 * 因此一个被改动的集合会让一个在某份配置下开始的请求在另一份配置下
 * 结束——或者以一个已不存在的提供方失败。正是这一点让该接缝的按步骤
 * 调用冻结（`llm.prepareCall()`）一路保持到底：在一次回复中途切换模型
 * 会在下一个步骤生效，而绝不会在正在进行中的那个步骤内部生效。
 *
 * 一条指名了凭据引用的路由仍然通过 harness 接缝解析它，并把它作为
 * 该请求的 `apiKey` 选项传入，而 pi-ai 把它当作最高优先级的认证覆盖——
 * 正是这一点保持了引用语义的响亮失败。该覆盖没有涵盖的一切都通过
 * 集合自己的认证到达 pi-ai：凭据存储持有一次登录所写入、并由一次刷新
 * 轮转的那些记录，而认证上下文回答某个提供方在解析时所问的那些环境问题。
 * 两者在快照之间保持稳定，因此一次配置变更会重建集合，而不会忘记
 * 谁已经登录。
 *
 * @module dsh-llm-pi-ai/adapter
 */

import type {
  Api,
  AuthContext,
  CredentialStore,
  Model,
  Models,
  ModelThinkingLevel,
  MutableModels,
  SimpleStreamOptions,
  ThinkingLevel,
} from '@earendil-works/pi-ai'
import {
  attributionHeaders,
  contentHasImage,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  ImageAttachmentAccess,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  ReasoningEffortId as ReasoningEffortIdType,
  ResolvedRetryPolicy,
  StreamChunk,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { ResolvedPiAiProviderProfile } from './config.ts'
import { requestImageTarget, toPiContext } from './context.ts'
import { conversationUpdates, createModels, getSupportedThinkingLevels } from './models.ts'
import { toStreamChunks } from './stream.ts'

/**
 * 被加入一个 Anthropic 请求的、初始即处于激活状态的声明，
 * 当该项目投影出来的工具全部是延迟加载时——因为 Anthropic 会拒绝
 * 一个没有任何激活项的工具列表。
 */
const ANTHROPIC_TOOL_UPDATE_PLACEHOLDER: ToolSchema = {
  name: 'DeferredToolPlaceholder',
  description: 'Reserved placeholder that keeps deferred tool loading active; never call this tool.',
  parameters: { type: 'object', properties: {} },
}

/** 一次解析的冻结视图：各个 profile，以及由它们构建出来的集合。 */
interface PiAiSnapshot {
  /** 构建本集合所依据的那些已解析 profile，被用作它的身份。 */
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /** 恰好对应那些 profile 的各个提供方；一旦发布就绝不被改动。 */
  models: Models
}

/** {@link PiAiAdapter} 的构造选项：由该插件持有的两个解析钩子。 */
export interface PiAiAdapterOptions {
  /** 按提供方路由组织的、当前已校验的 profile；每次操作调用一次。 */
  profiles: () => ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /**
   * 为一个已解析的 profile 解析凭据；每次流式调用调用一次并为该次调用冻结，
   * 也会被 `listModels` 调用——当它抛出 `MISSING_CREDENTIAL` 时不提供任何模型。
   * `undefined` 会委派给该路由自己的 pi-ai 认证，而对于一条已安装的目录路由，
   * 那就是它的提供方原生环境发现；该插件只允许一个完全没有指名任何凭据的
   * profile 这样做，因为一个指名了却未命中的引用会以 `LlmError`
   * `MISSING_CREDENTIAL` 抛出，而不是回退。
   */
  resolveApiKey: (provider: string, profile: ResolvedPiAiProviderProfile) => Promise<string | undefined>
  /**
   * 本适配器所构建的每个集合如何解析那些请求级 `apiKey` 覆盖没有涵盖的认证。
   * 它是必需的而非可选的：一个没有它们就构建出来的集合会得到 pi-ai 的
   * 内存默认存储，而它在每次启动时都是空的，并且在每次配置变更时被丢弃，
   * 因此一条其唯一方式是登录的路由会在每次请求上报告自己未被配置，
   * 无论人类登录了多少次。
   */
  auth: PiAiAuthInjection
  /** 在请求时解析可选的持久化附件服务。 */
  resolveAttachments?: () => AttachmentStore | undefined
  /** 把一个附件引用桥接到当前的模型工具执行世界。 */
  resolveImageAccess?: (attachments: AttachmentStore, ref: ImageAttachmentRef) => ImageAttachmentAccess | undefined
  /**
   * 观察一条助手历史消息因其已存储的回放状态无法被本构建使用，
   * 而降级为与提供方无关的转换。
   */
  onReplayDegrade?: (detail: { provider: string; model: string; reason: string }) => void
}

/** 构建一个 pi-ai 集合时所用的那两个认证注入项。 */
export interface PiAiAuthInjection {
  /** 供 pi-ai 自己写入的那些凭据使用的持久化存储：登录，以及它在自己的锁之下运行的刷新。 */
  credentials: CredentialStore
  /** 某个提供方在解析自己的认证时所执行的环境查找。 */
  authContext: AuthContext
}

/** 把 profile 的流开关复制进 pi-ai 的通用选项词汇。 */
function profileOptions(
  profile: ResolvedPiAiProviderProfile,
  reasoning: ModelThinkingLevel | undefined,
  apiKey: string | undefined,
): SimpleStreamOptions {
  const enabledReasoning: ThinkingLevel | undefined = reasoning === 'off' ? undefined : reasoning
  return {
    ...apiKey === undefined ? {} : { apiKey },
    ...enabledReasoning === undefined ? {} : { reasoning: enabledReasoning },
    ...profile.thinkingBudgets === undefined ? {} : { thinkingBudgets: profile.thinkingBudgets },
    ...profile.cacheRetention === undefined ? {} : { cacheRetention: profile.cacheRetention },
    ...profile.transport === undefined ? {} : { transport: profile.transport },
    ...profile.timeoutMs === undefined ? {} : { timeoutMs: profile.timeoutMs },
    ...profile.websocketConnectTimeoutMs === undefined ? {} : { websocketConnectTimeoutMs: profile.websocketConnectTimeoutMs },
    // 那个 agent 恢复层持有可见的尝试；一次适配器调用就是一次 SDK 尝试。
    maxRetries: 0,
  }
}

/**
 * 这条精确模型实际可以采取的那个 profile 默认值，用于**描述**它。
 * 一个该模型并不支持的已配置强度会得出 none 而不是抛错：
 * `resolveModel` 构建的是模型目录，而一个失败的目录会把它的整个提供方
 * 从每个选择器中移走——于是 profile 上一个设置错误的字段会隐藏该路由上的
 * 每一个模型，包括那些支持该强度的模型。请求路径仍然会拒绝，
 * 而那正是一份错误配置应当待的地方：描述一个模型能做什么，
 * 绝不能因为某个部署要求了它做不到的事情而失败。
 * @param model - 已解析的模型描述符。
 * @param effort - 该 profile 已配置的强度，若有。
 * @returns 当该模型支持它时返回该强度，否则返回 undefined。
 */
function describableReasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffortIdType | ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  return getSupportedThinkingLevels(model).some(level => level === effort)
    ? effort as ModelThinkingLevel
    : undefined
}

/** 校验一个显式的 Harness/profile 强度，而不调用 pi-ai 的钳制。 */
function resolveReasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffortIdType | ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  const supported = getSupportedThinkingLevels(model)
  if (supported.some(level => level === effort)) return effort as ModelThinkingLevel
  throw new LlmError(
    `pi-ai provider "${model.provider}" model "${model.id}" does not support reasoning effort "${effort}"`,
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

/**
 * 一个模型的可选推理强度，或者干脆什么都没有。
 *
 * 一个不携带任何推理元数据的模型——每一个手工声明的模型，以及每个被
 * pi-ai 标记为非推理的目录模型——都会被 pi-ai 报告为支持单一的
 * `off` 强度。把它透传会提供一个做不到它所说的控制项：`off` 被翻译为
 * *省略*那个推理选项，而对这样一个模型而言，这与不指名任何强度
 * 是逐字节相同的请求——于是一个其自身默认就是去思考的提供方，
 * 在选中 `off` 的情况下仍然会继续思考。完全省略 `reasoning` 是该接缝
 * 表达这项能力不可用的方式，于是界面只提供该提供方的默认值。
 * @param model - 已解析的模型描述符。
 * @param defaultLevel - 该 profile 已配置的强度，已经过校验。
 * @returns 那个 `reasoning` 字段，或一个空对象（当无法提供任何强度时）。
 */
function reasoningInfo(
  model: Model<Api>,
  defaultLevel: ModelThinkingLevel | undefined,
): Pick<LlmResolvedModelInfo, 'reasoning'> | Record<string, never> {
  if (!model.reasoning) return {}
  const levels = getSupportedThinkingLevels(model)
  return {
    reasoning: {
      efforts: levels.map(level => ({
        id: ReasoningEffortId(level),
        name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`,
      })),
      ...defaultLevel === undefined ? {} : { defaultEffort: ReasoningEffortId(defaultLevel) },
    },
  }
}

/** 合并部署提供的请求头，同时移除大小写不敏感的归因冲突项。 */
function requestHeaders(headers: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const attribution = attributionHeaders()
  const reserved = new Set(Object.keys(attribution).map(name => name.toLowerCase()))
  return {
    ...Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !reserved.has(name.toLowerCase()))),
    ...attribution,
  }
}

/**
 * 由 pi-ai 支撑的多提供方适配器。每次操作都读取当前的各个 profile，
 * 因此一次配置变更无需重启就能到达下一次请求；模型描述符来自那些
 * profile 所构建出来的集合。
 */
export class PiAiAdapter extends LlmAdapter {
  private snapshot: PiAiSnapshot | undefined

  constructor(private readonly config: PiAiAdapterOptions) {
    super()
  }

  override imageRequestTarget(provider: string, model: string, image: ImageAttachmentRef) {
    const snapshot = this.current()
    this.modelOf(snapshot, provider, model)
    const profile = this.profileOf(snapshot, provider)
    return requestImageTarget(image, { maxPixels: profile.requestImagePixelBudget, maxBytes: profile.requestImageMaxBytes })
  }

  /**
   * 当前各个 profile 的那个快照。解析会记住它的结果，因此一份未变化的
   * 配置会按身份被识别出来；一份已变化的配置会得到一个全新的集合，
   * 从而让某个操作已经捕获的任何快照在该操作持有它的期间保持不受影响。
   */
  private current(): PiAiSnapshot {
    const profiles = this.config.profiles()
    if (this.snapshot?.profiles === profiles) return this.snapshot
    const models: MutableModels = createModels(this.config.auth)
    for (const profile of profiles.values()) {
      if (profile.piProvider !== undefined) models.setProvider(profile.piProvider)
    }
    this.snapshot = { profiles, models }
    return this.snapshot
  }

  /** 某个快照中一条路由的 profile，或那个未持有的失败。 */
  private profileOf(snapshot: PiAiSnapshot, provider: string): ResolvedPiAiProviderProfile {
    const profile = snapshot.profiles.get(provider)
    if (profile === undefined) {
      throw new LlmError(`pi-ai adapter does not own provider "${provider}"`, 'NO_ADAPTER')
    }
    return profile
  }

  /** 某个快照中一对精确的路由/模型所对应的已配置描述符。 */
  private modelOf(snapshot: PiAiSnapshot, provider: string, model: string): Model<Api> {
    const profile = this.profileOf(snapshot, provider)
    const failure = profile.modelErrors.get(model)
      ?? (profile.piProvider === undefined ? profile.catalogError : undefined)
    if (failure !== undefined) throw new LlmError(failure, 'INVALID_CONFIG')
    const resolved = snapshot.models.getModel(provider, model)
    if (resolved === undefined) {
      throw new LlmError(`pi-ai provider "${provider}" has no configured model "${model}"`, 'UNKNOWN_MODEL')
    }
    return resolved
  }

  override providerInfo(provider: string): LlmProviderInfo {
    // 已配置的名称，而不是路由键：`displayName` 之所以存在，就是为了让一个
    // 部署能给一条路由贴标签，而一个只有配置界面会读取的标签会让每个
    // 选择器都在显示那个原始的键。
    return { id: provider, name: this.current().profiles.get(provider)?.displayName ?? provider }
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.current().profiles.get(provider)?.retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve().then(async () => {
      const snapshot = this.current()
      const profile = this.profileOf(snapshot, provider)
      try { await this.config.resolveApiKey(provider, profile) }
      catch (error) {
        // 一条其已指名密钥无法解析的路由无法服务请求，
        // 因此在密钥被存储之前它不提供任何模型。
        if (error instanceof LlmError && error.code === 'MISSING_CREDENTIAL') return []
        throw error
      }
      return snapshot.models.getModels(provider).map(model => ({
        provider,
        id: model.id,
        name: model.name,
        inputModalities: [...model.input],
      }))
    })
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve().then(() => {
      const snapshot = this.current()
      return this.modelInfo(snapshot, provider, model)
    })
  }

  private modelInfo(snapshot: PiAiSnapshot, provider: string, model: string): LlmResolvedModelInfo {
    const profile = this.profileOf(snapshot, provider)
    const resolvedModel = this.modelOf(snapshot, provider, model)
    const defaultLevel = describableReasoningLevel(resolvedModel, profile.reasoning)
    // 只有由部署配置的上限才是一个请求默认值；
    // 目录的 `maxTokens` 用于给模型定尺寸，并到此为止。
    const configuredMaxTokens = profile.configuredMaxTokens.get(model)
    return {
      provider,
      id: model,
      name: resolvedModel.name,
      inputModalities: [...resolvedModel.input],
      context: { contextWindow: resolvedModel.contextWindow },
      ...configuredMaxTokens === undefined ? {} : { defaultMaxTokens: configuredMaxTokens },
      ...reasoningInfo(resolvedModel, defaultLevel),
      ...conversationUpdates(resolvedModel),
    }
  }

  override prepareCall(provider: string, model: string, _signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const snapshot = this.current()
    return Promise.resolve({
      model: this.modelInfo(snapshot, provider, model),
      stream: options => this.streamWithSnapshot(options, snapshot),
    })
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamWithSnapshot(options, this.current())
  }

  private async * streamWithSnapshot(
    options: GenerateOptions,
    snapshot: PiAiSnapshot,
  ): AsyncIterable<StreamChunk> {
    if (options.stop !== undefined) {
      throw new LlmError('llm-pi-ai does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION')
    }
    // 每次流式调用一次捕获，且在任何 await 之前完成：那个 profile、
    // 那个模型描述符，以及那个集合全部来自同一个不可变快照，
    // 而凭据与它们一起冻结。请求中途的一次配置变更会构建一个独立的快照，
    // 因此本次请求会在它开始时所用的那个之下结束，而下一次调用会拾取新的那个。
    const profile = this.profileOf(snapshot, options.provider)
    const model = this.modelOf(snapshot, options.provider, options.model)
    const updates = conversationUpdates(model)
    // pi-ai 会折叠掉没有初始激活声明的 Anthropic 工具更新。
    const tools = options.tools ?? []
    const needsPlaceholder = model.api === 'anthropic-messages' && updates.toolUpdate === 'in-history'
      && tools.every(tool => tool.deferLoading === true)
      && options.messages.some(message => message.role === 'developer'
        && message.content.some(block => block.type === 'tool-addition' || block.type === 'tool-removal'))
    const request = needsPlaceholder
      ? { ...options, tools: [ANTHROPIC_TOOL_UPDATE_PLACEHOLDER, ...tools] }
      : options
    const reasoning = resolveReasoningLevel(
      model,
      options.reasoningEffort ?? profile.reasoning,
    )
    const apiKey = await this.config.resolveApiKey(options.provider, profile)

    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    const streamIdleTimeoutMs = profile.streamIdleTimeoutMs
    using watchdog = idleWatchdog(upstream, streamIdleTimeoutMs, 'LLM_STREAM_IDLE_TIMEOUT')

    try {
      const containsImage = options.messages.some(message => contentHasImage(message.content))
      if (containsImage && !model.input.includes('image')) {
        throw new LlmError(`pi-ai model "${model.id}" does not support image input`, 'UNSUPPORTED_CONTENT')
      }
      const attachments = containsImage ? this.config.resolveAttachments?.() : undefined
      if (containsImage && attachments === undefined) {
        throw new LlmError('pi-ai image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
      }
      const onReplayDegrade = (reason: string): void => {
        this.config.onReplayDegrade?.({ provider: options.provider, model: options.model, reason })
      }
      const context = attachments === undefined
        ? toPiContext(request, undefined, onReplayDegrade)
        : await toPiContext({ ...request, signal: watchdog.signal }, {
          attachments,
          resolveImageAccess: ref => this.config.resolveImageAccess?.(attachments, ref),
          maxRequestImageBytes: profile.maxRequestImageBytes,
          requestImagePolicy: {
            maxPixels: profile.requestImagePixelBudget,
            maxBytes: profile.requestImageMaxBytes,
          },
        }, onReplayDegrade)
      const events = snapshot.models.streamSimple(model, context, {
        ...profileOptions(profile, reasoning, apiKey),
        ...options.temperature === undefined ? {} : { temperature: options.temperature },
        ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
        ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
        signal: watchdog.signal,
        // profile 的请求头由部署持有；归因名称由 Harness 持有，
        // 因此在冲突时胜出。
        headers: requestHeaders(profile.headers),
      })
      const iterator = toStreamChunks(events, model.contextWindow, options.signal, model.id)[Symbol.asyncIterator]()
      let exhausted = false
      try {
        while (true) {
          const result = await watchdog.next(iterator)
          if (result.done) {
            exhausted = true
            return
          }
          yield result.value
        }
      } finally {
        if (!exhausted) {
          consumer.abort('pi-ai stream consumer stopped')
          // 一次被截止时间放弃的需求可能永远处于待定状态，而本生成器
          // 会把自己的 return 排在它之后；上面的 abort 负责 SDK 的终止。
          /* v8 ignore next -- 该分离的排空只在展开一个被放弃的流时才会 reject。 */
          void iterator.return(undefined).catch(() => {})
        }
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT') !== undefined) {
        throw new LlmError(`pi-ai stream idle timeout after ${streamIdleTimeoutMs}ms`, 'TIMEOUT', { cause: error })
      }
      if (options.signal?.aborted) {
        throw new LlmError('pi-ai request aborted by caller', 'ABORTED', { cause: error })
      }
      throw error
    } finally {
      consumer.abort('pi-ai stream consumer stopped')
    }
  }
}
