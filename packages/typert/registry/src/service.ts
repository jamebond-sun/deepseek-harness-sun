/**
 * 用于生成的 Typert 反射、Remote 调用，以及依赖倒置的 lookup/Context
 * 提供方的运行时注册表。它不进行任何 TypeScript 分析或 schema 生成。
 * @module @deepseek-ai/dsh-typert-registry
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type {
  InvocationDescriptor,
  RemoteAccessResourceKind,
  TypertClientContextAdapter,
  TypertContextMap,
  TypertContextRegistry,
  TypertContextWire,
  TypertDisposer,
  TypertHostContextAdapter,
  TypertHostContextResolver,
  TypertResourceDeclaration,
  TypertResourceRegistry,
  TypertLocalRegistry,
  TypertLookupHost,
  TypertLookupDefinition,
  TypertLookupMap,
  TypertLookupProvider,
  TypertLookupResolver,
  TypertLookupRegistry,
  TypertLookupWire,
  TypertRemoteContribution,
  TypertRemoteRegistry,
  TypertRegistryChange,
  TypertRegistryListener,
  TypertRegistryContract,
} from '@deepseek-ai/dsh-typert-protocol'
import type {
  TypertContribution,
  TypertFace,
  TypertPackageFilter,
  TypertPackageRecord,
  TypertSchemaFactory,
  TypertSchemaFilter,
  TypertSchemaRecord,
} from './types.ts'

/**
 * 组合一个生成 schema 的全局键。
 * @param packageName - 贡献的 npm 包。
 * @param name - schema 导出名。
 * @returns `<package>#<name>`。
 */
export function typertKey(packageName: string, name: string): string {
  return `${packageName}#${name}`
}

/**
 * 组合一个包端模型的身份。
 * @param packageName - 贡献的 npm 包。
 * @param face - 彼此独立编译的端。
 * @returns `<package>#<face>`。
 */
export function typertPackageKey(packageName: string, face: TypertFace): string {
  return `${packageName}#${face}`
}

/**
 * 组合本地与 Remote 调用注册表所用的端点键。
 * @param descriptor - 其命名空间与方法构成端点的调用。
 * @returns `<namespace>/<method>`。
 */
export function typertEndpoint(descriptor: Pick<InvocationDescriptor, 'namespace' | 'method'>): string {
  return `${descriptor.namespace}/${descriptor.method}`
}

interface DescriptorEntry {
  readonly descriptor: InvocationDescriptor
  readonly owner: object
}

interface ProviderEntry<Provider> {
  readonly provider: Provider
  readonly owner: object
}

type ReportObserverError = (change: TypertRegistryChange, error: unknown) => void

class ChangeSource {
  private readonly listeners = new Set<TypertRegistryListener>()

  constructor(private readonly report: ReportObserverError) {}

  subscribe(ctx: Context, listener: TypertRegistryListener): TypertDisposer {
    const { listeners } = this
    return ctx.effect(function* () {
      listeners.add(listener)
      yield () => { listeners.delete(listener) }
    }, 'typert registry subscription')
  }

  emit(change: TypertRegistryChange): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(change)
      } catch (error) {
        this.report(change, error)
      }
    }
  }
}

class DescriptorStore {
  private readonly entries = new Map<string, DescriptorEntry>()
  private readonly ids = new Map<string, DescriptorEntry>()
  private readonly history = new Set<string>()
  private readonly changes: ChangeSource

  constructor(
    private readonly kind: 'local' | 'remote',
    report: ReportObserverError,
  ) {
    this.changes = new ChangeSource(report)
  }

  validate(descriptors: readonly InvocationDescriptor[]): void {
    const endpoints = new Set<string>()
    const ids = new Set<string>()
    for (const descriptor of descriptors) {
      validateInvocation(descriptor)
      const endpoint = typertEndpoint(descriptor)
      if (endpoints.has(endpoint) || this.entries.has(endpoint)) {
        throw new Error(`typert: ${this.kind} endpoint "${endpoint}" is already registered`)
      }
      if (ids.has(descriptor.id) || this.ids.has(descriptor.id)) {
        throw new Error(`typert: ${this.kind} invocation id "${descriptor.id}" is already registered`)
      }
      endpoints.add(endpoint)
      ids.add(descriptor.id)
    }
  }

