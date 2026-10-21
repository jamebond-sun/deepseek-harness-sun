/**
 * 由带版本的、承载于被装饰类原型上的描述符支撑的远程装饰器与显式
 * Gateway 绑定。严格的反射仍是 Typert 编译器的职责。
 * @module @deepseek-ai/dsh-typert-protocol
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  RemoteWireArgs,
  TypertContextMap,
  TypertResourceReader,
  TypertResourceReaders,
} from './types.ts'

export { RemoteError, remoteErrorOf } from './remote-error.ts'
export { TYPERT_OWNED_VALUE, isTypertOwnedValue, typertOwnedValue } from './owned-value.ts'
export type { TypertOwnedValue } from './owned-value.ts'
export { isRemoteJsonValue, isRemoteUplinkItem } from './json-value.ts'
export { createTypertRemoteInfo, isTypertRemoteMethod } from './remote-info.ts'
export { principalOf } from './principal.ts'
export type { RemoteAccessResource, RemoteAccessResourceKind, RemoteAccessResourceOf } from './remote-access.ts'

const TYPERT_REMOTE_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

/**
 * 将一个生成的 Remote 名称对照连接端点语法进行检验。
 * @param value - 命名空间、方法、lookup 或 Context 段。
 * @returns 该值是否能不变地穿越共享 RPC 载体。
 */
export function isTypertRemoteSegment(value: string): boolean {
  return value !== '.' && value !== '..' && TYPERT_REMOTE_SEGMENT_PATTERN.test(value)
}

export type {
  InvocationDescriptor,
  InvocationParameterDescriptor,
  InvocationSourceLocation,
  PeerId,
  PeerScope,
  Principal,
  PrincipalMap,
  RemoteDecoded,
  RemoteErrorCode,
  RemoteErrorDetailsMap,
  RemoteFailure,
  RemoteInvocation,
  RemoteResult,
  RemoteStream,
  RemoteStreamHandle,
  RemoteUplinkWindow,
  RemoteWireArgs,
  RemoteWireValue,
  TypertClientEventListener,
  TypertClientRemote,
  TypertClientContextAdapter,
  TypertCodec,
  TypertContext,
  TypertContextMap,
  TypertContextRegistry,
  TypertContextWire,
  TypertDisposer,
  TypertForwardableEvent,
  TypertForwardableEventEntry,
  TypertHostContextAdapter,
  TypertHostContextResolver,
  TypertResource,
  TypertResourceDeclaration,
  TypertResourceEntry,
  TypertResourceId,
  TypertResourceKind,
  TypertResourceMap,
  TypertResourceReader,
  TypertResourceReaders,
  TypertResourceRegistry,
  TypertLocalRegistry,
  TypertLookup,
  TypertLookupDefinition,
  TypertLookupHost,
  TypertLookupMap,
  TypertLookupProvider,
  TypertLookupResolver,
  TypertLookupRegistry,
  TypertLookupWire,
  TypertRemoteScopeApi,
  TypertRemoteScopeMap,
  TypertRemoteScopeNamespace,
  TypertRemoteContribution,
  TypertRemoteInfo,
  TypertRemoteInputOptions,
  TypertRemoteMethod,
  TypertRemoteValue,
  TypertRemoteCodecSpec,
  TypertRemoteParameterSpec,
  TypertRemoteMethodSpec,
  TypertRemoteSpec,
  TypertRemoteEvent,
  TypertRemoteEventSelection,
  TypertRemoteMap,
  TypertRemoteNamespace,
  TypertRemoteNamespaceMap,
  TypertRemoteRegistry,
  TypertRegistryChange,
  TypertRegistryListener,
  TypertSchema,
  TypertRegistryContract,
} from './types.ts'

/** 一个显式 Service 到 Gateway 绑定的选项。 */
export interface TypertGatewayBindingOptions {
  /** 传输线命名空间；默认为 Cordis 服务键。 */
  readonly namespace?: string
}

