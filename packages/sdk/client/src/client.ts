/**
 * DeepSeek Harness SDK 运行时子进程的低层 JSON-RPC 客户端。
 * {@link HarnessClient} 持有该子进程：它启动运行时，通过子进程的 stdio
 * 使用 `@deepseek-ai/dsh-sdk-protocol` 线上协议，把服务端通知分发给各个订阅，
 * 并通过一条私有的 EOF → SIGTERM → SIGKILL 阶梯把子进程拆除至静默。
 * 其设计孪生是 Python SDK 的 `HarnessClient`（`python/sdk`）；两者驱动同一个
 * 运行时协议。本客户端运行在任意 harness context 之外，因此它直接 spawn，
 * 而不经过 `dsh-subprocess` 服务 —— 这是该能力缝针对 SDK 自管传输
 * 所记录的例外。
 *
 * @module @deepseek-ai/dsh-sdk-client/client
 */

import { spawn, type ChildProcess } from 'node:child_process'
import {
  JsonRpcLineTransport,
  JsonRpcResponseError,
  type InitializeParams,
  type InitializeResult,
  type SessionPromptParams,
  type SdkPromptContentBlock,
} from '@deepseek-ai/dsh-sdk-protocol'
import { disposeRuntimeProcess } from './dispose.ts'
import { resolveDshLaunch, type RuntimeProcessOptions } from './launch.ts'
import type { HarnessClientOptions, HarnessNotification, NotificationFilter } from './types.ts'

/** 保留的 stderr 行数，用于诊断运行时的意外死亡。 */
const STDERR_TAIL_LIMIT = 400

/** 运行时在其退出边沿之后留给 stdio 流收敛的宽限时间。 */
const STREAM_SETTLE_MS = 100

/**
 * 运行时子进程已消失或不可用：它已退出、其 stdio 已关闭，或它根本无法启动。
 * 消息中会携带退出码，并在可用时附带一段 stderr 尾部。
 */
export class TransportClosedError extends Error {
  /** @param message - 失败描述，包含任何 stderr 尾部。 */
  constructor(message: string) {
    super(message)
    this.name = 'TransportClosedError'
  }
}

/** 某个请求超过了 {@link HarnessClientOptions.requestTimeoutMs}。 */
export class RequestTimeoutError extends Error {
  /** @param message - 哪个方法超时。 */
  constructor(message: string) {
    super(message)
    this.name = 'RequestTimeoutError'
  }
}

/**
 * 运行时给出的应答超出了其文档化的协议（例如一个没有 `accepted: true` 的
 * `session/prompt` 响应）。
 */
export class SdkProtocolError extends Error {
  /** @param message - 协议违反的描述。 */
  constructor(message: string) {
    super(message)
    this.name = 'SdkProtocolError'
  }
}

interface SubscriptionState {
  readonly queue: HarnessNotification[]
  readonly waiters: { resolve: (item: HarnessNotification) => void; reject: (error: Error) => void }[]
  readonly filter: NotificationFilter | undefined
  failure: Error | undefined
}

/** {@link HarnessClient.subscribe} 返回的一个客户端通知流。 */
export interface NotificationSubscription extends AsyncIterable<HarnessNotification> {
  /**
   * 等待下一条匹配的通知。
   * @returns 该通知；运行时死亡之后，会先排空已经投递的内容再 reject；
   *   在 {@link close} 之后立即 reject（队列被丢弃）。
   */
  next(): Promise<HarnessNotification>

  /**
   * 不等待地排空一条已投递的通知。
   * @returns 下一条已入队的通知；当没有入队通知时为 `undefined`。
   */
  tryNext(): HarnessNotification | undefined

  /** 从客户端脱离；队列中的条目被丢弃，待定的等待者被 reject。 */
  close(): void
}

/** 公开通知订阅的内部生产者侧。 */
class NotificationSubscriptionImpl implements NotificationSubscription {
  constructor(
    private readonly state: SubscriptionState,
    private readonly unsubscribe: () => void,
  ) {}

  /**
   * 等待下一条匹配的通知。
   * @returns 该通知；运行时死亡之后，会先排空已经投递的内容再 reject；
   *   在 {@link close} 之后立即 reject（队列被丢弃）。
   */
  next(): Promise<HarnessNotification> {
    const queued = this.state.queue.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    if (this.state.failure !== undefined) return Promise.reject(this.state.failure)
    return new Promise((resolve, reject) => {
      this.state.waiters.push({ resolve, reject })
    })
  }

