/** 面向模型可见引用信封的、标签安全的 JSON 序列化。 */

/**
 * 序列化 JSON，同时阻止源数据拼出一个类似 XML 的起始标签。
 * @param value - 兼容 JSON 的引用数据。
 * @returns 解析结果不变、且其数据不含字面量 `<` 的 JSON。
 */
export function stringifyTagSafeJson(value: unknown): string {
  const serialized: unknown = JSON.stringify(value)
  if (typeof serialized !== 'string') throw new TypeError('session-reference data is not JSON-serializable')
  return serialized.replaceAll('<', '\\u003c')
}
