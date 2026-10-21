/**
 * PTC 执行能力 seam 的 Service Definition：把一段模型编写的程序跑起来，
 * 并让它调用宿主侧异步绑定。运行时对工具与会话一无所知；这些关注点属于消费者。
 * @module @deepseek-ai/dsh-ptc-runtime
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { PtcRunRequest, PtcRunResult, PtcRunSpec } from './types.ts'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'

export type {
  PtcBindingErrorClass,
  PtcBindingFunction,
  PtcBindingNamespace,
  PtcJsonValue,
  PtcRunFailure,
  PtcRunRequest,
  PtcRunResult,
  PtcRunSpec,
  PtcRunSandbox,
} from './types.ts'

/**
 * 所有后端都会拒绝的绑定全局名 —— 因为总会有某个后端占用了程序命名空间中的该槽位：
 * `console`（Node 的日志捕获），以及
 * `__dsh_main__`/`__builtins__`/`__name__`（Python 后端的 bootstrap 包装器
 * 与被预置的模块全局），还有 `__debug__`。共用一份集合 —— 而不是每个后端只拒绝自己
 * 的那几个槽位 —— 才能让可移植承诺真正成立：在某一后端合法的命名空间列表在所有后端
 * 都合法，调用方因此不可能挑到一个在 Node 上可用、却在 Python 上撞名的名字
 * （反之亦然）。`__name__` 等确实是可移植标识符，`PtcBindingNamespace.global`
 * 的标识符规则并不会拒绝它们，因此才需要这份显式集合。（错误成员不同：
 * {@link DUNDER_MEMBER} 会整体拒绝一切 dunder 形式；绑定全局名只拒绝此处列出的
 * 这几个。）`__debug__` 被列入的原因并非撞名：CPython 会把裸 `__debug__` 引用
 * 编译成常量 `True`，并且在编译期就拒绝对该名字的任何赋值，因此注入到这个名字下的
 * 全局在程序中根本不可达 —— 校验会接受它，Python 后端却用不了，而这正是共用集合
 * 要避免的那种割裂。
 */
export const RESERVED_BINDING_GLOBALS: ReadonlySet<string> = new Set([
  'console',
  '__dsh_main__', '__builtins__', '__name__', '__debug__',
])

/**
 * 所有后端都会拒绝的 `PtcBindingErrorClass.memberNameProperty` 名称，作为一份共用契约，
 * 使得在某一后端合法的请求在所有后端都合法。JS `Error` 的排除项
 * （`name`、`message`、`stack`）与 Python 异常协议成员
 * （`args`、`with_traceback`、`add_note`）按名列出；dunder 形式名
 * （`__x__`，中间非空）则整体拒绝 —— 其中若干是受约束的 CPython 描述符，
 * 构造拒绝时其 `setattr` 会抛错，而确切集合属于解释器版本的实现细节。
 * 其他任何非空自有属性名都在所有后端被接受。
 */
export const RESERVED_ERROR_MEMBERS: ReadonlySet<string> = new Set([
  'name', 'message', 'stack',
  'args', 'with_traceback', 'add_note',
])

/**
 * Dunder 形式（`__x__`，中间非空）：在 Python 中属于对象协议槽位，
 * 在所有后端都作为 {@link RESERVED_ERROR_MEMBERS | 错误成员} 被拒绝。
 */
export const DUNDER_MEMBER = /^__.+__$/

/**
 * 所有可移植目标语言（ECMAScript ∪ Python）的保留字，由所有后端作为
 * {@link PtcBindingNamespace.global} / 错误类名拒绝，每种语言各一份：已发布的
 * TypeScript Node 进程，以及实验性、未公开的 CPython 子进程。可移植标识符契约承诺
 * 在某一后端合法的命名空间列表在所有后端都合法；按语言分别检查会让 `lambda`
 * 通过 TypeScript 后端却在 Python 后端失败。为 seam 新增一门语言意味着扩大该并集
 * （按设计，这会对既有绑定名做一次破坏性复核）。
 */
