/**
 * 生成的 Typert Remote 描述符的 Client 投影。贡献安装可追踪的
 * `remote.<namespace>` 服务；方法查找、调用或类型暴露均不经过
 * JavaScript Proxy。
 */

import { Service } from '@deepseek-ai/cordis'
import { RemoteError, isRemoteUplinkItem, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
export type { TypertGatewayFaultDetails } from '../remote-error-codes.ts'
import type { Context } from '@deepseek-ai/cordis'
import type {
  ConnectionHandle,
} from '@deepseek-ai/dsh-client-connection/client'
import type {
  InvocationDescriptor,
  TypertClientEventListener,
  TypertClientRemote,
  RemoteFailure,
  RemoteResult,
  RemoteStreamHandle,
  TypertCodec,
  TypertDisposer,
  TypertRemoteContribution,
  TypertRemoteEvent,
} from '@deepseek-ai/dsh-typert-protocol'
import {
  ClientUplinkQueue,
  RemoteStreamCarrierError,
  RemoteStreamMuxClient,
} from './stream-client.ts'
import { ClientRemoteEvents } from './remote-events.ts'
import {
  RemoteStream,
  type RemoteStreamOptions,
} from './remote-stream.ts'

export { RemoteStreamCarrierError } from './stream-client.ts'
export { RemoteJournalStream } from './journal-stream.ts'
export type {
  RemoteJournalChange,
  RemoteJournalFrame,
  RemoteJournalStreamOptions,
  RemoteStreamFactory,
} from './journal-stream.ts'
export { RemoteStream } from './remote-stream.ts'
export type { RemoteStreamItem, RemoteStreamOptions } from './remote-stream.ts'
export { RemoteSnapshotStream } from './snapshot-stream.ts'
export type { RemoteSnapshotStreamOptions } from './snapshot-stream.ts'

interface MountToken {
  active: boolean
  readonly abort: AbortController
}

interface ScopedProjection {
  readonly context: string
  readonly wire: string
  readonly parameterIndex?: number
}

interface DirectMethod {
  readonly descriptor: InvocationDescriptor
  readonly token: MountToken
}

interface ScopedMethod extends DirectMethod {
  readonly projection: ScopedProjection
}

interface RemoteMethodRecord {
  direct?: DirectMethod
  scoped?: ScopedMethod
}

interface BoundContextIdentity {
  readonly value: unknown
}

interface PreparedClientInvocation {
  readonly endpoint: string
  readonly args: Readonly<Record<string, unknown>>
  readonly signal: AbortSignal
}

interface RemoteNamespaceHandle {
  readonly service: RemoteNamespaceService
  readonly dispose: TypertDisposer
}

interface LoaderReadiness {
  await(): Promise<unknown>
}

/** 一个描述符已挂载的变体，供组释放器逐一撤销。 */
interface InstalledMethod {
  readonly descriptor: InvocationDescriptor
  readonly token: MountToken
  direct: boolean
  scoped: boolean
}

/** 由生成的直接命名空间与 Gateway 流监督增强的类型化 Remote 服务。 */
export interface ClientRemote extends TypertClientRemote {
  /**
   * 创建一个可独立取消、可重连的逻辑流。
   * 需要 interactions=answer；被动 Client 使用生成的流方法。
   * @param options - 领域自有的打开器与代结束分类。
   * @returns 一个标注了物理代 id 的单消费方流。
   */
  $stream<Item>(options: RemoteStreamOptions<Item>): RemoteStream<Item>
  /**
   * 作为普通读取的固定 Host 事实：无存储、无订阅、
   * 无代计数器。`home` 在首个就绪帧之前保持 undefined，
   * 之后反映最新的一个。
   */
  readonly $host: RemoteHostFacts
}

/** 暴露在 `ctx.remote.$host` 上的固定 Host 事实。 */
export interface RemoteHostFacts {
  /** 来自就绪帧的 Host 主目录，在此之前为 undefined。 */
  readonly home: string | undefined
  /** 载体是否连接到本地 Host。 */
  readonly isLoopback: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 由 Client 组装选定的生成 Remote 命名空间。 */
    remote: ClientRemote
  }
}

/** 必需的 Client 服务：Typert 注册表与现有的 Connection 载体。 */
export const inject = ['typert', 'connection']

