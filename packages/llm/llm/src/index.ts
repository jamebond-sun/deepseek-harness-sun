/**
 * LLM 服务：带有一个可被瀑布拦截的流式调用 API 的适配器注册表。
 * 它导出默认的 `LlmRuntime`、供提供方后端使用的抽象 `LlmAdapter`，
 * 以及用于块装配的 `BlockAssembler`。
 *
 * @module @deepseek-ai/dsh-llm
 */

import { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type {
  GenerateOptions,
  RequestMessage,
  LlmConfigurableProvider,
  LlmDiscoveredModel,
  LlmFailure,
  LlmImageRequestPricing,
  LlmModelContext,
  LlmModelDiscoveryRequest,
  LlmModelInfo,
  LlmResolvedModelInfo,
  LlmProviderInfo,
  ModelModality,
  StreamChunk,
  SystemPromptUpdate,
  ToolSchema,
  ToolUpdate,
} from './types.ts'
import { freezeMessage } from './message.ts'
import { resolveRetryPolicy } from './retry-policy.ts'
import type { ResolvedRetryPolicy } from './retry-policy.ts'
import type { ProviderRequestId } from './brand.ts'
import { callConfigEquals } from './call-config.ts'
import type { ConfigureCall, LlmCallConfig, LlmCallConfigAdapterDefaults } from './call-config.ts'
import { HarnessError, INVALID_CREDENTIAL_CODE } from './error.ts'
import { normalizeLlmFailure } from './adapter-failure.ts'
import { normalizeApiKey } from './api-key.ts'
import {
  contentHasFile, contentHasImage, fileHandleText, projectFilesToText, projectImagesForTextModel, projectToolUpdates,
} from './content.ts'
import type { FileAttachmentRef, ImageAttachmentRef, ImageRequestTarget } from '@deepseek-ai/dsh-attachment'

export * from './attribution.ts'
export * from './brand.ts'
export * from './error.ts'
export * from './api-key.ts'
export * from './types.ts'
export * from './content.ts'
export * from './assistant-stream.ts'
export * from './message.ts'
export * from './retry-policy.ts'
export { BlockAssembler } from './assembler.ts'
export { callConfigEquals, isAgentLoopRequest, markAgentLoopRequest } from './call-config.ts'
export type { ConfigureCall, LlmCallConfig, LlmCallConfigAdapterDefaults, LlmCallControls } from './call-config.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    llm: LlmRuntime
  }

  interface Events {
    /**
     * 围绕每次流式模型调用的瀑布（重试、回放、路由）。
     * 它绑定到 {@link LlmRuntime}；调用 `next()` 以到达已解析适配器的流，
     * 或者产出你自己的块以短路。
     * @param options - 完整的请求。一个由循环构建的请求携带进程局部的
     *   {@link markAgentLoopRequest} 身份，并且是深度冻结地到达的（改动会抛错）：
     *   它的内容是会话日志的一个纯函数（可重建性 Agent Note），
     *   因此各个监听器读取它，绝不重写它。手工构建的调用不携带那个标记；
     *   调用方拥有自己的请求输入，并且必须在流落定之前保持它们不变。
     * @mode waterfall
     */
    'llm/stream'(this: LlmRuntime, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>

  }
}

/** 由 {@link LlmError} 接受的、结构化的提供方事实与 cause。 */
export interface LlmErrorOptions extends ErrorOptions {
  /** 在提供方边界处观测到的有效 HTTP 状态码。 */
  status?: number
  /** 提供方要求的、正的有限延迟，以毫秒计。 */
  providerRetryAfterMs?: number
  /** 非空的、不透明的提供方请求 id。 */
  requestId?: ProviderRequestId
  /** 还需额外卸载的最早的被保留图像出现的正数个数；仅配合 `IMAGE_OFFLOAD_REQUIRED`。 */
  offloadImages?: number
}

/**
 * 面向 LLM 相关失败的带类型错误。它继承 {@link HarnessError}，
 * 因此那个 `code` 字符串（例如 `AUTH`、`RATE_LIMIT`、`NO_ADAPTER`）
 * 属于共享的分类法。
 */
export class LlmError extends HarnessError {
  /** 留存在这个存活的 Error 旁边的、可序列化的事实。 */
  readonly failure: LlmFailure

  /**
   * @param message - 非空的、人类可读的失败摘要。
   * @param code - 非空的、稳定的、与提供方无关的机器码。
   * @param options - 可选的 cause，以及已校验的可序列化提供方事实。
   */
  constructor(message: string, code: string, options?: LlmErrorOptions) {
    if (typeof message !== 'string' || message.length === 0) throw new Error('LlmError message must be a non-empty string')
    if (typeof code !== 'string' || code.length === 0) throw new Error('LlmError code must be a non-empty string')
    if (options?.status !== undefined
      && (!Number.isInteger(options.status) || options.status < 100 || options.status > 599)) {
      throw new Error('LlmError status must be an integer from 100 through 599')
    }
    if (options?.providerRetryAfterMs !== undefined
      && (!Number.isFinite(options.providerRetryAfterMs) || options.providerRetryAfterMs <= 0)) {
      throw new Error('LlmError providerRetryAfterMs must be a positive finite number')
    }
    if (options?.requestId !== undefined
      && (typeof options.requestId !== 'string' || options.requestId.length === 0)) {
      throw new Error('LlmError requestId must be a non-empty string')
    }
    super(message, code, options)
    this.name = 'LlmError'
    this.failure = Object.freeze({
      message,
      code,
      ...options?.status === undefined ? {} : { status: options.status },
      ...options?.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: options.providerRetryAfterMs },
      ...options?.requestId === undefined ? {} : { requestId: options.requestId },
      ...options?.offloadImages === undefined ? {} : { offloadImages: options.offloadImages },
    })
  }
}

/**
 * 接受一个所提供的凭据，或把它当作不可用而拒绝。
 *
 * 一个已存储的密钥来自凭据接缝、某一行 `.env`，或一次 shell 导出，
 * 它们都会带上周围的空白，因此裁剪是静默的。其他任何问题都在这里失败，
 * 而不是在 `fetch` 内部——后者对 ByteString 的拒绝只会指名一个 UTF-16
 * 码位，而不是要改动哪个设置。该密钥绝不进入消息：`ref` 指名在哪里修复它，
 * 而把机密任何一部分回显到日志或 UI 正是这一诊断要避免的失败。
 *
 * 它放在 {@link LlmError} 旁边而不是 `./api-key.ts` 中，是为了让那个
 * 判定模块保持无依赖；两个适配器共享这一个诊断，而不是各自保留
 * 近乎相同的本地副本。
 * @param raw - 该凭据被提供时的原本形式。
 * @param pkg - 执行拒绝的包名，作为该诊断信息的前缀。
 * @param ref - 该值所解析经过的凭据引用。
 * @returns 已裁剪、可用的密钥。
 */
