/**
 * 建立在“通过子进程能力启动的一个语言服务”之上的 JSON-RPC 端点。负责 id 关联、
 * 出站请求/通知，以及入站的服务端→客户端请求：它用静态配置应答 `workspace/configuration`，
 * 并拒绝 `workspace/applyEdit`（本宿主从不应用编辑或执行命令）。它限制 stderr 大小，
 * 把分帧/解码失败上升为致命关闭，并通过句柄暴露受管范围的终止能力，使实例拥有拆除权；
 * 平台机制位于子进程服务提供者中。
 * @module @deepseek-ai/dsh-lsp-stdio/connection
 */

import type { Writable } from 'node:stream'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { encodeMessage, MessageDecoder } from './framing.ts'

/** 如何启动服务端，以及如何应答它的配置请求。 */
export interface ConnectionSpec {
  /** 已解析的绝对可执行文件路径（不经 shell）。 */
  readonly command: string
  /** 传给可执行文件的参数。 */
  readonly args: readonly string[]
  /** 子进程的工作目录（规范化的工作区）。 */
  readonly cwd: string
  /** 显式的子进程环境覆盖；子进程 provider 自行负责环境清理。 */
  readonly env: Record<string, string>
  /** 从服务端接受的单条分帧消息上限。 */
  readonly maxMessageBytes: number
  /** 为诊断保留的 stderr 尾部上限。 */
  readonly maxStderrBytes: number
  /**
   * 子进程 spec 的 `graceMs`：{@link LspConnection.terminate} 升级时的
   * SIGTERM→SIGKILL 窗口，也是服务端退出后仍在存活的辅助进程
   * 所持管道排空的时间上限。
   */
  readonly killGraceMs: number
  /** 对每一个 `workspace/configuration` 条目的静态应答。 */
  readonly configuration: unknown
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/**
 * 向子进程 stdin 写入一条 JSON-RPC 消息。
 * @param stdin - 已启动服务端的 stdin。
 * @param message - 未编码的 JSON-RPC 消息。
 * @param done - 报告异步流落定结果的回调。
 */
export type ConnectionWriter = (
  stdin: Writable,
  message: unknown,
  done: (error?: Error | null) => void,
) => void

/** 为本次连接启动一个子进程（provider 传入 `ctx.subprocess.spawn`）。 */
export type ConnectionSpawner = (spec: SubprocessSpawnSpec) => SubprocessHandle

const writeConnectionMessage: ConnectionWriter = (stdin, message, done) => {
  stdin.write(encodeMessage(message), done)
}

/** 绑定到一个子进程的存活 JSON-RPC 端点。 */
export class LspConnection {
  private readonly handle: SubprocessHandle
  private readonly stdin: Writable
  private readonly decoder: MessageDecoder
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private closeReason: Error | undefined
  /** 进程完全退出后置位；实例在拆除期间等待它。 */
  readonly closed: Promise<void>