  /**
   * 不等待地排空一条已投递的通知。
   * @returns 下一条已入队的通知；当没有入队通知时为 `undefined`。
   */
  tryNext(): HarnessNotification | undefined {
    return this.state.queue.shift()
  }

  /** 从客户端脱离；队列中的条目被丢弃，待定的等待者被 reject。 */
  close(): void {
    this.unsubscribe()
    // 丢弃队列是本方法契约的一部分；而运行时死亡导致的 fail() 会保留队列，
    // 使已经投递的通知仍然可以被排空。
    this.state.queue.length = 0
    this.fail(new TransportClosedError('notification subscription closed'))
  }

  /**
   * reject 待定及后续的等待（投递停止；第一个失败胜出）。
   * 已经入队的通知仍可通过 {@link next}/{@link tryNext} 排空。
   * @param error - 投递给等待者的终结性失败。
   */
  fail(error: Error): void {
    this.state.failure ??= error
    for (const waiter of this.state.waiters.splice(0)) waiter.reject(this.state.failure)
  }

  /**
   * 当过滤器匹配时，把一条通知投递给某个等待者或队列。抛出的过滤器只会让
   * 「本」订阅失败（脱离之后，该抛出成为它的终结性错误）—— 它绝不会打扰
   * 兄弟订阅或传输的读取循环。
   * @param notification - 待投递的线上通知。
   */
  push(notification: HarnessNotification): void {
    let matches: boolean
    try {
      matches = this.state.filter === undefined || this.state.filter(notification)
    } catch (error) {
      this.unsubscribe()
      this.fail(error instanceof Error ? error : new Error(String(error)))
      return
    }
    if (!matches) return
    const waiter = this.state.waiters.shift()
    if (waiter !== undefined) waiter.resolve(notification)
    else this.state.queue.push(notification)
  }

  /**
   * 迭代通知，直到订阅或运行时关闭（终结性的 rejection 会向上传播）。
   * @returns 一个基于 {@link next} 结果的异步迭代器。
   */
  async * [Symbol.asyncIterator](): AsyncIterator<HarnessNotification> {
    for (;;) yield await this.next()
  }
}

/**
 * 在子进程 stdio 之上、面向 DeepSeek Harness SDK 运行时的 JSON-RPC 客户端。
 *
 * 子进程在 {@link start} 时惰性启动，并由本实例持有，直到 {@link close}；
 * `close` 会先请求协议 `shutdown`，然后走共享的 EOF → SIGTERM → SIGKILL
 * 拆除阶梯，直至静默。没有线级别的取消：一个超时的请求会在服务端继续运行，
 * 直到运行时被关闭。
 */
export class HarnessClient {
  /** 本客户端原始的公开 dsh 启动与超时选项。 */
  readonly options: HarnessClientOptions
  private readonly runtime: RuntimeProcessOptions
  private child: ChildProcess | undefined
  private transport: JsonRpcLineTransport | undefined
  private readonly stderrTail: string[] = []
  private readonly subscriptions = new Map<string, NotificationSubscriptionImpl>()
  private readonly sessionParents = new Map<string, string>()
  private subscriptionSerial = 0
  private exitCode: number | null | undefined
  private spawnError: Error | undefined
  private streamsSettled: Promise<void> = Promise.resolve()
  private closeTask: Promise<void> | undefined

  /** @param options - dsh 的 profile、补丁、home、进程、环境与超时选项。 */
  constructor(options?: HarnessClientOptions)
  constructor(options: HarnessClientOptions = {}, runtime?: RuntimeProcessOptions) {
    this.options = options
    this.runtime = runtime ?? resolveDshLaunch(options)
  }

