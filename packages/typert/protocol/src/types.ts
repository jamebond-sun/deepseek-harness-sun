/**
 * 业务包、生成的 Remote 产物、Host Gateway 与 Client API 实现共享的、与编译器无关的 Typert 协议。
 * @module @deepseek-ai/dsh-typert-protocol/types
 */

import type { Context, Events } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ZodType } from 'zod'
import type { TypertOwnedValue } from './owned-value.ts'

declare const LOOKUP_HOST: unique symbol
declare const LOOKUP_WIRE: unique symbol
declare const CONTEXT_WIRE: unique symbol
declare const RESOURCE_ID: unique symbol

/** Host 对象与其传输线身份之间的类型级关联。 */
export interface TypertLookup<Host, Wire> {
  readonly [LOOKUP_HOST]: Host
  readonly [LOOKUP_WIRE]: Wire
}

/** 提取某一 lookup 声明关联的 Host 对象。 */
export type TypertLookupHost<Lookup> = Lookup extends TypertLookup<infer Host, infer _Wire> ? Host : never

/** 提取某一 lookup 声明关联的传输线身份。 */
export type TypertLookupWire<Lookup> = Lookup extends TypertLookup<infer _Host, infer Wire> ? Wire : never

/** 某个限定 Context 种类与其传输线身份之间的类型级关联。 */
export interface TypertContext<Wire> {
  readonly [CONTEXT_WIRE]: Wire
}

/** 提取某一限定 Context 声明关联的传输线身份。 */
export type TypertContextWire<ContextType> = ContextType extends TypertContext<infer Wire> ? Wire : never

/** 可合并扩展的 Host 对象 lookup 声明。 */
export interface TypertLookupMap {}

/** 可合并扩展的限定 Context 声明。 */
export interface TypertContextMap {}

/** 资源种类与其身份类型之间的类型级关联。 */
export interface TypertResource<Id> {
  readonly [RESOURCE_ID]: Id
}

/** 提取某一资源声明关联的身份类型。 */
export type TypertResourceId<Resource> = Resource extends TypertResource<infer Id> ? Id : never

/**
 * 可合并扩展的资源种类，其身份可由一次 Remote 调用或转发的事件携带。
 * 拥有某身份类型的包声明其种类；该值为该种类的身份类型，例如
 * 一个 branded id 这样的字符串类型。`global` 指代内置的无身份资源，
 * 在此处从不是一种种类。
 */
export interface TypertResourceMap {}

/** One declared resource kind. */
export type TypertResourceKind = Extract<keyof TypertResourceMap, string>

/**
 * 各按种类调用的资源读取器，以一个参数元组按位置展开传入：执行普通读取，
 * 返回一个身份、多个身份，或表示无的 `undefined`。
 * @template Args - 读取器作为形参接收的参数元组。
 */
export type TypertResourceReaders<Args extends readonly unknown[]> = {
  readonly [Kind in TypertResourceKind]?: (...args: Args) =>
    | TypertResourceId<TypertResourceMap[Kind]>
    | readonly TypertResourceId<TypertResourceMap[Kind]>[]
    | undefined
}

/**
 * 运行时载体所存的类型擦除资源读取器；调用方将参数元组展开传入并校验其结果。
 * 通过方法声明，使按自身形参类型化的读取器无需强制转换即可赋值。
 */
export type TypertResourceReader = { read(...args: readonly unknown[]): unknown }['read']

type TypertLookupEntry = TypertLookupMap[keyof TypertLookupMap]
type TypertWireForHost<Value, Entry> = Entry extends unknown
  ? Value extends TypertLookupHost<Entry> ? TypertLookupWire<Entry> : never
  : never

/** 方法参数抵达传输线时的形态：lookup 的 Host 对象变为其传输线身份。 */
export type RemoteWireValue<Value> = Value extends TypertLookupHost<TypertLookupEntry>
  ? TypertWireForHost<Value, TypertLookupEntry>
  : Value

/** 方法的位置参数在传输线上承载的形态。 */
export type RemoteWireArgs<Args extends unknown[]> = { [Index in keyof Args]: RemoteWireValue<Args[Index]> }

/** 为消费者生成的可合并扩展的直连 Remote 方法签名。 */
export interface TypertRemoteMap {}

/**
 * 可合并扩展的 Remote 失败词表：本包一次性声明通用的载体码；Gateway 合并
 * 其基础设施码，每个所有者在其抛出码旁合并其领域码。
 */
export interface RemoteErrorDetailsMap {
  /** 所有者侧业务校验拒绝了请求；当某个校验器产出时，`issues` 携带其输出。 */
  'gateway/bad-request': { readonly issues?: readonly object[] }
  /** 调用被载体信号或后端取消。 */
  'gateway/cancelled': {}
  /** 载体、分发或未分类的 Host 失败。 */
  'gateway/internal': {}
}

/** 所有已声明的 Remote 失败码。 */
export type RemoteErrorCode = keyof RemoteErrorDetailsMap

/**
 * 一次 Remote 调用的失败：RemoteError 实例按 code 区分的联合，因此
 * 一个 `code` 分支可在无强制转换的情况下收窄 `details`。
 */
