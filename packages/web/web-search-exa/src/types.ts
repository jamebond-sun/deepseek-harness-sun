/**
 * Exa 搜索 API 的线类型（`POST https://api.exa.ai/search`）。仅类型 —— 无运行时代码。
 * Exa 返回一个扁平的 `results[]`；每个条目携带一个 URL、可选 title、可选 `publishedDate`，
 * 以及（当请求突出句时）一个 `highlights[]` 显著句子数组。
 *
 * @module @deepseek-ai/dsh-web-search-exa/types
 */

/** 发送给 Exa 搜索端点的请求体。 */
export interface ExaSearchRequest {
  query: string
  /** 检索模式：关键词、神经（嵌入）或 auto（Exa 决定）。 */
  type: 'auto' | 'keyword' | 'neural'
  /** Exa 的结果数控制；该 seam 在返回时仍强制实施上限。 */
  numResults?: number
  /** 要求 Exa 返回每个结果的突出句子。 */
  contents: { highlights: { highlightsPerUrl: number } }
}

/** Exa 扁平 `results[]` 中的一个条目。 */
export interface ExaResult {
  url: string
  title?: string | null
  publishedDate?: string | null
  highlights?: string[]
}

/** Exa 的搜索响应信封。 */
export interface ExaSearchResponse {
  results?: ExaResult[]
}

/** Exa 的错误响应信封（尽力而为；字段因失败而异）。 */
export interface ExaError {
  error?: string
  message?: string
}
