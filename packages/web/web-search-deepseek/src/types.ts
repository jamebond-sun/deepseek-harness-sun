/**
 * DeepSeek 兼容 Anthropic 的 Messages API 的提供方私有线类型。可引用的结果项和引用摘录
 * 到达不同的块中；提供方按 URL 将它们连接。这些类型不创建对 `ctx.llm` 的依赖。
 * @module @deepseek-ai/dsh-web-search-deepseek/types
 */

/** `web_search_tool_result` 块内的一个 `web_search_result` 项。 */
export interface WebSearchResultItem {
  type: string
  url: string
  title?: string | null
  /** 提供方提供的页面年龄/时效性字符串（映射为 `publishedAt`）。 */
  page_age?: string | null
}

/** 一个 `web_search_tool_result` 内容块：可引用的结果形状。 */
export interface WebSearchToolResultBlock {
  type: 'web_search_tool_result'
  content?: WebSearchResultItem[]
}

/** `text` 块内的一个引用位置（摘要来源）。 */
export interface CitationLocation {
  type?: string
  url?: string | null
  cited_text?: string | null
}

/** 一个 `text` 内容块：模型的散文加上按 URL 的引用。 */
export interface TextBlock {
  type: 'text'
  text?: string | null
  citations?: CitationLocation[]
}

/** 任意内容块；只有 `web_search_tool_result` 与 `text` 被消费。 */
export type ContentBlock = WebSearchToolResultBlock | TextBlock | { type: string }

/** DeepSeek 的 Anthropic Messages 响应信封。 */
export interface AnthropicResponse {
  content?: ContentBlock[]
}

/** DeepSeek 的错误响应信封（尽力而为；字段各异）。 */
export interface AnthropicError {
  error?: { message?: string } | string
  message?: string
}