/**
 * 安装类型化的 Client Remote 服务。
 * @param ctx - Client Cordis 根。
 */
export function apply(ctx: Context): void {
  new ClientRemoteService(ctx)
}

class ClientRemoteService extends Service implements ClientRemote {
  private readonly ownerCtx: Context
  private readonly connection: ConnectionHandle
  private readonly namespaces = new Map<string, RemoteNamespaceHandle>()
  private hostFacts: RemoteHostFacts | undefined
  private readonly streams: RemoteStreamMuxClient
  private readonly events: ClientRemoteEvents | undefined
  private mutations = Promise.resolve()

  constructor(ctx: Context) {
    super(ctx, 'remote')
    this.ownerCtx = ctx
    const connection = ctx.get('connection') as ConnectionHandle
    this.connection = connection
    this.streams = new RemoteStreamMuxClient(
      path => connection.openWebSocket(path),
      connection.interactions === 'answer',
    )
    if (connection.interactions === 'answer') {
      this.events = new ClientRemoteEvents(
        ctx,
        connection,
        (endpoint, payload, signal) => this.openRemoteStream(endpoint, payload, signal),
      )
    }
    // 即使 API 调用方不接收事件，也保留一个生命周期套接字。
    // HTTP 分发从不等待这次独立的连接尝试。
    if (connection.rpc.open === undefined) this.streams.start()
    let disposed = false
    let loop: ReturnType<ConnectionHandle['start']> | undefined
    const start = (): void => {
      if (disposed || connection.interactions === 'none') return
      if (connection.rpc.open === undefined) this.streams.start()
      loop = connection.start({
        onConnected: () => { this.ownerCtx.emit('connection/reset') },
        onReconnectRequested: () => {
          if (connection.rpc.open === undefined) this.streams.reconnect()
        },
      })
    }
    const loader = ctx.get('loader') as LoaderReadiness | undefined
    if (loader === undefined) start()
    else void loader.await().then(start, () => {})
    ctx.effect(() => async () => {
      disposed = true
      loop?.stop()
      await this.events?.dispose()
      await this.streams.close()
    }, 'api-gateway.client.transport')
  }

  $stream<Item>(options: RemoteStreamOptions<Item>): RemoteStream<Item> {
    if (this.connection.interactions === 'none') {
      throw new Error('client api: $stream requires interactions=answer; use a generated stream method')
    }
    return new RemoteStream(this.connection, options)
  }

  get $host(): RemoteHostFacts {
    // 身份稳定：读取方（useSyncExternalStore 快照、memo 输入）
    // 按引用比较，因此只有事实本身变化时才会铸造新对象。
    // isLoopback 在页面生命周期内固定不变。
    const home = this.connection.generation.getSnapshot()?.host.home
    if (this.hostFacts === undefined || this.hostFacts.home !== home) {
      this.hostFacts = { home, isLoopback: this.connection.isLoopback }
    }
    return this.hostFacts
  }

  async $mount(contribution: TypertRemoteContribution): ReturnType<TypertClientRemote['$mount']> {
    const callerCtx = this.ctx
    const owned = callerCtx.effect(async () => {
      const dispose = await this.enqueue(() => this.mountContribution(callerCtx, contribution))
      return () => this.enqueue(dispose)
    }, `api-gateway.client.$mount(${JSON.stringify(contribution.package)})`)
    await owned
    return async () => { await owned() }
  }

  $on<Event extends TypertRemoteEvent>(
    event: Event,
    listener: TypertClientEventListener<Event>,
  ): () => void {
    if (this.events === undefined) throw new Error('client api: forwarded events require interactions=answer')
    return this.events.subscribe(this.ctx, event, listener)
  }