/** 声明一个 Service 参与 Typert Gateway 导出的可见声明。 */
export interface TypertGatewayBinding<Service extends object = object> {
  readonly service: Service
  readonly serviceKey: string
  readonly namespace: string
}

/** 由 Remote 方法装饰器记录的调用模式。 */
export type RemoteInvocationMarker =
  | { readonly kind: 'direct' }
  | { readonly kind: 'context'; readonly context: string }

/** 为一个存活 Service 实例发现的一个装饰器标记。 */
export interface RemoteMethodMarker {
  /** 承载实现的公共实例方法。 */
  readonly method: string
  /** 当端点方法不同于实现成员时的端点方法。 */
  readonly exportName?: string
  /** 流方法产出多个各自独立校验的结果项。 */
  readonly mode?: 'stream'
  readonly invocation: RemoteInvocationMarker
  /**
   * 按资源种类键控的、已声明的 `resources` 读取器。调用方将方法的传输线参数
   * 展开传入每一个读取器并校验其结果。
   */
  readonly resources?: Readonly<Record<string, TypertResourceReader>>
}

/**
 * 为一个 Remote Scope 方法提供的显式端点与资源选择。
 * @template WireArgs - 被装饰方法的位置参数在传输线上的承载形式；
 *   默认的 `never` 接受任意元组的读取器。
 */
export interface RemoteScopeOptions<WireArgs extends readonly unknown[] = never> {
  /** Exported endpoint method; omission retains the implementation member name. */
  readonly name?: string
  /**
   * 一次调用触及的资源的逐种类读取器。每个读取器接收方法的参数作为自身的形参、
   * 由 Typert 编解码器校验过的 JSON 参数、作为传输线身份的 lookup 参数，以及
   * 作为调用信号的取消参数，因此它只执行普通读取，并返回一个身份、多个身份，
   * 或无（表示没有）。一个抛出、空列表，或非非空字符串之外的身份会拒绝该调用。
   * 对于没有读取器的种类，Gateway 读取一个限定 Context 的身份（其 Host 适配器
   * 声明了该 `resource`），以及声明了它的 lookup 参数的身份；否则读取在
   * `typert.resources` 中注册的字段：一个顶层参数，若没有则读取第一个对象参数。
   * 不带身份的调用触及 `global`。读取器与这些默认值一起必须命名该方法访问的
   * 每一个资源：访问控制绝不检查它们所省略的资源。
   */
  readonly resources?: TypertResourceReaders<WireArgs>
}

/**
 * 为一个直连 Remote 方法提供的显式端点、流与资源选择。
 * @template WireArgs - 被装饰方法的位置参数在传输线上的承载形式；
 *   默认的 `never` 接受任意元组的读取器。
 */
export interface RemoteMethodOptions<WireArgs extends readonly unknown[] = never> extends RemoteScopeOptions<WireArgs> {
  /** `stream`：通过共享的逻辑流载体交付每个 Iterable 项。 */
  readonly mode?: 'stream'
}

/** 其 `resources` 读取器已对照被装饰方法的参数校验过的装饰器。 */
type RemoteTypedMethodDecorator<This extends object, Args extends unknown[], Result> = (
  method: (this: This, ...args: Args) => Result,
  context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
) => void

type RemoteMethodDecorator = <This extends object, Args extends unknown[], Result>(
  method: (this: This, ...args: Args) => Result,
  context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
) => void

interface RemoteInitializerContext<This extends object> {
  readonly private: boolean
  readonly static: boolean
  readonly name: string | symbol
  addInitializer(initializer: (this: This) => void): void
}

interface StoredRemoteMethodMarker {
  readonly exportName?: string
  readonly mode?: 'stream'
  readonly invocation: RemoteInvocationMarker
  readonly resources?: Readonly<Record<string, TypertResourceReader>>
}

/** 由装饰器实参选定的标记字段。 */
interface RemoteMarkerOptions {
  readonly mode?: 'stream'
  readonly exportName?: string
  readonly resources?: Readonly<Record<string, TypertResourceReader>>
}

