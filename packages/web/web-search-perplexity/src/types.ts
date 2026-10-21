/**
 * Perplexity 搜索 API 的线类型（`POST https://api.perplexity.ai/chat/completions`，
 * 一个兼容 OpenAI 的聊天形状）。来源优先采用结构化的 `search_results`，并回退到仅含 URL 的
 * `citations`；提供方私有的线形状不依赖 `ctx.llm`。
 * @module @deepseek-ai/dsh-web-search-perplexity/types
 */

/** 发送给 Perplexity 的 chat-completions 端点的请求体。 */
export interface PerplexityRequest {
  model: string
  messages: { role: 'user'; content: string }[]
}

/** 一个结构化的搜索结果（首选的引用形状）。 */
export interface PerplexitySearchResult {
  url: string
  title?: string | null
  snippet?: string | null
  date?: string | null
}

/** Perplexity 的响应信封。 */
export interface PerplexityResponse {
  choices?: { message?: { content?: string | null } }[]
  /** 结构化的引用数据（首选）。 */
  search_results?: PerplexitySearchResult[]
  /** 仅含 URL 的引用回退。 */
  citations?: string[]
}

/** Perplexity 的错误响应信封（尽力而为；字段各异）。 */
export interface PerplexityError {
  error?: { message?: string } | string
  message?: string
}
