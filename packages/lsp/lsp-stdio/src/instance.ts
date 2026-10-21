/**
 * 一个语言服务实例：连接加上 initialize 握手、串行化且可中止的查询队列、
 * 临时的 `didOpen`→request→`didClose` 生命周期，以及有界的拆除流程。一个实例拥有
 * 一个 `(provider id, 规范工作区)` 进程。查询通过单一队列串行化，因此一个未能停止
 * 服务端的取消可以终止它，而不会波及无关的工作；不同实例之间并行运行。
 * @module @deepseek-ai/dsh-lsp-stdio/instance
 */

import { LspError } from '@deepseek-ai/dsh-lsp'
import type {
  LspOperation,
  LspProviderQuery,
  LspQueryResult,
} from '@deepseek-ai/dsh-lsp'
import { deadline } from '@deepseek-ai/dsh-timeout'
import { abortable, abortError } from './abort.ts'
import { LspConnection } from './connection.ts'
import type { ConnectionSpawner, ConnectionSpec, ConnectionWriter } from './connection.ts'
import type { HostSource } from './host.ts'
import type { WireInitializeResult, WireServerCapabilities } from './protocol.ts'
import {
  negotiatePositionEncoding,
  normalizeHover,
  normalizeLocations,
  requestMethod,
  supportsOperation,
  supportsTransientOpen,
} from './translate.ts'

/** 除连接 spec 之外一个实例所需的全部内容。 */
export interface InstanceSpec extends ConnectionSpec {
  /** 由文件系统 provider 提供的规范工作区 file URI。 */
  readonly workspaceUri: string
  /** 转发给服务端的静态 `initialize` 选项。 */
  readonly initializationOptions: unknown
  /** 升级前的优雅 `shutdown`/`exit` 预算（毫秒）。 */
  readonly shutdownTimeoutMs: number
}

/**
 * 一个已初始化的服务端进程。不作为 provider 导出——由 provider 做单飞与池化。
 * `query()` 串行执行；`dispose()` 拒绝排队的工作并拆除进程。
 */
export class LspInstance {
  private readonly connection: LspConnection
  private capabilities: WireServerCapabilities | undefined
  /** 串行化尾部：每次查询都等待前一次，因此生命周期不会交错。 */
  private queue: Promise<unknown> = Promise.resolve()
  private disposed = false
  /** 唯一的一次拆除事务，由中止、失败与显式销毁共用。 */
  private teardownPromise: Promise<void> | undefined
  /** 进程关闭后置位，使池可以同步跳过一个已死亡的实例。 */
  private processClosed = false
  /** `initialize` 成功后填充；握手失败会让每次查询都拒绝。 */
  private readonly ready: Promise<void>

  /**
   * @param spec - 启动、初始化与拆除参数。
   * @param spawner - 子进程接缝的 spawn 函数。
   * @param writer - 传输一致性测试使用的可选连接写入器。
   */
  constructor(private readonly spec: InstanceSpec, spawner: ConnectionSpawner, writer?: ConnectionWriter) {
    this.connection = new LspConnection(spec, spawner, (method, params) => this.answerServerRequest(method, params), writer)
    this.ready = this.initialize()
    // 握手拒绝不得在第一次查询 await 它之前表现为未处理的拒绝；查询会挂上真正的处理器。
    this.ready.catch(() => {})
    void this.connection.closed.then(() => { this.processClosed = true })
  }

  /** 同步的存活检查：进程已关闭或实例已销毁时为 true。 */
  get dead(): boolean {
    return this.processClosed || this.disposed || this.connection.failed
  }

  /**
   * 判断一个捕获到的查询错误是否来自本实例的传输层。
   * @param error - provider 捕获到的错误。
   * @returns 仅当它是连接保留的致命传输原因时为 `true`。
   */
  isTransportFailure(error: unknown): boolean {
    return this.connection.failedWith(error)
  }

