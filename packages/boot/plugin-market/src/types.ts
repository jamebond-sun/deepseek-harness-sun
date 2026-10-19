/** 插件市场 Remote 命名空间的 JSON 安全记录与事件。 */
import type { MarketIndexMetadata, MarketInstallTarget, MarketPlugin, MarketVersion } from '@deepseek-ai/dsh-plugin-market-index'
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import type {} from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** 索引 URL 不是 http(s)，或带有凭据或片段。 */
    'plugin-market/invalid-index-url': { readonly url: string; readonly reason: string }
    /** 该 URL 不是已配置的索引源之一。 */
    'plugin-market/unknown-index': { readonly url: string }
    /** 索引无法被抓取：网络失败、超时、重定向、非 2xx 状态，或响应体超过大小限制。 */
    'plugin-market/fetch-failed': { readonly url: string; readonly reason: string }
    /** 抓取的文档不是合法的格式 1 JSON；`path` 指出有问题的 JSON 值。 */
    'plugin-market/invalid-index': { readonly url: string; readonly path: string; readonly reason: string }
    /** 搜索分页请求越界；`field` 指出有问题的查询字段。 */
    'plugin-market/invalid-query': { readonly field: string; readonly reason: string }
    /** 缺少 settings 服务与本服务的 profile 入口时，索引源无法被保存。 */
    'plugin-market/settings-unavailable': Record<string, never>
  }
}

/** 一个已配置的索引源，以及上次读取所了解到的信息。 */
export interface MarketIndexSummary {
  readonly url: string
  /** 上次成功读取的市场标题。 */
  readonly title?: LocalizedText
  readonly description?: LocalizedText
  /** 上次读取失败时的失败信息。 */
  readonly error?: string
}

/**
 * 一个插件与 profile 的 bundles 的关系，按包名匹配，并以其默认版本（无默认版本时
 * 以其最高版本）衡量：`provided` 表示 DSH 安装自带该包；`update-available` 表示该版本
 * 高于已安装版本；`different-version` 表示已安装版本未知、非合法 SemVer，或更高。
 */
export type MarketInstallationStatus = 'not-installed' | 'installed' | 'update-available' | 'different-version' | 'provided'

/** 一个插件的安装状态，以及在 profile 报告时的已安装版本。 */
export interface MarketInstallation {
  readonly status: MarketInstallationStatus
  readonly installedVersion?: string
}

/** 运行中的 DSH 版本是否满足某个版本的 `engines.dsh`，按 DSH 的安装检查方式评估。 */
export type MarketCompatibility =
  | { readonly compatible: true }
  | {
    readonly compatible: false
    readonly runtimeVersion: string
    /** 未被满足的要求，以 `engines.dsh` 为键。 */
    readonly requirements: Readonly<Record<string, string>>
    /** profile 是否持有针对这一确切包与运行时版本的版本豁免。 */
    readonly exempted: boolean
  }

/** 一个被列出的版本，及其兼容性与安装它的参数。 */
export interface MarketListingVersion extends MarketVersion {
  readonly install: MarketInstallTarget
  readonly compatibility: MarketCompatibility
}

/** 一个索引插件，带有市场列表所展示的 profile 专属事实。 */
export interface MarketListingEntry extends Omit<MarketPlugin, 'versions'> {
  /** 非空，按 SemVer 优先级降序排列。 */
  readonly versions: readonly MarketListingVersion[]
  /**
   * 默认安装的版本：不带预发布标记的最高兼容版本；当插件列出的版本都带预发布标记时，
   * 为最高兼容的预发布版本。没有这样的兼容版本时缺失。
   */
  readonly defaultVersion?: string
  readonly installation: MarketInstallation
}

/**
 * 搜索结果的排序；并列时保持索引顺序。`relevance` 按文本匹配度排序（最佳在前），
 * 无 `text` 时即为索引顺序。`published` 使用每个插件最新的发布时间。`key` 使用声明的
 * 排序键；没有该值的插件在任一方向上都排在其它所有插件之后。
 */
export type MarketSort =
  | { readonly kind: 'index' }
  | { readonly kind: 'relevance' }
  | { readonly kind: 'published'; readonly direction: 'asc' | 'desc' }
  | { readonly kind: 'key'; readonly id: string; readonly direction: 'asc' | 'desc' }

/** 针对一个索引的一页请求；索引未声明的 id 不会匹配任何插件。 */
export interface MarketQuery {
  /**
   * 与包名、作者、关键词，以及标题、描述、分类与标签标题的每一种语言做模糊匹配的文本。
   * 每个词都必须作为前缀、或在至多 2 的编辑距离内，匹配某个字段中的某个词。不含字母
   * 或数字的文本会匹配所有插件。
   */
  readonly text?: string
  /** 插件必须拥有的分类 id。 */
  readonly category?: string
  /** 插件必须全部拥有的标签 id。 */
  readonly labels?: readonly string[]
  readonly sort: MarketSort
  /** 要跳过的匹配插件数量；非负整数。 */
  readonly offset: number
  /** 返回的最大插件数量；1 到 100 的整数。 */
  readonly limit: number
  /** 重新抓取，而不是使用缓存的文档。 */
  readonly refresh?: boolean
  /**
   * 较早一页的 `fetchedAt`：只要该文档仍在缓存中（即便已超出 `cacheTtlMs`），就据此
   * 文档作答，使后续页面延续相同的结果。没有 `refresh` 时，被替换的文档按没有该字段
   * 的方式作答。
   */
  readonly fetchedAt?: number
}

/** 一页匹配的插件，附带市场视图所展示的索引事实。 */
export interface MarketSearchResult {
  readonly url: string
  readonly title: LocalizedText
  readonly description?: LocalizedText
  readonly metadata: MarketIndexMetadata
  /** 回答本页的文档的抓取时间，以 Unix 毫秒计；不同的值表示不同的文档。 */
  readonly fetchedAt: number
  /** 本页匹配的插件，按结果顺序排列。 */
  readonly entries: readonly MarketListingEntry[]
  /** 所有页面中匹配插件的总数。 */
  readonly total: number
  /** 下一页的 `offset`；最后一页之后为 null。 */
  readonly nextOffset: number | null
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * 已配置的索引源发生了变化。
     * @mode emit
     */
    'plugin-market/changed'(): void
  }
}
