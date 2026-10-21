/**
 * `ctx.lsp` 的通用 stdio 语言服务后端。一个插件实例配置一张具名的服务命令表，
 * 并为其中每一条目注册一个相互隔离的 provider。每个 provider 为每个规范工作区目标
 * 惰性单飞地启动一个服务端进程，通过它处理临时打开的查询，并在下一次只读查询之前或期间
 * 替换掉已失败的被选中传输。provider 通过 `ctx.fs` 读取源码、通过 `ctx.subprocess` 启动
 * 服务，因此本地与远程实现共享同一套宿主。
 *
 * 命名空间插件（具名导出，无默认导出）。生命周期由 effect 界定：
 * 销毁时会从 `ctx.lsp` 注销并拆除每一个存活的服务端。
 * @module @deepseek-ai/dsh-lsp-stdio
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LspError, LspProviderId } from '@deepseek-ai/dsh-lsp'
import type {
  LspProvider,
  LspProviderQuery,
  LspQueryResult,
} from '@deepseek-ai/dsh-lsp'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { abortable, abortError } from './abort.ts'
import { canonicalizeWorkspace, readHostSource } from './host.ts'
import type { HostWorkspace } from './host.ts'
import { LspInstance } from './instance.ts'
import type { ConnectionSpawner } from './connection.ts'
import type { InstanceSpec } from './instance.ts'

export { canonicalizeWorkspace, readHostSource } from './host.ts'
export { encodeMessage, MessageDecoder } from './framing.ts'
export {
  negotiatePositionEncoding,
  normalizeHover,
  normalizeLocations,
  requestMethod,
  supportsOperation,
  supportsTransientOpen,
} from './translate.ts'
export { LspInstance } from './instance.ts'
export { LspConnection } from './connection.ts'

/** 供加载器诊断使用的 Cordis 插件名。 */
export const name = 'lsp-stdio'

/** 本插件所需的服务。 */
export const inject = ['fs', 'lsp', 'subprocess']

const DEFAULT_MAX_MESSAGE_BYTES = 16_000_000
const DEFAULT_MAX_STDERR_BYTES = 1_000_000
const DEFAULT_MAX_DOCUMENT_BYTES = 4_000_000
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000
const DEFAULT_KILL_GRACE_MS = 2_000

/** 一个已配置的本地语言服务及其宿主边界。 */
export interface LspLocalServerConfig {
  /** 要启动的可执行文件（绝对路径，或在加载时按 PATH 解析）。 */
  command: string
  /** 小写的带前导点扩展名 → LSP 语言 id（例如 `{ '.ts': 'typescript' }`）。 */
  extensionToLanguage: Record<string, string>
  /** 传给可执行文件的参数（不经 shell）。默认 `[]`。 */
  args?: string[]
  /** 叠加在已清理的环境之上的额外环境变量。默认 `{}`。 */
  env?: Record<string, string>
  /** 转发给服务端的静态 `initialize` 选项。默认 `null`。 */
  initializationOptions?: unknown
  /** 对每一个 `workspace/configuration` 条目的静态应答。默认 `null`。 */
  configuration?: unknown
  /** 从服务端接受的单条分帧消息上限（字节）。默认 16000000。 */
  maxMessageBytes?: number
  /** 为诊断保留的 stderr 尾部上限（字节）。默认 1000000。 */
  maxStderrBytes?: number
  /** 本宿主会打开的源码文件上限（字节）。默认 4000000。 */
  maxDocumentBytes?: number
  /** 升级前的优雅 `shutdown`/`exit` 预算（毫秒）。默认 5000。 */
  shutdownTimeoutMs?: number
  /** 请求取消与 SIGTERM→SIGKILL 的宽限期（毫秒）。默认 2000。 */
  killGraceMs?: number
}

/** 插件配置：provider id → 本地语言服务配置。 */
export interface Config {
  /** 非空的“稳定 provider id → 各自独立的本地服务配置”表。 */
  servers: Record<string, LspLocalServerConfig>
}

/** schemastery 填充完所有默认值之后的一份服务配置。 */
type ResolvedServerConfig = Required<LspLocalServerConfig>
type WorkspaceKey = HostWorkspace['target']['targetKey']