export type RemoteFailure = {
  [Code in RemoteErrorCode]: import('./remote-error.ts').RemoteError<Code>
}[RemoteErrorCode]

/**
 * 每个生成的 Remote 方法所解析出的结果。Remote 端自身将载体失败折叠进
 * 错误分支，因此没有消费者需要包裹一次调用以恢复其中之一；只有装配故障
 * （参数个数、未挂载的方法、缺失的 Context 适配器）仍会 reject。
 * @template T - Host 方法的业务结果。
 */
export type RemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RemoteFailure }

declare const STREAM_UPLINK: unique symbol

/**
 * 一个 Host 方法返回的 Remote 流：它向 Client 产出的项，作为普通的
 * `AsyncIterable<Out>` 迭代。`In` 是 Client 可在同一逻辑流上回送的项类型，
 * 通过 `RemoteInvocation.uplink()` 读取；它仅作为类型级标记携带。默认的
 * `never` 声明一个不读取任何项的方法，其描述符不携带上行编解码器。一个
 * 生成的 Client 流方法以 `RemoteStreamHandle<Out, In>` 形式返回同一流。
 * @template Out - Host 方法产出的项类型。
 * @template In - Client 可发送的项类型；不读取时为 `never`。
 */
export type RemoteStream<Out, In = never> = AsyncIterable<Out> & { readonly [STREAM_UPLINK]?: In }

/**
 * Client 持有的一个已开启 Remote 流：下行项作为 `AsyncIterable`，外加同一
 * 逻辑流的上行与取消。生成的 Client 流方法返回它，调用该方法即开启流：
 * 既未迭代也未释放句柄的持有者会让 Host 流保持存活。句柄代表一代：当载体
 * 丢失时，迭代以载体错误失败，句柄结束。
 * @template Out - Host 方法产出的项类型。
 * @template In - Client 可发送的项类型；不读取时为 `never`。
 */
export interface RemoteStreamHandle<Out, In> extends AsyncIterable<Out> {
  /**
   * 发送一个上行项。在流开启前发送的项会排队，待 `open` 帧进入传输线后发送。
   * 顶层的 `undefined` 以不含 `value` 的 `item` 帧传输。
   * @param item - Host 依据方法上行编解码器校验的项。
   * @throws {Error} 当该项不是无损 JSON 值、当已调用 `end()`，或流已终止时。
   */
  send(item: In): void
  /** Half-close the uplink: the Host's `uplink()` iteration ends. Idempotent; ignored after termination. */
  end(): void
  /**
   * 取消逻辑流：除非已收到终止帧，否则发送 `cancel`，并安静地结束下行迭代器。
   * 提前跳出 `for await` 效果相同。
   */
  dispose(): void
}

/** 为消费者生成的可合并扩展的限定 Remote 方法签名。 */
export interface TypertRemoteScopeMap {}

type TypertEventParameters<Event extends keyof Events> =
  Events[Event] extends (...args: infer Args) => unknown ? Args : never

type TypertEventResult<Event extends keyof Events> =
  Events[Event] extends (...args: never[]) => infer Result ? Result : never

type TypertProjectedContextKey = Extract<keyof TypertLookupMap, keyof TypertContextMap>

type TypertProjectedContextSubject = {
  [Key in TypertProjectedContextKey]: TypertLookupHost<TypertLookupMap[Key]>
}[TypertProjectedContextKey]

type TypertAgentScopedRequest<Request> = Request extends object
  ? 'agent' extends keyof Request
    ? Exclude<Request['agent'], undefined> extends TypertProjectedContextSubject ? Request : never
    : never
  : never

type TypertWaterfallEvent<Event extends keyof Events> =
  unknown extends ThisParameterType<Events[Event]>
    ? never
    : TypertEventParameters<Event> extends [infer Request, infer Next]
      ? Next extends () => TypertEventResult<Event>
        ? TypertEventResult<Event> extends Promise<unknown>
          ? TypertAgentScopedRequest<Request> extends never ? never : Event
          : never
        : never
      : never

type TypertForwardingMode<Event extends keyof Events> =
  unknown extends ThisParameterType<Events[Event]>
    ? TypertEventResult<Event> extends void ? 'emit' : never
    : TypertWaterfallEvent<Event> extends never ? never : 'waterfall'

/**
 * Remote Event 载体可在无需第二份签名声明的情况下保留的 Cordis 事件名：
 * 无作用域的 `void` 通知，以及最终的形参为其同结果 `next()` 回调的限定异步
 * 瀑布。
 */
export type TypertForwardableEvent = {
  [Event in keyof Events]: TypertForwardingMode<Event> extends never ? never : Event
}[keyof Events]

/**
 * Remote Event 源接受的事件与分发模式。`emit` 条目可声明其负载携带的
 * 资源读取器；不带 `resources` 的条目触及内置的 `global` 资源。非所有者
 * Peer 仅在经过访问决策后收到 `emit` 通知，且绝不会收到 `waterfall`。
 */
