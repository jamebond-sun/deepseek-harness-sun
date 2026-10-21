/** 具有有界输出、就绪判定与终端协议应答的持久化 PTY 会话。 */

import { Buffer } from 'node:buffer'
import type { IDisposable, Terminal as HeadlessTerminalType } from '@xterm/headless'
import { createLazyRequire } from '@deepseek-ai/dsh-lazy-require'
import type {
  SubprocessOutcome,
  SubprocessTerminalForeground,
  SubprocessTerminalHandle,
} from '@deepseek-ai/dsh-subprocess'
import { TerminalError } from '@deepseek-ai/dsh-terminal'
import type {
  TerminalBackendSession,
  TerminalReadRequest,
  TerminalReadResult,
  TerminalSendOperation,
  TerminalSendRead,
  TerminalSendRequest,
  TerminalSendResult,
  TerminalSessionStatus,
  TerminalSignal,
  TerminalSignalResult,
  TerminalWaitReason,
} from '@deepseek-ai/dsh-terminal'
import type { ResolvedConfig } from './config.ts'
import { CONTROLLED_PROMPT, TerminalSanitizer } from './sanitize.ts'

const requireHeadless = createLazyRequire<typeof import('@xterm/headless')>('@xterm/headless', import.meta.url)

function utf8Tail(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false }
  const chars = Array.from(text)
  let bytes = 0
  let start = chars.length
  while (start > 0) {
    const next = Buffer.byteLength(chars[start - 1] as string)
    if (bytes + next > maxBytes) break
    bytes += next
    start -= 1
  }
  return { text: chars.slice(start).join(''), truncated: true }
}

// 独立地约束待定字符串片段，不受部署侧保留上限的影响。
const COALESCED_CHUNK_UNITS = 4096

interface TextChunk {
  text: string
  start: number
  next: TextChunk | undefined
}

/** 保留工作在追加文本时被平摊；读取时再拼装保留下来的分块。 */
class BoundedTextBuffer {
  private head: TextChunk | undefined
  private tail: TextChunk | undefined
  private bytes = 0
  private newlines = 0
  private lastCodeUnit = 0
  private dropped = false

  constructor(
    private readonly maxBytes: number,
    private readonly maxLines?: number,
  ) {}

  get truncated(): boolean {
    return this.dropped
  }

  get isEmpty(): boolean {
    return this.head === undefined
  }

  append(text: string): void {
    if (text.length === 0) return
    // 已清理文本可能是一段保留了被丢弃控制字符的切片；以 UTF-16 复制而不替换孤立代理项。
    text = Buffer.from(text, 'utf16le').toString('utf16le')
    this.bytes += Buffer.byteLength(text)
    const tail = this.tail
    if (tail !== undefined) {
      const last = this.lastCodeUnit
      const first = text.charCodeAt(0)
      // 拼接可能把两个三字节的孤立代理项合成一个四字节码点。
      if (last >= 0xd800 && last <= 0xdbff && first >= 0xdc00 && first <= 0xdfff) this.bytes -= 2
    }
    for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
      this.newlines += 1
    }
    this.lastCodeUnit = text.charCodeAt(text.length - 1)
    // 头分块不会增长，因此淘汰时永远不会重新扫描一个不断增长的字符串。
    if (tail !== undefined && tail !== this.head && tail.text.length + text.length <= COALESCED_CHUNK_UNITS) {
      tail.text += text
    } else {
      if (tail !== undefined && tail.text.length <= COALESCED_CHUNK_UNITS) {
        // 将已合并的片段复制到同一个字符串中；大尾部已经拥有自己的存储。
        tail.text = Buffer.from(tail.text, 'utf16le').toString('utf16le')
      }
      const chunk: TextChunk = { text, start: 0, next: undefined }
      if (tail === undefined) this.head = chunk
      else tail.next = chunk
      this.tail = chunk
    }

