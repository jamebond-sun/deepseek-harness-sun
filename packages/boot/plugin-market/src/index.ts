/** 为发现页与 `plugin_market` 工具读取已配置插件市场索引的宿主读取器。 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import semver from 'semver'
import { evaluatePluginCompatibility, getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import { marketInstallTarget, type MarketIndex, type MarketPlugin, type MarketVersion } from '@deepseek-ai/dsh-plugin-market-index'
import type { BundleInfo } from '@deepseek-ai/dsh-plugin-manager/types'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { normalizeIndexUrl } from './index-url.ts'
import { parseIndexInWorker } from './parse-thread.ts'
import { MarketSearch } from './search.ts'
// 仅类型：复用 `pluginManager` 服务、`settings.update`，以及 Loader 的 `loader/volatile-update` 事件。
import type {} from '@deepseek-ai/dsh-plugin-manager'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {
  MarketCompatibility, MarketIndexSummary, MarketInstallation, MarketListingEntry, MarketListingVersion, MarketQuery, MarketSearchResult,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 已配置的插件市场索引源及其校验后的清单。 */
    pluginMarket: PluginMarket
  }
}

/** 索引源与抓取限制。 */
export interface Config {
  /** 按展示顺序排列的索引 URL；Settings 与 `setIndexes` 在不重新挂载本服务的情况下写入该字段。 */
  indexes: Volatile<string[]>
  /** 一次索引抓取（含响应体）的截止时间。 */
  fetchTimeoutMs: number
  /** 可接受的索引响应体最大字节数。 */
  maxBytes: number
  /** 成功读取的索引文档的存活时长。 */
  cacheTtlMs: number
}

/** 失败的确切诊断信息，包括非 Error 的拒绝值。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 在一次拒绝之下追溯的原因链；更深或成环的链在此处被截断。 */
const MAX_CAUSES = 4

/** 携带原因链的拒绝：Node 的 `fetch` 失败是一个裸露的 `fetch failed`，其 reason 即为其原因。 */
function causeChainOf(error: unknown, depth = 0): string {
  return error instanceof Error && error.cause !== undefined && depth < MAX_CAUSES
    ? `${error.message}: ${causeChainOf(error.cause, depth + 1)}`
    : messageOf(error)
}

/** `search` 返回的单页最大条数。 */
const MAX_LIMIT = 100

/** 一个已抓取的索引文档及其搜索状态。 */
interface IndexDocument {
  readonly index: MarketIndex
  /** Unix 毫秒时间戳。 */
  readonly fetchedAt: number
  readonly search: MarketSearch
}

interface CachedIndex {
  readonly document: IndexDocument
  readonly expiresAt: number
}

/** 抓取、校验并缓存已配置的 market 索引；用 profile 的安装事实为条目做标注。 */
export default class PluginMarket extends TypertRemoteService {
  static inject = ['pluginManager']

  static Config = z.object({
    indexes: z.array(z.string().pattern(/^https?:\/\/\S+$/u)).default([]).volatile(),
    fetchTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(15000),
    maxBytes: z.natural().min(1).default(128 * 1024 * 1024),
    cacheTtlMs: z.natural().default(600000),
  })

