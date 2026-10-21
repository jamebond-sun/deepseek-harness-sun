/** 经过验证的 Platform HTTP 消息，以及受限的浏览器目的地。 */
import { z } from 'zod'
import type { AccountBonusOrderId, SignInErrorCode } from '@deepseek-ai/dsh-deepseek-account/types'

/** 协议错误暴露一个稳定的码，绝不会暴露响应体或授权 URL。 */
export class PlatformAuthError extends Error {
  /** @param code - 安全的错误分类。 */
  constructor(readonly code: SignInErrorCode) { super(`account: ${code}`) }
}

/** 一个已认证的 Platform 请求被以 HTTP 401 或码 40003 拒绝。 */
export class AccountUnauthorizedError extends PlatformAuthError {
  constructor() { super('expired') }
}

/**
 * 接受 HTTPS 的 Platform 端点，或显式配置的环回开发 HTTP。
 * @param value - 已配置的来源。
 * @param allowLoopbackHttp - 仅限开发的、可选项。
 * @returns 归一化后的来源。
 */
export function platformOrigin(value: string, allowLoopbackHttp: boolean): string {
  const url = new URL(value)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || !(url.protocol === 'https:' || (allowLoopbackHttp && loopback && url.protocol === 'http:'))) {
    throw new Error('account: platformOrigin must be an HTTPS origin or explicitly enabled loopback HTTP origin')
  }
  return url.origin
}

/**
 * 验证平台拥有的浏览器目的地，而不转发任意 URL。
 * @param value - 返回的浏览器 URL。
 * @param origin - 已配置的 Platform 来源。
 * @param path - 固定的授权或完成路径。
 * @param rewriteOrigin - 将已验证的浏览器页面映射到所配置的开发来源。
 * @returns 位于已配置来源之上的、归一化后的 URL。
 */
export function browserUrl(value: string, origin: string, path: string, rewriteOrigin = false): string {
  let url: URL
  try { url = new URL(value) } catch {
    console.error('[deepseek-account] browser URL rejected', { path, reason: 'invalid-url' })
    throw new PlatformAuthError('protocol')
  }
  const allowedOrigin = url.origin === origin || (rewriteOrigin && url.protocol === 'https:')
  if (!allowedOrigin || url.pathname !== path || url.username || url.password || url.hash) {
    console.error('[deepseek-account] browser URL rejected', {
      path, originMismatch: !allowedOrigin, pathMismatch: url.pathname !== path,
      hasCredentials: Boolean(url.username || url.password), hasFragment: Boolean(url.hash),
    })
    throw new PlatformAuthError('protocol')
  }
  return rewriteOrigin ? `${origin}${url.pathname}${url.search}` : url.href
}

/**
 * 验证仅宿主的部署请求头，而不在诊断中暴露其值。
 * @param values - 针对 Platform 来源所配置的请求头。
 * @returns 归一化后的请求头；授权、路由与框架仍由提供方所有。
 */
export function platformHeaders(values: Record<string, string>): Record<string, string> {
  const headers = new Headers()
  const names = new Set<string>()
  for (const [name, value] of Object.entries(values)) {
    const key = name.toLowerCase()
    if (['authorization', 'x-dsh-auth-token', 'host', 'content-length', 'transfer-encoding', 'connection', 'content-type'].includes(key)
      || names.has(key)) throw new Error('account: requestHeaders contains a reserved or duplicate header')
    names.add(key)
    try { headers.set(name, value) }
    catch { throw new Error('account: requestHeaders contains an invalid header') }
  }
  return Object.fromEntries(headers)
}

const envelope = z.object({ code: z.literal(0), data: z.object({ biz_code: z.number().int(), biz_data: z.unknown() }) })
/** 成功的初始化响应。 */
export const initialization = z.object({
  authorize_url: z.url(), authorize_id: z.string().min(1), expires_in: z.number().positive(),
})
/** 成功的代码交换响应。 */
export const exchange = z.object({ token: z.string().regex(/^[\x21-\x7e]+$/), authorized_url: z.url(), user: z.unknown().optional() })