    while (this.head !== undefined
      && (this.bytes > this.maxBytes || (this.maxLines !== undefined && this.newlines >= this.maxLines))) {
      const head = this.head
      const first = head.text.charCodeAt(head.start)
      const second = head.start + 1 < head.text.length
        ? head.text.charCodeAt(head.start + 1)
        : head.next?.text.charCodeAt(0)
      const paired = first >= 0xd800 && first <= 0xdbff
        && second !== undefined && second >= 0xdc00 && second <= 0xdfff
      this.bytes -= paired ? 4 : first < 0x80 ? 1 : first < 0x800 ? 2 : 3
      if (first === 10) this.newlines -= 1
      this.advance(paired ? 2 : 1)
      this.dropped = true
    }
    const head = this.head
    if (head !== undefined && head.start >= head.text.length / 2) {
      // 逐字复制 UTF-16，以免一个小的后缀留住了超大输入的底层存储。
      // 仅在丢弃至少一半之后才复制，可让这部分工作在被丢弃文本上保持平摊。
      head.text = Buffer.from(head.text.slice(head.start), 'utf16le').toString('utf16le')
      head.start = 0
    }
  }

  private advance(units: number): void {
    while (units > 0 && this.head !== undefined) {
      const head = this.head
      const count = Math.min(units, head.text.length - head.start)
      head.start += count
      units -= count
      if (head.start === head.text.length) this.head = head.next
    }
    if (this.head === undefined) this.tail = undefined
  }

  consume(): TerminalSendRead {
    const { text: delta, truncated } = this.snapshot()
    this.head = undefined
    this.tail = undefined
    this.bytes = 0
    this.newlines = 0
    this.dropped = false
    return { delta, truncated }
  }

  snapshot(): { text: string; truncated: boolean } {
    const chunks: string[] = []
    for (let chunk = this.head; chunk !== undefined; chunk = chunk.next) {
      chunks.push(chunk.text.slice(chunk.start))
    }
    return { text: chunks.join(''), truncated: this.dropped }
  }
}

class LocalSendOperation implements TerminalSendOperation {
  private readonly output: BoundedTextBuffer
  private readonly promise: PromiseWithResolvers<TerminalSendResult>
  private finished = false
  private cancellationRequested = false
  private initialForegroundLeftWait: boolean
  private initialForegroundPgid: number | undefined

  constructor(
    maxBytes: number,
    readonly startedAt: number,
    private readonly onCancel: () => void,
  ) {
    this.output = new BoundedTextBuffer(maxBytes)
    this.promise = Promise.withResolvers<TerminalSendResult>()
    this.initialForegroundLeftWait = true
  }

  get done(): Promise<TerminalSendResult> {
    return this.promise.promise
  }

  get settled(): boolean {
    return this.finished
  }

  get cancelRequested(): boolean {
    return this.cancellationRequested
  }

  append(text: string): void {
    if (!this.finished) this.output.append(text)
  }

  settle(waitReason: TerminalWaitReason, sessionStatus: TerminalSessionStatus, inheritedTruncation: boolean): void {
    if (this.finished) return
    this.finished = true
    const read = this.output.snapshot()
    this.promise.resolve({
      viewport: read.text,
      waitReason,
      sessionStatus,
      truncated: read.truncated || inheritedTruncation,
    })
  }

  fail(error: unknown): void {
    if (this.finished) return
    this.finished = true
    this.promise.reject(error)
  }

  readOutput(): TerminalSendRead {
    return this.output.consume()
  }

  setInitialForeground(foreground: SubprocessTerminalForeground | undefined): void {
    this.initialForegroundPgid = foreground?.processGroupId
    this.initialForegroundLeftWait = foreground?.inputWaiting !== true
  }

  acceptsStdinWait(pgid: number, waiting: boolean): boolean {
    // 同一进程组仍可能暴露 terminal.write 之前就存在的等待。
    // 观察每一次轮询，使得在精确结算阈值之前的离开，仍能构成写入之后
    // 回到该等待状态的证据。
    if (pgid !== this.initialForegroundPgid) return waiting
    if (!waiting) this.initialForegroundLeftWait = true
    return waiting && this.initialForegroundLeftWait
  }

  cancel(): boolean {
    if (this.finished) return false
    this.cancellationRequested = true
    this.onCancel()
    return true
  }
}