  commit(owner: object, descriptors: readonly InvocationDescriptor[]): void {
    for (const descriptor of descriptors) {
      const entry = { descriptor, owner }
      const endpoint = typertEndpoint(descriptor)
      this.entries.set(endpoint, entry)
      this.ids.set(descriptor.id, entry)
      this.history.add(endpoint)
    }
    for (const descriptor of descriptors) {
      this.changes.emit({ kind: this.kind, key: typertEndpoint(descriptor) })
    }
  }

  withdraw(owner: object, descriptors: readonly InvocationDescriptor[]): void {
    const removed: string[] = []
    for (const descriptor of descriptors) {
      const endpoint = typertEndpoint(descriptor)
      const entry = this.entries.get(endpoint)
      /* v8 ignore next -- 重复的注册会被拒绝，因此在它的 effect 释放之前，不会有后续的属主替换这一条目。 */
      if (entry?.owner !== owner) continue
      this.entries.delete(endpoint)
      /* v8 ignore next -- id 与端点在同一个唯一属主下一起提交与撤销。 */
      if (this.ids.get(descriptor.id) === entry) this.ids.delete(descriptor.id)
      removed.push(endpoint)
    }
    for (const endpoint of removed) this.changes.emit({ kind: this.kind, key: endpoint })
  }

  get(endpoint: string): InvocationDescriptor | undefined {
    return this.entries.get(endpoint)?.descriptor
  }

  hasSeen(endpoint: string): boolean {
    return this.history.has(endpoint)
  }

  list(): readonly InvocationDescriptor[] {
    return [...this.entries.values()].map(entry => entry.descriptor)
  }

  subscribe(ctx: Context, listener: TypertRegistryListener): TypertDisposer {
    return this.changes.subscribe(ctx, listener)
  }
}

class RemoteStore {
  private readonly packages = new Map<string, object>()

  constructor(private readonly descriptors: DescriptorStore) {}

  view(ctx: Context): TypertRemoteRegistry {
    return {
      register: contribution => this.register(ctx, contribution),
      get: endpoint => this.descriptors.get(endpoint),
      list: () => this.descriptors.list(),
      subscribe: listener => this.descriptors.subscribe(ctx, listener),
    }
  }

  private register(ctx: Context, contribution: TypertRemoteContribution): TypertDisposer {
    validateSegment('Remote package name', contribution.package)
    if (this.packages.has(contribution.package)) {
      throw new Error(`typert: Remote package "${contribution.package}" is already registered`)
    }
    this.descriptors.validate(contribution.descriptors)
    const owner = {}
    const { packages, descriptors } = this
    return ctx.effect(function* () {
      packages.set(contribution.package, owner)
      descriptors.commit(owner, contribution.descriptors)
      yield () => {
        /* v8 ignore else -- 重复的包注册会被拒绝，因此这一 effect 始终是包的唯一属主。 */
        if (packages.get(contribution.package) === owner) packages.delete(contribution.package)
        descriptors.withdraw(owner, contribution.descriptors)
      }
    }, `typert.remotes.register(${JSON.stringify(contribution.package)})`)
  }
}

class LookupStore {
  private readonly providers = new Map<string, ProviderEntry<TypertLookupProvider>>()
  private readonly resolvers = new Map<string, ProviderEntry<LookupResolverEntry>>()
  private readonly definitions = new Map<string, TypertLookupDefinition>()
  private readonly changes: ChangeSource

  constructor(report: ReportObserverError) {
    this.changes = new ChangeSource(report)
  }

