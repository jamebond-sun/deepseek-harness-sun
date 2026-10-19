/** 一个 PTY、一个有界终端模拟器，及其可分离的浏览器跟随端。 */
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { RemoteError, remoteErrorOf, type RemoteUplinkWindow } from '@deepseek-ai/dsh-typert-protocol'
import type { Terminal as HeadlessTerminal } from '@xterm/headless'
import type { SerializeAddon as Serializer } from '@xterm/addon-serialize'
import type { SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import { createLazyRequire } from '@deepseek-ai/dsh-lazy-require'
import { TerminalFollower } from './stream.ts'
import { TerminalRetention, type TerminalRetentionPolicy } from './retention.ts'
import type { TerminalEnvironment, TerminalInput, TerminalFrame, TerminalRetentionFrame, WebTerminalInfo } from './types.ts'

const requireHeadless = createLazyRequire<typeof import('@xterm/headless')>('@xterm/headless', import.meta.url)
const requireSerialize = createLazyRequire<typeof import('@xterm/addon-serialize')>('@xterm/addon-serialize', import.meta.url)

/** 进程生命周期独立于跟随端与组件的生命周期。 */
export class BrowserTerminal {
  private readonly screen: HeadlessTerminal
  private readonly serializer: Serializer
  private readonly followers = new Set<TerminalFollower>()
  private sequence = 0
  private operations: Promise<unknown> = Promise.resolve()
  private readonly drained: Promise<void>
  /** 提供方完成先于输出排空与已发布的退出状态。 */
  private exited = false
  private closing: Promise<void> | undefined
  private retention: TerminalRetention | undefined
  private controller: TerminalFollower | undefined

  /**
   * @param handle - 已分配的终端进程范围。
   * @param info - 初始元数据。
   * @param scrollback - 保留的回滚行数上限。
   * @param maxBufferedBytes - 每个跟随端的队列上限。
   */
  constructor(
    private readonly handle: SubprocessTerminalHandle,
    public info: WebTerminalInfo,
    scrollback: number,
    private readonly maxBufferedBytes: number,
  ) {
    const { Terminal } = requireHeadless()
    const { SerializeAddon } = requireSerialize()
    this.screen = new Terminal({ cols: info.cols, rows: info.rows, scrollback, allowProposedApi: true })
    this.serializer = new SerializeAddon()
    this.screen.loadAddon(this.serializer)
    this.drained = this.consume()
  }

  /**
   * 在此分配提交给其 Session 拥有者之后开始监控。
   * @param policy - 已验证的 Host 时序策略。
   * @param closing - 在任何异步终止之前关闭该 id。
   * @param closed - 移除恰好成功终止的那条拥有者记录。
   * @param failed - 后台清理失败时的诊断接收器。
   */
  monitor(policy: TerminalRetentionPolicy, closing: () => void, closed: () => void, failed: (error: unknown) => void): void {
    this.retention = new TerminalRetention(policy, () => this.handle.inspectActivity(), async () => {
      closing()
      await this.closeProcess()
      closed()
    }, failed)
  }

  /**
   * 在独立于输出连接的前提下保留此已提交进程。
   * @param signal - 物理窗口流的生命周期。
   * @returns 其持有确认与生命周期。
   */
  retain(signal: AbortSignal): AsyncIterable<TerminalRetentionFrame> {
    if (this.retention === undefined) throw new Error('Terminal has not been committed')
    return this.retention.retain(signal)
  }

  /**
   * 以独占输入控制的方式连接；较早的连接继续接收输出。
   * @param input - Gateway 解码后的命令；返回其迭代器必须中断挂起的读取。
   * @param limits - 在 Remote 边界验证的输入字节与 PTY 尺寸限制。
   * @param signal - 连接取消；绝不终止进程。
   * @param inputWindow - 载体帧容量；没有编码帧收件箱限制的载体则缺省。
   * @returns 屏幕基线、输出、每次连接的状态与有序的命令确认。
   */
  async *attach(input: AsyncIterable<TerminalInput>, limits: Pick<TerminalEnvironment, 'maxInputBytes' | 'maxCols' | 'maxRows'>, signal: AbortSignal, inputWindow?: RemoteUplinkWindow): AsyncIterable<TerminalFrame> {
    signal.throwIfAborted()
    const follower = new TerminalFollower(this.maxBufferedBytes)
    const baseline = await this.enqueue(() => {
      signal.throwIfAborted()
      this.controller = follower
      this.broadcastState()
      const snapshot: TerminalFrame = { type: 'snapshot', sequence: this.sequence, screen: this.serializer.serialize(), info: this.info, writable: this.writable(follower), ...inputWindow === undefined ? {} : { inputWindow } }
      this.followers.add(follower)
      return snapshot
    })
    const uplink = input[Symbol.asyncIterator]()
    const commands = this.consumeInput(uplink, follower, limits, signal).catch((error: unknown) => {
      follower.fail(error instanceof Error ? error : new Error(String(error)))
    })
    try {
      yield baseline
      yield* follower.read(signal)
    } finally {
      this.followers.delete(follower)
      follower.close()
      if (this.controller === follower) {
        this.controller = undefined
        this.broadcastState()
      }
      // Gateway 的上行流 return 会在连接清理等待输入泵结束之前唤醒挂起的读取。
      await uplink.return?.()
      await commands
    }
  }

  private async consumeInput(input: AsyncIterator<TerminalInput>, follower: TerminalFollower, limits: Pick<TerminalEnvironment, 'maxInputBytes' | 'maxCols' | 'maxRows'>, signal: AbortSignal): Promise<void> {
    let sequence = 0
    while (true) {
      const next = await input.next()
      if (next.done === true || signal.aborted || !follower.active) return
      const command = next.value
      if (!Number.isSafeInteger(command.sequence) || command.sequence !== ++sequence) throw new Error('Terminal input sequence has a gap')
      try {
        await this.enqueue(async () => {
          signal.throwIfAborted()
          this.requireController(follower)
          switch (command.type) {
            case 'write':
              if (Buffer.byteLength(command.data, 'utf8') > limits.maxInputBytes) throw new Error('Terminal input exceeds the configured limit')
              this.retention?.invalidate()
              await this.handle.write(command.data)
              break
            case 'resize':
              if (!Number.isSafeInteger(command.cols) || command.cols < 2 || command.cols > limits.maxCols
                || !Number.isSafeInteger(command.rows) || command.rows < 1 || command.rows > limits.maxRows) throw new Error('Terminal dimensions exceed the configured limits')
              await this.handle.resize(command.cols, command.rows)
              this.screen.resize(command.cols, command.rows)
              this.info = { ...this.info, cols: command.cols, rows: command.rows }
              this.broadcastState()
              break
            /* v8 ignore next -- Gateway 编解码器会校验这个封闭联合类型。 */
            default: assertNever(command)
          }
        })
        follower.push({ type: 'ack', sequence })
      } catch (error) {
        const failure = remoteErrorOf(error)
        if (failure?.code === 'terminal/control-unavailable') {
          follower.push({ type: 'ack', sequence, refusal: failure.details.reason })
        } else if (this.exited) {
          follower.push({ type: 'ack', sequence, refusal: 'not-running' })
        } else throw error
      }
    }
  }

  private writable(follower: TerminalFollower): boolean {
    return !this.exited && this.closing === undefined && this.info.state === 'running' && this.controller === follower
  }

  private broadcastState(): void {
    for (const follower of this.followers) follower.push({ type: 'state', info: this.info, writable: this.writable(follower) })
  }

  /**
   * 向每个已连接的视图发布显示名称。
   * @param title - 已验证的用户标题。
   */
  rename(title: string): void {
    this.info = { ...this.info, title }
    this.broadcastState()
  }

  /**
   * 在释放屏幕之前终止提供方拥有的完整进程范围。
   * @returns 进程清理与最终输出排空完成后返回；失败仍可重试。
   */
  close(): Promise<void> {
    return this.retention?.close() ?? this.closeProcess()
  }

  /**
   * 停止无人值守的清理调度，并等待最终进程清理完成。
   * @returns 终端与监控都静止后返回。
   */
  dispose(): Promise<void> { return this.retention?.dispose() ?? this.closeProcess() }

  private closeProcess(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.closing = (async () => {
      await this.handle.terminate()
      await this.drained
      for (const follower of this.followers) follower.finish()
      this.followers.clear()
      this.screen.dispose()
    })().catch((error: unknown) => { this.closing = undefined; throw error })
    return this.closing
  }

  private requireController(follower: TerminalFollower): void {
    if (this.exited || this.closing !== undefined || this.info.state !== 'running') throw new RemoteError('terminal/control-unavailable', 'Terminal is not running', { reason: 'not-running' })
    if (this.controller !== follower || !follower.active) throw new RemoteError('terminal/control-unavailable', 'Terminal input is controlled by another attachment', { reason: 'read-only' })
  }

  private broadcast(frame: TerminalFrame): void {
    for (const follower of this.followers) follower.push(frame)
  }

  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const pending = this.operations.then(operation)
    this.operations = pending.catch(() => { /* 调用方拥有此次操作的失败；后续清理仍必须运行。 */ })
    return pending
  }

  private async consume(): Promise<void> {
    const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
    const outcome = this.handle.done.then((value) => { this.exited = true; return { value } }, (error: unknown) => ({ error }))
    try {
      for await (const chunk of this.handle.output) {
        // Node Readable 的迭代器没有类型；此提供方显式产出 Buffer 块。
        const data = decoder.decode(chunk as Buffer, { stream: true })
        await this.output(data)
      }
      await this.output(decoder.decode())
      const result = await outcome
      if ('error' in result) throw result.error
      this.info = { ...this.info, state: 'exited', exitCode: result.value.exitCode }
    } catch (error) {
      this.info = { ...this.info, state: 'failed', error: error instanceof Error ? error.message : String(error) }
    }
    this.broadcastState()
  }

  private async output(data: string): Promise<void> {
    if (data.length === 0) return
    await this.enqueue(async () => {
      await new Promise<void>((resolve) => { this.screen.write(data, resolve) })
      this.broadcast({ type: 'output', sequence: ++this.sequence, data })
    })
  }
}
