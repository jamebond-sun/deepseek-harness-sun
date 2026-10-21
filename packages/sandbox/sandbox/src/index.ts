/**
 * 同世界进程限制这一能力接缝的服务定义：把精确的子进程 argv 包装到一份
 * 主机路径文件策略之下。容器、microVM 与远程执行替换的是其外围的能力接缝；
 * 本服务与宿主机共享同一个内核与文件系统。
 * @module @deepseek-ai/dsh-sandbox
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

export {
  ESCALATION_TARGETS,
  WIDER_MODES,
  approveEscalation,
  escalationHintMarker,
  sandboxDenialMarker,
  sandboxPermissionsDescription,
  validateEscalationArgs,
} from './escalation.ts'
export type { EscalationApproval, EscalationApprover, EscalationOutcome, EscalationRequest } from './escalation.ts'
export { canonicalPath, writableRoots } from './roots.ts'

/**
 * 受限进程的文件效应策略。`read-only` 只允许 `/dev/null` 这类必需的输出端；
 * `workspace-write` 额外允许工作区以及后端定义的临时区；`danger-full-access`
 * 绕过限制。网络与进程可见性不在本词汇之内。
 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** 具有限制性的（非 `danger-full-access`）模式——即 {@link SandboxPolicy} 可承载的模式。 */
export type ConfinedSandboxMode = Exclude<SandboxMode, 'danger-full-access'>

/**
 * 为一次能力调用解析出的完整文件效应策略。即便在不消费工作区根的模式
 * 下也会携带它，这样调用方可以在选择强制路径之前一次性解析策略。
 */
export interface SandboxExecutionPolicy {
  /** 本次执行所运行的文件效应模式。 */
  mode: SandboxMode
  /** `workspace-write` 允许写入的绝对根目录。 */
  workspaceRoot: string
  /**
   * 调用会话的不透明标识（`dsh-session` 的带品牌 SessionId）。后端以它为键
   * 存放按会话划分的状态（例如 windows-acl 为每个活跃的会话/工作区对分配
   * 一个随机的私有临时目录及其 SID，而工作区 SID 与常驻授予仍按工作区
   * 划分）；无 agent 的调用不带此字段，退化为按调用划分的后端状态。
   */
  sessionId?: SessionId
}

/**
 * 本宿主机上的强制完整度。`partial` 表示当前后端或较旧的内核 ABI 无法
 * 管辖所有已承诺的文件效应；要求绝对边界的调用方不得把它当作 `full`。
 */
export type SandboxEnforcement = 'full' | 'partial'

/**
 * 一次受限执行允许触及的范围——按调用携带，而不是固定在提供者上：两个
 * 消费者可以在同一时刻按不同策略施加限制（bash 处于 `read-only`，而一个
 * 受限的子 agent 需要其状态目录可写），一次获准的升级重试则是一次策略更
 * 宽的新调用。取默认值/解析是消费者边界上一个显式的步骤；提供者把策略
 * 视为已完全指定。
 */
export interface SandboxPolicy extends SandboxExecutionPolicy {
  /** 本次执行所运行的文件效应模式。 */
  mode: ConfinedSandboxMode
}

/**
 * 用于识别沙箱运行器在执行被包装命令之前就已失败的证据。消费者先应用
 * {@link allowedExitCodes}（若存在），再按整行大小写不敏感相等排除
 * {@link informationalLines}，然后在剩余的每个 stderr 行内大小写不敏感地
 * 匹配 {@link fatalSignatures}。仅凭退出状态永远不足以证明运行器失败。
 */
export interface RunnerFailureRule {
  /** 本规则可匹配的进程非零退出码；省略表示允许任意非零退出。 */
  allowedExitCodes?: readonly number[]
  /** 用于在某一 stderr 行上标识致命运行器诊断的非空子串。 */
  fatalSignatures: readonly string[]
  /** 在致命匹配之前按整行完全相等排除的良性 stderr 行。 */
  informationalLines?: readonly string[]
}

