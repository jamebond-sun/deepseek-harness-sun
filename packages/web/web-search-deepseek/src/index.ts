/**
 * 在 `ctx.web` 中注册一个 DeepSeek 支持的提供方。它调用兼容 Anthropic 的 Messages API，
 * 使用原生的 `web_search_20250305`。由 DeepSeek 账号路由上的会话发起的搜索，在账号服务允许
 * 该搜索端点时使用账号令牌认证；所有其他搜索复用 `DEEPSEEK_API_KEY`。该提供方不复用
 * `DEEPSEEK_BASE_URL`；辅助搜索有其自己的端点配置。
 * @module @deepseek-ai/dsh-web-search-deepseek
 */
import type { Volatile } from '@deepseek-ai/cordis'

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-web'
import {
  DeepSeekSearchProvider,
  DEEPSEEK_DEFAULT_API_VERSION,
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_MAX_TOKENS,
  DEEPSEEK_DEFAULT_MAX_USES,
  DEEPSEEK_DEFAULT_MODEL,
} from './provider.ts'
import type { DeepSeekSearchProviderOptions } from './provider.ts'

export {
  DeepSeekSearchProvider,
  DEEPSEEK_DEFAULT_API_VERSION,
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_MAX_TOKENS,
  DEEPSEEK_DEFAULT_MAX_USES,
  DEEPSEEK_DEFAULT_MODEL,
  DEEPSEEK_PROVIDER_ID,
} from './provider.ts'
export type { DeepSeekSearchLlmRequest, DeepSeekSearchProviderOptions } from './provider.ts'

/** 供加载器诊断使用的 Cordis 插件名。 */
export const name = 'web-search-deepseek'

/** 该提供方注册进入的 web seam。 */
export const inject = ['web']

const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'

/** 插件配置（全部可选 —— `apply` 会填入环境变量与常量默认值）。 */
export interface Config {
  /** 字面 DeepSeek API 密钥；优先使用 {@link apiKeyEnv}，以免机密进入配置文件。 */
  apiKey: Volatile<string | undefined>
  /** 为每次搜索解析的凭据引用；默认为 `DEEPSEEK_API_KEY`。 */
  apiKeyEnv: Volatile<string>
  /** 兼容 Anthropic 的端点基址；会追加 `/messages`。 */
  baseURL: Volatile<string | undefined>
  /** Anthropic 格式的模型名。默认为 `deepseek-v4-flash`。 */
  model: Volatile<string>
  /** `anthropic-version` 头的值。默认为 `2023-06-01`。 */
  apiVersion: Volatile<string>
  /** Messages 请求生成令牌的上限。默认为 4096。 */
  maxTokens: Volatile<number>
  /** 每次请求 `web_search` 服务端工具的最大使用次数。默认为 5。 */
  maxUses: Volatile<number>
}

export const Config = z.object({
  apiKey: z.string().role('secret').volatile(),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV).volatile(),
  // 在此声明而非仅在调用点声明：一个配置界面会渲染解析后的节，因此模式未携带的默认值
  // 在那里会被读作完全没有值。
  baseURL: z.string().volatile(),
  model: z.string().default(DEEPSEEK_DEFAULT_MODEL).volatile(),
  apiVersion: z.string().default(DEEPSEEK_DEFAULT_API_VERSION).volatile(),
  maxTokens: z.number().step(1).min(1).default(DEEPSEEK_DEFAULT_MAX_TOKENS).volatile(),
  maxUses: z.number().step(1).min(1).default(DEEPSEEK_DEFAULT_MAX_USES).volatile(),
})

/**
 * 独立于对话适配器的 `$DEEPSEEK_BASE_URL` 和所选协议的辅助搜索端点。
 */
const SEARCH_BASE_URL_ENV = 'DEEPSEEK_SEARCH_BASE_URL'

/** `dsh-llm-deepseek-account` 注册的提供方路由 id；`request/context` 事件按会话记录它。 */
const ACCOUNT_PROVIDER = 'deepseek-account'

/** 携带本提供方端点、模型和密钥引用的设置命名空间。 */
export const WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE = 'web-search-deepseek'

/**
 * 将一个解析后的节投影为提供方下一次搜索所用的选项。环境回退保留在这里而非提供方中：
 * 它读取的每个值都已完全默认化。
 * @param ctx - 提供凭据与环境平面的插件上下文。
 * @param config - 当前权威的节。
 * @returns 一次搜索的选项。
 */
function resolveOptions(
  ctx: Context, config: { [K in keyof Config]: ReturnType<Config[K]['get']> },
): DeepSeekSearchProviderOptions {
  const apiKeyEnv = credentialRef(config.apiKeyEnv)
  const literalApiKey = config.apiKey !== undefined && config.apiKey.length > 0
    ? config.apiKey
    : undefined
  return {
    ...literalApiKey === undefined ? {} : { apiKey: literalApiKey },
    resolveAccountToken: async (endpoint) => {
      // 最新的请求上下文命名了服务于调用此搜索的模型请求的路由，
      // 因为账号登出会读取它。
      const provider = ctx.get('agents')?.currentInitiator()?.session.requestContext()?.provider
      if (provider !== ACCOUNT_PROVIDER) return undefined
      return await ctx.get('deepseekAccount')?.resolveToken(endpoint)
    },
    resolveApiKey: async () => {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) return (await credentials.resolve(apiKeyEnv))?.value
      // 没有该 seam 时，环境就是整个凭据平面。
      const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv)
      return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
    },
    apiKeyEnv,
    baseURL: config.baseURL
      ?? launchEnvironmentOf(ctx).get(SEARCH_BASE_URL_ENV)?.value
      ?? DEEPSEEK_DEFAULT_BASE_URL,
    model: config.model,
    apiVersion: config.apiVersion,
    maxTokens: config.maxTokens,
    maxUses: config.maxUses,
    recordRequest: (request) => {
      ctx.get('agents')?.currentInitiator()?.session.append(
        'web/deepseek-search-llm-request',
        request,
      )
    },
  }
}

/** 向 `ctx.web` 注册 DeepSeek 搜索提供方。 */
export function apply(ctx: Context, config: Config): void {
  ctx.web.registerSearchProvider(new DeepSeekSearchProvider(() => resolveOptions(ctx, {
    apiKey: config.apiKey.get(), apiKeyEnv: config.apiKeyEnv.get(), baseURL: config.baseURL.get(), model: config.model.get(),
    apiVersion: config.apiVersion.get(), maxTokens: config.maxTokens.get(), maxUses: config.maxUses.get(),
  })))
}
