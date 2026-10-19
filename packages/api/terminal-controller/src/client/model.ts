/** 不依赖 React 的浏览器终端状态与可重连 Remote 流的持有权。 */
import { preferredShell, rememberShell } from './shell-preference.ts'
import type { TerminalInventory } from './inventory.ts'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Deque } from '@deepseek-ai/dsh-deque'
import { RemoteStreamCarrierError, type ClientRemote, type RemoteStream } from '@deepseek-ai/dsh-api-gateway/client'
import { RemoteError, remoteErrorOf, type RemoteResult, type RemoteStreamHandle, type RemoteUplinkWindow } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-api-terminal-controller/remote'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  TerminalInput, TerminalEnvironment, TerminalFrame,
  WebTerminalId, WebTerminalInfo,
} from '../types.ts'

/** 生成的终端命名空间中面向浏览器的操作。 */
export type TerminalRemote = ClientRemote['terminal']

/** 由终端 UI 翻译的产品错误标识。 */
export type TerminalViewIssue = 'missingTerminal' | 'inputFull' | 'attachmentEnded' | 'invalidOutput' | 'terminalLimit'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** 经 Remote 流监督器保留的 Client 终端失败。 */
    'terminal/view': { readonly issue: TerminalViewIssue }
  }
}

class TerminalViewError extends RemoteError<'terminal/view'> {
  constructor(issue: TerminalViewIssue, message: string = issue) { super('terminal/view', message, { issue }) }
}

/** 一次等待 DOM 模拟器回调的屏幕写入。 */
export interface TerminalRenderFrame {
  readonly revision: number
  readonly frame: Extract<TerminalFrame, { type: 'snapshot' | 'output' }>
}

/** 一个侧边栏出现项的可观察状态。 */
export interface TerminalViewState {
  readonly phase: 'idle' | 'loading' | 'creating' | 'connecting' | 'connected' | 'disconnected' | 'closing' | 'closed' | 'failed'
  readonly environment?: TerminalEnvironment | undefined
  readonly title?: string | undefined
  readonly info?: WebTerminalInfo | undefined
  readonly writable: boolean
  readonly render?: TerminalRenderFrame | undefined
  readonly error?: string | undefined
  readonly issue?: TerminalViewIssue | undefined
}

interface InputCost {
  readonly inputBytes: number
  readonly frameBytes: number
}

interface TerminalInputAttachment {
  readonly handle: RemoteStreamHandle<TerminalFrame, TerminalInput>
  readonly signal: AbortSignal
  sequence: number
  acknowledged: number
  readonly pending: Map<number, InputCost>
  readonly queued: Deque<InputCost & { readonly command: TerminalInput }>
  window: RemoteUplinkWindow | undefined
  bytes: number
  bufferedBytes: number
  inFlightBytes: number
}

/** 视图可在 DOM 卸载后存活；其进程仅在显式关闭时结束。 */
export class TerminalView {
  /** 可观察控制项、进程元数据，以及等待确认的下一个屏幕更新。 */
  readonly state: SnapshotStore<TerminalViewState> = createSnapshotStore<TerminalViewState>({ phase: 'idle', writable: false })
  private readonly lifetime = new AbortController()
  private stream: RemoteStream<TerminalFrame> | undefined
  private mounted = false
  private attachment: TerminalInputAttachment | undefined
  private pendingRender: { revision: number; resolve: () => void } | undefined
  private revision = 0
  private creation: Promise<void> | undefined
  private loading: Promise<void> | undefined
  private closing: Promise<void> | undefined
  private readonly detaching = new Set<Promise<void>>()

  /**
   * @param sessionId - 拥有该终端的 Session。
   * @param remote - 类型化的终端 Remote 操作。
   * @param gateway - 可重连流的工厂。
   * @param inventory - 所有视图共享的 Session 终端列表。
   * @param id - Host 终端标识；从其 Session 列表恢复条目时复用。
   * @param createWhenMissing - 仅为新标签页允许分配，绝不针对列表中的终端。
   * @param shellPath - 在引导处选择的显式 shell；省略时使用记住的可用 shell。
   * @param retain - 输出连接之前所需的窗口持有确认。
   */
  constructor(
    private readonly sessionId: SessionId,
    private readonly remote: TerminalRemote,
    private readonly gateway: Pick<ClientRemote, '$stream'>,
    private readonly inventory: TerminalInventory,
    readonly id: WebTerminalId,
    private createWhenMissing = true,
    private readonly shellPath?: string,
    private readonly retain?: (signal: AbortSignal) => Promise<void>,
  ) {}

