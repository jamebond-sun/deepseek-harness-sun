/** Linux 用户态 systemd scope 启动与受管范围所有权。 */

import { controlPipe } from './control-spawn.ts'
import { execFile, spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleepMs } from 'node:timers/promises'
import type {
  SubprocessOutcome,
  SubprocessSpawnSpec,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { loadLinuxExecve } from './linux-execve.ts'
import type { BoundProcessOwner, ManagedProcessLaunch } from './managed-owner.ts'
import {
  cleanupLinuxLaunchFiles,
  createLinuxLaunchFiles,
  deserializeRunnerError,
  readLinuxStartupError,
} from './runner-protocol.ts'
import type { LinuxLaunchFiles } from './runner-protocol.ts'
import {
  runnerEnvironment,
  runnerInvocationAvailable,
  runnerStdio,
  spawnRunnerInvocation,
} from './runner-launch.ts'
import type { RunnerInvocation } from './runner-launch.ts'
import { childEnv } from './spawn.ts'

/** 用于 systemd 命令执行的测试 seam。 */
export interface LinuxScopeInternals {
  spawn?: typeof spawn
  spawnSync?: typeof spawnSync
  systemctlQuery?: (command: string, args: readonly string[]) => Promise<SystemctlResult>
  systemdRun?: string
  systemctl?: string
  runnerInvocation?: RunnerInvocation
  resolveRunnerInvocation?: () => RunnerInvocation
  runnerAvailable?: (invocation: RunnerInvocation) => boolean
  loadLinuxExecve?: typeof loadLinuxExecve
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>
  /** 由用户管理器确认逻辑读取的内核 unix 套接字表；默认为 /proc/net/unix。 */
  unixSocketTable?: string
}

interface SystemctlResult {
  status: number | null
  stdout: string
  stderr: string
  error?: Error
}

const SYSTEMCTL_TIMEOUT_MS = 5_000
const SCOPE_INITIAL_POLL_INTERVAL_MS = 50
const MISSING_UNIT = /\bunit\b[^\r\n]*(?:could not be found|not found|not loaded)/iu
const LITERAL_ARGV_OPTION = '--expand-environment=no'
// v254 之前的 systemd-run 会拒绝该选项；其 scope 模式将 argv 原样传给 execvpe，不做展开。
const LITERAL_ARGV_OPTION_REJECTED = /unrecognized option\b.*expand-environment/u
// systemctl v252 之前的拼写，也是后续 `--kill-whom` 的无歧义前缀。
const KILL_ALL_MEMBERS = '--kill-who=all'
/** /proc/net/unix 在监听套接字上设置的标志位（__SO_ACCEPTCON）。 */
const UNIX_SOCKET_ACCEPTING = 0x10000

/** 让目标 argv 保持字面的 systemd-run 选项；在 scope 模式从不展开 argv 时为空。 */
export type LiteralArgvOptions = readonly string[]

function managerEnvironment(): NodeJS.ProcessEnv {
  const environment = childEnv({ LC_ALL: 'C' })
  delete environment.SYSTEMD_LOG_TARGET
  return environment
}

function quietSystemdEnvironment(): NodeJS.ProcessEnv {
  return childEnv({ LC_ALL: 'C', SYSTEMD_LOG_TARGET: 'null' })
}

function querySystemctl(command: string, args: readonly string[]): Promise<SystemctlResult> {
  return new Promise((resolveResult) => {
    execFile(command, [...args], {
      encoding: 'utf8',
      env: managerEnvironment(),
      timeout: SYSTEMCTL_TIMEOUT_MS,
    }, (error, stdout, stderr) => {
      const code = error === null ? 0 : (error as Error & { code?: string | number }).code
      resolveResult({
        status: typeof code === 'number' ? code : null,
        stdout,
        stderr,
        ...error === null ? {} : { error },
      })
    })
  })
}

function unitStem(prefix: string): string {
  return `${prefix}-${String(process.pid)}-${randomBytes(6).toString('hex')}`
}

function sleepWithAbort(delayMs: number, signal?: AbortSignal): Promise<void> {
  return sleepMs(delayMs, undefined, { signal })
}

/**
 * 在没有探测模式的情况下，确认这一确切的 runner 入口与 libc execve 绑定。
 * @param internals - 由测试使用的、可选的 runner 与 libc 绑定 seam。
 * @returns 引导程序能否进入最终目标。
 */
export function probeLinuxBootstrap(internals: LinuxScopeInternals = {}): boolean {
  try {
    ;(internals.loadLinuxExecve ?? loadLinuxExecve)()
    const invocation = internals.runnerInvocation
      ?? (internals.resolveRunnerInvocation ?? spawnRunnerInvocation)()
    return (internals.runnerAvailable ?? runnerInvocationAvailable)(invocation)
  } catch {
    return false
  }
}

/**
 * 在选择原生启动之前，确认当前的字面 argv 临时 scope 支持。
 * @param internals - 由测试使用的、可选的 systemd 命令 seam。
 * @returns 让目标 argv 保持字面的选项；当用户管理器无法创建 scope 时为 undefined。
 */
export function probeLinuxScope(internals: LinuxScopeInternals = {}): LiteralArgvOptions | undefined {
  const attempt = (literalArgv: LiteralArgvOptions): { created: boolean; stderr: string } => {
    const unitBase = unitStem('dsh-subprocess-probe')
    const result = (internals.spawnSync ?? spawnSync)(internals.systemdRun ?? 'systemd-run', [
      '--user',
      '--scope',
      '--quiet',
      '--collect',
      ...literalArgv,
      `--unit=${unitBase}`,
      '--',
      internals.systemctl ?? 'systemctl',
      '--user',
      'show',
      `${unitBase}.scope`,
      '--property=ActiveState',
      '--value',
    ], {
      encoding: 'utf8',
      env: quietSystemdEnvironment(),
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: SYSTEMCTL_TIMEOUT_MS,
    })
    return { created: result.error === undefined && result.status === 0, stderr: result.stderr }
  }
  const current = attempt([LITERAL_ARGV_OPTION])
  if (current.created) return [LITERAL_ARGV_OPTION]
  if (!LITERAL_ARGV_OPTION_REJECTED.test(current.stderr)) return undefined
  return attempt([]).created ? [] : undefined
}

/**
 * 在每次调用时检查每一个 Linux 原生前置条件。
 * @param internals - 由测试使用的、可选的原生能力 seam。
 * @returns 当 Linux 原生隔离可用时的字面 argv scope 选项，否则为 undefined。
 */
export function probeLinuxNative(internals: LinuxScopeInternals = {}): LiteralArgvOptions | undefined {
  return probeLinuxBootstrap(internals) ? probeLinuxScope(internals) : undefined
}

/**
 * 通过 systemctl 对查询用户管理器一次。
 * @param internals - 由测试使用的、可选的 systemctl seam。
 * @returns 查询是否成功。
 */
export function probeLinuxManager(internals: LinuxScopeInternals = {}): boolean {
  const result = (internals.spawnSync ?? spawnSync)(internals.systemctl ?? 'systemctl', [
    '--user',
    'show',
    '--property=Version',
    '--value',
  ], { env: managerEnvironment(), stdio: 'ignore', timeout: SYSTEMCTL_TIMEOUT_MS })
  return result.error === undefined && result.status === 0
}

/**
 * 找出此网络命名空间中、在给定路径上监听的套接字。内核只在进程保持套接字打开时才
 * 列出它，因此一个已停止或崩溃的监听者留下的套接字文件不算数。
 */
function unixSocketListener(path: string, table: string): string | undefined {
  let text: string
  try {
    text = readFileSync(table, 'utf8')
  } catch (_unreadableSocketTable) {
    // 没有套接字表就无从得知，因此调用方退回到 systemctl 或保持各自的结论。
    return undefined
  }
  const suffix = ` ${path}`
  for (const line of text.split('\n')) {
    if (!line.endsWith(suffix)) continue
    const fields = line.trim().split(/\s+/u)
    if (fields.slice(7).join(' ') === path && (Number.parseInt(String(fields[3]), 16) & UNIX_SOCKET_ACCEPTING) !== 0) {
      return String(fields[6])
    }
  }
  return undefined
}

/**
 * 识别用户管理器在 `$XDG_RUNTIME_DIR/systemd/private` 上的监听者，即
 * `systemd-run --user` 所连接通过的套接字。
 * @param internals - 由测试使用的、可选的套接字表 seam。
 * @returns 来自内核套接字表的监听套接字 inode；当 XDG_RUNTIME_DIR 未设置或此网络
 *   命名空间中没有任何监听者时，为 undefined。
 */
export function linuxManagerListener(internals: LinuxScopeInternals = {}): string | undefined {
  const runtimeDirectory = childEnv().XDG_RUNTIME_DIR
  if (runtimeDirectory === undefined || runtimeDirectory === '') return undefined
  return unixSocketListener(join(runtimeDirectory, 'systemd', 'private'), internals.unixSocketTable ?? '/proc/net/unix')
}

/**
 * 识别 scope 启动经由 PATH 解析到的 systemd-run 可执行文件，以便一个替换它的包升级会
 * 触发对其字面 argv 选项的又一次探测。
 * @param internals - 由测试使用的、可选的 systemd-run seam。
 * @returns 第一个匹配项的设备号、inode、大小与修改时间；当没有任何匹配时，为 undefined。
 */
export function systemdRunIdentity(internals: LinuxScopeInternals = {}): string | undefined {
  const command = internals.systemdRun ?? 'systemd-run'
  const candidates = command.includes('/')
    ? [command]
    : (childEnv().PATH ?? '').split(':').filter(directory => directory !== '').map(directory => join(directory, command))
  for (const candidate of candidates) {
    let stats: ReturnType<typeof statSync>
    try {
      stats = statSync(candidate, { throwIfNoEntry: false })
    } catch (_unreadableCandidate) {
      // 一个不可搜索的目录形式的 PATH 项不可能包含 systemd-run。
      continue
    }
    if (stats?.isFile() === true) return `${String(stats.dev)}:${String(stats.ino)}:${String(stats.size)}:${String(stats.mtimeMs)}`
  }
  return undefined
}

/**
 * 在 scope 启动之前确认用户管理器。其私有套接字上的监听者无需子进程即可确认它；
 * 否则由一次 systemctl 查询决定。一个仍在监听但已挂起的管理器会通过，而其 scope
 * 启动会以 LinuxScopeNotStartedError 失败。
 * @param internals - 由测试使用的、可选的套接字表与 systemctl seam。
 * @returns 一次 scope 启动能否联络到用户管理器。
 */
export function confirmLinuxManager(internals: LinuxScopeInternals = {}): boolean {
  return linuxManagerListener(internals) !== undefined || probeLinuxManager(internals)
}

interface DirectRange {
  running(): boolean
  /** 组 TERM 投递、直接信号提交，或已证实的直接 PID 缺失时为 true。 */
  signal(signal: 'SIGTERM' | 'SIGKILL'): boolean
  /** 直接的退出/错误结算，独立于输出排空与受管范围的完成。 */
  settled: Promise<unknown>
}

/** 一次其引导程序从未消费启动请求、因而目标从未运行的 scope 启动。 */
export class LinuxScopeNotStartedError extends Error {
  override readonly name = 'LinuxScopeNotStartedError'
}

class LinuxScopeStartup {
  readonly terminationSignals = new Set<NodeJS.Signals>()

  constructor(readonly files: LinuxLaunchFiles, private readonly kind: 'subprocess' | 'terminal') {}

  resolveOutcome(outcome: SubprocessOutcome): SubprocessOutcome {
    const startup = readLinuxStartupError(this.files.startupErrorPath)
    if (startup !== undefined) throw deserializeRunnerError(startup.error)
    if (existsSync(this.files.requestPath)
      && !(outcome.signal !== null && this.terminationSignals.has(outcome.signal))) {
      throw new LinuxScopeNotStartedError(
        `${this.kind} scope exited before its bootstrap consumed the launch request; the provider probes native containment again before its next command`,
      )
    }
    return outcome
  }
}

class SystemdScopeOwner implements BoundProcessOwner {
  private establishment: 'pending' | 'established' = 'pending'
  private stopped = false
  private terminationRequested = false
  private observation: Promise<void> | undefined
  private killFailure: Error | undefined
  private directKillSettlement: Promise<void> | undefined
  private wakeGeneration = 0
  private wakeWaiter: { generation: number; resolve: () => void } | undefined

  constructor(
    private readonly unit: string,
    private readonly startup: LinuxScopeStartup,
    private readonly direct: DirectRange,
    private readonly systemctl: string,
    private readonly runSync: typeof spawnSync,
    private readonly query: (command: string, args: readonly string[]) => Promise<SystemctlResult>,
    private readonly sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>,
  ) {}

  inspectTaskCount(): number | undefined {
    const result = this.runSync(this.systemctl, [
      '--user', 'show', '--property=LoadState', '--property=ActiveState', '--property=TasksCurrent', this.unit,
    ], { encoding: 'utf8', env: managerEnvironment(), timeout: SYSTEMCTL_TIMEOUT_MS })
    if (result.error !== undefined || result.status !== 0 || typeof result.stdout !== 'string') return undefined
    const state = this.parseUnitState(result.stdout)
    return state.loadState === 'loaded' && state.activeState === 'active' ? state.tasksCurrent : undefined
  }

  signal(signal: 'SIGTERM' | 'SIGKILL'): void {
    if (this.stopped) return
    this.terminationRequested = true
    if (this.direct.running()) this.startup.terminationSignals.add(signal)
    this.observeRequestConsumption()
    const directFallbackRequired = this.establishment === 'pending'
    let directSignalled = false
    if (directFallbackRequired && this.direct.running()) directSignalled = this.direct.signal(signal)
    const result = this.runSync(this.systemctl, [
      '--user',
      'kill',
      KILL_ALL_MEMBERS,
      `--signal=${signal}`,
      this.unit,
    ], { encoding: 'utf8', env: managerEnvironment(), timeout: SYSTEMCTL_TIMEOUT_MS })
    this.wakeObservation()
    if (result.error === undefined && result.status === 0) {
      if (signal === 'SIGKILL') {
        this.killFailure = undefined
        this.directKillSettlement = undefined
      }
      return
    }
    if (!directFallbackRequired && this.direct.running()) directSignalled = this.direct.signal(signal)
    if (signal === 'SIGKILL') {
      const output = `${result.stdout}\n${result.stderr}`
      if (!MISSING_UNIT.test(output)) {
        this.killFailure = result.error ?? new Error(
          `systemctl could not signal ${this.unit}: ${output.trim() || `exit ${String(result.status)}`}`,
        )
        // 直接结果会保留错误；此屏障只汇入其物理结算。
        this.directKillSettlement = directSignalled
          ? this.direct.settled.then(() => {}, () => {})
          : undefined
      }
    }
  }

  terminateForHostExit(): void {
    if (this.stopped) return
    try {
      if (this.direct.running()) this.direct.signal('SIGKILL')
    } catch { /* 继续沿用原生所有者。 */ }
    try {
      this.runSync(this.systemctl, [
        '--user',
        'kill',
        KILL_ALL_MEMBERS,
        '--signal=SIGKILL',
        this.unit,
      ], { env: managerEnvironment(), stdio: 'ignore', timeout: SYSTEMCTL_TIMEOUT_MS })
    } catch {
      // Host exit cannot report one range; the runtime continues with the rest.
    }
  }

  private observeRequestConsumption(): void {
    if (this.establishment === 'pending' && !existsSync(this.startup.files.requestPath)) {
      this.establishment = 'established'
    }
  }

  private absentUnit(): boolean {
    this.observeRequestConsumption()
    if (this.establishment === 'established') return false
    if (!this.direct.running() && existsSync(this.startup.files.requestPath)) {
      return false
    }
    if (this.killFailure !== undefined) throw this.killFailure
    return true
  }

  /**
   * 证明一个没有进程的活动单元是空的受管范围，而非仍在布置其负载的启动。systemd 只在
   * “由非空到空”的跃迁时才结束一个 scope，因此一个在进入 cgroup 之前就被杀死的负载会让
   * 该单元永远处于活动状态。一个已离去的客户端无法再添加另一个负载；而一个已被消费的
   * 请求能证明负载已进入 scope，即便其直接进程的退出通知尚在等待中。
   */
  private emptyRange(tasksCurrent: number | undefined): boolean {
    return this.terminationRequested && tasksCurrent === 0
      && (!this.direct.running() || !existsSync(this.startup.files.requestPath))
  }

  /** 释放一个遗留的空 scope，使临时单元被回收且不会累积。 */
  private releaseEmptyRange(): void {
    try {
      this.runSync(this.systemctl, ['--user', 'stop', this.unit], {
        env: managerEnvironment(),
        stdio: 'ignore',
        timeout: SYSTEMCTL_TIMEOUT_MS,
      })
    } catch {
      // 范围已为空；清理失败只会留下临时单元。
    }
  }

  private parseUnitState(stdout: string): { loadState: string; activeState: string; tasksCurrent: number | undefined } {
    const values = new Map<string, string>()
    for (const line of stdout.split(/\r?\n/u)) {
      if (line === '') continue
      const separator = line.indexOf('=')
      if (separator <= 0) {
        throw new Error(`systemctl returned malformed state for ${this.unit}: ${JSON.stringify(stdout.trim())}`)
      }
      const name = line.slice(0, separator)
      if (values.has(name)) {
        throw new Error(`systemctl returned duplicate ${name} for ${this.unit}`)
      }
      values.set(name, line.slice(separator + 1))
    }
    const loadState = values.get('LoadState')
    const activeState = values.get('ActiveState')
    // 管理器会为一个单元并不携带的属性打印此哨兵值。
    const reportedTasks = values.get('TasksCurrent')
    const tasksCurrent = reportedTasks === '[not set]' ? undefined : reportedTasks
    if (values.size !== (reportedTasks === undefined ? 2 : 3)
      || loadState === undefined || activeState === undefined) {
      throw new Error(`systemctl returned incomplete state for ${this.unit}: ${JSON.stringify(stdout.trim())}`)
    }
    if (tasksCurrent !== undefined && !/^\d+$/u.test(tasksCurrent)) {
      throw new Error(`systemctl returned a non-numeric TasksCurrent for ${this.unit}: ${JSON.stringify(tasksCurrent)}`)
    }
    return {
      loadState,
      activeState,
      tasksCurrent: tasksCurrent === undefined ? undefined : Number(tasksCurrent),
    }
  }

  private async rangeActive(): Promise<boolean> {
    this.observeRequestConsumption()
    const generation = this.wakeGeneration
    const directRunning = this.direct.running()
    const result = await this.query(this.systemctl, [
      '--user',
      'show',
      this.unit,
      '--property=LoadState',
      '--property=ActiveState',
      '--property=TasksCurrent',
    ])
    // 信号会使在其投递与直接回退之前查询到的状态失效。
    if (generation !== this.wakeGeneration) return true
    const output = `${result.stdout}\n${result.stderr}`
    if (result.status === 0) {
      const { loadState, activeState, tasksCurrent } = this.parseUnitState(result.stdout)
      if (loadState === 'not-found' && activeState === 'inactive') return this.absentUnit()
      if (loadState !== 'loaded') {
        throw new Error(
          `systemctl returned unknown state for ${this.unit}: ${JSON.stringify({ loadState, activeState })}`,
        )
      }
      this.establishment = 'established'
      if (activeState === 'inactive' || activeState === 'failed') return false
      if (!['active', 'activating', 'reloading', 'deactivating'].includes(activeState)) {
        throw new Error(`systemctl returned unknown ActiveState for ${this.unit}: ${JSON.stringify(activeState)}`)
      }
      if (this.emptyRange(tasksCurrent)) {
        this.releaseEmptyRange()
        return false
      }
      if (this.killFailure !== undefined) {
        if (directRunning && this.directKillSettlement !== undefined) {
          const settlement = this.directKillSettlement
          this.directKillSettlement = undefined
          await settlement
          // 直接退出之前的查询无法证明那些被发信号的进程是否存活。
          return this.rangeActive()
        }
        throw this.killFailure
      }
      return true
    }
    if (!MISSING_UNIT.test(output)) {
      if (result.error !== undefined) throw result.error
      throw new Error(`systemctl could not read ${this.unit}: ${output.trim() || `exit ${String(result.status)}`}`)
    }
    return this.absentUnit()
  }

  private wakeObservation(): void {
    this.wakeGeneration += 1
    this.wakeWaiter?.resolve()
    this.wakeWaiter = undefined
  }

  private async waitForPoll(delayMs: number, generation: number): Promise<void> {
    if (generation !== this.wakeGeneration) return
    const wake = Promise.withResolvers<void>()
    const waiter = { generation, resolve: wake.resolve }
    const sleepController = new AbortController()
    this.wakeWaiter = waiter
    try {
      await Promise.race([this.sleep(delayMs, sleepController.signal), wake.promise])
    } finally {
      sleepController.abort()
      if (this.wakeWaiter === waiter) this.wakeWaiter = undefined
    }
  }

  async waitForExit(): Promise<void> {
    if (this.stopped) return
    this.observation ??= (async () => {
      let pollIntervalMs = SCOPE_INITIAL_POLL_INTERVAL_MS
      let generation = this.wakeGeneration
      while (await this.rangeActive()) {
        await this.waitForPoll(pollIntervalMs, generation)
        generation = this.wakeGeneration
        // 先让建立过程保持响应，再在 systemd 仍是活动范围的权威所有者期间
        // 降低 systemctl 的进程抖动。
        if (this.establishment === 'established') {
          pollIntervalMs = Math.min(pollIntervalMs * 2, SYSTEMCTL_TIMEOUT_MS)
        }
      }
      this.stopped = true
    })().catch((error: unknown) => {
      this.observation = undefined
      throw error
    })
    await this.observation
  }

  cleanup(): void {
    cleanupLinuxLaunchFiles(this.startup.files)
  }
}

function scopeArgs(
  unitBase: string,
  literalArgv: LiteralArgvOptions,
  invocation: RunnerInvocation,
  argv: readonly string[],
): string[] {
  return [
    '--user',
    '--scope',
    '--quiet',
    '--collect',
    ...literalArgv,
    `--unit=${unitBase}`,
    '--',
    ...invocation,
    '--',
    ...argv,
  ]
}

function directOutcome(
  child: ReturnType<typeof spawn>,
  startup: LinuxScopeStartup,
): Promise<SubprocessOutcome> {
  return new Promise((resolveOutcome, rejectOutcome) => {
    let settled = false
    child.once('error', (error) => {
      if (settled) return
      settled = true
      rejectOutcome(error)
    })
    child.once('exit', (exitCode, signal) => {
      if (settled) return
      settled = true
      try {
        resolveOutcome(startup.resolveOutcome({ exitCode, signal }))
      } catch (error) {
        /* v8 ignore next -- Node filesystem operations throw Error instances. */
        const failure = error instanceof Error ? error : new Error(String(error))
        rejectOutcome(failure)
      }
    })
  })
}

/**
 * 发送一个直接进程信号，区分缺失的 PID 与失败的投递。
 * @param pid - 被拥有的直接进程身份，其退出通知可能仍在等待中。
 * @param send - 平台信号操作；返回 true 表示信号已提交。
 * @returns 信号是否已提交，或该被拥有的 PID 是否已缺失。
 */
export function signalLinuxDirectProcess(pid: number, send: () => boolean): boolean {
  try {
    if (send()) return true
  } catch { /* 一次失败的信号仍允许一次独立的缺失观察。 */ }
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

function signalChildGroup(child: ReturnType<typeof spawn>, signal: 'SIGTERM' | 'SIGKILL'): boolean {
  let groupSignalled = false
  try {
    groupSignalled = process.kill(-(child.pid as number), signal)
  } catch { /* 缺失或不可访问的进程组仍允许一次直接进程的尝试。 */ }
  if (groupSignalled && signal === 'SIGTERM') return true
  // 组的成功可能反映的是另一个成员；要并入直接退出，需要它自身的 SIGKILL 提交。
  // ChildProcess.kill 可能抛出一个错误，在真正退出之前便结算了 directOutcome。
  return signalLinuxDirectProcess(child.pid as number, () => process.kill(child.pid as number, signal))
}

/** 对应一次性 scope/bootstrap 的 Linux PTY 调用与所有者。 */
export interface LinuxTerminalScopeLaunch {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  bindOwner: (direct: DirectRange) => BoundProcessOwner
  resolveOutcome: (outcome: SubprocessOutcome) => SubprocessOutcome
  cleanup: () => void
}

/**
 * Prepare one Linux PTY scope using the same launch request and bootstrap core.
 * @param spec - terminal target request.
 * @param targetEnv - validated complete target environment.
 * @param literalArgv - options from the provider's positive scope probe.
 * @param internals - optional runner and systemd seams used by tests.
 * @returns invocation and ownership callbacks; requested termination preserves the observed signal even before bootstrap consumption.
 */
export function prepareLinuxTerminalScope(
  spec: SubprocessTerminalSpawnSpec,
  targetEnv: Record<string, string>,
  literalArgv: LiteralArgvOptions,
  internals: LinuxScopeInternals = {},
): LinuxTerminalScopeLaunch {
  const invocation = internals.runnerInvocation ?? spawnRunnerInvocation()
  const files = createLinuxLaunchFiles({ cwd: spec.cwd, env: targetEnv })
  const startup = new LinuxScopeStartup(files, 'terminal')
  const unitBase = unitStem('dsh-terminal')
  return {
    command: internals.systemdRun ?? 'systemd-run',
    args: scopeArgs(unitBase, literalArgv, invocation, spec.argv),
    cwd: process.cwd(),
    env: runnerEnvironment(files.requestPath, invocation),
    bindOwner: direct => new SystemdScopeOwner(
      `${unitBase}.scope`,
      startup,
      direct,
      internals.systemctl ?? 'systemctl',
      internals.spawnSync ?? spawnSync,
      internals.systemctlQuery ?? querySystemctl,
      internals.sleep ?? sleepWithAbort,
    ),
    resolveOutcome: outcome => startup.resolveOutcome(outcome),
    cleanup: () => { cleanupLinuxLaunchFiles(files) },
  }
}

/**
 * 在一个临时用户 scope 内启动一个普通目标。
 * @param spec - 普通目标请求。
 * @param targetEnv - 经过校验的完整目标环境。
 * @param literalArgv - 来自提供方肯定 scope 探测的选项。
 * @param internals - 由测试使用的、可选的 runner 与 systemd seam。
 * @returns 流、结果以及 scope 所有者；被请求的终止会在引导程序消费之前就保留所观察到的信号。
 */
export function launchLinuxScope(
  spec: SubprocessSpawnSpec,
  targetEnv: Record<string, string>,
  literalArgv: LiteralArgvOptions,
  internals: LinuxScopeInternals = {},
): ManagedProcessLaunch {
  const invocation = internals.runnerInvocation ?? spawnRunnerInvocation()
  const files = createLinuxLaunchFiles({
    cwd: spec.cwd, env: targetEnv,
    ...spec.stdio.control === undefined ? {} : { control: spec.stdio.control },
  })
  const startup = new LinuxScopeStartup(files, 'subprocess')
  const unitBase = unitStem('dsh-subprocess')
  let child: ReturnType<typeof spawn>
  try {
    child = (internals.spawn ?? spawn)(internals.systemdRun ?? 'systemd-run', scopeArgs(
      unitBase,
      literalArgv,
      invocation,
      spec.argv,
    ), {
      cwd: process.cwd(),
      env: runnerEnvironment(files.requestPath, invocation),
      stdio: runnerStdio(spec, false),
      detached: true,
    })
  } catch (error) {
    cleanupLinuxLaunchFiles(files)
    throw error
  }
  const direct = directOutcome(child, startup)
  const owner = new SystemdScopeOwner(
    `${unitBase}.scope`,
    startup,
    {
      running: () => child.pid !== undefined && child.exitCode === null && child.signalCode === null,
      signal: signal => signalChildGroup(child, signal),
      settled: direct,
    },
    internals.systemctl ?? 'systemctl',
    internals.spawnSync ?? spawnSync,
    internals.systemctlQuery ?? querySystemctl,
    internals.sleep ?? sleepWithAbort,
  )
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    control: controlPipe(child, spec.stdio.control),
    direct,
    owner,
  }
}