/**
 * {@link SandboxProvider.confine} 的结果：替代调用方自身 argv 去 spawn 的
 * argv，以及所选后端对它达成的强制完整度。
 */
export interface ConfinedArgv {
  /** 包装后的 argv（运行器、配置、分隔符，然后是调用方的 argv）。 */
  argv: string[]
  /** 所选后端对策略文件效应的强制完整程度。 */
  enforcement: SandboxEnforcement
  /**
   * 所选后端的拒绝"方言"：被该后端拒绝的文件效应会产生哪些大小写不敏感的
   * stderr 子串（bwrap 只读绑定下是 EROFS 文本，Landlock 下是 EACCES，
   * Seatbelt 下是 EPERM）。从一次失败运行的 stderr 推断拒绝的消费者，应当
   * 只针对这些子串匹配，而不是跨后端的并集——并集会声称某个后端永远不会
   * 产生的拒绝。
   */
  denialSignatures: readonly string[]
  /**
   * 运行器失败的结构化证据规则。在检查拒绝特征串之前，消费者要求先有匹配
   * 的致命 stderr 行（排除信息性行之后）以及该规则特有的退出码门槛：运行器
   * 失败意味着命令根本没有运行，而拒绝意味着限制生效并拦住了它。
   */
  runnerFailureRules: readonly RunnerFailureRule[]
}

/**
 * 请求受限模式但没有任何后端可用时的错误码。提供者失败即关闭（fail closed），
 * `HarnessError` 会把该错误码经 `tool/result` 传递出去，让调用方能够区分
 * "缺少限制"与"命令失败"。
 */
export const SANDBOX_UNAVAILABLE = 'SANDBOX_UNAVAILABLE'

/**
 * 当 {@link SandboxProvider.confine} 无法强制所请求的模式时抛出。它通过
 * 结构化错误通道携带 {@link SANDBOX_UNAVAILABLE}。
 */
export class SandboxUnavailableError extends HarnessError {
  constructor(mode: ConfinedSandboxMode, detail?: string) {
    super(
      `sandbox mode "${mode}" is requested but no sandbox backend is usable on this host; `
      + 'refusing to run the command unconfined. Install bubblewrap or run a Landlock-enforcing '
      + 'kernel (Linux), ensure sandbox-exec is usable (macOS), or ensure the ACL '
      + 'restricted-token runner can start (Windows) — otherwise switch the consumer to '
      + 'danger-full-access.'
      + (detail === undefined ? '' : ` Runner failure: ${detail}`),
      SANDBOX_UNAVAILABLE,
    )
    this.name = 'SandboxUnavailableError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sandbox: SandboxProvider
  }
}

/**
 * 抽象的进程沙箱服务。{@link confine} 必须返回具有强制力的 argv，或者在
 * 包装时、运行器执行时失败即关闭；禁止静默地放行未受限制的执行。功能性
 * 探测用于裁决多运行器链，单一候选者可以跳过探测——它自身的拒绝仍是
 * 失败即关闭的终点。
 */
export abstract class SandboxProvider extends Service {
  /* v8 ignore next -- 抽象服务的构造由具体提供者包中的实现覆盖。 */
  constructor(ctx: Context) {
    super(ctx, 'sandbox')
  }

  /**
   * 包装 `argv`，使其在本宿主机上按 `policy` 受限执行；调用方以返回的
   * argv 替代自身 argv 去 spawn。
   * @param argv - 调用方即将 spawn 的精确 argv（程序加参数），不是 shell
   *   字符串——shell 形态的消费者应传入 `['bash', '-c', command]`。
   * @param policy - 本次执行所运行的文件效应策略，按调用携带
   *   （见 {@link SandboxPolicy}）。
   * @param signal - 在提供者解析策略与运行器期间的取消信号。
   * @returns 需要改去 spawn 的 argv，以及所选后端对它达成的强制完整度。
   */
  abstract confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv>
}

export default SandboxProvider

export { classifyRunnerFailure, isRunnerSpawnFailure, matchesSignature } from './diagnostics.ts'
