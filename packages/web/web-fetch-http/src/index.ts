/**
 * 匿名公共 HTTP(S) `WebFetchProvider` 插件。它贡献于 `ctx.web` 注册表，
 * 但不拥有该服务。
 *
 * @module @deepseek-ai/dsh-web-fetch-http
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import { HttpFetchProvider } from './provider.ts'
import type { HttpFetchLimits } from './provider.ts'

const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647

export {
  LOCAL_FETCH_PROVIDER_ID,
  HttpFetchProvider,
} from './provider.ts'
export type { HttpFetchLimits, HttpFetchResolver } from './provider.ts'

/** 默认 `User-Agent`：一个明确的产品代理，绝不是浏览器伪装。 */
export const DEFAULT_USER_AGENT = 'deepseek-harness/0.0.1 (+https://github.com/deepseek-ai)'

/** 供加载器诊断使用的 Cordis 插件名。 */
export const name = 'web-fetch-http'

/** 该提供方注册进入的 web seam。 */
export const inject = ['web']

/** 插件配置：提供方的传输与大小限制，以及其 `User-Agent`（均带默认值）。 */
export interface Config {
  /** 响应正文的最大字节数。 */
  maxResponseBytes?: number
  /** 已解码正文的最大字符数。 */
  maxBodyChars?: number
  /** Node 计时器范围内的默认抓取超时（毫秒）。 */
  timeoutMs?: number
  /** 要跟随的同源重定向跳数上限。 */
  maxRedirects?: number
  /** 每次请求发送的 `User-Agent` 头。 */
  userAgent?: string
}

export const Config: z<Config> = z.object({
  maxResponseBytes: z.number().default(5_000_000),
  maxBodyChars: z.number().default(100_000),
  timeoutMs: z.number().default(30_000),
  maxRedirects: z.number().default(5),
  userAgent: z.string().default(DEFAULT_USER_AGENT),
})

/** schemastery 套用所有字段默认值之后的完整配置。 */
type ResolvedConfig = Required<Config>

/** 一个资源限制（字节/字符/长度/超时上限）必须是正有限数。 */
function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`web-fetch-http: ${name} must be a positive finite number`)
  }
}

/** Node 会把更大的计时器延迟强制为 1 ms，因此在配置时就拒绝它们。 */
function assertTimeoutMs(value: number): void {
  assertPositiveFinite('timeoutMs', value)
  if (value > MAX_NODE_TIMER_DELAY_MS) {
    throw new Error(`web-fetch-http: timeoutMs must be no greater than ${MAX_NODE_TIMER_DELAY_MS}`)
  }
}

/** 重定向跳数上限必须是非负整数（0 表示不跟随任何重定向）。 */
function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`web-fetch-http: ${name} must be a non-negative integer`)
  }
}

/** 向 `ctx.web` 注册本地 HTTP(S) 抓取提供方。 */
export function apply(ctx: Context, config: Config): void {
  // schemastery（Config）已经填好了每一个默认字段。
  const resolved = config as ResolvedConfig
  assertPositiveFinite('maxResponseBytes', resolved.maxResponseBytes)
  assertPositiveFinite('maxBodyChars', resolved.maxBodyChars)
  assertTimeoutMs(resolved.timeoutMs)
  assertNonNegativeInteger('maxRedirects', resolved.maxRedirects)
  const limits: HttpFetchLimits = {
    maxResponseBytes: resolved.maxResponseBytes,
    maxBodyChars: resolved.maxBodyChars,
    timeoutMs: resolved.timeoutMs,
    maxRedirects: resolved.maxRedirects,
    userAgent: resolved.userAgent,
  }
  ctx.web.registerFetchProvider(new HttpFetchProvider(limits))
}
