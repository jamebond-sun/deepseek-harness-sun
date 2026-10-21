/**
 * 单个执行世界的文件系统服务定义。后端负责稳定的目标标识、进程路径与文件 URI、
 * 隔离约束、文本读取、解码、二进制拒绝以及原子修改。读取窗口与观测态策略由消费方
 * 与策略插件负责；`editText` 保留在此处，使版本校验、字面量匹配与重写共享同一段临界区。
 * @module @deepseek-ai/dsh-fs
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { FsError } from './types.ts'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsObservation,
  FsTarget,
  FsVersion,
  FsWriteIntent,
  FsWriteOutcome,
} from './types.ts'

export {
  FsError,
  FsTargetKey,
  FsVersion,
} from './types.ts'
export type {
  FsEditOutcome,
  FsEditRequest,
  FsDirEntry,
  FsErrorCode,
  FsInfo,
  FsObservation,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    fs: FileSystem
  }

  interface Events {
    /**
     * 下一次 {@link FileSystem.writeText} 的单槽决策。调用 `next()` 会产出裸提供者的
     * 无条件写入；首个返回意图的监听器独占该决策，而不是与同级监听器组合。
     * @param target - 即将被写入的已解析目标。
     * @param actor - 决策方据以判断的不透明工具执行上下文。
     * @mode waterfall
     */
    'fs/write-intent'(target: FsTarget, actor: object | undefined, next: () => FsWriteIntent | undefined | Promise<FsWriteIntent | undefined>): Promise<FsWriteIntent | undefined>
    /**
     * 下一次 {@link FileSystem.editText} 的单槽决策。调用 `next()` 会产出无条件编辑；
     * 首个返回的守卫生效。
     * @param target - 即将被编辑的已解析目标。
     * @param actor - 决策方据以判断的不透明工具执行上下文。
     * @mode waterfall
     */
    'fs/edit-intent'(target: FsTarget, actor: object | undefined, next: () => { version: FsVersion } | undefined | Promise<{ version: FsVersion } | undefined>): Promise<{ version: FsVersion } | undefined>
    /**
     * 记录一次权威的肯定或否定观测。监听器必须是同步的记录者：抛出异常会使工具调用失败，
     * 返回的 promise 不会被等待。
     * @param target - 被观测到存在或不存在的目标。
     * @param observation - 存在并附带版本，或已确认不存在。
     * @param actor - 执行观测的工具上下文；为 undefined 时记录不出有意义的信息。
     * @mode emit
     */
    'fs/observed'(target: FsTarget, observation: FsObservation, actor: object | undefined): void
  }
}

/**
 * 抽象的文件系统提供者。目标必须在别名之间保持同一性；读取暴露常规的 UTF-8 文本或
 * 类型化错误，列举结果稳定且不含内容，修改操作是原子的。可选的守卫提供过期保护，
 * 但不改变无守卫时的提供者契约。
 */
export abstract class FileSystem extends Service {
  constructor(ctx: Context) {
    super(ctx, 'fs')
  }

  /**
   * 在该提供者的执行世界中观测一个文件或一个目录的直接子项。
   * @param target - 已解析的文件或目录，也可以是不存在的路径，用于观测其创建。
   * @param changed - 失效回调；错误可在初始化期间或之后上报。
   * @param signal - 取消监听器的初始化；已初始化的监听器由调用方关闭。
   * @returns promise 在观测生效后 resolve，并返回一个异步的关闭函数。
   * @throws 当提供者不支持监听或无法初始化监听器时抛出。
   */
  watch(target: FsTarget, changed: (error?: Error) => void, signal: AbortSignal): Promise<() => Promise<void>> {
    void target
    void changed
    signal.throwIfAborted()
    return Promise.reject(new FsError('Filesystem watching is not supported by this provider.', 'FS_IO_ERROR'))
  }

