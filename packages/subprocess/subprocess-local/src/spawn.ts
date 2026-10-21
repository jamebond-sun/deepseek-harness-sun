/**
 * 本地 subprocess 服务的进程管道：带逐流 stdio 处理方式的普通进程启动、
 * 带溢出文件的尾部保留收集、提供方拥有的范围信令，以及通用的终止调度。
 * POSIX 所有者会在 KILL 之前先发 TERM；Windows 所有者则立即终止。
 * 这一层只响应中止信号；超时分类、拆除阶梯与原因归类由调用方负责。
 * @module dsh-subprocess-local/spawn
 */

import { type ChildProcess, type SpawnOptions, spawn, spawnSync } from 'node:child_process'
import type { Readable } from 'node:stream'
import { setTimeout as sleepMs } from 'node:timers/promises'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type {
  SubprocessCollect,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputMode,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type { BoundProcessOwner, ManagedProcessLaunch } from './managed-owner.ts'
import { waitWithAbort } from './managed-owner.ts'
import { controlEnvironment, controlPipe } from './control-spawn.ts'
import { SUBPROCESS_CONTROL_FD } from '@deepseek-ai/dsh-subprocess/control'
import { linuxProcessGroupHasLiveMembers } from './process-inspector.ts'
import { OutputCollector, prepareManagedProcessBinding, type SpillFailureReporter } from './output.ts'

type SpawnProcess = (
  program: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess

/**
 * 构建子进程环境：显式的调用方条目按目标平台的环境键语义覆盖已清理的
 * 父进程基表。字符串值会有意恢复或覆盖某个条目；显式的 `undefined`
 * 墓碑则移除一个普通的既有条目。
 * @param extra - 在清理之后合并的、显式调用方条目与墓碑。
 * @returns 要交给 `spawn` 用于子进程的环境。
 */
export function childEnv(extra?: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const env = scrubbedParentEnv()
  if (process.platform !== 'win32') return { ...env, ...extra }
  let entries: [string, string | undefined][] = Object.entries(env)
  for (const [key, value] of Object.entries(extra ?? {})) {
    const normalized = key.toUpperCase()
    entries = entries.filter(([inherited]) => inherited.toUpperCase() !== normalized)
    entries.push([key, value])
  }
  return Object.fromEntries(entries)
}

/** 可注入的进程、溢出与平台操作。 */
export interface SpawnInternals {
  /** 进程启动器（默认为 `node:child_process` 的 `spawn`）。 */
  spawn?: SpawnProcess
  /** 溢出文件目录（默认为操作系统临时目录）。 */
  spillDir?: string
  /** 接收溢出打开/写入失败；运行时提供其插件日志器，裸调用方会得到一行 stderr。 */
  onSpillFailure?: SpillFailureReporter
  /** Windows 树形终止运行器（默认为 `taskkill /PID <pid> /T /F`）。 */
  taskkill?: (pid: number) => void
  /** 用于信令决策的主机平台覆盖项。 */
  platform?: NodeJS.Platform
  /** Linux 进程组成员探测（默认为 `/proc` 检查）。 */
  linuxProcessGroupHasLiveMembers?: (processGroupId: number) => boolean | undefined
}

/**
 * 本地专有的同步最终终止，由拥有方服务在主机退出时使用，并作为正常释放失败后的
 * 最后回退。它刻意不出现在公开的 subprocess 能力 seam 中。
 */
export interface LocalSubprocessHandle extends SubprocessHandle {
  /** 在不启动定时器或等待的情况下，同步强制终止当前进程树。 */
  terminateForHostExit(): void
}

/**
 * 树形退出等待的存活轮询节拍。该定时器保持有引用：被 await 的拆除必须让事件循环
 * 持续运行，直到进程树真正退出，否则父进程可能在声明已静默并承诺回收其幸存者时
 * 提前退出，从而让这些幸存者变成孤儿。
 */
function sleepTick(): Promise<void> {
  return sleepMs(15)
}

/**
 * 向一个分离的 POSIX 进程组发送 `sig`。绝不抛错：投递会与进程退出竞争，
 * 并可能在定时器回调中运行，因此失败被就地遏制，缺失的 pid 则是一次空操作。
 * @param pid - 组领导者的 pid，仅当启动发布过它时才有。
 * @param sig - 要投递给整个进程组的信号。
 */
export function killGroup(pid: number | undefined, sig: NodeJS.Signals): void {
  if (pid === undefined) return
  try {
    process.kill(-pid, sig)
  } catch {
    // Swallow: see contract above.
  }
}

/**
 * 用 `taskkill /T /F` 终止一棵 Windows 进程树。其遏制方式类似于 POSIX 组信令——
 * 投递会与树退出竞争，因此缺失的树、非零状态，或缺失的 taskkill 二进制文件
 * 都不能破坏幂等的拆除。
 * @param pid - 根进程 id，仅当启动发布过它时才有。
 */
export function taskkillProcessTree(pid: number | undefined): void {
  if (pid === undefined || pid <= 0) return
  // 结果刻意不检查：一个已经不存在的树（状态 128）、退出竞争，以及缺失的
  // taskkill 二进制（spawnSync 只报告、绝不抛错），在这里与 POSIX 组信号遇到
  // ESRCH 时一样可被容忍。
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
  })
}

