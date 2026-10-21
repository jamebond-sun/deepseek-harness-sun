/** 针对 subprocess 能力 seam 的本地 node-pty 终端进程实现。 */

import { Buffer } from 'node:buffer'
import { constants } from 'node:os'
import { PassThrough } from 'node:stream'
import type { IDisposable, IPty } from 'node-pty'
import type {
  SubprocessOutcome,
  SubprocessTerminalActivity,
  SubprocessTerminalForeground,
  SubprocessTerminalHandle,
  SubprocessTerminalSignal,
} from '@deepseek-ai/dsh-subprocess'
import type { BoundProcessOwner } from './managed-owner.ts'
import type { ProcessIdentity, ProcessInspector, ProcessSnapshot } from './process-inspector.ts'
import type { ShellActivity } from './shell-activity.ts'

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal?.addEventListener('abort', finish, { once: true })
  })
}

async function raceWithDelay<T, U>(operation: Promise<T>, ms: number, timeout: U): Promise<T | U> {
  const controller = new AbortController()
  try {
    return await Promise.race([
      operation,
      delay(ms, controller.signal).then(() => timeout),
    ])
  } finally {
    controller.abort()
  }
}

function signalName(number: number | undefined): NodeJS.Signals | null {
  if (number === undefined || number === 0) return null
  for (const [name, value] of Object.entries(constants.signals)) {
    if (value === number) return name as NodeJS.Signals
  }
  return null
}

/**
 * 一个本地终端，其原生受管范围或回退进程会话的所有权位于 PTY 后端之下。
 * 该 seam 的 terminate() 承诺——结算后不再有正在进行的写入、检查或信号——之所以
 * 无需操作跟踪就能成立，只是因为每次句柄调用在底层都是同步完成的（node-pty 写入、
 * 基于 ps 的检查）。任意句柄调用中一旦出现首个真正的异步步骤，就必须补上
 * 远程提供方所需的跟踪。
 */
export class LocalTerminalHandle implements SubprocessTerminalHandle {
  readonly pid: number
  readonly output = new PassThrough()
  readonly done: Promise<SubprocessOutcome>

  private readonly outcome = Promise.withResolvers<SubprocessOutcome>()
  private readonly dataDisposable: IDisposable
  private readonly exitDisposable: IDisposable
  private cleanup: Promise<void> | undefined
  private managedOwnerCleaned = false
  private exited = false
  private outputPaused = false
  private trackedDescendants: ProcessIdentity[] = []
  private activityRevision = 0
  private activityKey = ''
  private quiescent = false
  private managedRangeEmpty = false
  /** The spawned shell's start identity; scans stop adopting members once the root pid no longer carries it. */
  private readonly rootIdentity: ProcessIdentity | undefined

  /**
   * @param terminal - 已分配的 node-pty 进程。
   * @param inspector - 平台进程/会话操作。
   * @param graceMs - TERM 到 KILL 以及退出等待的宽限。
   * @param platform - 主机平台；默认取运行平台，可注入以得到确定性测试。
   */
  constructor(
    private readonly terminal: IPty,
    private readonly inspector: ProcessInspector,
    private readonly graceMs: number,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly managedOwner?: BoundProcessOwner,
    private readonly resolveManagedOutcome?: (outcome: SubprocessOutcome) => SubprocessOutcome,
    private readonly shellActivity?: Pick<ShellActivity, 'inspect' | 'invalidate' | 'dispose'>,
    private readonly onQuiescence?: () => void,
    private readonly observeShellExit = false,
  ) {
    this.pid = terminal.pid
    try { this.rootIdentity = inspector.snapshot().tree(this.pid).find(member => member.pid === this.pid) }
    catch (_rootIdentityUnavailable) { this.rootIdentity = undefined }
    this.done = this.outcome.promise
    const resume = (): void => {
      if (!this.outputPaused) return
      this.outputPaused = false
      if (!this.exited) terminal.resume()
    }
    this.output.on('drain', resume)
    this.output.once('close', () => { this.output.off('drain', resume) })
    this.dataDisposable = terminal.onData((data) => {
      if (!this.output.write(Buffer.from(data, 'utf8')) && this.cleanup === undefined && !this.outputPaused) {
        this.outputPaused = true
        terminal.pause()
      }
    })
    this.exitDisposable = terminal.onExit(({ exitCode, signal: exitSignal }) => {
      if (this.exited) return
      this.exited = true
      if (this.managedOwner !== undefined && this.observeShellExit) {
        void this.managedOwner.waitForExit().then(() => { this.managedRangeEmpty = true }).catch(() => {
          // 失败的范围观察不能授权空闲回收。
        })
      }
      this.output.end()
      const outcome = {
        exitCode: exitSignal === undefined || exitSignal === 0 ? exitCode : null,
        signal: signalName(exitSignal),
      }
      try {
        this.outcome.resolve(this.resolveManagedOutcome?.(outcome) ?? outcome)
      } catch (error) {
        this.outcome.reject(error)
      }
    })
  }