export const PORTABLE_RESERVED_WORDS: ReadonlySet<string> = new Set([
  // ECMAScript 保留字，以及仅在严格模式下保留的名称。
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in',
  'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof',
  'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'implements', 'interface', 'package',
  'private', 'protected', 'public', 'arguments', 'eval',
  // 上面未列出的 Python 3.x 关键字与软关键字（'type' 与 '_' 是软关键字：
  // 实践中是合法名称，此处为稳妥起见也一并保留）。
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'def', 'del', 'elif', 'except', 'from',
  'global', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'match', 'type', '_',
])

declare module '@deepseek-ai/cordis' {
  interface Context {
    ptcRuntime: PtcRuntime
  }
}

/**
 * 注册一个 `ctx.ptcRuntime` 实现。程序、预算、中止与执行基座的失败都以
 * {@link PtcRunResult} 的字段决议；只有 Service Definition 契约被误用时才拒绝。
 * 实现方负责桥接可结构化克隆的绑定、具现化每个命名空间声明的拒绝类、把程序当作
 * 敌对对等方对待、隔离不同的状态所有者，并在销毁时终止且等待进行中的运行结束。
 */
export abstract class PtcRuntime extends Service {
  /**
   * {@link run} 期望 `program` 使用的源语言，以小写标识符表示。仅供参考，不做门禁 ——
   * 生成语言专属呈现（类型化 SDK 存根、使用说明）的消费者据此分支，遇到无法呈现的
   * 语言就大声失败。已知取值：`'typescript'` 与 `'python'`，即 `dsh-tools` 会呈现的
   * 两种；TypeScript 后端已发布，Python 后端是实验性且未公开的（不发布）。
   */
  abstract readonly language: string

  /**
   * 执行基座，以小写标识符表示。仅供参考，不做门禁 —— 它是一段描述，让部署与诊断
   * 能区分后端，而不是一项安全声明。已知取值：`'worker-thread'`、`'process'`、
   * `'container'`。
   */
  abstract readonly isolation: string

  /** 源码求值形式，与 provider 是否为某所有者保留状态无关。 */
  get programFormat(): 'function-body' | 'repl' { return 'function-body' }

  /**
   * 释放某个所有者保留的环境，并等待其执行资源回收。
   * 无状态 provider 没有需要释放的保留资源。
   * @param owner - 作为请求状态所有者传入的那个确切对象。
   * @returns 在其名下所有执行资源都已释放后完成。
   * @throws 当托管资源清理失败时。
   */
  release(owner: object): Promise<void> { void owner; return Promise.resolve() }

  /** provider 自有的程序使用说明，供消费者与源语言一同呈现。 */
  get executionInstructions(): string { return '' }

  /** 部署的文件策略模式；provider 不支持隔离时为 undefined。 */
  get sandboxMode(): SandboxMode | undefined { return undefined }

  /** 已配置的数值型执行时间默认值与上限；不支持逐次调用覆盖时为 undefined。 */
  get timeout(): { defaultMs: number; maxMs: number } | undefined { return undefined }

  constructor(ctx: Context) {
    super(ctx, 'ptcRuntime')
  }

  /**
   * 在执行前解析受支持的选项与 provider 默认值。
   * @param request - 程序、绑定、取消信号，以及可选的执行选择。
   * @returns 供 run 使用的完整目录、截止时间与受支持的权限。
   * @throws 当某个显式取值非法或不被该 provider 支持时。
   */
  abstract resolve(request: PtcRunRequest): PtcRunSpec

  /**
   * 执行已解析的输入；程序的各种结果以结果字段的形式决议。
   * @param spec - 目录、截止时间、程序、绑定、取消信号与受支持的策略。
   * @returns 捕获到的输出与本次执行的结果。
   */
  abstract run(spec: PtcRunSpec): Promise<PtcRunResult>
}

export default PtcRuntime
