/**
 * subprocess 服务定义的术语表：完全指定的启动请求，带有 Node 形态的逐流 stdio
 * 模式、带溢出恢复的有限收集输出、原始管道流，以及受管范围的终止。命令默认值、
 * shell 语义、协议分帧与呈现属于消费者（如 bash 执行器这个 seam）。
 * @module dsh-subprocess/types
 */

import type { Duplex, Readable, Writable } from 'node:stream'

/** 为 DeepSeek Harness 管理的子进程环境事实保留的命名空间前缀。 */
export const DSH_ENV_PREFIX = 'DSH_' as const

/** 受管 {@link DSH_ENV_PREFIX} 命名空间内的一个环境键。 */
export type DshEnvironmentKey = `${typeof DSH_ENV_PREFIX}${string}`

/** 供一次子进程执行使用的可信 DeepSeek Harness 变量。 */
export type DshEnvironment = Readonly<Record<DshEnvironmentKey, string>>

/** 一条被捕获的流：文本（可能被截断）及恢复信息。 */
export interface CollectedOutput {
  /** 收集到的文本——截断时即流的尾部。 */
  text: string
  /** 当 `text` 中已有字节被丢弃时为 true。 */
  truncated: boolean
  /** 当发生截断且可用时，保存完整流的文件路径。 */
  spillPath?: string
}

/**
 * stdin 的处理方式。`'ignore'` 将 fd 0 指向 `/dev/null`；`'pipe'` 暴露
 * {@link SubprocessHandle.stdin} 供调用方持续写入协议数据；
 * `{ data }` 写入字节后关闭（批量形态）。
 */
export type SubprocessStdinMode = 'ignore' | 'pipe' | { readonly data: string }

/**
 * 单条输出流的有限内存收集，附可选的完整流溢出文件。省略 `spill` 只保留内存中的
 * 尾部——即诊断尾部形态（语言服务器的 stderr）；包含它则使完整流可恢复至其上限
 * （bash 工具形态）。
 */
export interface SubprocessCollect {
  /** 内存上限（字节）；溢出时保留尾部。 */
  maxBytes: number
  /** 完整流溢出文件；缺省则完全禁用溢出。 */
  spill?: {
    /** 整流的字节上限；更大的流会丢弃其现已不完整的溢出文件。 */
    maxBytes: number
  }
}

/**
 * stdout/stderr 的处理方式。`'pipe'` 暴露原始 `Readable` 供调用方解码协议；
 * `'inherit'` 透传父进程的描述符（子进程诊断落到 harness 自身的流上）；
 * {@link SubprocessCollect} 对象按偏移读取做有限缓冲。
 */
export type SubprocessOutputMode = 'pipe' | 'inherit' | SubprocessCollect

/** 逐流的 stdio 处理方式，全部显式指定——此 seam 不应用任何默认值。 */
export interface SubprocessStdio {
  stdin: SubprocessStdinMode
  stdout: SubprocessOutputMode
  stderr: SubprocessOutputMode
  /** 请求一条独立的字节模式双工通道；省略则不创建。 */
  control?: 'pipe'
}

/**
 * 一个完全指定的启动请求。此 seam 不应用任何默认值：每一种处理方式、限制与目录
 * 都是显式的，因此由调用方自身的配置——而非隐藏的 subprocess 服务默认值——来决定
 * （`dsh-shell` 的 request/spec 拆分是归属模板）。
 */
export interface SubprocessSpawnSpec {
  /** 可执行文件及参数；`argv[0]` 为程序名。此处绝不会做 shell 解释。 */
  argv: readonly string[]
  /** 子进程的工作目录。 */
  cwd: string
  /** 逐流的 stdio 处理方式。 */
  stdio: SubprocessStdio
  /**
   * 正数且有限的宽限期（毫秒），不超过 `MAX_TIMER_DELAY_MS`，供提供方的终止流程
   * 使用，并在进程退出后用于排空仍打开的收集管道（被幸存者持有的继承描述符不能
   * 无限期地拖住结果）。各提供方需记录其范围终止是分阶段的还是即时的。
   */
  graceMs: number
  /**
   * 中止信号——触发时在受管范围内启动终止升级。截止时间与原因分类由调用方负责；
   * 此 seam 只响应中止。
   */
  signal?: AbortSignal | undefined
  /**
   * 显式环境项，合并到实现的已清理父环境基底上（见 `scrubbedParentEnv`），不做
   * 命名空间校验。字符串是调用方刻意的显式加入，因此被转发的凭据形态项或当前的
   * `DSH_*` 事实会越过清理而保留；`undefined` 是一个墓碑值，用于从子进程中移除
   * 一条普通的外部环境项。
   */
  env?: NodeJS.ProcessEnv | undefined
}

