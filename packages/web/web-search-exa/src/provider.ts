/**
 * `ExaSearchProvider`：一个由 Exa 搜索 API 支持的 `WebSearchProvider`（`POST /search`，
 * 带突出内容）。它将第一个非空突出句映射为 `snippet`，将 `publishedDate` 映射为
 * `publishedAt`，丢弃没有摘要的条目，并省略 `content`，因为 Exa 不返回生成的答案。
 * @module @deepseek-ai/dsh-web-search-exa/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { ExaError, ExaResult, ExaSearchResponse } from './types.ts'

/** 本提供方注册的固定 id。 */
export const EXA_PROVIDER_ID = 'exa'

/** 默认 Exa 搜索端点；`/search` 是操作。 */
export const EXA_DEFAULT_BASE_URL = 'https://api.exa.ai'

/** 默认检索模式：让 Exa 在关键词与神经搜索之间选择。 */
export const EXA_DEFAULT_SEARCH_TYPE = 'auto'

/** 每个结果请求的默认突出句子数。 */
export const EXA_DEFAULT_HIGHLIGHTS_PER_RESULT = 1

/** 每次请求发送的归因头。随包版本递增。 */
const USER_AGENT = 'deepseek-harness/0.0.1'

/** 已解析的提供方选项（插件的 `apply` 提供环境变量与常量默认值）。 */
export interface ExaSearchProviderOptions {
  /** Exa API 密钥。为空/缺失会使提供方不可用。 */
  apiKey: string
  /** 端点基址；会追加 `/search`。 */
  baseURL: string
  /** 作为 Exa 的 `type` 发送的检索模式。 */
  searchType: 'auto' | 'keyword' | 'neural'
  /** 当请求不带 `maxResults` 时的默认结果数。 */
  numResults?: number
  /** 每个结果请求的突出句子数（Exa 的 `highlightsPerUrl`）。 */
  highlightsPerResult: number
}

/**
 * 将一个 Exa 结果映射为归一化的来源，当它没有可移植的摘要时返回 `undefined`
 *（没有突出的条目会被丢弃 —— 该 seam 没有其他字段可派生摘要，编造一个会撒谎）。
 *
 * @param result - Exa 的 `results[]` 中的一个条目。
 * @returns 归一化的来源，或当该条目没有非空突出句时为 `undefined`。
 */
export function mapExaResult(result: ExaResult): WebSearchSource | undefined {
  const snippet = result.highlights?.find(highlight => highlight.trim().length > 0)
  if (snippet === undefined) return undefined
  return {
    url: result.url,
    ...result.title != null && result.title.length > 0 ? { title: result.title } : {},
    snippet,
    ...result.publishedDate != null && result.publishedDate.length > 0 ? { publishedAt: result.publishedDate } : {},
  }
}

/**
 * 将 Exa 响应信封映射为归一化的搜索结果。
 *
 * @param response - 解析后的 `POST /search` 响应体。
 * @returns 归一化的结果；无摘要的条目被丢弃（{@link mapExaResult}）。
 */
export function mapExaResponse(response: ExaSearchResponse): WebSearchResult {
  const sources = (response.results ?? [])
    .map(mapExaResult)
    .filter((source): source is WebSearchSource => source !== undefined)
  // Exa 不返回生成的答案，因此省略 `content`。web 服务拥有最终的
  // `maxResults` 截断，因此此提供方报告 `truncated: false`。
  return { sources, truncated: false }
}

/** 由 Exa 支持的搜索提供方；HTTP 重定向作为 `WEB_PROVIDER_ERROR` 失败。 */
export class ExaSearchProvider implements WebSearchProvider {
  readonly id = EXA_PROVIDER_ID

  constructor(private readonly options: ExaSearchProviderOptions) {}

  available(): boolean {
    return this.options.apiKey.length > 0
      && isValidBaseUrl(this.options.baseURL)
      && isPositiveInteger(this.options.highlightsPerResult)
      && (this.options.numResults === undefined || isPositiveInteger(this.options.numResults))
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    // 每请求上限胜过配置的默认值；任一都可能缺失。
    const numResults = request.maxResults ?? this.options.numResults
    let response: Response
    try {
      response = await fetch(`${this.options.baseURL}/search`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'authorization': `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
          'accept': 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify({
          query: request.query,
          type: this.options.searchType,
          contents: { highlights: { highlightsPerUrl: this.options.highlightsPerResult } },
          ...numResults !== undefined ? { numResults } : {},
        }),
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Exa search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Exa search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      const status = response.status
      let message = `Exa API error (HTTP ${status})`
      try {
        const parsed = await response.json() as ExaError
        const detail = parsed.error ?? parsed.message
        if (detail !== undefined && detail.length > 0) message = detail
      } catch (error: unknown) {
        // 在正文读取中途触发的取消必须以 WEB_ABORTED 呈现，而不能被吞入一个
        // 泛化的 HTTP 错误消息 —— 取消不是提供方错误（该 seam 的取消契约）。
        if (isAbortError(error)) throw new WebError('Exa search aborted', 'WEB_ABORTED', { cause: error })
        // 否则：HTTP 状态已在上方的 `message` 中捕获；一个畸形/非 JSON 的错误体
        //（网关 5xx/429 的常见情况）最多损失一个更丰富的提供方消息，绝不会丢失真实错误。
      }
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    try {
      const payload = await response.json() as ExaSearchResponse
      return mapExaResponse(payload)
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Exa search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Exa returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }
}

/** 当 `baseURL` 解析为绝对 URL 时返回 true（廉价的本地配置检查）。 */
function isValidBaseUrl(baseURL: string): boolean {
  return URL.canParse(baseURL)
}

/** 对于可以发往 Exa 的请求上限（正整数）返回 true。 */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

/** 对于 fetch/`AbortSignal` 的取消返回 true，以 `WEB_ABORTED` 呈现。 */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