export function assertUsableApiKey(raw: string, pkg: string, ref: string): string {
  const checked = normalizeApiKey(raw)
  if (checked.ok) return checked.value
  // Models 页面被指名为它通常是的那个写入者，而不是唯一的那个：
  // 同一个值也可能来自一次手工编辑的 .env，或某个根本没有挂载
  // 凭据接缝的组合中的 shell 导出；而在那种部署下，把用户指向
  // 一个该部署并未提供的页面会是一条死路。
  throw new LlmError(
    checked.reason === 'empty'
      ? `${pkg}: the API key resolved from ${ref} is blank; set ${ref} to the raw key`
        + ' (the web Models page writes it) or export it in the launching environment'
      : `${pkg}: the API key resolved from ${ref} contains characters no HTTP header can carry;`
        + ` set ${ref} to the raw key alone (the web Models page writes it)`,
    INVALID_CREDENTIAL_CODE,
  )
}

/** 一次其配置与适配器注册被一起解析出来的模型调用。 */
export interface PreparedLlmCall {
  /** 已分离、深度冻结的配置，其中任何由适配器持有的默认值都已物化。 */
  readonly config: LlmCallConfig
  /** 随该适配器注册一起捕获的不可变重试策略。 */
  readonly retryPolicy: ResolvedRetryPolicy
  /** 随该注册绑定调用一起解析出来的、已分离的上下文元数据。 */
  readonly context?: LlmModelContext
  /** 随该适配器分发世代一起捕获的精确模型模态。 */
  readonly inputModalities?: readonly ModelModality[]
  /** 随该适配器分发世代一起捕获的精确模型系统提示更新模式。 */
  readonly systemPromptUpdate?: SystemPromptUpdate
  /** 随该适配器分发世代一起捕获的精确模型工具更新模式。 */
  readonly toolUpdate?: ToolUpdate
  /** 由已捕获的适配器物化、而非由调用方提议的那些配置字段。 */
  readonly adapterDefaults: LlmCallConfigAdapterDefaults
  /**
   * 通过准备期间所捕获的那次注册分发本次调用一次。该请求的
   * call-config 字段必须匹配 {@link config}；复用或错位会以
   * `INVALID_PREPARED_CALL` 失败。
   * @param options - 携带该已准备配置的、完整装配好的请求。
   * @returns 块流，包含 `llm/stream` 瀑布。
   */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/** 一个由适配器持有、且绑定到它最终流式调用的模型解析世代。 */
export interface PreparedAdapterCall {
  /** 来自与 {@link stream} 同一个适配器世代的精确模型元数据。 */
  readonly model: LlmResolvedModelInfo
  /** 通过该世代分发，而不重新读取动态的连接事实。 */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/**
 * 面向 harness 消息与流词汇的提供方线路适配器。用
 * `ctx.llm.registerAdapter(providers, adapter)` 注册各个实现。
 * 每个提供方 HTTP 请求都必须包含 `attributionHeaders()`；
 * 请在线路请求或库请求头钩子中证明这些请求头已被添加。直接 fetch 的
 * DeepSeek 适配器与由库支撑的 pi-ai 适配器通过不同的内部实现满足这一契约。
 */
export abstract class LlmAdapter {
  /**
   * 描述本适配器所持有的一条提供方路由。
   * @param provider - 为本实例传给 `registerAdapter()` 的一条路由。
   * @returns 已分离的展示元数据，其 id 必须等于 `provider`。
   */
  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: provider }
  }

  /**
   * 返回随本路由一起捕获的、由提供方持有的重试策略。
   * @param _provider - 为本实例传给 `registerAdapter()` 的一条路由。
   * @returns 一个已解析的策略，或 `undefined` 以使用 normal 默认值。
   */
  providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined {
    return undefined
  }

  /**
   * 为一条精确模型路由解析提供方侧的请求图像定价。
   * 默认不声明任何定价，因此消费者回退到它们自己的中立估计。
   * 实现必须同步作答且不做 I/O；token meter 按每次度量解析它。
   * @param _provider - 为本实例传给 `registerAdapter()` 的一条路由。
   * @param _model - 传给 {@link GenerateOptions.model} 的精确模型 id。
   * @returns 由路由持有的图像定价，或当该路由不声明任何定价时为 `undefined`。
   */
  imageRequestPricing(_provider: string, _model: string): LlmImageRequestPricing | undefined {
    return undefined
  }

  /**
   * 解析本适配器发送给模型的图像尺寸与字节目标。
   * 默认保留已规范化的图像；会缩放的适配器必须覆盖它。
   * @param _provider - 已注册的提供方路由。
   * @param _model - 精确的模型 id。
   * @param image - 其请求投影正在被解析的、已规范化的图像。
   * @returns 请求序列化所使用的同一个目标，且先于提供方内部的处理。
   */
  imageRequestTarget(_provider: string, _model: string, image: ImageAttachmentRef): ImageRequestTarget {
    return { width: image.width, height: image.height, maxBytes: image.bytes }
  }

  /**
   * 列出本适配器当前可以为它所持有的一条提供方宣传的各个模型。
   * 核心路由接受未被列出的模型 id；像 GUI 那样由目录驱动的入口
   * 可能要求成员身份。在那里被使用的适配器必须宣传它们可用的模型；
   * 基类那个空目录不提供任何 GUI 选择。
   * @param _provider - 本适配器所持有的一条提供方路由。
   * @returns 按适配器偏好顺序排列的、可被发现的模型。
   */
  listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([])
  }

  /**
   * 解析一条精确模型可得的全部元数据。这一查询独立于那份参考性的目录，
   * 并且不校验请求路由。
   * @param provider - 本适配器所持有的一条提供方路由。
   * @param model - 传给 {@link GenerateOptions.model} 的精确模型 id。
   * @param _signal - 本次精确模型查找的取消信号；异步实现必须在它
   *   中止之后迅速落定。
   * @returns 提供方/模型身份，外加任何上下文、调用默认值与推理元数据。
   */
  resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  /**
   * 把精确的模型元数据与最终的请求分发绑定到同一个适配器世代。
   * 动态适配器覆盖它，从而使准备与分发之间发生的设置变更
   * 无法把一个世代的能力与另一个世代的端点组合在一起。
   * @param provider - 已注册的提供方路由。
   * @param model - 精确的模型 id。
   * @param signal - 模型解析的取消信号。
   * @returns 模型元数据，以及一个单世代的流入口。
   */
  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: options => this.stream(options),
    }
  }

  /**
   * 以原始块的形式流式输出一次模型调用。这是唯一必需的方法。
   * @param options - 完整装配好的请求；实现必须遵守 `options.signal`。
   * @returns 块流，遵守 `StreamChunk` 上所记载的适配器契约。
   */
  abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/**
 * {@link LlmRuntime.registerAdapter} 的返回值：那个 disposer，
 * 以及针对同一个适配器实例的原子性路由替换。
 */
