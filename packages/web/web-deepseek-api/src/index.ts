/**
 * 在 `ctx.web` 中将 DeepSeek 搜索与抓取 API 注册为 `deepseek-search-api`
 * 和 `deepseek-fetch-api`。每次操作都是一次直接的 API 请求，无需辅助模型请求；
 * 两个提供方都读取本节的凭据和 API 基址。`web.searchProvider` 和 `web.fetchProvider`
 * 选择它们。基于 DeepSeek 账号路由的会话在账号服务允许该端点时，使用账号令牌进行认证；
 * 所有其他请求使用配置的密钥。
 * @module @deepseek-ai/dsh-web-deepseek-api
 */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-web'
import { DeepSeekFetchApiProvider } from './fetch.ts'
import { DEEPSEEK_DEFAULT_COUNT, DEEPSEEK_WEB_API_BASE_URL, DeepSeekSearchApiProvider } from './search.ts'
import { deepSeekWebAuth } from './transport.ts'

export { DEEPSEEK_FETCH_API_PROVIDER_ID, DeepSeekFetchApiProvider } from './fetch.ts'
export type { DeepSeekFetchApiOptions } from './fetch.ts'
export {
  DEEPSEEK_DEFAULT_COUNT, DEEPSEEK_SEARCH_API_PROVIDER_ID, DEEPSEEK_WEB_API_BASE_URL,
  DeepSeekSearchApiProvider, mapSearchResponse,
} from './search.ts'
export type { DeepSeekSearchApiOptions } from './search.ts'

/** 供加载器诊断使用的 Cordis 插件名。 */
export const name = 'web-deepseek-api'

/** 两个提供方都注册进入的 web seam。 */
export const inject = ['web']

/** 在下一次搜索或抓取之前读取的设置，无需重新注册任一提供方。 */
export interface Config {
  /** 字面 DeepSeek API 密钥；优先使用 {@link apiKeyEnv}，以免机密进入配置文件。 */
  apiKey: Volatile<string | undefined>
  /** 为每次操作解析的凭据引用；默认为 `DEEPSEEK_API_KEY`。 */
  apiKeyEnv: Volatile<string>
  /** API 基址，含路径前缀；会追加 `/search` 和 `/fetch`。 */
  baseURL: Volatile<string>
  /** 每次搜索的搜索 API 结果数，从 1 到 50；较小的请求上限胜出。默认 10。 */
  count: Volatile<number>
  /** 发送触发本次轮次的用户问题，限长 128 字符，作为 `ori_question`。默认 true。 */
  sendOriginalQuestion: Volatile<boolean>
}

export const Config = z.object({
  apiKey: z.string().role('secret').volatile(),
  apiKeyEnv: z.string().role('credential-ref').default('DEEPSEEK_API_KEY').volatile(),
  baseURL: z.string().default(DEEPSEEK_WEB_API_BASE_URL).volatile(),
  count: z.number().step(1).min(1).max(50).default(DEEPSEEK_DEFAULT_COUNT).volatile(),
  sendOriginalQuestion: z.boolean().default(true).volatile(),
})

/**
 * 读取最新一条人类提示词的文本，即触发本次轮次的问题。注入的用户角色上下文携带另一种来源类型。
 * @param session - 发起会话的 Session，当搜索在其中运行时。
 * @returns 提示词拼接后的文本块，无提示词时为 undefined。
 */
function latestUserQuestion(session: Session | undefined): string | undefined {
  const prompt = session?.deriveMessages().findLast(message => message.role === 'user' && message.source.kind === 'user')
  if (prompt === undefined) return undefined
  return prompt.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

/**
 * 在一个实时的设置节之上注册搜索 API 和抓取 API 提供方。
 * @param ctx - 拥有这两次注册的插件上下文。
 * @param config - 实时设置，每次操作读取一次。
 */
export function apply(ctx: Context, config: Config): void {
  const auth = () => deepSeekWebAuth(ctx, { apiKey: config.apiKey.get(), apiKeyEnv: config.apiKeyEnv.get() })
  ctx.web.registerSearchProvider(new DeepSeekSearchApiProvider(() => ({
    ...auth(),
    baseURL: config.baseURL.get(),
    count: config.count.get(),
    ...config.sendOriginalQuestion.get() ? {
      originalQuestion: () => latestUserQuestion(ctx.get('agents')?.currentInitiator()?.session),
    } : {},
  })))
  ctx.web.registerFetchProvider(new DeepSeekFetchApiProvider(() => ({ ...auth(), baseURL: config.baseURL.get() })))
}
