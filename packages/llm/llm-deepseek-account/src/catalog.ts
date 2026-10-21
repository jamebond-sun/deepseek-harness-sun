/** 按凭据范围隔离的 `/models` 缓存：单飞加载、后台刷新，并保留最后已知的良好结果。 */
import { createHash } from 'node:crypto'
import { deadline } from '@deepseek-ai/dsh-timeout'
import type { CatalogSettings } from './config.ts'
import { LISTING_TIMEOUT } from './listing.ts'
import type { ModelListing } from './listing.ts'

/** 一个目录实例由宿主持有的输入。 */
export interface CatalogDependencies {
  /** 当前的端点设置，每次访问时重新读取。 */
  readonly settings: () => CatalogSettings
  /** `url` 允许使用的账号令牌；未登录时为 `undefined`。 */
  readonly token: (url: string) => Promise<string | undefined>
  /** 执行一次用 `token` 认证的清单请求；`signal` 携带 {@link LISTING_TIMEOUT} 请求截止时间。 */
  readonly load: (url: string, token: string, signal: AbortSignal) => Promise<ModelListing>
  /** 用于计算清单时效的挂钟。 */
  readonly now: () => number
  /** 报告一次已加载的清单。 */
  readonly info: (message: string) => void
  /** 报告一次失败连续中的首次失败。 */
  readonly warn: (message: string) => void
}

/** 请求解析所读取的内容。 */
export interface CatalogView {
  /** 清单端点是否具备可用的账号令牌。 */
  readonly signedIn: boolean
  /** 本凭据与端点下最近一次成功的清单；在成功之前为 `undefined`。 */
  readonly listing: ModelListing | undefined
}

/** 等待 `task`，除非 `signal` 先中止；任务本身会继续运行。 */
async function abandonable(task: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return task
  const abandoned = Promise.withResolvers<never>()
  const abandon = (): void => { abandoned.reject(signal.reason) }
  signal.addEventListener('abort', abandon, { once: true })
  try {
    await Promise.race([task, abandoned.promise])
  } finally {
    signal.removeEventListener('abort', abandon)
  }
}

/** 一条账号路由的清单缓存；每个端点与凭据组合各自拥有独立的作用域。 */
export class AccountModelCatalog {
  private scope: string | undefined
  private listing: ModelListing | undefined
  /** 本作用域中最近一次加载的落定时刻；在首次落定之前为 `undefined`。 */
  private settledAt: number | undefined
  private inflight: Promise<void> | undefined
  private request: AbortController | undefined
  private generation = 0
  private failing = false
  private closed = false

  /** @param dependencies - 设置、凭据、传输、时钟与诊断回调。 */
  constructor(private readonly dependencies: CatalogDependencies) {}

  /**
   * 最近一次发布的视图，不产生 I/O。
   * @returns 当前作用域的登录状态与清单。
   */
  current(): CatalogView {
    return { signedIn: this.scope !== undefined, listing: this.listing }
  }

  /**
   * 为当前凭据解析视图。某个作用域的首次访问会等待其加载，
   * 该等待由请求截止时间约束；之后的访问立即返回，并在后台刷新过期的清单。
   * @param signal - 仅放弃本次等待；共享的加载会继续。
   * @returns 该作用域首次加载落定之后的视图。
   */
  async view(signal?: AbortSignal): Promise<CatalogView> {
    const settings = this.dependencies.settings()
    const token = await this.dependencies.token(settings.url)
    signal?.throwIfAborted()
    if (this.closed) return this.current()
    const scope = token === undefined ? undefined : `${settings.url}\n${createHash('sha256').update(token).digest('hex')}`
    if (scope !== this.scope) this.rescope(scope)
    if (token !== undefined) {
      if (this.settledAt === undefined) await abandonable(this.start(settings, token), signal)
      else if (this.dependencies.now() - this.settledAt >= settings.maxAgeMs) void this.start(settings, token)
    }
    return this.current()
  }

  /** 中止进行中的加载；之后的结果与访问都不再产生任何改变。 */
  dispose(): void {
    this.closed = true
    this.generation += 1
    this.request?.abort()
  }

  private rescope(scope: string | undefined): void {
    this.request?.abort()
    this.scope = scope
    this.listing = undefined
    this.settledAt = undefined
    this.inflight = undefined
    this.failing = false
    this.generation += 1
  }

  private start(settings: CatalogSettings, token: string): Promise<void> {
    if (this.inflight !== undefined) return this.inflight
    this.generation += 1
    const generation = this.generation
    const request = new AbortController()
    this.request = request
    const limit = deadline(request.signal, settings.timeoutMs, LISTING_TIMEOUT)
    const run = this.dependencies.load(settings.url, token, limit.signal)
      .then((listing) => {
        if (generation !== this.generation) return
        this.listing = listing
        this.settledAt = this.dependencies.now()
        this.failing = false
        this.dependencies.info(`model listing from ${settings.url} loaded ${listing.entries.length} model(s), skipped ${listing.skipped} row(s)`)
      }, (error: unknown) => {
        if (generation !== this.generation) return
        if (!this.failing) {
          const fallback = this.listing === undefined ? 'using the bundled catalog' : 'keeping the previous catalog'
          this.dependencies.warn(`model listing from ${settings.url} failed (${String(error)}); ${fallback}`)
        }
        this.settledAt = this.dependencies.now()
        this.failing = true
      })
      .finally(() => {
        limit[Symbol.dispose]()
        if (this.inflight === run) this.inflight = undefined
      })
    this.inflight = run
    return run
  }
}
