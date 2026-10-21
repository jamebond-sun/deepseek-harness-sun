/** 在插件导出与惰性构建器边界处的身份检查。 */

import type { NativeConfigSchema } from './types.ts'

/**
 * 在不调用校验器或序列化钩子的前提下，识别原生的 Schemastery 图协议。
 * @param value - 插件 Config 导出或惰性构建器的结果。
 * @returns 是否可检查原生 schema 字段。
 */
export function isNativeConfigSchema(value: unknown): value is NativeConfigSchema {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false
  const meta: unknown = Reflect.get(value, 'meta')
  return Reflect.get(value, Symbol.for('schemastery')) === true
    && typeof Reflect.get(value, 'type') === 'string'
    && meta !== null && typeof meta === 'object'
}