export type TypertForwardableEventEntry = {
  [Event in keyof Events]: TypertForwardingMode<Event> extends infer Mode
    ? Mode extends 'emit'
      ? {
        readonly event: Event
        readonly mode: Mode
        readonly resources?: TypertResourceReaders<TypertEventParameters<Event>>
      }
      : Mode extends 'waterfall'
        ? { readonly event: Event; readonly mode: Mode }
        : never
    : never
}[keyof Events]

/** 由 Host 装配一次性声明的可合并扩展转发选择。 */
export interface TypertRemoteEventSelection {}

/** 从兼容载体的 Cordis 事件声明中选出的合法 `$on` 键。 */
export type TypertRemoteEvent = Extract<TypertForwardableEvent, keyof TypertRemoteEventSelection>

type TypertClientAgent<Value> =
  Exclude<Value, undefined> extends TypertProjectedContextSubject
    ? Context | Extract<Value, undefined>
    : Value

type TypertClientEventRequest<Request> = Request extends object
  ? { [Key in keyof Request]: Key extends 'agent' ? TypertClientAgent<Request[Key]> : Request[Key] }
  : never

type TypertScopedClientEventListener<Event extends TypertRemoteEvent> =
  Events[Event] extends (request: infer Request, next: infer Next) => infer Result
    ? (
      this: Context,
      request: TypertClientEventRequest<Request>,
      next: Next,
    ) => Result
    : never

/**
 * 由一个选定的 Cordis 事件声明派生的监听器。限定的 Host 主体变为已解析的
 * Client `Context`；单向通知保持其声明不变。
 * @template Event - 选定的 Remote Event 名称。
 */
export type TypertClientEventListener<Event extends TypertRemoteEvent> =
  unknown extends ThisParameterType<Events[Event]>
    ? Events[Event]
    : TypertScopedClientEventListener<Event>

/**
 * 从生成的扁平端点映射解析一个直连 Remote 命名空间。
 * @template Namespace - 端点斜杠之前的传输线命名空间。
 */
export type TypertRemoteNamespace<Namespace extends string> = {
  [Endpoint in keyof TypertRemoteMap as Endpoint extends `${Namespace}/${infer Method}`
    ? Method
    : never]: TypertRemoteMap[Endpoint]
}

/**
 * Resolve one scoped Remote namespace across every generated Context kind.
 * The calling Cordis Context supplies the concrete identity at runtime.
 * @template Namespace - wire namespace between the Context prefix and method.
 */
export type TypertRemoteScopeNamespace<
  Namespace extends string,
  ContextKey extends string = string,
> = {
  [Endpoint in keyof TypertRemoteScopeMap as Endpoint extends `${ContextKey}:${Namespace}/${infer Method}`
    ? Method
    : never]: TypertRemoteScopeMap[Endpoint]
}

type TypertRemoteScopeNamespaceKey<
  ContextKey extends string,
  Endpoint = keyof TypertRemoteScopeMap,
> = Endpoint extends `${ContextKey}:${infer Namespace}/${string}` ? Namespace : never

/** 某一 Context 种类可用的、生成的限定 Remote 命名空间。 */
export type TypertRemoteScopeApi<ContextKey extends string> = {
  [Namespace in TypertRemoteScopeNamespaceKey<ContextKey>]:
  TypertRemoteScopeNamespace<Namespace, ContextKey>
}

/** 为 Client Remote 服务生成的可合并扩展的直连命名空间表面。 */
export interface TypertRemoteNamespaceMap {}

/** Cordis 所有的 Typert 注册所返回的、可等待的释放器。 */
export type TypertDisposer = () => Promise<void>

type StringKeyOf<Value> = Extract<keyof Value, string>

/** 严格生成的编解码器携带的最简运行时 schema 能力。 */
export interface TypertSchema<Output = unknown> {
  /**
   * 解析并校验一个边界值。
   * @param value - 不受信任的边界值。
   * @returns 校验后的值。
   */
  parse(value: unknown): Output
}

/** Remote 载体重建的原生字节视图拥有普通的 ArrayBuffer 后备。 */
export type RemoteDecoded<Value> = Value extends Uint8Array ? Uint8Array<ArrayBuffer>
  : Value extends string | number | boolean | bigint | symbol ? Value
    : Value extends object ? { [Key in keyof Value]: RemoteDecoded<Value[Key]> } : Value

/** 附加在一个调用参数或结果上的编解码器。 */
export type TypertCodec<Value = unknown> =
  | TypertRemoteValue<Value> & {
    readonly mode: 'strict'
    readonly typeSymbol: string
    /**
     * 解码一个其字段需要类型特定处理的单值结果。
     * @param value - RPC 载体重建的结果。
     * @returns 校验后的结果，保留原生字节视图。
     */
    readonly decode?: ((value: unknown) => unknown) | undefined
    /**
     * 将类型化的二进制字段投影进 RPC 结果附件。
     * @param value - 原生单值结果。
     * @param writeBytes - 在相对于结果的位置记录一个字节视图并返回其 JSON 占位符。
     * @returns 保留未触及 JSON 子树的 JSON 元数据。
     */
    readonly encode?: ((value: unknown, writeBytes: (bytes: Uint8Array, path: readonly (string | number)[]) => null) => unknown) | undefined
  }
  | {
    readonly mode: 'src-json'
  }

