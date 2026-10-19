/**
 * @deepseek-ai/dsh-cmdline —— dsh 启动器交给它所启动应用的命令行参数。
 *
 * 启动器只解析自己的标志（`--profile`、`--patch`、各配置转储），然后把它们
 * 之后的所有内容按原样、按 argv 顺序通过 {@link CmdlineArgs} 服务交给应用树，
 * 因此某个应用拥有自己的标志族、自己的 `--help` 文本以及自己的解析错误，而
 * 启动器无需了解它们。
 *
 * 任何应用插件都可以注入 `cmdlineArgs` 并调用 {@link parseCmdline}。某个 provider
 * 可以在其程序的 commander action 中把解析后的值作为自己的服务发布，普通行则
 * 可以注入该服务并从惰性解析的配置中读取它 —— 例如
 * `port: !!js ctx.webStartup.port ?? 3080` —— 这样某个标志会胜过写在它旁边的
 * 默认值。没有任何行拥有启动器级别的命令行状态。
 * @module @deepseek-ai/dsh-cmdline
 */

import type { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'

/**
 * 本次调用的内部参数：启动器自身标志之后的所有内容，按原样、按 argv 顺序排列。
 * `dsh --profile tui --resume abc` 会得到 `['--resume', 'abc']`。
 */
export interface CmdlineArgs {
  /**
   * 读取内部参数。
   * @returns 按 argv 顺序排列的参数；当本次调用没有任何参数时为空数组。
   */
  get(): readonly string[]
}

/** 请求有界进程退出；启动器会把它接到自己的关闭控制器上。 */
export interface AppExit {
  /**
   * 在应用树被释放后请求退出。
   * @param code - 进程退出码。
   */
  (code: number): void
}

/** 由启动器拥有的、应用启动成功的信号。 */
export interface AppReady {
  /**
   * 在启动成功被提交后运行一次监听器。启动失败或被外部终止时永远不会调用它。
   * @param listener - 只有在启动成功之后才能开始的工作。
   * @returns 取消一个待运行监听器的释放函数。
   */
  onReady(listener: () => void): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 本次调用的内部参数；由启动器在应用树挂载之前提供。 */
    cmdlineArgs?: CmdlineArgs
    /** 有界的进程退出请求；由启动器在应用树挂载之前提供。 */
    appExit?: AppExit
    /** 启动成功信号；由启动器在应用树挂载之前提供。 */
    appReady?: AppReady
  }
}

/** 应用所需的启动器事实。 */
export interface CmdlineHost {
  /** 本次调用的内部参数，按 argv 顺序排列。 */
  args: readonly string[]
  /** 有界的进程退出请求。 */
  exit: AppExit
  /** 用于绝不能掩盖启动失败的生命周期工作的启动成功信号。 */
  ready?: AppReady
}

/**
 * 在任意应用树入口挂载之前，在宿主上下文上提供启动器事实：命令行、有界退出请求，
 * 以及可选的启动成功信号。一个没有命令行的嵌入式宿主提供空的参数列表；一个挂载
 * stdio 应用的宿主同时提供就绪信号。
 * @param ctx - 应用树将挂载在其下的宿主上下文。
 * @param host - 本次调用的参数、退出请求，以及可选的就绪信号。
 */
export function provideCmdline(ctx: Context, host: CmdlineHost): void {
  const snapshot: readonly string[] = Object.freeze([...host.args])
  ctx.provide('cmdlineArgs', { get: () => snapshot })
  ctx.provide('appExit', host.exit)
  if (host.ready !== undefined) ctx.provide('appReady', host.ready)
}

/** 用于绑定 stdio 应用生命周期的进程 stdin 操作。 */
export interface AppStdin {
  /** EOF 是否在应用绑定其监听器之前就已经到达。 */
  readonly readableEnded: boolean
  /** 订阅一次 stdin 的 EOF。 */
  once(event: 'end', listener: () => void): unknown
  /** 移除此前安装的 stdin EOF 监听器。 */
  off(event: 'end', listener: () => void): unknown
}

/** 应用命令行与 stdio 生命周期绑定所用的进程流；测试会替换它们。 */
export const internals: {
  stdin: AppStdin
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
} = {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
}

/**
 * 让 stdin 的 EOF 在 {@link AppReady} 提交之后请求启动器的有界成功关闭。因此当
 * EOF 与启动拒绝竞速时，启动拒绝仍然是进程的结果。调用方只有在自己的命令行
 * action 接受了本次调用之后才会调用它，所以 help 与 usage 失败不会启动任何
 * 传输生命周期。该监听器不会读取或恢复 stdin：协议传输拥有输入，并接收在它挂载
 * 之前被缓冲的字节。释放操作会移除 EOF 与就绪监听器。
 * @param ctx - 携带启动器退出请求的应用插件上下文。
 * @param label - 命名所属应用的 effect 标签。
 */
