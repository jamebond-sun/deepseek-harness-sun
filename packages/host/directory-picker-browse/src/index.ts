/**
 * 目录选择接缝的浏览后端：以 `browse` 能力注册 `ctx.directoryPicker`——通过 Node 标准库
 * （它已自带各操作系统的适配）在宿主文件系统上提供单层目录列表与子目录创建。宿主显示器
 * 上不渲染任何内容，因此本后端可服务于对话框后端触及不到的远程客户端。相关策略决定
 * （隐藏项仅做标记但仍返回、跟随符号链接、作用范围为整个文件系统）记录在 directory-picker
 * 接缝的 Agent Note 中。
 * @module @deepseek-ai/dsh-host-directory-picker-browse
 */

import { mkdir, opendir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, posix, resolve, win32 } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  DirectoryPicker, DirectoryPickerError,
} from '@deepseek-ai/dsh-host-directory-picker'
import type {
  DirectoryEntry, DirectoryListing, DirectoryPickerCapability,
} from '@deepseek-ai/dsh-host-directory-picker'

/**
 * 从文件系统根到 `target`（含）的祖先链——即列表的面包屑行，每一行都是可跳转的目标。
 */
function ancestryCrumbs(target: string): DirectoryEntry[] {
  const crumbs: DirectoryEntry[] = []
  let current = target
  for (;;) {
    const parent = dirname(current)
    // 根目录的 basename 为 ''——用其完整路径（'/'、'C:\'）作为根面包屑的标签。
    crumbs.unshift({ name: parent === current ? current : basename(current), path: current, hidden: false })
    if (parent === current) return crumbs
    current = parent
  }
}

/**
 * 当该路径无论进程状态如何都指向同一个固定的文件系统位置时为真：POSIX 上要求
 * POSIX 绝对路径；Windows 上仅接受带驱动器限定（`C:\…`）或完整 UNC（`\\server\share…`）
 * 形式。有根但无驱动器的形式（`\foo`、`/foo`）以及不完整的 UNC 前缀（`\\`、`\\server`）
 * 能通过 `isAbsolute`，却仍会相对进程的当前驱动器解析。
 * @param path - 候选路径。
 * @param platform - 替换 `process.platform`，便于确定性测试。
 * @returns 该路径在此平台上是否为完全限定路径。
 */
export function fullyQualified(path: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32'
    ? win32.isAbsolute(path) && /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/.test(path)
    : posix.isAbsolute(path)
}

/** 一个流式列表候选：只保留行所需的 dirent 事实，不保留其他内容。 */
export interface ListingCandidate {
  /** 该层内的基本名称。 */
  name: string
  /** dirent 指明是目录（无需探测）。 */
  isDirectory: boolean
  /** dirent 指明是符号链接（是否可进入需要一次 stat 探测）。 */
  isSymbolicLink: boolean
}

/**
 * 把一个流式候选插入按名称排序的有界窗口中，当窗口超过 `keep` 时淘汰名称最大的候选。
 * 因此无论目录有多少子项，处理任意大层级时的内存都保持 O(keep)。
 * @param window - 按名称升序的窗口，原地修改。
 * @param candidate - 待放入的流式候选。
 * @param keep - 窗口上限。
 * @returns 是否发生了淘汰（该层存在窗口之外的候选）。
 */
export function boundedInsert(window: ListingCandidate[], candidate: ListingCandidate, keep: number): boolean {
  // 窗口已满且名称不小于尾部：一次比较即可拒绝，因此超大层级中每个越过头部的候选都是
  // O(1)，而不需要扫描整个窗口（10 万个子项对 1,001 的窗口绝不能接近 10^8 次比较）。
  // oxlint-disable-next-line typescript/no-non-null-assertion -- 已满的窗口（length === keep >= 1）必有尾元素
  if (window.length === keep && candidate.name.localeCompare(window[window.length - 1]!.name) >= 0) return true
  // 二分插入使被保留的候选只需 O(log keep) 次比较。
  let lo = 0
  let hi = window.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    // oxlint-disable-next-line typescript/no-non-null-assertion -- 由循环条件保证有界
    if (candidate.name.localeCompare(window[mid]!.name) < 0) hi = mid
    else lo = mid + 1
  }
  window.splice(lo, 0, candidate)
  if (window.length <= keep) return false
  window.pop()
  return true
}

