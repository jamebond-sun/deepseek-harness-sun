/**
 * 用于非 owner 访问决策的资源解析：一次调用或一个转发事件
 * 所触及的资源，在任何查找或上下文解析它们之前，
 * 从 Typert 校验过的参数中读取。
 * @module @deepseek-ai/dsh-api-gateway/src/access
 */

import type {
  InvocationDescriptor,
  RemoteAccessResource,
  TypertRegistryContract,
  TypertResourceReader,
} from '@deepseek-ai/dsh-typert-protocol'

const GLOBAL: readonly RemoteAccessResource[] = Object.freeze([Object.freeze({ kind: 'global' })])

/** 一个源为某个种类产出的资源 id，值格式错误时为 `invalid`。 */
type ResourceIds = readonly unknown[] | 'invalid'

/**
 * 解析一次调用所触及的资源。对每种资源种类：
 * 方法的 `resources` 读取器优先；
 * 否则，其提供方声明了该种类的每个查找参数贡献其
 * wire 资源 id，Host 适配器声明了该种类的 Context 方法的上下文
 * 身份同样如此；否则，从顶层参数读取该种类注册在
 * `typert.resources` 中的默认字段，
 * 读取失败时再从首个对象参数读取。
 * @param typert - 持有默认字段、查找提供方与 Host 上下文适配器的注册表。
 * @param readers - 方法的 `resources` 读取器，方法未声明时为 `undefined`。
 * @param descriptor - 方法的接收者、参数顺序、查找与取消槽位。
 * @param args - 与描述符字段集匹配的具名参数：JSON 参数保持其
 *   Typert 编解码器校验后的形态，
 *   查找与上下文身份保持 wire 值。
 * @param signal - 放入位置参数取消槽位的值。
 * @returns 触及的资源，没有时仅为全局资源；
 *   资源无效时为 `undefined`：读取器抛出异常或返回空列表、
 *   默认字段是数组，
 *   或资源 id 不是非空字符串。
 */
export function callResources(
  typert: Pick<TypertRegistryContract, 'contexts' | 'lookups' | 'resources'>,
  readers: Readonly<Record<string, TypertResourceReader>> | undefined,
  descriptor: Pick<InvocationDescriptor, 'cancellation' | 'invocation' | 'parameters'>,
  args: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
): readonly RemoteAccessResource[] | undefined {
  // 每个后来的源替换其种类上较早的源，并保留该种类的位置。
  const sources = new Map<string, () => ResourceIds>()
  for (const { kind, field } of typert.resources.entries()) {
    sources.set(kind, () => {
      // 默认字段恰好指名一个资源 id；只有读取器可以返回多个。
      const id = defaultFieldId(descriptor, args, field)
      return Array.isArray(id) ? 'invalid' : id === undefined ? [] : [id]
    })
  }
  for (const [kind, ids] of lookupResources(typert, descriptor, args)) {
    sources.set(kind, () => ids)
  }
  let positional: readonly unknown[] | undefined
  for (const [kind, reader] of Object.entries(readers ?? {})) {
    sources.set(kind, () => {
      positional ??= [
        ...descriptor.parameters.map(parameter => args[parameter.wire]),
        ...descriptor.cancellation === undefined ? [] : [signal],
      ]
      return read(reader, positional, [])
    })
  }
  const resources: RemoteAccessResource[] = []
  for (const [kind, ids] of sources) {
    if (!collect(resources, kind, ids())) return undefined
  }
  return resources.length === 0 ? GLOBAL : resources
}

/**
 * 解析一个转发事件通知所触及的资源。事件携带其声明的全部资源，
 * 因此读取器返回 `undefined` 会使通知无效，
 * 而不是视为全局资源。
 * @param readers - 事件条目声明的读取器，未声明时为 `undefined`。
 * @param args - 事件校验后的 JSON 参数，作为位置参数传给每个读取器。
 * @returns 没有读取器（包括空读取器集合）时仅为全局资源；
 *   否则为触及的资源；资源无效时为 `undefined`：
 *   资源 id 缺失或格式错误。
 */
export function eventResources(
  readers: Readonly<Record<string, TypertResourceReader>> | undefined,
  args: readonly unknown[],
): readonly RemoteAccessResource[] | undefined {
  const declared = Object.entries(readers ?? {})
  if (declared.length === 0) return GLOBAL
  const resources: RemoteAccessResource[] = []
  for (const [kind, reader] of declared) {
    if (!collect(resources, kind, read(reader, args, 'invalid'))) return undefined
  }
  return resources
}

/**
 * 按资源种类给出查找参数与上下文身份指名的资源 id：
 * 上下文身份在前，随后按顺序是查找参数。
 * 调用省略的可选查找参数不指名资源 id；
 * 上下文身份是必需的。
 */
function lookupResources(
  typert: Pick<TypertRegistryContract, 'contexts' | 'lookups'>,
  descriptor: Pick<InvocationDescriptor, 'invocation' | 'parameters'>,
  args: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, unknown[]> {
  const ids = new Map<string, unknown[]>()
  const add = (kind: string, id: unknown): void => {
    const list = ids.get(kind)
    if (list === undefined) ids.set(kind, [id])
    else list.push(id)
  }
  const receiver = descriptor.invocation
  if (receiver.kind === 'context') {
    const kind = typert.contexts.getHost(receiver.context)?.resource
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- domain packages merge resource kinds into TypertResourceMap.
    if (kind !== undefined) add(kind, args[receiver.wire])
  }
  for (const parameter of descriptor.parameters) {
    if (parameter.lookup === undefined) continue
    const kind = typert.lookups.get(parameter.lookup)?.resource
    const id = args[parameter.wire]
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- domain packages merge resource kinds into TypertResourceMap.
    if (kind !== undefined && id !== undefined) add(kind, id)
  }
  return ids
}

/** 以展开的位置参数运行一个读取器：`undefined` 产出 `absent`，列表指名多个且不得为空。 */
function read(reader: TypertResourceReader, args: readonly unknown[], absent: ResourceIds): ResourceIds {
  let value: unknown
  try {
    value = reader(...args)
  } catch {
    // 读取器的任何错误都意味着它无法指名其资源，因此这些资源无效。
    return 'invalid'
  }
  if (value === undefined) return absent
  if (!Array.isArray(value)) return [value]
  return value.length === 0 ? 'invalid' : value
}

/** 追加一个种类的资源 id；任一格式错误则返回 false。 */
function collect(resources: RemoteAccessResource[], kind: string, ids: ResourceIds): boolean {
  if (ids === 'invalid') return false
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0) return false
    // 种类来自注册、查找、上下文适配器与读取器键，全部由合并的资源映射约束类型。
    resources.push({ kind, id } as RemoteAccessResource)
  }
  return true
}

/** 默认字段：顶层参数，否则为首个对象参数上的该字段。 */
function defaultFieldId(
  descriptor: Pick<InvocationDescriptor, 'parameters'>,
  args: Readonly<Record<string, unknown>>,
  field: string,
): unknown {
  if (descriptor.parameters.some(parameter => parameter.wire === field)) return args[field]
  for (const parameter of descriptor.parameters) {
    const value = args[parameter.wire]
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    if (!Object.hasOwn(value, field)) return undefined
    const id: unknown = Reflect.get(value, field)
    return id
  }
  return undefined
}