/**
 * 以平台正确的语义向一棵分离的进程树发信号：POSIX 向负的进程组 id 发信号，
 * 并在组消失时回退到直接子进程；Windows 通过 taskkill 终止该树（任何信号值都会
 * 强制终止——Node 把信号映射为 TerminateProcess）。
 */
function signalTree(
  platform: NodeJS.Platform,
  pid: number | undefined,
  sig: NodeJS.Signals,
  child: ChildProcess,
  taskkill: (pid: number) => void,
): void {
  /* v8 ignore next -- kill/terminate 以 treeAlive() 为门，没有 pid 时为假；此守卫只保护直接调用方。 */
  if (pid === undefined) return
  if (platform === 'win32') {
    taskkill(pid)
    return
  }
  try {
    process.kill(-pid, sig)
  } catch {
    /* v8 ignore start -- the fallback needs a live child whose group signal fails
       (EPERM-style), which POSIX CI cannot stage; the swallow keeps teardown idempotent. */
    try {
      child.kill(sig)
    } catch {
      // 直接子进程已退出；拆除仍保持幂等。
    }
    /* v8 ignore stop */
  }
}

/**
 * 校验一次普通启动请求的同步部分。
 * @param spec - 精确的目标请求。
 * @throws 当宽限、取消或 argv 在启动前无效时。
 */