  /** node-pty 是否尚未发布顶层退出事件。 */
  get running(): boolean {
    return !this.exited
  }

  // node-pty 是同步写入的；该 seam 为远程传输返回一个承诺。
  // oxlint-disable-next-line typescript/require-await -- Preserve promise rejection semantics at the async provider contract.
  async write(data: string): Promise<void> {
    if (this.exited) throw new Error('terminal process has exited')
    this.shellActivity?.invalidate()
    this.terminal.write(data)
  }

  // oxlint-disable-next-line typescript/require-await -- Provider operations share promise rejection semantics.
  async resize(cols: number, rows: number): Promise<void> {
    if (this.exited) throw new Error('terminal process has exited')
    this.terminal.resize(cols, rows)
  }

  // 本地检查是同步的；该 seam 为远程传输返回一个承诺。
  // oxlint-disable-next-line typescript/require-await -- Preserve promise rejection semantics at the async provider contract.
  async inspectForeground(): Promise<SubprocessTerminalForeground | undefined> {
    this.descendants(this.inspector.snapshot())
    const processGroupId = this.inspector.foregroundPgid(this.pid)
    if (processGroupId === undefined) return undefined
    return {
      processGroupId,
      inputWaiting: this.inspector.isStdinWaiting(processGroupId, this.pid),
    }
  }

  // oxlint-disable-next-line typescript/require-await -- Local inspection is synchronous; SSH shares this promise interface.
  async inspectActivity(): Promise<SubprocessTerminalActivity> {
    let state: SubprocessTerminalActivity['state'] = this.quiescent ? 'idle' : 'unknown'
    let revision = 0
    if (!this.quiescent) {
      try {
        const shell = this.shellActivity?.inspect(this.pid) ?? { state: 'unknown' as const, revision: 0 }
        revision = shell.revision
        const observed = this.inspector.snapshot()
        const descendants = this.descendants(observed)
        const root = observed.tree(this.pid).find(member => member.pid === this.pid)
        if (this.exited && this.managedRangeEmpty) state = 'idle'
        else if (descendants.length > 0) state = 'busy'
        else if (this.exited && this.managedOwner === undefined && this.platform === 'linux' && observed.complete === true && root === undefined) {
          state = observed.session(this.pid).some(member => observed.alive(member)) ? 'busy' : 'idle'
        }
        else if (observed.complete === true && root?.started === this.rootIdentity?.started && root !== undefined) {
          const foreground = this.inspector.foregroundPgid(this.pid)
          state = foreground === undefined ? 'unknown' : foreground === this.pid ? shell.state : 'busy'
          if (state === 'idle' && this.managedOwner !== undefined) {
            const tasks = this.managedOwner.inspectTaskCount?.()
            state = tasks === undefined || tasks < 1 ? 'unknown' : tasks === 1 ? 'idle' : 'busy'
          }
        }
      } catch (_incompleteActivityObservation) { state = 'unknown' }
    }
    const key = `${revision}:${state}`
    if (key !== this.activityKey) { this.activityKey = key; this.activityRevision++ }
    return { state, revision: this.activityRevision }
  }