  /** 打开一个 Remote 流，并规范化 worker 本地载体的结构性失败。 */
  private openRemoteStream(
    endpoint: string,
    payload: unknown,
    signal: AbortSignal,
    uplink?: AsyncIterable<unknown>,
    noConnection = `client api: ${endpoint} has no active Connection`,
  ): AsyncIterable<unknown> {
    const connection = this.ownerCtx.get('connection') as ConnectionHandle | undefined
    if (connection === undefined) throw new Error(noConnection)
    const local = connection.rpc.open?.('/api', endpoint, payload, signal, uplink)
    return local === undefined
      ? this.streams.open(endpoint, payload, signal, uplink)
      : normalizeConnectionStream(local)
  }

  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.mutations.then(operation, operation)
    this.mutations = result.then(() => undefined, () => undefined)
    return result
  }

  private async mountContribution(
    callerCtx: Context,
    contribution: TypertRemoteContribution,
  ): Promise<TypertDisposer> {
    this.validateContribution(contribution)
    const disposeRemote = callerCtx.typert.remotes.register(contribution)
    const groups = new Map<string, InvocationDescriptor[]>()
    for (const descriptor of contribution.descriptors) {
      const group = groups.get(descriptor.namespace)
      if (group === undefined) groups.set(descriptor.namespace, [descriptor])
      else group.push(descriptor)
    }
    const installed: TypertDisposer[] = []
    try {
      for (const [namespace, descriptors] of groups) {
        installed.push(await this.installNamespace(namespace, descriptors))
      }
    } catch (error) {
      for (const dispose of installed.reverse()) await dispose()
      await disposeRemote()
      throw error
    }
    return async () => {
      for (const dispose of installed.reverse()) await dispose()
      await disposeRemote()
    }
  }

  private validateContribution(contribution: TypertRemoteContribution): void {
    const direct = new Map<string, Set<string>>()
    const scoped = new Map<string, Set<string>>()
    const add = (
      table: Map<string, Set<string>>,
      descriptor: InvocationDescriptor,
      kind: 'direct' | 'scoped',
    ): void => {
      const methods = table.get(descriptor.namespace) ?? new Set<string>()
      if (methods.has(descriptor.method)) {
        throw new Error(`client api: contribution repeats ${kind} method ${endpointOf(descriptor)}`)
      }
      methods.add(descriptor.method)
      table.set(descriptor.namespace, methods)
      const namespace = this.namespaces.get(descriptor.namespace)?.service
      if (namespace?.has(kind, descriptor.method) === true) {
        throw new Error(`client api: ${kind} method ${endpointOf(descriptor)} is already mounted`)
      }
    }
    for (const descriptor of contribution.descriptors) {
      requireStrictInputs(descriptor)
      if (descriptor.invocation.kind === 'direct') add(direct, descriptor, 'direct')
      if (scopedProjection(descriptor) !== undefined) add(scoped, descriptor, 'scoped')
    }
    const namespaces = new Set([...direct.keys(), ...scoped.keys()])
    for (const namespace of namespaces) {
      const service = this.namespaces.get(namespace)?.service
      if (service === undefined) {
        if (namespace in this) {
          throw new Error(`client api: namespace ${JSON.stringify(namespace)} conflicts with the Remote service`)
        }
        const serviceKey = remoteServiceKey(namespace)
        const property = this.ownerCtx.reflect.props[serviceKey]
        if (property?.type === 'accessor' || this.ownerCtx.get(serviceKey) !== undefined) {
          throw new Error(`client api: namespace ${JSON.stringify(namespace)} conflicts with an existing Remote namespace`)
        }
      }
      for (const method of new Set([...(direct.get(namespace) ?? []), ...(scoped.get(namespace) ?? [])])) {
        if (service === undefined) RemoteNamespaceService.assertMethodAvailable(namespace, method)
        else service.assertMethodAvailable(method)
      }
    }
  }

  /**
   * 以无可见性间隙地挂载一个命名空间的描述符组：
   * 全新命名空间在其 fiber 的 apply 中同步安装整组，
   * 因此停在命名空间服务上的插件绝不会观察到缺少
   * 同一贡献所携带方法的它；已存在的命名空间则在
   * 一个同步步骤中接纳该组。
   * @param name - Remote 命名空间。
   * @param descriptors - 命名该命名空间的每个贡献描述符。
   * @returns 卸载该组并在清空后卸载命名空间的释放器。
   */
  private async installNamespace(
    name: string,
    descriptors: readonly InvocationDescriptor[],
  ): Promise<TypertDisposer> {
    let namespace = this.namespaces.get(name)
    let installed: InstalledMethod[]
    if (namespace === undefined) {
      ({ namespace, installed } = await this.createNamespace(name, descriptors))
    } else {
      installed = installMethods(namespace.service, descriptors)
    }
    const handle = namespace
    return async () => {
      for (const method of [...installed].reverse()) {
        /* v8 ignore next -- Cordis effect disposers are idempotent and invoke this cleanup at most once. */
        if (!method.token.active) continue
        method.token.active = false
        method.token.abort.abort()
        if (method.scoped) handle.service.remove('scoped', method.descriptor.method, method.token)
        if (method.direct) handle.service.remove('direct', method.descriptor.method, method.token)
      }
      await this.disposeNamespace(name, handle)
    }
  }

  private async createNamespace(
    name: string,
    descriptors: readonly InvocationDescriptor[],
  ): Promise<{ namespace: RemoteNamespaceHandle; installed: InstalledMethod[] }> {
    let service: RemoteNamespaceService | undefined
    let installed: InstalledMethod[] | undefined
    const fiber = this.ownerCtx.plugin({
      name: remoteServiceKey(name),
      apply: (ctx: Context) => {
        service = new RemoteNamespaceService(
          ctx,
          name,
          (direct, scoped, caller, args) => this.invokeMethod(direct, scoped, caller, args),
        )
        // 与服务注册相同的同步窗口：被新服务解除停靠的
        // 依赖项只会在方法存在之后运行。
        installed = installMethods(service, descriptors)
      },
    })
    try {
      await fiber
    } catch (error) {
      await fiber.dispose()
      throw error
    }
    /* v8 ignore next 3 -- a settled namespace fiber synchronously constructs its Service and installs the group. */
    if (service === undefined || installed === undefined) {
      throw new Error(`client api: namespace ${JSON.stringify(name)} did not start`)
    }
    const namespace = { service, dispose: fiber.dispose }
    this.namespaces.set(name, namespace)
    return { namespace, installed }
  }

  private async disposeNamespace(name: string, namespace: RemoteNamespaceHandle): Promise<void> {
    if (!namespace.service.empty || this.namespaces.get(name) !== namespace) return
    this.namespaces.delete(name)
    await namespace.dispose()
  }

  private invokeMethod(
    direct: DirectMethod | undefined,
    scoped: ScopedMethod | undefined,
    callerCtx: Context,
    values: readonly unknown[],
  ): Promise<RemoteResult<unknown>> | RemoteStreamHandle<unknown, unknown> {
    if (scoped !== undefined) {
      const adapter = this.ownerCtx.typert.contexts.getClient(scoped.projection.context)
      const identity = adapter?.identity(callerCtx)
      if (identity !== undefined) {
        return this.invokeSelected(
          scoped.descriptor,
          scoped.projection,
          scoped.token,
          callerCtx,
          values,
          { value: identity },
        )
      }
    }
    if (direct !== undefined) {
      return this.invokeSelected(direct.descriptor, undefined, direct.token, callerCtx, values)
    }
    if (scoped !== undefined) {
      return this.invokeSelected(scoped.descriptor, scoped.projection, scoped.token, callerCtx, values)
    }
    throw new Error('client api: Remote method is no longer mounted')
  }

  private invokeSelected(
    descriptor: InvocationDescriptor,
    projection: ScopedProjection | undefined,
    token: MountToken,
    callerCtx: Context,
    values: readonly unknown[],
    boundIdentity?: BoundContextIdentity,
  ): Promise<RemoteResult<unknown>> | RemoteStreamHandle<unknown, unknown> {
    if (descriptor.mode !== undefined) {
      return this.invokeStream(descriptor, projection, token, callerCtx, values, boundIdentity)
    }
    return this.invoke(descriptor, projection, token, callerCtx, values, boundIdentity)
  }

  private async invoke(
    descriptor: InvocationDescriptor,
    projection: ScopedProjection | undefined,
    token: MountToken,
    callerCtx: Context,
    values: readonly unknown[],
    boundIdentity?: BoundContextIdentity,
  ): Promise<RemoteResult<unknown>> {
    const endpoint = endpointOf(descriptor)
    if (!token.active) return withdrawn(endpoint)
    const prepared = this.prepareInvocation(descriptor, projection, token, callerCtx, values, boundIdentity)
    const connection = this.ownerCtx.get('connection') as ConnectionHandle | undefined
    if (connection === undefined) throw new Error(`client api: ${endpoint} has no active Connection`)
    try {
      const result = await connection.rpc.call('/api', endpoint, { args: prepared.args }, prepared.signal)
      if (!mountActive(token)) return withdrawn(endpoint)
      prepared.signal.throwIfAborted()
      if (!result.ok) return { ok: false, error: rebuiltFailure(result.error) }
      const value = descriptor.result.mode === 'strict' && descriptor.result.decode !== undefined
        ? descriptor.result.decode(result.value)
        : result.value
      return { ok: true, value }
    } catch (error) {
      // 载体抛出（离线或中止）是调用的结果而非组装故障，因此
      // 它们进入同一个错误分支。调用方中止的调用是一次取消，
      // 即使本地抛出在与线上往返的竞速中获胜也是如此，因此
      // 它获得 Host 本会产生的同一代码。
      if (prepared.signal.aborted) return cancelledFailure(endpoint, error)
      return carrierFailure(endpoint, error)
    }
  }

  /** 立即打开逻辑流并交回其句柄；首次读取之前的 `send()` 会排在 `open` 帧之后。 */
  private invokeStream(
    descriptor: InvocationDescriptor,
    projection: ScopedProjection | undefined,
    token: MountToken,
    callerCtx: Context,
    values: readonly unknown[],
    boundIdentity?: BoundContextIdentity,
  ): RemoteStreamHandle<unknown, unknown> {
    const endpoint = endpointOf(descriptor)
    if (!token.active) throw new Error(withdrawn(endpoint).error.message)
    const prepared = this.prepareInvocation(descriptor, projection, token, callerCtx, values, boundIdentity)
    const generation = new AbortController()
    const uplink = new ClientUplinkQueue(endpoint)
    const downlink = this.openRemoteStream(
      endpoint,
      { args: prepared.args },
      AbortSignal.any([prepared.signal, generation.signal]),
      uplink,
    )
    return new ClientStreamHandle(endpoint, downlink, uplink, generation, token)
  }

  private prepareInvocation(
    descriptor: InvocationDescriptor,
    projection: ScopedProjection | undefined,
    token: MountToken,
    callerCtx: Context,
    values: readonly unknown[],
    boundIdentity?: BoundContextIdentity,
  ): PreparedClientInvocation {
    const endpoint = endpointOf(descriptor)
    const expected = descriptor.parameters.length - (projection?.parameterIndex === undefined ? 0 : 1)
    const hasCallerSignal = descriptor.cancellation !== undefined && values.length === expected + 1
    if (values.length !== expected && !hasCallerSignal) {
      const contract = descriptor.cancellation === undefined
        ? `${String(expected)} argument(s)`
        : `${String(expected)} business argument(s) plus an optional AbortSignal`
      throw new Error(
        `client api: ${endpoint} expected ${contract}, got ${String(values.length)}`,
      )
    }
    const args = Object.create(null) as Record<string, unknown>
    if (projection !== undefined) {
      const adapter = boundIdentity === undefined
        ? this.ownerCtx.typert.contexts.getClient(projection.context)
        : undefined
      if (boundIdentity === undefined && adapter === undefined) {
        throw new Error(`client api: ${endpoint} has no Client Context adapter for ${JSON.stringify(projection.context)}`)
      }
      const identity = boundIdentity === undefined
        ? adapter?.identity(callerCtx)
        : boundIdentity.value
      if (identity === undefined) {
        throw new Error(`client api: ${endpoint} requires a ${JSON.stringify(projection.context)} Context`)
      }
      args[projection.wire] = identity
    }
    let valueIndex = 0
    descriptor.parameters.forEach((parameter, parameterIndex) => {
      if (parameterIndex === projection?.parameterIndex) return
      const value = values[valueIndex]
      if (value !== undefined) args[parameter.wire] = value
      valueIndex += 1
    })
    const callerSignal = hasCallerSignal ? values[expected] as AbortSignal | undefined : undefined
    const signal = callerSignal === undefined
      ? token.abort.signal
      : AbortSignal.any([token.abort.signal, callerSignal])
    return { endpoint, args, signal }
  }
}

