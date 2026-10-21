/**
 * 网络能力 seam（`ctx.web`）的词表。搜索和抓取刻意共享同一个 seam，以便提供方选择、
 * 取消、错误和产品配置有单一归属，同时保留各自独立的请求与结果类型。
 * @module @deepseek-ai/dsh-web/types
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/**
 * 一个具备搜索能力的后端被要求搜索的内容。每个请求携带一个查询；一个消费方可以发出
 * 多个请求。`maxResults` 是一个透传不变的 `dsh-tool-web` 层上限，并在返回途中由该 seam
 * 强制实施（见 {@link WebSearchResult}）。
 */
export interface WebSearchRequest {
  readonly query: string
  /**
   * 返回来源数量的上限；该 seam 会截断至该值。省略 = 无上限。`dsh-tool-web` 总是设置它。
   * 其 API 支持结果数量控制的提供方（Exa 的 `numResults`）应在请求层应用它，作为成本/延迟
   * 优化；该 seam 无论如何都会强制实施该上限。
   */
  readonly maxResults?: number
}

/**
 * 归一化的搜索结果。`content` 是可选的提供方生成的答案文本或摘要（Exa 和 DeepSeek 不返回；
 * Perplexity 返回生成的答案）。`sources[]` 是可移植的引用形状。`truncated` 由该 seam 在它把
 * `sources[]` 削减至 `maxResults` 时设置。
 */
export interface WebSearchResult {
  /** 可选的提供方生成的答案文本、搜索上下文或摘要。 */
  readonly content?: string
  /** 可引用的来源，已截断至请求的 `maxResults`。 */
  readonly sources: readonly WebSearchSource[]
  /** 当该 seam 为遵守 `maxResults` 而丢弃来源时为 true。 */
  readonly truncated: boolean
}

/**
 * 一个可引用的来源。一个来源始终有一个 URL；`title`、`snippet` 和 `publishedAt` 是可选的，
 * 因为并非每个提供方都返回它们 —— 强迫适配器编造它们会让该 seam 说谎（Perplexity 的引用可能
 * 只有 URL）。`dsh-tool-web` 渲染 `title ?? hostname(url)` 用于展示。
 */
export interface WebSearchSource {
  readonly url: string
  readonly title?: string
  readonly snippet?: string
  /** 提供方提供的发布/抓取时间戳，ISO-8601 字符串。 */
  readonly publishedAt?: string
}

/**
 * 一个具备抓取能力的后端被要求检索的内容。该请求刻意省略超时、格式、提示词和提取控制：
 * 取消是一个直接的执行参数，而呈现和更高层的 LLM 关注点属于安全检索之外。
 */
export interface WebFetchRequest {
  readonly url: string
}

/**
 * 归一化的抓取结果。对一个非 2xx 响应的成功网络抓取是一个结果，而非错误：状态码是所获资源
 * 状态的一部分。{@link WebError} 保留给无法安全检索或表示资源的失败。
 */
export interface WebFetchResult {
  /** 允许的重定向之后的最终 URL（请求 URL 在请求中）。 */
  readonly url: string
  /** 抓取到的响应的 HTTP 状态码。 */
  readonly statusCode: number
  /** 已解码正文，按内容类型分类。 */
  readonly body: WebFetchBody
  /** 当提供方截断了已解码正文时为 true。 */
  readonly truncated: boolean
}

/**
 * 已抓取资源的已解码正文。一个由 `dsh-web` 拥有的封闭判别联合：提供方解码 kind，
 * `dsh-tool-web` 渲染它，因此新增一种 kind 是在已知包之间协调的变更，而非插件扩展。
 * 消费方对 `kind` 进行 `switch` 并以 `default: assertNever(...)` 结尾，从而新增一种 kind
 * 会在每个消费方处造成编译错误，直到被处理。即使字段重合，每个分支也保持各自独立的对象字面量，
 * 以便某个分支可以获得其他分支所没有的字段。
 */
export type WebFetchBody =
  | { readonly kind: 'html'; readonly content: string }
  | { readonly kind: 'text'; readonly content: string }

/**
 * 一个具备搜索能力的后端。通过 `ctx.web.registerSearchProvider` 注册。
 * `id` 是一个稳定的字符串，在该搜索能力类型内唯一。
 */
export interface WebSearchProvider {
  readonly id: string
  /** 廉价的本地可用性检查；不得发起网络调用。 */
  available(): boolean
  /** 运行一次搜索；遵守 `signal` 进行取消。 */
  search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>
}

/**
 * 一个具备抓取能力的后端。通过 `ctx.web.registerFetchProvider` 注册。
 * `id` 是一个稳定的字符串，在该抓取能力类型内唯一。
 */
export interface WebFetchProvider {
  readonly id: string
  /** 廉价的本地可用性检查；不得发起网络调用。 */
  available(): boolean
  /** 检索一个 URL；遵守 `signal` 进行取消。 */
  fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult>
}

/**
 * 带有一个机器可路由、开放字符串 `code` 和链式 `cause` 的类型化 web 错误。
 * 消费方必须容忍提供方特定的 code。共享 code 涵盖不可用、缺失、不可用、歧义或重复的
 * 提供方、取消以及提供方失败；本地抓取提供方还额外区分无效或受阻 URL、重定向、大小与
 * 超时限制，以及不支持的内容类型。工具执行将 code 暴露于结构化错误元数据中。
 */
export class WebError extends HarnessError {}
