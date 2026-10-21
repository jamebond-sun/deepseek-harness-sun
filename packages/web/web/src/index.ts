/**
 * 网络访问能力 seam（`ctx.web`）的服务定义：用于搜索和抓取的服务注册表与提供方选择式执行。
 * 重复的 id 会被拒绝。在执行时，必须存在一个已配置且可用的提供方；若没有，则要求恰好一个
 * 可用的提供方，因此选择绝不依赖注册顺序。
 * @module @deepseek-ai/dsh-web
 */

import { Context, Service, type Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  WebFetchProvider,
  WebFetchRequest,
  WebFetchResult,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
} from './types.ts'
import { WebError } from './types.ts'

export {
  WebError,
} from './types.ts'
export type {
  WebFetchBody,
  WebFetchProvider,
  WebFetchRequest,
  WebFetchResult,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    web: WebRuntime
  }
}

/** 执行时提供方解析的选择输入。 */
interface Selection<P> {
  /** 该能力已配置的提供方 id（若有）。 */
  readonly configuredId?: string
  /** 为该能力类型注册的提供方。 */
  readonly providers: ReadonlyMap<string, P>
}

/**
 * web seam 的配置。`searchProvider` / `fetchProvider` 钉住每种能力各自的胜出提供方；
 * 二者均可选（恰好一个已注册的可用提供方会自动选中）。每次操作都读取当前值，因此一次
 * 设置变更会应用于下一次搜索或抓取，而无需重新挂载服务。诸如环境变量之类的运行期覆盖
 * 必须馈入这些相同字段，而不是引入一条隐藏的优先级链。
 */
export interface WebRuntimeConfig {
  /** 显式的搜索提供方 id。省略 = 恰好一个可用时自动选择。 */
  readonly searchProvider: Volatile<string | undefined>
  /** 显式的抓取提供方 id。省略 = 恰好一个可用时自动选择。 */
  readonly fetchProvider: Volatile<string | undefined>
}

/**
 * 网络访问服务。注册为 `ctx.web`（每个上下文一个实例）。
 *
 * 选择语义（在执行时解析，从不依赖顺序）：
 * - 一个已注册且 `available()` 的配置 id → 该提供方。
 * - 已配置但未注册的 id → `WEB_PROVIDER_CONFIGURED_MISSING`。
 * - 已配置但不可用的 id → `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`。
 * - 未配置 id，且恰好一个已注册的可用提供方 → 该提供方。
 * - 未配置 id，且有多个可用提供方 → `WEB_PROVIDER_AMBIGUOUS`。
 * - 未配置 id，且无可用提供方 → `WEB_PROVIDER_UNAVAILABLE`。
 */
export class WebRuntime extends Service {
  /**
   * 提供方选择配置。运行期环境覆盖馈入相同的字段：
   * `$DSH_WEB_SEARCH_PROVIDER` / `$DSH_WEB_FETCH_PROVIDER` 等价于
   * `searchProvider` / `fetchProvider`，而绝非一条隐藏的优先级链。
   */
  static Config = z.object({
    searchProvider: z.string().volatile(),
    fetchProvider: z.string().volatile(),
  })

  private searchProviders = new Map<string, WebSearchProvider>()
  private fetchProviders = new Map<string, WebFetchProvider>()
  private readonly searchProviderEnv: string | undefined
  private readonly fetchProviderEnv: string | undefined

  constructor(ctx: Context, private readonly config: WebRuntimeConfig) {
    super(ctx, 'web')
    this.searchProviderEnv = process.env.DSH_WEB_SEARCH_PROVIDER
    this.fetchProviderEnv = process.env.DSH_WEB_FETCH_PROVIDER
  }

  /**
   * 注册一个搜索提供方。若其 id 已为搜索注册，则抛出 {@link WebError}
   * `WEB_DUPLICATE_PROVIDER`。返回清理器；随调用纤程一起 dispose。
   * @param provider - 该提供方；其 `id` 为注册表键。
   * @returns 注销该提供方的清理器。
   */
  registerSearchProvider(provider: WebSearchProvider): () => void {
    return this.registerProvider(this.searchProviders, provider)
  }

