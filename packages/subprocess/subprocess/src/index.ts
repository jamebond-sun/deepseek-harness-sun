/**
 * subprocess 能力 seam（`ctx.subprocess`）的服务定义：执行世界的可执行文件查找、
 * 由提供方完全指定的受管进程范围（带原始或收集式 stdio），以及一个终端进程原语。
 * 命令默认值、shell 语义、截止时间、协议分帧、终端就绪与呈现都属于消费者。本地实现
 * 位于 `@deepseek-ai/dsh-subprocess-local`。
 * @module @deepseek-ai/dsh-subprocess
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { proxyEnvironmentForChild } from '@deepseek-ai/dsh-http-proxy'
import { DSH_ENV_PREFIX } from './types.ts'
import type { SubprocessHandle, SubprocessSpawnSpec } from './types.ts'
import type { SubprocessTerminalEnvironment, SubprocessTerminalHandle, SubprocessTerminalSpawnSpec } from './types.ts'

export { DSH_ENV_PREFIX } from './types.ts'
export type {
  CollectedOutput,
  DshEnvironment,
  DshEnvironmentKey,
  SubprocessCollect,
  SubprocessCollectedOutputs,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputMode,
  SubprocessOutputRead,
  SubprocessOutputReader,
  SubprocessSpawnSpec,
  SubprocessStdinMode,
  SubprocessStdio,
  SubprocessTerminalForeground,
  SubprocessTerminalActivity,
  SubprocessTerminalEnvironment,
  SubprocessTerminalHandle,
  SubprocessTerminalSignal,
  SubprocessTerminalSpawnSpec,
} from './types.ts'

/**
 * 凭据形态的环境名不会被转发给子进程（harness 自身的 `DEEPSEEK_API_KEY`/密钥
 * 不得隐式泄漏到被启动的进程中）。这是每个仓库内启动器共用的一种启发式；被刻意
 * 提供的条目会保留下来，因为显式环境层在清理之后才合并。
 */
export const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i

/**
 * 环境父进程环境减去凭据形态的名称、再减去所有 `DSH_*` 名称——即每个 harness 子进程
 * 启动时所基于的规范基底。`PATH`、`HOME`、区域设置与代理变量会被保留，因此子进程
 * CLI 可正常运行；harness 身份永远不会隐式泄漏（被刻意转发的凭据或当前的 `DSH_*`
 * 事实会经由 spec 的显式 `env` 传入，而该层在此清理之后才合并）。两次清理都按
 * 大小写不敏感匹配：Windows 环境名是大小写不敏感的，否则父进程中的 `dsh_*` 条目会
 * 残留，并在子进程中读回为 `$env:DSH_*`；在 POSIX 上刻意使用小写的 `dsh_*` 名称
 * 则几乎不可能出现。导出为普通函数，以便无法经由服务路由的启动器（node-pty 后端、
 * SDK 管理的传输）也能共用同一份清理定义。
 *
 * 当代理处于激活状态时，结果还会携带已解析的代理名，以及子进程 Node 需要用来
 * 遵从代理的标志，从而让子进程继承与其父进程相同的路由。
 * @returns 一个全新的、可安全交给子进程启动的环境对象。
 */
export function scrubbedParentEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !SENSITIVE_ENV_PATTERN.test(key) && !key.toUpperCase().startsWith(DSH_ENV_PREFIX)) env[key] = value
  }
  // 子进程 Node 会忽略继承的代理变量，除非设置了此处添加的标志，因此一个 MCP
  // stdio 服务器或子代理 CLI 会在其父进程走代理时直连。同一覆盖层将每个代理名
  // 还原为用户导出的值，撤销本进程自身的规范化——
  // `undefined` 会移除用户从未设置过的名称。
  for (const [name, value] of Object.entries(proxyEnvironmentForChild())) {
    if (value === undefined) Reflect.deleteProperty(env, name)
    else env[name] = value
  }
  return env
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    subprocess: SubprocessRuntime
  }
}