  /**
   * 通过串行化队列执行一次查询。
   * @param request - 已解析的 provider 查询。
   * @param source - 预先校验并已读取的宿主源码（provider 在启动进程之前读取）。
   * @param signal - 本次查询完整生命周期的可选取消信号。
   * @returns 规范化的结果。
   */
  query(request: LspProviderQuery, source: HostSource, signal?: AbortSignal): Promise<LspQueryResult> {
    // 排在先前的工作之后执行，但在队列等待期间也要观察中止：如果前一个查询挂起
    // （例如一个没有 signal 的服务调用方），后一个工具的超时仍必须能够放弃，
    // 而不是永远阻塞在共享尾部上。
    const run = abortable(this.queue, signal)
      .then(() => this.runQuery(request, source, signal))
      .catch(async (error: unknown) => {
        if (this.isTransportFailure(error)) await this.awaitTeardownAttempt()
        throw error
      })
    // 无论本次查询结果如何都保持尾部存活，使下一个调用方仍可串行化。尾步跟随
    // 真实的先前工作（this.queue），而不是可中止视图，因此调用方放弃等待
    // 不会让队列失去串行化。
    this.queue = this.queue.then(() => run).then(() => undefined, () => undefined)
    return run
  }

  private async initialize(): Promise<void> {
    const initializeResult = await this.connection.request('initialize', {
      // 子进程 provider 可能运行在另一个 PID 命名空间或另一台机器上；
      // 宿主的 PID 会让服务端去监视一个无关的进程。
      processId: null,
      rootUri: this.spec.workspaceUri,
      workspaceFolders: [{ uri: this.spec.workspaceUri, name: 'workspace' }],
      capabilities: CLIENT_CAPABILITIES,
      initializationOptions: this.spec.initializationOptions,
    }) as WireInitializeResult
    const capabilities = initializeResult.capabilities
    // 省略编码时默认为 utf-16；任何其他取值都是协议错误，我们在这里拒绝。
    negotiatePositionEncoding(capabilities.positionEncoding)
    this.capabilities = capabilities
    await this.connection.notify('initialized', {})
  }

  private async runQuery(request: LspProviderQuery, source: HostSource, signal?: AbortSignal): Promise<LspQueryResult> {
    if (this.disposed) throw new LspError('LSP instance was disposed', 'LSP_DISPOSED')
    /* v8 ignore next -- 可中止的队列等待会在 runQuery 之前拒绝一个已中止的 signal；这里是一道双保险。 */
    if (signal?.aborted) throw abortError(signal)
    // 在等待握手期间观察中止，并且绝不对一个被污染的实例做池化：如果等待以失败告终——
    // 一个仍在挂起的握手被中止，或者 `initialize` 在没有进程退出的情况下拒绝
    // （utf-8 协商、结果畸形）——就拆除该实例，使一个永久拒绝/挂起的 `ready`
    // 不会让该工作区之后的每次查询都失败。
    try {
      await abortable(this.ready, signal)
    } catch (error) {
      if (!this.dead) {
        await this.awaitTeardownAttempt()
      }
      throw error
    }
    const capabilities = this.capabilities
    /* v8 ignore next -- `ready` 只在 capabilities 置位之后才 resolve，否则在上面就拒绝了；防御性。 */
    if (capabilities === undefined) throw new Error('LSP instance is not initialized')
    if (!supportsOperation(capabilities, request.operation)) {
      throw new LspError(`server does not support ${request.operation}`, 'LSP_UNSUPPORTED_OPERATION')
    }
    if (!supportsTransientOpen(capabilities.textDocumentSync)) {
      throw new LspError('server does not support the transient textDocument/didOpen this host requires', 'LSP_UNSUPPORTED_OPERATION')
    }

    const uri = source.fileUrl
    let opened = false
    try {
      /* v8 ignore next -- 守护中止落在 ready 等待与 didOpen 之间的情形；无法确定性复现。 */
      if (signal?.aborted) throw abortError(signal)
      try {
        await abortable(this.connection.notify('textDocument/didOpen', {
          textDocument: { uri, languageId: request.languageId, version: 1, text: source.text },
        }), signal)
      } catch (error) {
        // 被取消的背压写入或失败的 stdin 会让协议流在 `opened` 能够装配 didClose 清理之前
        // 就不可用。此处拆除会让池驱逐该实例。
        await this.awaitTeardownAttempt()
        throw error
      }
      opened = true
      const payload = await this.sendRequest(request.operation, uri, request.position, signal)
      return this.normalize(request.operation, payload)
    } finally {
      // 一个已销毁或已关闭的实例（例如服务端忽略了 `$/cancelRequest` 的已中止请求）
      // 已经在拆除中；再发送 didClose 会与拆除竞争，并让下一个排队查询的文档生命周期
      // 与仍在活动的请求重叠。
      if (opened && !this.dead) {
        try {
          await this.connection.notify('textDocument/didClose', { textDocument: { uri } })
        } catch (_closeFailure: unknown) {
          // 关闭写入失败不会替换已落定的结果/错误，但该实例已不再可信。
          // provider 会重新等待这次拆除，并负责失败上报。
          await this.awaitTeardownAttempt()
        }
      }
    }
  }