interface StoredRemoteMethod extends StoredRemoteMethodMarker {
  readonly method: string
}

interface RemoteMethodDescriptorV1 {
  readonly version: 1
  readonly methods: readonly StoredRemoteMethod[]
}

const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/**
 * 将一个可见的 Service 字段绑定到 Cordis 键与 Remote 命名空间。一个拥有
 * Cordis Context 的 Service 还会为其树提供 `ctx.invocation`（Remote 调用
 * 之外为 `undefined`），因此 Host 组合无需 `TypertRemoteService` 即可读取它。
 * @param service - 拥有 Service 实例，通常为 `this`。
 * @param serviceKey - 精确的 Cordis 服务键。
 * @param options - 可选的传输线命名空间。
 * @returns 一个冻结的、可检查的绑定，不含编译器注入的元数据。
 */
export function bindTypertRemote<Service extends object>(
  service: Service,
  serviceKey: string,
  options: TypertGatewayBindingOptions = {},
): TypertGatewayBinding<Service> {
  validateName('service key', serviceKey)
  const namespace = options.namespace ?? serviceKey
  validateName('namespace', namespace)
  const ctx: unknown = Reflect.get(service, 'ctx')
  if (Context.is(ctx)) provideInvocationAccessor(ctx)
  return Object.freeze({ service, serviceKey, namespace })
}

/** 通过其注册名经由 Typert Gateway 暴露的 Cordis Service 基类。 */
export abstract class TypertRemoteService<out T = never> extends Service<T> {
  /** Visible binding consumed by the Gateway's source-mode discovery. */
  readonly typertRemote: TypertGatewayBinding<this>

  /**
   * 注册该 Service 并将同一键绑定到 Typert Gateway。
   * @param ctx - 拥有的 Cordis Context。
   * @param serviceKey - 精确的 Cordis 服务键与默认传输线命名空间。
   * @param options - 可选的传输线命名空间。
   */
  protected constructor(ctx: Context, serviceKey: string, options: TypertGatewayBindingOptions = {}) {
    super(ctx, serviceKey)
    this.typertRemote = bindTypertRemote(this, this.name, options)
  }
}

/**
 * 让 `ctx.invocation` 在 Remote 调用之外读取为 `undefined`，而非反射服务的
 * “无法获取属性”错误；由调用派生的 Context 以自己的属性遮蔽该访问器。树中
 * 构造的第一个 Remote Service 将其注册到根上，使其比任何单一 Service 都长寿。
 */
function provideInvocationAccessor(ctx: Context): void {
  if (Object.hasOwn(ctx.root.reflect.props, 'invocation')) return
  ctx.root.accessor('invocation', { get: () => undefined })
}

/**
 * 将一个公共实例方法标记为一个直连 Remote 调用。
 * @param _method - 被装饰方法；仅由类自身保留。
 * @param context - 用于安排私有标记的标准装饰器上下文。
 */
export function Remote<This extends object, Args extends unknown[], Result>(
  _method: (this: This, ...args: Args) => Result,
  context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
): void
/**
 * 用端点名标记一个公共实例方法。
 * @param name - 导出的端点方法。
 * @returns 一个标准方法装饰器。
 */
export function Remote(name: string): RemoteMethodDecorator
/**
 * 用端点、流或资源选项标记一个公共实例方法。
 * @param options - Remote 选项；每个读取器的形参从被装饰方法推断。
 * @returns 一个标准方法装饰器。
 */
export function Remote<This extends object, Args extends unknown[], Result>(
  options: NoInfer<RemoteMethodOptions<RemoteWireArgs<Args>>>,
): RemoteTypedMethodDecorator<This, Args, Result>
export function Remote<This extends object, Args extends unknown[], Result>(
  methodExportOrOptions: string | RemoteMethodOptions | ((this: This, ...args: Args) => Result),
  context?: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
): void | RemoteMethodDecorator {
  if (typeof methodExportOrOptions === 'string') {
    validateName('Remote export name', methodExportOrOptions)
    return remoteDecorator({ kind: 'direct' }, { exportName: methodExportOrOptions })
  }
  if (typeof methodExportOrOptions === 'object') {
    return remoteDecorator({ kind: 'direct' }, markerOptions(
      methodExportOrOptions,
      REMOTE_OPTION_KEYS,
      'Remote options require name, mode: "stream", or resources',
    ))
  }
  if (context === undefined) throw new TypeError('typert-protocol: Remote decorator context is missing')
  addMarkerInitializer(context, { kind: 'direct' })
}