export interface AdapterRegistrationHandle {
  /** 释放本次注册当前持有的每条路由。 */
  (): void
  /**
   * 用 `providers` 替换本次注册的路由，并保留同一个适配器实例。
   * 候选集合会先被完整校验——与另一个适配器冲突、一个无效的名称，
   * 或错误的提供方元数据都会抛错，并且让当前的路由不受影响——
   * 而这次替换本身是一个同步区段，因此没有任何请求能观察到空档。
   * 这里一个空数组是合法的（一个被清空的小节在保持注册的同时
   * 持有零条路由），这与一次空的初始注册不同。
   *
   * 一旦本次注册已被释放，就以错误码 `REGISTRATION_DISPOSED`
   * 抛出 `LlmError`：它的路由已经消失，而它的 disposer 也已经运行过，
   * 因此之后注册的任何东西都将没有持有者来释放它。
   * @param providers - 本次注册的完整下一个路由集合。
   */
  replace(providers: string[]): void
}

/**
 * 一个存活的、可配置提供方注册，可释放且可原子替换——
 * 即 {@link AdapterRegistrationHandle} 在目录侧的对应物。
 */
export interface DirectoryRegistrationHandle {
  /** 撤下本次注册当前持有的每个条目。 */
  (): void
  /**
   * 用 `entries` 替换本次注册的条目。候选集合会先被完整校验——
   * 一个已被另一次注册声明的条目、集合内部的重复，或无效的元数据
   * 都会抛错，并且让当前的条目不受影响——而这次替换是一个同步区段，
   * 因此没有任何读取者观察到空档。这里一个空数组是合法的，
   * 这与一次空的初始注册不同。
   *
   * 一旦本次注册已被释放，就以错误码 `REGISTRATION_DISPOSED`
   * 抛出 `LlmError`。
   */
  replace(entries: readonly LlmConfigurableProvider[]): void
}

/**
 * 抽象的 `llm` 服务：一个适配器注册表，外加一个可通过
 * `llm/stream` 瀑布拦截的流式模型调用 API。
 */
export class LlmRuntime extends TypertRemoteService {
  private adapters = new Map<string, AdapterRegistration>()
  private directory = new Map<string, LlmConfigurableProvider>()
  private discoveries = new Map<
    string,
    (request: LlmModelDiscoveryRequest, signal?: AbortSignal) => Promise<readonly LlmDiscoveredModel[]>
  >()

  constructor(ctx: Context) {
    super(ctx, 'llm')
  }

  /** 通知各个拓扑观察者，且不让一个损坏的监听器否决这次提交。 */
  private emitAdaptersUpdated(): void {
    // Cordis 的 emit 使用 Array.map：一次同步抛出会让较晚的监听器饿死。
    // 注册表通知是不可否决的，因此独立地隔离每一个回调。
    for (const listener of this.ctx.events.dispatch('emit', ['llm/adapters-updated']) as Array<() => unknown>) {
      try {
        const returned = listener()
        if (returned != null && typeof (returned as PromiseLike<unknown>).then === 'function') {
          // 一个 emit 监听器仍然可能是一个 async 函数；它的拒绝
          // 在这里被隔离，而不是变成一个未处理的拒绝。
          void Promise.resolve(returned as PromiseLike<unknown>).then(undefined, (error: unknown) => {
            this.warnAdaptersListenerFailure(error)
          })
        }
      } catch (error) {
        this.warnAdaptersListenerFailure(error)
      }
    }
  }

  /** 由同步与异步两条失败路径共享的、已隔离监听器的诊断信息。 */
  private warnAdaptersListenerFailure(error: unknown): void {
    this.ctx.logger.warn('llm: an llm/adapters-updated listener failed')
    this.ctx.logger.warn(error)
  }

  /**
   * 为给定的各条提供方路由注册一个适配器。当任何提供方已经拥有一个
   * 适配器时，以错误码 `DUPLICATE_ADAPTER` 抛出 `LlmError`（全有或全无）。
   * 随 fiber 一起被释放。
   * @param providers - 本适配器应当服务的每条提供方路由。
   * @param adapter - 为那些提供方流式输出各次调用的适配器。
   * @returns 那个 disposer，并携带 {@link AdapterRegistrationHandle.replace}。
   */
  registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle {
    // 本次注册当前持有的各条路由；`replace` 会重写它，
    // 而那个 disposer 会释放它在释放时刻所持有的任何东西。
    const owned = new Set<string>()
    // disposer 已经运行过：`owned` 为空这一点本身无法说明这一点，
    // 因为 `replace([])` 合法地留下一个持有零条路由的存活注册。
    let released = false
    const dispose = this.ctx.effect(function* (this: LlmRuntime) {
      if (providers.length === 0) throw new LlmError('an adapter must register at least one provider', 'INVALID_ADAPTER')
      this.commitRoutes(owned, this.prepareRoutes(providers, adapter, owned))
      yield () => {
        released = true
        for (const provider of owned) this.adapters.delete(provider)
        owned.clear()
        this.emitAdaptersUpdated()
      }
    }.bind(this), 'llm.registerAdapter()')
    // ctx.effect 的 disposer 返回 Promise<void>；我们的 disposer API
    // 是同步的即发即弃 —— 丢弃那个（总是已兑现的）promise。
    const handle = (() => void dispose()) as AdapterRegistrationHandle
    handle.replace = (next: string[]): void => {
      // 在这里注册将会泄漏：那个 effect 的 disposer 已经运行过，
      // 因此没有任何东西留下，来释放本次调用将放进映射表的东西。
      if (released) {
        throw new LlmError('a disposed adapter registration cannot replace its routes', 'REGISTRATION_DISPOSED')
      }
      this.commitRoutes(owned, this.prepareRoutes(next, adapter, owned))
    }
    return handle
  }