  view(ctx: Context): TypertLookupRegistry {
    return {
      register: <K extends Extract<keyof TypertLookupMap, string>>(
        key: K,
        provider: TypertLookupProvider<
          TypertLookupHost<TypertLookupMap[K]>,
          TypertLookupWire<TypertLookupMap[K]>
        >,
      ) => this.register(ctx, key, provider),
      configure: <K extends Extract<keyof TypertLookupMap, string>>(
        key: K,
        resolver: TypertLookupResolver<
          TypertLookupHost<TypertLookupMap[K]>,
          TypertLookupWire<TypertLookupMap[K]>
        >,
      ) => this.configure(ctx, key, resolver),
      get: key => this.get(key),
      definitions: () => [...this.definitions.values()],
      keys: () => [...this.providers.keys()],
      subscribe: listener => this.changes.subscribe(ctx, listener),
    }
  }

  private get(key: string): TypertLookupProvider | undefined {
    const provider = this.providers.get(key)?.provider
    if (provider === undefined) return undefined
    const resolver = this.resolvers.get(key)?.provider
    if (resolver === undefined) return provider
    return {
      parameter: provider.parameter,
      wire: provider.wire,
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- 领域包会把资源种类合并进 TypertResourceMap。
      ...provider.resource === undefined ? {} : { resource: provider.resource },
      hostTypeSymbol: provider.hostTypeSymbol,
      wireTypeSymbol: provider.wireTypeSymbol,
      resolve: id => resolver.resolve(id),
    }
  }

  private configure<Host, Wire>(
    ctx: Context,
    key: string,
    resolver: TypertLookupResolver<Host, Wire>,
  ): TypertDisposer {
    validateSegment('lookup key', key)
    if (this.resolvers.has(key)) throw new Error(`typert: lookup "${key}" resolver is already configured`)
    const owner = {}
    // 该映射擦除了每个合并声明的 Wire 类型；仅在带类型的
    // configure() 边界处恢复它，以维持严格函数变型的健全性。
    const entry: ProviderEntry<LookupResolverEntry> = {
      provider: { resolve: async id => resolver(id as Wire) },
      owner,
    }
    const { resolvers, changes } = this
    return ctx.effect(function* () {
      resolvers.set(key, entry)
      changes.emit({ kind: 'lookup', key })
      yield () => {
        /* v8 ignore next -- 重复的配置会被拒绝，因此这一 effect 始终是键的唯一属主。 */
        if (resolvers.get(key) !== entry) return
        resolvers.delete(key)
        changes.emit({ kind: 'lookup', key })
      }
    }, `typert.lookups.configure(${JSON.stringify(key)})`)
  }

  private register<Host, Wire>(ctx: Context, key: string, provider: TypertLookupProvider<Host, Wire>): TypertDisposer {
    validateSegment('lookup key', key)
    validateSegment('lookup parameter', provider.parameter)
    validateWireName('lookup wire field', provider.wire)
    validateNonempty('lookup Host type symbol', provider.hostTypeSymbol)
    validateNonempty('lookup wire type symbol', provider.wireTypeSymbol)
    if (this.providers.has(key)) throw new Error(`typert: lookup "${key}" is already registered`)
    const definition: TypertLookupDefinition = {
      key,
      parameter: provider.parameter,
      wire: provider.wire,
      hostTypeSymbol: provider.hostTypeSymbol,
      wireTypeSymbol: provider.wireTypeSymbol,
    }
    const known = this.definitions.get(key)
    if (known !== undefined && !lookupDefinitionEquals(known, definition)) {
      throw new Error(`typert: lookup "${key}" changed its wire declaration during this registry lifetime`)
    }
    const owner = {}
    const entry: ProviderEntry<TypertLookupProvider> = { provider, owner }
    const { definitions, providers, changes } = this
    return ctx.effect(function* () {
      definitions.set(key, definition)
      providers.set(key, entry)
      changes.emit({ kind: 'lookup', key })
      yield () => {
        /* v8 ignore next -- 重复的注册会被拒绝，因此这一 effect 始终是键的唯一属主。 */
        if (providers.get(key) !== entry) return
        providers.delete(key)
        changes.emit({ kind: 'lookup', key })
      }
    }, `typert.lookups.register(${JSON.stringify(key)})`)
  }
}