  /**
   * 该后端**默认**对修改操作强制施加的沙箱模式，若完全不做隔离则为 `undefined` ——
   * 工具层读取这一能力事实，以便诚实地宣示提级字段（对应 `ShellExecutor.sandboxMode`）。
   * 基类与裸本地后端返回 `undefined`；做隔离的后端（`@deepseek-ai/dsh-fs-sandbox`）
   * 用部署默认值覆写它。会话级覆写可能让有效模式更窄或更宽，因此提级是否被严格放宽
   * 是按次调用检查的，而不编码进这个相对默认的事实里。
   * @returns 隔离后端已配置的默认模式；永不做隔离的后端为 `undefined`。
   */
  get sandboxMode(): SandboxMode | undefined {
    return undefined
  }

  /**
   * 把模型/插件提供的路径解析为稳定的 {@link FsTarget}。可能会执行 I/O（远端或沙箱后端
   * 可能需要一次往返才能把路径映射为稳定标识），因此是异步的，尽管本地后端只做规范化
   * 加 realpath。
   *
   * @param path - 待解析的路径；相对路径基于 `opts.cwd` 解析。
   * @param opts - 可选的 cwd 覆写与取消信号。
   * @returns 稳定的目标；同一个文件产出相同的 `targetKey`。
   */
  abstract resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>

  /**
   * 返回该文件系统执行世界中子进程可以打开的规范绝对路径。该路径刻意与
   * {@link FsTarget.targetKey} 分离：消费方可以把这个值交给另一个操作系统能力，
   * 但必须继续把目标键当作不透明值。
   * @param target - 需要其进程路径的已解析目标。
   * @returns 后端执行世界中的绝对路径。
   */
  abstract processPath(target: FsTarget): string

  /**
   * 当宿主路径与本文件系统执行世界中的某个路径指向同一文件时，把宿主的绝对路径映射到
   * 本文件系统的执行世界。基础提供者不提供任何映射；由宿主持有或显式共享的后端会覆写它。
   * @param hostPath - 宿主文件系统中的绝对路径。
   * @returns 同一文件在该执行世界中的进程路径；当该执行世界读不到这个宿主文件时为 undefined。
   */
  processPathFromHostPath(hostPath: string): string | undefined {
    void hostPath
    return undefined
  }

  /**
   * 返回目标在该文件系统执行世界中的规范 `file:` URI。URI 编码由后端负责，因为宿主平台
   * 可能与执行平台不同。
   * @param target - 待编码的已解析目标。
   * @returns 目标的规范文件 URI。
   */
  abstract fileUrl(target: FsTarget): string

  /**
   * 在不暴露或解析后端目标键的前提下测试规范的包含关系。两个目标都必须来自本提供者。
   * @param parent - 规范的目录目标。
   * @param child - 规范的候选目标。
   * @returns 当 `child` 就是 `parent` 或其后代时为 true。
   */
  abstract contains(parent: FsTarget, child: FsTarget): boolean

  /**
   * 返回目标元数据；当目标不存在时为 `undefined`。
   * @param target - 待 stat 的已解析目标。
   * @param signal - 中断元数据的往返。
   * @returns 仅元数据，绝不含内容；目标不存在时为 undefined。
   */
  abstract stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>

  /**
   * 当最后一个路径分量是符号链接时，返回不跟随该分量的路径元数据。它刻意是路径形态而非
   * 目标形态：{@link resolve} 会跟随符号链接以产出普通读写所用的稳定标识，而 `lstat` 让
   * 消费方能在跟随发生之前先拒绝该路径本身。
   *
   * `opts.cwd` 遵循 {@link resolve} 的 cwd 规则。`undefined` 表示路径不存在。
   * @param path - 待检查的路径；相对路径基于 `opts.cwd` 解析。
   * @param opts - `cwd` 覆写后端解析相对路径时使用的默认基准。
   * @param signal - 中断元数据的往返。
   * @returns 仅元数据，绝不含内容；路径不存在时为 undefined。
   */
  abstract lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined>

