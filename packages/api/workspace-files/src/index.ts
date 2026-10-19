/**
 * Workspace 文件服务：只读文件预览、workspace 目录列表，以及文件系统
 * 观察变更流，以 `workspaceFiles` 暴露。
 *
 * 文件读取遵循组合文件系统的读访问，包括 workspace 之外的路径。所选
 * Session 头提供相对路径的基准，其无 cwd 时的回退是 sandbox 策略根，
 * 而非读取围栏限制。目录列表与变更观察保持 workspace 范围。文件类型
 * 检查与配置的读取上限适用于每次预览；本服务不暴露任何变更操作。
 *
 * 一页从 `streamText` 中截取，后者边解码边拒绝非 UTF-8，因此文件只被
 * 读取到页之后的第一个字符，且整个文件从不整体驻留内存；NUL 扫描
 * 在页本身上运行。
 *
 * 本服务并非以 `session.openWorkspacePath` 为模型。那个端点把路径交给
 * 本地打开器并把效果留在机器上；本服务则把文件内容经 wire 发送，
 * 属于不同的暴露级别。
 */

import { posix, win32 } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-fs'
import type { FsDirEntry, FsInfo, FsPathInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Remote, RemoteError, TypertRemoteService, type TypertLookup } from '@deepseek-ai/dsh-typert-protocol'
import { WorkspaceChangeFeed } from './changes.ts'
import type {
  WorkspaceByteRange,
  WorkspaceByteReadOptions,
  WorkspaceDirectoryEntry,
  WorkspaceDirectoryListing,
  WorkspaceFileBytes,
  WorkspaceFileRange,
  WorkspaceFileStat,
  WorkspaceFileText,
  WorkspaceFileWatchFrame,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** `workspaceFiles` Remote 命名空间的 Host 属主。 */
    workspaceFiles: WorkspaceFiles
  }
}

/** 由头派生的单个 Session 身份的文件解析上下文。 */
export interface WorkspaceFileScope {
  /** wire 上收到的 Session 身份。 */
  readonly sessionId: SessionId
  /** Session 的 workspace 根，其头不含 cwd 时为部署回退值。 */
  readonly workspaceRoot: string
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertLookupMap {
    /** 将 Session id 解析为其 workspace 根，不加载其事件体，也不激活 Agent。 */
    workspaceFileScope: TypertLookup<WorkspaceFileScope, SessionId>
  }
}

/** 部署层面对单页或单次列表的上限。 */
export interface Config {
  /**
   * 单页文本与单个字节窗口的含边界字节上限。
   *
   * 超过上限的页直接失败而不被缩短，因为被静默截断的页读起来
   * 像完整页。请求更大字节窗口的调用以同样方式被拒绝。文件本身
   * 没有大小上限：调用方通过分页遍历。
   */
  readonly maxBytes: number
  /** 完整文件读取的含边界字节上限；更大的文件被拒绝，从不截断。 */
  readonly maxFileBytes: number
  /** 页大小的默认值与最大值（以行计）；请求更大的值会被拒绝。 */
  readonly maxLines: number
  /** 返回目录条目的上限；其余被丢弃并报告为已截断。 */
  readonly maxEntries: number
}

/** 从解码文本流截出的一页。 */
interface Page {
  readonly text: string
  /** `text` 中的行数；页越过最后一行时为 `0`。 */
  readonly lines: number
  readonly eof: boolean
}

/** 文本字节流中绝不出现的字节：它的存在将页标记为二进制。 */
const NUL = String.fromCharCode(0)

/** 拒绝 wire 模式视为数字但窗口无法使用的值：只有安全整数可用于索引文件。 */
function integerAtLeast(value: number, min: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new RemoteError('gateway/bad-request', `${name} must be a safe integer of at least ${min}`, {})
  }
  return value
}

/**
 * 从解码块中截取第 `offset` 到 `offset + limit - 1` 行，在读到页之后的
 * 第一个字符时停止，因此文件的其余部分从不被读取。页之前的行只计数
 * 不保留，且页的字节数一旦超过 `maxBytes` 立即被拒绝，因此一行超大
 * 内容也无法使内存越过上限增长。
 */