const LspLocalServerConfig: z<LspLocalServerConfig> = z.object({
  command: z.string().required(),
  args: z.array(String).default([]),
  env: z.dict(String).default({}),
  extensionToLanguage: z.dict(String).required(),
  initializationOptions: z.any().default(null),
  configuration: z.any().default(null),
  maxMessageBytes: z.number().default(DEFAULT_MAX_MESSAGE_BYTES),
  maxStderrBytes: z.number().default(DEFAULT_MAX_STDERR_BYTES),
  maxDocumentBytes: z.number().default(DEFAULT_MAX_DOCUMENT_BYTES),
  shutdownTimeoutMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_SHUTDOWN_TIMEOUT_MS),
  killGraceMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_KILL_GRACE_MS),
})

export const Config: z<Config> = z.object({
  servers: z.dict(LspLocalServerConfig).required(),
})

/** 仅在每个兄弟项都落定之后才传播拆除失败。 */
function throwTeardownFailures(results: readonly PromiseSettledResult<void>[], message: string): void {
  const failures: unknown[] = []
  for (const result of results) {
    if (result.status === 'rejected') failures.push(result.reason)
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, message)
}

/**
 * 注册已配置的 stdio LSP provider。在发布任何 provider 之前，于加载时（凭据清理之后）
 * 解析每一个可执行文件；每个进程在其第一个匹配的查询上惰性启动。
 * @param ctx - 携带 `fs`、`lsp` 与 `subprocess` 的插件上下文。
 * @param config - 已解析的插件配置（schemastery 已填充全部默认值）。
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const entries = Object.entries(config.servers)
  if (entries.length === 0) throw new Error('lsp-stdio: servers must contain at least one server')

  const setupAbort = new AbortController()
  const stopSetupCancellation = ctx.on('internal/plugin', (fiber) => {
    // 异步插件回调必须在 Cordis 能够运行 effect 清理之前观察到自身的销毁，
    // 否则 unload 会一直等待这个回调。
    if (fiber === ctx.fiber && fiber.uid === null) {
      setupAbort.abort(new Error('lsp-stdio setup disposed'))
    }
  })

  // 在注册之前解析每一条服务本地设置，使后面出错的命令或边界无法让前面的 provider 被发布。
  // 注册表层面的映射冲突在下面回滚。
  const providers = await (async () => {
    const lookups = entries.map(async ([providerId, rawConfig]) => {
      if (providerId.trim() === '') throw new Error('lsp-stdio: server ids must be non-empty strings')
      const resolved = rawConfig as ResolvedServerConfig
      validateServerConfig(providerId, resolved)
      const executable = await ctx.subprocess.resolveExecutable(
        resolved.command,
        resolved.env,
        setupAbort.signal,
      )
      setupAbort.signal.throwIfAborted()
      return new LocalLspProvider(
        providerId,
        ctx.fs,
        resolved,
        executable,
        spec => ctx.subprocess.spawn(spec),
      )
    })
    try {
      return await Promise.all(lookups)
    } catch (error: unknown) {
      setupAbort.abort(error)
      await Promise.allSettled(lookups)
      throw error
    } finally {
      stopSetupCancellation()
    }
  })()

  ctx.effect(() => {
    const disposers: Array<() => void> = []
    try {
      for (const provider of providers) disposers.push(ctx.lsp.registerProvider(provider))
    } catch (error) {
      for (const dispose of disposers.reverse()) dispose()
      throw error
    }
    return async () => {
      // 在进程拆除之前移除每一条路由，使新的查询无法进入一个正在排空的 provider。
      for (const dispose of disposers.reverse()) dispose()
      const results = await Promise.allSettled(providers.map(provider => provider.disposeAll()))
      throwTeardownFailures(results, 'lsp-stdio provider teardown failed')
    }
  }, 'lsp-stdio.registerProviders')
}

/** 在表中任何 provider 被注册之前校验一条已解析的服务条目。 */
function validateServerConfig(providerId: string, resolved: ResolvedServerConfig): void {
  // 拆除预算会喂给 `deadline()`，其 `<= 0` 是内部的“无超时”哨兵；一个非正值
  // 会让一个忽略 shutdown 的服务端把销毁永久挂住。在加载时就失败。
  assertTimer(providerId, 'shutdownTimeoutMs', resolved.shutdownTimeoutMs)
  assertTimer(providerId, 'killGraceMs', resolved.killGraceMs)
  // 字节上限必须为正：非正的 stderr 上限会破坏保留尾部的约束
  // （`slice(-0)` 会保留全部内容），`maxMessageBytes: 0` 会让每个响应都变成致命错误，
  // 而一个错误的文档上限会推迟到读取路径才失败，而不是在加载时失败。
  assertPositiveInteger(providerId, 'maxStderrBytes', resolved.maxStderrBytes)
  assertPositiveInteger(providerId, 'maxMessageBytes', resolved.maxMessageBytes)
  assertPositiveInteger(providerId, 'maxDocumentBytes', resolved.maxDocumentBytes)
}