/**
 * 生成的流方法返回的句柄：一个逻辑流的一个代。下行只被迭代
 * 一次；`send`/`end` 将条目送入载体泵抽干的上行队列；
 * `dispose` 中止该代并归还载体迭代器，除非已有终结帧抵达，
 * 它会发出 `cancel`、丢弃已缓冲的内容，
 * 并安静地结束迭代。
 */
class ClientStreamHandle implements RemoteStreamHandle<unknown, unknown> {
  private readonly downlink: AsyncIterator<unknown>
  private primed: Promise<IteratorResult<unknown>> | undefined
  private consumed = false
  private disposed = false

  constructor(
    private readonly endpoint: string,
    downlink: AsyncIterable<unknown>,
    private readonly uplink: ClientUplinkQueue,
    private readonly generation: AbortController,
    private readonly token: MountToken,
  ) {
    this.downlink = downlink[Symbol.asyncIterator]()
    // 载体在首次拉取时打开逻辑流；现在拉取会把 `open` 帧放到
    // 线上，先于任何 `send()`。首次读取保留给消费方，失败会等
    // 待它而不是在此处浮现；这也会终止流，因此队列关闭且
    // `send()` 抛出。
    this.primed = this.downlink.next()
    void this.primed.catch(() => { this.uplink.close() })
  }

