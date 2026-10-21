/**
 * 通过 Perplexity 兼容 OpenAI 的 chat-completions 端点进行搜索。生成的答案成为 `content`；
 * 来源优先采用结构化的 `search_results[]`，并回退到仅含 URL 的 `citations[]`。线格式与
 * 原生 `fetch` 客户端都是提供方私有的，不使用 `ctx.llm`。
 * @module @deepseek-ai/dsh-web-search-perplexity/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { PerplexityError, PerplexityResponse, PerplexitySearchResult } from './types.ts'

/** 本提供方注册的固定 id。 */
export const PERPLEXITY_PROVIDER_ID = 'perplexity'

/** 默认 Perplexity 端点；`/chat/completions` 是操作。 */
export const PERPLEXITY_DEFAULT_BASE_URL = 'https://api.perplexity.ai'

/** 默认搜索模型。 */
export const PERPLEXITY_DEFAULT_MODEL = 'sonar'

/** 生成答案令牌的默认上限。 */
export const PERPLEXITY_DEFAULT_MAX_TOKENS = 1024

/** Perplexity 为 `search_recency_filter` 接受的时效性过滤值。 */
export type PerplexityRecency = 'day' | 'week' | 'month' | 'year'

/** 每次请求发送的归因头。随包版本递增。 */
const USER_AGENT = 'deepseek-harness/0.0.1'

/** 已解析的提供方选项（插件的 `apply` 提供环境变量与常量默认值）。 */
export interface PerplexitySearchProviderOptions {
  /** Perplexity API 密钥。为空/缺失会使提供方不可用。 */
  apiKey: string
  /** 端点基址；会追加 `/chat/completions`。 */
  baseURL: string
  /** 搜索模型名。 */
  model: string
  /** 生成答案令牌的上限（`max_tokens`）。 */
  maxTokens: number
  /** 作为 `search_recency_filter` 发送的可选时效性窗口；省略 = 无过滤。 */
  searchRecency?: PerplexityRecency
}

/**
 * 将一个结构化的 Perplexity 搜索结果映射为归一化的来源。
 *
 * @param result - 响应 `search_results[]` 中的一个条目。
 * @returns 归一化的来源；空白字段被省略而非设为空。
 */
export function mapPerplexityResult(result: PerplexitySearchResult): WebSearchSource {
  return {
    url: result.url,
    ...result.title != null && result.title.length > 0 ? { title: result.title } : {},
    ...result.snippet != null && result.snippet.length > 0 ? { snippet: result.snippet } : {},
    ...result.date != null && result.date.length > 0 ? { publishedAt: result.date } : {},
  }
}

/**
 * 将 Perplexity 响应信封映射为归一化的搜索结果。优先采用结构化的 `search_results[]`；
 * 仅当 `search_results` 缺失时，回退到仅含 URL 的 `citations[]`（这些来源只携带一个 `url`）。
 *
 * @param response - 解析后的 chat-completions 响应体。
 * @returns 归一化的结果；当答案为空时省略 `content`。
 */
export function mapPerplexityResponse(response: PerplexityResponse): WebSearchResult {
  const content = response.choices?.[0]?.message?.content
  const sources: WebSearchSource[] = response.search_results !== undefined
    ? response.search_results.map(mapPerplexityResult)
    : (response.citations ?? []).map(url => ({ url }))
  return {
    ...content != null && content.length > 0 ? { content } : {},
    sources,
    truncated: false,
  }
}

/** 由 Perplexity 支持的搜索提供方；HTTP 重定向作为 `WEB_PROVIDER_ERROR` 失败。 */
export class PerplexitySearchProvider implements WebSearchProvider {
  readonly id = PERPLEXITY_PROVIDER_ID

  constructor(private readonly options: PerplexitySearchProviderOptions) {}

  // 可用性检查紧贴每个提供方各异的配置契约；一个共享基类会掩盖哪些字段使此后端可用。
  /* jscpd:ignore-start */
  available(): boolean {
    return this.options.apiKey.length > 0
      && URL.canParse(this.options.baseURL)
      && isPositiveInteger(this.options.maxTokens)
  }
  /* jscpd:ignore-end */

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    let response: Response
    try {
      response = await fetch(`${this.options.baseURL}/chat/completions`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'authorization': `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
          'accept': 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify({
          model: this.options.model,
          max_tokens: this.options.maxTokens,
          messages: [{ role: 'user', content: request.query }],
          ...this.options.searchRecency !== undefined ? { search_recency_filter: this.options.searchRecency } : {},
        }),
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Perplexity search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Perplexity search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      const status = response.status
      let message = `Perplexity API error (HTTP ${status})`
      try {
        const parsed = await response.json() as PerplexityError
        const detail = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? parsed.message
        if (detail !== undefined && detail.length > 0) message = detail
      } catch (error: unknown) {
        // 在正文读取中途触发的取消必须以 WEB_ABORTED 呈现，而不能被吞入一个
        // 泛化的 HTTP 错误消息 —— 取消不是提供方错误（该 seam 的取消契约）。
        if (isAbortError(error)) throw new WebError('Perplexity search aborted', 'WEB_ABORTED', { cause: error })
        // 否则：HTTP 状态已在上方的 `message` 中捕获；一个畸形/非 JSON 的错误体
        //（网关 5xx/429 的常见情况）最多损失一个更丰富的提供方消息，绝不会丢失真实错误。
      }
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    try {
      const payload = await response.json() as PerplexityResponse
      return mapPerplexityResponse(payload)
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Perplexity search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Perplexity returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }
}

// 这两个谓词是刻意局部的：从公共 web seam 导出通用的内部实现会为这些纯检查添加超出所需的 API。
/* jscpd:ignore-start */
/** 对于 fetch/`AbortSignal` 的取消返回 true，以 `WEB_ABORTED` 呈现。 */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** 对于可以发往 Perplexity 的请求上限（正整数）返回 true。 */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}
/* jscpd:ignore-end */