/** 拒绝 Node 会被钳制而非按配置调度的定时器取值。 */
function assertTimer(providerId: string, name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`lsp-stdio: servers.${providerId}.${name} must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}

/** 在加载时拒绝非正或非整数的配置值，使错误配置失败即报。 */
function assertPositiveInteger(providerId: string, name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`lsp-stdio: servers.${providerId}.${name} must be a positive integer`)
  }
}

/** 一个池化的通用 provider：每个规范工作区一个服务端进程，按需创建。 */
class LocalLspProvider implements LspProvider {
  readonly id: LspProviderId
  readonly extensionToLanguage: Readonly<Record<string, string>>
  /** 每个稳定的规范工作区身份对应一个存活实例。 */
  private readonly instances = new Map<WorkspaceKey, LspInstance>()
  /** 每个规范工作区一条完整的“读取源码→打开→查询→关闭”串行化尾部。 */
  private readonly queues = new Map<WorkspaceKey, Promise<void>>()
  /** 尚未进入 provider 自有队列的工作区规范化操作。 */
  private readonly workspaceLookups = new Set<Promise<void>>()
  private readonly lifetime = new AbortController()
  private disposed = false

  constructor(
    providerId: string,
    private readonly fs: Context['fs'],
    private readonly config: ResolvedServerConfig,
    private readonly executable: string,
    private readonly spawner: ConnectionSpawner,
  ) {
    this.id = LspProviderId(providerId)
    this.extensionToLanguage = config.extensionToLanguage
  }

  /** 通过一个方法读取销毁标志，使 `query()` 的 await 不会把它收窄为字面量。 */
  private isDisposed(): boolean {
    return this.disposed
  }

  /** 拒绝那些无法发布或使用 provider 自有实例的工作。 */
  private assertActive(signal?: AbortSignal): void {
    /* v8 ignore next -- 接缝会在销毁之前注销本 provider；直接的在途调用走的是 await 之后的检查。 */
    if (this.isDisposed()) throw new LspError('lsp-stdio provider is disposed', 'LSP_DISPOSED')
    if (signal?.aborted) throw abortError(signal)
  }

  /** 为每一次文件系统与协议 await 融合调用方取消与 provider 销毁。 */
  private querySignal(signal?: AbortSignal): AbortSignal {
    return signal === undefined
      ? this.lifetime.signal
      : AbortSignal.any([signal, this.lifetime.signal])
  }

  async query(request: LspProviderQuery, signal?: AbortSignal): Promise<LspQueryResult> {
    // 在任何 provider I/O 之前先尊重一个已中止的 signal，使被取消的请求永远不会启动服务端。
    this.assertActive(signal)
    const querySignal = this.querySignal(signal)
    const workspaceResult = canonicalizeWorkspace(this.fs, request.workspaceRoot, querySignal)
    const workspaceLookup = workspaceResult.then(() => undefined, () => undefined)
    this.workspaceLookups.add(workspaceLookup)
    let workspace: HostWorkspace
    try {
      workspace = await workspaceResult
    } finally {
      this.workspaceLookups.delete(workspaceLookup)
    }
    this.assertActive(querySignal)
    const workspaceKey = workspace.target.targetKey
    return this.enqueue(workspaceKey, querySignal, async () => {
      this.assertActive(querySignal)
      // 在读取源码时位于工作区队列之内、但在启动进程之前：排队的查询在自己的回合开始时
      // 看到当前字节，而非法的源码仍然不会让一个空闲进程留在池里。
      const source = await readHostSource(this.fs, request.filePath, workspace, this.config.maxDocumentBytes, querySignal)
      // 宿主 I/O 挂起期间，销毁可能已经快照了实例表。在同步的 get-or-create 之前重新检查，
      // 使每一个被启动的进程始终归属于拆除流程。
      this.assertActive(querySignal)
      let instance = this.instanceFor(workspaceKey, workspace)
      let canRetryTransport = true
      for (;;) {
        const [queryOutcome] = await Promise.allSettled([
          instance.query(request, source, querySignal),
        ])
        let teardownOutcome: PromiseSettledResult<void> | undefined
        if (instance.dead) {
          ;[teardownOutcome] = await Promise.allSettled([instance.dispose()])
          // 一个已死亡的实例绝不可复用，即使它最后的静止观察失败了。
          this.evictIfCurrent(workspaceKey, instance)
        }
        if (teardownOutcome?.status === 'rejected') {
          if (queryOutcome.status === 'rejected') {
            throw new AggregateError(
              [queryOutcome.reason, teardownOutcome.reason],
              'LSP operation and teardown failed',
            )
          }
          throw teardownOutcome.reason
        }
        if (queryOutcome.status === 'fulfilled') return queryOutcome.value
        // 一个被选中的子进程可能在空闲期间死亡，或在下一次写入时失败。查询是只读的，
        // 因此在干净地销毁之后替换该传输一次并透明重试。
        if (!canRetryTransport || !instance.isTransportFailure(queryOutcome.reason)) {
          throw queryOutcome.reason
        }
        canRetryTransport = false
        this.assertActive(querySignal)
        instance = this.instanceFor(workspaceKey, workspace)
      }
    })
  }

  /** 为一个规范工作区串行化一个完整的查询生命周期。 */
  private enqueue<T>(workspace: WorkspaceKey, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(workspace) ?? Promise.resolve()
    const result = abortable(previous, signal).then(run)
    // 即使本次调用方放弃等待，尾部也跟随真实的先前工作。它永不拒绝，
    // 因此后续调用方可以串行化，而不继承先前查询的结果。
    const tail = previous.then(() => result).then(() => undefined, () => undefined)
    this.queues.set(workspace, tail)
    void tail.then(() => {
      if (this.queues.get(workspace) === tail) this.queues.delete(workspace)
    })
    return result
  }

  /** 返回或同步发布某个规范工作区唯一的那个实例。 */
  private instanceFor(workspaceKey: WorkspaceKey, workspace: HostWorkspace): LspInstance {
    this.assertActive()
    const existing = this.instances.get(workspaceKey)
    if (existing !== undefined) return existing
    const created = this.createInstance(workspace)
    this.instances.set(workspaceKey, created)
    return created
  }

  /** 当且仅当该槽位仍装着这个实例时才丢弃它。 */
  private evictIfCurrent(workspace: WorkspaceKey, instance: LspInstance): void {
    /* v8 ignore next -- 出现不匹配需要另一次查询在这个 finally 运行之前替换掉该槽位。 */
    if (this.instances.get(workspace) === instance) this.instances.delete(workspace)
  }

  private createInstance(workspace: HostWorkspace): LspInstance {
    const spec: InstanceSpec = {
      command: this.executable,
      args: this.config.args,
      cwd: workspace.canonicalPath,
      workspaceUri: workspace.fileUrl,
      env: this.config.env,
      configuration: this.config.configuration,
      initializationOptions: this.config.initializationOptions,
      maxMessageBytes: this.config.maxMessageBytes,
      maxStderrBytes: this.config.maxStderrBytes,
      shutdownTimeoutMs: this.config.shutdownTimeoutMs,
      killGraceMs: this.config.killGraceMs,
    }
    return new LspInstance(spec, this.spawner)
  }

  /** 销毁每一个存活实例并阻止后续查询。 */
  async disposeAll(): Promise<void> {
    this.disposed = true
    this.lifetime.abort(new LspError('lsp-stdio provider is disposed', 'LSP_DISPOSED'))
    const live = [...this.instances.values()]
    const draining = [...this.queues.values()]
    const resolving = [...this.workspaceLookups]
    this.instances.clear()
    const results = await Promise.allSettled([
      ...live.map(instance => instance.dispose()),
      ...draining,
      ...resolving,
    ])
    this.queues.clear()
    this.workspaceLookups.clear()
    throwTeardownFailures(results, 'lsp-stdio instance teardown failed')
  }
}