/**
 * 等待 `operation`，但一旦信号中止就以信号原因立即拒绝。Node 的文件系统读取不可撤销，
 * 因此该操作本身仍会针对调用方随后关闭的句柄继续运行——其迟到的结算在此被吞掉，从而
 * 被放弃的读取不会表现为未处理的拒绝。
 * @param operation - 进行中的文件系统步骤。
 * @param signal - 调用方生命周期；缺省表示普通 await。
 * @returns 操作的结果值。
 */
export function raceAbort<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return operation
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      operation.catch(() => {
        // 被放弃的读取：其句柄正由发起中止的调用方关闭，而中止原因已经承载了结果。
      })
      reject(asError(signal.reason))
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (reason: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(asError(reason))
      },
    )
  })
}

/** 把抛出的值转为 Error（线上/中止原因可以是任意值）。 */
function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason))
}

/* v8 ignore start -- 被放弃句柄的关闭失败没有消费方，而要造出这种失败需要在请求中途拆掉文件系统。 */
/** 吞掉其调用方已经离开的句柄的关闭失败。 */
function swallowCloseFailure(): void {}
/* v8 ignore stop */

/** 未知抛出值的消息文本。 */
function messageOf(error: unknown): string {
  /* v8 ignore next -- node:fs 以 Error 实例拒绝；String 分支只是为了满足 unknown 的收窄。 */
  return error instanceof Error ? error.message : String(error)
}

/**
 * 为一个 dirent 生成一行列表记录，跟随指向目录的符号链接；非目录以及断裂/循环的链接
 * 返回 null（静默跳过——浏览器只显示可进入的项，而断裂的链接无法进入）。
 */
async function directoryRow(
  parent: string, name: string, isDirectory: boolean, isSymbolicLink: boolean, signal: AbortSignal | undefined,
): Promise<DirectoryEntry | null> {
  const path = join(parent, name)
  let enterable = isDirectory
  if (!enterable && isSymbolicLink) {
    try {
      // 该探测同样与调用方竞争：指向停滞网络文件系统的符号链接目标不得让已离开的调用方
      // 的请求继续存活。
      enterable = (await raceAbort(stat(path), signal)).isDirectory()
    } catch {
      /* v8 ignore next 2 -- 在探测中途到达的中止需要一个停滞的 stat；list 中逐候选的检查覆盖了已结算的路径。 */
      if (signal?.aborted) throw asError(signal.reason)
      // 断裂或循环的符号链接：stat 即探测手段，失败意味着“不可进入”。
      return null
    }
  }
  if (!enterable) return null
  // POSIX 的隐藏约定；Windows 的隐藏属性不会由 dirent 暴露（已知限制）。是否显示隐藏行
  // 由客户端决定。
  return { name, path, hidden: name.startsWith('.') }
}

/** 已校验的插件配置。 */
export interface Config {
  /** 单层列表的完整结果上限；见 {@link BrowseDirectoryPicker.Config}。 */
  maxEntries: number
}

/** `ctx.directoryPicker` 的浏览实现（每个服务生命周期内能力对象保持稳定）。 */
export default class BrowseDirectoryPicker extends DirectoryPicker {
  /**
   * `maxEntries` 限制单次 `list` 调用可物化并放到线上的完整列表层级：最多这么多个子目录
   * 行（含隐藏行），被截断时以 `truncated` 标记。默认值沿用 GitHub Web 界面的做法，即
   * 目录列表在 1,000 项处截断。
   */
  static Config: z<Config> = z.object({
    maxEntries: z.natural().min(1).default(1000),
  })