export function exitOnStdinEnd(ctx: Context, label: string): void {
  const exit = ctx.get('appExit')
  const ready = ctx.get('appReady')
  if (exit === undefined || ready === undefined) {
    throw new Error('stdio app: the launcher must provide ctx.appExit and ctx.appReady before the tree mounts')
  }
  const stdin = internals.stdin
  let active = true
  let ended = false
  let cancelReady = (): void => {}
  const onEnd = (): void => {
    if (!active || ended) return
    ended = true
    cancelReady = ready.onReady(() => { exit(0) })
  }
  ctx.effect(() => () => {
    active = false
    cancelReady()
    stdin.off('end', onEnd)
  }, label)
  stdin.once('end', onEnd)
  if (stdin.readableEnded) queueMicrotask(onEnd)
}

/**
 * 用某个应用的 commander 程序解析启动器不可变的参数快照。commander 会在解析成功时
 * 运行该程序自己的同步 action 处理器；其中的应用代码会发布自己的服务，并用
 * `program.error(...)` 拒绝非法的调用。本辅助函数没有 Loader 行或服务的所有权语义。
 *
 * help、version，以及被拒绝的参数 —— 无论是来自文法还是来自某个 action —— 都会
 * 终止进程：commander 写出文本，而本辅助函数请求 `ctx.appExit`。在 help、version
 * 或文法拒绝时 action 永远不会运行；action 必须在发布之前就拒绝，因为它在
 * `program.error(...)` 之前的语句已经运行过了。
 * @param ctx - 携带 `cmdlineArgs` 与 `appExit` 的插件上下文。
 * @param program - 应用的 commander 程序，其标志、描述、actions 以及任意子命令
 * 都已声明完毕。
 * @throws 当启动器没有提供命令行和退出请求，或程序中没有任何命令声明 action 时。
 */
export function parseCmdline(ctx: Context, program: Command): void {
  // 通过全局服务存储读取，而不是属性代理：appExit 是一个可选的宿主值，插件只需
  // 注入 cmdlineArgs 即可。
  const args = ctx.get('cmdlineArgs')
  const exit = ctx.get('appExit')
  if (args === undefined || exit === undefined) {
    throw new Error(`${program.name()}: the launcher must provide ctx.cmdlineArgs and ctx.appExit before the tree mounts`)
  }
  if (!hasAction(program)) {
    throw new Error(`${program.name()}: no command in the program declares an action; parseCmdline runs the invoked command's action on a successful parse, and app code there publishes its service`)
  }
  configureExitAndOutput(program)
  try {
    program.parse(args.get(), { from: 'user' })
  } catch (error) {
    // exitOverride 会把 help、version、解析错误，以及 action 自己的
    // program.error() 变成一个 CommanderError；commander 已经通过上述配置的输出
    // 写好了文本。
    if (!isCommanderError(error)) throw error
    exit(error.exitCode)
  }
}

/**
 * 命令树中是否任何命令声明了 action 处理器。
 *
 * `Command` 类型无法表达 action 的前置条件，因此处理器是结构性读取的（就像
 * {@link isCommanderError} 读取 commander 的控制流错误那样）：如果没有这道守卫，
 * 一个忘记了自己 action 的程序会解析成功、什么都不发布，并且仅仅表现为依赖行
 * 挂在缺失的服务上。
 * @param command - 被检查其命令树的对象。
 * @returns 当该命令或任意已注册子命令拥有 action 时返回 true。
 */
function hasAction(command: Command): boolean {
  if (typeof (command as unknown as { _actionHandler?: unknown })._actionHandler === 'function') return true
  return command.commands.some(hasAction)
}

/**
 * 把每个命令的退出与输出都经由启动器适配器路由。
 *
 * commander 只在注册时把 `exitOverride` 与输出配置复制到子命令，因此仅作用于根
 * 的覆盖会让一个已经注册过的子命令的拒绝直接写到进程流并调用 `process.exit`，
 * 从而绕过 `ctx.appExit`。
 * @param command - 要配置的命令树的根。
 */
function configureExitAndOutput(command: Command): void {
  command
    .exitOverride()
    .configureOutput({
      writeOut: text => void internals.stdout.write(text),
      writeErr: text => void internals.stderr.write(text),
    })
  for (const child of command.commands) configureExitAndOutput(child)
}

/**
 * 一个被抛出的值是否为 commander 自己的控制流错误（help、version、解析错误，
 * 或 `program.error`）。
 *
 * 这是结构性检测的，而不是用 `instanceof`：一个树外的插件会带来它自己的 commander
 * 副本，其 `CommanderError` 类的身份与本包的不同，而在那里做身份检查会把一个已经
 * 打印出来的 help 当作致命的加载失败重新抛出。
 * @param error - 被抛出的值。
 * @returns 当该值携带 commander 的错误码与退出码时返回 true。
 */
function isCommanderError(error: unknown): error is { code: string; exitCode: number } {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { code?: unknown; exitCode?: unknown }
  return typeof candidate.code === 'string' && candidate.code.startsWith('commander.')
    && typeof candidate.exitCode === 'number'
}
