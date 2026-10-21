/**
 * bash 能力缝的本地 PowerShell 服务提供者。每条命令都通过 `ctx.subprocess`
 * 以 `pwsh -NoLogo -NoProfile -NonInteractive -Command <command>` 的形式运行在
 * 一个受管进程中；执行器负责命令默认值、期限与原因分类、对模型友好的终端
 * 环境，以及面向模型的后台读取 stdout/stderr 合并。
 *
 * 命令字符串作为单个 argv 元素传给 `-Command`：文本由 PowerShell 自己解析，
 * 中间并不存在 shell，因此没有需要转义的 shell 引用层（`bash -c` 的字符串
 * 域在这里没有对应物）。原生 Win32 路径（`C:\...`）会原样透传。
 *
 * @module @deepseek-ai/dsh-pwsh-local
 */

/* jscpd:ignore-start -- 该执行器刻意逐调用镜像 dsh-bash-local（见本包 README），
   因此两者导入同一份能力缝接口 */
import type { Volatile } from '@deepseek-ai/cordis'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { CollectedOutput, ShellExecRequest, ShellExecSpec, ShellExecution, ShellProcess, ShellProcessRead, ShellRunResult } from '@deepseek-ai/dsh-shell'
import type { SubprocessCollect, SubprocessHandle, SubprocessOutputReader, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { clampTimeout, deadline, MAX_TIMER_DELAY_MS, timeoutOf } from '@deepseek-ai/dsh-timeout'
/* jscpd:ignore-end */
import { resolvePwshPath } from './resolve.ts'

/* jscpd:ignore-start -- 对 dsh-bash-local 的逐调用刻意镜像（Agent Note: pwsh-tool-and-executor）。 */
/**
 * 面向 PowerShell 的、对模型友好的环境覆盖项：关闭会扰乱工具输出的颜色与
 * 分页器。`TERM=dumb` 属于 POSIX 概念，故刻意不设置；`NO_COLOR` 则被现代
 * 的 pwsh 渲染器所遵循。
 */
export const ENV_OVERRIDES = {
  NO_COLOR: '1',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
} as const

/**
 * 前置到每条命令之前的 UTF-8 输出固定语句。subprocess 采集器按 UTF-8 解码
 * 输出字节，但 Windows PowerShell 5.1（兜底的可执行文件）默认写入控制台／
 * OEM 代码页，这会使非 ASCII 输出变成乱码；pwsh 7 默认使用 UTF-8，不受影响。
 * 这些语句以 `; ` 分隔排在第 1 行，以保证 PowerShell 的错误行号保持准确。
 */
export const ENCODING_PREAMBLE =
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); '

/** 默认的 SIGTERM→SIGKILL 宽限期（即 `graceMs` 配置）。 */
const DEFAULT_GRACE_MS = 3_000

/** 默认的单流溢出上限（即 `maxSpillBytes` 配置）。 */
const DEFAULT_MAX_SPILL_BYTES = 64 * 1024 * 1024

/** 经过校验的插件配置，带有可变的命令预算。 */
export interface Config {
  /** 命令的默认工作目录（默认：process.cwd()）。 */
  cwd: Volatile<string | undefined>
  /** 默认的前台超时时间，单位毫秒。 */
  timeoutMs: Volatile<number>
  /** 单次调用超时覆盖值的上限。 */
  maxTimeoutMs: Volatile<number>
  /** 单流内存中输出上限；超出部分溢出到临时文件。 */
  maxOutputBytes: Volatile<number>
  /** 单流溢出文件上限；更大的流只保留其内存中的尾部。 */
  maxSpillBytes: Volatile<number>
  /** 终止升级与继承管道的宽限期；至多为 `MAX_TIMER_DELAY_MS`。 */
  graceMs: Volatile<number>
  /**
   * 显式的 pwsh 可执行文件。省略时会按顺序探测常见的 Windows 安装位置与
   * PATH 条目（PowerShell 7 安装位置、诸如 Microsoft Store 安装的 PATH
   * 条目，然后是 Windows PowerShell 5.1），最终回退到通过 PATH 解析的裸
   * `pwsh`。
   */
  pwshPath: Volatile<string | undefined>
}

