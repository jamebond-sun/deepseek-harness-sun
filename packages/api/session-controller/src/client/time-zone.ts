/** 为一次提示词 RPC 采样的浏览器持有时区。 */

/**
 * 为一次出站操作解析当前浏览器 IANA 时区。
 * @returns 浏览器提供的规范时区。
 * @throws 当运行时无法提供非空时区时。
 */
export function resolvedClientTimeZone(): string {
  const timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone
  if (typeof timeZone !== 'string' || timeZone.length === 0) {
    throw new Error('browser time zone is unavailable')
  }
  return timeZone
}