  /**
   * 附着 DOM 生命周期，启动所选 shell 或重连已保存的进程。
   * @returns 一个让终端进程保持存活的分离回调。
   */
  mount(): () => void {
    this.mounted = true
    const state = this.state.getSnapshot()
    if (state.phase === 'idle') void this.refresh()
    else if (state.info !== undefined && state.phase !== 'failed' && state.phase !== 'closed') this.connect()
    return () => {
      this.mounted = false
      this.detach()
    }
  }

  /**
   * 启动或显式重试此标签页，与其他视图共享 Session 发现。
   * 新标识直接分配；已确认或已恢复的终端不能被替换。
   * @returns 环境查找与创建或恢复都落定后返回。
   */
  refresh(): Promise<void> {
    if (this.creation !== undefined) return this.creation
    if (this.loading !== undefined) return this.loading
    if (this.closing !== undefined || this.lifetime.signal.aborted) return Promise.resolve()
    const retry = this.state.getSnapshot().phase !== 'idle'
    this.patch({ phase: 'loading', error: undefined, issue: undefined })
    this.loading = (async () => {
      const [environment, available] = await Promise.all([
        this.remote.environment(this.sessionId, this.lifetime.signal),
        this.createWhenMissing ? undefined : this.inventory.read(retry),
      ])
      if (this.stopped()) return
      this.patch({ environment: valueOf(environment) })
      const info = available?.get(this.id)
      if (info !== undefined) this.adopt(info)
      else if (this.createWhenMissing) {
        let path = this.shellPath
        if (path === undefined) {
          const shells = valueOf(await this.remote.shells(this.sessionId, this.lifetime.signal))
          const previous = preferredShell()
          path = shells.find(shell => shell.path === previous)?.path ?? shells[0]?.path
        }
        if (this.stopped()) return
        if (path !== undefined) rememberShell(path)
        await this.create(valueOf(environment), path)
      }
      else throw new TerminalViewError('missingTerminal')
    })().catch((error: unknown) => { this.fail(error) }).finally(() => { this.loading = undefined })
    return this.loading
  }

  private stopped(): boolean { return this.lifetime.signal.aborted || this.closing !== undefined }

  private async create(environment: TerminalEnvironment, shellPath?: string): Promise<void> {
    this.patch({ phase: 'creating', error: undefined, issue: undefined })
    this.creation = (async () => {
      const info = valueOf(await this.remote.create(this.sessionId, {
        id: this.id, ...shellPath === undefined ? {} : { shellPath },
        cols: Math.min(80, environment.maxCols), rows: Math.min(24, environment.maxRows),
      }, this.lifetime.signal))
      if (!this.lifetime.signal.aborted) {
        this.inventory.update(info)
        this.adopt(info)
      }
    })().catch((error: unknown) => { this.fail(error) }).finally(() => { this.creation = undefined })
    await this.creation
  }

  private adopt(info: WebTerminalInfo): void {
    this.createWhenMissing = false
    this.patch({ info, title: info.title })
    if (this.retain === undefined) { if (this.mounted && this.closing === undefined) this.connect(); return }
    void this.retain(this.lifetime.signal).then(() => {
      if (this.mounted && this.closing === undefined) this.connect()
    }).catch((error: unknown) => { if (!this.stopped()) this.fail(error) })
  }

  /** 以全新屏幕重新附着，并重新获得输入控制。 */
  connect(): void {
    const info = this.state.getSnapshot().info
    if (info === undefined || !this.mounted || this.closing !== undefined || this.lifetime.signal.aborted) return
    this.detach()
    const stream = this.gateway.$stream<TerminalFrame>({
      name: 'Browser terminal output',
      open: async function* (this: TerminalView, signal: AbortSignal) {
        await this.retain?.(signal)
        signal.throwIfAborted()
        const handle = this.remote.attach(this.sessionId, info.id, signal)
        const attachment: TerminalInputAttachment = {
          handle, signal, sequence: 0, acknowledged: 0,
          pending: new Map(), queued: new Deque(), window: undefined,
          bytes: 0, bufferedBytes: 0, inFlightBytes: 0,
        }
        this.attachment = attachment
        try {
          for await (const frame of handle) {
            if (frame.type === 'snapshot') attachment.window = frame.inputWindow
            yield frame
          }
        }
        finally { if (this.attachment === attachment) this.attachment = undefined }
      }.bind(this),
      ended: () => new TerminalViewError('attachmentEnded'),
      carrierFailed: () => { if (this.stream === stream) this.patch({ phase: 'disconnected', writable: false }) },
    })
    this.stream = stream
    this.patch({ phase: 'connecting', writable: false, error: undefined, issue: undefined, render: undefined })
    void this.consume(stream)
  }