  private readonly browseCapability: DirectoryPickerCapability = {
    kind: 'browse',
    list: (path, signal) => this.list(path, signal),
    createDirectory: (path, name) => this.createDirectory(path, name),
  }

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx)
  }

  /**
   * 浏览交互能力。
   * @returns 稳定的 `browse` 能力对象。
   */
  capability(): DirectoryPickerCapability {
    return this.browseCapability
  }

  private async list(path?: string, signal?: AbortSignal): Promise<DirectoryListing> {
    const home = homedir()
    // 接缝契约只接受完全限定路径；resolve() 会把相对或空的线上值静默地重定基到宿主进程
    // 的 cwd（对 Windows 上有根但无驱动器的形式，则是其当前驱动器）。
    if (path !== undefined && !fullyQualified(path)) {
      throw new DirectoryPickerError('directory-unreadable', path, `cannot list "${path}": not a fully qualified path`)
    }
    const target = resolve(path ?? home)
    // 以流式方式（opendir，一次一个 dirent）把该层读入一个最多 maxEntries + 1 个候选的
    // 按名称排序窗口：无论目录有多少子项，内存都保持有界；窗口保留按名称排序的头部，而
    // 多出的那一个槽位让窗口内的额外一行足以证明发生了截断。窗口内某个最终不可进入的
    // 候选（断裂的符号链接）不会从窗口外回补——一次淘汰已经把该层标记为截断，这仍是诚
    // 实的答案。
    const keep = this.config.maxEntries + 1
    const window: ListingCandidate[] = []
    let evicted = false
    try {
      // 每次文件系统 await 都与调用方的信号竞争：网络文件系统上停滞的 opendir/read 不得
      // 让已离开的调用方的扫描继续存活；即使该层为空，已中止的请求也必须拒绝。
      const opening = opendir(target)
      const level = await raceAbort(opening, signal).catch((error: unknown) => {
        // 在中止胜出之后，被放弃的 open 仍可能铸造出一个句柄；关闭它，使已离开的调用方
        // 不会泄漏一个描述符。（与 opendir 自身拒绝竞争失败时没有东西可关，而关闭自身的
        // 失败会被吞掉——请求已经返回，清理错误没有消费方。）
        void opening.then(dir => dir.close().catch(swallowCloseFailure), () => {
          // 已经拒绝：raceAbort 已将其抛出或吞掉。
        })
        throw error
      })
      try {
        for (;;) {
          const dirent = await raceAbort(level.read(), signal)
          if (dirent === null) break
          // 只有浏览器可进入的行才参与窗口竞争；dirent 直接给出“目录”，符号链接则需要
          // 后面的 stat 探测。
          if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue
          const candidate = { name: dirent.name, isDirectory: dirent.isDirectory(), isSymbolicLink: dirent.isSymbolicLink() }
          if (boundedInsert(window, candidate, keep)) evicted = true
        }
      } finally {
        // 手动 read() 永远不会自动关闭；每条退出路径都要关闭。中止退出时不得 await 它——
        // Node 会把 close 排在任何进行中的 read 之后，await 就会把已离开的调用方重新拴回
        // 中止本已逃脱的那个停滞上（被放弃读取的结算已由 raceAbort 吞掉）。
        const closing = level.close()
        /* v8 ignore next 3 -- 在 open 与 close 之间到达的中止需要一个停滞的 read；被放弃的关闭分支没有可观测结果。 */
        if (signal?.aborted) {
          closing.catch(swallowCloseFailure)
        } else {
          await closing
        }
      }
    } catch (error: unknown) {
      // 中止是调用方自己的原因，而不是目录不可读。
      signal?.throwIfAborted()
      throw new DirectoryPickerError('directory-unreadable', target, `cannot list ${target}: ${messageOf(error)}`)
    }
    const entries: DirectoryEntry[] = []
    let truncated = evicted
    for (const candidate of window) {
      // 在读取与探测之间离开的调用方会在下一次探测前停下（每次探测自身的 await 都在
      // directoryRow 内部参与竞争）。
      signal?.throwIfAborted()
      const row = await directoryRow(target, candidate.name, candidate.isDirectory, candidate.isSymbolicLink, signal)
      if (row === null) continue
      if (entries.length === this.config.maxEntries) {
        truncated = true
        break
      }
      entries.push(row)
    }
    return { path: target, home, crumbs: ancestryCrumbs(target), entries, truncated }
  }

  private async createDirectory(path: string, name: string): Promise<string> {
    // 与 list 相同的完全限定栅栏：绝不把父目录重定基到 cwd 或当前驱动器。
    if (!fullyQualified(path)) {
      throw new DirectoryPickerError('directory-create-failed', path, `cannot create under "${path}": not a fully qualified parent path`)
    }
    const parent = resolve(path)
    // 路径段校验由后端负责；Remote 控制器同样拒绝非法的线上输入，但直接的服务消费方
    // 也必须撞上同一道栅栏。
    if (name.trim() === '' || name === '.' || name === '..' || /[/\\]/.test(name)) {
      throw new DirectoryPickerError('directory-create-failed', join(parent, name), `"${name}" is not a single path segment`)
    }
    const target = join(parent, name)
    try {
      // 非递归：父目录就是浏览器正在展示的目录，因此父目录缺失是一个真实的失败，而不是
      // 需要凭空造出的一层。
      await mkdir(target)
      return target
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') {
        throw new DirectoryPickerError('directory-exists', target, `${target} already exists`)
      }
      throw new DirectoryPickerError('directory-create-failed', target, `cannot create ${target}: ${messageOf(error)}`)
    }
  }
}