interface LookupResolverEntry {
  resolve(id: unknown): Promise<unknown>
}

function lookupDefinitionEquals(left: TypertLookupDefinition, right: TypertLookupDefinition): boolean {
  return left.parameter === right.parameter
    && left.wire === right.wire
    && left.hostTypeSymbol === right.hostTypeSymbol
    && left.wireTypeSymbol === right.wireTypeSymbol
}

class ContextStore {
  private readonly hosts = new Map<string, ProviderEntry<TypertHostContextAdapter>>()
  private readonly hostResolvers = new Map<string, ProviderEntry<HostContextResolverEntry>>()
  private readonly clients = new Map<string, ProviderEntry<TypertClientContextAdapter>>()
  private readonly changes: ChangeSource

  constructor(report: ReportObserverError) {
    this.changes = new ChangeSource(report)
  }

  view(ctx: Context): TypertContextRegistry {
    return {
      registerHost: <K extends Extract<keyof TypertContextMap, string>>(
        key: K,
        adapter: TypertHostContextAdapter<TypertContextWire<TypertContextMap[K]>>,
      ) => this.registerHost(ctx, key, adapter),
      configureHost: <K extends Extract<keyof TypertContextMap, string>>(
        key: K,
        resolver: TypertHostContextResolver<TypertContextWire<TypertContextMap[K]>>,
      ) => this.configureHost(ctx, key, resolver),
      registerClient: <K extends Extract<keyof TypertContextMap, string>>(
        key: K,
        adapter: TypertClientContextAdapter<TypertContextWire<TypertContextMap[K]>>,
      ) => this.registerClient(ctx, key, adapter),
      getHost: key => this.getHost(key),
      getClient: key => this.clients.get(key)?.provider,
      subscribe: listener => this.changes.subscribe(ctx, listener),
    }
  }

  private getHost(key: string): TypertHostContextAdapter | undefined {
    const adapter = this.hosts.get(key)?.provider
    if (adapter === undefined) return undefined
    const resolver = this.hostResolvers.get(key)?.provider
    if (resolver === undefined) return adapter
    return {
      wire: adapter.wire,
      wireTypeSymbol: adapter.wireTypeSymbol,
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- 领域包会把资源种类合并进 TypertResourceMap。
      ...adapter.resource === undefined ? {} : { resource: adapter.resource },
      resolve: id => resolver.resolve(id),
    }
  }

  private configureHost<Wire>(
    ctx: Context,
    key: string,
    resolver: TypertHostContextResolver<Wire>,
  ): TypertDisposer {
    validateSegment('Context key', key)
    if (this.hostResolvers.has(key)) throw new Error(`typert: host-context "${key}" resolver is already configured`)
    const entry: ProviderEntry<HostContextResolverEntry> = {
      provider: { resolve: async id => resolver(id as Wire) },
      owner: {},
    }
    const { hostResolvers, changes } = this
    return ctx.effect(function* () {
      hostResolvers.set(key, entry)
      changes.emit({ kind: 'host-context', key })
      yield () => {
        /* v8 ignore next -- 重复的配置会被拒绝，因此这一 effect 始终是键的唯一属主。 */
        if (hostResolvers.get(key) !== entry) return
        hostResolvers.delete(key)
        changes.emit({ kind: 'host-context', key })
      }
    }, `typert.contexts.configureHost(${JSON.stringify(key)})`)
  }

  private registerHost<Wire>(ctx: Context, key: string, adapter: TypertHostContextAdapter<Wire>): TypertDisposer {
    validateSegment('Context key', key)
    validateWireName('Context wire field', adapter.wire)
    validateNonempty('Context wire type symbol', adapter.wireTypeSymbol)
    return this.registerProvider(ctx, this.hosts, 'host-context', key, adapter)
  }