/**
 * 一个已关闭进程的退出事实——沿用 Node 的 `close` 事件术语。刻意不携带超时或取消
 * 分类（调用方读取其自身拥有的信号来分类原因），也不携带输出：收集后的流在结算后
 * 仍可通过 {@link SubprocessHandle.collected} 读取，因此批处理与流式调用方共用
 * 同一访问路径。
 */
export interface SubprocessOutcome {
  /** 退出码；进程因信号死亡时为 null。 */
  exitCode: number | null
  /** 终止信号（如 'SIGTERM'）；正常退出时为 null。 */
  signal: NodeJS.Signals | null
}

/** 一次增量 {@link SubprocessOutputReader.readFrom} 读取。 */
export interface SubprocessOutputRead {
  /** 从请求偏移开始的流文本（有损时为完整保留的尾部）。 */
  text: string
  /** 下一次读取时续传的整流产偏移。 */
  nextOffset: number
  /** 请求的偏移已滑出内存尾部窗口时为 true。 */
  lossy: boolean
  /** 完整流溢出文件的路径，当已创建且仍完好时。 */
  spillPath?: string
}

/**
 * 对一条收集输出流的无游标增量访问。偏移是调用方拥有的整流产字节坐标，因此独立的
 * 读取者不会互相消耗对方的输出；结算后的 `readFrom(0)` 即批处理结果（`lossy` 此时
 * 意味着内存尾部的头部已丢失——即 {@link CollectedOutput.truncated} 事实）。
 */
export interface SubprocessOutputReader {
  /**
   * 读取自 `fromByte` 以来捕获到的所有内容。当该偏移已滑出内存尾部窗口时，此次读取
   * 为 `lossy`——返回完整保留的尾部，缺口只能从溢出文件中恢复。
   * @param fromByte - 续传的整流产偏移（上一次读取的 `nextOffset`；首次读取为 0）。
   * @returns 增量文本、下一偏移、`lossy` 标志，以及（若存在）溢出文件路径。
   */
  readFrom(fromByte: number): SubprocessOutputRead
}

/** 针对以收集模式启动的流的基于偏移的读取器。 */
export interface SubprocessCollectedOutputs {
  /** 当且仅当 stdout 为 {@link SubprocessCollect} 时存在。 */
  readonly stdout?: SubprocessOutputReader
  /** 当且仅当 stderr 为 {@link SubprocessCollect} 时存在。 */
  readonly stderr?: SubprocessOutputReader
}

/**
 * 一个存活的子进程及其由提供方管理的进程范围。收集输出在退出后仍可读；
 * 管道流归调用方所有。
 *
 * 终止与 {@link SubprocessHandle.waitForExit} 使用同一受管范围。每个提供方需记录
 * 其可观察的范围，以及其信号与观察的限制。
 */
export interface SubprocessHandle {
  /** The child's stdin, present iff spawned with `stdin: 'pipe'`. */
  readonly stdin: Writable | undefined
  /** 子进程的原始 stdout，当且仅当以 `stdout: 'pipe'` 启动时存在。 */
  readonly stdout: Readable | undefined
  /** 子进程的原始 stderr，当且仅当以 `stderr: 'pipe'` 启动时存在。 */
  readonly stderr: Readable | undefined
  /** 当被请求时的一条独立、调用方拥有的字节通道；原生启动失败可能导致其缺失。 */
  readonly control: Duplex | undefined
  /** 针对收集模式流的基于偏移的读取器（退出后亦可读）。 */
  readonly collected: SubprocessCollectedOutputs
  /** 以启动命令的退出事实结算；因启动或提供方失败而拒绝。 */
  readonly done: Promise<SubprocessOutcome>
  /**
   * 在受管范围上启动提供方记录的终止流程——这是此 seam 唯一的终止动词。幂等，
   * 一旦该范围消失即为空操作，且同样由 spec 的中止信号触发。
   */
  terminate(): void
  /**
   * 等待同一受管范围清空——而非仅等待启动命令上报其结果，从而使幸存的工作仍可被观察。
   * @param signal - 等待的可选边界。
   * @returns 受管范围为空时为 `true`，信号先中止时为 `false`。
   * @throws 当所选提供方无法再观察其受管范围时。
   */
  waitForExit(signal?: AbortSignal): Promise<boolean>
}

