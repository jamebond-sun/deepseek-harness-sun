/** 同步 Client Context 解析器返回的通用调用所属值。 */

/** 跨独立打包的 Context 提供方与 Gateway 的共享标识。 */
export const TYPERT_OWNED_VALUE = Symbol.for('dsh.typert.owned-value')

/** 借用的负载，搭配调用所有者的幂等清理。 */
export interface TypertOwnedValue<Value> extends Disposable {
  readonly [TYPERT_OWNED_VALUE]: true
  readonly value: Value
}

/**
 * 在不增加额外资源引用计数的前提下转移清理所有权。
 * @param value - 传入调用的已解析负载。
 * @param release - 不抛出的同步释放函数，至多调用一次。
 * @returns 在调用与响应结算后释放的所属负载。
 */
export function typertOwnedValue<Value>(value: Value, release: () => void): TypertOwnedValue<Value> {
  let active = true
  return {
    [TYPERT_OWNED_VALUE]: true,
    value,
    [Symbol.dispose]() {
      if (!active) return
      active = false
      release()
    },
  }
}

/**
 * 使用共享标记识别调用所属值。
 * @param value - 借用或已解析的解析器结果。
 * @returns 结果是否携带调用清理。
 */
export function isTypertOwnedValue(value: unknown): value is TypertOwnedValue<unknown> {
  return typeof value === 'object' && value !== null
    && TYPERT_OWNED_VALUE in value && value[TYPERT_OWNED_VALUE] === true
}