/**
 * 读取一个有限的 Platform 响应；非取消的失败会向 stderr 发出不含秘密的诊断信息。
 * @param origin - 已验证的 Platform 来源。
 * @param method - Platform 端点后缀。
 * @param body - 协议请求，绝不记录日志。
 * @param signal - 尝试的取消与超时。
 * @param headers - 针对此来源的、已验证的部署请求头。
 * @returns 成功的业务载荷，由其调用方校验。
 */
export async function requestPlatform(origin: string, method: string, body: unknown,
  signal: AbortSignal, headers: Record<string, string>): Promise<unknown> {
  return platformRequest(`${origin}/auth-api/v0/dsh/${method}`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }, signal)
}

/**
 * 使用保留在宿主请求头中的授权，来获取一个固定的 Platform 账户端点。
 * @param origin - 已配置且与授权相匹配的来源。
 * @param path - 账户端点。
 * @param token - 账户授权。
 * @param signal - 凭证生命周期与请求超时。
 * @param headers - 针对此来源的、已验证的部署请求头。
 * @returns 成功的业务载荷。
 */
export function requestAccount(origin: string, path: '/auth-api/v0/users/current' | '/api/v0/users/get_user_summary',
  token: string,
  signal: AbortSignal, headers: Record<string, string>): Promise<unknown> {
  return platformRequest(`${origin}${path}`, { method: 'GET', headers: accountHeaders(headers, token) }, signal)
}

/**
 * 读取 Platform 尚未记录为已展示的、已授予的赠金。
 * @param origin - 与授权签发者相匹配的、已配置的来源。
 * @param token - 已存储的账户授权。
 * @param signal - 凭证生命周期与请求超时。
 * @param headers - 针对此来源的、部署与客户端身份请求头。
 * @returns 持有尚未通知赠金列表的成功业务载荷。
 */
export function requestUnnotifiedBonuses(origin: string, token: string,
  signal: AbortSignal, headers: Record<string, string>): Promise<unknown> {
  return platformRequest(`${origin}/api/v0/users/get_unnotified_bonuses`,
    { method: 'GET', headers: accountHeaders(headers, token) }, signal)
}

/**
 * 向 Platform 确认一条确实已展示的赠金。
 * @param origin - 与授权签发者相匹配的、已配置的来源。
 * @param token - 已存储的账户授权。
 * @param orderId - 用户所看到的、已授予赠金的订单。
 * @param signal - 凭证生命周期与请求超时。
 * @param headers - 针对此来源的、部署与客户端身份请求头。
 * @returns 成功的业务载荷，其中不携带任何数据。
 */
export function requestBonusNotified(origin: string, token: string, orderId: AccountBonusOrderId,
  signal: AbortSignal, headers: Record<string, string>): Promise<unknown> {
  return platformRequest(`${origin}/api/v0/users/ack_bonus_notified`, {
    method: 'POST', headers: { ...accountHeaders(headers, token), 'content-type': 'application/json' },
    body: JSON.stringify({ order_id: orderId }),
  }, signal)
}

// 该授权由提供方所有；部署的 requestHeaders 无法覆盖它或客户端身份。
function accountHeaders(headers: Record<string, string>, token: string): Record<string, string> {
  return { ...headers, 'x-dsh-auth-token': token }
}

/**
 * 使用其已有的登出端点来结束 Platform 会话。
 * @param origin - 与授权签发者相匹配的、已配置的来源。
 * @param token - 已存储的账户令牌。
 * @param signal - 登出请求的截止时间。
 * @param headers - 针对此来源的、已验证的部署请求头。
 * @returns 在 Platform 确认登出之后。
 */