  async signalForeground(signal: SubprocessTerminalSignal): Promise<number> {
    this.shellActivity?.invalidate()
    const foreground = await this.inspectForeground()
    if (foreground === undefined) {
      throw new Error(`cannot resolve foreground process group for terminal ${this.pid}`)
    }
    if (signal === 'SIGKILL' && foreground.processGroupId === this.pid) {
      throw new Error('refusing to SIGKILL the terminal shell; terminate the terminal session instead')
    }
    if (this.platform === 'win32') {
      if (signal === 'SIGINT') {
        // Windows 没有进程组信令：一次 `\x03` 输入写入就是 console host 转化为
        // 面向已附加进程的、整控制台 CTRL_C 事件的 Ctrl-C 投递路径。node-pty 的信号
        // 杀死在 Windows 上会抛错，因此没有任何信号能到达检查器。
        this.terminal.write('\x03')
        return foreground.processGroupId
      }
      if (signal === 'SIGTSTP' || signal === 'SIGHUP') {
        throw new Error(`signal ${signal} is unsupported on Windows; only SIGINT, SIGTERM, and SIGKILL are available`)
      }
    }
    this.inspector.signalGroup(foreground.processGroupId, signal)
    return foreground.processGroupId
  }

  terminate(): Promise<void> {
    if (this.cleanup !== undefined) return this.cleanup
    if (this.outputPaused) { this.outputPaused = false; this.terminal.resume() }
    const cleanup = this.closeOnce().then(() => {
      this.quiescent = true
      this.shellActivity?.dispose()
      this.onQuiescence?.()
    })
    this.cleanup = cleanup
    void cleanup.catch(() => { this.cleanup = undefined })
    return cleanup
  }

  /**
   * 在 Node 的退出事件期间，同步强制终止可观测的会话。它不声明静默，也不替代 terminate()。
   */
  terminateForHostExit(): void {
    this.forceStopDescendants()
    this.forceStopShell()
    this.forceStopDescendants()
    this.managedOwner?.terminateForHostExit()
  }

  private forceStopShell(): void {
    if (this.exited) return
    if (this.rootIdentity !== undefined) {
      try {
        this.inspector.signalProcess(this.rootIdentity, 'SIGKILL')
      } catch (_rootExitedDuringHostExit) {
        // 精确身份信令同时包含退出竞争与 PID 复用。
      }
      return
    }
    try {
      this.terminal.kill('SIGKILL')
    } catch (_unidentifiedShellExitedDuringHostExit) {
      // 没有捕获到的身份时，node-pty 是唯一的根级杀死原语。
    }
  }

  private survivors(members: ProcessIdentity[], observed: ProcessSnapshot): ProcessIdentity[] {
    return members.filter(member => observed.alive(member))
  }

  private descendants(observed: ProcessSnapshot): ProcessIdentity[] {
    // 只在数值根 pid 可证明仍携带被生成 shell 的起始身份时，才接纳新扫描到的
    // 成员：shell 死亡后，一个被回收 pid 的树与会话绝不能把一个无关进程的
    // 子进程捐献给本次会话的信令。已被接纳的成员保留各自的起始身份，每次信号都会重新检查。
    const tree = observed.tree(this.pid)
    const root = tree.find(member => member.pid === this.pid)
    const rootVerified = this.rootIdentity !== undefined
      && root !== undefined
      && root.started === this.rootIdentity.started
    this.trackedDescendants = this.survivors(this.unionMembers(
      this.trackedDescendants,
      ...rootVerified ? [tree, observed.session(this.pid)] : [],
    ).filter(member => member.pid !== this.pid), observed)
    return this.trackedDescendants
  }