  /**
   * @param spec - 如何启动服务端，以及如何应答它的配置请求。
   * @param spawner - 子进程接缝的 spawn（provider 传入 `ctx.subprocess.spawn`）。
   * @param onServerRequest - 应答一个服务端→客户端请求；拒绝即发送错误响应。
   * @param writer - 消息写入器；测试通过它注入回调失败，而不依赖 OS 管道竞态。
   */
  constructor(
    spec: ConnectionSpec,
    spawner: ConnectionSpawner,
    private readonly onServerRequest: (method: string, params: unknown) => Promise<unknown>,
    private readonly writer: ConnectionWriter = writeConnectionMessage,
  ) {
    this.decoder = new MessageDecoder(spec.maxMessageBytes)
    // stdin/stdout 是本端点自行分帧的管道协议流；stderr 是采集的诊断尾部
    // （不做溢出落盘——这个有界尾部本身就是契约）。接缝负责受管范围的信号与观察。
    this.handle = spawner({
      argv: [spec.command, ...spec.args],
      cwd: spec.cwd,
      stdio: {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: { maxBytes: spec.maxStderrBytes },
      },
      graceMs: spec.killGraceMs,
      // 接缝在其环境清理之后合并显式配置条目，因此配置中的凭据或 DSH_* 事实
      // 是有意地传给子进程的。
      env: spec.env,
    })
    /* v8 ignore start -- 按接缝契约，'pipe' 处置方式会暴露两个流；此处为防御性检查。 */
    if (this.handle.stdin === undefined || this.handle.stdout === undefined) {
      throw new Error('lsp-stdio: subprocess implementation dropped a piped protocol stream')
    }
    /* v8 ignore stop */
    this.stdin = this.handle.stdin
    this.closed = new Promise<void>((resolve) => {
      const close = (): void => {
        const reason = this.closeReason ?? new Error(this.exitMessage())
        // 记录原因，使关闭之后才发出的请求立即拒绝而不是挂起
        // （已关闭的进程不会再发送任何响应）。
        this.closeReason = reason
        this.failAll(reason)
        resolve()
      }
      this.handle.done.then(close, (error: unknown) => {
        // 启动层面的失败不会产生 close 事件；该拒绝同时是致命原因与关闭边界。
        this.fail(asError(error))
        close()
      })
    })
    // 子进程 stdin 可能在进程仍然存活时失败（例如服务端关闭了 fd 0）。
    // 把这视为致命连接错误，使挂起的请求立即拒绝，而不是等待一个可能永不到达的进程关闭事件。
    this.stdin.on('error', (error) => { this.fail(error) })
    this.handle.stdout.on('data', (chunk: Buffer) => { this.onStdout(chunk) })
  }

  /** 保留的 stderr 尾部，用于服务端失败时的诊断。 */
  get stderrTail(): string {
    /* v8 ignore next -- collect 处置方式总是暴露 stderr 读取器；此处为防御性检查。 */
    return this.handle.collected.stderr?.readFrom(0).text ?? ''
  }

  /** 传输层是否已失败，即使子进程 close 事件尚未到达。 */
  get failed(): boolean {
    return this.closeReason !== undefined
  }

  /**
   * 判断一个捕获到的错误是否是本连接保留的致命传输原因。
   * @param error - 实例或 provider 捕获到的错误。
   * @returns 仅当本连接产生了该确切失败时为 `true`。
   */
  failedWith(error: unknown): boolean {
    return this.closeReason === error
  }

  /**
   * 发送一个请求并等待其结果。
   * @param method - JSON-RPC 方法。
   * @param params - 请求参数。
   * @returns 响应的结果；错误响应、写入失败或关闭时拒绝。
   */
  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    const promise = new Promise<unknown>((resolve, reject) => {
      if (this.closeReason !== undefined) {
        reject(this.closeReason)
        return
      }
      this.pending.set(id, { resolve, reject })
      // `write()` 会把同步或由回调传递的失败都记录到连接上，并拒绝所有挂起的请求。
      // 这个处理器只消费 write 自身的 promise。
      void this.write({ jsonrpc: '2.0', id, method, params }).catch(() => {})
    })
    // 停止等待的调用方（例如被中止的查询）会让这个 promise 在进程关闭时稍后拒绝；
    // 一个无害的空处理器可避免它表现为未处理的拒绝。返回的 promise 仍会把拒绝
    // 交付给调用方自己的 await/catch。
    promise.catch(() => {})
    return promise
  }

  /**
   * 发送一个通知（无 id，无响应）。
   * @param method - JSON-RPC 方法。
   * @param params - 通知参数。
   * @returns 分帧通知写入完成时落定的 promise。
   */
  notify(method: string, params: unknown): Promise<void> {
    return this.write({ jsonrpc: '2.0', method, params })
  }