// 解析逻辑放在独立的无依赖模块中，以便仓库的覆盖率网关探针与各测试套件
// 共用完全相同的定义。
export { candidatePwshPaths, resolvePwshPath } from './resolve.ts'

/** 把已落定的采集模式读取器投影为最终的 CollectedOutput 形状。 */
function finalOutput(reader: SubprocessOutputReader): CollectedOutput {
  const read = reader.readFrom(0)
  return {
    text: read.text,
    truncated: read.lossy,
    ...read.spillPath !== undefined ? { spillPath: read.spillPath } : {},
  }
}

function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`pwsh-local: ${name} must be a positive finite number`)
  }
}

/**
 * 拒绝本执行器无法据以运行的已解析配置项。schema 既无法表达“正数且有限”，
 * 也无法表达 `graceMs` 必须满足的计时器边界，因此不可用的存储值会在下一条
 * 命令处失败。
 * @param config - 实时配置，按构造过程已是 schema 校验通过的。
 * @throws Error 指出无法使用的字段。
 */
export function assertServiceablePwshConfig(config: Config): void {
  assertPositiveFinite('timeoutMs', config.timeoutMs.get())
  assertPositiveFinite('maxTimeoutMs', config.maxTimeoutMs.get())
  assertPositiveFinite('maxOutputBytes', config.maxOutputBytes.get())
  assertPositiveFinite('maxSpillBytes', config.maxSpillBytes.get())
  assertPositiveFinite('graceMs', config.graceMs.get())
  if (config.graceMs.get() > MAX_TIMER_DELAY_MS) {
    throw new Error(`pwsh-local: graceMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}

/**
 * 基于 `ctx.subprocess` 的本地 PowerShell 执行器。有界输出、溢出文件与
 * 托管进程的终止都是 subprocess 服务的机制；本执行器为每次 spawn 提供
 * 它们已配置的预算。
 */
export class PwshLocalExecutor extends ShellExecutor {
  static inject = ['subprocess']

  static Config = z.object({
    cwd: z.string().volatile(),
    timeoutMs: z.number().default(120_000).volatile(),
    maxTimeoutMs: z.number().default(600_000).volatile(),
    maxOutputBytes: z.number().default(64_000).volatile(),
    maxSpillBytes: z.number().default(DEFAULT_MAX_SPILL_BYTES).volatile(),
    graceMs: z.number().default(DEFAULT_GRACE_MS).volatile(),
    pwshPath: z.string().volatile(),
  })

  /** 当前 {@link pwshPath} 所由以解析的已声明可执行文件。 */
  private declaredPwshPath: string | undefined

  /** 依据当前配置解析出的 pwsh 可执行文件。 */
  private resolvedPwshPath: string

  /** 所有命令经由的 pwsh 可执行文件；声明路径发生变化时会在下次读取时重新探测。 */
  get pwshPath(): string {
    const declared = this.config.pwshPath.get()
    if (declared !== this.declaredPwshPath) {
      this.resolvedPwshPath = resolvePwshPath(declared)
      this.declaredPwshPath = declared
    }
    return this.resolvedPwshPath
  }

  constructor(ctx: Context, readonly config: Config) {
    super(ctx)
    this.declaredPwshPath = config.pwshPath.get()
    this.resolvedPwshPath = resolvePwshPath(this.declaredPwshPath)
  }

  /**
   * 把请求解析为完全确定的规约：`workdir` 由 `config.cwd` 填充（否则取
   * `process.cwd()`），`timeoutMs` 由 `config.timeoutMs` 填充并以
   * `config.maxTimeoutMs` 为上限。
   */
  resolve(request: ShellExecRequest): ShellExecSpec {
    assertServiceablePwshConfig(this.config)
    const timeoutMs = clampTimeout(
      request.timeoutMs,
      this.config.timeoutMs.get(),
      this.config.maxTimeoutMs.get(),
      'pwsh-local: request.timeoutMs',
    )
    const stdoutMaxBytes = request.stdoutMaxBytes ?? this.config.maxOutputBytes.get()
    assertPositiveFinite('request.stdoutMaxBytes', stdoutMaxBytes)
    return {
      command: request.command,
      workdir: request.workdir ?? this.config.cwd.get() ?? process.cwd(),
      timeoutMs,
      onExpiry: request.onExpiry ?? 'kill',
      stdoutMaxBytes,
      ...request.signal ? { signal: request.signal } : {},
      ...request.stdin !== undefined ? { stdin: request.stdin } : {},
      ...request.env !== undefined ? { env: request.env } : {},
      ...request.dshEnv !== undefined ? { dshEnv: request.dshEnv } : {},
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  /**
   * 一份已解析规约对应的 pwsh 调用 argv——这是隔离型子类通过
   * `ctx.sandbox.confine` 包装的 argv 级接缝（即 `dsh-bash-local` 的
   * `executeArgv` 钩子的 pwsh 孪生体；参见 `@deepseek-ai/dsh-pwsh-sandbox`）。
   */
  protected argv(spec: ShellExecSpec): string[] {
    return [this.pwshPath, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `${ENCODING_PREAMBLE}${spec.command}`]
  }

  /** 把一份已解析规约及其 argv 映射为完全确定的 subprocess spawn 规约。 */
  private spawnSpec(
    spec: ShellExecSpec,
    stdoutMaxBytes: number,
    signal: AbortSignal | undefined,
    argv: readonly string[],
  ): SubprocessSpawnSpec {
    const collect = (maxBytes: number): SubprocessCollect =>
      ({ maxBytes, spill: { maxBytes: this.config.maxSpillBytes.get() } })
    return {
      argv: [...argv],
      cwd: spec.workdir,
      stdio: {
        stdin: spec.stdin !== undefined ? { data: spec.stdin } : 'ignore',
        stdout: collect(stdoutMaxBytes),
        stderr: collect(this.config.maxOutputBytes.get()),
      },
      graceMs: this.config.graceMs.get(),
      signal,
      env: { ...ENV_OVERRIDES, ...spec.env, ...spec.dshEnv },
    }
  }

  /** 执行器自身请求的采集模式读取器（按构造过程必然存在）。 */
  private static collected(handle: SubprocessHandle): { stdout: SubprocessOutputReader; stderr: SubprocessOutputReader } {
    const { stdout, stderr } = handle.collected
    /* v8 ignore start -- 按能力缝契约，采集 disposition 会暴露两个读取器；此处为防御性检查。 */
    if (stdout === undefined || stderr === undefined) {
      throw new Error('pwsh-local: subprocess implementation dropped a requested collect stream')
    }
    /* v8 ignore stop */
    return { stdout, stderr }
  }

  async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    return this.executeArgv(spec, this.argv(spec))
  }

  /**
   * 以本执行器的生命周期、环境、输出、期限与取消语义执行一个显式 argv。
   * 子类在执行边界处替换掉公开命令的 shell argv 之后使用它。
   * @param spec - 已解析的执行设置与调用方持有的命令元数据。
   * @param argvOrPrepare - 精确的 argv，或使用执行取消信号的准备函数。
   * @param onStarted - 在句柄可能落定之前同步地写入 provider 事实。
   * @returns 处于活动状态的执行句柄；spawn 被拒绝会让句柄以 killed 落定，
   *   而 `result()` 则以拒绝形式承载同一失败。
   */
  protected async executeArgv(
    spec: ShellExecSpec,
    argvOrPrepare: readonly string[] | ((signal: AbortSignal) => Promise<readonly string[]>),
    onStarted?: (process: ShellExecution) => void,
  ): Promise<ShellExecution> {
    // 按期限策略接线。每个分支都提供 spawn 信号、结果投影的首因分类，
    // 以及落定后续流程要运行的解除操作。`ShellExpiryPolicy` 恰好只有
    // 这两个成员，因此 `else` 分支即为 `'none'`。
    let spawnSignal: AbortSignal | undefined
    let classify: () => { timedOut: boolean; aborted: boolean }
    let disarm = (): void => {}
    if (spec.onExpiry === 'kill') {
      // 单一的融合期限同时涵盖超时与上游取消；只有本执行器的超时原因才
      // 计为 timedOut，外层期限计为中止。
      const d = deadline(spec.signal, spec.timeoutMs, 'BASH_TIMEOUT')
      spawnSignal = d.signal
      classify = () => {
        const timedOut = timeoutOf(d.signal, 'BASH_TIMEOUT') !== undefined
        return { timedOut, aborted: d.signal.aborted && !timedOut }
      }
      disarm = () => { d[Symbol.dispose]() }
    } else {
      // 无期限：调用方通过 kill() 或 spec.signal 停止进程。
      spawnSignal = spec.signal
      classify = () => ({ timedOut: false, aborted: spec.signal?.aborted === true })
    }

    let argv: readonly string[] = []
    let preparationTimedOut = false
    if (typeof argvOrPrepare === 'function') {
      const signal = spawnSignal ?? new AbortController().signal
      const cancelled = Promise.withResolvers<never>()
      const abort = (): void => { cancelled.reject(signal.reason) }
      signal.addEventListener('abort', abort, { once: true })
      try {
        argv = await Promise.race([
          Promise.resolve().then(() => { signal.throwIfAborted(); return argvOrPrepare(signal) }),
          cancelled.promise,
        ])
        signal.throwIfAborted()
      } catch (error) {
        if (!classify().timedOut) {
          disarm()
          throw error
        }
        preparationTimedOut = true
      } finally { signal.removeEventListener('abort', abort) }
    } else { argv = argvOrPrepare }

    // 同步的 spawn 抛出（预先中止的信号、其他 subprocess 实现）会被收束到
    // 与异步 spawn 拒绝相同的“以 killed 落定”形状，因此 execute() 自身
    // 永远不会因 spawn 问题而抛出，失败由 result() 统一承载。
    let running: SubprocessHandle | undefined
    let syncSpawnError: { error: unknown } | undefined
    try {
      if (!preparationTimedOut) {
        running = this.ctx.subprocess.spawn(this.spawnSpec(spec, spec.stdoutMaxBytes, spawnSignal, argv))
      }
    } catch (error) {
      syncSpawnError = { error }
    }
    const emptyReader: SubprocessOutputReader = {
      readFrom: () => ({ text: '', lossy: false, nextOffset: 0 }),
    }
    const collected = running !== undefined
      ? PwshLocalExecutor.collected(running)
      : { stdout: emptyReader, stderr: emptyReader }
    const spawnThrow = (): unknown => (syncSpawnError as { error: unknown }).error
    const spawned = preparationTimedOut
      ? Promise.resolve({ exitCode: null, signal: null })
      : running !== undefined ? running.done
      // 即使原始抛出值不是 Error，也原样保留给调用方。
      // eslint-disable-next-line prefer-promise-reject-errors
        : Promise.reject(spawnThrow())

    // provider 拒绝不产生任何进程输出，因此 subprocess 服务没有可缓冲的
    // 内容：provider 一旦拒绝，它与阶段无关的提示就是所有读取器看到的整条
    // stderr 流。观察型读取器在偏移 0 处提供它，消费型读取恰好把它并入
    // 一次，而保留下来的错误则是 result() 投影的拒绝原因。
    let providerFailure: { error: unknown; note: string } | undefined
    let providerFailureReported = false
    const consumeProviderFailure = (): string => {
      if (providerFailure === undefined || providerFailureReported) return ''
      providerFailureReported = true
      return providerFailure.note
    }
    const observedStderr: SubprocessOutputReader = {
      readFrom: (fromByte) => {
        if (providerFailure === undefined) return collected.stderr.readFrom(fromByte)
        const note = Buffer.from(providerFailure.note, 'utf8')
        return { text: note.subarray(Math.min(fromByte, note.length)).toString('utf8'), nextOffset: note.length, lossy: false }
      },
    }

    let stdoutOffset = 0
    let stderrOffset = 0
    let resultPromise: Promise<ShellRunResult> | undefined
    const proc: ShellExecution = {
      status: 'running',
      exitCode: null,
      signal: null,
      observed: { stdout: collected.stdout, stderr: observedStderr },
      done: spawned.then((outcome) => {
        // 任何信号终止都算 killed，包括命令自己给自己发信号的情形。
        if (proc.status === 'running') {
          proc.status = spawnSignal?.aborted === true || outcome.signal !== null ? 'killed' : 'completed'
        }
        proc.exitCode = outcome.exitCode
        proc.signal = outcome.signal
        this.onProcessDone(proc, collected.stderr.readFrom(0).text, false)
        disarm()
      }, (error: unknown) => {
        // 一个活动句柄若其拒绝紧跟本次执行自身的终止——kill() 或 spawn
        // 信号的中止——则上报其终止结局：在目标启动之前就终止该进程的
        // provider 没有可上报的退出信息，而是以取消原因拒绝。结果投影
        // 依据期限接线对其分类；这里不存在 provider 失败。同步的 spawn
        // 抛出从未产生句柄，因此仍然算作失败。
        if (running !== undefined && (proc.status === 'killed' || spawnSignal?.aborted === true)) {
          proc.status = 'killed'
          this.onProcessDone(proc, collected.stderr.readFrom(0).text, false)
          disarm()
          return
        }
        // provider 失败会让句柄以 killed 落定，并对所有读取器暴露在 stderr 上。
        proc.status = 'killed'
        let detail = 'unprintable provider failure'
        try {
          detail = String(error)
        } catch {
          // provider 持有的拒绝值不能让 ShellProcess.done 变为拒绝。
        }
        providerFailure = { error, note: `subprocess failed before reporting an outcome: ${detail}` }
        this.onProcessDone(proc, providerFailure.note, true, error)
        disarm()
      }),
      readOutput: (): ShellProcessRead => {
        const out = collected.stdout.readFrom(stdoutOffset)
        const err = collected.stderr.readFrom(stderrOffset)
        stdoutOffset = out.nextOffset
        stderrOffset = err.nextOffset

        const providerFailure = consumeProviderFailure()
        const failureSeparator = err.text.length > 0 && !err.text.endsWith('\n') ? '\n' : ''
        const errText = err.text
          + (providerFailure.length > 0 ? `${failureSeparator}${providerFailure}` : '')
        // 区块之间只保留单个换行：stdout 分块通常已经以换行结尾，
        // 仅在缺失时才补上。
        const separator = out.text.length > 0 && !out.text.endsWith('\n') ? '\n' : ''
        const delta = out.text
          + (errText.length > 0 ? `${separator}[stderr]\n${errText}` : '')
        return {
          delta,
          lossy: out.lossy || err.lossy,
          ...out.spillPath !== undefined ? { stdoutSpillPath: out.spillPath } : {},
          ...err.spillPath !== undefined ? { stderrSpillPath: err.spillPath } : {},
        }
      },
      kill: (): boolean => {
        if (proc.status !== 'running') return false
        proc.status = 'killed'
        running?.terminate()
        return true
      },
      result: (): Promise<ShellRunResult> => {
        resultPromise ??= proc.done.then(() => {
          // 与历史前台路径在基础设施故障上保持一致：
          // 从未产生进程的 spawn 会让该投影拒绝。
          if (providerFailure !== undefined) throw providerFailure.error
          return {
            exitCode: proc.exitCode,
            signal: proc.signal,
            ...classify(),
            timeoutMs: spec.timeoutMs,
            stdout: finalOutput(collected.stdout),
            stderr: finalOutput(collected.stderr),
          }
        })
        return resultPromise
      },
    }
    if (!preparationTimedOut) onStarted?.(proc)
    return proc
  }

  /**
   * 供子类把执行事实挂到进程上的落定钩子。基类实现刻意为空。此处镜像自
   * `dsh-bash-local`（其沙箱子类消费同一钩子）；pwsh 隔离场景的消费方是
   * `@deepseek-ai/dsh-pwsh-sandbox`。
   * @param _proc - 已落定的进程句柄。
   * @param _stderr - 进程保留的 stderr 尾部，子类据此进行落定分类。
   * @param _providerRejected - subprocess promise 是否在没有直接结局的情况下拒绝。
   * @param _providerError - provider 的拒绝原因，其自身也可能为 undefined。
   */
  protected onProcessDone(_proc: ShellProcess, _stderr: string, _providerRejected: boolean, _providerError?: unknown): void {}
}
/* jscpd:ignore-end */

export default PwshLocalExecutor