  /**
   * 注册一个抓取提供方。若其 id 已为抓取注册，则抛出 {@link WebError}
   * `WEB_DUPLICATE_PROVIDER`。返回清理器；随调用纤程一起 dispose。
   * @param provider - 该提供方；其 `id` 为注册表键。
   * @returns 注销该提供方的清理器。
   */
  registerFetchProvider(provider: WebFetchProvider): () => void {
    return this.registerProvider(this.fetchProviders, provider)
  }

  private registerProvider<P extends { readonly id: string }>(store: Map<string, P>, provider: P): () => void {
    if (store.has(provider.id)) {
      throw new WebError(`a web provider with id "${provider.id}" is already registered`, 'WEB_DUPLICATE_PROVIDER')
    }
    const dispose = this.ctx.effect(function* () {
      store.set(provider.id, provider)
      yield () => store.delete(provider.id)
    }, 'web.registerProvider()')
    // ctx.effect 的清理器返回 Promise<void>；我们的清理器 API 是同步的
    // 即发即弃 —— 丢弃（总是已 resolved 的）promise。
    return () => void dispose()
  }

  /**
   * 通过所选提供方运行一次搜索。在调用时按上述选择规则解析提供方；当该能力无法运行时
   * 抛出 {@link WebError}。该 seam 在结果上强制实施 `request.maxResults`：若提供方返回过多，
   * 则 `sources[]` 被截断并设置 `truncated`。
   * @param request - 查询以及可选的结果上限。
   * @param signal - 转发给提供方的可选取消信号。
   * @returns 提供方的结果，截断至 `request.maxResults`。
   */
  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const configuredId = this.config.searchProvider.get() ?? this.searchProviderEnv
    const provider = resolveProvider({
      providers: this.searchProviders,
      ...configuredId !== undefined ? { configuredId } : {},
    })
    const result = await provider.search(request, signal)
    return capSources(result, request.maxResults)
  }

  /**
   * 通过所选提供方检索一个 URL。在调用时按上述选择规则解析提供方；当该能力无法运行时
   * 抛出 {@link WebError}。非 2xx 响应是一个结果，而非抛出。
   * @param request - URL 以及检索选项。
   * @param signal - 转发给提供方的可选取消信号。
   * @returns 检索结果；非 2xx 响应会以描述性方式 resolve。
   */
  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    const configuredId = this.config.fetchProvider.get() ?? this.fetchProviderEnv
    const provider = resolveProvider({
      providers: this.fetchProviders,
      ...configuredId !== undefined ? { configuredId } : {},
    })
    return provider.fetch(request, signal)
  }
}

interface ResolvableProvider {
  readonly id: string
  available(): boolean
}

/** 解析所选提供方，或抛出匹配的 {@link WebError}。 */
function resolveProvider<P extends ResolvableProvider>(selection: Selection<P>): P {
  const { configuredId, providers } = selection
  if (configuredId !== undefined) {
    const provider = providers.get(configuredId)
    if (!provider) {
      throw new WebError(`configured web provider "${configuredId}" is not registered`, 'WEB_PROVIDER_CONFIGURED_MISSING')
    }
    if (!provider.available()) {
      throw new WebError(`configured web provider "${configuredId}" is registered but unavailable`, 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE')
    }
    return provider
  }
  const usable = [...providers.values()].filter(provider => provider.available())
  const [single] = usable
  if (single === undefined) {
    throw new WebError('no usable web provider is registered', 'WEB_PROVIDER_UNAVAILABLE')
  }
  if (usable.length > 1) {
    const ids = usable.map(provider => provider.id).join(', ')
    throw new WebError(`multiple usable web providers are registered (${ids}); configure one explicitly`, 'WEB_PROVIDER_AMBIGUOUS')
  }
  return single
}

/** 在搜索结果上强制实施 `maxResults`：截断 `sources[]` 并标记。 */
function capSources(result: WebSearchResult, maxResults: number | undefined): WebSearchResult {
  if (maxResults === undefined || result.sources.length <= maxResults) return result
  return { ...result, sources: result.sources.slice(0, maxResults), truncated: true }
}

export default WebRuntime