  send(item: unknown): void {
    if (!isRemoteUplinkItem(item)) throw new Error(`client api: ${this.endpoint} uplink item is not a lossless JSON value`)
    this.uplink.push(item)
  }

  end(): void {
    this.uplink.end()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.uplink.close()
    this.generation.abort(new Error(`client api: ${this.endpoint} stream disposed`))
    // 归还载体迭代器会到达其 `finally`，即使没有人读取下行，
    // 因此 `cancel` 现在发出且泵停止。
    void Promise.resolve(this.downlink.return?.()).catch(() => undefined)
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    if (this.consumed) throw new Error(`client api: ${this.endpoint} stream has one consumer`)
    this.consumed = true
    const iteration = this.iterate()
    return {
      next: () => iteration.next(),
      // 首次读取之前的 return 会结束一个从未启动的生成器，因此其 `finally` 不会释放。
      return: (value?: unknown) => {
        this.dispose()
        return iteration.return(value)
      },
    }
  }

  private async *iterate(): AsyncGenerator {
    try {
      while (true) {
        const next = await (this.primed ?? this.downlink.next())
        this.primed = undefined
        if (this.disposed || next.done === true) return
        if (!mountActive(this.token)) throw new Error(withdrawn(this.endpoint).error.message)
        yield next.value
      }
    } catch (error) {
      if (this.disposed) return
      throw error
    } finally {
      // 提前结束就是一次释放；已终止的流不再接受上行。
      this.dispose()
      await this.downlink.return?.()
    }
  }
}

