/** 浏览器终端标识、元数据与屏幕流帧。 */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { RemoteUplinkWindow } from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** 终端标识缺失或已开始进程清理。 */
    'terminal/unavailable': Record<string, never>
    /** 输入或 resize 被拒绝，但不会使输出连接失效。 */
    'terminal/control-unavailable': { readonly reason: 'read-only' | 'not-running' }
    /** 已保留的屏幕与待完成的分配占用 Session 的终端配额。 */
    'terminal/limit-reached': { readonly limit: number }
  }
}

/** 限定于单个 Session 与单个 Host 生命周期的终端标识。 */
export type WebTerminalId = Branded<'WebTerminalId'>

/** 确认一次物理窗口持有，而不获取屏幕或输入控制权。 */
export interface TerminalRetentionFrame {
  readonly type: 'retained'
}

/** 在子进程提供方的执行环境中验证过的可执行 shell。 */
export interface TerminalShell {
  readonly path: string
  readonly args: readonly string[]
  readonly name: string
}

/** 当前 Session 目录与终端限制；已保留的终端保留各自的进程目录。 */
export interface TerminalEnvironment {
  /** 已记录的当前目录，读取时不做文件系统校验。 */
  readonly cwd: string
  readonly maxInputBytes: number
  /** 在确认之前保留的完整编码 Client 输入的最大字节数。 */
  readonly maxBufferedBytes: number
  readonly maxCols: number
  readonly maxRows: number
  readonly scrollback: number
}

/** Host 持有的终端状态；进程退出绝不会创建替换的 shell。 */
export interface WebTerminalInfo {
  readonly id: WebTerminalId
  readonly title: string
  readonly shell: TerminalShell
  /** 初始工作目录；shell 的目录变更不会更新此字段。 */
  readonly cwd: string
  readonly cols: number
  readonly rows: number
  readonly state: 'running' | 'exited' | 'failed'
  readonly exitCode: number | null
  readonly error?: string
}

/** 对打开状态的标识而言 create 是幂等的；已关闭的标识不能重新创建。 */
export interface TerminalCreateRequest {
  /** shell 发现返回的路径；缺省时选择执行环境默认值。 */
  readonly shellPath?: string
  readonly id: WebTerminalId
  readonly cols: number
  readonly rows: number
}

/** 命令在每次连接内从 1 开始连续编号；确认绝不授权重放。 */
export type TerminalInput =
  | { readonly type: 'write'; readonly sequence: number; readonly data: string }
  | { readonly type: 'resize'; readonly sequence: number; readonly cols: number; readonly rows: number }

/**
 * 每次连接都以一个完整的有界屏幕开始，随后是有序输出。
 * 当载体没有编码帧收件箱限制时，inputWindow 缺省。
 */
export type TerminalFrame =
  | { readonly type: 'snapshot'; readonly sequence: number; readonly screen: string; readonly info: WebTerminalInfo; readonly writable: boolean; readonly inputWindow?: RemoteUplinkWindow }
  | { readonly type: 'output'; readonly sequence: number; readonly data: string }
  | { readonly type: 'state'; readonly info: WebTerminalInfo; readonly writable: boolean }
  | { readonly type: 'ack'; readonly sequence: number; readonly refusal?: 'read-only' | 'not-running' }
