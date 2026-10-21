/**
 * 本地 HTTP(S) 抓取提供方的 URL 校验与内容类型分类 —— 纯的、无网络的一半。提供方的
 * `fetch()` 将这些与传输层（重定向跟随、字节上限、解码）组合到一起。
 *
 * @module @deepseek-ai/dsh-web-fetch-http/policy
 */

import { WebError } from '@deepseek-ai/dsh-web'

/** 公共抓取提供方强制实施的最大请求 URL 长度。 */
export const WEB_FETCH_MAX_URL_LENGTH = 2048

/** 本提供方解码的正文种类。 */
export type FetchableKind = 'html' | 'text'

/**
 * 解析请求 URL 并强制实施与网络无关传输限制：仅 HTTP(S)，且不得内嵌凭据。
 * 提供方在解析目标之前应用它。
 *
 * @param input - 来自抓取请求的原始 URL 字符串。
 * @returns 解析后的 `URL`。
 */
export function parseFetchUrl(input: string): URL {
  let url: URL
  try {
    url = new URL(input)
  } catch (error: unknown) {
    throw new WebError(`invalid URL: ${input}`, 'WEB_INVALID_URL', { cause: error })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebError(`unsupported URL scheme "${url.protocol}" (only http and https are allowed)`, 'WEB_INVALID_URL')
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new WebError('credentials in URLs are not allowed', 'WEB_BLOCKED_URL')
  }
  return url
}

/**
 * 针对提供方完整的网络前策略校验请求 URL：有界长度加上 {@link parseFetchUrl} 强制实施的
 * 限制。公共地址解析与连接钉死在此检查之后运行。
 *
 * @param input - 来自抓取请求的原始 URL 字符串。
 * @returns 解析后的 `URL`。
 */
export function validateFetchUrl(input: string): URL {
  if (input.length > WEB_FETCH_MAX_URL_LENGTH) {
    throw new WebError(`URL exceeds the maximum length of ${WEB_FETCH_MAX_URL_LENGTH}`, 'WEB_INVALID_URL')
  }
  return parseFetchUrl(input)
}

/**
 * 当两个 URL 的方案、主机名和端口都匹配时，它们同源。跨越源的重定向会被拒绝，以便每个新源
 * 都需要一次全新的工具调用以及公共地址验证。
 *
 * @param a - 两个待比较 URL 之一。
 * @param b - 另一个待比较的 URL。
 * @returns 当 `a` 与 `b` 共享方案、主机名和端口时为 true。
 */
export function isSameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.hostname === b.hostname && a.port === b.port
}

/**
 * 将响应 `Content-Type` 分类为一种可解码的正文种类，或针对不支持（如二进制）的类型返回
 * `undefined`。`text/html` 与 `application/xhtml+xml` 为 `html`；其他 `text/*` 加上少量结构化
 * 文本类型为 `text`。
 *
 * @param contentType - 原始 `Content-Type` 头，或当响应不带时（`null`，不支持）。
 * @returns 可解码的种类，或针对不支持类型的 `undefined`。
 */
export function classifyContentType(contentType: string | null): FetchableKind | undefined {
  const mime = (contentType ?? '').replace(/;.*$/s, '').trim().toLowerCase()
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html'
  if (mime.startsWith('text/')) return 'text'
  if (mime === 'application/json' || mime === 'application/xml' || mime.endsWith('+json') || mime.endsWith('+xml')) return 'text'
  return undefined
}

/**
 * 从响应 `Content-Type` 中提取 `charset` 参数，转为小写，缺失时为 `undefined`。提供方将此标签
 * 喂给 `TextDecoder`，从而一个非 UTF-8 响应以其声明编码解码，而不是被静默乱码化为替换字符。
 *
 * @param contentType - 原始 `Content-Type` 头，或当响应不带时（`null`）。
 * @returns 小写的 charset 标签，或未声明时为 `undefined`。
 */
export function parseCharset(contentType: string | null): string | undefined {
  const match = /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(contentType ?? '')
  return match?.[1]?.trim().toLowerCase()
}

/**
 * 为声明的 charset 构建 `TextDecoder`，当未声明时回退到 UTF-8。当标签存在但 `TextDecoder`
 * 无法识别为 charset 时，抛出 {@link WebError} `WEB_UNSUPPORTED_CONTENT_TYPE` —— 响亮地失败
 * 好过返回乱码。
 *
 * @param charset - 声明的 charset 标签（来自 {@link parseCharset}），或 `undefined` 表示默认 UTF-8。
 * @returns 为声明（或默认）编码构建的解码器。
 */
export function decoderForCharset(charset: string | undefined): TextDecoder {
  if (charset === undefined) return new TextDecoder('utf-8')
  try {
    return new TextDecoder(charset)
  } catch (error: unknown) {
    throw new WebError(`unsupported charset "${charset}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE', { cause: error })
  }
}