  private async sendRequest(
    operation: LspOperation,
    uri: string,
    position: LspProviderQuery['position'],
    signal?: AbortSignal,
  ): Promise<unknown> {
    const params = {
      textDocument: { uri },
      position: { line: position.line, character: position.character },
      // findReferences 总是包含声明：调用方拿不到开关，影响分析绝不会漏掉定义处。
      ...(operation === 'findReferences' ? { context: { includeDeclaration: true } } : {}),
    }
    const requestId = this.connection.peekNextId()
    const send = this.connection.request(requestMethod(operation), params)
    if (signal === undefined) return send
    return this.raceAbort(send, requestId, signal)
  }

  /**
   * 让一个在途请求与中止竞争。中止时发送 `$/cancelRequest`，并给服务端一个有界的
   * 宽限期来确认；若它未能在时限内落定，就让实例失效并拆除，
   * 使仍在活动的请求无法与下一个排队查询的文档生命周期重叠。
   */
  private async raceAbort(send: Promise<unknown>, requestId: number, signal: AbortSignal): Promise<unknown> {
    try {
      return await abortable(send, signal)
    } catch (error) {
      if (!signal.aborted) throw error
      this.connection.cancel(requestId)
      // 有界地等待服务端兑现取消。若它没有兑现，说明请求仍在运行：终止该实例
      // （销毁会等待进程关闭），使任何东西都不会比这次查询活得更久。
      const grace = deadline(undefined, this.spec.killGraceMs, 'LSP_CANCEL_GRACE')
      try {
        // `settled` 为 true 表示请求在宽限期耗尽之前完成（无论成功失败）。
        const settled = await Promise.race([
          send.then(markSettled, markSettled),
          new Promise<boolean>((resolve) => {
            /* v8 ignore next -- 取消宽限期的 deadline signal 在此处是新装配的且尚未中止；防御性。 */
            if (grace.signal.aborted) { resolve(false); return }
            grace.signal.addEventListener('abort', () => { resolve(false) }, { once: true })
          }),
        ])
        if (!settled) await this.awaitTeardownAttempt()
      } finally {
        grace[Symbol.dispose]()
      }
      throw error
    }
  }

  private normalize(operation: LspOperation, payload: unknown): LspQueryResult {
    if (operation === 'hover') {
      return { kind: 'hover', hover: normalizeHover(payload) }
    }
    // 文件系统 provider 拥有执行平台的 URI 语法，它可能与 harness 宿主不同。
    // 通过渲染保留该坐标系，而不是在那里重新解析 `spec.cwd`。
    return { kind: 'locations', locations: normalizeLocations(payload), resolvedWorkspaceUri: this.spec.workspaceUri }
  }