  private registerClient<Wire>(ctx: Context, key: string, adapter: TypertClientContextAdapter<Wire>): TypertDisposer {
    validateSegment('Context key', key)
    return this.registerProvider(ctx, this.clients, 'client-context', key, adapter)
  }

  private registerProvider<Provider>(
    ctx: Context,
    table: Map<string, ProviderEntry<Provider>>,
    kind: 'host-context' | 'client-context',
    key: string,
    provider: Provider,
  ): TypertDisposer {
    if (table.has(key)) throw new Error(`typert: ${kind} provider "${key}" is already registered`)
    const entry: ProviderEntry<Provider> = { provider, owner: {} }
    const { changes } = this
    return ctx.effect(function* () {
      table.set(key, entry)
      changes.emit({ kind, key })
      yield () => {
        /* v8 ignore next -- 重复的注册会被拒绝，因此这一 effect 始终是键的唯一属主。 */
        if (table.get(key) !== entry) return
        table.delete(key)
        changes.emit({ kind, key })
      }
    }, `typert.contexts.register(${JSON.stringify(key)})`)
  }
}

interface HostContextResolverEntry {
  resolve(id: unknown): Promise<Context | undefined>
}

/** 内置的、无身份的资源种类；任何已声明的资源种类都不得使用此名。 */
const GLOBAL_RESOURCE_KIND = 'global' satisfies RemoteAccessResourceKind

class ResourceStore {
  private readonly declarations = new Map<string, ProviderEntry<TypertResourceDeclaration>>()
  private readonly changes: ChangeSource

  constructor(report: ReportObserverError) {
    this.changes = new ChangeSource(report)
  }

  view(ctx: Context): TypertResourceRegistry {
    return {
      register: (kind, declaration) => this.register(ctx, kind, declaration),
      get: kind => this.declarations.get(kind)?.provider,
      entries: () => [...this.declarations].map(([kind, entry]) => Object.freeze({ kind, field: entry.provider.field })),
      subscribe: listener => this.changes.subscribe(ctx, listener),
    }
  }

  private register(ctx: Context, kind: string, declaration: TypertResourceDeclaration): TypertDisposer {
    validateSegment('resource kind', kind)
    if (kind === GLOBAL_RESOURCE_KIND) {
      throw new Error(`typert: resource kind "${GLOBAL_RESOURCE_KIND}" is reserved for the built-in global resource`)
    }
    validateWireName('resource field', declaration.field)
    if (this.declarations.has(kind)) throw new Error(`typert: resource kind "${kind}" is already registered`)
    const entry: ProviderEntry<TypertResourceDeclaration> = { provider: { field: declaration.field }, owner: {} }
    const { declarations, changes } = this
    return ctx.effect(function* () {
      declarations.set(kind, entry)
      changes.emit({ kind: 'resource', key: kind })
      yield () => {
        /* v8 ignore next -- 重复的注册会被拒绝，因此这一 effect 始终是种类的唯一属主。 */
        if (declarations.get(kind) !== entry) return
        declarations.delete(kind)
        changes.emit({ kind: 'resource', key: kind })
      }
    }, `typert.resources.register(${JSON.stringify(kind)})`)
  }
}

/**
 * 生成 schema、包反射、调用以及 Remote 依赖提供方的注册表。
 * @typert service typert
 */
export class TypertRegistry extends Service implements TypertRegistryContract {
  private readonly schemas = new Map<string, TypertSchemaFactoryRecord>()
  private readonly packages = new Map<string, TypertPackageRecord>()
  private readonly localStore: DescriptorStore
  private readonly remoteStore: RemoteStore
  private readonly lookupStore: LookupStore
  private readonly contextStore: ContextStore
  private readonly resourceStore: ResourceStore

  constructor(ctx: Context) {
    super(ctx, 'typert')
    const report: ReportObserverError = (change, error) => {
      ctx.logger.warn(`typert: ${change.kind} observer for "${change.key}" failed`)
      ctx.logger.warn(error)
    }
    this.localStore = new DescriptorStore('local', report)
    this.remoteStore = new RemoteStore(new DescriptorStore('remote', report))
    this.lookupStore = new LookupStore(report)
    this.contextStore = new ContextStore(report)
    this.resourceStore = new ResourceStore(report)
  }

