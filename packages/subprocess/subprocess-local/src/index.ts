/**
 * subprocess 能力 seam 的本地服务提供者。每次启动都拥有一个平台选定的受管范围，
 * 以及 spec 的逐流 stdio 处理方式。正常的释放会终止并汇入活动范围；Node 的同步退出
 * 阶段会强制停止该服务仍拥有的任何范围。它没有配置：每一种处理方式与限制都来自
 * spec，因此因部署而异的选择仍留在调用方的配置中（bash 执行器的、LSP 主机的……）。
 * @module @deepseek-ai/dsh-subprocess-local
 */

import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { delimiter, extname, isAbsolute, resolve } from 'node:path'
import type { Duplex } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import type * as NodePty from 'node-pty'
import type { IPtyForkOptions, IWindowsPtyForkOptions } from 'node-pty'
import { createLazyRequire } from '@deepseek-ai/dsh-lazy-require'
import { SubprocessRuntime, SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalEnvironment,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import {
  bindManagedProcess,
  childEnv,
  spawnSubprocess,
  validateSubprocessSpec,
} from './spawn.ts'
import { logSpillFailure, prepareManagedProcessBinding } from './output.ts'
import type { LocalSubprocessHandle, SpawnInternals } from './spawn.ts'
import {
  confirmLinuxManager,
  LinuxScopeNotStartedError,
  launchLinuxScope,
  linuxManagerListener,
  prepareLinuxTerminalScope,
  probeLinuxNative,
  signalLinuxDirectProcess,
  systemdRunIdentity,
} from './linux-scope.ts'
import { LinuxScopeSelector } from './linux-scope-selector.ts'
import type { LinuxScopeDecision } from './linux-scope-selector.ts'
import { launchWindowsJob, probeWindowsJob } from './windows-job.ts'
import { targetEnvironment } from './runner-launch.ts'
import { createProcessInspector } from './process-inspector.ts'
import type { ProcessInspector } from './process-inspector.ts'
import { LocalTerminalHandle } from './terminal.ts'
import { prepareShellActivity } from './shell-activity.ts'

const requireNodePty = createLazyRequire<typeof NodePty>('node-pty', import.meta.url)

/**
 * 本地 subprocess 服务：平台选定的受管范围、Node 形态的 stdio 处理方式（原始管道、
 * 继承、带溢出文件的有限尾部保留收集）、凭据清理后的环境，以及提供方拥有的范围信令。
 * POSIX 路径在 KILL 之前先发 TERM；Windows 路径则立即终止。JavaScript 可观察的主机
 * 退出也会执行同步的最终终止。
 */
export class LocalSubprocessRuntime extends SubprocessRuntime {
  /** 为正常释放与同步主机退出收尾而保留的活动句柄。 */
  private live = new Set<LocalSubprocessHandle>()
  /** 在正常静默或主机退出收尾期间保留的活动终端。 */
  private terminals = new Set<LocalTerminalHandle>()
  /** 在关闭之前保留的调用方端点，独立于受管进程的生命周期。 */
  private controlChannels = new Set<Duplex>()
  /** 测试钩子：转发给 spawnSubprocess 的进程、溢出与平台操作。 */
  internals: SpawnInternals = {}
  /** 提供方生命周期内的闩锁，用于抑制重复的、较弱隔离的警告。 */
  private fallbackWarningIssued = false
  /**
   * Linux 原生隔离决策。每次探测都是一次会阻塞事件循环并 fork 主机的 spawnSync，
   * 因此选择器只在某个事件使前一结论失效后才重跑它。
   */
  private readonly linuxScope = new LinuxScopeSelector({
    probe: () => probeLinuxNative(),
    managerListener: () => linuxManagerListener(),
    confirmManager: () => confirmLinuxManager(),
    launcherIdentity: () => systemdRunIdentity(),
  })
  /** 进行中启动的 scope 决策；selectContainmentMode 在启动读取它之前立即设置它。 */
  private linuxScopeDecision: Extract<LinuxScopeDecision, { kind: 'scope' }> | undefined
  /** 平台进程检查的测试钩子；生产环境在终端启动时惰性解析。 */
  terminalInspector: ProcessInspector | undefined

  constructor(ctx: Context) {
    super(ctx)
    ctx.effect(() => {
      const onHostExit = (): void => { this.terminateForHostExit() }
      process.prependListener('exit', onHostExit)
      return async () => {
        await this.disposeManagedProcesses()
        process.off('exit', onHostExit)
      }
    }, 'local subprocess teardown')
  }

  /** 溢出失败会送达插件日志器；该日志行是“结果为何没有溢出路径”的唯一线索。 */
  private readonly reportSpillFailure = logSpillFailure(this.ctx.logger, 'subprocess-local')

  private terminateForHostExit(): void {
    for (const handle of this.live) {
      try {
        handle.terminateForHostExit()
      } catch (_ordinaryRangeTerminationFailed) {
        // 主机退出无法等待或报告单个目标；继续处理其余部分。
      }
    }
    for (const terminal of this.terminals) {
      try {
        terminal.terminateForHostExit()
      } catch (_terminalTerminationFailed) {
        // 一个终端不应妨碍另一个目标的最后终止。
      }
    }
  }

  private async disposeManagedProcesses(): Promise<void> {
    // 请求终止，然后等待受管范围退出——而不仅仅是直接命令的结算——这样即便有幸存的
    // 后代也无法活得比纤程更久。在这些等待挂起期间，两个集合都保持权威，以便一个更短的
    // 进程级退出边界仍能强制杀死它们。
    const pending: Promise<unknown>[] = []
    for (const handle of this.live) {
      handle.terminate()
      // 直接结果与范围观察是相互独立的。两者都启动，这样不可读的拥有者就无法躲在
      // 一个永不结算的结果背后。
      pending.push(Promise.all([
        handle.done.catch(() => {}),
        handle.waitForExit(),
      ]).then(() => { this.live.delete(handle) }))
    }
    for (const terminal of this.terminals) {
      pending.push(terminal.terminate().then(() => { this.terminals.delete(terminal) }))
    }
    const outcomes = await Promise.allSettled(pending)
    await Promise.all([...this.controlChannels].map(control => new Promise<void>((resolveClose) => {
      control.once('close', () => { resolveClose() })
      control.destroy()
    })))
    this.controlChannels.clear()
    const failures: unknown[] = []
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') failures.push(outcome.reason)
    }
    if (failures.length > 0) this.terminateForHostExit()
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'local subprocess teardown failed')
  }

  async resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    if (command.length === 0) throw new Error('subprocess-local: executable must be non-empty')
    signal?.throwIfAborted()
    const environment = childEnv(env)
    const absolute = isAbsolute(command)
    if (!absolute && (command.includes('/') || (process.platform === 'win32' && command.includes('\\')))) {
      throw new Error(
        `subprocess-local: command ${JSON.stringify(command)} is a relative path; use an absolute path or a bare PATH name`,
      )
    }
    const candidates = absolute ? [command] : this.executableCandidates(command, environment)
    for (const candidate of candidates) {
      signal?.throwIfAborted()
      try {
        const info = await stat(candidate)
        if (!info.isFile()) continue
        await access(candidate, constants.X_OK)
        signal?.throwIfAborted()
        return candidate
      } catch {
        // Try the next PATH candidate; the final miss receives one stable error.
      }
    }
    signal?.throwIfAborted()
    throw new SubprocessExecutableNotFoundError(absolute
      ? `subprocess-local: command ${JSON.stringify(command)} is not an executable file`
      : `subprocess-local: command ${JSON.stringify(command)} was not found on PATH`)
  }

  private executableCandidates(command: string, env: NodeJS.ProcessEnv): string[] {
    const path = environmentValue(env, 'PATH') ?? ''
    const extensions = process.platform === 'win32' && extname(command) === ''
      ? (environmentValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';')
      : ['']
    return path.split(delimiter).flatMap(directory =>
      extensions.map(extension => resolve(process.cwd(), directory, command + extension)))
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    validateSubprocessSpec(spec)
    const env = targetEnvironment(spec)
    const containmentMode = this.selectContainmentMode('ordinary')
    let handle: LocalSubprocessHandle
    const internals: SpawnInternals = { ...this.internals, onSpillFailure: this.reportSpillFailure }
    if (containmentMode === 'fallback') {
      handle = spawnSubprocess(spec, internals)
    } else {
      const binding = prepareManagedProcessBinding(internals)
      const linuxScope = containmentMode === 'linux-scope' ? this.linuxScopeDecision : undefined
      const launch = linuxScope === undefined
        ? launchWindowsJob(spec, env)
        : launchLinuxScope(spec, env, linuxScope.literalArgv)
      handle = bindManagedProcess(spec, launch, binding)
      if (linuxScope !== undefined) this.watchLinuxScopeStart(handle.done, linuxScope.generation)
    }
    this.live.add(handle)
    const control = handle.control
    if (control !== undefined) {
      this.controlChannels.add(control)
      control.once('close', () => { this.controlChannels.delete(control) })
    }
    // 仅在整个受管范围消失后才释放所有权，而非在直接子进程结算时——一个比领导者更长寿、
    // 会捕获 TERM 的辅助进程必须仍被拥有，这样拆除时才能对其升级。对于常见的“无幸存者”
    // 情形，waitForExit 会在结算后立即完成。
    const release = (): Promise<void> =>
      handle.waitForExit().then(() => { this.live.delete(handle) })
    void handle.done.then(release, release).catch(() => {})
    return handle
  }

  /** 当一次在 generation 下启动的 scope 从未启动其目标时，在下一次启动前再次探测。 */
  private watchLinuxScopeStart(done: Promise<unknown>, generation: number): void {
    void done.catch((error: unknown) => {
      if (error instanceof LinuxScopeNotStartedError) this.linuxScope.scopeNotStarted(generation)
    })
  }

  private selectContainmentMode(
    kind: 'ordinary' | 'terminal',
  ): 'linux-scope' | 'windows-job' | 'fallback' {
    const platform = this.internals.platform ?? process.platform
    let fallbackReason: string | undefined
    if (platform === 'linux') {
      const decision = this.linuxScope.select()
      const probe = decision.probe === undefined ? '' : `, probed after ${decision.probe}`
      this.ctx.logger.debug(`linux native containment: ${decision.kind} (${decision.reason}${probe})`)
      if (decision.kind === 'scope') {
        this.linuxScopeDecision = decision
        return 'linux-scope'
      }
      fallbackReason = 'the current user-systemd scope or private bootstrap is unavailable'
    }
    if (kind === 'ordinary' && platform === 'win32') {
      const available = probeWindowsJob()
      if (available) return 'windows-job'
    }
    this.warnFallback(platform, kind, fallbackReason)
    return 'fallback'
  }

  private warnFallback(
    platform: NodeJS.Platform,
    kind: 'ordinary' | 'terminal',
    selectedReason?: string,
  ): void {
    if (this.fallbackWarningIssued) return
    this.fallbackWarningIssued = true
    const reason = selectedReason ?? (platform === 'darwin'
      ? 'macOS has no supported persistent process-range owner'
      : platform === 'win32'
        ? kind === 'terminal'
          ? 'Windows ConPTY remains outside Job containment'
          : 'the Win32 Job runner is unavailable'
        : `platform ${platform} has no native managed range`)
    this.ctx.logger.warn(
      `subprocess-local is using weaker process-tree containment because ${reason}; descendants that escape the process group or direct-parent tree are not guaranteed to terminate or delay waitForExit()`,
    )
  }

  /** @inheritdoc */
  // oxlint-disable-next-line typescript/require-await -- Keep the provider promise rejection semantics for cancelled inspection.
  async terminalEnvironment(signal?: AbortSignal): Promise<SubprocessTerminalEnvironment> {
    signal?.throwIfAborted()
    const platform = process.platform === 'win32' ? 'windows' : 'posix'
    const defaultShell = platform === 'windows' ? process.env.ComSpec || undefined : process.env.SHELL || userInfo().shell || undefined
    return { platform, ...defaultShell === undefined ? {} : { defaultShell } }
  }

  // 本地 PTY 分配是同步的，但提供方契约允许远程的异步分配。
  // oxlint-disable-next-line typescript/require-await -- Preserve promise rejection semantics at the async provider contract.
  async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    const file = spec.argv[0]
    if (file === undefined || file.length === 0) {
      throw new Error('subprocess-local: terminal argv must contain a program')
    }
    spec.signal?.throwIfAborted()
    const inspector = this.terminalInspector ?? createProcessInspector()
    const containmentMode = this.selectContainmentMode('terminal')
    const env = targetEnvironment(spec)
    const platform = this.internals.platform ?? process.platform
    const activity = prepareShellActivity(spec, env, platform)
    const launch = activity === undefined ? spec : { ...spec, argv: activity.argv, env: activity.env }
    const options: IPtyForkOptions | IWindowsPtyForkOptions = {
      name: spec.terminalType,
      rows: spec.rows,
      cols: spec.cols,
      cwd: spec.cwd,
      env: { ...activity?.env ?? env, TERM: spec.terminalType },
      // Windows 自带的 console host（备用池运行 Server 2022 与 Windows 10 22H2）会把持久化
      // pwsh 提示符尾部渲染成就绪路径无法匹配的形式；node-pty 自带的 console host 会原样
      // 发出它，见 [Agent Note](../../../../.agents/notes/implemented/bug-fix/2026-09-28-pty-bundled-console-host.md)。
      ...(platform === 'win32' ? { useConptyDll: true } : {}),
    }
    const linuxScope = containmentMode === 'linux-scope' ? this.linuxScopeDecision : undefined
    let scope: ReturnType<typeof prepareLinuxTerminalScope> | undefined
    let terminal: NodePty.IPty
    try {
      scope = linuxScope === undefined
        ? undefined
        : prepareLinuxTerminalScope(launch, { ...activity?.env ?? env, PWD: spec.cwd, TERM: spec.terminalType }, linuxScope.literalArgv)
      if (scope !== undefined) { options.cwd = scope.cwd; options.env = scope.env }
      terminal = requireNodePty().spawn(
        scope?.command ?? file,
        scope?.args ?? [...launch.argv.slice(1)],
        options,
      )
    } catch (error) {
      scope?.cleanup()
      activity?.dispose()
      throw error
    }
    // oxlint-disable-next-line eslint/prefer-const -- The owner can query readiness before the handle is published.
    let handle: LocalTerminalHandle | undefined
    const directSettlement = Promise.withResolvers<void>()
    const owner = scope?.bindOwner({
      running: () => handle?.running ?? true,
      settled: directSettlement.promise,
      // node-pty 会吞掉信号错误；scope 所有者需要它们的投递结果。
      signal: signal => signalLinuxDirectProcess(terminal.pid, () => process.kill(terminal.pid, signal)),
    })
    handle = new LocalTerminalHandle(
      terminal,
      inspector,
      spec.graceMs,
      platform,
      owner,
      scope?.resolveOutcome,
      activity,
      () => { this.terminals.delete(handle as LocalTerminalHandle) },
      spec.shellActivity === true,
    )
    this.terminals.add(handle)
    if (linuxScope !== undefined) this.watchLinuxScopeStart(handle.done, linuxScope.generation)
    const release = async (): Promise<void> => {
      // terminate() 可以等待这个直接退出承诺。
      directSettlement.resolve()
      if (spec.shellActivity === true) return
      await handle.terminate()
      this.terminals.delete(handle)
    }
    void handle.done.then(release, release).catch(() => {})
    return handle
  }
}

/** 用平台的大小写不敏感语义读取一个 Windows 环境键。 */
function environmentValue(env: NodeJS.ProcessEnv, name: 'PATH' | 'PATHEXT'): string | undefined {
  const exact = env[name]
  if (exact !== undefined || process.platform !== 'win32') return exact
  const normalized = name.toUpperCase()
  return Object.entries(env).find(([key]) => key.toUpperCase() === normalized)?.[1]
}

export default LocalSubprocessRuntime