  private readonly lifetime = new AbortController()
  private readonly cache = new Map<string, CachedIndex>()
  private readonly pending = new Map<string, Promise<IndexDocument>>()
  private readonly errors = new Map<string, string>()
  private readonly entryId: string | undefined

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'pluginMarket')
    this.entryId = ctx.fiber.entry?.options.id
    ctx.on('loader/volatile-update', () => {
      const configured = new Set(this.sources().flatMap(source => source.error === undefined ? [source.url] : []))
      for (const url of [...this.cache.keys(), ...this.errors.keys()]) {
        if (!configured.has(url)) {
          this.cache.delete(url)
          this.errors.delete(url)
        }
      }
      ctx.emit('plugin-market/changed')
    })
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('Plugin market disposed'))
      await Promise.allSettled(this.pending.values())
    })
  }

  /**
   * 列出已配置的索引源，但不抓取它们。
   * @returns 按顺序排列的每个源，以及其最后一次成功读取的标题；当最后一次读取失败时，附带其错误。
   */
  @Remote
  listIndexes(): MarketIndexSummary[] {
    return this.sources().map(({ url, error: invalid }) => {
      const index = this.cache.get(url)?.document.index
      const error = invalid ?? this.errors.get(url)
      return {
        url,
        ...index === undefined ? {} : { title: index.title, ...index.description === undefined ? {} : { description: index.description } },
        ...error === undefined ? {} : { error },
      }
    })
  }

  /**
   * 通过 Settings 替换已配置的索引源，而不重新挂载本服务。
   * `plugin-market/changed` 会广播提交后的列表。已经配置过的 URL 保持原样写入，因此客户端可以在
   * `listIndexes` 报告为不可用的源旁边增删其它源。
   * @param urls - 按展示顺序排列的索引 URL。
   * @throws {RemoteError} 对于无效的新 URL 或重复的 URL 抛出 `plugin-market/invalid-index-url`；
   * 缺少 Settings 或 profile 入口时抛出 `plugin-market/settings-unavailable`。
   */
  @Remote
  async setIndexes(urls: string[]): Promise<void> {
    const configured = new Set(this.config.indexes.get())
    const normalized = urls.map(url => configured.has(url) ? url : normalizeIndexUrl(url))
    // 一个被保留的 URL 在拥有规范形式时按其规范形式比较，因此对它的新写法也算作重复。
    const keys = normalized.map(url => URL.canParse(url) ? new URL(url).href : url)
    const repeated = normalized.find((_url, position) => keys.indexOf(keys[position] as string) !== position)
    if (repeated !== undefined) {
      throw new RemoteError('plugin-market/invalid-index-url', `Index source listed twice: ${repeated}`, { url: repeated, reason: 'duplicate' })
    }
    const settings = this.ctx.get('settings')
    if (settings === undefined || this.entryId === undefined) {
      throw new RemoteError('plugin-market/settings-unavailable', 'Index sources require the settings service and a profile entry', {})
    }
    await settings.update(this.entryId, { indexes: normalized })
  }

  /**
   * 返回某个已配置索引中匹配查询的插件的一页。对同一 URL 的并发读取会共享一次抓取；
   * 除非设置了 `refresh`，成功获取的文档会在 `cacheTtlMs` 内被复用。匹配与排序只读取文档；
   * 安装状态与兼容性在每次调用时为返回的页面计算。
   * @param url - 一个已配置的索引 URL。
   * @param query - 文本、过滤器、排序、分页，以及是否绕过缓存的文档。
   * @returns 索引头部、本页插件（每个插件含默认版本、安装状态，以及每个版本的兼容性与
   *   安装参数）、匹配数量，以及下一页的偏移量。
   * @throws {RemoteError} `plugin-market/invalid-query`、`plugin-market/unknown-index`、
   *   `plugin-market/invalid-index-url`、`plugin-market/fetch-failed`，或 `plugin-market/invalid-index`。
   */
  @Remote
  async search(url: string, query: MarketQuery): Promise<MarketSearchResult> {
    if (!Number.isSafeInteger(query.offset) || query.offset < 0) {
      throw new RemoteError('plugin-market/invalid-query', 'offset must be a non-negative integer', { field: 'offset', reason: 'range' })
    }
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_LIMIT) {
      throw new RemoteError('plugin-market/invalid-query', `limit must be an integer from 1 to ${String(MAX_LIMIT)}`, { field: 'limit', reason: 'range' })
    }
    const document = await this.document(url, query.refresh === true, query.fetchedAt)
    const matching = await document.search.select(query)
    const page = matching.slice(query.offset, query.offset + query.limit)
    const listing = await this.annotator()
    const next = query.offset + page.length
    const { index } = document
    return {
      url,
      title: index.title,
      ...index.description === undefined ? {} : { description: index.description },
      metadata: index.metadata,
      fetchedAt: document.fetchedAt,
      entries: page.map(listing),
      total: matching.length,
      nextOffset: next < matching.length ? next : null,
    }
  }

  /**
   * 读取某个已配置索引中的一个插件，与 `search` 一样使用缓存的文档。
   * @param url - 一个已配置的索引 URL。
   * @param name - 插件的包名。
   * @returns 带有默认版本、安装状态与已标注版本的插件；当索引未列出该插件时为 undefined。
   * @throws {RemoteError} `plugin-market/unknown-index`、`plugin-market/invalid-index-url`、
   *   `plugin-market/fetch-failed`，或 `plugin-market/invalid-index`。
   */
  async entry(url: string, name: string): Promise<MarketListingEntry | undefined> {
    const plugin = (await this.document(url, false)).index.plugins.find(candidate => candidate.name === name)
    return plugin === undefined ? undefined : (await this.annotator())(plugin)
  }

  private async document(url: string, refresh: boolean, fetchedAt?: number): Promise<IndexDocument> {
    const source = this.sources().find(candidate => candidate.url === url)
    if (source === undefined) throw new RemoteError('plugin-market/unknown-index', `Not a configured index source: ${url}`, { url })
    if (source.error !== undefined) {
      throw new RemoteError('plugin-market/invalid-index-url', source.error, { url, reason: 'configured' })
    }
    const cached = this.cache.get(url)
    const usable = cached !== undefined && (cached.expiresAt > Date.now() || cached.document.fetchedAt === fetchedAt)
    return !refresh && usable ? cached.document : await this.fetchShared(url)
  }

  /** 用 profile 当前的 bundles 与豁免项为插件做标注。 */
  private async annotator(): Promise<(plugin: MarketPlugin) => MarketListingEntry> {
    const [bundles, { exemptions }] = [await this.ctx.pluginManager.listBundles(), this.ctx.pluginManager.listVersionExemptions()]
    const runtimeVersion = getDshRuntimeVersion()
    return plugin => listingOf(plugin, bundles, exemptions, runtimeVersion)
  }

  /**
   * 按原样写出的已配置源，每个都附带使之不可用的拒绝原因。Settings 与 profile 文件可以
   * 写入任意 http(s) 字符串，因此每次使用都做校验而非依赖 schema；不可用的源会附带其错误
   * 被列出且永远不会被抓取，重复的 URL 只计数一次。
   */
  private sources(): { readonly url: string; readonly error?: string }[] {
    const seen = new Set<string>()
    return this.config.indexes.get().flatMap((url) => {
      if (seen.has(url)) return []
      seen.add(url)
      try {
        return normalizeIndexUrl(url) === url ? [{ url }] : [{ url, error: `Index URL is not in canonical form; use ${normalizeIndexUrl(url)}` }]
      } catch (error) {
        return [{ url, error: messageOf(error) }]
      }
    })
  }

  private configured(url: string): boolean {
    return this.sources().some(source => source.url === url && source.error === undefined)
  }

  private fetchShared(url: string): Promise<IndexDocument> {
    let pending = this.pending.get(url)
    if (pending === undefined) {
      pending = this.fetchIndex(url).then((index) => {
        // 即使两次抓取在一毫秒内完成，也按 URL 各自独立。
        const fetchedAt = Math.max(Date.now(), (this.cache.get(url)?.document.fetchedAt ?? 0) + 1)
        const document = { index, fetchedAt, search: new MarketSearch(index) }
        if (this.configured(url)) {
          this.cache.set(url, { document, expiresAt: Date.now() + this.config.cacheTtlMs })
          this.errors.delete(url)
        }
        return document
      }, (error: unknown) => {
        if (this.configured(url)) this.errors.set(url, messageOf(error))
        throw error
      }).finally(() => { this.pending.delete(url) })
      this.pending.set(url, pending)
    }
    return pending
  }

  private async fetchIndex(url: string): Promise<MarketIndex> {
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.config.fetchTimeoutMs)])
    const failed = (reason: string, cause?: unknown): RemoteError =>
      new RemoteError('plugin-market/fetch-failed', `Could not fetch ${url}: ${reason}`, { url, reason }, { cause })
    let response: Response
    try {
      response = await fetch(url, { signal, redirect: 'error', headers: { accept: 'application/json' } })
    } catch (error) {
      throw failed(causeChainOf(error), error)
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw failed(`HTTP ${String(response.status)}`)
    }
    const bytes = await this.readBody(response, failed)
    const result = await parseIndexInWorker(bytes, url, this.lifetime.signal).catch((error: unknown) => {
      throw failed(messageOf(error), error)
    })
    if (result.ok) return result.index
    throw new RemoteError('plugin-market/invalid-index', `${url}: ${result.message}`, { url, path: result.path, reason: result.reason })
  }

  /** 读取整个响应体，一旦超过 `maxBytes` 就拒绝它。 */
  private async readBody(response: Response, failed: (reason: string, cause?: unknown) => RemoteError): Promise<Uint8Array> {
    const limit = this.config.maxBytes
    const tooLarge = `body exceeds ${String(limit)} bytes`
    if (Number(response.headers.get('content-length') ?? 0) > limit) {
      await response.body?.cancel()
      throw failed(tooLarge)
    }
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for await (const chunk of response.body ?? []) {
        size += chunk.byteLength
        if (size > limit) throw failed(tooLarge)
        chunks.push(chunk)
      }
    } catch (error) {
      if (error instanceof RemoteError) throw error
      throw failed(messageOf(error), error)
    }
    const body = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      body.set(chunk, offset)
      offset += chunk.byteLength
    }
    return body
  }
}