/**
 * 抽象 subprocess 服务。请子类化、实现 {@link spawn}，并将子类作为插件加载——它会
 * 注册为 `ctx.subprocess`（每个上下文一个实现；加载第二个会抛错，这是 cordis 标准的
 * 重复服务行为）。
 *
 * 实现必须遵循以下语义：
 * - 可执行文件路径属于与已挂载文件系统提供方共享的同一个执行世界。
 * - {@link spawn} 同步返回一个存活句柄。目标身份仍为提供方私有；`done` 以启动命令的
 *   退出事实结算，并可能因启动或提供方失败而拒绝。
 * - 收集模式的读取器基于偏移且不消费，因此独立的读取者永远不会消耗彼此的输出；
 *   有损读取会报告截断，并在存在时提供保存完整流的溢出文件。管道流以原始形式交给
 *   调用方，此处从不缓冲。
 * - {@link SubprocessHandle.terminate}（以及 spec 的中止信号）会在其受管范围上启动
 *   提供方记录的流程。{@link SubprocessHandle.waitForExit} 观察的是同一范围，因此
 *   由消费者拥有的逐级拆除阶梯可让每一层都停在真正的静默上；每个提供方需记录其
 *   信号与可观察性限制。
 * - 服务的释放会终止所有仍在运行的受管进程并等待其退出。
 * - {@link spawnTerminal} 将终端分配、文本传输、前台进程组、信令，以及整个会话的
 *   静默，统一收在一个需要等待的终止方法之后；就绪与持久 shell 策略仍留在 PTY
 *   消费者一侧。当顶层进程退出时，其输出流在已排队的终端输出之后结束。
 */
export abstract class SubprocessRuntime extends Service {
  constructor(ctx: Context) {
    super(ctx, 'subprocess')
  }

  /**
   * 在此提供方的执行世界中解析一个已配置的可执行文件。
   * 绝对路径会被校验；裸名称使用提供方清理后的 PATH 加上显式环境覆盖。包含分隔符的
   * 相对路径会被拒绝：解析基准未定义，因此提供方会响亮地报错，而不是去猜测。
   * @param command - 绝对可执行路径或裸 PATH 名称。
   * @param env - 用于查找的显式环境条目。
   * @param signal - 中止远程或本地查找。
   * @returns 一个规范化的可执行路径。
   */
  abstract resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string>

  /**
   * 检查提供方执行环境中的 shell 选择事实。
   * @param signal - 远程环境检查的取消信号。
   * @returns 平台与首选 shell；可执行文件查找与分配仍是相互独立的两个操作。
   */
  abstract terminalEnvironment(signal?: AbortSignal): Promise<SubprocessTerminalEnvironment>

  /**
   * 从一个完全指定的 spec 启动一个受管子进程；此 seam 不应用任何默认值。
   * @param spec - argv、目录、stdio 处理方式、宽限、取消信号与环境。
   * @returns 存活的进程句柄（流/读取器、信令、结果承诺）。
   * @throws 当已预先中止，或在句柄创建前 argv、cwd、环境或宽限无效时，同步抛出。
   */
  abstract spawn(spec: SubprocessSpawnSpec): SubprocessHandle

  /**
   * 分配一个真实终端并启动一个被拥有进程会话。这是唯一的非管道进程原语：实现方拥有
   * 终端字节 I/O、前台进程组、信号，以及整个会话的静默。
   * @param spec - 完全指定的 argv、cwd、环境、尺寸、宽限与分配取消信号。
   * @returns 分配成功后的存活终端句柄。
   */
  abstract spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle>
}

export default SubprocessRuntime

/** 可执行文件查找已完成，但未找到任何可执行文件。 */
export class SubprocessExecutableNotFoundError extends Error {
  /**
   * @param message - 提供方特定的查找诊断信息。
   * @param options - 原始的提供方失败信息（如有）。
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SubprocessExecutableNotFoundError'
  }
}