/** Backend session wrapping one provider-owned terminal process. */
export class LocalPtySession implements TerminalBackendSession {
  motd = ''
  readonly pid: number
  private readonly decoder = new TextDecoder()
  /** 仅用于协议状态；已清理文本与有界缓冲区才真正持有返回的文本内容。 */
  private readonly emulator: HeadlessTerminalType
  private readonly emulatorData: IDisposable
  private readonly sanitizer: TerminalSanitizer
  private readonly scrollback: BoundedTextBuffer
  private readonly outputEnded = Promise.withResolvers<void>()
  private readonly completion: Promise<void>
  private statusValue: TerminalSessionStatus = { kind: 'running' }
  // TODO(pty-send-state-consolidation): 将下方每个发送相关的字段
  // （active/activeTimer/activeDeadlineTimer/activeAbort/interrupting/
  // activeWrite/pollingReady/polling 以及终端协议相关工作）合并到单一的发送生命周期
  // 拥有者中；取消/就绪之间的相互作用已有足够的固定测试，足以安全地承载该重构。
  private active: LocalSendOperation | undefined
  private activeTimer: NodeJS.Timeout | undefined
  private activeDeadlineTimer: NodeJS.Timeout | undefined
  private activeAbort: (() => void) | undefined
  private interrupting: LocalSendOperation | undefined
  private activeWrite: Promise<boolean> | undefined
  private pollingReady: LocalSendOperation | undefined
  private polling = false
  private promptSeen = false
  private promptTextSeen = false
  private promptTail = ''
  private shellPgid: number | undefined
  private initializing = false
  private lastOutputAt = Date.now()
  private closing = false
  private closePromise: Promise<void> | undefined
  private transportFailure: Error | undefined
  private emulatorWrites = Promise.resolve()
  private emulatorWriteDone: (() => void) | undefined
  private emulatorBuffer = ''
  private emulatorWriting = false
  private responseWrites = Promise.resolve()
  private pendingResponseWrites = 0
  private emulatorClosed = false

  constructor(
    private readonly terminal: SubprocessTerminalHandle,
    private readonly config: ResolvedConfig,
  ) {
    this.pid = terminal.pid
    const { Terminal: HeadlessTerminal } = requireHeadless()
    this.emulator = new HeadlessTerminal({ cols: config.cols, rows: config.rows, scrollback: 0 })
    this.emulatorData = this.emulator.onData((data) => {
      this.pendingResponseWrites += 1
      const response = this.responseWrites.then(async () => { await this.terminal.write(data) })
      this.responseWrites = response.then(
        () => { this.finishResponseWrite() },
        (error: unknown) => {
          this.finishResponseWrite()
          if (!this.emulatorClosed && !this.closing) this.onTransportFailure(error)
        },
      )
    })
    this.sanitizer = new TerminalSanitizer(config.maxReadBytes)
    this.scrollback = new BoundedTextBuffer(config.scrollbackMaxBytes, config.scrollbackLines)
    terminal.output.on('data', this.onTerminalData)
    terminal.output.once('end', this.onTerminalEnd)
    terminal.output.once('error', this.onTerminalError)
    this.completion = terminal.done.then(
      outcome => this.onExit(outcome),
      (error: unknown) => { this.onTransportFailure(error) },
    )
  }

  /**
   * 通过和后续发送相同的就绪契约来捕获启动输出。
   * @param signal - 在 shell 抵达首个提示符期间的可选取消信号。
   * @returns 启动就绪后兑现；在退出或就绪超时时拒绝。
   */
  async initialize(signal?: AbortSignal): Promise<void> {
    this.initializing = true
    try {
      const operation = this.startSend({ text: '', submit: false, ...signal !== undefined ? { signal } : {} })
      const result = await operation.done
      if (result.waitReason === 'session_exit') throw new Error('PTY shell exited during startup')
      if (result.waitReason === 'timeout') throw new Error('PTY shell did not reach readiness before startup timeout')
      this.motd = result.viewport
    } catch (error: unknown) {
      signal?.throwIfAborted()
      throw error
    } finally {
      this.initializing = false
    }
  }

