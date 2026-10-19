/** 由 `setIndexes` 与对配置来源的逐项检查共享的索引源 URL 校验。 */
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

/**
 * 校验并规范化一个索引源 URL。
 * @param text - 按配置或输入给出的 URL。
 * @returns 该 URL 的序列化形式。
 * @throws {RemoteError} 对于非 http(s) URL、或带有凭据或片段的 URL，抛出
 *   `plugin-market/invalid-index-url`。
 */
export function normalizeIndexUrl(text: string): string {
  let url: URL
  try {
    url = new URL(text.trim())
  } catch {
    // 无法解析的文本：报告规则，而非解析器的报错信息。
    throw new RemoteError('plugin-market/invalid-index-url', `Not an absolute URL: ${text}`, { url: text, reason: 'not-absolute' })
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new RemoteError('plugin-market/invalid-index-url', `Index URLs use http or https: ${text}`, { url: text, reason: 'scheme' })
  }
  if (url.username !== '' || url.password !== '' || url.href.includes('#')) {
    throw new RemoteError('plugin-market/invalid-index-url', `Index URLs carry no credentials or fragment: ${text}`, { url: text, reason: 'credentials-or-fragment' })
  }
  return url.href
}