const REMOTE_OPTION_KEYS: ReadonlySet<string> = new Set(['name', 'mode', 'resources'])
const REMOTE_SCOPE_OPTION_KEYS: ReadonlySet<string> = new Set(['name', 'resources'])

/** 对照装饰器实参接受的键校验一个装饰器选项对象，并选定标记字段。 */
function markerOptions(options: RemoteMethodOptions, accepted: ReadonlySet<string>, requirement: string): RemoteMarkerOptions {
  const keys = Reflect.ownKeys(options)
  if (keys.length === 0 || keys.some(key => typeof key !== 'string' || !accepted.has(key))
    || (Object.hasOwn(options, 'mode') && options.mode !== 'stream')) {
    throw new TypeError(`typert-protocol: ${requirement}`)
  }
  const { mode, name, resources } = options
  if (name !== undefined) validateName('Remote export name', name)
  return {
    ...(mode === undefined ? {} : { mode }),
    ...(name === undefined ? {} : { exportName: name }),
    ...(resources === undefined ? {} : { resources: resourceReaders(resources) }),
  }
}

/** 将已声明的读取器冻结进标记记录；声明错误的读取器在装饰时失败。 */
function resourceReaders(resources: object): Readonly<Record<string, TypertResourceReader>> {
  const readers: Record<string, TypertResourceReader> = {}
  for (const [kind, reader] of Object.entries(resources as Readonly<Record<string, unknown>>)) {
    if (typeof reader !== 'function') {
      throw new TypeError(`typert-protocol: Remote resource reader "${kind}" must be a function`)
    }
    readers[kind] = reader as TypertResourceReader
  }
  if (Object.keys(readers).length === 0) throw new TypeError('typert-protocol: Remote resources require at least one reader')
  return Object.freeze(readers)
}

function remoteDecorator(
  invocation: RemoteInvocationMarker,
  options: RemoteMarkerOptions = {},
): RemoteMethodDecorator {
  return function <This extends object, Args extends unknown[], Result>(
    _method: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
  ): void {
    addMarkerInitializer(context, invocation, options)
  }
}

/**
 * 为从一个 Remote Scope 解析出的方法创建装饰器。
 * @param key - 通过 Context 映射声明的 scope 键。
 * @param name - 可选的 Remote 导出名；默认为方法名。
 * @returns 一个记录带版本原型描述符的标准方法装饰器。
 */
export function RemoteScope(key: Extract<keyof TypertContextMap, string>, name?: string): RemoteMethodDecorator
/**
 * 为带有端点或资源选项的 Remote Scope 方法创建装饰器。
 * @param key - 通过 Context 映射声明的 scope 键。
 * @param options - Remote Scope 选项；每个读取器的形参从被装饰方法推断。
 * @returns 一个记录带版本原型描述符的标准方法装饰器。
 */
export function RemoteScope<This extends object, Args extends unknown[], Result>(
  key: Extract<keyof TypertContextMap, string>,
  options: NoInfer<RemoteScopeOptions<RemoteWireArgs<Args>>>,
): RemoteTypedMethodDecorator<This, Args, Result>
export function RemoteScope(
  key: Extract<keyof TypertContextMap, string>,
  option?: string | RemoteScopeOptions,
): RemoteMethodDecorator {
  validateName('Scope key', key)
  const invocation: RemoteInvocationMarker = { kind: 'context', context: key }
  if (option === undefined) return remoteDecorator(invocation)
  if (typeof option === 'string') {
    validateName('Remote export name', option)
    return remoteDecorator(invocation, { exportName: option })
  }
  return remoteDecorator(invocation, markerOptions(
    option,
    REMOTE_SCOPE_OPTION_KEYS,
    'RemoteScope options require name or resources',
  ))
}