  /**
   * 启动运行时子进程并开始读取帧。进程存活期间幂等；在 {@link close}
   * 之后复用会 reject。
   */
  start(): void {
    if (this.closeTask !== undefined) throw new TransportClosedError('DeepSeek Harness runtime client is closed')
    if (this.child !== undefined) return
    const child = spawn(this.runtime.command, this.runtime.args, {
      cwd: this.runtime.cwd,
      env: this.runtime.environment(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    child.once('error', (error) => {
      this.spawnError = error
      // 启动失败会在没有输入 'end' 边沿的情况下销毁管道，
      // 因此传输层的待定请求必须在这里失败掉。
      this.transport?.close()
      this.failSubscriptions(this.closedError('DeepSeek Harness runtime failed to start'))
    })
    // 写入会与运行时死亡时 stdin 上的 EPIPE 竞争；下面的退出边沿才是真正的
    // 信号，因此流级别的错误只需非致命即可。
    // 该竞争的时序无法确定性复现。
    /* v8 ignore next */
    child.stdin.on('error', () => {})
    let stderrBuffer = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderrBuffer += chunk
      const newline = stderrBuffer.lastIndexOf('\n')
      if (newline >= 0) {
        this.appendStderr(stderrBuffer.slice(0, newline).split('\n'))
        stderrBuffer = stderrBuffer.slice(newline + 1)
      }
    })
    let signalStreamsSettled!: () => void
    this.streamsSettled = new Promise((resolve) => { signalStreamsSettled = resolve })
    const settled = { stderr: false, exited: false }
    const maybeSettle = (): void => {
      if (settled.stderr && settled.exited) signalStreamsSettled()
    }
    child.stderr.once('close', () => {
      if (stderrBuffer.length > 0) this.appendStderr([stderrBuffer])
      settled.stderr = true
      maybeSettle()
    })
    child.once('exit', (code) => {
      this.exitCode = code
      settled.exited = true
      maybeSettle()
      this.failSubscriptions(this.closedError('DeepSeek Harness runtime exited'))
    })
    child.once('close', () => {
      // 所有 stdio 都已收敛：stdout 的 'end' 已经排空了每一个尾部帧，
      // 因此此刻关闭不会丢弃响应 —— 它只会让那些永远得不到应答的请求失败。
      this.transport?.close()
    })
    const transport = new JsonRpcLineTransport(child.stdout, child.stdin)
    transport.onNotification((method, params) => { this.dispatchNotification({ method, params }) })
    transport.start()
    this.transport = transport
  }

  /**
   * 执行进程级握手。
   * @param params - 工作区 cwd 加上 provider/model 路由。
   * @returns 运行时的线上身份。
   */
  async initialize(params: InitializeParams): Promise<InitializeResult> {
    const result = await this.request('initialize', { ...params }, this.runtime.initializeTimeoutMs)
    if (!isRecord(result) || !isRecord(result.serverInfo)
      || typeof result.serverInfo.name !== 'string' || typeof result.serverInfo.version !== 'string') {
      throw new SdkProtocolError(`initialize returned no server identity: ${JSON.stringify(result)}`)
    }
    return { serverInfo: { name: result.serverInfo.name, version: result.serverInfo.version } }
  }

  /**
   * 入队一次提示并返回其持久化的 inbox 标识。
   * @param sessionId - 目标 session；未知 id 会创建它。
   * @param contentBlocks - 用户消息，原样发送。
   * @returns 已入队消息的 id。
   */
  async prompt(sessionId: string, contentBlocks: SdkPromptContentBlock[]): Promise<string> {
    const params: SessionPromptParams = { sessionId, contentBlocks }
    const result = await this.request('session/prompt', { ...params })
    if (!isRecord(result) || typeof result.messageId !== 'string') {
      throw new SdkProtocolError(`session/prompt returned no message id: ${JSON.stringify(result)}`)
    }
    return result.messageId
  }

  /**
   * 恢复持久化历史而不发送提示；失败会直接传播，且不创建 session。
   * @param sessionId - 本运行时所配置持久化存储中的持久化标识。
   * @returns 在 session 准备好接受提示之后 settle。
   */
  async resumeSession(sessionId: string): Promise<void> {
    await this.request('session/resume', { sessionId })
  }

  /**
   * 读取某个 Session 的有效工作目录，并在缺失时恢复它。
   * @param sessionId - 目标 Session；未知 id 会创建它。
   * @returns 绝对的有效目录。
   */
  getWorkingDirectory(sessionId: string): Promise<string> {
    return this.workingDirectoryRequest('session/working-directory/get', { sessionId })
  }

  /**
   * 修改某个 Session 的有效目录，而不改变其来源或权限。
   * @param sessionId - 目标 Session；未知 id 会创建它。
   * @param path - 绝对路径，或相对 Session 当前目录的路径。
   * @returns 经过校验的绝对目录。
   */
  setWorkingDirectory(sessionId: string, path: string): Promise<string> {
    return this.workingDirectoryRequest('session/working-directory/set', { sessionId, path })
  }

  private async workingDirectoryRequest(method: string, params: object): Promise<string> {
    const result = await this.request(method, params)
    if (!isRecord(result) || typeof result.cwd !== 'string') {
      throw new SdkProtocolError(`${method} returned no working directory: ${JSON.stringify(result)}`)
    }
    return result.cwd
  }

  /**
   * 发送一条 JSON-RPC 请求并等待其结果。
   * @param method - 线上方法名。
   * @param params - params 对象；省略 params 时发送 `{}`。
   * @param timeoutMs - 逐次调用时对 {@link HarnessClientOptions.requestTimeoutMs} 的覆盖。
   * @returns 原始结果；收到协议错误响应时以 {@link JsonRpcResponseError} reject，
   *   超时时以 {@link RequestTimeoutError} reject，运行时已消失时以
   *   {@link TransportClosedError} reject。
   */
  async request(method: string, params?: object, timeoutMs?: number): Promise<unknown> {
    this.start()
    // 已死的运行时无法应答；带上进程上下文失败，而不是写入一个已销毁的
    // 管道并一直挂到超时。
    if (this.exitCode !== undefined || this.spawnError !== undefined) {
      await this.settleStreams()
      throw this.closedError('DeepSeek Harness runtime is not running')
    }
    const transport = this.transport
    /* v8 ignore next -- start() 要么设置 transport，要么抛出 */
    if (transport === undefined) throw new TransportClosedError('DeepSeek Harness runtime is not running')
    const timeout = timeoutMs ?? this.runtime.requestTimeoutMs
    try {
      if (timeout === undefined) return await transport.request(method, params ?? {})
      // 中止信号让超时变成一次放弃：传输层丢弃它的待定条目，因此针对一个
      // 卡住的方法重复发起有界请求，不会保留任何逐次调用的状态
      // （服务端的工作仍会一直跑到关闭）。
      const abandon = new AbortController()
      const timer = setTimeout(() => {
        const stderr = this.stderrTail.length === 0 ? '' : `; stderr tail:\n${this.stderrTail.join('\n')}`
        abandon.abort(new RequestTimeoutError(`${method} timed out after ${timeout}ms waiting for ${this.runtime.description}${stderr}`))
      }, timeout)
      try {
        return await transport.request(method, params ?? {}, abandon.signal)
      } finally {
        clearTimeout(timer)
      }
    } catch (error) {
      if (error instanceof JsonRpcResponseError || error instanceof RequestTimeoutError) throw error
      // 传输层的失败会附带进程上下文：退出码 + stderr 尾部。
      await this.settleStreams()
      throw this.closedError(errorMessage(error))
    }
  }

  /**
   * 订阅服务端通知。
   * @param filter - 可选的判定函数；省略表示接收每一条通知。
   * @returns 订阅句柄；关闭它即停止投递。在 {@link close} 或运行时死亡之后，
   *   该句柄一诞生就是失败状态 —— 已经没有生产者了，因此 `next()` 会 reject，
   *   而不是永远等待。
   */
  subscribe(filter?: NotificationFilter): NotificationSubscription {
    const id = String(this.subscriptionSerial++)
    const state: SubscriptionState = { queue: [], waiters: [], filter, failure: undefined }
    const subscription = new NotificationSubscriptionImpl(state, () => { this.subscriptions.delete(id) })
    if (this.closeTask !== undefined || this.exitCode !== undefined || this.spawnError !== undefined) {
      subscription.fail(this.closedError('DeepSeek Harness runtime closed'))
      return subscription
    }
    this.subscriptions.set(id, subscription)
    return subscription
  }

  /**
   * 订阅某个 session，以及从 `subagent.started` 血缘边发现的后代。
   * 运行时会为其 context 中的每个 session 发出通知，因此范围由本客户端施加。
   * @param sessionId - 根 session id。
   * @returns 已过滤的订阅句柄。
   */
  subscribeSessionTree(sessionId: string): NotificationSubscription {
    return this.subscribe((notification) => {
      const params = notification.params
      if (notification.method === 'subagent.started' || notification.method === 'subagent.finished') {
        const parentId = params.parentSessionId
        if (typeof parentId === 'string' && this.isDescendantOf(parentId, sessionId)) return true
        return params.childSessionId === sessionId
      }
      const relatedId = params.sessionId
      return typeof relatedId === 'string' && this.isDescendantOf(relatedId, sessionId)
    })
  }

  /**
   * 关闭并回收运行时：先是一次由 `shutdownTimeoutMs` 限制、尽力而为的协议
   * `shutdown`，然后是共享的 stdin-EOF → SIGTERM → SIGKILL 阶梯，
   * 直到进程真正退出。幂等。
   * @returns 完整拆除的 settle 结果。
   */
  close(): Promise<void> {
    this.closeTask ??= this.performClose()
    return this.closeTask
  }

  private async performClose(): Promise<void> {
    const child = this.child
    if (child === undefined) return
    try {
      await this.request('shutdown', undefined, this.runtime.shutdownTimeoutMs ?? 1_000)
    } catch (error) {
      // 仅作诊断：下面的拆除阶梯，才是针对一个已经无法应答 shutdown 的
      // 运行时的权威拆除手段。
      this.appendStderr([`shutdown request failed: ${errorMessage(error)}`])
    }
    await disposeRuntimeProcess(child, {
      disposeEofGraceMs: this.runtime.disposeEofGraceMs ?? 6_000,
      disposeGraceMs: this.runtime.disposeGraceMs ?? 3_000,
    })
    this.transport?.close()
    this.failSubscriptions(this.closedError('DeepSeek Harness runtime closed'))
  }

  private dispatchNotification(notification: HarnessNotification): void {
    this.recordSessionRelationship(notification)
    for (const subscription of this.subscriptions.values()) subscription.push(notification)
  }

  private recordSessionRelationship(notification: HarnessNotification): void {
    if (notification.method !== 'subagent.started') return
    const parentId = notification.params.parentSessionId
    const childId = notification.params.childSessionId
    if (typeof parentId === 'string' && parentId !== '' && typeof childId === 'string' && childId !== '' && parentId !== childId) {
      this.sessionParents.set(childId, parentId)
    }
  }

  private isDescendantOf(sessionId: string, rootSessionId: string): boolean {
    const visited = new Set<string>()
    let current = sessionId
    while (!visited.has(current)) {
      if (current === rootSessionId) return true
      visited.add(current)
      const parent = this.sessionParents.get(current)
      if (parent === undefined) return false
      current = parent
    }
    // 父级映射只会向上延伸链条，因此不可能形成环。
    /* v8 ignore next */
    return false
  }

  private failSubscriptions(error: Error): void {
    for (const subscription of this.subscriptions.values()) subscription.fail(error)
  }

  private appendStderr(lines: string[]): void {
    const kept = lines.filter(line => line.length > 0)
    this.stderrTail.push(...kept)
    if (this.stderrTail.length > STDERR_TAIL_LIMIT) {
      this.stderrTail.splice(0, this.stderrTail.length - STDERR_TAIL_LIMIT)
    }
  }

  private settleStreams(): Promise<void> {
    return Promise.race([
      this.streamsSettled,
      new Promise<void>((resolve) => { setTimeout(resolve, STREAM_SETTLE_MS) }),
    ])
  }

  private closedError(reason: string): TransportClosedError {
    const parts = [`${this.runtime.description}: ${reason}`]
    if (this.spawnError !== undefined) parts.push(`spawn error: ${this.spawnError.message}`)
    if (this.exitCode !== undefined) parts.push(`exit code: ${String(this.exitCode)}`)
    if (this.stderrTail.length > 0) parts.push(`stderr tail:\n${this.stderrTail.join('\n')}`)
    return new TransportClosedError(parts.join('\n'))
  }
}

/** 针对通用进程构造传输层，供包内的 fake-runtime 测试使用。 */
export function createProcessHarnessClient(options: RuntimeProcessOptions): HarnessClient {
  const Constructor = HarnessClient as new (
    publicOptions: HarnessClientOptions,
    runtime: RuntimeProcessOptions,
  ) => HarnessClient
  return new Constructor({}, options)
}

/**
 * 判断 `value` 是否为普通 JSON 对象（线上边界的形状探测）。
 * @param value - 待探测的线上值。
 * @returns 当且仅当 `value` 是非 null、非数组的对象时为 `true`。
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 抛出值的消息（传输层只抛出 `Error`；其余情况由 `String` 兜住）。 */
function errorMessage(error: unknown): string {
  /* v8 ignore next -- 传输层与拆除阶梯只以 Error reject */
  return error instanceof Error ? error.message : String(error)
}