type InvokeRemote = (
  direct: DirectMethod | undefined,
  scoped: ScopedMethod | undefined,
  callerCtx: Context,
  args: readonly unknown[],
) => Promise<RemoteResult<unknown>> | RemoteStreamHandle<unknown, unknown>

class RemoteNamespaceService extends Service {
  private readonly methods = new Map<string, RemoteMethodRecord>()
  private readonly namespace: string

  static assertMethodAvailable(namespace: string, method: string): void {
    if (REMOTE_NAMESPACE_FIELDS.has(method) || method in RemoteNamespaceService.prototype) {
      throw new Error(`client api: method ${JSON.stringify(`${namespace}/${method}`)} conflicts with its namespace service`)
    }
  }

  constructor(
    ctx: Context,
    name: string,
    private readonly invokeRemote: InvokeRemote,
  ) {
    super(ctx, remoteServiceKey(name))
    this.namespace = name
  }

  assertMethodAvailable(method: string): void {
    RemoteNamespaceService.assertMethodAvailable(this.namespace, method)
    if (method in this && !this.methods.has(method)) {
      throw new Error(`client api: method ${JSON.stringify(`${this.namespace}/${method}`)} conflicts with its namespace service`)
    }
  }

  get empty(): boolean {
    return this.methods.size === 0
  }

  has(kind: 'direct' | 'scoped', method: string): boolean {
    return this.methods.get(method)?.[kind] !== undefined
  }

  installDirect(descriptor: InvocationDescriptor, token: MountToken): void {
    this.install(descriptor.method, 'direct', { descriptor, token })
  }

  installScoped(descriptor: InvocationDescriptor, projection: ScopedProjection, token: MountToken): void {
    this.install(descriptor.method, 'scoped', { descriptor, projection, token })
  }