  startSend(request: TerminalSendRequest): TerminalSendOperation {
    if (this.closing) throw new Error('PTY session is closing')
    if (this.statusValue.kind === 'exited') throw new Error('PTY session has exited')
    if (this.active !== undefined) {
      const draining = this.activeWrite !== undefined
        ? ' or draining provider write'
        : this.interrupting !== undefined
          ? ' or draining foreground interrupt'
          : ''
      throw new TerminalError(`PTY session already has an active send${draining}`, 'SEND_ACTIVE')
    }
    if (request.signal?.aborted === true) throw new Error('PTY send aborted before write')

    const operation = new LocalSendOperation(
      this.config.maxReadBytes,
      Date.now(),
      () => { this.interrupt(operation) },
    )
    this.active = operation
    this.resetReadinessEvidence()

    if (request.signal !== undefined) {
      const onAbort = (): void => { operation.cancel() }
      request.signal.addEventListener('abort', onAbort, { once: true })
      this.activeAbort = () => request.signal?.removeEventListener('abort', onAbort)
    }
    this.activeDeadlineTimer = setTimeout(() => {
      if (this.active === operation) {
        this.settleActive('timeout', this.activeWrite !== undefined
          || this.interrupting === operation
          || this.protocolWorkPending())
      }
    }, this.config.timeoutMs)
    void this.beginSend(operation, request)
    return operation
  }

  private async beginSend(operation: LocalSendOperation, request: TerminalSendRequest): Promise<void> {
    let foreground: SubprocessTerminalForeground | undefined
    try {
      if (this.protocolWorkPending()) await this.drainTerminalProtocol()
      const emulatorWrites = this.emulatorWrites
      const responseWrites = this.responseWrites
      foreground = await this.terminal.inspectForeground()
      if (this.protocolStateChanged(emulatorWrites, responseWrites)) {
        foreground = await this.inspectForegroundAfterProtocol()
      }
    } catch (error: unknown) {
      if (this.protocolWorkPending()) await this.drainTerminalProtocol()
      // 在取消信号持有该槽位时发生写前检查失败，绝不能释放它：interruptOnce
      // 正在飞行的 FG 信号可能落到后继的 FG 进程组上。中断路径在信号之后的尾部
      // 会恢复轮询，其受保护的 catch 会传播一个持久性失败。一个被保留的已结算
      // 操作意味着同一个正在飞行的中断，因此本守卫只接纳尚未结算的活动发送。
      if (this.active === operation && !this.closing && this.interrupting !== operation) {
        this.failActive(error)
      }
      return
    }
    try {
      if (this.active !== operation || this.closing || this.interrupting === operation) return
      operation.setInitialForeground(foreground)
      const input = `${request.text}${request.submit ? '\r' : ''}`
      if (input.length > 0 && !operation.cancelRequested) {
        this.resetReadinessEvidence()
        const write = this.terminal.write(input)
        this.activeWrite = write.then(() => true, () => false)
        try {
          await write
        } finally {
          this.activeWrite = undefined
        }
      }
      // 取消信号负责写后信令与槽位释放。
      if (operation.cancelRequested) return
      if (this.active === operation && operation.settled) {
        this.releaseSettledActive()
        return
      }
      // 尽管静态分析只看到局部赋值，关闭仍可能与被 await 的提供者写入产生竞态。
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- 被 await 的提供者写入可能会关闭会话。
      if (this.active === operation && !this.closing) {
        this.pollingReady = operation
        this.schedulePoll(operation)
      }
    } catch (error: unknown) {
      if (this.active === operation && !this.closing) {
        if (operation.settled) this.releaseSettledActive()
        else this.failActive(error)
      }
    }
  }

  private resetReadinessEvidence(): void {
    this.lastOutputAt = Date.now()
    this.promptSeen = false
    this.promptTextSeen = false
    this.promptTail = ''
  }

  read(request: TerminalReadRequest): TerminalReadResult {
    const snapshot = this.scrollback.snapshot()
    const lines = snapshot.text.split('\n')
    const totalLines = snapshot.text.length === 0 ? 0 : lines.length
    const offset = request.offset ?? 0
    const count = request.count ?? 500
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('PTY read offset must be a non-negative safe integer')
    if (!Number.isSafeInteger(count) || count <= 0) throw new Error('PTY read count must be a positive safe integer')
    if (offset >= totalLines) {
      return { text: '', totalLines, lineBegin: offset, lineEnd: offset, truncated: snapshot.truncated }
    }
    const end = totalLines - offset
    const start = Math.max(0, end - count)
    const requested = lines.slice(start, end).join('\n')
    const bounded = utf8Tail(requested, this.config.maxReadBytes)
    const returnedLines = bounded.text.length === 0 ? 0 : bounded.text.split('\n').length
    return {
      text: bounded.text,
      totalLines,
      lineBegin: offset,
      lineEnd: offset + returnedLines,
      truncated: snapshot.truncated || bounded.truncated,
    }
  }

