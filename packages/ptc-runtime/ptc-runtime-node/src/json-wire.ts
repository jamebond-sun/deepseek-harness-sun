/**
 * 为无依赖的源码 bootstrap 闭包提供的无损 JSON 快照。
 * @module @deepseek-ai/dsh-ptc-runtime-node/json-wire
 */

import type { PtcJsonValue } from '@deepseek-ai/dsh-ptc-runtime'

/* jscpd:ignore-start -- 源码 bootstrap 在不引入工作区运行时依赖的前提下镜像了会话 JSON 辅助函数 */
type IntrinsicCallable = (this: unknown, ...args: unknown[]) => unknown

const intrinsicFunctionToString = Reflect.get(Function.prototype, 'toString') as IntrinsicCallable
const intrinsicReflectApply = Reflect.get(Reflect, 'apply') as (
  target: IntrinsicCallable,
  thisArgument: unknown,
  argumentsList: readonly unknown[],
) => unknown
const IntrinsicError = Error
const IntrinsicSet = Set
const intrinsicArrayIsArray = Array.isArray
const intrinsicArrayPrototype = Array.prototype
const intrinsicNumberIsFinite = Number.isFinite
const intrinsicNumberIsSafeInteger = Number.isSafeInteger
const intrinsicObjectCreate = Object.create
const intrinsicObjectDefineProperty = Object.defineProperty
const intrinsicObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const intrinsicObjectGetPrototypeOf = Object.getPrototypeOf
const intrinsicObjectHasOwn = Object.hasOwn
const intrinsicObjectIs = Object.is
const intrinsicObjectKeys = Object.keys
const intrinsicObjectPrototype = Object.prototype
const intrinsicObjectPropertyIsEnumerable = Reflect.get(intrinsicObjectPrototype, 'propertyIsEnumerable') as IntrinsicCallable
const intrinsicReflectOwnKeys = Reflect.ownKeys
const intrinsicSetAdd = Reflect.get(Set.prototype, 'add') as IntrinsicCallable
const intrinsicSetDelete = Reflect.get(Set.prototype, 'delete') as IntrinsicCallable
const intrinsicSetHas = Reflect.get(Set.prototype, 'has') as IntrinsicCallable

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

/** 判断一个捕获内部函数所用的 Set 是否包含某个值。 */
function setHas<T>(target: Set<T>, value: T): boolean {
  return intrinsicReflectApply(intrinsicSetHas, target, [value]) as boolean
}

/** 向一个捕获内部函数所用的 Set 添加元素。 */
function setAdd<T>(target: Set<T>, value: T): void {
  intrinsicReflectApply(intrinsicSetAdd, target, [value])
}

/** 从一个捕获内部函数所用的 Set 删除元素。 */
function setDelete<T>(target: Set<T>, value: T): void {
  intrinsicReflectApply(intrinsicSetDelete, target, [value])
}

/** 判断某个 realm 自有的内部原型是否由其原生构造器支撑。 */
function hasIntrinsicConstructor(prototype: object, name: 'Array' | 'Object'): boolean {
  const descriptor = intrinsicObjectGetOwnPropertyDescriptor(prototype, 'constructor')
  const constructor: unknown = descriptor?.value
  if (typeof constructor !== 'function') return false
  try {
    return constructor.name === name
      && constructor.prototype === prototype
      && intrinsicReflectApply(intrinsicFunctionToString, constructor, []) === `function ${name}() { [native code] }`
  } catch {
    return false
  }
}

/** 判断候选对象是否为某个外部 realm 的内部 `Object.prototype`。 */
function isForeignIntrinsicObjectPrototype(value: object): boolean {
  return intrinsicObjectGetPrototypeOf(value) === null && hasIntrinsicConstructor(value, 'Object')
}

/** 判断数组是否使用了某个 realm 的内部 `Array.prototype`，而非子类或伪造的原型。 */
function hasPlainArrayPrototype(value: unknown[]): boolean {
  const prototype: unknown = intrinsicObjectGetPrototypeOf(value)
  if (prototype === intrinsicArrayPrototype) return true
  if (!intrinsicArrayIsArray(prototype) || !hasIntrinsicConstructor(prototype, 'Array')) return false
  const objectPrototype: unknown = intrinsicObjectGetPrototypeOf(prototype)
  return typeof objectPrototype === 'object'
    && objectPrototype !== null
    && isForeignIntrinsicObjectPrototype(objectPrototype)
}