  /**
   * 在 xterm 解析此帧之后释放下一个流条目。
   * @param revision - 本地已交付的渲染修订号。
   */
  acknowledge(revision: number): void {
    if (this.pendingRender?.revision !== revision) return
    this.pendingRender.resolve()
    this.pendingRender = undefined
  }

  /**
   * 在原始 UTF-8 与编码帧预算内将输入入队，等待载体容量。
   * @param data - 来自终端模拟器的输入；断开后绝不重放。
   */
  write(data: string): void {
    const state = this.state.getSnapshot()
    const attachment = this.attachment
    if (!state.writable || state.info === undefined || attachment === undefined || attachment.signal.aborted) return
    if (data.length === 0) return
    const bytes = new TextEncoder().encode(data).byteLength
    if (attachment.bytes + bytes > (state.environment?.maxInputBytes ?? 0)) { this.failInput(new TerminalViewError('inputFull')); return }
    this.send(attachment, { type: 'write', sequence: attachment.sequence + 1, data }, bytes)
  }

  /**
   * 仅从当前可写的视图调整尺寸，与键盘输入保持有序。
   * @param cols - 测得的列数。
   * @param rows - 测得的行数。
   */
  resize(cols: number, rows: number): void {
    const state = this.state.getSnapshot()
    const attachment = this.attachment
    if (!state.writable || state.info === undefined || attachment === undefined || attachment.signal.aborted) return
    if (state.info.cols === cols && state.info.rows === rows) return
    cols = Math.min(cols, state.environment?.maxCols ?? cols)
    rows = Math.min(rows, state.environment?.maxRows ?? rows)
    this.send(attachment, { type: 'resize', sequence: attachment.sequence + 1, cols, rows }, 0)
  }

  private send(attachment: TerminalInputAttachment, command: TerminalInput, bytes: number): void {
    const frameBytes = new TextEncoder().encode(JSON.stringify(command)).byteLength + (attachment.window?.frameOverheadBytes ?? 0)
    if (attachment.bufferedBytes + frameBytes > (this.state.getSnapshot().environment?.maxBufferedBytes ?? 0)
      || (attachment.window !== undefined && frameBytes > attachment.window.maxBytes)) {
      this.failInput(new TerminalViewError('inputFull'))
      return
    }
    attachment.queued.pushBack({ command, inputBytes: bytes, frameBytes })
    attachment.sequence = command.sequence
    attachment.bytes += bytes
    attachment.bufferedBytes += frameBytes
    this.flushInput(attachment)
  }

  private flushInput(attachment: TerminalInputAttachment): void {
    while (this.attachment === attachment && !attachment.signal.aborted && this.state.getSnapshot().writable) {
      const next = attachment.queued.popFront()
      if (next === undefined) return
      if (attachment.window !== undefined && attachment.inFlightBytes + next.frameBytes > attachment.window.maxBytes) {
        attachment.queued.pushFront(next)
        return
      }
      try { attachment.handle.send(next.command) }
      catch (error) { this.failInput(error); return }
      attachment.pending.set(next.command.sequence, { inputBytes: next.inputBytes, frameBytes: next.frameBytes })
      attachment.inFlightBytes += next.frameBytes
    }
  }

  private failInput(error: unknown): void {
    this.fail(error)
    this.detach()
  }

  /**
   * 更新 Host 终端的显示名称。
   * @param title - 用户输入的终端标题。
   * @returns 重命名落定且其结果反映到视图状态之后。
   */
  async rename(title: string): Promise<void> {
    if (title.trim() === this.state.getSnapshot().title || this.lifetime.signal.aborted) return
    try {
      valueOf(await this.remote.rename(this.sessionId, this.id, title))
      if (this.stopped()) return
      const current = this.state.getSnapshot().info
      if (current !== undefined) this.inventory.update({ ...current, title: title.trim() })
      this.patch({ ...(current === undefined ? {} : { info: { ...current, title: title.trim() } }), title: title.trim() })
    } catch (error) { this.fail(error) }
  }