/** 一次 Remote 调用中的一个有序业务参数。 */
export interface InvocationParameterDescriptor {
  /** Source-level parameter name. */
  readonly name: string
  /** Source parameter documentation, independent of JSON Schema support. */
  readonly description?: string
  /** Required key in the wire `args` object. */
  readonly wire: string
  /** Whether the value is JSON or requires a registered Host lookup. */
  readonly source: 'json' | 'lookup'
  /** Lookup key when `source` is `lookup`. */
  readonly lookup?: string
  /** Boundary codec for the wire representation. */
  readonly codec: TypertCodec
  /** Missing wire fields decode to `undefined` only for an explicitly declared `T | undefined`. */
  readonly acceptsUndefined?: true
}

/** 从生成定义保留、用于诊断的源位置。 */
export interface InvocationSourceLocation {
  readonly file: string
  readonly line: number
  readonly column: number
}

/** 与载体无关的、对一个已导出方法调用的描述。 */
export interface InvocationDescriptor {
  /** Globally stable generated identity. */
  readonly id: string
  /** Cordis service key owning the method. */
  readonly service: string
  /** Wire namespace, defaulting to the service key. */
  readonly namespace: string
  /** Public instance method name. */
  readonly method: string
  /** Service member invoked when the exported method name is an alias. */
  readonly implementation?: string
  /** Absent for unary calls; stream calls deliver every yielded item as the Host produced it. */
  readonly mode?: 'stream'
  /** Receiver selection mode. */
  readonly invocation:
    | { readonly kind: 'direct' }
    | {
      readonly kind: 'context'
      readonly context: string
      readonly wire: string
      readonly codec: TypertCodec
    }
  /** 为一个直连 lookup 参数的可选消费端 Context 投影。 */
  readonly scope?: {
    /** 由 Client 适配器提供身份的 Context 种类。 */
    readonly context: string
    /** 被 Context 身份替换的 lookup 参数传输线字段。 */
    readonly wire: string
  }
  /** 有序业务参数。 */
  readonly parameters: readonly InvocationParameterDescriptor[]
  /**
   * 与本方法 `RemoteStream<Out, In>` 返回类型的 `In` 类型实参生成的、
   * 同一逻辑流的 Client 到 Host 项；当 `In` 为 `never` 时缺省。方法通过
   * `RemoteInvocation.uplink()` 读取这些项，因此没有任何内容进入参数列表。
   */
  readonly uplink?: {
    /** 在 `uplink()` 交付前校验每个上行项的编解码器。 */
    readonly codec: TypertCodec
  }
  /** 在业务参数之后注入的传输取消，而非进入传输线参数。 */
  readonly cancellation?: {
    /** 预留的最后的 Host 方法参数。 */
    readonly parameter: 'signal'
  }
  /** 一元结果或每个产出的流项的编解码器。 */
  readonly result: TypertCodec
  /** 源拥有的方法文档；普通方法不必有 JSDoc。 */
  readonly description?: string
  /** 仅用于诊断的源声明。 */
  readonly sourceLocation?: InvocationSourceLocation
}

/**
 * 一个 Peer 的不透明身份：由连接层准许进入此 Host 的一方。"Peer" 是
 * 连接层的用语；浏览器应用保留 "Client" 一词。
 */
export type PeerId = Branded<'PeerId'>

/**
 * 可合并扩展的调用方身份。每个驱动声明各自的条目。每个条目是一个带有
 * 唯一字面量 `kind` 的 JSON 值，不携带任何凭据，且可安全持久化进 Session 日志。
 */
export interface PrincipalMap {
  /** 拥有此 Host 的本地用户。 */
  owner: { readonly kind: 'owner' }
}

/** 一个调用方身份；授权层只读此。 */
export type Principal = PrincipalMap[keyof PrincipalMap]

/**
 * 一个 Peer 在此 Host 上的会话。其创建者拥有它：`ctx` 是拥有连接生命周期
 * 注册、并随 Peer 一起释放的 Cordis 作用域，而 `principal` 是 Peer 创建时
 * 固定的调用方身份。
 */
export interface PeerScope {
  readonly id: PeerId
  /** 连接生命周期注册；随 Peer 一起释放。 */
  readonly ctx: Context
  /** 由进程内 Host 代码在创建时固定、传输线上任何字段都无法设置的调用方身份。 */
  readonly principal: Principal
  /** Peer 被释放后立即中止；代表该 Peer 的 Remote 流随之结束。 */
  readonly signal: AbortSignal
  /** Peer 是否能开启转发事件流；这不授予业务权限。 */
  readonly interactions: 'answer' | 'none'
  /**
   * 拆除通过 `ctx` 完成的所有注册。
   * @returns 在作用域静止后结算；竞态调用共享一次完成。
   */
  dispose(): Promise<void>
}

/** 一个逻辑流缓冲上行帧的载体容量。 */
export interface RemoteUplinkWindow {
  /** 等待 Host 消费者的最大完整编码帧字节数。 */
  readonly maxBytes: number
  /** 为带有 present value 字段的紧凑 JSON 项添加的 UTF-8 信封字节数。 */
  readonly frameOverheadBytes: number
}