/** 判断对象是否为来自任意 JavaScript realm 的普通记录或 null 原型记录。 */
function hasPlainObjectPrototype(value: object): boolean {
  const prototype: unknown = intrinsicObjectGetPrototypeOf(value)
  return prototype === null
    || prototype === intrinsicObjectPrototype
    || typeof prototype === 'object' && isForeignIntrinsicObjectPrototype(prototype)
}

/** 返回对象上所有 JSON 可见的键；若存在 JSON 会丢弃的自有数据则返回 undefined。 */
function enumerableStringKeys(value: object): string[] | undefined {
  const keys = intrinsicReflectOwnKeys(value)
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]
    if (typeof key !== 'string' || !intrinsicReflectApply(intrinsicObjectPropertyIsEnumerable, value, [key])) return undefined
  }
  return keys as string[]
}

type SnapshotDestination =
  | { kind: 'root' }
  | { kind: 'array'; target: PtcJsonValue[]; index: number }
  | { kind: 'object'; target: Record<string, PtcJsonValue>; key: string }

type SnapshotTask =
  | { kind: 'visit'; value: unknown; destination: SnapshotDestination }
  | { kind: 'array-item'; source: unknown[]; index: number; target: PtcJsonValue[] }
  | { kind: 'object-property'; source: Record<string, unknown>; key: string; target: Record<string, PtcJsonValue> }
  | { kind: 'leave'; source: object }

/**
 * 校验并分离一个进程边界上的值，而不在运行时加载另一个工作区包。
 * 它镜像了会话所拥有的权威 JSON 边界，同时保持可被未构建的 bootstrap 安全导入。
 * 其迭代式遍历不会引入 JavaScript 调用栈深度限制。
 *
 * @param value - 候选的完成值。
 * @returns 分离出来的无损 JSON 快照；非法时为 `undefined`。
 */
export function snapshotPtcJsonValue(value: unknown): PtcJsonValue | undefined {
  const active = new IntrinsicSet<object>()
  let root: PtcJsonValue | undefined
  const assign = (destination: SnapshotDestination, item: PtcJsonValue): void => {
    if (destination.kind === 'root') {
      root = item
    } else if (destination.kind === 'array') {
      defineEnumerableDataProperty(destination.target, destination.index, item)
    } else {
      defineEnumerableDataProperty(destination.target, destination.key, item)
    }
  }

  const tasks: SnapshotTask[] = [{ kind: 'visit', value, destination: { kind: 'root' } }]
  for (let task = takeLast(tasks); task !== undefined; task = takeLast(tasks)) {
    if (task.kind === 'leave') {
      setDelete(active, task.source)
      continue
    }
    if (task.kind === 'array-item') {
      if (!intrinsicObjectHasOwn(task.source, task.index)) return undefined
      append(tasks, {
        kind: 'visit',
        value: task.source[task.index],
        destination: { kind: 'array', target: task.target, index: task.index },
      })
      continue
    }
    if (task.kind === 'object-property') {
      append(tasks, {
        kind: 'visit',
        value: task.source[task.key],
        destination: { kind: 'object', target: task.target, key: task.key },
      })
      continue
    }

    const candidate = task.value
    if (candidate === null) {
      assign(task.destination, null)
      continue
    }
    if (typeof candidate === 'boolean' || typeof candidate === 'string') {
      assign(task.destination, candidate)
      continue
    }
    if (typeof candidate === 'number') {
      if (!intrinsicNumberIsFinite(candidate) || intrinsicObjectIs(candidate, -0)) return undefined
      assign(task.destination, candidate)
      continue
    }
    if (typeof candidate !== 'object') return undefined
    if (setHas(active, candidate)) return undefined

    if (intrinsicArrayIsArray(candidate)) {
      if (!hasPlainArrayPrototype(candidate)) return undefined
      const length = candidate.length
      if (intrinsicReflectOwnKeys(candidate).length !== length + 1) return undefined
      const target: PtcJsonValue[] = []
      assign(task.destination, target)
      setAdd(active, candidate)
      append(tasks, { kind: 'leave', source: candidate })
      for (let index = length - 1; index >= 0; index--) {
        append(tasks, { kind: 'array-item', source: candidate, index, target })
      }
      continue
    }

    if (!hasPlainObjectPrototype(candidate)) return undefined
    const keys = enumerableStringKeys(candidate)
    if (keys === undefined) return undefined
    const target: Record<string, PtcJsonValue> = {}
    assign(task.destination, target)
    setAdd(active, candidate)
    append(tasks, { kind: 'leave', source: candidate })
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index]
      /* v8 ignore next -- 循环由已捕获的键数量界定上界。 */
      if (key === undefined) return undefined
      append(tasks, { kind: 'object-property', source: candidate as Record<string, unknown>, key, target })
    }
  }
  return root
}

