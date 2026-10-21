/**
 * 已校验的插件市场索引记录。
 * @module @deepseek-ai/dsh-plugin-market-index/types
 */

import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'

/** 一个市场声明的类别或标签：一个不透明 id 的展示标题。 */
export interface MarketDeclaration {
  readonly title: LocalizedText
}

/** 一个市场声明的排序键：其展示标题与初始方向。 */
export interface MarketSortKeyDeclaration {
  readonly title: LocalizedText
  readonly order: 'asc' | 'desc'
}

/** 市场定义的声明；缺席的组为空记录。 */
export interface MarketIndexMetadata {
  readonly categories: Readonly<Record<string, MarketDeclaration>>
  readonly labels: Readonly<Record<string, MarketDeclaration>>
  readonly sortKeys: Readonly<Record<string, MarketSortKeyDeclaration>>
}

/** 一个插件的由市场定义的值；类别、标签与排序键 id 需要索引声明。 */
export interface MarketPluginMetadata {
  readonly category?: string
  /** 自由格式字符串，通常来自包关键词；缺席输入变为空数组。 */
  readonly keywords: readonly string[]
  readonly labels: readonly string[]
  readonly sortKeys: Readonly<Record<string, number>>
}

/** 插件源代码的发布位置；仅用于展示，绝不作为安装来源。 */
export interface MarketRepository {
  /** 仓库网页的绝对 http(s) URL，不含凭据、查询或片段。 */
  readonly url: string
  /** 包在仓库内的相对 POSIX 目录；缺席意为仓库根。 */
  readonly directory?: string
}

/** 一个精确版本的安装来源。 */
export type MarketSource =
  | {
    readonly type: 'npm'
    /** http(s) 注册表 URL；缺席意为安装客户端的已配置注册表。 */
    readonly registry?: string
  }
  | {
    readonly type: 'git'
    /** 规范的 https 仓库 URL，不含凭据、查询或片段。 */
    readonly url: string
    /** 小写 40 位十六进制提交 SHA。 */
    readonly commit: string
    /** 相对 POSIX 包目录；缺席意为仓库根。 */
    readonly path?: string
  }

/** 一个版本的运行时要求。 */
export interface MarketEngines {
  /** 该版本运行的 DSH 版本的 SemVer 范围；缺席意为任意 DSH 版本。 */
  readonly dsh?: string
}

/** 一个可安装的插件版本。 */
export interface MarketVersion {
  /** 精确 SemVer 版本，在其插件内唯一。 */
  readonly version: string
  /** `version` 的发布时间，以 Unix 秒计。 */
  readonly publishTimestamp: number
  readonly source: MarketSource
  readonly engines: MarketEngines
}

/** 一个可安装的包及其所列版本。 */
export interface MarketPlugin {
  /** npm 包名，在其索引内唯一。 */
  readonly name: string
  readonly title?: LocalizedText
  readonly description?: LocalizedText
  /** Base64 `data:` URL 或绝对 URL；相对索引引用已被解析为关于索引 URL 的形式。 */
  readonly icon?: string
  readonly author?: string
  /** 关于该插件的页面的绝对 http(s) URL。 */
  readonly homepage?: string
  /** 插件源仓库及其包目录的网页；仅展示用。 */
  readonly repository?: MarketRepository
  readonly metadata: MarketPluginMetadata
  /** 非空，按 SemVer 优先级降序。 */
  readonly versions: readonly MarketVersion[]
}

/** 一个已校验的格式 1 索引；格式未定义的成员会被丢弃。 */
export interface MarketIndex {
  readonly format: 1
  readonly title: LocalizedText
  readonly description?: LocalizedText
  readonly metadata: MarketIndexMetadata
  /** 按索引默认顺序的插件。 */
  readonly plugins: readonly MarketPlugin[]
}

/** 安装一个精确版本的参数。 */
export interface MarketInstallTarget {
  /** `pnpm add` 接受的安装说明。 */
  readonly spec: string
  /** 优先询问的注册表；缺席意为安装客户端的已配置注册表。 */
  readonly registry?: string
}