  /**
   * 把整个常规文本文件读成一个已解码的字符串。
   * @param target - 待读取的已解析目标。
   * @param signal - 中断读取。
   * @returns 完整解码后的 UTF-8 内容。
   */
  abstract readText(target: FsTarget, signal?: AbortSignal): Promise<string>

  /**
   * 以已解码的文本分块流式读取整个常规文本文件（文本语义同 {@link readText}，用于大文件）。
   * 后端负责跨分块的 UTF-8 解码与二进制拒绝，使策略层永远不接触原始字节。
   * @param target - 待读取的已解析目标。
   * @param signal - 中断流读取，包括分块之间的中断。
   * @returns 已解码并按 {@link readText} 同样校验过的分块可迭代对象。
   */
  abstract streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>>

  /**
   * 把整个常规文件读成原始字节，不做任何解码与二进制拒绝。上限就设在这个接缝处，使后端
   * 永远不会缓冲无界大的文件：已知或发现超过 `maxBytes` 的目标会以 `FS_TOO_LARGE` 失败，
   * 而不是返回被截断的结果。
   * @param target - 待读取的已解析目标。
   * @param signal - 中断读取。
   * @param maxBytes - 对完整内容的字节上限，含边界值。
   * @returns 完整的原始内容，长度至多为 `maxBytes`。
   */
  abstract readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>

  /**
   * 以原始字节读取常规文件的一个字节窗口，不做任何解码与二进制拒绝：即 `[offset, offset + length)`
   * 处的字节；当文件在窗口内结束时结果更短，当 `offset` 位于或超过文件末尾时结果为空。
   * 这里的界限是窗口而不是文件：除了为到达 `offset` 而跳过的那部分前缀，后端最多再传输
   * `length` 字节的内容，永不会缓冲整个文件，因此调用方对 `length` 的限制才是防止无界
   * 缓冲的守卫。
   * @param target - 待读取的已解析目标。
   * @param range - `offset` 为 0 基的首字节位置，`length` 为最大字节数；均为非负整数。
   * @param signal - 中断读取。
   * @returns 窗口内的字节，长度至多为 `length`。
   */
  abstract readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array>

  /**
   * 以稳定的名称顺序列出目录的直接子项。返回已解析的子目标外加廉价的元数据，绝不读取
   * 文件内容。
   * @param target - 已解析的目录目标。
   * @param signal - 中断列举。
   * @returns 每个直接子项一个条目，按稳定的名称顺序排列。
   */
  abstract listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]>

  /**
   * 原子地创建或替换 UTF-8 文本。`expected` 守卫意图与过期；省略则允许无条件覆盖。
   * @param target - 待写入的已解析目标。
   * @param content - 文件的全新完整内容。
   * @param expected - 守卫本次写入的写入意图；省略表示无条件写入。
   * @param signal - 在原子发布生效之前中断本次写入。
   * @param sandboxPolicy - 本次写入所依据的按次调用模式与工作区根目录；隔离型后端据此围栏
   *   本次写入，裸后端忽略它。省略则让后端沿用自身默认值。
   * @returns 写入结果，包含本次写入产生的版本。
   */
  abstract writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome>

  /**
   * 原子地编辑字面量文本。给定版本守卫时，会在匹配之前先校验版本，使过期内容报
   * `FS_STALE_VERSION`；省略则不带新鲜度前置条件地编辑当前内容。
   * @param target - 待编辑的已解析目标。
   * @param edit - 字面量的查找/替换请求。
   * @param expected - 版本守卫；省略表示无条件编辑。
   * @param signal - 在原子发布生效之前中断本次编辑。
   * @param sandboxPolicy - 本次编辑所依据的按次调用模式与工作区根目录；隔离型后端据此围栏
   *   本次编辑，裸后端忽略它。省略则让后端沿用自身默认值。
   * @returns 编辑结果，包含本次编辑产生的版本。
   */
  abstract editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome>
}

export default FileSystem
