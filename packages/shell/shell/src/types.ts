/**
 * bash 执行器能力缝的执行类型。后台作业语义属于 `@deepseek-ai/dsh-jobs`，
 * 本能力缝只暴露进程句柄。受管环境与输出采集的词汇由 subprocess 能力缝
 * 持有并在此重新导出，使 bash 使用方只保留一个导入入口。
 * @module dsh-shell/types
 */

import type { SandboxEnforcement, SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { CollectedOutput, DshEnvironment, SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'

export { DSH_ENV_PREFIX } from '@deepseek-ai/dsh-subprocess'
export type { CollectedOutput, DshEnvironment, DshEnvironmentKey, SubprocessOutputRead, SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'

/**
 * 后台进程已采集输出流之上的非消费式偏移读取器，供独立于
 * {@link ShellProcess.readOutput} 消费游标的观察者使用。每个后台进程都会
 * 暴露这两条流；被拒绝的 spawn 不产生任何进程输出，因此其 stderr 读取器
 * 会把 `spawn failed: …` 提示作为整条流提供。
 */
export interface ShellObservedStreams {
  /** 已采集 stdout 之上的偏移读取器。 */
  stdout: SubprocessOutputReader
  /** 已采集 stderr 之上的偏移读取器（spawn 失败时即为 spawn 失败提示）。 */
  stderr: SubprocessOutputReader
}

/**
 * 单次运行的沙箱事实，仅当由带沙箱能力的执行器处理时才存在。
 * 这些事实独立于进程退出状态上报，便于调用方区分命令失败、策略拒绝与
 * 运行器故障。
 */
export interface ShellSandboxInfo {
  /** 命令实际运行所处的模式。 */
  mode: SandboxMode
  /** 沙箱是否拒绝过某次文件操作。 */
  denied: boolean
  /** 所选运行器对请求模式的执行完整程度。 */
  enforcement?: SandboxEnforcement
  /** 沙箱运行器是否在命令执行之前就已失败。 */
  runnerFailed?: boolean
}

/**
 * 执行器在期限到期时的动作：`kill` 终止命令并把结果归类为 `timedOut`
 * （默认值）；`none` 完全不设期限，此时调用方的 signal 与
 * {@link ShellProcess.kill} 是终止命令的唯一手段。只想等待一段时间的
 * 使用方可以用 `none` 运行命令，并自行限制等待时长。
 */
export type ShellExpiryPolicy = 'kill' | 'none'

/**
 * 调用方的执行请求：`workdir` 与 `timeoutMs` 为可选，由
 * {@link ShellExecutor.resolve} 依据实现自身的配置补齐。这是面向模型／插件的
 * 形状；交给 `resolve()` 即可得到完全解析的 {@link ShellExecSpec}。
 */
export interface ShellExecRequest {
  command: string
  /** 工作目录覆盖项（默认取实现配置值）。 */
  workdir?: string | undefined
  /** 超时覆盖值，单位毫秒（实现会对它设上限）。 */
  timeoutMs?: number | undefined
  /** `timeoutMs` 到期时的期限策略（默认 `'kill'`）。 */
  onExpiry?: ShellExpiryPolicy | undefined
  /**
   * 前台 stdout 采集字节预算。缺省时使用执行器默认的输出上限。受信任的
   * 进程内使用方在必须解析完整 stdout（直到自己的有界上限）时使用它；
   * 面向模型的 bash 工具不把它作为参数暴露。
   */
  stdoutMaxBytes?: number | undefined
  /** 中止信号——实现在它触发时终止命令，并把已处于中止状态的信号视为已触发。 */
  signal?: AbortSignal | undefined
  /**
   * 写入命令 stdin 的字节，随后关闭 stdin。缺省则 stdin 保持关闭／为空
   * （模型驱动的工具调用即为此默认情形）。由进程内插件设置（例如 hooks
   * 桥接会把 hook 命令的 JSON 负载写入其 stdin）；面向模型的 bash 工具
   * 不把它作为参数暴露（需要 stdin 的模型可用 heredoc 或管道等 shell 语法）。
   */
  stdin?: string | undefined
  /**
   * 命令的普通环境项，在凭据清理之后合并。受管事实属于 {@link dshEnv}，
   * 它在本表之后再合并，因此此处的项永远无法顶替受管项。由进程内插件
   * 设置（hooks 桥接会设置 `CLAUDE_PROJECT_DIR`、`CLAUDE_PLUGIN_ROOT` 等）；
   * 面向模型的 bash 工具不把它作为参数暴露。
   */
  env?: Record<string, string> | undefined
  /**
   * 本次执行的、由 harness 持有的 `DSH_*` 变量（类型化为受管键）。执行器
   * 会先丢弃进程环境中既有的 `DSH_*` 项，再最后合并这份快照，因此当前
   * 不可用的事实不会继承 harness 进程里的过期值，调用方的 {@link env}
   * 项也无法顶替受管项。
   */
  dshEnv?: DshEnvironment | undefined
  /** 完全解析后的单次调用沙箱策略；带沙箱能力的执行器会为它设默认值。 */
  sandboxPolicy?: SandboxExecutionPolicy | undefined
}

/**
 * 已解析的执行规约。{@link ShellExecutor.resolve} 会填充必填字段并施加上限；
 * 在 `onExpiry: 'none'` 下，解析出的 `timeoutMs` 不启用任何计时器，只会被
 * 原样回写到 {@link ShellRunResult.timeoutMs}。
 */
export interface ShellExecSpec {
  command: string
  workdir: string
  timeoutMs: number
  /** `timeoutMs` 到期时的期限策略（{@link ShellExecutor.resolve} 默认为 `'kill'`）。 */
  onExpiry: ShellExpiryPolicy
  /**
   * 解析出的 stdout 采集字节预算，作用于每次执行的 stdout；stderr 仍使用
   * 执行器自身的输出上限。
   */
  stdoutMaxBytes: number
  /** 中止信号——实现在它触发时终止命令，并把已处于中止状态的信号视为已触发。 */
  signal?: AbortSignal | undefined
  /** 关闭 stdin 之前写入的字节；缺省表示没有 stdin。 */
  stdin?: string | undefined
  /**
   * 从 {@link ShellExecRequest.env} 透传的普通环境项；{@link dshEnv} 仍在
   * 它们之后再合并。与 `stdin` 同理，它在规约上是可选的：缺省表示没有
   * 额外的普通环境项。
   */
  env?: Record<string, string> | undefined
  /** 受管的 `DSH_*` 快照（类型化为受管键）；在 {@link env} 之后合并。 */
  dshEnv?: DshEnvironment | undefined
  /** 解析后的沙箱策略；不实施隔离的执行器会忽略它。 */
  sandboxPolicy: SandboxExecutionPolicy | undefined
}

/** 前台运行的结果，包含准备阶段发生超时的情形。 */
export interface ShellRunResult {
  /** 退出码；准备阶段超时或进程死于信号时为 null。 */
  exitCode: number | null
  /** 终止信号；未上报任何信号时为 null，准备阶段超时亦为 null。 */
  signal: NodeJS.Signals | null
  /**
   * 当执行器自身的超时是让命令中断的第一个原因时为 true。与
   * {@link aborted} 互斥：同一个融合期限同时驱动超时与调用方的取消，
   * 因此在进程关闭前竞态的超时与中止只会上报唯一的“首个中止原因”，
   * 而不会同时上报两者（参见 [timeout-library Agent Note](../../../../.agents/notes/implemented/architecture/2026-07-06-timeout-deadline-library.md)）。
   */
  timedOut: boolean
  /**
   * 当调用方的 `AbortSignal` 是终止命令的第一个原因（且不是执行器自身的
   * 超时）时为 true。与 {@link timedOut} 互斥——首因分类见其说明。
   */
  aborted: boolean
  /** 本次运行实际生效的超时时间（经过默认值填充与上限收敛）。 */
  timeoutMs: number
  stdout: CollectedOutput
  stderr: CollectedOutput
  /** 沙箱执行事实；不带沙箱的执行器不提供该字段。 */
  sandbox?: ShellSandboxInfo
}

/** 后台进程的生命周期状态。 */
export type ShellProcessStatus = 'running' | 'completed' | 'killed'

/** 一次增量 {@link ShellProcess.readOutput} 读取。 */
export interface ShellProcessRead {
  /** 上次读取之后新增的输出（stderr 位于带标记的区块中）。 */
  delta: string
  /** 截断丢弃了本次 delta 未能包含的未读字节时为 true。 */
  lossy: boolean
  /** stdout 发生截断且存在安全路径时，完整的 stdout 溢出文件路径。 */
  stdoutSpillPath?: string
  /** stderr 发生截断且存在安全路径时，完整的 stderr 溢出文件路径。 */
  stderrSpillPath?: string
}

/**
 * {@link ShellExecutor.start} 返回的后台进程句柄。它是唯一的访问途径；
 * 缓冲的输出在进程退出后仍可读取。composition 拆除（即 subprocess 服务
 * 的 disposal）会终止仍在运行的进程并等待 {@link done}；仅重载执行器则
 * 让这些进程继续运行。
 */
export interface ShellProcess {
  /** 进程生命周期状态（恰好落定一次）。 */
  status: ShellProcessStatus
  /** 结束后的退出码（null 表示被信号终止／仍在运行）。 */
  exitCode: number | null
  /** 被信号终止时的终止信号名。 */
  signal: NodeJS.Signals | null
  /**
   * 在底层进程落定时兑现（永不拒绝——provider 拒绝会以 `killed` 落定，
   * 并在 stderr 上留下与阶段无关的错误）。
   */
  readonly done: Promise<void>
  /** 沙箱事实；受隔离的进程落定后被写入。 */
  sandbox?: ShellSandboxInfo
  /**
   * 读取上次读取之后新增的输出（消费式——连续读取不会重复投递）。
   * 丢失数据的读取会标记 `lossy`，并在可用时指向整流的溢出文件。
   */
  readOutput(): ShellProcessRead
  /**
   * 位于 {@link readOutput} 游标所消耗的同一批已采集输出流之上的非消费式
   * 偏移读取器，其中包含被拒绝的 spawn 在 stderr 上留下的 provider 失败
   * 提示。独立观察者可在此按各自偏移读取，而不会从 `readOutput` 抢走字节。
   */
  observed: ShellObservedStreams
  /**
   * 终止 provider 托管的进程。若它已结束则返回 false（空操作）；幂等。
   */
  kill(): boolean
}

/**
 * {@link ShellExecutor.execute} 返回的唯一执行句柄：即存活的
 * {@link ShellProcess} 本身，再加上前台投影 `result()`。
 */
export interface ShellExecution extends ShellProcess {
  /**
   * 前台投影：在进程关闭时落定，给出分流采集的输出与首因
   * `timedOut`/`aborted` 分类。仅在基础设施故障时拒绝（即 spawn 从未
   * 产生进程）；非零退出、超时终止与中止终止都会以描述性结果兑现。
   * 按需创建并被记忆化——从不调用它的使用方（后台生产者）同样不会观察到
   * 拒绝；spawn 失败的信息由句柄的 `done`／读取路径承载。
   * @returns 本次执行已落定的前台结果。
   */
  result(): Promise<ShellRunResult>
}
