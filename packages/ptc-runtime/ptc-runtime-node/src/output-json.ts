/** 为外层输出账本服务的 JSON 字符串前缀计量。 @module @deepseek-ai/dsh-ptc-runtime-node/output-json */

import type { PtcJsonValue } from '@deepseek-ai/dsh-ptc-runtime'

type IntrinsicCallable = (this: unknown, ...args: unknown[]) => unknown

const intrinsicReflectApply = Reflect.apply as (
  target: IntrinsicCallable,
  thisArgument: unknown,
  argumentsList: readonly unknown[],
) => unknown
const intrinsicArrayIsArray = Array.isArray
const IntrinsicBuffer = Buffer
const intrinsicBufferByteLength = Reflect.get(Buffer, 'byteLength') as IntrinsicCallable
const intrinsicObjectCreate = Object.create
const intrinsicObjectDefineProperty = Object.defineProperty
const intrinsicObjectKeys = Object.keys
const intrinsicString = String
const intrinsicStringCharCodeAt = Reflect.get(String.prototype, 'charCodeAt') as IntrinsicCallable
const intrinsicStringCodePointAt = Reflect.get(String.prototype, 'codePointAt') as IntrinsicCallable
const intrinsicStringSlice = Reflect.get(String.prototype, 'slice') as IntrinsicCallable

/** 构造一个不会继承到模型自定义访问器字段的数据描述符。 */
function dataDescriptor(value: unknown): PropertyDescriptor {
  const descriptor = intrinsicObjectCreate(null) as PropertyDescriptor
  descriptor.value = value
  return descriptor
}

/** 定义一个普通的可枚举数据槽位，不使用带原型的描述符。 */
function defineEnumerableDataProperty(target: object, key: PropertyKey, value: unknown): void {
  const descriptor = dataDescriptor(value)
  descriptor.enumerable = true
  descriptor.configurable = true
  descriptor.writable = true
  intrinsicObjectDefineProperty(target, key, descriptor)
}

/** 经模块捕获的 Node 内部函数计算 UTF-8 字节长度。 */
function byteLength(text: string): number {
  return intrinsicReflectApply(intrinsicBufferByteLength, IntrinsicBuffer, [text, 'utf8']) as number
}

/** 追加元素，不查阅可能被模型改过的 `Array.prototype`。 */
function append<T>(target: T[], value: T): void {
  defineEnumerableDataProperty(target, target.length, value)
}

/** 弹出末尾元素，不查阅可能被模型改过的 `Array.prototype`。 */
function takeLast<T>(target: T[]): T | undefined {
  if (target.length === 0) return undefined
  const index = target.length - 1
  const value = target[index]
  intrinsicObjectDefineProperty(target, 'length', dataDescriptor(index))
  return value
}

/** 从字符串中取出一个按码点对齐的字符。 */
function characterAt(text: string, index: number): string {
  const codePoint = intrinsicReflectApply(intrinsicStringCodePointAt, text, [index]) as number
  const width = codePoint > 0xffff ? 2 : 1
  return intrinsicReflectApply(intrinsicStringSlice, text, [index, index + width]) as string
}

/** 一个完整 Unicode 码点在 JSON 引号内所贡献的序列化字节数。 */
function serializedCharacterBytes(character: string): number {
  if (character.length === 2) return 4
  if (character === '"' || character === '\\') return 2
  const code = intrinsicReflectApply(intrinsicStringCharCodeAt, character, [0]) as number
  if (code >= 0xd800 && code <= 0xdfff) return 6
  if (code < 0x20) return code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 2 : 6
  return byteLength(character)
}

/**
 * 度量一个 JSON 字符串，而不把它的完整转义形式具现出来。
 * @param text - 候选字符串。
 * @param maxBytes - 调用方可接纳的最大序列化尺寸。
 * @returns 精确的序列化字节数；一旦越过上限立即返回 `undefined`。
 */