/**
 * 一次 Remote 调用的上下文，可在接收方法内部作为 `this.ctx.invocation` 访问。
 * Gateway 从携带它的 Context 派生接收方，因此不注入任何参数，也没有任何内容穿越传输线。
 */
export interface RemoteInvocation {
  readonly request: {
    readonly namespace: string
    readonly method: string
    readonly args: Readonly<Record<string, unknown>>
  }
  /** 接收服务的 Cordis 服务键。 */
  readonly service: string
  /** 调用所代表的 Peer；每个载体都显式命名它。 */
  readonly peer: PeerScope
  /** 载体取消：Client 取消、套接字关闭或上行失败。 */
  readonly signal: AbortSignal
  /** 载体帧容量；当载体不施加编码帧收件箱限制时缺省。 */
  readonly uplinkWindow?: RemoteUplinkWindow | undefined
  /**
   * 本次调用的 Client 上行项。仅可用一次；第二次调用会抛出。当描述符上带有
   * 上行编解码器时，每个项都被解码为 `In`；否则在经过 JSON 安全性检查后
   * 以 `unknown` 形式到达。迭代在 Client 结束其上行时结束；当方法完成其下行时，
   * Gateway 调用迭代器的 `return()`，未读项被丢弃。`In` 是调用方的断言：
   * 运行时按描述符解码，并不交叉校验它。
   * @template In - 调用方读取的项类型；由描述符编解码器决定实际到达的内容。
   * @returns 单消费者上行可迭代对象。
   */
  uplink<In = unknown>(): AsyncIterable<In>
}

/** 由 Client 装配显式选定的、生成的 Host 契约。 */
export interface TypertRemoteContribution {
  /** 拥有 Remote 方法的 npm 包。 */
  readonly package: string
  /** 从该包生成的、消费端调用描述符。 */
  readonly descriptors: readonly InvocationDescriptor[]
}

/** 一个 Remote 值的、生成的解析器与可选的无损工具 schema 投影。 */
export interface TypertRemoteValue<Value = unknown> {
  /** 在不加载拥有服务的情况下实例化生成的解析器。 */
  readonly create: () => TypertSchema<Value>
  /** 源拥有的取值文档，独立于工具投影支持。 */
  readonly description?: string | undefined
  /** 当该值可在不丢失约束的情况下表示于工具 schema 子集时存在；可惰性派生。 */
  readonly jsonSchema?: Readonly<Record<string, unknown>> | undefined
  /** 需要 JSON Schema 的消费者遇到的投影失败；解析仍可用。 */
  readonly jsonSchemaError?: string | undefined
}

/** 消费者拥有的输入校验；从不改变 Host 分发或业务方法声明。 */
export interface TypertRemoteInputOptions {
  /** 拒绝输入对象中未声明的字段；显式字典与 JSON 值仍保持开放。 */
  readonly strict?: boolean
}

/** 一个直连描述符；DecodedOutput 与解析器输出仅在载体重建的一元字节上不同。 */
export type TypertRemoteMethod<Input extends object, Output, Mode extends 'unary' | 'stream' = 'unary', Uplink = never, DecodedOutput = Output> =
  Omit<InvocationDescriptor, 'mode' | 'invocation' | 'result'>
  & (Mode extends 'stream' ? { readonly mode: 'stream' } : { readonly mode?: never }) & {
    /** Named invocation selects a direct Service method, not a Context receiver. */
    readonly invocation: { readonly kind: 'direct' }
    /**
     * 在不改变分发的前提下，选择匹配的具名输入解析与工具 schema 投影。
     * @param options - 消费者拥有的严格度；缺省时保持普通 Remote 对象处理。
     * @returns 本策略的缓存视图；其解析器与投影仍保持惰性。
     */
    input(options?: TypertRemoteInputOptions): TypertRemoteValue<Input>
    /** 描述符的一元结果或流项解析器；仅解析不会规范化原生字节后备。 */
    readonly result: Extract<TypertCodec<Output>, { readonly mode: 'strict' }>
    /**
     * 以具名传输线参数调用已挂载的命名空间方法。
     * @param remote - 调用方拥有的、无作用域的 Client Remote 服务；其挂载决定可用性。
     * @param input - 已解码的具名传输线参数。
     * @param signal - 调用方拥有的调用生命周期。
     * @returns 载体解码的一元结果或完整的流句柄，包括上行与释放。
     */
    invoke(remote: TypertClientRemote, input: Input, signal?: AbortSignal): Mode extends 'stream'
      ? RemoteStreamHandle<Output, Uplink>
      : Promise<RemoteResult<DecodedOutput>>
  }

/** 普通贡献，其方法索引引用其直连调用描述符。 */
export interface TypertRemoteInfo<Methods extends Readonly<Record<string,
  TypertRemoteMethod<object, unknown> | TypertRemoteMethod<object, unknown, 'stream', unknown>
>> = Readonly<Record<string, TypertRemoteMethod<object, unknown> | TypertRemoteMethod<object, unknown, 'stream', unknown>>>>
  extends TypertRemoteContribution {
  /** Exact generated keys and types; Context-only receivers are available only through descriptors. */
  readonly methods: Methods
}