/**
 * 读取附加到一个存活 Service 类原型上的 Remote 标记。
 * 返回的快照无法修改已存储的描述符。
 * @param service - 存活 Service 实例。
 * @returns 按类声明顺序排列的标记。
 */
export function remoteMethods(service: object): readonly RemoteMethodMarker[] {
  const prototype = Object.getPrototypeOf(service) as object | null
  if (prototype === null) return []
  return (readRemoteMethodDescriptor(prototype)?.methods ?? []).map(marker => ({ ...marker }))
}

function readRemoteMethodDescriptor(prototype: object): RemoteMethodDescriptorV1 | undefined {
  const property = Object.getOwnPropertyDescriptor(prototype, REMOTE_METHOD_DESCRIPTOR)
  if (property === undefined) return undefined
  const descriptor: unknown = property.value
  if (descriptor === null || typeof descriptor !== 'object') {
    throw new TypeError('typert-protocol: Remote method descriptor must be an object')
  }
  const version: unknown = Reflect.get(descriptor, 'version')
  if (version !== 1) {
    throw new TypeError(`typert-protocol: unsupported Remote method descriptor version ${String(version)}`)
  }
  const methods: unknown = Reflect.get(descriptor, 'methods')
  if (!Array.isArray(methods)) {
    throw new TypeError('typert-protocol: Remote method descriptor methods must be an array')
  }
  return descriptor as RemoteMethodDescriptorV1
}

function addMarkerInitializer<This extends object>(
  context: RemoteInitializerContext<This>,
  invocation: RemoteInvocationMarker,
  options: RemoteMarkerOptions = {},
): void {
  if (context.private || context.static || typeof context.name !== 'string') {
    throw new TypeError('typert-protocol: Remote decorators require a public instance method with a string name')
  }
  const method = context.name
  context.addInitializer(function (this: This) {
    const prototype = Object.getPrototypeOf(this) as object | null
    if (prototype === null) {
      throw new TypeError(`typert-protocol: cannot mark Remote method "${method}" on an object without a prototype`)
    }
    mark(prototype, method, invocation, options)
  })
}

function mark(
  prototype: object,
  method: string,
  invocation: RemoteInvocationMarker,
  { mode, exportName, resources }: RemoteMarkerOptions,
): void {
  const descriptor = readRemoteMethodDescriptor(prototype)
  const marker: StoredRemoteMethod = Object.freeze({
    method,
    ...(exportName === undefined || exportName === method ? {} : { exportName }),
    ...(mode === undefined ? {} : { mode }),
    invocation: Object.freeze(invocation),
    ...(resources === undefined ? {} : { resources }),
  })
  const current = descriptor?.methods.find(candidate => candidate.method === method)
  if (current !== undefined) {
    // 一次装饰器应用拥有一个冻结的读取器记录，因此引用同一标识即代表同一声明。
    if (current.exportName === marker.exportName
      && current.mode === marker.mode
      && current.resources === marker.resources
      && sameInvocation(current.invocation, invocation)) return
    throw new Error(`typert-protocol: Remote method "${method}" has conflicting invocation markers`)
  }
  Object.defineProperty(prototype, REMOTE_METHOD_DESCRIPTOR, {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze([...(descriptor?.methods ?? []), marker]),
    } satisfies RemoteMethodDescriptorV1),
  })
}

function sameInvocation(left: RemoteInvocationMarker, right: RemoteInvocationMarker): boolean {
  if (left.kind === 'direct') return right.kind === 'direct'
  if (right.kind === 'direct') return false
  return left.context === right.context
}

function validateName(subject: string, value: string): void {
  if (!isTypertRemoteSegment(value)) {
    throw new TypeError(`typert-protocol: ${subject} must contain only RPC endpoint segment characters`)
  }
}