  private async waitForMembers(members: ProcessIdentity[]): Promise<ProcessIdentity[]> {
    if (members.length === 0) return []
    const until = Date.now() + this.graceMs
    let survivors = this.survivors(members, this.inspector.snapshot())
    while (survivors.length > 0 && Date.now() < until) {
      await delay(Math.min(25, Math.max(1, until - Date.now())))
      survivors = this.survivors(members, this.inspector.snapshot())
    }
    return survivors
  }

  private signalMembers(members: ProcessIdentity[], signal: 'SIGTERM' | 'SIGKILL'): void {
    for (const member of members) {
      try {
        // 每条信号都在本 try 内读取自己的身份栅栏：一次失败的读取只应损失一个
        // 目标，绝不能是拆除轮次中的其余目标。
        this.inspector.signalProcess(member, signal)
      } catch (_alreadyExitedDuringSignal) {
        // 精确的进程身份会被重新检查；同一 tick 内的退出即视为成功。
      }
    }
  }

  private forceStopDescendants(): void {
    let members = this.trackedDescendants
    try {
      members = this.descendants(this.inspector.snapshot())
    } catch (_processTableUnavailableDuringHostExit) {
      // 当最后一次进程表扫描失败时，保留已捕获的身份。
    }
    this.signalMembers(members, 'SIGKILL')
  }

  private unionMembers(...groups: ProcessIdentity[][]): ProcessIdentity[] {
    const members: ProcessIdentity[] = []
    const seen = new Set<string>()
    for (const group of groups) {
      for (const member of group) {
        const key = `${member.pid}:${member.started}`
        if (seen.has(key)) continue
        seen.add(key)
        members.push(member)
      }
    }
    return members
  }

  private async stopDescendants(): Promise<ProcessIdentity[]> {
    const captured = this.descendants(this.inspector.snapshot())
    this.signalMembers(captured, 'SIGTERM')
    const capturedSurvivors = await this.waitForMembers(captured)
    const members = this.unionMembers(capturedSurvivors, this.descendants(this.inspector.snapshot()))
    this.signalMembers(members, 'SIGKILL')
    const survivors = await this.waitForMembers(members)
    const observed = this.inspector.snapshot()
    return this.survivors(this.unionMembers(survivors, this.descendants(observed)), observed)
  }

  private async stopShell(): Promise<void> {
    if (this.platform === 'win32') {
      await this.stopShellWindows()
      return
    }
    if (!this.exited) {
      try {
        this.terminal.kill('SIGTERM')
      } catch (_topLevelAlreadyExitedDuringTerm) {
        // 退出回调是权威来源。
      }
      await Promise.race([this.done.then(() => undefined), delay(this.graceMs)])
    }
    if (!this.exited) {
      try {
        this.terminal.kill('SIGKILL')
      } catch (_topLevelAlreadyExitedDuringKill) {
        // 退出回调是权威来源。
      }
      await Promise.race([this.done.then(() => undefined), delay(this.graceMs)])
    }
    if (!this.exited) throw new Error(`terminal cleanup failed; surviving pid: ${this.pid}`)
  }

  private async stopShellWindows(): Promise<void> {
    // node-pty 的 Windows kill(signal) 会抛错（"Signals not supported on
    // windows"），而其裸 kill() 经由每主机一条路径到达 console host：Windows 自带的
    // host 走一个控制台列表代理，在父进程没有控制台时会失败，而打包的 OpenConsole
    // 执行一次原生 kill 外加 conout 拆除。taskkill 树升级才是拆除路径，并与每个后代
    // 一样以 shell 的起始身份为栅栏；若根身份缺失则回退到裸 kill。taskkill 终止也不能
    // 可靠地触发 node-pty 的退出通知，因此各层级通过检查器验证 shell 是否缺席，而非
    // 仅等待 `done`。
    const shellGone = (): boolean =>
      this.exited || (this.rootIdentity !== undefined && !this.inspector.isAlive(this.rootIdentity))
    if (!shellGone() && this.rootIdentity !== undefined) {
      this.inspector.signalProcess(this.rootIdentity, 'SIGTERM')
      await this.waitForWindowsShellExit()
    }
    if (!shellGone() && this.rootIdentity === undefined) {
      try {
        this.terminal.kill()
      } catch (_topLevelAlreadyExitedDuringKill) {
        // 退出回调是权威来源。
      }
      await Promise.race([this.done.then(() => undefined), delay(this.graceMs)])
    }
    if (!shellGone() && this.rootIdentity !== undefined) {
      this.inspector.signalProcess(this.rootIdentity, 'SIGKILL')
      await this.waitForWindowsShellExit()
    }
    if (!shellGone()) throw new Error(`terminal cleanup failed; surviving pid: ${this.pid}`)
  }

