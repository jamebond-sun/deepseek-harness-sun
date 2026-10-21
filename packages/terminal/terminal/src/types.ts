/**
 * 由 PTY 后端、按所有者划分作用域的注册表以及工具消费者共享的类型。
 * 运行时服务代码位于 `./index.ts`。
 * @module @deepseek-ai/dsh-terminal/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** 公共 `TerminalSessionId` 类型/值对所使用的内部导出基类型。 */
export type TerminalSessionIdValue = Branded<'TerminalSessionId'>

/**
 * 后端报告的失败：在失败未发布的设置之后，无法清理部分资源。
 * @param spawnError - 原始的 setup 或取消失败。
 * @param cleanupError - 可能导致后端持有的资源存活的失败。
 */
export class TerminalBackendCleanupError extends AggregateError {
  constructor(
    readonly spawnError: unknown,
    readonly cleanupError: unknown,
  ) {
    super([spawnError, cleanupError], 'PTY backend startup and cleanup both failed')
    this.name = 'TerminalBackendCleanupError'
  }
}

/** 一次交互式发送将控制权交还其调用方的原因。 */
export type TerminalWaitReason = 'stdin_read' | 'inferred_idle' | 'timeout' | 'session_exit'

/**
 * 面向模型的 PTY 接口允许向前台进程组发送的信号。
 * 与 `@deepseek-ai/dsh-subprocess` 中的 `SubprocessTerminalSignal` 保持成员一致，
 * 但不产生跨接缝依赖；两者需同步修改。
 */
export type TerminalSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'SIGTSTP' | 'SIGHUP'

/** 顶层 PTY 进程状态，独立于某次发送的等待原因。 */
export type TerminalSessionStatus =
  | { kind: 'running' }
  | { kind: 'exited'; exitCode: number | null; signal: NodeJS.Signals | null }

/** 创建一个按所有者划分作用域的 PTY 会话的请求。 */
export interface TerminalSpawnRequest {
  /** 已注册的后端类型。 */
  type: string
  /** 可选的属主本地显示名称。 */
  name?: string
  /** 可选的初始工作目录，由后端解释。 */
  cwd?: string
}

/** 由注册表交给后端的、已完全标识的请求。 */
export interface TerminalBackendSpawnSpec extends TerminalSpawnRequest {
  /** 注册表铸造的会话身份。 */
  sessionId: TerminalSessionIdValue
  /** 用于权限感知后端设置的精确活动所有者。 */
  owner: Agent
  /** 对未发布后端设置的取消信号。 */
  signal?: AbortSignal
}

/** 一次按行终端交互的输入。 */
export interface TerminalSendRequest {
  /** 要写入的 UTF-8 文本。 */
  text: string
  /** 是否在 {@link text} 之后写入后端的回车序列。 */
  submit: boolean
  /** 针对等待的取消信号；后端也会中断前台命令。 */
  signal?: AbortSignal
}

/** Incremental output consumed from one live send operation. */
export interface TerminalSendRead {
  /** Output produced since the previous operation read. */
  delta: string
  /** Whether unread operation output was dropped by the backend's bound. */
  truncated: boolean
}

/** 一次前台或后台发送结算后的结果。 */
export interface TerminalSendResult {
  /** 结算时仍保留的有界渲染终端增量。 */
  viewport: string
  /** 等待返回的原因；这并不暗示任意子进程退出。 */
  waitReason: TerminalWaitReason
  /** 结算时观察到的顶层会话状态。 */
  sessionStatus: TerminalSessionStatus
  /** 输出是否从操作或保留的回滚缓冲中被丢弃。 */
  truncated: boolean
}

/** 后端持有的实时发送；每个 PTY 会话中恰好只能有一个处于活动状态。 */
export interface TerminalSendOperation {
  /** 在就绪、超时、取消或顶层进程退出之后兑现。 */
  done: Promise<TerminalSendResult>
  /** 消费自上次调用以来产生的输出。 */
  readOutput(): TerminalSendRead
  /** 请求 `SIGINT`；在操作结算后返回 false。 */
  cancel(): boolean
}

/** 请求一页向后的回滚缓冲。 */
export interface TerminalReadRequest {
  /** 相对最新保留行的偏移；默认值由后端决定。 */
  offset?: number
  /** 请求的行数；后端限制仍然适用。 */
  count?: number
}

/** 有界的回滚缓冲页。 */
export interface TerminalReadResult {
  /** 按时间顺序保留的文本。 */
  text: string
  /** 当前保留的行数。 */
  totalLines: number
  /** 返回的首行的包含性、相对最新的偏移。 */
  lineBegin: number
  /** 返回页面之后的排除性、相对最新的偏移。 */
  lineEnd: number
  /** 较旧的保留输出或请求结果是否超出了某个边界。 */
  truncated: boolean
}

/** 向一个已验证的前台进程组递送信号的结果。 */
export interface TerminalSignalResult {
  /** 仅当后端已递送该信号后才为 true。 */
  delivered: true
  /** 收到信号的进程组。 */
  targetPgid: number
}

/** 一个已发布 PTY 会话的、对所有者可见的摘要。 */
export interface TerminalSessionSnapshot {
  /** 每次操作所使用的、注册表铸造的身份。 */
  sessionId: TerminalSessionIdValue
  /** 可选的属主本地显示名称。 */
  name?: string
  /** 创建该会话的后端类型。 */
  type: string
  /** 当后端拥有顶层进程时的顶层进程 id。 */
  pid?: number
  /** 当前的顶层进程状态。 */
  status: TerminalSessionStatus
}

/** 由 {@link TerminalSessionService} 保留的、后端持有的实时会话。 */
export interface TerminalBackendSession {
  /** 从 `terminal_open` 返回的、初始的有界终端输出。 */
  readonly motd: string
  /** 当存在时的顶层进程 id。 */
  readonly pid?: number
  /** 启动一次独占的发送操作。 */
  startSend(request: TerminalSendRequest): TerminalSendOperation
  /** 从保留的回滚缓冲中读取一页有界内容。 */
  read(request: TerminalReadRequest): TerminalReadResult
  /** 向已验证的前台进程组发送信号。 */
  signal(signal: TerminalSignal): Promise<TerminalSignalResult>
  /** 观察顶层进程状态。 */
  status(): TerminalSessionStatus
  /** 幂等关闭被捕获的、所属的进程树并等待其静止。 */
  close(reason: string): Promise<void>
}

/** 用于一种 PTY 会话类型、可替换的提供者。 */
export interface TerminalBackend {
  /** 由 {@link TerminalSpawnRequest.type} 选择的稳定类型。 */
  readonly type: string
  /** 创建未发布的会话，或在清理部分资源后拒绝；清理失败使用 {@link TerminalBackendCleanupError}。 */
  spawn(spec: TerminalBackendSpawnSpec): Promise<TerminalBackendSession>
}

/** 由 {@link TerminalSessionService.spawn} 返回的成功发布结果。 */
export interface TerminalSpawnResult extends TerminalSessionSnapshot {
  /** 在发布之前捕获的初始有界输出。 */
  motd: string
}