function listingOf(
  plugin: MarketPlugin, bundles: readonly BundleInfo[], exemptions: Readonly<Record<string, readonly string[]>>, runtimeVersion: string,
): MarketListingEntry {
  const versions = plugin.versions.map((version): MarketListingVersion => ({
    ...version,
    install: marketInstallTarget(plugin.name, version),
    compatibility: compatibilityOf(plugin.name, version, exemptions, runtimeVersion),
  }))
  const compatible = versions.filter(version => version.compatibility.compatible)
  const stable = plugin.versions.some(version => semver.prerelease(version.version) === null)
  const defaultVersion = compatible.find(version => !stable || semver.prerelease(version.version) === null)?.version
  /* v8 ignore next -- parseMarketIndex guarantees a non-empty version list */
  const measured = defaultVersion ?? versions[0]?.version ?? ''
  return {
    ...plugin,
    versions,
    ...defaultVersion === undefined ? {} : { defaultVersion },
    installation: installationOf(plugin.name, measured, bundles),
  }
}

function installationOf(name: string, version: string, bundles: readonly BundleInfo[]): MarketInstallation {
  const bundle = bundles.find(candidate => candidate.name === name)
  // 按需目录条目在 profile 安装它之前就被列出。
  if (bundle === undefined || (!bundle.installed && bundle.availability !== 'installation')) return { status: 'not-installed' }
  if (!bundle.installed) return { status: 'provided', ...bundle.version === undefined ? {} : { installedVersion: bundle.version } }
  if (bundle.version === undefined) return { status: 'different-version' }
  const installedVersion = bundle.version
  if (installedVersion === version) return { status: 'installed', installedVersion }
  const newer = semver.valid(installedVersion) !== null && semver.gt(version, installedVersion)
  return { status: newer ? 'update-available' : 'different-version', installedVersion }
}

function compatibilityOf(
  name: string, version: MarketVersion, exemptions: Readonly<Record<string, readonly string[]>>, runtimeVersion: string,
): MarketCompatibility {
  const manifest = { name, version: version.version, ...version.engines.dsh === undefined ? {} : { engines: { dsh: version.engines.dsh } } }
  const issue = evaluatePluginCompatibility(manifest, exemptions, runtimeVersion)
  if (issue === undefined) return { compatible: true }
  return { compatible: false, runtimeVersion: issue.runtimeVersion, requirements: issue.requirements, exempted: issue.exempted }
}