  /**
   * 独立于其 DOM 生命周期显式终止此视图的进程。
   * @returns Host 进程清理成功后返回；失败仍可由拥有者重试。
   */
  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.patch({ phase: 'closing', writable: false, error: undefined, issue: undefined })
    this.detach()
    this.closing = (async () => {
      // 即使创建响应被拒绝或丢失，也可能留下待关闭的分配。
      await this.creation
      valueOf(await this.remote.close(this.sessionId, this.id))
      this.inventory.remove(this.id)
      this.detach()
      this.patch({ phase: 'closed', writable: false })
    })().catch((error: unknown) => { this.closing = undefined; this.fail(error); throw error })
    return this.closing
  }

  /**
   * 插件卸载时停止 Client 侧工作，而不关闭 Host 终端。
   * @returns 活动与先前分离的流迭代器都关闭之后。
   */
  async dispose(): Promise<void> {
    this.mounted = false
    this.lifetime.abort()
    this.detach()
    await Promise.all(this.detaching)
  }

  private detach(): void {
    const previous = this.stream
    this.stream = undefined
    this.attachment = undefined
    this.pendingRender?.resolve()
    this.pendingRender = undefined
    if (previous !== undefined) {
      const cleanup = previous.dispose().finally(() => { this.detaching.delete(cleanup) })
      this.detaching.add(cleanup)
    }
  }

  private async consume(stream: RemoteStream<TerminalFrame>): Promise<void> {
    let generation = 0
    let sequence = 0
    try {
      for await (const item of stream) {
        if (this.stream !== stream) return
        const frame = item.value
        if (generation !== item.generation) {
          if (frame.type !== 'snapshot') throw new TerminalViewError('invalidOutput', 'Terminal output generation is missing its screen snapshot')
          generation = item.generation
          sequence = frame.sequence
          item.accept()
        } else if (frame.type === 'output') {
          if (frame.sequence !== sequence + 1) throw new TerminalViewError('invalidOutput', 'Terminal output sequence has a gap')
          sequence = frame.sequence
        } else if (frame.type === 'snapshot') throw new TerminalViewError('invalidOutput', 'Unexpected terminal screen snapshot')
        if (frame.type === 'ack') {
          const attachment = this.attachment
          /* v8 ignore next -- 物理打开方会保留其句柄，直到此消费方推进。 */
          if (attachment === undefined) throw new TerminalViewError('invalidOutput', 'Terminal acknowledgement has no attachment')
          const pending = attachment.pending.get(frame.sequence)
          if (frame.sequence !== attachment.acknowledged + 1 || pending === undefined) throw new TerminalViewError('invalidOutput', 'Terminal input acknowledgement is out of order')
          attachment.acknowledged = frame.sequence
          attachment.bytes -= pending.inputBytes
          attachment.bufferedBytes -= pending.frameBytes
          attachment.inFlightBytes -= pending.frameBytes
          attachment.pending.delete(frame.sequence)
          if (frame.refusal !== undefined) this.patch({ writable: false })
          this.flushInput(attachment)
          continue
        }
        if (frame.type !== 'output') {
          this.inventory.update(frame.info)
          this.patch({ info: frame.info, title: frame.info.title, phase: 'connected', writable: frame.info.state === 'running' && frame.writable })
        }
        if (frame.type !== 'state') {
          const revision = ++this.revision
          await new Promise<void>((resolve) => {
            this.pendingRender = { revision, resolve }
            const aborted = (): void => { this.acknowledge(revision) }
            item.signal.addEventListener('abort', aborted, { once: true })
            this.pendingRender.resolve = () => { item.signal.removeEventListener('abort', aborted); resolve() }
            this.patch({ render: { revision, frame } })
            if (item.signal.aborted) aborted()
          })
        }
      }
    } catch (error) {
      if (this.stream === stream) {
        if (this.state.getSnapshot().info?.state === 'exited') this.patch({ phase: 'closed', writable: false })
        else this.fail(error)
      }
    }
  }

  private patch(patch: Partial<TerminalViewState>): void {
    if (this.lifetime.signal.aborted) return
    this.state.set({ ...this.state.getSnapshot(), ...patch })
  }

  private fail(error: unknown): void {
    const failure = remoteErrorOf(error)
    const issue = failure?.code === 'terminal/view' ? failure.details.issue : failure?.code === 'terminal/limit-reached' ? 'terminalLimit' : failure?.code === 'terminal/unavailable' ? 'missingTerminal' : undefined
    if (!this.stopped() && issue === 'missingTerminal') this.inventory.remove(this.id)
    this.patch({ phase: error instanceof RemoteStreamCarrierError ? 'disconnected' : 'failed', writable: false, issue, error: error instanceof Error ? error.message : String(error) })
  }
}

function valueOf<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw result.error
  return result.value
}