  /**
   * 为 `adapter` 校验一个候选路由集合，并把本次注册已经持有的路由
   * 当作可用。没有任何东西被改动：一个被拒绝的候选会让注册表
   * 与之前完全一样。
   */
  private prepareRoutes(providers: string[], adapter: LlmAdapter, owned: ReadonlySet<string>): AdapterRegistration[] {
    const unique = new Set<string>()
    const registrations: AdapterRegistration[] = []
    for (const provider of providers) {
      if (provider.length === 0) throw new LlmError('adapter provider names must be non-empty', 'INVALID_ADAPTER')
      if (unique.has(provider) || (this.adapters.has(provider) && !owned.has(provider))) {
        throw new LlmError(`an adapter for provider "${provider}" is already registered`, 'DUPLICATE_ADAPTER')
      }
      const info = adapter.providerInfo(provider)
      if (typeof info.id !== 'string' || info.id !== provider || typeof info.name !== 'string' || info.name.length === 0) {
        throw new LlmError(`adapter metadata for provider "${provider}" must preserve its id and have a non-empty name`, 'INVALID_ADAPTER')
      }
      unique.add(provider)
      const retryPolicy = adapter.providerRetryPolicy(provider)
        ?? resolveRetryPolicy(undefined, `llm: provider "${provider}" retryPolicy`)
      registrations.push({
        adapter,
        provider: { id: info.id, name: info.name },
        retryPolicy,
      })
    }
    return registrations
  }

  /**
   * 在一个同步区段内把本次注册的路由换成那些已准备好的路由，
   * 因此没有任何观察者能看到释放与重新注册之间的注册表。
   * 该路由集合唯一的改动点也正是发布 `llm/adapters-updated` 的地方，
   * 于是一次 `replace` 会像一次首次注册那样宣告自己。
   */
  private commitRoutes(owned: Set<string>, registrations: readonly AdapterRegistration[]): void {
    for (const provider of owned) this.adapters.delete(provider)
    owned.clear()
    for (const registration of registrations) {
      this.adapters.set(registration.provider.id, registration)
      owned.add(registration.provider.id)
    }
    this.emitAdaptersUpdated()
  }

  /**
   * 描述那些拥有已注册适配器的提供方路由。
   * @returns 按注册顺序排列的、已分离的提供方元数据。
   */
  @Remote
  listProviders(): LlmProviderInfo[] {
    return [...this.adapters.values()].map(({ provider }) => ({ ...provider }))
  }

  /**
   * 声明那些适配器插件可以通过配置激活的提供方路由。注册是全有或全无的：
   * 一个空列表、无效的条目，或一个已被任何一次注册声明过的提供方，
   * 都会在不注册其余部分的前提下抛出 `LlmError`。随 fiber 一起被释放。
   * @param entries - 本插件所持有的每个可配置提供方。
   * @returns 一个撤下它们全部、并能原子地替换它们的句柄。
   */
  registerConfigurableProviders(entries: readonly LlmConfigurableProvider[]): DirectoryRegistrationHandle {
    let held: LlmConfigurableProvider[] = []
    let disposed = false
    /**
     * 针对本次注册尚未持有的一切，完整校验一个候选集合，然后发布它。
     * 在整个集合通过之前不写入任何东西，因此一个被拒绝的候选会让当前
     * 条目留在原处——正是这一性质让 `replace` 成为一次替换，
     * 而不是一次可能把目录搁置为空的先删后加。
     */
    const commit = (candidates: readonly LlmConfigurableProvider[]): void => {
      const detached: LlmConfigurableProvider[] = []
      const own = new Set(held.map(entry => entry.provider))
      for (const entry of candidates) {
        if (entry.provider.length === 0 || entry.displayName.length === 0 || entry.settingsNs.length === 0) {
          throw new LlmError('configurable providers need a non-empty provider, displayName, and settingsNs', 'INVALID_DIRECTORY')
        }
        if (entry.settingsPath.some(segment => segment.length === 0)) {
          throw new LlmError(`configurable provider "${entry.provider}" has an empty settingsPath segment`, 'INVALID_DIRECTORY')
        }
        if ((this.directory.has(entry.provider) && !own.has(entry.provider))
          || detached.some(seen => seen.provider === entry.provider)) {
          throw new LlmError(`configurable provider "${entry.provider}" is already declared`, 'DUPLICATE_DIRECTORY')
        }
        detached.push(detachDirectoryEntry(entry))
      }
      for (const entry of held) this.directory.delete(entry.provider)
      for (const entry of detached) this.directory.set(entry.provider, entry)
      held = detached
      this.emitAdaptersUpdated()
    }

    const dispose = this.ctx.effect(function* (this: LlmRuntime) {
      if (entries.length === 0) {
        throw new LlmError('a configurable-provider registration must declare at least one provider', 'INVALID_DIRECTORY')
      }
      commit(entries)
      yield () => {
        disposed = true
        for (const entry of held) this.directory.delete(entry.provider)
        held = []
        this.emitAdaptersUpdated()
      }
    }.bind(this), 'llm.registerConfigurableProviders()')

    const handle = ((): void => void dispose()) as DirectoryRegistrationHandle
    handle.replace = (next: readonly LlmConfigurableProvider[]): void => {
      if (disposed) {
        throw new LlmError('this configurable-provider registration was disposed', 'REGISTRATION_DISPOSED')
      }
      commit(next)
    }
    return handle
  }

  /**
   * 列出每个已声明的可配置提供方，无论已注册还是处于休眠。
   * @returns 按声明顺序排列的、已分离的目录条目。
   */
  @Remote
  listConfigurableProviders(): LlmConfigurableProvider[] {
    return [...this.directory.values()].map(detachDirectoryEntry)
  }

  /**
   * 代表本插件所持有的设置命名空间，主动提出去探查各个提供方端点。
   * 命名空间之所以是那个键，是因为一个配置界面已经从可配置提供方目录
   * 那里持有它，并且因为一个正在被*添加*的提供方还没有可以指名的路由。
   * 随 fiber 一起被释放。
   * @param settingsNs - 本次发现所服务的那些 profile 所属的命名空间。
   * @param discover - 探查一个端点，且必须遵守所提供的信号。
   * @returns 撤下该提议的 disposer。
   */
  registerModelDiscovery(
    settingsNs: string,
    discover: (
      request: LlmModelDiscoveryRequest,
      signal?: AbortSignal,
    ) => Promise<readonly LlmDiscoveredModel[]>,
  ): () => void {
    const dispose = this.ctx.effect(function* (this: LlmRuntime) {
      if (settingsNs.length === 0) {
        throw new LlmError('model discovery needs a non-empty settings namespace', 'INVALID_DISCOVERY')
      }
      if (this.discoveries.has(settingsNs)) {
        throw new LlmError(`model discovery for "${settingsNs}" is already registered`, 'DUPLICATE_DISCOVERY')
      }
      this.discoveries.set(settingsNs, discover)
      yield () => {
        this.discoveries.delete(settingsNs)
      }
    }.bind(this), 'llm.registerModelDiscovery()')
    return () => void dispose()
  }