  /** 当前环境的调用定义。 */
  get local(): TypertLocalRegistry {
    const ctx = this.ctx
    return {
      get: endpoint => this.localStore.get(endpoint),
      hasSeen: endpoint => this.localStore.hasSeen(endpoint),
      list: () => this.localStore.list(),
      subscribe: listener => this.localStore.subscribe(ctx, listener),
    }
  }

  /** 消费者选定的 Remote 定义。 */
  get remotes(): TypertRemoteRegistry {
    return this.remoteStore.view(this.ctx)
  }

  /** Host 对象 lookup 提供方。 */
  get lookups(): TypertLookupRegistry {
    return this.lookupStore.view(this.ctx)
  }

  /** Host 与 Client 的 Context 适配器。 */
  get contexts(): TypertContextRegistry {
    return this.contextStore.view(this.ctx)
  }

  /** 资源种类的默认传输线字段。 */
  get resources(): TypertResourceRegistry {
    return this.resourceStore.view(this.ctx)
  }

  /**
   * 为调用的 fiber 原子地注册一个生成的贡献。
   * 重复的包端身份、schema、调用 id 或端点会拒绝整批。
   * @param contribution - 生成的 schema、反射与 Host 调用。
   * @returns 移除本贡献的确切 effect 释放器。
   */
  register(contribution: TypertContribution): TypertDisposer {
    const packageRecord = this.validatePackage(contribution)
    const schemaRecords = this.validateSchemas(contribution)
    const invocations = contribution.invocations
    this.localStore.validate(invocations)
    const owner = {}
    const { schemas, packages, localStore } = this
    return this.ctx.effect(function* () {
      packages.set(packageRecord.key, packageRecord)
      for (const record of schemaRecords) schemas.set(record.key, record)
      localStore.commit(owner, invocations)
      yield () => {
        /* v8 ignore else -- 重复的包端注册会被拒绝，因此这一 effect 始终是它的唯一属主。 */
        if (packages.get(packageRecord.key) === packageRecord) packages.delete(packageRecord.key)
        for (const record of schemaRecords) {
          /* v8 ignore else -- 重复的 schema 注册会被拒绝，因此这一贡献始终是每条记录的唯一属主。 */
          if (schemas.get(record.key) === record) schemas.delete(record.key)
        }
        localStore.withdraw(owner, invocations)
      }
    }, 'typert.register()')
  }

  /**
   * 按 `<package>#<name>` 查找一个 schema。
   * @param key - 全局 schema 键。
   * @returns 包含缓存 schema 的记录，缺省时为 `undefined`。
   */
  get(key: string): TypertSchemaRecord | undefined {
    const record = this.schemas.get(key)
    return record === undefined ? undefined : materializeSchema(record)
  }

  /**
   * 解析一个必需的 schema。
   * @param key - 全局 schema 键。
   * @returns 包含缓存 schema 的记录。
   * @throws 当键格式错误、包端缺失，或 schema 未被贡献时。
   */
  resolve(key: string): TypertSchemaRecord {
    const record = this.schemas.get(key)
    if (record !== undefined) return materializeSchema(record)
    const hash = key.indexOf('#')
    if (hash <= 0 || hash === key.length - 1) {
      throw new Error(`typert: invalid schema key "${key}" — expected "<package>#<name>"`)
    }
    const packageName = key.slice(0, hash)
    if ([...this.packages.values()].some(candidate => candidate.package === packageName)) {
      throw new Error(
        `typert: cannot resolve "${key}" — package "${packageName}" is registered but contributes no schema named "${key.slice(hash + 1)}"`,
      )
    }
    throw new Error(`typert: cannot resolve "${key}" — package "${packageName}" has no registered contribution`)
  }