/** 一个调用值的、生成的 Zod 工厂与可选工具投影。 */
export interface TypertRemoteCodecSpec extends Omit<Extract<TypertCodec, { readonly mode: 'strict' }>, 'create'> {
  /** 仅在请求解析器时实例化生成的 Zod schema。 */
  readonly create: () => ZodType
}

/** 一个有序参数；省略的传输线名解析为源参数名。 */
export interface TypertRemoteParameterSpec extends Omit<InvocationParameterDescriptor, 'wire' | 'codec'> {
  /** Explicit wire alias, notably for a Host lookup identity. */
  readonly wire?: string
  /** Ordinary Remote parser and projection for this parameter. */
  readonly codec: TypertRemoteCodecSpec
  /** Consumer-selected counterpart rejecting undeclared fields in explicit input objects. */
  readonly strictCodec: TypertRemoteCodecSpec
}

/** 静态方法事实；端点身份与具名调用辅助由运行时工厂派生。 */
export interface TypertRemoteMethodSpec extends Omit<InvocationDescriptor, 'id' | 'namespace' | 'method' | 'parameters' | 'result'> {
  /** Ordered Host parameters, including their wire representations. */
  readonly parameters: readonly TypertRemoteParameterSpec[]
  /** Successful unary result or stream item, with optional native-byte handling. */
  readonly result: TypertRemoteCodecSpec
}

/** 由编译器产出、与服务、注册和传输无关的方法定义。 */
export interface TypertRemoteSpec {
  /** Package owning these methods. */
  readonly package: string
  /** Public endpoints; each method's invocation facts occur only once. */
  readonly methods: Readonly<Record<`${string}/${string}`, TypertRemoteMethodSpec>>
}

/** 由 Gateway 实现、并被 Remote 装配消费的 Client Remote 能力。 */
export interface TypertClientRemote extends TypertRemoteNamespaceMap {
  /**
   * 在调用方的 fiber 中挂载一个生成的、面向 Client 的 Host 贡献。
   * @param contribution - 显式选定的 Remote 包产物。
   * @returns 命名空间服务与具体方法就绪后的释放器。
   */
  $mount(contribution: TypertRemoteContribution): Promise<TypertDisposer>
  /**
   * 订阅一个转发的 Host 事件。通知按注册顺序运行并隔离失败；限定的瀑布
   * 返回、通过 `next()` 委托，或 reject Host 分发。
   * @template Event - 由 Host 装配选定的转发事件名。
   * @param event - 转发的 Host 事件名，在传输线上不变。
   * @param listener - 接收 Cordis `Events` 声明的 Client 投影。
   * @returns 由调用 fiber 拥有的释放器。
   */
  $on<Event extends TypertRemoteEvent>(event: Event, listener: TypertClientEventListener<Event>): () => void
}

/**
 * Resolve one validated wire identity, synchronously or asynchronously.
 * @param id - validated wire identity.
 * @returns the Host object, or `undefined` when unavailable.
 */
export type TypertLookupResolver<Host = unknown, Wire = unknown> = (
  id: Wire,
) => Host | undefined | Promise<Host | undefined>

/** 身份类型为传输线身份的资源种类；对类型擦除的提供方则为每一种类。 */
type TypertResourceKindFor<Wire> = unknown extends Wire
  ? TypertResourceKind
  : { [Kind in TypertResourceKind]: [Wire] extends [TypertResourceId<TypertResourceMap[Kind]>] ? Kind : never }[TypertResourceKind]

/** 一个已声明 Host 对象 lookup 的运行时提供方。 */
export interface TypertLookupProvider<Host = unknown, Wire = unknown> {
  /** SRC 弱解析器识别的源参数名。 */
  readonly parameter: string
  /** 替换 Host 对象参数的传输线字段。 */
  readonly wire: string
  /** 传输线身份命名的资源种类；此 lookup 的一个参数携带该资源。 */
  readonly resource?: TypertResourceKindFor<Wire>
  /** 严格生成使用的规范 Host 类型符号。 */
  readonly hostTypeSymbol: string
  /** 严格生成使用的规范传输线类型符号。 */
  readonly wireTypeSymbol: string
  /**
   * 通过提供方的默认策略解析一个传输线身份。
   * @param id - 已校验的传输线身份。
   * @returns 对象，不可用时为 `undefined`，或异步地返回其中之一。
   */
  resolve(id: Wire): Host | undefined | Promise<Host | undefined>
}

/** 在 lookup 提供方卸载后保留的稳定传输线声明。 */
export interface TypertLookupDefinition {
  /** 合并声明的 lookup 键。 */
  readonly key: string
  /** SRC 弱解析器识别的源参数名。 */
  readonly parameter: string
  /** 替换 Host 对象参数的传输线字段。 */
  readonly wire: string
  /** 严格生成使用的规范 Host 类型符号。 */
  readonly hostTypeSymbol: string
  /** 严格生成使用的规范传输线类型符号。 */
  readonly wireTypeSymbol: string
}