  private install(method: string, kind: 'direct', value: DirectMethod): void
  private install(method: string, kind: 'scoped', value: ScopedMethod): void
  private install(method: string, kind: 'direct' | 'scoped', value: DirectMethod | ScopedMethod): void {
    this.assertMethodAvailable(method)
    let record = this.methods.get(method)
    const fresh = record === undefined
    record ??= {}
    if (fresh) {
      Object.defineProperty(this, method, {
        configurable: true,
        enumerable: true,
        get: function (this: RemoteNamespaceService): (...args: unknown[]) => unknown {
          const callerCtx = this.ctx
          const current = this.methods.get(method)
          const direct = current?.direct
          const scoped = current?.scoped
          return (...args: unknown[]) => {
            return this.invokeRemote(direct, scoped, callerCtx, args)
          }
        },
      })
      this.methods.set(method, record)
    }
    if (kind === 'direct') record.direct = value
    else record.scoped = value as ScopedMethod
  }

  remove(kind: 'direct' | 'scoped', method: string, token: MountToken): void {
    const record = this.methods.get(method)
    const current = record?.[kind]
    /* v8 ignore next -- duplicate live variants are rejected before installation, so no newer token can replace this one. */
    if (record === undefined || current?.token !== token) return
    if (kind === 'direct') delete record.direct
    else delete record.scoped
    if (record.direct !== undefined || record.scoped !== undefined) return
    this.methods.delete(method)
    Reflect.deleteProperty(this, method)
  }
}

/**
 * 在命名空间服务上安装一个描述符组，当某个描述符被拒绝时
 * 回退已安装的部分组。
 * @param service - 接收这些方法的命名空间服务。
 * @param descriptors - 一个贡献的描述符组。
 * @returns 供组释放器使用的逐描述符记录。
 */
function installMethods(
  service: RemoteNamespaceService,
  descriptors: readonly InvocationDescriptor[],
): InstalledMethod[] {
  const installed: InstalledMethod[] = []
  try {
    for (const descriptor of descriptors) {
      const method: InstalledMethod = {
        descriptor,
        token: { active: true, abort: new AbortController() },
        direct: false,
        scoped: false,
      }
      installed.push(method)
      if (descriptor.invocation.kind === 'direct') {
        service.installDirect(descriptor, method.token)
        method.direct = true
      }
      const projection = scopedProjection(descriptor)
      if (projection !== undefined) {
        service.installScoped(descriptor, projection, method.token)
        method.scoped = true
      }
    }
  } catch (error) {
    for (const method of [...installed].reverse()) {
      method.token.active = false
      method.token.abort.abort()
      if (method.scoped) service.remove('scoped', method.descriptor.method, method.token)
      if (method.direct) service.remove('direct', method.descriptor.method, method.token)
    }
    throw error
  }
  return installed
}

const REMOTE_NAMESPACE_FIELDS = new Set(['ctx', 'empty', 'invokeRemote', 'methods', 'name', 'namespace'])

function remoteServiceKey(namespace: string): string {
  return `remote.${namespace}`
}

function endpointOf(descriptor: Pick<InvocationDescriptor, 'namespace' | 'method'>): string {
  return `${descriptor.namespace}/${descriptor.method}`
}

function mountActive(token: MountToken): boolean {
  return token.active
}

function scopedProjection(descriptor: InvocationDescriptor): ScopedProjection | undefined {
  if (descriptor.invocation.kind === 'context') {
    return {
      context: descriptor.invocation.context,
      wire: descriptor.invocation.wire,
    }
  }
  if (descriptor.scope === undefined) return undefined
  const lookupParameters = descriptor.parameters
    .map((parameter, index) => ({ parameter, index }))
    .filter(candidate => candidate.parameter.source === 'lookup')
  const selected = lookupParameters.length === 1 ? lookupParameters[0] : undefined
  if (selected === undefined
    || selected.parameter.wire !== descriptor.scope.wire
    || selected.parameter.lookup !== descriptor.scope.context) {
    throw new Error(
      `client api: generated Remote ${endpointOf(descriptor)} scope must select its only lookup parameter`,
    )
  }
  return {
    context: descriptor.scope.context,
    wire: descriptor.scope.wire,
    parameterIndex: selected.index,
  }
}

