/**
 * 将脚本 VM 的值物化为纯 JSON，并渲染被抛出的值。
 * getter 和 proxy 陷阱可能在受限的 Node 进程内执行；进程隔离与取消
 * 属于 PTC，而非 VM。
 * @module @deepseek-ai/dsh-workflow-ptc/realm
 */

/** 由 {@link materializeFromRealm} 抛出；调用方将其包装为正确的 `WorkflowError` 码。 */
export class MaterializeError extends Error {
  constructor(public readonly path: string, public readonly reason: string) {
    super(`${path}: ${reason}`)
    this.name = 'MaterializeError'
  }
}

/**
 * 将抛出的值渲染为失败文本，且永不抛出：优先使用 `stack`（宿主或 realm ——
 * realm 错误的 `stack` 是一个纯字符串读取），退回到 `message`，再退回到
 * `String()`。读取这些属性 MAY 运行脚本代码；如果该代码自身抛出，则改为
 * 返回一个固定标签。
 * @param error - 在宿主或 guest realm 中抛出的任意值。
 * @returns 失败报告的可读文本；优先使用栈。
 */
export function renderThrown(error: unknown): string {
  try {
    const stack = (error as { stack?: unknown } | null | undefined)?.stack
    if (typeof stack === 'string' && stack.length > 0) return stack
    const message = (error as { message?: unknown } | null | undefined)?.message
    if (typeof message === 'string' && message.length > 0) return message
    return String(error)
  } catch {
    // 被抛出值上的抛错 accessor/toString —— 渲染必须是全函数式的
    // （drive() 的永不 reject 契约），因此回退到一个固定标签。
    return '[unrenderable thrown value]'
  }
}

/**
 * 一个对象的原型链是否表示一个纯数据对象：`null`，或者其自身原型为
 * `null`（即 realm 的 `Object.prototype` —— 我们无法跨 realm 按同一性
 * 比较它）的对象。`Date`/`Map`/类实例有更长的链，会被拒绝。
 */
function hasPlainPrototype(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value)
  if (proto === null) return true
  return Object.getPrototypeOf(proto) === null
}

/**
 * 将 `value`（通常来自 vm realm）复制为纯宿主 JSON 数据。根级 `undefined`
 * 原样返回；嵌套的 `undefined` 以及 JSON 无法无损表示的值会以出错路径失败。
 * 属性访问器正常运行，读取抛错会被包装为其渲染后的失败。
 *
 * @param value - 要物化的 realm 值。
 * @param root - 根值的路径标签（用于错误消息）。
 * @returns 宿主 realm 的副本（仅含纯对象/数组/标量）。
 * @throws {@link MaterializeError} 针对不支持的值、环、稀疏数组、外来
 *   原型，或抛错的属性读取。
 */
export function materializeFromRealm(value: unknown, root = 'value'): unknown {
  if (value === undefined) return undefined
  try {
    return materialize(value, root, new Set())
  } catch (error: unknown) {
    if (error instanceof MaterializeError) throw error
    // 一次属性读取运行了抛错的脚本代码；将其全函数化，以便调用方能够
    // 保留狭窄的 MaterializeError 契约。
    throw new MaterializeError(root, `reading the value threw: ${renderThrown(error)}`)
  }
}

function materialize(value: unknown, path: string, seen: Set<object>): unknown {
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return value
    case 'number': {
      if (!Number.isFinite(value)) throw new MaterializeError(path, 'non-finite numbers are not JSON data')
      return value
    }
    case 'bigint':
      throw new MaterializeError(path, 'bigints are not JSON data')
    case 'function':
      throw new MaterializeError(path, 'functions are not plain JSON data')
    case 'symbol':
      throw new MaterializeError(path, 'symbols are not plain JSON data')
    case 'undefined':
      throw new MaterializeError(path, 'undefined is not JSON data')
    case 'object':
      break
  }
  if (value === null) return null
  const objectValue: object = value
  if (seen.has(objectValue)) throw new MaterializeError(path, 'circular references are not JSON data')
  seen.add(objectValue)
  try {
    if (Array.isArray(objectValue)) return materializeArray(objectValue, path, seen)
    return materializeObject(objectValue, path, seen)
  } finally {
    seen.delete(objectValue)
  }
}

function materializeArray(value: unknown[], path: string, seen: Set<object>): unknown[] {
  const out: unknown[] = []
  for (let index = 0; index < value.length; index++) {
    if (!(index in value)) throw new MaterializeError(`${path}[${index}]`, 'sparse arrays are not JSON data')
    out.push(materialize(value[index], `${path}[${index}]`, seen))
  }
  // 超出索引的自身可枚举属性（如 `arr.total = 3`）会被 JSON 静默丢弃 ——
  // 改为拒绝它们。
  for (const key of Object.keys(value)) {
    const index = Number(key)
    if (!Number.isInteger(index) || index < 0 || index >= value.length) {
      throw new MaterializeError(`${path}.${key}`, 'arrays with non-index properties are not JSON data')
    }
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new MaterializeError(path, 'symbol-keyed properties are not plain JSON data')
  }
  return out
}

function materializeObject(value: object, path: string, seen: Set<object>): Record<string, unknown> {
  if (!hasPlainPrototype(value)) {
    throw new MaterializeError(path, 'only plain objects and arrays are JSON data (exotic prototype)')
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new MaterializeError(path, 'symbol-keyed properties are not plain JSON data')
  }
  const out: Record<string, unknown> = {}
  // Object.keys = 自身可枚举字符串键，与 JSON.stringify 的属性选择完全一致
  // （不可枚举属性永远不会进入 JSON 输出）。
  for (const key of Object.keys(value)) {
    // 使用 defineProperty，而非赋值：一个 "__proto__" 键必须成为副本的
    // 一个自身数据属性，而非原型变异。
    Object.defineProperty(out, key, {
      value: materialize((value as Record<string, unknown>)[key], `${path}.${key}`, seen),
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return out
}
