/**
 * 接受调用方时区的线边界所共享的时间词汇。
 * 仅做校验与规范化：本库不格式化任何内容，也不拥有任何失败词汇——
 * 每个边界各自声明并抛出自己的拒绝理由。
 * @module @deepseek-ai/dsh-util-time
 */

/** 严格的浏览器时区档案：UTC 或 IANA 的 Area/Location 风格标识符。 */
const IANA_TIME_ZONE = /^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+$/

/**
 * 在线边界校验并规范化一个调用方提供的 IANA 时区。
 *
 * 规范名称是后续读取方所需之物：时区标识会存储在持久记录上，并由另一个
 * 进程再次解析，因此此处接受的别名不会与读取方推导出的时区比较相等。
 * @param value - 调用方报告的时区名称。
 * @returns 规范化的时区；名称不可用时为 `undefined`。
 */
export function canonicalClientTimeZone(value: string): string | undefined {
  if (value.length === 0 || value.trim() !== value
    || (value !== 'UTC' && !IANA_TIME_ZONE.test(value))) return undefined
  try {
    const canonical = new Intl.DateTimeFormat('en-US', { timeZone: value })
      .resolvedOptions().timeZone
    /* v8 ignore next -- Intl 对接受的输入返回 UTC 或规范的 IANA Area/Location。 */
    if (canonical !== 'UTC' && !IANA_TIME_ZONE.test(canonical)) return undefined
    return canonical
  } catch {
    // Intl 拒绝不受支持的时区名称；调用方负责映射该解析拒绝。
    return undefined
  }
}
