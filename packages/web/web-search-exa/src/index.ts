/**
 * 由 Exa 支持的 `WebSearchProvider` 插件。它贡献于 `ctx.web` 注册表，
 * 但不拥有该服务。
 *
 * @module @deepseek-ai/dsh-web-search-exa
 */

import type { Context } from '@deepseek-ai/cordis'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import {
  ExaSearchProvider,
  EXA_DEFAULT_BASE_URL,
  EXA_DEFAULT_HIGHLIGHTS_PER_RESULT,
  EXA_DEFAULT_SEARCH_TYPE,
} from './provider.ts'

export {
  EXA_DEFAULT_BASE_URL,
  EXA_DEFAULT_HIGHLIGHTS_PER_RESULT,
  EXA_DEFAULT_SEARCH_TYPE,
  EXA_PROVIDER_ID,
  ExaSearchProvider,
} from './provider.ts'
export type { ExaSearchProviderOptions } from './provider.ts'

/** 供加载器诊断使用的 Cordis 插件名。 */
export const name = 'web-search-exa'

/** 该提供方注册进入的 web seam。 */
export const inject = ['web']

/** 插件配置（全部可选 —— `apply` 会填入环境变量与常量默认值）。 */
export interface Config {
  /** Exa API 密钥。回退到 `$EXA_API_KEY`。为空 → 提供方不可用。 */
  apiKey?: string
  /** 端点基址；会追加 `/search`。默认为公共 API。 */
  baseURL?: string
  /** 作为 Exa 的 `type` 发送的检索模式。默认为 `auto`。 */
  searchType?: 'auto' | 'keyword' | 'neural'
  /** 当请求不带 `maxResults` 时的默认结果数。省略 = 无。 */
  numResults?: number
  /** 每个结果请求的突出句子数。默认为 1。 */
  highlightsPerResult?: number
}

export const Config: z<Config> = z.object({
  apiKey: z.string(),
  baseURL: z.string(),
  searchType: z.union(['auto', 'keyword', 'neural'] as const),
  numResults: z.number().step(1).min(1),
  highlightsPerResult: z.number().step(1).min(1),
})

/** 向 `ctx.web` 注册 Exa 搜索提供方。 */
export function apply(ctx: Context, config: Config): void {
  ctx.web.registerSearchProvider(new ExaSearchProvider({
    // 每一层环境都可能命名此密钥：产品信任其被启动于其中的项目，托管存储不在此涉及。
    apiKey: config.apiKey ?? launchEnvironmentOf(ctx).get('EXA_API_KEY')?.value ?? '',
    baseURL: config.baseURL ?? EXA_DEFAULT_BASE_URL,
    searchType: config.searchType ?? EXA_DEFAULT_SEARCH_TYPE,
    highlightsPerResult: config.highlightsPerResult ?? EXA_DEFAULT_HIGHLIGHTS_PER_RESULT,
    ...config.numResults !== undefined ? { numResults: config.numResults } : {},
  }))
}