  /**
   * 探查一个提供方端点，看它宣传了哪些模型。该请求描述的是一份草稿，
   * 而非一条已存储的路由，因此这里没有任何东西读取或写入设置或凭据——
   * 两者都由调用方持有，而应答是某个界面可以提议采纳的候选元数据。
   * @param settingsNs - 其已注册发现服务于这份草稿的命名空间。
   * @param request - 要使用的端点、协议与一次性凭据。
   * @param signal - 调用方的取消信号。
   * @returns 被宣传的各个模型，按端点顺序去重。
   */
  async discoverModels(
    settingsNs: string,
    request: LlmModelDiscoveryRequest,
    signal?: AbortSignal,
  ): Promise<LlmDiscoveredModel[]> {
    const discover = this.discoveries.get(settingsNs)
    if (discover === undefined) {
      throw new LlmError(`no model discovery is registered for "${settingsNs}"`, 'NO_DISCOVERY')
    }
    // 这两者之一标识要描述什么：一条适配器知道的路由，或一个要去询问的端点。
    // 两者都缺失就没有任何可以作答的对象。
    if ((request.provider ?? '').length === 0 && (request.baseURL ?? '').length === 0) {
      throw new LlmError('model discovery needs a provider route or a baseURL', 'INVALID_DISCOVERY')
    }
    const discovered = signal === undefined
      ? await discover(request)
      : await discover(request, signal)
    const seen = new Set<string>()
    const models: LlmDiscoveredModel[] = []
    for (const model of discovered) {
      if (typeof model.id !== 'string' || model.id.length === 0 || seen.has(model.id)) continue
      seen.add(model.id)
      models.push({
        id: model.id,
        ...model.name === undefined ? {} : { name: model.name },
        ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
        ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
        ...model.inputModalities === undefined ? {} : { inputModalities: [...model.inputModalities] },
      })
    }
    return models
  }

  /**
   * 供一次草稿提供方探查使用的远端适配器。
   * @param settingsNs - 其已注册发现服务于这份草稿的命名空间。
   * @param request - 要使用的端点、协议与一次性凭据。
   * @param signal - 由 Remote 载体提供的调用方取消信号。
   * @returns 按端点顺序排列的、被宣传的模型。
   * @throws 当发现拒绝或失败时，抛出带有 `llm/model-discovery-rejected` 的 RemoteError。
   */
  @Remote('discoverModels')
  async remoteDiscoverModels(
    settingsNs: string,
    request: LlmModelDiscoveryRequest,
    signal: AbortSignal,
  ): Promise<LlmDiscoveredModel[]> {
    try {
      return await this.discoverModels(settingsNs, request, signal)
    } catch (error: unknown) {
      throw new RemoteError(
        'llm/model-discovery-rejected',
        error instanceof Error ? error.message : String(error),
        {
          settingsNs,
          ...request.baseURL === undefined ? {} : { baseURL: request.baseURL },
        },
        { cause: error },
      )
    }
  }

  /**
   * 解析某条提供方路由被注册时所捕获的重试策略。
   * @param provider - 要查看的、已注册的提供方路由。
   * @returns 由提供方持有的策略，其中 normal 默认值已经解析完成。
   */
  providerRetryPolicy(provider: string): ResolvedRetryPolicy {
    return this.registration(provider).retryPolicy
  }

  /**
   * 为一条精确路由解析提供方侧的请求图像定价，或当该提供方未注册
   * 或未声明任何定价时为 `undefined`。未知的提供方降级为 `undefined`
   * 而不是抛错，因为调用方要为那些其路由可能已不再挂载的持久化历史计价。
   * @param provider - 由某个请求头指名的提供方路由。
   * @param model - 由同一个请求头指名的精确模型 id。
   * @returns 持有该路由的适配器的图像定价，当它声明了时。
   */
  imageRequestPricing(provider: string, model: string): LlmImageRequestPricing | undefined {
    return this.adapters.get(provider)?.adapter.imageRequestPricing(provider, model)
  }

  /**
   * 为一条精确的已注册模型路由解析图像投影。
   * @param provider - 已注册的提供方路由。
   * @param model - 精确的模型 id。
   * @param image - 已规范化的图像引用。
   * @returns 该适配器的请求序列化器所使用的尺寸与字节目标。
   */
  imageRequestTarget(provider: string, model: string, image: ImageAttachmentRef): ImageRequestTarget {
    return this.registration(provider).adapter.imageRequestTarget(provider, model, image)
  }

  /**
   * 解析一个持久化文件出现在当前执行环境中对每个提供方请求所贡献的精确文本。
   * @param ref - 来自模型历史的、持久化的逐字文件引用。
   * @returns 在适配器分发处所使用的同一个确定性句柄文本。
   */
  fileRequestText(ref: FileAttachmentRef): string {
    return fileHandleText(ref, this.fileReadPath(ref))
  }

  /** 分离由适配器持有的、带类型的模态元数据。 */
  private detachedModalities(modalities: readonly ModelModality[] | undefined): ModelModality[] | undefined {
    return modalities === undefined ? undefined : [...modalities]
  }

  /**
   * 发现一条已注册提供方所宣传的各个模型。目录成员身份并不约束核心路由。
   * 由目录驱动的入口可能把选择与提交限制在被宣传的那些模型上。
   * @param provider - 要查看的、已注册的提供方路由。
   * @returns 按适配器偏好顺序排列的、已分离的模型元数据。
   */
  async listModels(provider: string): Promise<LlmModelInfo[]> {
    const adapter = this.registration(provider).adapter
    const models = await adapter.listModels(provider)
    const seen = new Set<string>()
    return models.map((model) => {
      if (
        typeof model.provider !== 'string'
        || model.provider !== provider
        || typeof model.id !== 'string'
        || model.id.length === 0
        || typeof model.name !== 'string'
        || model.name.length === 0
        || (model.description !== undefined && typeof model.description !== 'string')
        || seen.has(model.id)
      ) {
        throw new LlmError(`adapter returned invalid or duplicate model metadata for provider "${provider}"`, 'INVALID_CATALOG')
      }
      seen.add(model.id)
      const inputModalities = this.detachedModalities(model.inputModalities)
      return {
        provider: model.provider,
        id: model.id,
        name: model.name,
        ...model.description === undefined ? {} : { description: model.description },
        ...inputModalities === undefined ? {} : { inputModalities },
      }
    })
  }

