/**
 * 由 Perplexity 支持的 `WebSearchProvider` 插件。它贡献于 `ctx.web` 注册表，
 * 但不拥有该服务。
 *
 * @module @deepseek-ai/dsh-web-search-perplexity
 */

import type { Context } from '@deepseek-ai/cordis'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import { PerplexitySearchProvider, PERPLEXITY_DEFAULT_BASE_URL, PERPLEXITY_DEFAULT_MAX_TOKENS, PERPLEXITY_DEFAULT_MODEL } from './provider.ts'

export {
  PERPLEXITY_DEFAULT_BASE_URL,
  PERPLEXITY_DEFAULT_MAX_TOKENS,
  PERPLEXITY_DEFAULT_MODEL,
  PERPLEXITY_PROVIDER_ID,
  PerplexitySearchProvider,
} from './provider.ts'
export type { PerplexityRecency, PerplexitySearchProviderOptions } from './provider.ts'

/** 供加载器诊断使用的 Cordis 插件名。 */
export const name = 'web-search-perplexity'

/** 该提供方注册进入的 web seam。 */
export const inject = ['web']

/** 插件配置（全部可选 —— `apply` 会填入环境变量与常量默认值）。 */
export interface Config {
  /** Perplexity API 密钥。回退到 `$PERPLEXITY_API_KEY`。为空 → 不可用。 */
  apiKey?: string
  /** 端点基址；会追加 `/chat/completions`。默认为公共 API。 */
  baseURL?: string
  /** 搜索模型名。默认为 `sonar`。 */
  model?: string
  /** 生成答案令牌的上限。默认为 1024。 */
  maxTokens?: number
  /** 作为 `search_recency_filter` 发送的时效性窗口。省略 = 无过滤。 */
  searchRecency?: 'day' | 'week' | 'month' | 'year'
}

export const Config: z<Config> = z.object({
  apiKey: z.string(),
  baseURL: z.string(),
  model: z.string(),
  maxTokens: z.number().step(1).min(1),
  searchRecency: z.union(['day', 'week', 'month', 'year'] as const),
})

/** 向 `ctx.web` 注册 Perplexity 搜索提供方。 */
export function apply(ctx: Context, config: Config): void {
  ctx.web.registerSearchProvider(new PerplexitySearchProvider({
    // 每一层环境都可能命名此密钥：产品信任其被启动于其中的项目，托管存储不在此涉及。
    apiKey: config.apiKey ?? launchEnvironmentOf(ctx).get('PERPLEXITY_API_KEY')?.value ?? '',
    baseURL: config.baseURL ?? PERPLEXITY_DEFAULT_BASE_URL,
    model: config.model ?? PERPLEXITY_DEFAULT_MODEL,
    maxTokens: config.maxTokens ?? PERPLEXITY_DEFAULT_MAX_TOKENS,
    ...config.searchRecency !== undefined ? { searchRecency: config.searchRecency } : {},
  }))
}