/**
 * 终端进程原语支持的信号。在不引入跨 seam 依赖的前提下，使其成员与
 * `@deepseek-ai/dsh-terminal` 中的 `TerminalSignal` 保持一致；两者需同步修改。
 */
export type SubprocessTerminalSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'SIGTSTP' | 'SIGHUP'

/** 来自 subprocess 提供方执行环境的 shell 选择事实。 */
export interface SubprocessTerminalEnvironment {
  /** 解释可执行路径与 shell 参数的操作系统族。 */
  platform: 'posix' | 'windows'
  /** 登录或环境所选的 shell，当提供方能解析出其中之一时。 */
  defaultShell?: string
}

/** 一个完全指定的终端进程启动。 */
export interface SubprocessTerminalSpawnSpec {
  /** 可执行文件及参数；`argv[0]` 为程序名。 */
  argv: readonly string[]
  /** 此 subprocess 提供方执行世界中的工作目录。 */
  cwd: string
  /** 在提供方环境清理之后叠加的显式环境。 */
  env?: Record<string, string> | undefined
  /** 终端初始行数。 */
  rows: number
  /** 终端初始列数。 */
  cols: number
  /** 通过 TERM 向子进程声明的终端仿真类型。 */
  terminalType: string
  /** 请求支持的交互式 shell 生命周期观察；不支持的启动会报告未知活动。 */
  shellActivity?: boolean | undefined
  /** 整个终端会话从 TERM 到 KILL 的清理宽限期。 */
  graceMs: number
  /** 终端分配的取消；已发布的句柄拥有其后续生命周期。 */
  signal?: AbortSignal | undefined
}

/** Current foreground process-group facts for one terminal. */
export interface SubprocessTerminalForeground {
  /** 由终端驱动发布的前台进程组 id。 */
  processGroupId: number
  /** 提供方当前能否证明该进程组正在等待终端输入。 */
  inputWaiting: boolean
}

/** 提供方对 shell 生命周期及幸存的被管作业所做的观察。 */
export interface SubprocessTerminalActivity {
  /** 空闲需要正面的提示符证据，且无被观察到的前台、后台或已停止作业。 */
  state: 'idle' | 'busy' | 'unknown'
  /** 随输入、shell 转换及进程观察变化而变化；作用域限定于本句柄。 */
  revision: number
}

/**
 * 一个存活的终端进程及其拥有的操作系统会话。终端分配、前台进程组检查/信令，以及
 * 整个会话的静默，是一个深层的 subprocess 原语，因为在没有特定底层进程控制的
 * 情况下，这些都无法从普通的管道 stdio 重建出来。
 */
export interface SubprocessTerminalHandle {
  /** 顶层终端进程 id。 */
  readonly pid: number
  /** 按投递顺序的 UTF-8 终端输出字节；终端退出后在已排队输出之后结束。 */
  readonly output: Readable
  /** 顶层进程退出时结算；因终端启动、提供方或实时传输失败而拒绝。 */
  readonly done: Promise<SubprocessOutcome>
  /**
   * 向终端输入写入文本。
   * @param data - 投递的文本，不做隐式换行转换。
   */
  write(data: string): Promise<void>
  /**
   * 改变终端尺寸并通知其前台应用。
   * @param cols - 正数终端列数。
   * @param rows - 正数终端行数。
   */
  resize(cols: number, rows: number): Promise<void>
  /**
   * 检查当前的前台进程组。
   * @returns 其 id 与输入等待事实，或当无法解析出前台进程组时为 undefined。
   */
  inspectForeground(): Promise<SubprocessTerminalForeground | undefined>
  /**
   * 观察命令活动，但不解读输出，也不把静默当作完成。
   * @returns 一次新的观察；不支持的 shell 与未完成的观察会报告 unknown。
   */
  inspectActivity(): Promise<SubprocessTerminalActivity>
  /**
   * 向当前前台进程组投递一个信号。
   * @param signal - 允许的终端信号。
   * @returns 实际收到该信号的进程组 id。
   */
  signalForeground(signal: SubprocessTerminalSignal): Promise<number>
  /**
   * 幂等地终止提供方仍能观察到的每一个终端会话成员，并等待其静默。结算之后，
   * 不再有任何进行中的写入、检查或信号调用。提供方需记录特定底层的可观察性限制。
   */
  terminate(): Promise<void>
}