  /**
   * 解析并校验来自持有某条精确路由的适配器的全部元数据。该结果
   * 已从由适配器持有的对象上分离；目录成员身份仍然是参考性的，
   * 并不控制请求路由。
   * @param provider - 要查看的、已注册的提供方路由。
   * @param model - 传给该适配器的精确模型 id。
   * @param signal - 供由适配器持有的异步查找使用的可选取消信号。
   * @returns 精确的模型身份，外加可得的上下文与推理元数据。
   */
  async resolveModelInfo(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return this.resolveModelInfoFor(this.registration(provider), model, signal)
  }

  private async resolveModelInfoFor(
    registration: AdapterRegistration,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const resolved = await registration.adapter.resolveModel(registration.provider.id, model, signal)
    return this.normalizeModelInfo(registration, model, resolved)
  }

  /** 校验并分离一个由适配器返回的精确模型结果。 */
  private normalizeModelInfo(
    registration: AdapterRegistration,
    model: string,
    resolved: LlmResolvedModelInfo,
  ): LlmResolvedModelInfo {
    const provider = registration.provider.id
    if (
      typeof resolved.provider !== 'string'
      || resolved.provider !== provider
      || typeof resolved.id !== 'string'
      || resolved.id !== model
      || typeof resolved.name !== 'string'
      || resolved.name.length === 0
      || (resolved.description !== undefined && typeof resolved.description !== 'string')
    ) {
      throw new LlmError(
        `adapter returned invalid exact model metadata for provider "${provider}" model "${model}"`,
        'INVALID_MODEL_INFO',
      )
    }
    const context = resolved.context
    if (context !== undefined && (!Number.isInteger(context.contextWindow) || context.contextWindow <= 0)) {
      throw new LlmError(
        `adapter returned invalid context metadata for provider "${provider}" model "${model}"`,
        'INVALID_MODEL_CONTEXT',
      )
    }
    // 能力元数据原样带过：一个显式的模态遗漏，就是下游预检
    // （图像准入）所依据的否定能力。
    const inputModalities = this.detachedModalities(resolved.inputModalities)
    // 放宽：适配器从目录配置派生这个模式，因此该值按字符串校验。
    const systemPromptUpdate: string | undefined = resolved.systemPromptUpdate
    if (systemPromptUpdate !== undefined && systemPromptUpdate !== 'in-history') {
      throw new LlmError(
        `adapter returned invalid system prompt update mode for provider "${provider}" model "${model}"`,
        'INVALID_MODEL_INFO',
      )
    }
    // 出于同样的原因放宽：目录配置以文本形式提供工具更新模式。
    const toolUpdate: string | undefined = resolved.toolUpdate
    if (toolUpdate !== undefined && toolUpdate !== 'in-history' && toolUpdate !== 'addition-only') {
      throw new LlmError(
        `adapter returned invalid tool update mode for provider "${provider}" model "${model}"`,
        'INVALID_MODEL_INFO',
      )
    }
    const defaultMaxTokens = resolved.defaultMaxTokens
    if (defaultMaxTokens !== undefined
      && (!Number.isSafeInteger(defaultMaxTokens) || defaultMaxTokens <= 0)) {
      throw new LlmError(
        `adapter returned invalid default maxTokens for provider "${provider}" model "${model}"`,
        'INVALID_MODEL_MAX_TOKENS',
      )
    }
    const info: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: resolved.name,
      ...resolved.description === undefined ? {} : { description: resolved.description },
      ...inputModalities === undefined ? {} : { inputModalities },
      ...context === undefined ? {} : { context: { contextWindow: context.contextWindow } },
      ...defaultMaxTokens === undefined ? {} : { defaultMaxTokens },
      ...resolved.systemPromptUpdate === undefined ? {} : { systemPromptUpdate: resolved.systemPromptUpdate },
      ...resolved.toolUpdate === undefined ? {} : { toolUpdate: resolved.toolUpdate },
    }
    const reasoning = resolved.reasoning
    if (reasoning === undefined) return info
    if (reasoning.efforts.length === 0) {
      throw new LlmError(
        `adapter returned invalid reasoning metadata for provider "${provider}" model "${model}"`,
        'INVALID_MODEL_REASONING',
      )
    }
    const seen = new Set<string>()
    const efforts = reasoning.efforts.map((effort) => {
      if (
        typeof effort.id !== 'string'
        || effort.id.length === 0
        || typeof effort.name !== 'string'
        || effort.name.length === 0
        || (effort.description !== undefined && typeof effort.description !== 'string')
        || seen.has(effort.id)
      ) {
        throw new LlmError(
          `adapter returned invalid or duplicate reasoning effort metadata for provider "${provider}" model "${model}"`,
          'INVALID_MODEL_REASONING',
        )
      }
      seen.add(effort.id)
      return {
        id: effort.id,
        name: effort.name,
        ...effort.description === undefined ? {} : { description: effort.description },
      }
    })
    if (reasoning.defaultEffort !== undefined && !seen.has(reasoning.defaultEffort)) {
      throw new LlmError(
        `adapter returned an unknown default reasoning effort for provider "${provider}" model "${model}"`,
        'INVALID_MODEL_REASONING',
      )
    }
    return {
      ...info,
      reasoning: {
        efforts,
        ...reasoning.defaultEffort === undefined ? {} : { defaultEffort: reasoning.defaultEffort },
      },
    }
  }

  /**
   * 针对某条精确模型的能力校验一次对话调用配置，并物化由适配器配置的
   * 默认值。不受支持的显式强度会在任何提供方 I/O 之前被拒绝；
   * 不执行任何钳制或别名化。这一独立查询并不绑定之后的一次分发；
   * 当记录日志与流式输出必须共享同一个适配器注册时，请使用 {@link prepareCall}。
   * @param config - 提供方/模型路由，以及可选的请求控制项。
   * @param signal - 供由适配器持有的能力查找使用的可选取消信号。
   * @returns 仅当某个默认值必须被物化时，一份已分离的配置。
   */
  async resolveCallConfig(config: LlmCallConfig, signal?: AbortSignal): Promise<LlmCallConfig> {
    return (await this.resolveCallFor(this.registration(config.provider), config, signal)).config
  }

  private async resolveCallFor(
    registration: AdapterRegistration,
    config: LlmCallConfig,
    signal?: AbortSignal,
  ): Promise<{ config: LlmCallConfig; context?: LlmModelContext; modelInfo: LlmResolvedModelInfo }> {
    const info = await this.resolveModelInfoFor(registration, config.model, signal)
    return this.resolveCallWithInfo(config, info)
  }

  /** 针对一个已绑定的精确模型结果校验各个请求控制项。 */
  private resolveCallWithInfo(
    config: LlmCallConfig,
    info: LlmResolvedModelInfo,
  ): { config: LlmCallConfig; context?: LlmModelContext; modelInfo: LlmResolvedModelInfo } {
    const defaulted = config.maxTokens === undefined && info.defaultMaxTokens !== undefined
      ? { ...config, maxTokens: info.defaultMaxTokens }
      : config
    const reasoning = info.reasoning
    const requested = defaulted.reasoningEffort
    let resolvedConfig = defaulted
    if (reasoning === undefined) {
      if (requested !== undefined) {
        throw new LlmError(
          `provider "${config.provider}" model "${config.model}" does not support reasoning effort "${requested}"`,
          'UNSUPPORTED_REASONING_EFFORT',
        )
      }
    } else {
      const effective = requested ?? reasoning.defaultEffort
      if (effective !== undefined) {
        if (!reasoning.efforts.some(effort => effort.id === effective)) {
          throw new LlmError(
            `provider "${config.provider}" model "${config.model}" does not support reasoning effort "${effective}"`,
            'UNSUPPORTED_REASONING_EFFORT',
          )
        }
        if (requested !== effective) resolvedConfig = { ...defaulted, reasoningEffort: effective }
      }
    }
    return {
      config: resolvedConfig,
      ...info.context === undefined ? {} : { context: info.context },
      modelInfo: info,
    }
  }

  /**
   * 在其当前的适配器注册之下解析一次调用。所返回的那个一次性句柄
   * 会在请求头记录与分发之间保持该注册，因此 HMR 无法把一个适配器的
   * 能力结果与另一个适配器组合起来。一个可选的同步回调使用已捕获的
   * 模型元数据选择具体的控制项。默认值与校验作用于它的结果。
   * 回调失败与取消会在分发之前让这次准备 reject。
   * @param config - 提供方/模型路由，以及可选的、具体的请求控制项。
   * @param signal - 供由适配器持有的能力查找使用的可选取消信号。
   * @param configure - 纯粹的控制项选择，在默认值与校验之前被调用一次。
   * @returns 一份已准备的配置，以及它绑定到该注册的流入口。
   */
  async prepareCall(
    config: LlmCallConfig,
    signal?: AbortSignal,
    configure?: ConfigureCall,
  ): Promise<PreparedLlmCall> {
    signal?.throwIfAborted()
    const { provider, model, ...controls } = config
    const registration = this.registration(provider)
    const adapterCall = await registration.adapter.prepareCall(provider, model, signal)
    signal?.throwIfAborted()
    const modelInfo = this.normalizeModelInfo(registration, model, adapterCall.model)
    const proposed = configure === undefined
      ? config
      : { ...configure(deepFreeze(structuredClone(controls)), deepFreeze(modelInfo)), provider, model }
    signal?.throwIfAborted()
    const resolved = this.resolveCallWithInfo(proposed, modelInfo)
    const resolvedConfig = deepFreeze(structuredClone(resolved.config))
    const context = resolved.context === undefined
      ? undefined
      : deepFreeze(structuredClone(resolved.context))
    const adapterDefaults = deepFreeze<LlmCallConfigAdapterDefaults>({
      ...proposed.reasoningEffort === undefined && resolvedConfig.reasoningEffort !== undefined
        ? { reasoningEffort: true }
        : {},
      ...proposed.maxTokens === undefined && resolvedConfig.maxTokens !== undefined
        ? { maxTokens: true }
        : {},
    })
    let dispatched = false
    return Object.freeze({
      config: resolvedConfig,
      retryPolicy: registration.retryPolicy,
      adapterDefaults,
      ...context === undefined ? {} : { context },
      ...modelInfo.inputModalities === undefined
        ? {}
        : { inputModalities: Object.freeze([...modelInfo.inputModalities]) },
      ...modelInfo.systemPromptUpdate === undefined ? {} : { systemPromptUpdate: modelInfo.systemPromptUpdate },
      ...modelInfo.toolUpdate === undefined ? {} : { toolUpdate: modelInfo.toolUpdate },
      stream: (options: GenerateOptions): AsyncIterable<StreamChunk> => {
        if (dispatched) {
          throw new LlmError('a prepared LLM call can only be dispatched once', 'INVALID_PREPARED_CALL')
        }
        if (!callConfigEquals(options, resolvedConfig)) {
          throw new LlmError(
            'prepared LLM call config changed before adapter dispatch',
            'INVALID_PREPARED_CALL',
          )
        }
        dispatched = true
        return this.streamWithRegistration(options, {
          registration,
          config: resolvedConfig,
          modelInfo,
          dispatch: options => adapterCall.stream(options),
        })
      },
    })
  }

  private registration(provider: string): AdapterRegistration {
    const registration = this.adapters.get(provider)
    if (!registration) throw new LlmError(`no adapter registered for provider "${provider}"`, 'NO_ADAPTER')
    return registration
  }

  /** 移除那些其历史路由由另一个适配器持有的回放状态。 */
  private forAdapter(options: GenerateOptions, adapter: LlmAdapter): GenerateOptions {
    const messages: RequestMessage[] = options.messages.map((message) => {
      if (message.role !== 'assistant') return message
      const source = message.source
      if (source.replayState === undefined) return message
      if (this.adapters.get(source.provider)?.adapter === adapter) return message
      return freezeMessage({
        ...message,
        source: { kind: 'model', provider: source.provider, model: source.model },
      })
    })
    if (messages.every((message, index) => message === options.messages[index])) return options
    const filtered = { ...options, messages }
    return Object.isFrozen(options) ? deepFreeze(filtered) : filtered
  }

  /**
   * 通过已挂载的附件与文件系统提供方，解析一个持久化文件引用
   * 在当前执行世界中的读取路径。
   */
  private fileReadPath(ref: FileAttachmentRef): string | undefined {
    let hostPath: string | undefined
    try {
      hostPath = this.ctx.get('attachments')?.fileHostPath(ref)
    } catch {
      // 一个格式错误的持久化引用会把这次出现降级为无路径的句柄，
      // 而不是让同一份日志之后的每个请求都失败。
      return undefined
    }
    if (hostPath === undefined) return undefined
    // 结构性的接口面：dsh-llm 不能依赖文件系统包，而只消费这一个映射方法。
    const fs = this.ctx.get('fs') as { processPathFromHostPath(hostPath: string): string | undefined } | undefined
    return fs?.processPathFromHostPath(hostPath)
  }

  /**
   * 最终的适配器边界。适配器选择、分发、迭代器构造与迭代失败
   * 都会变成一个终止性的失败块。中间件与下游消费者的失败
   * 仍然是被抛出的插件或消费者错误。
   */
  private async * adapterStream(
    options: GenerateOptions,
    prepared?: PreparedDispatch,
  ): AsyncGenerator<StreamChunk> {
    let iterator: AsyncIterator<StreamChunk>
    try {
      const registration = prepared?.registration ?? this.registration(options.provider)
      const adapter = registration.adapter
      let modelInfo: LlmResolvedModelInfo
      let resolvedConfig: LlmCallConfig
      let dispatch: (options: GenerateOptions) => AsyncIterable<StreamChunk>
      if (prepared === undefined) {
        const adapterCall = await adapter.prepareCall(options.provider, options.model, options.signal)
        modelInfo = this.normalizeModelInfo(registration, options.model, adapterCall.model)
        resolvedConfig = this.resolveCallWithInfo(options, modelInfo).config
        dispatch = options => adapterCall.stream(options)
      } else {
        modelInfo = prepared.modelInfo
        resolvedConfig = prepared.config
        dispatch = prepared.dispatch
      }
      if (prepared !== undefined && !callConfigEquals(options, resolvedConfig)) {
        throw new LlmError(
          'prepared LLM call config changed before adapter dispatch',
          'INVALID_PREPARED_CALL',
        )
      }
      const resolvedOptions = callConfigEquals(options, resolvedConfig)
        ? options
        : Object.isFrozen(options)
          ? deepFreeze({ ...options, ...resolvedConfig })
          : { ...options, ...resolvedConfig }
      // 文件永远不会原生地被分发：每条路由收到的都是句柄文本。
      let projectedMessages: readonly RequestMessage[] = resolvedOptions.messages
      if (projectedMessages.some(message => contentHasFile(message.content))) {
        projectedMessages = projectFilesToText(projectedMessages, ref => this.fileReadPath(ref))
      }
      if (modelInfo.inputModalities !== undefined
        && !modelInfo.inputModalities.includes('image')
        && projectedMessages.some(message => contentHasImage(message.content))) {
        projectedMessages = projectImagesForTextModel(projectedMessages)
      }
      // 工具变更在每条路由上都会被记录；由该路由已声明的模式选择它收到什么。
      const projectedTools = projectToolUpdates(projectedMessages, resolvedOptions.tools, modelInfo.toolUpdate, resolvedOptions.toolHistory)
      projectedMessages = projectedTools.messages
      let projectedOptions = resolvedOptions
      if (projectedMessages !== resolvedOptions.messages || projectedTools.tools !== resolvedOptions.tools) {
        projectedOptions = {
          ...resolvedOptions,
          messages: projectedMessages as RequestMessage[],
          ...projectedTools.tools === undefined ? {} : { tools: projectedTools.tools as ToolSchema[] },
        }
        if (Object.isFrozen(resolvedOptions)) deepFreeze(projectedOptions)
      }
      const stream = dispatch(this.forAdapter(projectedOptions, adapter))
      iterator = stream[Symbol.asyncIterator]()
    } catch (error: unknown) {
      yield adapterFailureChunk(error, options.signal)
      return
    }

    let completed = false
    try {
      while (true) {
        let item: { done: true } | { done: false; value: StreamChunk }
        try {
          const next = await iterator.next()
          item = next.done
            ? { done: true }
            : { done: false, value: next.value }
        } catch (error: unknown) {
          completed = true
          yield adapterFailureChunk(error, options.signal)
          return
        }
        if (item.done) {
          completed = true
          return
        }
        // 在 yield 之前结束由适配器持有的那个 try：被恢复进本生成器的
        // 消费者/中间件失败必须保持被抛出。
        yield item.value
      }
    } finally {
      if (!completed) {
        const close = iterator.return?.bind(iterator)
        if (close) await close()
      }
    }
  }

  /**
   * 以原始块（令牌级增量）的形式流式输出一次模型调用。只有当同一个
   * 适配器实例同时持有其历史提供方与目标提供方时，回放状态才会被保留。
   * 最终的适配器选择在异步的精确模型解析与分发期间保持固定。适配器选择、
   * 分发与迭代失败会变成终止性的 `error` 或 `aborted` 结束块；
   * 中间件、嵌套调用、清理与消费者的失败仍然是被抛出的。
   * @param options - 完整的请求；`options.provider` 选择那个适配器。
   * @returns 块流，可能被各个 `llm/stream` 监听器包装。
   */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamWithRegistration(options)
  }

  private streamWithRegistration(
    options: GenerateOptions,
    prepared?: PreparedDispatch,
  ): AsyncIterable<StreamChunk> {
    return this.ctx.waterfall(
      this,
      'llm/stream',
      options,
      () => this.adapterStream(options, prepared),
    )
  }
}