interface ArrayWireToken {
  kind: 'array'
  length: number
}

interface ObjectWireToken {
  kind: 'object'
  keys: string[]
}

type PtcJsonToken = null | boolean | number | string | ArrayWireToken | ObjectWireToken

/**
 * 单个无损 JSON 值的前序、深度有界的传输形式。容器标记与标量叶子共用
 * 一个扁平 token 数组，因此 JSON 序列化不会沿着该值的应用层嵌套递归下去。
 */
export type PtcJsonWire = PtcJsonToken[]

/**
 * 把一个已校验的 JSON 值压平，以便在进程控制通道上传输。
 * @param value - 要传输的无损 JSON 值。
 * @returns 一个前序 token 流，其自身的嵌套深度是有界的。
 */
export function encodePtcJsonWire(value: PtcJsonValue): PtcJsonWire {
  const wire: PtcJsonWire = []
  const pending: PtcJsonValue[] = [value]
  for (let current = takeLast(pending); current !== undefined; current = takeLast(pending)) {
    if (current === null || typeof current === 'boolean' || typeof current === 'number' || typeof current === 'string') {
      append(wire, current)
      continue
    }
    if (intrinsicArrayIsArray(current)) {
      append(wire, { kind: 'array', length: current.length })
      for (let index = current.length - 1; index >= 0; index--) {
        const item = current[index]
        if (item === undefined) throw new IntrinsicError('cannot encode a sparse JSON array')
        append(pending, item)
      }
      continue
    }
    const keys = intrinsicObjectKeys(current)
    append(wire, { kind: 'object', keys })
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index]
      /* v8 ignore next -- 循环由已捕获的键数量界定上界。 */
      if (key === undefined) throw new IntrinsicError('cannot encode a missing JSON object key')
      const item = current[key]
      if (item === undefined) throw new IntrinsicError('cannot encode an undefined JSON object property')
      append(pending, item)
    }
  }
  return wire
}

type DecodeFrame =
  | { kind: 'array'; target: PtcJsonValue[]; length: number; index: number }
  | { kind: 'object'; target: Record<string, PtcJsonValue>; keys: string[]; index: number }

/** 判断数组是否恰好只包含其稠密索引槽位与 `length`。 */
function isDenseArray(value: unknown[]): boolean {
  if (!hasPlainArrayPrototype(value) || intrinsicReflectOwnKeys(value).length !== value.length + 1) return false
  for (let index = 0; index < value.length; index++) {
    if (!intrinsicObjectHasOwn(value, index)) return false
  }
  return true
}

/** 判断一个精确的键名列表是否包含某个键，不查阅其原型。 */
function keysContain(keys: string[], expected: string): boolean {
  for (let index = 0; index < keys.length; index++) {
    if (keys[index] === expected) return true
  }
  return false
}