export function validateSubprocessSpec(spec: SubprocessSpawnSpec): void {
  if (!Number.isFinite(spec.graceMs) || spec.graceMs <= 0 || spec.graceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`subprocess graceMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (spec.signal?.aborted) {
    let reason = 'aborted'
    try {
      reason = String(spec.signal.reason ?? reason)
    } catch {
      // 任意的、由调用方拥有的原因不能逸出这个稳定的错误边界。
    }
    throw new Error(`aborted before spawn: ${reason}`)
  }
  const [program] = spec.argv
  if (program === undefined || program.length === 0) {
    throw new Error('invalid argv: expected a non-empty program name at argv[0]')
  }
}

function directChildResult(child: ChildProcess): Promise<SubprocessOutcome> {
  return new Promise((resolve, reject) => {
    let completed = false
    child.once('error', (error) => {
      /* v8 ignore next -- ChildProcess 可能在终态退出事件之后又报告一次运行期错误；首个终态事件拥有该结果。 */
      if (completed) return
      completed = true
      reject(error)
    })
    child.once('exit', (exitCode, signal) => {
      /* v8 ignore next -- 一次 spawn/kill 错误之后可能紧跟着退出；Promise 只能发布首个终态事件。 */
      if (completed) return
      completed = true
      resolve({ exitCode, signal })
    })
  })
}

function fallbackOwner(
  platform: NodeJS.Platform,
  pid: number | undefined,
  child: ChildProcess,
  taskkill: (pid: number) => void,
  linuxGroupHasLiveMembers: (processGroupId: number) => boolean | undefined,
  direct: Promise<SubprocessOutcome>,
): BoundProcessOwner {
  let stopped = false
  let directSettled = false
  let observation: Promise<void> | undefined
  void direct.then(
    () => { directSettled = true },
    () => { directSettled = true },
  )

  const alive = (): boolean => {
    if (stopped || pid === undefined) return false
    if (platform === 'win32') return child.exitCode === null && child.signalCode === null
    try {
      process.kill(-pid, 0)
      if (directSettled && platform === 'linux' && linuxGroupHasLiveMembers(pid) === false) return false
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ESRCH') return false
      /* v8 ignore start -- EPERM 与非 POSIX 负 pid 失败都属于平台防御。 */
      if (code === 'EPERM') return true
      return child.exitCode === null && child.signalCode === null
      /* v8 ignore stop */
    }
  }

  return {
    signal: (signal) => {
      if (!alive()) {
        stopped = true
        return
      }
      signalTree(platform, pid, signal, child, taskkill)
    },
    waitForExit: async () => {
      /* v8 ignore next -- bindManagedProcess memoizes this owner wait; the guard only
         protects direct internal re-entry after signal() observed absence. */
      if (stopped) return
      observation ??= (async () => {
        while (alive()) await sleepTick()
        stopped = true
      })()
      await observation
    },
    terminateForHostExit: () => {
      if (stopped) return
      signalTree(platform, pid, 'SIGKILL', child, taskkill)
    },
  }
}

/**
 * 将平台启动事实绑定到既有的 stdio、结果、中止与终止生命周期上。
 * @param spec - 完全解析后的 argv、cwd、stdio、宽限、取消与环境。
 * @param launch - 平台流、直接结果与受管范围所有者。
 * @param internals - 溢出目录覆盖项与溢出失败报告器。
 * @returns 存活的 subprocess 句柄。
 */
export function bindManagedProcess(
  spec: SubprocessSpawnSpec,
  launch: ManagedProcessLaunch,
  internals: Pick<SpawnInternals, 'spillDir' | 'onSpillFailure'> = {},
): LocalSubprocessHandle {
  const { spillDir, onSpillFailure } = prepareManagedProcessBinding(internals)
  const { stdin, stdout, stderr } = launch

  const isCollect = (mode: SubprocessOutputMode): mode is SubprocessCollect =>
    mode !== 'pipe' && mode !== 'inherit'
  const outMode = spec.stdio.stdout
  const errMode = spec.stdio.stderr
  const stdinMode = spec.stdio.stdin

  const collectStream = (mode: SubprocessOutputMode, stream: Readable | null, label: string): OutputCollector | undefined => {
    if (!isCollect(mode) || stream === null) return undefined
    const collector = new OutputCollector(
      mode.maxBytes,
      label,
      mode.spill === undefined ? undefined : { maxBytes: mode.spill.maxBytes, dir: spillDir, onFailure: onSpillFailure },
    )
    stream.on('data', (chunk: Buffer) => { collector.push(chunk) })
    return collector
  }
  const stdoutCollector = collectStream(outMode, stdout, 'stdout')
  const stderrCollector = collectStream(errMode, stderr, 'stderr')
  const observeOutputStream = (mode: SubprocessOutputMode, stream: Readable | null): Promise<void> | undefined => {
    if (mode === 'inherit' || stream === null || stream.readableEnded || stream.destroyed) return undefined
    return new Promise((resolve) => {
      const settle = (): void => {
        stream.off('end', settle)
        stream.off('close', settle)
        stream.off('error', settle)
        resolve()
      }
      stream.once('end', settle)
      stream.once('close', settle)
      stream.once('error', settle)
    })
  }
  const stdoutClosed = observeOutputStream(outMode, stdout)
  const stderrClosed = observeOutputStream(errMode, stderr)
  const outputStreamsClosed = Promise.all([stdoutClosed, stderrClosed])
  const stopCollectors = (): void => {
    if (stdoutCollector !== undefined) stdout?.destroy()
    if (stderrCollector !== undefined) stderr?.destroy()
    stdoutCollector?.seal()
    stderrCollector?.seal()
  }

  let graceTimer: ReturnType<typeof setTimeout> | undefined
  let terminationStarted = false
  let rangeExitObserved = false
  let rangeExitObservation: Promise<void> | undefined
  let settled = false

  const scheduleOwnerCleanup = (): boolean => {
    if (launch.owner.cleanup === undefined) return false
    queueMicrotask(() => { void done.finally(() => { launch.owner.cleanup?.() }).catch(() => {}) })
    return true
  }

  /**
   * Start or reuse the handle's managed-range exit observer. A failed read
   * before direct settlement can be retried. Once direct settlement permits
   * cleanup, retain a failed observation because removing its private evidence
   * must not turn a later wait into a false success. The first confirmed
   * absence is the permanent no-more-signals boundary and cancels pending
   * escalation before stale identity can be used.
   */
  const observeRangeExit = (): Promise<void> => {
    rangeExitObservation ??= (async () => {
      await launch.owner.waitForExit()
      rangeExitObserved = true
      if (graceTimer !== undefined) clearTimeout(graceTimer)
      graceTimer = undefined
      spec.signal?.removeEventListener('abort', onAbort)
      scheduleOwnerCleanup()
    })().catch((error: unknown) => {
      if (!settled || !scheduleOwnerCleanup()) rangeExitObservation = undefined
      throw error
    })
    return rangeExitObservation
  }

  const kill = (sig: 'SIGTERM' | 'SIGKILL', cancellationReason?: unknown): void => {
    if (rangeExitObserved) return
    launch.owner.signal(sig, cancellationReason)
  }

  const terminateWithReason = (cancellationReason: unknown): void => {
    if (rangeExitObserved || terminationStarted) return
    terminationStarted = true
    // 让 waitForExit() 仍能拿到共享的观察拒绝，同时避免在调用方只调用 terminate() 时泄漏未处理的拒绝。
    void observeRangeExit().catch(() => {})
    kill('SIGTERM', cancellationReason)
    graceTimer = setTimeout(() => {
      graceTimer = undefined
      kill('SIGKILL')
    }, spec.graceMs)
  }

  const terminate = (): void => {
    terminateWithReason(new Error('subprocess terminated before target start'))
  }

  const terminateForHostExit = (): void => {
    launch.owner.terminateForHostExit()
  }

  // 超时分类由调用方负责；这一层只响应 abort。
  const onAbort = (): void => { terminateWithReason(spec.signal?.reason) }
  spec.signal?.addEventListener('abort', onAbort, { once: true })

  // 批量 stdin 在开头就写入并关闭；进程退出与已捕获的输出仍是权威来源，因此写入错误（EPIPE）是尽力而为的。
  if (typeof stdinMode === 'object' && stdin !== null) {
    stdin.on('error', () => { /* stdin 写入是尽力而为的；结果取决于退出/输出。 */ })
    stdin.end(stdinMode.data)
  }

  const done = new Promise<SubprocessOutcome>((resolve, reject) => {
    let pipeDrainTimer: ReturnType<typeof setTimeout> | undefined
    const settle = (outcome: SubprocessOutcome): void => {
      if (settled) return
      settled = true
      // 在排空边界只有由 harness 收集的管道会被强制关闭；'pipe' 模式的流属于调用方，会随子进程一同关闭。
      stopCollectors()
      cleanup()
      resolve(outcome)
    }
    const fail = (error: unknown): void => {
      settled = true
      terminate()
      stopCollectors()
      cleanup()
      // 保留确切的、父进程本地的 AbortSignal 原因，包括 null 或 undefined。
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Exact cancellation reason is the contract.
      reject(error)
    }
    launch.direct.then((outcome) => {
      if (stdoutClosed === undefined && stderrClosed === undefined) {
        settle(outcome)
        return
      }
      pipeDrainTimer = setTimeout(() => { settle(outcome) }, spec.graceMs)
      void outputStreamsClosed.then(() => { settle(outcome) })
    }, fail)
    function cleanup(): void {
      // graceTimer 刻意不清空：在启动的命令结算之后，强制终止仍必须能触及范围内的幸存者。
      if (pipeDrainTimer !== undefined) clearTimeout(pipeDrainTimer)
    }
  })

  const waitForExit = async (signal?: AbortSignal): Promise<boolean> => {
    if (rangeExitObserved) return true
    return waitWithAbort(observeRangeExit(), signal)
  }

  return {
    /* v8 ignore start -- pipe 模式的流在每一次合规启动中都存在；空值合并只是防御一个内部适配缺陷。 */
    stdin: stdinMode === 'pipe' ? stdin ?? undefined : undefined,
    stdout: outMode === 'pipe' ? stdout ?? undefined : undefined,
    stderr: errMode === 'pipe' ? stderr ?? undefined : undefined,
    control: launch.control,
    /* v8 ignore stop */
    collected: {
      ...stdoutCollector !== undefined ? { stdout: stdoutCollector } : {},
      ...stderrCollector !== undefined ? { stderr: stderrCollector } : {},
    },
    done,
    terminate,
    terminateForHostExit,
    waitForExit,
  }
}

/**
 * 启动一个分离的 PGID/taskkill 回退，并绑定通用生命周期。
 * @param spec - 完全解析后的 argv、cwd、stdio、宽限、取消与环境。
 * @param internals - 仅用于测试的溢出目录、平台与 taskkill 覆盖项。
 * @returns 存活的 subprocess 句柄。
 */
export function spawnSubprocess(spec: SubprocessSpawnSpec, internals: SpawnInternals = {}): LocalSubprocessHandle {
  const binding = prepareManagedProcessBinding(internals)
  const platform = internals.platform ?? process.platform
  const [program, ...args] = spec.argv
  const stdio: import('node:child_process').StdioOptions = [
    spec.stdio.stdin === 'ignore' ? 'ignore' : 'pipe',
    spec.stdio.stdout === 'inherit' ? 'inherit' : 'pipe',
    spec.stdio.stderr === 'inherit' ? 'inherit' : 'pipe',
  ]
  if (spec.stdio.control === 'pipe') {
    while (stdio.length < SUBPROCESS_CONTROL_FD) stdio.push('ignore')
    stdio.push('overlapped')
  }
  const child = (internals.spawn ?? spawn)(program as string, args, {
    cwd: spec.cwd,
    env: controlEnvironment(childEnv(spec.env), spec.stdio.control),
    stdio,
    detached: platform !== 'win32',
    windowsHide: platform === 'win32',
  })
  const direct = directChildResult(child)
  const pid = child.pid
  const owner = fallbackOwner(
    platform,
    pid,
    child,
    internals.taskkill ?? taskkillProcessTree,
    internals.linuxProcessGroupHasLiveMembers ?? linuxProcessGroupHasLiveMembers,
    direct,
  )
  return bindManagedProcess(spec, {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    control: controlPipe(child, spec.stdio.control),
    direct,
    owner,
  }, binding)
}
