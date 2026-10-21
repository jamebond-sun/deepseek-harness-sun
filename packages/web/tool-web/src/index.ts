/**
 * 基于 `ctx.web` 的、面向模型的 `web_search` 与 `web_fetch` 工具。本包只负责
 * 模式定义、校验、提示词指导、限制和呈现，绝不负责具体的提供方。启用开关控制
 * 工具的注册：一个已启用的工具在其提供方不可用时仍保持可见，并在执行时以结构化
 * 错误失败。
 * @module @deepseek-ai/dsh-tool-web
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import { applyWebSearchTool, WEB_SEARCH_MAX_QUERIES, WEB_SEARCH_MAX_RESULTS } from './search.ts'
import { applyWebFetchTool } from './fetch.ts'

export { WEB_SEARCH_MAX_QUERIES, WEB_SEARCH_MAX_RESULTS, applyWebSearchTool, formatSearchOutput, presentSearchCall, presentSearchResult, searchMetaFromValue, searchMetaFromResult } from './search.ts'
export type { WebSearchMeta } from './search.ts'
export { applyWebFetchTool, formatFetchOutput, parseFetchArgs, presentFetchCall, presentFetchResult, fetchMetaFromValue, fetchMetaFromResult } from './fetch.ts'
export type { WebFetchMeta } from './fetch.ts'

/** 供加载器诊断使用的 Cordis 插件名。 */
export const name = 'tool-web'

/** 网络工具套件所需的服务。 */
export const inject = ['tools', 'web', 'systemPrompt']

/** 网络工具的默认协作式工具调用超时预算（毫秒）。 */
export const DEFAULT_WEB_TOOL_TIMEOUT_MS = 30_000

/**
 * 单次 `web_fetch` 输出以及同步转换的源字符数的默认上限。该值为本地提供方默认的
 * 100,000 字符正文上限之上留出余量，同时限制自定义提供方和呈现后的输出。
 */
export const DEFAULT_FETCH_MAX_OUTPUT_CHARS = 200_000

/** 插件配置：要注册哪些网络工具、搜索边界、各工具预算以及 fetch 输出上限。 */
export interface Config {
  /** 注册 `web_search`。默认为 true。 */
  search?: boolean
  /** 注册 `web_fetch`。默认为 true。 */
  fetch?: boolean
  /** 单次 `web_search` 调用返回的来源数量上限。 */
  searchMaxResults?: number
  /** 单次 `web_search` 调用接受的查询数量上限。 */
  searchMaxQueries?: number
  /** `web_fetch` 的协作式超时预算（毫秒）。默认 30000。 */
  fetchTimeoutMs?: number
  /** `web_search` 的协作式超时预算（毫秒）。默认 30000。 */
  searchTimeoutMs?: number
  /** 转换的源字符数以及完整的 `web_fetch` 输出字符数上限。默认 200000。 */
  fetchMaxOutputChars?: number
}

export const Config: z<Config> = z.object({
  search: z.boolean().default(true),
  fetch: z.boolean().default(true),
  searchMaxResults: z.number().default(WEB_SEARCH_MAX_RESULTS),
  searchMaxQueries: z.number().default(WEB_SEARCH_MAX_QUERIES),
  fetchTimeoutMs: z.number().default(DEFAULT_WEB_TOOL_TIMEOUT_MS),
  searchTimeoutMs: z.number().default(DEFAULT_WEB_TOOL_TIMEOUT_MS),
  fetchMaxOutputChars: z.number().default(DEFAULT_FETCH_MAX_OUTPUT_CHARS),
})

/** schemastery 套用所有字段默认值之后的完整配置。 */
type ResolvedConfig = Required<Config>

/** 配置得到的计数、超时和字符上限必须为正整数。 */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-web: ${name} must be a positive integer`)
  }
}

/**
 * 注册已启用的网络工具。`search`/`fetch` 默认均为 true；若某产品只想要其中之一，
 * 可在配置中禁用另一个。每个工具的协作式超时预算（`fetchTimeoutMs`/`searchTimeoutMs`，
 * 默认 30000）在此处解析，并作为 `ToolDefinition.timeoutMs` 附加到工具上，由
 * `@deepseek-ai/dsh-tool-call-timeout-policy` 强制实施。这些工具的清理器是
 * 纤程作用域的（基于 effect 的注册表在 dispose 时自行清理），因此无需手动拆除。
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery（Config）已经填好了每一个默认字段。
  const resolved = config as ResolvedConfig
  assertPositiveInteger('searchMaxResults', resolved.searchMaxResults)
  assertPositiveInteger('searchMaxQueries', resolved.searchMaxQueries)
  assertPositiveInteger('fetchTimeoutMs', resolved.fetchTimeoutMs)
  assertPositiveInteger('searchTimeoutMs', resolved.searchTimeoutMs)
  assertPositiveInteger('fetchMaxOutputChars', resolved.fetchMaxOutputChars)
  if (resolved.search) {
    applyWebSearchTool(ctx, resolved.searchMaxResults, resolved.searchMaxQueries, resolved.searchTimeoutMs, resolved.fetch)
  }
  if (resolved.fetch) applyWebFetchTool(ctx, resolved.fetchTimeoutMs, resolved.fetchMaxOutputChars)
}