export function jsonStringBytesUpTo(text: string, maxBytes: number): number | undefined {
  if (maxBytes < 2) return undefined
  let bytes = 2
  for (let index = 0; index < text.length;) {
    const character = characterAt(text, index)
    bytes += serializedCharacterBytes(character)
    if (bytes > maxBytes) return undefined
    index += character.length
  }
  return bytes
}

/**
 * 度量一个无损 JSON 值，而不为它的序列化形式分配内存。
 * @param value - 已校验过的无损 JSON。
 * @param maxBytes - 调用方可接纳的最大序列化尺寸。
 * @returns 精确的序列化字节数；一旦越过上限立即返回 `undefined`。
 */
export function jsonValueBytesUpTo(value: PtcJsonValue, maxBytes: number): number | undefined {
  type Task =
    | { kind: 'value'; value: PtcJsonValue }
    | { kind: 'array'; value: PtcJsonValue[]; index: number }
    | { kind: 'object'; value: Record<string, PtcJsonValue>; keys: string[]; index: number }

  let bytes = 0
  const add = (cost: number): boolean => {
    bytes += cost
    return bytes <= maxBytes
  }
  const tasks: Task[] = [{ kind: 'value', value }]
  for (let task = takeLast(tasks); task !== undefined; task = takeLast(tasks)) {
    if (task.kind === 'value') {
      const current = task.value
      if (current === null) {
        if (!add(4)) return undefined
      } else if (typeof current === 'string') {
        const stringBytes = jsonStringBytesUpTo(current, maxBytes - bytes)
        if (stringBytes === undefined) return undefined
        bytes += stringBytes
      } else if (typeof current === 'number') {
        if (!add(byteLength(intrinsicString(current)))) return undefined
      } else if (typeof current === 'boolean') {
        if (!add(current ? 4 : 5)) return undefined
      } else if (intrinsicArrayIsArray(current)) {
        if (!add(2)) return undefined
        if (current.length > 0) append(tasks, { kind: 'array', value: current, index: 0 })
      } else {
        if (!add(2)) return undefined
        const keys = intrinsicObjectKeys(current)
        if (keys.length > 0) append(tasks, { kind: 'object', value: current, keys, index: 0 })
      }
      continue
    }

    if (task.index > 0 && !add(1)) return undefined
    if (task.kind === 'array') {
      const item = task.value[task.index]
      if (item === undefined) return undefined
      if (task.index + 1 < task.value.length) append(tasks, { ...task, index: task.index + 1 })
      append(tasks, { kind: 'value', value: item })
      continue
    }

    const key = task.keys[task.index]
    /* v8 ignore next -- 对象帧只在存在对应 Object.keys 条目时才被创建并推进。 */
    if (key === undefined) return undefined
    const keyBytes = jsonStringBytesUpTo(key, maxBytes - bytes)
    if (keyBytes === undefined) return undefined
    if (!add(keyBytes + 1)) return undefined
    const item = task.value[key]
    if (item === undefined) return undefined
    if (task.index + 1 < task.keys.length) append(tasks, { ...task, index: task.index + 1 })
    append(tasks, { kind: 'value', value: item })
  }
  return bytes
}

/**
 * 返回最长的、按码点对齐的前缀，使其 JSON 字符串编码（含两侧引号）
 * 能放进 `maxBytes`。
 *
 * @param text - 候选字符串。
 * @param maxBytes - 可用的 JSON 字符串序列化字节数。
 * @returns 恰好能放下的前缀；当连有用的内容都放不下时返回空字符串。
 */
export function truncateJsonStringBytes(text: string, maxBytes: number): string {
  if (maxBytes < 2) return ''
  let bytes = 2
  let end = 0
  for (let index = 0; index < text.length;) {
    const character = characterAt(text, index)
    const cost = serializedCharacterBytes(character)
    if (bytes + cost > maxBytes) break
    bytes += cost
    end += character.length
    index += character.length
  }
  return end === text.length ? text : intrinsicReflectApply(intrinsicStringSlice, text, [0, end]) as string
}
