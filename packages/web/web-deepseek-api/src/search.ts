/**
 * DeepSeek 搜索 API 提供方：每次搜索一次直接请求，无需辅助模型请求。
 * @module @deepseek-ai/dsh-web-deepseek-api/search
 */
import type { WebSearchProvider, WebSearchRequest, WebSearchResult } from '@deepseek-ai/dsh-web'
import {
  dispatchDeepSeekWeb, hasDeepSeekWebCredential, invalidResponse, isRecord,
  type DeepSeekWebAuth, type DeepSeekWebGuidance,
} from './transport.ts'

/** 搜索 API 提供方在搜索注册表中注册的固定 id。 */
export const DEEPSEEK_SEARCH_API_PROVIDER_ID = 'deepseek-search-api'

/** 搜索与抓取 API 的默认基址，含其 `/v1/tools` 前缀；会追加 `/search` 和 `/fetch`。 */
export const DEEPSEEK_WEB_API_BASE_URL = 'https://api.deepseek.com/v1/tools'

/** 搜索 API 的默认结果数，即服务自身的默认值。 */
export const DEEPSEEK_DEFAULT_COUNT = 10

/** 搜索 API 接受的 `ori_question` 最大长度（字符）。 */
const ORIGINAL_QUESTION_MAX_CHARS = 128

/** 本包中任一 API 端点失败时所命名的设置。 */
export const DEEPSEEK_WEB_API_GUIDANCE: Omit<DeepSeekWebGuidance, 'subject'> = {
  plugin: 'web-deepseek-api', field: 'baseURL', label: 'Search / Fetch API base URL', page: 'Web search',
}

/** 为一次搜索快照化的认证、端点和结果设置。 */
export interface DeepSeekSearchApiOptions extends DeepSeekWebAuth {
  /** API 基址，含路径前缀；会追加 `/search`。 */
  baseURL: string
  /** 每次搜索请求的结果数，从 1 到 50；较小的请求上限胜出。 */
  count: number
  /** 读取触发搜索的用户问题；undefined 或空则不发送。 */
  originalQuestion?: () => string | undefined
}

/**
 * 校验搜索 API 响应并将其来源投影到 web 服务中。
 * @param response - 来自搜索端点的不可信 JSON。
 * @returns 保留提供方顺序以及可空发布日期的来源。
 * @throws 当响应不包含合法搜索结果时抛出 {@link WebError}。
 */
export function mapSearchResponse(response: unknown): WebSearchResult {
  if (!isRecord(response) || !Array.isArray(response.results)) throw invalidResponse()
  const sources = response.results.map((item: unknown) => {
    if (!isRecord(item) || typeof item.url !== 'string' || item.url.length === 0
      || typeof item.title !== 'string' || typeof item.snippet !== 'string'
      || (item.date !== null && typeof item.date !== 'string')) throw invalidResponse()
    return {
      url: item.url,
      ...item.title.length > 0 ? { title: item.title } : {},
      ...item.snippet.length > 0 ? { snippet: item.snippet } : {},
      ...item.date !== null && item.date.length > 0 ? { publishedAt: item.date } : {},
    }
  })
  return { sources, truncated: false }
}

/**
 * 通过 DeepSeek 搜索 API 搜索。HTTP 重定向作为 `WEB_PROVIDER_ERROR` 失败；
 * 分发之后的失败会指出端点，并告诉模型用户如何配置它。
 */
export class DeepSeekSearchApiProvider implements WebSearchProvider {
  readonly id = DEEPSEEK_SEARCH_API_PROVIDER_ID

  /**
   * @param resolveOptions - 供下一次搜索使用的选项，在每次搜索入口处读取一次，
   *   因此一次搜索绝不会混用两个设置节。
   */
  constructor(private readonly resolveOptions: () => DeepSeekSearchApiOptions) {}

  available(): boolean {
    const options = this.resolveOptions()
    return hasDeepSeekWebCredential(options) && URL.canParse(options.baseURL) && isPositiveInteger(options.count)
  }

  search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const options = this.resolveOptions()
    const question = boundedQuestion(options.originalQuestion?.())
    return dispatchDeepSeekWeb(options, {
      endpoint: `${options.baseURL.replace(/\/+$/u, '')}/search`,
      body: {
        query: request.query,
        count: Math.min(options.count, request.maxResults ?? options.count),
        need_content: false,
        ...question === undefined ? {} : { ori_question: question },
      },
      decode: mapSearchResponse,
      guidance: { subject: 'Search', ...DEEPSEEK_WEB_API_GUIDANCE },
    }, signal)
  }
}

/**
 * 将触发的问题限制为 `ori_question` 所接受的范围：空白折叠为单个空格，并保留前 128 个字符。
 * @param question - 用户问题，当存在时。
 * @returns 受限后的问题，或无剩余内容时为 undefined。
 */
function boundedQuestion(question: string | undefined): string | undefined {
  const collapsed = question?.replace(/\s+/gu, ' ').trim() ?? ''
  if (collapsed.length === 0) return undefined
  return Array.from(collapsed).slice(0, ORIGINAL_QUESTION_MAX_CHARS).join('')
}

/** 对于正整数的请求上限返回 true。 */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}