export async function logoutAccount(origin: string, token: string,
  signal: AbortSignal, headers: Record<string, string>): Promise<void> {
  await platformRequest(`${origin}/auth-api/v0/users/logout`, {
    method: 'POST', headers: { ...headers, 'x-dsh-auth-token': token },
  }, signal)
}

/** 调用方的取消保持静默；标准的 TimeoutError 中止仍属失败。 */
function callerCancelled(signal: AbortSignal): boolean {
  const reason: unknown = signal.reason
  return signal.aborted && !(reason instanceof Error && reason.name === 'TimeoutError')
}

async function platformRequest(url: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
  const path = new URL(url).pathname
  let response: Response
  try {
    response = await fetch(url, { ...init, redirect: 'error', signal })
  } catch {
    if (!callerCancelled(signal)) console.error('[deepseek-account] request failed', { path, errorCode: 'no-response', aborted: signal.aborted })
    throw new PlatformAuthError('no-response')
  }
  if (response.status === 401 && new Headers(init.headers).has('x-dsh-auth-token')) {
    if (!callerCancelled(signal)) console.error('[deepseek-account] request failed', { path, status: response.status, errorCode: 'expired' })
    await response.body?.cancel()
    throw new AccountUnauthorizedError()
  }
  if (!response.ok || response.body === null) {
    if (!callerCancelled(signal)) console.error('[deepseek-account] request failed', { path, status: response.status, errorCode: 'network' })
    await response.body?.cancel()
    throw new PlatformAuthError('network')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let stage = 'read-body'
  let codes: { code: number; data?: { biz_code: number } | undefined } | undefined
  let validationError: z.ZodError | undefined
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > 65_536) {
        stage = 'body-limit'
        throw new PlatformAuthError('protocol')
      }
      chunks.push(next.value)
    }
    stage = 'parse-json'
    const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const responseCodes = z.object({ code: z.number().int(), data: z.object({ biz_code: z.number().int() }).optional() }).safeParse(payload)
    if (responseCodes.success) codes = responseCodes.data
    const authorization = z.object({ code: z.literal(40003) }).safeParse(payload)
    if (authorization.success && new Headers(init.headers).has('x-dsh-auth-token')) {
      throw new AccountUnauthorizedError()
    }
    stage = 'envelope'
    const parsed = envelope.safeParse(payload)
    if (!parsed.success) {
      validationError = parsed.error
      throw new PlatformAuthError('protocol')
    }
    stage = 'business-code'
    if (parsed.data.data.biz_code !== 0) {
      // TODO(product-error-ui): Apply product-defined copy and UI behavior for the supplied biz_code values.
      // Business failures use the existing generic failure UI until then; backend messages stay Host-only.
      throw new PlatformAuthError('protocol')
    }
    return parsed.data.data.biz_data
  } catch (error) {
    if (!callerCancelled(signal)) console.error('[deepseek-account] response rejected', {
      path, status: response.status, stage, code: codes?.code, bizCode: codes?.data?.biz_code,
      issues: validationError?.issues.map(issue => ({ path: issue.path, code: issue.code })),
      errorCode: error instanceof PlatformAuthError ? error.code : 'protocol',
    })
    if (error instanceof PlatformAuthError) throw error
    throw new PlatformAuthError('protocol')
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/**
 * 接受一个浏览器可访问的环回 HTTP 来源，用于本地或经 SSH 转发的登录。
 * @param value - 由已认证的发起客户端所提供的、带显式端口的环回 HTTP 来源。
 * @returns 归一化后的来源；远端域名与基于路径的代理不受支持。
 */
export function loginOrigin(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new PlatformAuthError('protocol') }
  const explicitPort = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):([0-9]+)\/?$/i.exec(value)?.[1]
  if (explicitPort === undefined || Number(explicitPort) === 0
    || url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new PlatformAuthError('protocol')
  }
  return `${url.protocol}//${url.hostname}:${Number(explicitPort)}`
}