async function cutPage(
  chunks: AsyncIterable<string>,
  offset: number,
  limit: number,
  maxBytes: number,
  path: string,
): Promise<Page> {
  const last = offset + limit - 1
  const lines: string[] = []
  let current = ''
  let bytes = 0
  let lineNumber = 1
  const admit = (size: number): void => {
    bytes += size
    if (bytes > maxBytes) {
      throw new RemoteError(
        'workspace-file/too-large',
        `lines ${offset}-${last} of "${path}" exceed the ${maxBytes} byte cap`,
        { path, limit: maxBytes },
      )
    }
  }
  const complete = (): void => {
    if (lines.length > 0) admit(1)
    lines.push(current)
    current = ''
  }
  for await (const chunk of chunks) {
    let position = 0
    while (position < chunk.length) {
      if (lineNumber > last) return { text: lines.join('\n'), lines: lines.length, eof: false }
      const newline = chunk.indexOf('\n', position)
      const segment = newline === -1 ? chunk.slice(position) : chunk.slice(position, newline)
      if (lineNumber >= offset) {
        admit(Buffer.byteLength(segment, 'utf8'))
        current += segment
      }
      if (newline === -1) break
      if (lineNumber >= offset) complete()
      lineNumber += 1
      position = newline + 1
    }
  }
  // 这里只可能有一行页内内容尚未收尾：更早的行从未保留，
  // 且读到页之后的字符时已在上方返回。
  if (current.length > 0) complete()
  return { text: lines.join('\n'), lines: lines.length, eof: true }
}

/**
 * `target` 相对 `root` 的 workspace 路径，由两个规范 `file:` URI 推导而来，
 * 因此结果在所有平台上都以 `/` 连接。根本身为空串。
 */
function workspacePathOf(rootUrl: string, targetUrl: string): string {
  const root = new URL(rootUrl).pathname.replace(/\/+$/, '')
  const target = new URL(targetUrl).pathname
  if (target === root) return ''
  return target.slice(root.length + 1).split('/').map(decodeURIComponent).join('/')
}

/** 去掉已解析的子项目标：wire 只承载名称与元数据。 */
function directoryEntry(child: FsDirEntry): WorkspaceDirectoryEntry {
  return {
    name: child.name,
    type: child.type,
    ...child.size === undefined ? {} : { size: child.size },
  }
}

/** 在组合文件系统上提供 Host Remote 文件读取与 workspace 目录观察。 */
export class WorkspaceFiles extends TypertRemoteService {
  static inject = ['fs', 'sandboxPolicy', 'sessions', 'typert']