/** 用于严格 Remote 方法的、Host 传输线到 Context 的解析器与声明。 */
export interface TypertHostContextAdapter<Wire = unknown> {
  /** 携带 Context 身份的传输线字段。 */
  readonly wire: string
  /** 严格生成使用的规范传输线类型符号。 */
  readonly wireTypeSymbol: string
  /** 传输线身份命名的资源种类；限定到该 Context 的调用携带该资源。 */
  readonly resource?: TypertResourceKindFor<Wire>
  /**
   * 将一个已校验的传输线身份解析为存活的 Host Context。
   * @param id - 已校验的传输线身份。
   * @returns Context，不可用时为 `undefined`。
   */
  resolve(id: Wire): Context | undefined | Promise<Context | undefined>
}

/** 替换某个 Host Context 适配器默认 lookup 策略的、组合拥有的解析器。 */
export type TypertHostContextResolver<Wire = unknown> = (
  id: Wire,
) => Context | undefined | Promise<Context | undefined>

/** 客户端双向 Context 适配器。 */
export interface TypertClientContextAdapter<Wire = unknown> {
  /**
   * 读取一个存活 Client Context 所代表的身份。
   * @param ctx - 由限定 Remote 调用方检查的 Client Context。
   * @returns 传输线身份，或为另一个 Context 种类的 `undefined`。
   */
  identity(ctx: Context): Wire | undefined
  /**
   * 为一次 Client 调用同步解析一个已校验的身份。
   * @param id - 已校验的传输线身份。
   * @returns 借用的或调用拥有的 Client Context，不可用时为 undefined。
   */
  resolve(id: Wire): Context | TypertOwnedValue<Context> | undefined
}

/** Typert 运行时注册发生变化后发出的通知。 */
export interface TypertRegistryChange {
  readonly kind: 'local' | 'remote' | 'lookup' | 'host-context' | 'client-context' | 'resource'
  readonly key: string
}

/** 一个 Typert 运行时注册表的监听器。 */
export type TypertRegistryListener = (change: TypertRegistryChange) => void

/** 当前环境的调用定义。 */
export interface TypertLocalRegistry {
  /**
   * 按 `<namespace>/<method>` 查找一个调用。
   * @param endpoint - 规范端点。
   * @returns 存活的描述符，缺省时为 `undefined`。
   */
  get(endpoint: string): InvocationDescriptor | undefined
  /**
   * 报告在当前 Typert Service 生命周期内是否曾存在某个严格定义。
   * @param endpoint - 规范端点。
   * @returns 端点至少注册过一次（即便已撤回）后为 `true`。
   */
  hasSeen(endpoint: string): boolean
  /** @returns 本地描述符的注册顺序快照。 */
  list(): readonly InvocationDescriptor[]
  /**
   * 观察后续的本地定义变化。
   * @param listener - 同步的、受控的观测者。
   * @returns 本订阅的释放器。
   */
  subscribe(listener: TypertRegistryListener): TypertDisposer
}

/** 消费者选定的 Remote 贡献注册表。 */
export interface TypertRemoteRegistry {
  /**
   * 为调用的 Cordis fiber 注册一个生成的贡献。
   * @param contribution - 生成的 Remote 描述符。
   * @returns 撤回该确切贡献的释放器。
   */
  register(contribution: TypertRemoteContribution): TypertDisposer
  /**
   * 按端点查找一个 Remote 描述符。
   * @param endpoint - 规范端点。
   * @returns 描述符，未挂载时为 `undefined`。
   */
  get(endpoint: string): InvocationDescriptor | undefined
  /** @returns Remote 描述符的注册顺序快照。 */
  list(): readonly InvocationDescriptor[]
  /**
   * 观察后续的 Remote 贡献变化。
   * @param listener - 同步的、受控的观测者。
   * @returns 本订阅的释放器。
   */
  subscribe(listener: TypertRegistryListener): TypertDisposer
}

/** Host 对象 lookup 提供方的运行时注册表。 */
export interface TypertLookupRegistry {
  /**
   * 在其合并声明的键下注册一个提供方。
   * @param key - lookup 键。
   * @param provider - 拥有包的活动解析器。
   * @returns 撤回该确切提供方的释放器。
   */
  register<K extends StringKeyOf<TypertLookupMap>>(
    key: K,
    provider: TypertLookupProvider<
      TypertLookupHost<TypertLookupMap[K]>,
      TypertLookupWire<TypertLookupMap[K]>
    >,
  ): TypertDisposer
  /**
   * 在本贡献处于活动期间，替换某个提供方的默认解析策略。
   * 配置可能先于提供方注册；没有活动提供方时 `get()` 仍不可用。
   * @param key - 其传输线声明仍由提供方拥有的 lookup 键。
   * @param resolver - 被该键的每次 lookup 使用的、组合拥有的解析器。
   * @returns 恢复提供方默认解析器的释放器。
   */
  configure<K extends StringKeyOf<TypertLookupMap>>(
    key: K,
    resolver: TypertLookupResolver<
      TypertLookupHost<TypertLookupMap[K]>,
      TypertLookupWire<TypertLookupMap[K]>
    >,
  ): TypertDisposer
  /**
   * 按运行时键查找一个提供方。
   * @param key - 描述符 lookup 键。
   * @returns 活动的提供方，缺省时为 `undefined`。
   */
  get(key: string): TypertLookupProvider | undefined
  /** @returns 在当前 Typert Service 生命周期内观察到的 lookup 声明。 */
  definitions(): readonly TypertLookupDefinition[]
  /** @returns 已注册提供方键的快照。 */
  keys(): readonly string[]
  /**
   * 观察后续的 lookup 变化。
   * @param listener - 同步的、受控的观测者。
   * @returns 本订阅的释放器。
   */
  subscribe(listener: TypertRegistryListener): TypertDisposer
}