  /**
   * 按注册顺序枚举存活的 schema。
   * @param filter - 可选的包与端限制。
   * @returns 包含缓存 schema 的匹配记录。
   */
  list(filter: TypertSchemaFilter = {}): TypertSchemaRecord[] {
    return [...this.schemas.values()].filter(record => matches(record, filter)).map(materializeSchema)
  }

  /**
   * 查找一个包端生成的反射。
   * @param packageName - 精确的 npm 包名。
   * @param face - 要查询的端；默认为 host 运行时。
   * @returns 存活的包记录，缺省时为 `undefined`。
   */
  getPackage(packageName: string, face: TypertFace = 'host'): TypertPackageRecord | undefined {
    return this.packages.get(typertPackageKey(packageName, face))
  }

  /**
   * 按注册顺序枚举生成的包反射。
   * @param filter - 可选的包与端限制。
   * @returns 匹配的包记录。
   */
  listPackages(filter: TypertPackageFilter = {}): TypertPackageRecord[] {
    return [...this.packages.values()].filter(record => matches(record, filter))
  }

  /**
   * 将存活的 Zod schema 投影为 JSON Schema，且不缓存结果。
   * @param key - 全局 schema 键。
   * @param params - Zod 投影参数。
   * @returns 一份全新的 JSON Schema 文档。
   */
  toJSONSchema(key: string, params?: z.core.ToJSONSchemaParams): z.core.JSONSchema.BaseSchema {
    return z.toJSONSchema(this.resolve(key).schema, params)
  }

  private validatePackage(contribution: TypertContribution): TypertPackageRecord {
    validateSegment('package name', contribution.package)
    const face: unknown = contribution.face
    if (face !== 'host' && face !== 'client') {
      throw new Error(`typert: invalid face ${JSON.stringify(face)} — expected "host" or "client"`)
    }
    const key = typertPackageKey(contribution.package, contribution.face)
    if (this.packages.has(key)) {
      throw new Error(`typert: package face "${key}" is already registered`)
    }
    return {
      package: contribution.package,
      face,
      key,
      model: contribution.model,
    }
  }

  private validateSchemas(contribution: TypertContribution): TypertSchemaFactoryRecord[] {
    const records: TypertSchemaFactoryRecord[] = []
    const batch = new Set<string>()
    for (const schema of contribution.schemas) {
      validateSegment('schema name', schema.name)
      if (typeof schema.create !== 'function') {
        throw new Error(`typert: schema "${schema.name}" has no create() factory`)
      }
      const key = typertKey(contribution.package, schema.name)
      if (batch.has(key) || this.schemas.has(key)) {
        throw new Error(`typert: schema "${key}" is already registered`)
      }
      batch.add(key)
      records.push({
        ...schema,
        package: contribution.package,
        face: contribution.face,
        key,
      })
    }
    return records
  }
}

interface TypertSchemaFactoryRecord extends TypertSchemaFactory {
  readonly package: string
  readonly face: TypertFace
  readonly key: string
  value?: z.ZodType
}

function materializeSchema(record: TypertSchemaFactoryRecord): TypertSchemaRecord {
  const schema = record.value ??= record.create()
  return {
    name: record.name,
    schema,
    package: record.package,
    face: record.face,
    key: record.key,
  }
}

function matches(
  record: { readonly package: string; readonly face: TypertFace },
  filter: { readonly package?: string; readonly face?: TypertFace },
): boolean {
  return (filter.package === undefined || record.package === filter.package)
    && (filter.face === undefined || record.face === filter.face)
}

