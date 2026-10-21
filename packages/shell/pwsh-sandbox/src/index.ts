/**
 * 消费沙箱的 PowerShell 执行器——`@deepseek-ai/dsh-bash-sandbox` 的 pwsh
 * 孪生体。它通过 `ctx.sandbox`（在 Windows 上解析为 ACL 受限令牌运行器链）
 * 包装本地 pwsh 的精确 argv，继承本地进程机制，并上报所选模式、执行程度
 * 与拒绝事实。运行器可执行文件的正面证据标识出一个已损坏的隔离运行器：
 * 前台调用抛出 `SANDBOX_UNAVAILABLE`，后台进程则携带 `runnerFailed`；其他
 * provider 拒绝仍保留与阶段无关的本地执行器语义。工具层通过 `ctx.approval`
 * 持有升级审批流程；本执行器负责上报工具要渲染的沙箱事实。
 * @module @deepseek-ai/dsh-pwsh-sandbox
 */

import { Context } from '@deepseek-ai/cordis'
import type { ShellExecRequest, ShellExecSpec, ShellExecution, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type {
  ConfinedArgv,
  ConfinedSandboxMode,
  RunnerFailureRule,
  SandboxEnforcement,
  SandboxExecutionPolicy,
  SandboxMode,
  SandboxPolicy,
} from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { PwshLocalExecutor } from '@deepseek-ai/dsh-pwsh-local'
import type { Config as LocalConfig } from '@deepseek-ai/dsh-pwsh-local'
import { classifyDenial, classifyRunnerFailure, isRunnerSpawnFailure, matchesSignature } from './helpers.ts'

/**
 * 插件配置：即本地执行器的那些开关，逐字继承。沙箱策略——默认模式与
 * `workspace-write` 的兜底根路径——并不在此：它位于 `ctx.sandboxPolicy`
 * （`@deepseek-ai/dsh-sandbox-policy`）上，该服务会为每个施加隔离的能力
 * 解析各调用会话的模式与 cwd。运行器的选择同样属于 `ctx.sandbox`
 * provider 的配置，而非本执行器的配置。
 */
export type Config = LocalConfig

/**
 * 取代本地 pwsh 执行器注册为 `ctx.shell`，并要求存在 `ctx.sandbox`
 * provider 与 `ctx.sandboxPolicy`；工具层承载沙箱拒绝的渲染与升级入口
 * （参见 pwsh-tool-and-executor Agent Note）。工具调用会传入调用方会话
 * 已解析的策略；直接调用则回退到部署策略。`result.sandbox` 上报工具
 * 要渲染的模式、执行程度与拒绝事实。
 */
/* jscpd:ignore-start -- 对 bash-sandbox 执行器的逐调用刻意镜像（pwsh-tool-and-executor Agent Note） */
export class SandboxPwshExecutor extends PwshLocalExecutor {
  static override inject = ['subprocess', 'sandbox', 'sandboxPolicy']

  // 没有自己的 Config：沙箱默认值（mode + workspaceRoot）已移交给
  // ctx.sandboxPolicy，因此本执行器逐字继承 PwshLocalExecutor 的
  // Config（配置目录会遍历继承来的静态成员）。

  private readonly mode: SandboxMode
  /**
   * 保持到落定为止的按进程隔离事实。provider 在相互重叠的调用之间可能
   * 改变执行程度与诊断方言，因此共享“最近一次包装”的值会用错误的事实
   * 给进程分类。未被隔离的进程没有条目。
   */
  private readonly processFacts = new Map<ShellProcess, {
    mode: ConfinedSandboxMode
    enforcement: SandboxEnforcement
    denialSignatures: readonly string[]
    runnerFailureRules: readonly RunnerFailureRule[]
    runnerProgram: string | undefined
    workdir: string
  }>()

  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    // 默认模式是用于 schema 声明的能力事实；
    // 实际的工具执行携带的是其已解析的单次调用策略。
    this.mode = ctx.sandboxPolicy.defaultMode
  }

  /** 已配置的默认模式——即工具层读取的能力事实。 */
  override get sandboxMode(): SandboxMode {
    return this.mode
  }

  /**
   * 把完整的单次调用策略写入规约。工具调用提供调用方会话已解析的模式与
   * 根路径；更底层的调用方则回退到部署策略。
   */
  override resolve(request: ShellExecRequest): ShellExecSpec {
    return { ...super.resolve(request), sandboxPolicy: request.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve() }
  }

  override async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    const policy = spec.sandboxPolicy as SandboxExecutionPolicy
    const { mode } = policy
    if (mode === 'danger-full-access') {
      return SandboxPwshExecutor.decorateResult(
        await super.execute(spec),
        result => ({ ...result, sandbox: { mode, denied: false } }),
      )
    }
    let confined: ConfinedArgv | undefined
    const ex = await this.executeArgv(spec, async (signal) => {
      const prepared = await this.confine(spec, { ...policy, mode }, signal)
      signal.throwIfAborted()
      confined = prepared
      return prepared.argv
    }, (process) => {
      const facts = confined as ConfinedArgv
      this.processFacts.set(process, {
        mode,
        enforcement: facts.enforcement,
        denialSignatures: facts.denialSignatures,
        runnerFailureRules: facts.runnerFailureRules,
        runnerProgram: facts.argv[0],
        workdir: spec.workdir,
      })
    })
    return SandboxPwshExecutor.decorateResult(ex, (result) => {
      if (confined === undefined) return { ...result, sandbox: { mode, denied: false } }
      const { enforcement, denialSignatures, runnerFailureRules } = confined
      // 运行器失败优先于拒绝，因为命令根本没有运行。这里携带的是匹配到的
      // 致命行，而不是它之前那条信息性输出。
      const runnerFailure = classifyRunnerFailure(result.exitCode, result.stderr.text, runnerFailureRules)
      if (runnerFailure !== undefined) {
        throw new SandboxUnavailableError(mode, runnerFailure.detail)
      }
      return { ...result, sandbox: { mode, denied: classifyDenial(result, denialSignatures), enforcement } }
    }, (error) => {
      // 上游中止即便阻止了 spawn，也仍然属于取消。
      if (spec.signal?.aborted === true) spec.signal.throwIfAborted()
      if (confined !== undefined && isRunnerSpawnFailure(error, confined.argv[0], spec.workdir)) {
        throw new SandboxUnavailableError(mode, String(error))
      }
      throw error
    })
  }

  /**
   * 就地装饰句柄的前台投影，并只记忆化一次。句柄保持其标识（绝不会被包进
   * 第二个对象），因为按进程的事实与 `onProcessDone` 都以该精确实例为键。
   */
  private static decorateResult(
    ex: ShellExecution,
    map: (result: ShellRunResult) => ShellRunResult,
    mapError?: (error: unknown) => never,
  ): ShellExecution {
    const base = ex.result.bind(ex)
    let decorated: Promise<ShellRunResult> | undefined
    ex.result = () => {
      decorated ??= base().then(map, mapError)
      return decorated
    }
    return ex
  }

  /**
   * 在 `done` 落定之前写入按进程的沙箱事实。完全放行的进程没有事实；
   * 死于信号不属于拒绝。
   */
  protected override onProcessDone(proc: ShellProcess, stderr: string, providerRejected: boolean, providerError?: unknown): void {
    const facts = this.processFacts.get(proc)
    if (facts !== undefined) {
      this.processFacts.delete(proc)
      // provider 拒绝不暴露公开的失败阶段。只有当错误独立地指名 argv[0]
      // 时，才把它归因于隔离运行器；否则已落定的运行器失败优先于形似
      // 拒绝的诊断信息。
      const runnerFailed = providerRejected
        ? isRunnerSpawnFailure(providerError, facts.runnerProgram, facts.workdir)
        : classifyRunnerFailure(proc.exitCode, stderr, facts.runnerFailureRules) !== undefined
      proc.sandbox = {
        mode: facts.mode,
        denied: !runnerFailed && matchesSignature(proc.exitCode, stderr, facts.denialSignatures),
        enforcement: facts.enforcement,
        ...(runnerFailed ? { runnerFailed } : {}),
      }
    }
    super.onProcessDone(proc, stderr, providerRejected, providerError)
  }

  /**
   * 通过 `ctx.sandbox` provider 包装一次 pwsh 调用。provider 的错误原样
   * 向上传播；返回的 argv 会直接交给本地执行器的 subprocess 路径。
   * @param spec - 其 pwsh argv 待被隔离的已解析执行规约。
   * @param policy - 已解析的隔离执行策略。
   * @param signal - 隔离准备阶段的取消信号。
   * @returns provider 的精确 argv 与落定分类事实。
   */
  private confine(spec: ShellExecSpec, policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv> {
    return this.ctx.sandbox.confine(this.argv(spec), policy, signal)
  }
}
/* jscpd:ignore-end */

export default SandboxPwshExecutor