function requireStrictInputs(descriptor: InvocationDescriptor): void {
  const endpoint = endpointOf(descriptor)
  for (const parameter of descriptor.parameters) {
    requireStrictCodec(parameter.codec, endpoint, parameter.wire)
  }
  if (descriptor.uplink !== undefined) requireStrictCodec(descriptor.uplink.codec, endpoint, 'uplink')
  if (descriptor.invocation.kind === 'context') {
    requireStrictCodec(descriptor.invocation.codec, endpoint, descriptor.invocation.wire)
  }
}

function requireStrictCodec(codec: TypertCodec, endpoint: string, field: string): void {
  if (codec.mode !== 'strict') {
    throw new Error(`client api: generated Remote ${endpoint} field ${JSON.stringify(field)} has no strict codec`)
  }
}

/** 命名空间在调用之前或期间已退役，因此不存在请求结果。 */
function withdrawn(endpoint: string): Extract<RemoteResult<never>, { readonly ok: false }> {
  return internalFailure(`client api: Remote method ${endpoint} is no longer mounted`)
}

/**
 * 载体抛出（离线、传输故障）折入的错误分支：`gateway/internal`
 * 命名端点与被抛出的消息。导出它使此 face 的替身可以同样折入。
 * @param endpoint - 被调用的 `<namespace>/<method>`。
 * @param error - 载体抛出的内容。
 * @returns 失败的结果。
 */
export function carrierFailure(endpoint: string, error: unknown): Extract<RemoteResult<never>, { readonly ok: false }> {
  return internalFailure(`client api: ${endpoint} failed: ${error instanceof Error ? error.message : String(error)}`)
}

/**
 * 被其调用方中止的调用折入的错误分支：`gateway/cancelled` 并以载体的抛出作为 `cause`。
 * @param endpoint - 被调用的 `<namespace>/<method>`。
 * @param cause - 信号中止时载体抛出的内容。
 * @returns 失败的结果。
 */
export function cancelledFailure(endpoint: string, cause: unknown): Extract<RemoteResult<never>, { readonly ok: false }> {
  return {
    ok: false,
    error: new RemoteError('gateway/cancelled', `client api: Remote invocation "${endpoint}" was aborted`, {}, { cause }),
  }
}

function internalFailure(message: string): Extract<RemoteResult<never>, { readonly ok: false }> {
  return { ok: false, error: new RemoteError('gateway/internal', message, {}) }
}

/**
 * 捕获的值是否为该 face 交付或抛出的 Remote 失败。
 * 唯一面向消费方的判别点：带标记的实例携带其 Host 代码；
 * 其余任何值都是调用方应任其崩溃的本地故障。
 * @param error - 捕获的值。
 * @returns 当值收窄为 RemoteFailure 时为 true。
 */
export function isRemoteFailure(error: unknown): error is RemoteFailure {
  return remoteErrorOf(error) !== undefined
}

/**
 * 将线上失败重建为本地 RemoteError 实例，使错误分支携带真正的
 * Error 且 `throw result.error` 保持 throw 语义。代码逐字透传而
 * 不做运行时校验：超出此 Client 合并映射之外的代码仍按原样
 * 浮现，因此较新的 Host 仍可被读取。
 */
function rebuiltFailure(error: { code: string; message: string; details: object }): RemoteFailure {
  return new RemoteError(error.code as never, error.message, error.details as never)
}

type MarkedConnectionStreamFailure = Error & {
  readonly dshRemoteStreamFailure?:
    | { readonly kind: 'remote'; readonly code: string; readonly details: object }
    | { readonly kind: 'carrier' }
}

/** 在 worker 传输单独打包的页面半侧之间保留 Gateway 错误类。 */
async function *normalizeConnectionStream(source: AsyncIterable<unknown>): AsyncGenerator {
  try {
    yield * source
  } catch (error) {
    if (!(error instanceof Error)) throw error
    const marker = (error as MarkedConnectionStreamFailure).dshRemoteStreamFailure
    if (marker?.kind === 'remote') {
      throw new RemoteError(marker.code as never, error.message, marker.details as never)
    }
    if (marker?.kind === 'carrier') {
      throw new RemoteStreamCarrierError(error.message, { cause: error })
    }
    throw error
  }
}