/** 返回一个精确的容器标记；任何多余或缺失字段都会被拒绝。 */
function containerToken(value: object): ArrayWireToken | ObjectWireToken | undefined {
  if (intrinsicArrayIsArray(value) || !hasPlainObjectPrototype(value)) return undefined
  const keys = enumerableStringKeys(value)
  if (keys === undefined) return undefined
  const token = value as Record<string, unknown>
  if (token.kind === 'array') {
    if (keys.length !== 2 || !keysContain(keys, 'kind') || !keysContain(keys, 'length')) return undefined
    const length = token.length
    return typeof length === 'number' && intrinsicNumberIsSafeInteger(length) && length >= 0
      ? { kind: 'array', length }
      : undefined
  }
  if (token.kind === 'object') {
    if (keys.length !== 2 || !keysContain(keys, 'kind') || !keysContain(keys, 'keys')) return undefined
    const objectKeys = token.keys
    if (!intrinsicArrayIsArray(objectKeys) || !isDenseArray(objectKeys)) return undefined
    const unique = new IntrinsicSet<string>()
    const normalizedKeys: string[] = []
    const objectKeyValues = objectKeys as unknown[]
    for (let index = 0; index < objectKeyValues.length; index++) {
      const key = objectKeyValues[index]
      if (typeof key !== 'string' || setHas(unique, key)) return undefined
      setAdd(unique, key)
      append(normalizedKeys, key)
    }
    return { kind: 'object', keys: normalizedKeys }
  }
  return undefined
}

/**
 * 从扁平的进程 wire 格式重建一个无损 JSON 值。
 * 畸形或不完整的流量返回 `undefined`；遍历是迭代式的，
 * 因此与被传输值的应用层深度无关。
 * @param input - 不可信的消息端口载荷。
 * @returns 分离出来的 JSON 值；wire 非法时为 `undefined`。
 */
export function decodePtcJsonWire(input: unknown): PtcJsonValue | undefined {
  try {
    if (!intrinsicArrayIsArray(input) || !isDenseArray(input) || input.length === 0) return undefined
    const wire = input as unknown[]
    const frames: DecodeFrame[] = []
    let root: PtcJsonValue | undefined
    let rootAssigned = false

    const attach = (value: PtcJsonValue): boolean => {
      const parent = frames[frames.length - 1]
      if (!parent) {
        if (rootAssigned) return false
        root = value
        rootAssigned = true
        return true
      }
      /* v8 ignore next -- 已完成的帧会在下一个 token 挂载之前弹出。 */
      if (parent.index >= (parent.kind === 'array' ? parent.length : parent.keys.length)) return false
      if (parent.kind === 'array') {
        append(parent.target, value)
      } else {
        const key = parent.keys[parent.index]
        /* v8 ignore next -- 对象帧由已校验的键及其精确长度构建。 */
        if (key === undefined) return false
        defineEnumerableDataProperty(parent.target, key, value)
      }
      parent.index += 1
      return true
    }

    for (let tokenIndex = 0; tokenIndex < wire.length; tokenIndex++) {
      const token = wire[tokenIndex]
      let value: PtcJsonValue
      let frame: DecodeFrame | undefined
      if (token === null || typeof token === 'boolean' || typeof token === 'string') {
        value = token
      } else if (typeof token === 'number') {
        if (!intrinsicNumberIsFinite(token) || intrinsicObjectIs(token, -0)) return undefined
        value = token
      } else {
        if (typeof token !== 'object') return undefined
        const marker = containerToken(token)
        if (!marker) return undefined
        const remainingTokens = wire.length - tokenIndex - 1
        if (marker.kind === 'array') {
          if (marker.length > remainingTokens) return undefined
          const target: PtcJsonValue[] = []
          value = target
          if (marker.length > 0) frame = { kind: 'array', target, length: marker.length, index: 0 }
        } else {
          if (marker.keys.length > remainingTokens) return undefined
          const target: Record<string, PtcJsonValue> = {}
          value = target
          if (marker.keys.length > 0) frame = { kind: 'object', target, keys: marker.keys, index: 0 }
        }
      }
      if (!attach(value)) return undefined
      if (frame) append(frames, frame)
      while (frames.length > 0) {
        const current = frames[frames.length - 1]
        /* v8 ignore next -- 循环条件保证了一定存在末帧。 */
        if (current === undefined) break
        if (current.index < (current.kind === 'array' ? current.length : current.keys.length)) break
        takeLast(frames)
      }
    }
    return frames.length === 0 ? root : undefined
  } catch {
    return undefined
  }
}
/* jscpd:ignore-end */