/** 把一次适配器抛出转换为流协议的终止性结果。 */
function adapterFailureChunk(error: unknown, signal?: AbortSignal): StreamChunk {
  const failure = normalizeLlmFailure(error)
  return {
    type: 'finish',
    reason: signal?.aborted || failure.code === 'ABORTED'
      ? { kind: 'aborted', failure }
      : { kind: 'error', failure },
  }
}

/** 复制一个目录条目，包括它的各个数组，因此任何一方都无法改动另一方的副本。 */
function detachDirectoryEntry(entry: LlmConfigurableProvider): LlmConfigurableProvider {
  const { nativeAuth } = entry
  return {
    ...entry,
    settingsPath: [...entry.settingsPath],
    ...entry.baseURLEnv === undefined ? {} : { baseURLEnv: [...entry.baseURLEnv] },
    ...(nativeAuth === undefined ? {} : { nativeAuth: { ...nativeAuth, env: [...nativeAuth.env] } }),
  }
}

interface AdapterRegistration {
  readonly adapter: LlmAdapter
  readonly provider: LlmProviderInfo
  readonly retryPolicy: ResolvedRetryPolicy
}

interface PreparedDispatch {
  readonly registration: AdapterRegistration
  readonly config: LlmCallConfig
  readonly modelInfo: LlmResolvedModelInfo
  readonly dispatch: (options: GenerateOptions) => AsyncIterable<StreamChunk>
}

export default LlmRuntime
