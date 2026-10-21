/**
 * 本仓库所发布到的每个 JavaScript 上下文中都能工作的 UUID 生成。
 * `crypto.randomUUID` 是一个安全上下文中的 Web API——通过局域网地址以
 * 明文 HTTP 提供服务的页面或 worker 没有该方法——而
 * `crypto.getRandomValues` 在所有地方都不受限制（浏览器、worker、
 * Node ≥ 19）。这里的一份实现取代了每个调用方各自的 polyfill；
 * `no-restricted-properties` lint 规则会让调用 `crypto.randomUUID` 的
 * 代码指向本模块。
 * @module @deepseek-ai/dsh-util-crypto
 */

/** RFC 9562 格式的 UUID 字符串，即 `crypto.randomUUID` 所声明的形状。 */
export type Uuid = `${string}-${string}-${string}-${string}-${string}`

/**
 * 以规范 base64 编码字节，避免超出函数参数上限。
 * @param data - 待编码的字节。
 * @returns base64 文本。
 */
export function bytesToBase64(data: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < data.length; offset += chunk) {
    binary += String.fromCharCode(...data.subarray(offset, offset + chunk))
  }
  return btoa(binary)
}

/**
 * 由 `crypto.getRandomValues` 生成的随机 v4 UUID。
 * @returns UUID 字符串。
 */
export function randomUUID(): Uuid {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
  // RFC 9562 §5.4：第 6 字节高半字节为版本 4，第 8 字节为变体位 10。
  const hex = Array.from(bytes, (byte, index) => {
    const pinned = index === 6 ? (byte & 0x0f) | 0x40 : index === 8 ? (byte & 0x3f) | 0x80 : byte
    return pinned.toString(16).padStart(2, '0')
  }).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