  /**
   * 为某个在途请求 id 发送 `$/cancelRequest`（尽力而为；忽略写入失败）。
   * @param requestId - 要取消的请求的数字 id。
   */
  cancel(requestId: number): void {
    // 服务端已经消失或不可写时会走到这里；`write()` 已记录致命连接失败并拒绝了该挂起请求，
    // 因此取消保持尽力而为的语义。
    void this.write({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: requestId } }).catch(() => {})
  }

  /**
   * 下一次 `request()` 将要使用的 id，使实例可以预先准备取消。
   * @returns 下一个请求将被分配的数字 id。
   */
  peekNextId(): number {
    return this.nextId
  }

  /** 终止服务端由 provider 管理的范围（幂等）。 */
  terminate(): void {
    this.handle.terminate()
  }

  /**
   * 等待所属的受管范围变为空。
   * @param signal - 等待的可选上限。
   * @returns 范围为空时为 `true`，signal 先中止时为 `false`。
   */
  async waitForManagedRangeExit(signal?: AbortSignal): Promise<boolean> {
    return await this.handle.waitForExit(signal)
  }

  private onStdout(chunk: Buffer): void {
    let messages: unknown[]
    try {
      messages = this.decoder.push(chunk)
    } catch (error) {
      // 分帧/JSON 破坏会不可恢复地损坏流的位置：让实例失败，并终止受管范围，
      // 使辅助进程不会比主进程活得更久。
      this.fail(asError(error))
      this.handle.terminate()
      return
    }
    for (const message of messages) this.dispatch(message)
  }

  private dispatch(message: unknown): void {
    if (message === null || typeof message !== 'object') return
    const frame = message as Record<string, unknown>
    const id = frame.id
    const method = frame.method
    if (typeof method === 'string' && (typeof id === 'number' || typeof id === 'string')) {
      // 响应写入失败已在 `write()` 中使连接失效。
      /* v8 ignore next -- 协议测试覆盖了响应写入；只有同时发生连接失败才会走到这个消费处理器。 */
      void this.handleServerRequest(id, method, frame.params).catch(() => {})
      return
    }
    if (typeof method === 'string') {
      // 服务端→客户端通知（例如诊断、日志）：本 MVP 宿主忽略。
      return
    }
    if (typeof id === 'number') this.handleResponse(id, frame)
  }

  private async handleServerRequest(id: number | string, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.onServerRequest(method, params)
      await this.write({ jsonrpc: '2.0', id, result })
    } catch (error) {
      await this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: asError(error).message } })
    }
  }

  private handleResponse(id: number, frame: Record<string, unknown>): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    const error = frame.error
    if (error !== null && typeof error === 'object') {
      const record = error as Record<string, unknown>
      pending.reject(new Error(typeof record.message === 'string' ? record.message : 'LSP error response'))
      return
    }
    pending.resolve(frame.result)
  }

  private write(message: unknown): Promise<void> {
    if (this.closeReason !== undefined) return Promise.reject(this.closeReason)
    return new Promise<void>((resolve, reject) => {
      const done = (error?: Error | null): void => {
        if (error === undefined || error === null) {
          resolve()
          return
        }
        this.fail(error)
        reject(error)
      }
      try {
        this.writer(this.stdin, message, done)
      /* v8 ignore start -- Node 流的写入失败由回调传递；此处防范一个不合规的 Writable
         实现同步抛出。 */
      } catch (error) {
        const failure = asError(error)
        this.fail(failure)
        reject(failure)
      }
      /* v8 ignore stop */
    })
  }

  /** 退出关闭的错误消息；服务端有输出时附加上保留的 stderr 尾部。 */
  private exitMessage(): string {
    const tail = this.stderrTail.trim()
    return tail === '' ? 'language server exited' : `language server exited; stderr: ${tail}`
  }

  private fail(error: Error): void {
    /* v8 ignore next -- 第二个分支（closeReason 已置位）需要在关闭前发生两次 fail()；防御性。 */
    if (this.closeReason === undefined) this.closeReason = error
    this.failAll(error)
  }

  private failAll(error: Error): void {
    const waiting = [...this.pending.values()]
    this.pending.clear()
    for (const pending of waiting) pending.reject(error)
  }
}

/** 把一个未知的抛出值强制转换为 `Error`。 */
function asError(value: unknown): Error {
  /* v8 ignore next -- 非 Error 分支用于防御非 Error 抛出，我们的代码路径不会产生。 */
  return value instanceof Error ? value : new Error(String(value))
}