  private async waitForWindowsShellExit(): Promise<void> {
    const until = Date.now() + this.graceMs
    while (!this.exited && Date.now() < until) {
      if (this.rootIdentity !== undefined && !this.inspector.isAlive(this.rootIdentity)) return
      await delay(Math.min(25, Math.max(1, until - Date.now())))
    }
  }

  private async closeOnce(): Promise<void> {
    if (this.managedOwner !== undefined) {
      try {
        await this.closeManagedRange(this.managedOwner)
        this.dataDisposable.dispose()
        this.exitDisposable.dispose()
      } finally {
        void this.done.finally(() => { this.cleanupManagedOwner(this.managedOwner as BoundProcessOwner) }).catch(() => {})
      }
      return
    }
    let survivors = await this.stopDescendants()
    if (survivors.length > 0) {
      throw new Error(`terminal cleanup failed; surviving pids: ${survivors.map(member => member.pid).join(', ')}`)
    }
    await this.stopShell()
    survivors = await this.stopDescendants()
    if (survivors.length > 0) {
      throw new Error(`terminal cleanup failed; surviving pids: ${survivors.map(member => member.pid).join(', ')}`)
    }
    this.settleExitIfGone()
    this.dataDisposable.dispose()
    this.exitDisposable.dispose()
  }

  private cleanupManagedOwner(owner: BoundProcessOwner): void {
    if (this.managedOwnerCleaned) return
    this.managedOwnerCleaned = true
    owner.cleanup?.()
  }

  private async closeManagedRange(owner: BoundProcessOwner): Promise<void> {
    owner.signal('SIGTERM')
    const observation = owner.waitForExit()
    const first = await raceWithDelay(observation.then(
      () => ({ kind: 'stopped' as const }),
      (error: unknown) => ({ kind: 'failed' as const, error }),
    ), this.graceMs, { kind: 'timeout' as const })
    if (first.kind !== 'stopped') {
      owner.signal('SIGKILL')
      if (first.kind === 'failed') {
        // 观察失败仍是权威的，但在暴露它之前，仍须尝试强制清理以及一次全新的最终观察。
        try {
          await owner.waitForExit()
        } catch (finalError: unknown) {
          throw new AggregateError([first.error, finalError], 'terminal managed-range cleanup failed')
        }
        throw first.error
      }
      await observation
    }
    if (!this.exited) {
      await raceWithDelay(this.done.then(() => undefined), this.graceMs, undefined)
    }
    if (!this.exited) throw new Error(`terminal cleanup failed; surviving pid: ${this.pid}`)
  }

  private settleExitIfGone(): void {
    // 一个被外部 taskkill 的 Windows shell 可能永远不会触发 node-pty 的退出通知
    //（其控制台列表代理在没有父控制台时会失败），这会让 `done`——以及每个等待它的
    // 消费者——永远悬而未决。拆除刚刚通过检查器确认了 shell 的缺席，因此缺失的退出事件
    // 本身就是结果。
    if (this.platform !== 'win32') return
    if (this.exited) return
    /* v8 ignore next -- stopShellWindows() 已确认 shell 已消失或已抛错；
       identity re-check 是为未来调用方设的防御性栅栏。 */
    if (this.rootIdentity !== undefined && this.inspector.isAlive(this.rootIdentity)) return
    this.exited = true
    this.output.end()
    this.outcome.resolve({ exitCode: null, signal: null })
  }
}