/** 每个 Context 种类的 Host 与 Client 适配器的运行时注册表。 */
export interface TypertContextRegistry {
  /**
   * 注册一个 Host Context 适配器。
   * @param key - 合并声明的 Context 键。
   * @param adapter - 拥有包的 Host 解析器与传输线声明。
   * @returns 撤回该确切适配器的释放器。
   */
  registerHost<K extends StringKeyOf<TypertContextMap>>(
    key: K,
    adapter: TypertHostContextAdapter<TypertContextWire<TypertContextMap[K]>>,
  ): TypertDisposer
  /**
   * 为调用的 fiber 覆盖某个 Host Context 键的解析策略。
   * 配置可先于提供方注册，并在释放时恢复提供方的默认解析器。
   * @param key - 合并声明的 Context 键。
   * @param resolver - 被该键的每次 Host Context lookup 使用的、组合拥有的解析器。
   * @returns 恢复提供方默认解析器的释放器。
   */
  configureHost<K extends StringKeyOf<TypertContextMap>>(
    key: K,
    resolver: TypertHostContextResolver<TypertContextWire<TypertContextMap[K]>>,
  ): TypertDisposer
  /**
   * 注册一个 Client Context 适配器。
   * @param key - 合并声明的 Context 键。
   * @param adapter - 拥有包的双向 Client 投影。
   * @returns 撤回该确切适配器的释放器。
   */
  registerClient<K extends StringKeyOf<TypertContextMap>>(
    key: K,
    adapter: TypertClientContextAdapter<TypertContextWire<TypertContextMap[K]>>,
  ): TypertDisposer
  /**
   * 查找一个 Host Context 适配器；已配置的解析器保留适配器的声明与 `resource`。
   * @param key - 描述符 Context 键。
   * @returns 适配器，缺省时为 `undefined`。
   */
  getHost(key: string): TypertHostContextAdapter | undefined
  /**
   * 查找一个 Client Context 适配器。
   * @param key - 描述符 Context 键。
   * @returns 适配器，缺省时为 `undefined`。
   */
  getClient(key: string): TypertClientContextAdapter | undefined
  /**
   * 观察后续的 Context 适配器变化。
   * @param listener - 同步的、受控的观测者。
   * @returns 本订阅的释放器。
   */
  subscribe(listener: TypertRegistryListener): TypertDisposer
}

/** 一个资源种类的默认传输线字段。 */
export interface TypertResourceDeclaration {
  /** 持有该种类一个身份的最顶层或首个对象传输线字段。 */
  readonly field: string
}

/** 一个已注册的资源种类及其默认传输线字段。 */
export interface TypertResourceEntry extends TypertResourceDeclaration {
  /** 已注册的资源种类。 */
  readonly kind: string
}

/** 资源种类默认传输线字段的运行时注册表。 */
export interface TypertResourceRegistry {
  /**
   * 为调用的 fiber 注册一个种类的默认传输线字段。只有拥有该种类的
   * 领域才会注册它。
   * @param kind - 合并声明的资源种类。
   * @param declaration - 该种类的默认传输线字段。
   * @returns 撤回该确切注册的释放器。
   * @throws Error 当该种类已注册或是内置资源种类 `global` 时。
   */
  register(kind: TypertResourceKind, declaration: TypertResourceDeclaration): TypertDisposer
  /**
   * 查找一个种类的声明。
   * @param kind - 资源种类。
   * @returns 活动的声明，未注册时为 `undefined`。
   */
  get(kind: string): TypertResourceDeclaration | undefined
  /** @returns 已注册种类及其字段的注册顺序快照。 */
  entries(): readonly TypertResourceEntry[]
  /**
   * 观察后续的资源种类变化。
   * @param listener - 同步的、受控的观测者。
   * @returns 本订阅的释放器。
   */
  subscribe(listener: TypertRegistryListener): TypertDisposer
}

/** 通过依赖倒置消费的最简 Typert 运行时。 */
export interface TypertRegistryContract {
  readonly local: TypertLocalRegistry
  readonly remotes: TypertRemoteRegistry
  readonly lookups: TypertLookupRegistry
  readonly contexts: TypertContextRegistry
  readonly resources: TypertResourceRegistry
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    typert: TypertRegistryContract
    /**
     * 此 Context 为之派生的 Remote 调用，或未被任何 Remote 调用派生时的
     * `undefined`。服务方法将其读作 `this.ctx.invocation`。
     */
    readonly invocation: RemoteInvocation | undefined
  }
}
