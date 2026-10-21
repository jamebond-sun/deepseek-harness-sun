/**
 * 所有 Remote 载体共享的无损 JSON 校验：Client 句柄在排队上行项之前、
 * Gateway 在其传输线与无编解码的上行边界，以及进程内 mock。
 */

/**
 * 检验一个值能否在无强制转换或省略的情况下穿越 JSON 传输。
 * @param value - 候选边界值。
 * @returns 该值是否无损兼容 JSON。
 */
export function isRemoteJsonValue(value: unknown): boolean {
  return visitJsonValue(value, new Set<object>())
}

/**
 * 检验一个值能否作为一个上行项传输：无损 JSON 值，或顶层的 `undefined`
 * （传输线以不含 `value` 的 `item` 帧携带它）。嵌套的 `undefined`、`NaN`
 * 与无穷大仍被拒绝。
 * @param value - 候选上行项。
 * @returns 该上行项是否能不变地穿越每个载体。
 */
export function isRemoteUplinkItem(value: unknown): boolean {
  return value === undefined || isRemoteJsonValue(value)
}

function visitJsonValue(value: unknown, ancestors: Set<object>): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0)
  if (typeof value !== 'object') return false
  if (ancestors.has(value)) return false
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype
        || Reflect.ownKeys(value).length !== value.length + 1) return false
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index) || !visitJsonValue(value[index], ancestors)) return false
      }
      return true
    }
    const prototype: unknown = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return false
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return false
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor?.enumerable !== true || !visitJsonValue(Reflect.get(value, key), ancestors)) return false
    }
    return true
  } finally {
    ancestors.delete(value)
  }
}