  async signal(signal: TerminalSignal): Promise<TerminalSignalResult> {
    if (this.closing) throw new Error('PTY session is closing')
    const targetPgid = await this.terminal.signalForeground(signal)
    return { delivered: true, targetPgid }
  }

  status(): TerminalSessionStatus {
    return this.statusValue
  }

  close(reason: string): Promise<void> {
    this.closing = true
    if (this.closePromise !== undefined) return this.closePromise
    const closing = this.closeOnce(reason).catch((error: unknown) => {
      this.closePromise = undefined
      this.failActive(error)
      throw error
    })
    this.closePromise = closing
    return closing
  }

  private readonly onTerminalData = (chunk: Buffer | Uint8Array | string): void => {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    const data = this.decoder.decode(bytes, { stream: true })
    this.queueEmulatorData(data)
    this.onData(data)
  }

  private readonly onTerminalEnd = (): void => {
    this.onData(this.decoder.decode())
    this.appendOutput(this.sanitizer.flush())
    this.closeEmulator()
    this.outputEnded.resolve()
  }

  private readonly onTerminalError = (error: Error): void => {
    this.closeEmulator()
    this.onTransportFailure(error)
    this.outputEnded.resolve()
  }

  private onData(data: string): void {
    const sanitized = this.sanitizer.push(data)
    this.appendOutput(sanitized.text)
    if (sanitized.prompt) {
      // TODO(pty-delayed-signal-prompt): 在能稳定复现的前提下，界定一个标记生成边界，
      // 再把“信号延迟导致的提示符”归因到后续发送之前先明确它。
      // bash 可能在内核将返回值发布到前台进程组之前就打印 PROMPT_COMMAND。
      // 保留该标记；下面的轮询才是权威，它只在 bash 拥有前台后才接受该标记。
      this.promptSeen = true
      this.promptTail = ''
      this.lastOutputAt = Date.now()
    }
    if (this.promptSeen && sanitized.promptTail !== undefined) {
      const remaining = Math.max(0, CONTROLLED_PROMPT.length + 1 - this.promptTail.length)
      this.promptTail += sanitized.promptTail.slice(0, remaining)
      if (sanitized.promptTail.length > remaining) this.promptTail = `${CONTROLLED_PROMPT}\0`
      this.promptTextSeen = this.promptTail === CONTROLLED_PROMPT
    }
  }

  private async onExit(outcome: SubprocessOutcome): Promise<void> {
    await this.outputEnded.promise
    if (this.transportFailure !== undefined) return
    this.statusValue = { kind: 'exited', exitCode: outcome.exitCode, signal: outcome.signal }
    this.settleActive('session_exit')
  }