  static Config: z<Config> = z.object({
    maxBytes: z.number().step(1).min(1).default(2 * 1024 * 1024),
    maxFileBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER - 1).default(32 * 1024 * 1024),
    maxLines: z.number().step(1).min(1).default(5000),
    maxEntries: z.number().step(1).min(1).default(2000),
  })

  private readonly feed: WorkspaceChangeFeed

  /**
   * @param ctx - 携带文件系统与 sandbox 策略的 Host 上下文。
   * @param config - 部署层面对单页或单次列表的上限。
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'workspaceFiles')
    this.feed = new WorkspaceChangeFeed(ctx)
    ctx.inject(['sessions', 'typert'], (scope) => {
      scope.typert.lookups.register('workspaceFileScope', {
        parameter: 'workspaceFileScope',
        wire: 'workspaceFileScopeId',
        resource: 'session',
        hostTypeSymbol: '@deepseek-ai/dsh-api-workspace-files#WorkspaceFileScope',
        wireTypeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
        resolve: async (sessionId) => {
          const live = scope.sessions.get(sessionId)?.header
          const stored = live === undefined
            ? await scope.get('sessionPersistence')?.stat(sessionId)
            : undefined
          const header = live ?? stored?.header
          if (header === undefined) return undefined
          return {
            sessionId,
            workspaceRoot: header.cwd ?? scope.sandboxPolicy.workspaceRoot,
          }
        },
      })
    })
  }

  /**
   * 从文件系统后端可读的一个 UTF-8 文件中读取一页行。
   * @param workspaceFileScope - 由头派生的 workspace 根，对应 wire 上的 Session 身份。
   * @param path - 绝对路径或相对 workspace 根的路径；允许 workspace 之外的文件。
   * @param range - 行窗口；省略的字段取页默认值。
   * @param signal - 调用方取消。
   * @returns 页、其前一次 stat 时的文件版本，以及是否到达最后一行。
   */
  @Remote
  async read(
    workspaceFileScope: WorkspaceFileScope,
    path: string,
    range: WorkspaceFileRange,
    signal: AbortSignal,
  ): Promise<WorkspaceFileText> {
    const { offset, limit } = this.resolvePage(range)
    const { target, info } = await this.locateFile(workspaceFileScope, path, signal)
    const page = await this.cutPage(target, offset, limit, signal, path)
    if (page.text.includes(NUL)) {
      throw new RemoteError('workspace-file/not-text', `"${path}" contains NUL bytes`, { path })
    }
    return { ...this.statOf(target, info), offset, text: page.text, lines: page.lines, eof: page.eof }
  }

  /**
   * 不做文本解码地读取一个完整常规文件或一个字节范围。
   * @param workspaceFileScope - 由头派生的 workspace 根，对应 wire 上的 Session 身份。
   * @param path - 目标路径，绝对或 workspace 相对；提供基准文件时相对其所在目录。
   * @param options - 可选的基准文件与范围；不带范围时适用完整文件上限。
   * @param signal - 调用方取消。
   * @returns 原生字节，附带前一次 stat 时的文件版本与大小、字节偏移，以及 EOF 标记。
   */
  @Remote
  async readBytes(
    workspaceFileScope: WorkspaceFileScope,
    path: string,
    options: WorkspaceByteReadOptions,
    signal: AbortSignal,
  ): Promise<WorkspaceFileBytes> {
    const window = options.range === undefined ? undefined : this.resolveWindow(options.range, path)
    const resolved = options.baseFile === undefined ? path : await this.relativePath(workspaceFileScope, options.baseFile, path, signal)
    const { target, info } = await this.locateFile(workspaceFileScope, resolved, signal)
    if (window !== undefined) {
      const { offset, length } = window
      const data = await this.ctx.fs.readByteRange(target, window, signal)
      const eof = info.size === undefined ? data.length < length : offset + data.length >= info.size
      return { ...this.statOf(target, info), offset, data, eof }
    }
    const limit = this.config.maxFileBytes
    const data = await this.ctx.fs.readBytes(target, signal, limit).catch((cause: unknown) => {
      if (typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'FS_TOO_LARGE') {
        throw new RemoteError('workspace-file/too-large', `"${path}" exceeds the ${limit} byte full-file cap`, { path, limit }, { cause })
      }
      throw cause
    })
    return { ...this.statOf(target, info), offset: 0, data, eof: true }
  }

  /**
   * 报告一个常规文件的身份、版本与大小，不含其内容。
   * @param workspaceFileScope - 由头派生的 workspace 根，对应 wire 上的 Session 身份。
   * @param path - 绝对路径或相对 workspace 根的路径；允许 workspace 之外的文件。
   * @param signal - 调用方取消。
   * @returns 文件的绝对路径、当前版本与字节大小。
   */
  @Remote
  async stat(workspaceFileScope: WorkspaceFileScope, path: string, signal: AbortSignal): Promise<WorkspaceFileStat> {
    const { target, info } = await this.locateFile(workspaceFileScope, path, signal)
    return this.statOf(target, info)
  }

  /**
   * 列出 Session workspace 内一个目录的直接子项。
   * @param workspaceFileScope - 由头派生的 workspace 根，对应 wire 上的 Session 身份。
   * @param path - workspace 路径，绝对或相对 workspace 根。
   * @param signal - 调用方取消。
   * @returns 目录子项，按后端稳定的名称顺序，受条目上限约束。
   */
  @Remote
  async list(workspaceFileScope: WorkspaceFileScope, path: string, signal: AbortSignal): Promise<WorkspaceDirectoryListing> {
    const { root, workspaceRoot, entry } = await this.inspect(workspaceFileScope, path, signal)
    // 末端链接——Windows junction 或符号链接——通过其解析到的目录列出，
    // 与 `listDir` 为该条目报告的子项类型一致；`read` 对末端组件
    // 保留自己的不跟随门禁。
    if (entry.type !== 'directory' && entry.type !== 'symlink') {
      throw new RemoteError(
        'workspace-file/not-directory',
        `"${path}" is a ${entry.type}`,
        { path, kind: entry.type },
      )
    }
    const target = await this.confine(root, workspaceRoot, path, signal)
    if (entry.type === 'symlink') {
      const info = await this.ctx.fs.stat(target, signal)
      if (info?.type !== 'directory') {
        throw new RemoteError('workspace-file/not-directory', `"${path}" does not resolve to a directory`, { path, kind: 'symlink' })
      }
    }
    const children = await this.ctx.fs.listDir(target, signal)
    return {
      path: workspacePathOf(this.ctx.fs.fileUrl(root), this.ctx.fs.fileUrl(target)),
      entries: children.slice(0, this.config.maxEntries).map(directoryEntry),
      truncated: children.length > this.config.maxEntries,
    }
  }

  /**
   * 在 Session 的文件系统中 watch 一个文件或一个目录的直接条目。
   * 文件使用后端的读权限；目录保持 workspace 范围。
   * @param workspaceFileScope - 由头派生的 workspace 根，对应 wire 上的 Session 身份。
   * @param path - 目标路径；Host 判定其类型，并将目录限制在 workspace 内。
   * @param signal - 生成取消。
   * @returns 目标 watch 生效后先发 `ready`，随后对排队与实时的失效发送当前元数据。
   * @throws 当 watch 不可用或目录在 workspace 之外时抛出 RemoteError。
   */
  @Remote({ mode: 'stream' })
  changes(workspaceFileScope: WorkspaceFileScope, path: string, signal: AbortSignal): AsyncIterable<WorkspaceFileWatchFrame> {
    return this.feed.follow(workspaceFileScope.workspaceRoot, path, signal)
  }

  private async relativePath(scope: WorkspaceFileScope, baseFile: string, path: string, signal: AbortSignal): Promise<string> {
    const relative = path.replace(/\\/g, '/')
    if (relative.length === 0 || relative.startsWith('/') || /^[a-z][a-z\d+.-]*:/iu.test(relative) || relative.includes(NUL)) {
      throw new RemoteError('gateway/bad-request', 'path must be relative when baseFile is provided', {})
    }
    const { target } = await this.locateFile(scope, baseFile, signal)
    const absolute = this.ctx.fs.processPath(target)
    const paths = absolute.startsWith('/') ? posix : win32
    return paths.resolve(paths.dirname(absolute), relative)
  }

  /** 在此应用页默认值与上限，使请求绝不隐式携带它们。 */
  private resolvePage(range: WorkspaceFileRange): { offset: number; limit: number } {
    const offset = range.offset === undefined ? 1 : integerAtLeast(range.offset, 1, 'offset')
    const limit = range.limit === undefined ? this.config.maxLines : integerAtLeast(range.limit, 1, 'limit')
    if (limit > this.config.maxLines) {
      throw new RemoteError('gateway/bad-request', `limit must be at most ${this.config.maxLines}`, {})
    }
    return { offset, limit }
  }

  /** 应用字节窗口默认值与上限；超过上限的窗口被拒绝而非缩短。 */
  private resolveWindow(range: WorkspaceByteRange, path: string): { offset: number; length: number } {
    const offset = range.offset === undefined ? 0 : integerAtLeast(range.offset, 0, 'offset')
    const length = range.length === undefined ? this.config.maxBytes : integerAtLeast(range.length, 1, 'length')
    if (offset + length > Number.MAX_SAFE_INTEGER) {
      throw new RemoteError('gateway/bad-request', 'offset plus length must stay a safe integer', {})
    }
    if (length > this.config.maxBytes) {
      throw new RemoteError(
        'workspace-file/too-large',
        `${length} bytes of "${path}" exceed the ${this.config.maxBytes} byte cap`,
        { path, limit: this.config.maxBytes },
      )
    }
    return { offset, length }
  }
  /**
   * 在解析跟随最后组件之前先检查请求的路径本身。
   * 目录围栏由 `list` 单独检查。
   */
  private async inspect(
    workspaceFileScope: WorkspaceFileScope,
    path: string,
    signal: AbortSignal,
  ): Promise<{ root: FsTarget; workspaceRoot: string; entry: FsPathInfo }> {
    if (path.length === 0) throw new RemoteError('gateway/bad-request', 'path is required', {})
    const { workspaceRoot } = workspaceFileScope
    const root = await this.ctx.fs.resolve(workspaceRoot, { signal })
    // 在任何解析跟随它之前，先对路径本身设门禁。
    const entry = await this.ctx.fs.lstat(path, { cwd: workspaceRoot }, signal)
    if (entry === undefined) {
      throw new RemoteError('workspace-file/not-found', `no entry at "${path}"`, { path })
    }
    return { root, workspaceRoot, entry }
  }

  /** 解析已检查的路径，除非 workspace 包含它，否则拒绝。 */
  private async confine(root: FsTarget, workspaceRoot: string, path: string, signal: AbortSignal): Promise<FsTarget> {
    const target = await this.ctx.fs.resolve(path, { cwd: workspaceRoot, signal })
    if (!this.ctx.fs.contains(root, target)) {
      throw new RemoteError('workspace-file/outside-workspace', `"${path}" is outside the workspace`, { path })
    }
    return target
  }

  /**
   * 常规文件的全部门禁，以确定其版本与大小的一次 stat 收尾。
   * 该 stat 会复核 `lstat` 所见：文件可能在此期间消失或改变了类型。
   */
  private async locateFile(
    workspaceFileScope: WorkspaceFileScope,
    path: string,
    signal: AbortSignal,
  ): Promise<{ target: FsTarget; info: FsInfo }> {
    const { workspaceRoot, entry } = await this.inspect(workspaceFileScope, path, signal)
    if (entry.type !== 'file') {
      throw new RemoteError('workspace-file/not-regular-file', `"${path}" is a ${entry.type}`, { path, kind: entry.type })
    }
    const target = await this.ctx.fs.resolve(path, { cwd: workspaceRoot, signal })
    const info = await this.ctx.fs.stat(target, signal)
    if (info === undefined) {
      throw new RemoteError('workspace-file/not-found', `no entry at "${path}"`, { path })
    }
    if (info.type !== 'file') {
      throw new RemoteError('workspace-file/not-regular-file', `"${path}" is a ${info.type}`, { path, kind: info.type })
    }
    return { target, info }
  }

  private statOf(target: FsTarget, info: FsInfo): WorkspaceFileStat {
    return {
      absolutePath: this.ctx.fs.processPath(target),
      version: info.version,
      ...info.size === undefined ? {} : { bytes: info.size },
    }
  }

  /** 将文件以文本流式读取并截页，对后端的非文本拒绝做分类。 */
  private async cutPage(target: FsTarget, offset: number, limit: number, signal: AbortSignal, path: string): Promise<Page> {
    try {
      return await cutPage(await this.ctx.fs.streamText(target, signal), offset, limit, this.config.maxBytes, path)
    } catch (error: unknown) {
      if (isNotTextRefusal(error)) {
        throw new RemoteError('workspace-file/not-text', `"${path}" is not UTF-8 text`, { path }, { cause: error })
      }
      throw error
    }
  }
}

/**
 * 后端的非文本拒绝，仅凭其 code 识别：错误类属于提供方加载的
 * 某个 `dsh-fs` 实例，因此类标识不跨包共享。
 */
function isNotTextRefusal(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'FS_NOT_TEXT'
}

export default WorkspaceFiles