function validateInvocation(descriptor: InvocationDescriptor): void {
  validateNonempty('invocation id', descriptor.id)
  validateSegment('invocation service key', descriptor.service)
  validateWireName('invocation namespace', descriptor.namespace)
  validateWireName('invocation method', descriptor.method)
  if (descriptor.implementation !== undefined) {
    validateWireName('invocation implementation method', descriptor.implementation)
  }
  validateCodec(descriptor.result, `${descriptor.id} result`)
  const wires = new Set<string>()
  for (const parameter of descriptor.parameters) {
    validateWireName('parameter name', parameter.name)
    validateWireName('parameter wire field', parameter.wire)
    if (wires.has(parameter.wire)) {
      throw new Error(`typert: invocation "${descriptor.id}" repeats wire field "${parameter.wire}"`)
    }
    wires.add(parameter.wire)
    if (parameter.source === 'lookup') {
      if (parameter.acceptsUndefined !== undefined) {
        throw new Error(`typert: invocation "${descriptor.id}" lookup parameter "${parameter.name}" cannot accept undefined`)
      }
      if (parameter.lookup === undefined) {
        throw new Error(`typert: invocation "${descriptor.id}" lookup parameter "${parameter.name}" has no lookup key`)
      }
      validateSegment('lookup key', parameter.lookup)
    } else if (parameter.lookup !== undefined) {
      throw new Error(`typert: invocation "${descriptor.id}" JSON parameter "${parameter.name}" declares a lookup key`)
    }
    validateCodec(parameter.codec, `${descriptor.id} parameter ${parameter.name}`)
  }
  const cancellation = descriptor.cancellation as { readonly parameter: string } | undefined
  if (cancellation !== undefined && cancellation.parameter !== 'signal') {
    throw new Error(`typert: invocation "${descriptor.id}" cancellation parameter must be "signal"`)
  }
  const mode = descriptor.mode as string | undefined
  if (mode !== undefined && mode !== 'stream') {
    throw new Error(`typert: invocation "${descriptor.id}" mode must be "stream"`)
  }
  if (descriptor.uplink !== undefined) validateCodec(descriptor.uplink.codec, `${descriptor.id} uplink`)
  if (descriptor.scope !== undefined) {
    if (descriptor.invocation.kind !== 'direct') {
      throw new Error(`typert: invocation "${descriptor.id}" Context receiver cannot declare a direct scope projection`)
    }
    validateSegment('scope Context key', descriptor.scope.context)
    validateWireName('scope wire field', descriptor.scope.wire)
    const lookups = descriptor.parameters.filter(candidate => candidate.source === 'lookup')
    const parameter = lookups.length === 1 ? lookups[0] : undefined
    if (parameter === undefined || parameter.wire !== descriptor.scope.wire
      || parameter.lookup !== descriptor.scope.context) {
      throw new Error(
        `typert: invocation "${descriptor.id}" scope wire "${descriptor.scope.wire}" must select its only lookup parameter`,
      )
    }
  }
  if (descriptor.invocation.kind === 'context') {
    validateSegment('Context key', descriptor.invocation.context)
    validateWireName('Context wire field', descriptor.invocation.wire)
    if (wires.has(descriptor.invocation.wire)) {
      throw new Error(`typert: invocation "${descriptor.id}" repeats wire field "${descriptor.invocation.wire}"`)
    }
    validateCodec(descriptor.invocation.codec, `${descriptor.id} Context`)
  }
}

function validateCodec(codec: InvocationDescriptor['result'], subject: string): void {
  if (codec.mode === 'src-json') return
  validateNonempty(`${subject} type symbol`, codec.typeSymbol)
  if (typeof codec.create !== 'function') {
    throw new Error(`typert: ${subject} strict codec has no create() factory`)
  }
}

function validateWireName(subject: string, value: string): void {
  if (value === '.' || value === '..' || !/^[A-Za-z0-9_$.-]+$/.test(value)) {
    throw new Error(`typert: invalid ${subject} "${value}" — must contain only RPC endpoint segment characters`)
  }
}

function validateSegment(subject: string, value: string): void {
  if (value.length === 0 || value.includes('#')) {
    throw new Error(`typert: invalid ${subject} "${value}" — must be nonempty and must not contain "#"`)
  }
}

function validateNonempty(subject: string, value: string): void {
  if (value.length === 0) throw new Error(`typert: invalid ${subject} — must be nonempty`)
}

export default TypertRegistry