  private answerServerRequest(method: string, params: unknown): Promise<unknown> {
    if (method === 'workspace/configuration') {
      // 用那一个静态配置值应答每一个被请求的条目。
      const record = params as { items?: unknown[] } | null
      /* v8 ignore next -- 配置请求总是携带 items 数组；空数组回退是防御性的。 */
      const items = Array.isArray(record?.items) ? record.items : []
      return Promise.resolve(items.map(() => this.spec.configuration))
    }
    if (LIFECYCLE_NOOP_METHODS.has(method)) {
      // 以空结果接受生命周期记账类请求；我们没有注册任何动态能力。
      return Promise.resolve(null)
    }
    if (method === 'workspace/applyEdit') {
      // 本宿主从不应用编辑或执行命令。
      return Promise.reject(new Error('workspace/applyEdit is not permitted by this host'))
    }
    return Promise.reject(new Error(`unsupported server request: ${method}`))
  }

  /**
   * 拒绝排队的工作，尝试优雅的 `shutdown`/`exit`，然后升级为 SIGTERM→SIGKILL，
   * 并等待进程关闭，使任何东西都不会比销毁活得更久。
   */
  async dispose(): Promise<void> {
    await this.startTeardown()
  }

  /** 一次性发布销毁状态，并让每个调用方等待同一个静止边界。 */
  private startTeardown(): Promise<void> {
    this.disposed = true
    this.teardownPromise ??= this.tearDown()
    return this.teardownPromise
  }

  /** 等待拆除，同时把它记忆化的失败留给 provider 层的最终处理。 */
  private async awaitTeardownAttempt(): Promise<void> {
    try {
      await this.startTeardown()
    } catch (_teardownFailure: unknown) {
      // LocalLspProvider 会重新等待同一次拆除，并把它与查询结果合并。
    }
  }

  private async tearDown(): Promise<void> {
    const shutdownDeadline = deadline(undefined, this.spec.shutdownTimeoutMs, 'LSP_SHUTDOWN')
    try {
      await this.gracefulShutdown(shutdownDeadline.signal)
    } catch {
      // 优雅关闭失败或超时；下面的受管范围清理仍然是权威的。
    } finally {
      shutdownDeadline[Symbol.dispose]()
    }
    await this.forceTerminate()
  }

  /** 尽力的 LSP `shutdown`/`exit`，包含进程关闭，由 `signal` 约束。 */
  private async gracefulShutdown(signal: AbortSignal): Promise<void> {
    await abortable(this.connection.request('shutdown', null), signal)
    await this.connection.notify('exit', null)
    await abortable(this.connection.closed, signal)
  }

  /**
   * 终止 provider 管理的范围，然后等待直接的服务端结果与整个范围的静止。
   * 这里的等待是刻意不带上限的，因为销毁要交付给调用方的前置条件是静止，
   * 而不是又一个定时器。
   */
  private async forceTerminate(): Promise<void> {
    this.connection.terminate()
    await Promise.all([
      this.connection.closed,
      this.connection.waitForManagedRangeExit(),
    ])
  }
}

/** 本宿主以空结果确认的服务端→客户端请求方法（无动态注册）。 */
const LIFECYCLE_NOOP_METHODS = new Set([
  'window/workDoneProgress/create',
  'client/registerCapability',
  'client/unregisterCapability',
])

/** 在取消宽限期竞争中标定一个已落定的请求（任一结果都表示请求已结束）。 */
function markSettled(): boolean {
  return true
}

/**
 * `initialize` 时通告的客户端能力：UTF-16 位置、工作区文件夹与配置、
 * markdown/纯文本悬停，以及 definition/implementation 的链接支持。
 * 不做动态注册；服务端返回的能力是权威的。
 */
const CLIENT_CAPABILITIES = {
  general: { positionEncodings: ['utf-16'] },
  workspace: { workspaceFolders: true, configuration: true },
  textDocument: {
    synchronization: { dynamicRegistration: false },
    hover: { contentFormat: ['markdown', 'plaintext'] },
    definition: { linkSupport: true },
    implementation: { linkSupport: true },
    references: {},
  },
} as const
