/**
 * 一个格式良好的提供方 API 密钥的唯一定义，由每一个把它放进 HTTP
 * 请求头的适配器共享。
 * @module @deepseek-ai/dsh-llm/api-key
 */

/**
 * HTTP 请求头值逐字承载、且每个已知提供方密钥都使用的字符：可打印 ASCII，
 * 不含空格。超出这一集合的密钥无法到达任何提供方——`fetch` 会拒绝构建
 * 该请求头——因此这是一条传输不变量，而非某个提供方的策略。
 * 有意排除 Latin-1：请求头本可以承载它，但没有提供方会签发它，
 * 而接纳它等于用一个本地可解释的拒绝去换一个不透明的 401。
 */
const LEGAL_API_KEY = /^[\x21-\x7E]+$/

/** 一个所提供的 API 密钥为何无法使用。 */
export type ApiKeyRejection = 'empty' | 'illegalCharacters'

/** 对一个所提供的 API 密钥的判定。 */
export type ApiKeyCheck =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: ApiKeyRejection }

/**
 * 判定一个*所提供的* API 密钥，先裁剪两侧的空白。
 *
 * 裁剪是静默的，因为一个带填充的密钥只有一种无歧义的读法；
 * 其他任何缺陷都会被报告。缺失是一种本函数永远不会看到的配置状态——
 * 一个没有指名任何凭据的 profile 会通过提供方自身的环境发现或 OAuth 认证——
 * 因此在询问之前，由调用方决定某个值是否已被提供。
 * @param raw - 密钥的配置、存储或键入的原本形式。
 * @returns 裁剪后的密钥，或它为何无法使用。
 */
export function normalizeApiKey(raw: string): ApiKeyCheck {
  const value = raw.trim()
  if (value.length === 0) return { ok: false, reason: 'empty' }
  if (!LEGAL_API_KEY.test(value)) return { ok: false, reason: 'illegalCharacters' }
  return { ok: true, value }
}