  private onTransportFailure(error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error))
    this.transportFailure ??= failure
    this.statusValue = { kind: 'exited', exitCode: null, signal: null }
    this.closeEmulator()
    this.failActive(failure)
    void this.terminal.terminate().catch(() => {})
  }

  private appendOutput(text: string): void {
    if (text.length === 0) return
    this.lastOutputAt = Date.now()
    this.scrollback.append(text)
    this.active?.append(text)
  }

  private schedulePoll(operation: LocalSendOperation, delayMs = this.config.pollIntervalMs): void {
    if (this.active !== operation || this.interrupting === operation || this.polling) return
    if (this.activeTimer !== undefined) clearTimeout(this.activeTimer)
    this.activeTimer = setTimeout(() => {
      this.activeTimer = undefined
      void this.pollReadiness(operation)
    }, delayMs)
  }

  private async pollReadiness(operation: LocalSendOperation): Promise<void> {
    if (this.active !== operation || this.polling) return
    this.polling = true
    try {
      if (this.statusValue.kind === 'exited') {
        this.settleActive('session_exit')
        return
      }
      if (this.protocolWorkPending()) await this.drainTerminalProtocol()
      const emulatorWrites = this.emulatorWrites
      const responseWrites = this.responseWrites
      let foreground = await this.terminal.inspectForeground()
      if (this.protocolStateChanged(emulatorWrites, responseWrites)) {
        foreground = await this.inspectForegroundAfterProtocol()
      }
      if (this.active !== operation || this.closing || this.interrupting === operation) return
      const idleFor = Date.now() - this.lastOutputAt
      if (this.promptSeen && foreground !== undefined && this.shellPgid === undefined) {
        this.shellPgid = foreground.processGroupId
      }
      if (this.promptSeen && this.promptTextSeen && idleFor >= this.config.pollIntervalMs
        && foreground?.processGroupId === this.shellPgid) {
        this.settleActive('stdin_read')
        return
      }
      const elapsed = Date.now() - operation.startedAt
      const startupHasOutput = !this.initializing || !this.scrollback.isEmpty
      const acceptsStdinWait = startupHasOutput && foreground !== undefined
        && operation.acceptsStdinWait(foreground.processGroupId, foreground.inputWaiting)
      if (elapsed >= this.config.exactProbeAfterMs && acceptsStdinWait) {
        this.settleActive('stdin_read')
        return
      }
      // 一个提示符候选可能与 bash 的前台交接产生竞态，但交互式子进程也会继承
      // PROMPT_COMMAND。因此静默仍是等待 shell 拥有前台的上限，而不是让子进程
      // 标记把就绪压制到绝对超时为止。
      const handoffGrace = this.promptSeen ? this.config.handoffGraceMs : 0
      // 一个已出现、但其可打印尾部尚未到达的标记，正是提示函数自身证明 shell 已抵达
      // 提示符的证据：尾部由同一渲染写出，因此在边界内缺失尾部只是投递延迟，而非提示符
      // 缺失。配置中的容差只为该状态在精确路径上挂起发送：一个已到达、随后又被后续输出
      // 失效的尾部无法再完成，因此它仍保持普通边界。零值将边界保持在
      // `idleSilenceMs + handoffGraceMs`。
      const tailPending = this.promptSeen && !this.promptTextSeen && CONTROLLED_PROMPT.startsWith(this.promptTail)
      const tailGrace = tailPending ? this.config.promptTailGraceMs : 0
      if (startupHasOutput && idleFor >= this.config.idleSilenceMs + handoffGrace + tailGrace) {
        this.settleActive('inferred_idle')
      }
    } catch (error: unknown) {
      if (this.protocolWorkPending()) await this.drainTerminalProtocol()
      if (this.active === operation && !this.closing && this.interrupting !== operation) this.failActive(error)
    } finally {
      this.polling = false
      const active = this.active
      // 尽管静态分析看不到，被 await 的提供者检查仍可能清除或替换活动发送。
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- 被 await 的检查可能替换活动发送。
      if (active !== undefined && this.pollingReady === active) this.schedulePoll(active)
    }
  }

  /** 在另一个发送可以发布之前，等待已生成的应答抵达提供者。 */
  private async drainTerminalProtocol(): Promise<void> {
    for (;;) {
      const emulatorWrites = this.emulatorWrites
      await emulatorWrites
      const responseWrites = this.responseWrites
      await responseWrites
      if (emulatorWrites === this.emulatorWrites && responseWrites === this.responseWrites
        && !this.protocolWorkPending()) return
    }
  }

  /** 仅在整个检查期间协议应答都已平静之后，才采样前台状态。 */
  private async inspectForegroundAfterProtocol(): Promise<SubprocessTerminalForeground | undefined> {
    for (;;) {
      if (this.protocolWorkPending()) await this.drainTerminalProtocol()
      const emulatorWrites = this.emulatorWrites
      const responseWrites = this.responseWrites
      const foreground = await this.terminal.inspectForeground()
      if (!this.protocolStateChanged(emulatorWrites, responseWrites)) return foreground
    }
  }

  private protocolStateChanged(emulatorWrites: Promise<void>, responseWrites: Promise<void>): boolean {
    return emulatorWrites !== this.emulatorWrites || responseWrites !== this.responseWrites
      || this.protocolWorkPending()
  }

  private protocolWorkPending(): boolean {
    return this.emulatorWriteDone !== undefined || this.pendingResponseWrites > 0
  }

  private queueEmulatorData(data: string): void {
    if (this.emulatorClosed) return
    this.emulatorBuffer += data
    if (this.emulatorWriteDone === undefined) {
      const idle = Promise.withResolvers<undefined>()
      this.emulatorWrites = idle.promise
      this.emulatorWriteDone = () => { idle.resolve(undefined) }
    }
    this.pumpEmulator()
  }

  private pumpEmulator(): void {
    if (this.emulatorWriting || this.emulatorClosed) return
    if (this.emulatorBuffer.length === 0) {
      const done = this.emulatorWriteDone
      this.emulatorWriteDone = undefined
      done?.()
      this.releaseSettledActive()
      return
    }
    const data = this.emulatorBuffer
    this.emulatorBuffer = ''
    this.emulatorWriting = true
    try {
      this.emulator.write(data, () => {
        this.emulatorWriting = false
        this.pumpEmulator()
      })
    } catch (error: unknown) {
      this.emulatorWriting = false
      this.emulatorBuffer = ''
      const done = this.emulatorWriteDone
      this.emulatorWriteDone = undefined
      done?.()
      this.releaseSettledActive()
      if (!this.closing) this.onTransportFailure(error)
    }
  }

  private finishResponseWrite(): void {
    this.pendingResponseWrites -= 1
    this.releaseSettledActive()
  }

  private releaseSettledActive(): void {
    const operation = this.active
    if (operation === undefined || !operation.settled || this.activeWrite !== undefined
      || this.interrupting === operation || this.protocolWorkPending()) return
    this.clearActive()
  }

  private closeEmulator(): void {
    if (this.emulatorClosed) return
    this.emulatorClosed = true
    this.emulatorBuffer = ''
    this.emulatorWriting = false
    const done = this.emulatorWriteDone
    this.emulatorWriteDone = undefined
    done?.()
    this.emulatorData.dispose()
    this.emulator.dispose()
  }

  private settleActive(waitReason: TerminalWaitReason, retainOwnership = false): void {
    const operation = this.active
    if (operation === undefined) return
    const scrollbackTruncated = this.scrollback.truncated
    if (retainOwnership) {
      this.stopPolling()
      this.activeAbort?.()
      this.activeAbort = undefined
    } else {
      this.clearActive()
    }
    operation.settle(waitReason, this.statusValue, scrollbackTruncated)
  }

  private stopPolling(): void {
    this.stopReadinessPolling()
    if (this.activeDeadlineTimer !== undefined) clearTimeout(this.activeDeadlineTimer)
    this.activeDeadlineTimer = undefined
  }

  private stopReadinessPolling(): void {
    if (this.activeTimer !== undefined) clearTimeout(this.activeTimer)
    this.activeTimer = undefined
    this.pollingReady = undefined
  }

  private clearActive(): void {
    const operation = this.active
    this.stopPolling()
    this.activeAbort?.()
    this.activeAbort = undefined
    if (this.interrupting === operation) this.interrupting = undefined
    this.pollingReady = undefined
    this.active = undefined
  }

  private failActive(error: unknown): void {
    const operation = this.active
    if (operation === undefined) return
    this.clearActive()
    operation.fail(error)
  }

  private interrupt(operation: LocalSendOperation): void {
    if (this.active !== operation) return
    this.interrupting = operation
    this.stopReadinessPolling()
    void this.interruptOnce(operation)
  }

  private async interruptOnce(operation: LocalSendOperation): Promise<void> {
    try {
      const activeWrite = this.activeWrite
      if (activeWrite !== undefined && !await activeWrite) return
      await this.terminal.signalForeground('SIGINT')
    } catch (error: unknown) {
      if (this.active === operation && !this.closing) this.onTransportFailure(error)
      return
    } finally {
      if (this.interrupting === operation) this.interrupting = undefined
    }
    if (this.active === operation && operation.settled) {
      this.releaseSettledActive()
    } else if (this.active === operation && !this.closing) {
      this.pollingReady = operation
      this.schedulePoll(operation, 0)
    }
  }

  private async closeOnce(reason: string): Promise<void> {
    // 停止就绪轮询但保留活动操作：下面的拆除会把它结算为 session_exit，
    // 因此在宽限期内，一个正在飞行的发送绝不会被错误地结算为
    // stdin_read/inferred_idle/timeout。
    this.stopPolling()
    this.closeEmulator()
    try {
      await this.terminal.terminate()
    } catch (error: unknown) {
      throw new Error(`PTY cleanup failed (${reason})`, { cause: error })
    }
    // 静止状态即为活动发送的最终结果。
    this.settleActive('session_exit')
    await this.completion
    this.terminal.output.off('data', this.onTerminalData)
    this.terminal.output.off('end', this.onTerminalEnd)
    this.terminal.output.off('error', this.onTerminalError)
    if (this.transportFailure !== undefined) throw this.transportFailure
  }
}
