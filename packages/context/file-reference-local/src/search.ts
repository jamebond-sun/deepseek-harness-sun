/**
 * 面向 `@file` 补全的、宿主工作区发现。索引仅包含路径：
 * 所选值仍是普通提示文本，文件内容则留在面向模型的 `read` 工具之后。
 *
 * @module @deepseek-ai/dsh-file-reference-local/search
 */

import { lstat, readdir } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { FileReferenceCandidate } from '@deepseek-ai/dsh-file-reference'

export { activeAtToken, formatFileMention } from '@deepseek-ai/dsh-file-reference/grammar'

/** 针对一次查询渲染的、默认的最大文件与目录候选数。 */
export const DEFAULT_FILE_SEARCH_MAX_RESULTS = 20
/** 单个工作区搜索索引中保留的默认最大条目数。 */
export const DEFAULT_FILE_SEARCH_MAX_ENTRIES = 50_000
/**
 * 除非部署覆盖，否则遍历中省略的目录基名：版本控制与依赖存储，
 * 以及没有任何生态也用于源代码的构建产物名。生成文件带着生成它们的
 * 源代码基名，因此一棵未过滤的树既会双倍消耗条目预算，
 * 又会让 `dist/x.js` 与 `src/x.ts` 在每个查询中并列排名。
 *
 * 此处刻意不含 `lib`：Ruby gems 与许多 npm 包将其源代码放在那里，
 * 排除它会让 `@` 彻底且静默地错过那些源代码。构建到 `lib` 的工作区
 * 可通过 `excludedDirectories` 自行加入它。
 */
export const DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES = [
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  '.next',
  '.nuxt',
  '.turbo',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.gradle',
] as const

/** 单个工作区索引的已解析限制与排除项。 */
export interface FileSearchConfig {
  /** 针对一次查询返回的、排名后的最大候选数。 */
  maxResults: number
  /** 被索引的最大文件与目录数。 */
  maxEntries: number
  /** 永不被遍历或提供的目录基名。 */
  excludedDirectories: readonly string[]
}

interface IndexedPath extends FileReferenceCandidate {}

interface RankedPath {
  candidate: FileReferenceCandidate
  score: number
}

interface IndexGeneration {
  controller: AbortController
  promise: Promise<IndexedPath[]>
}

/** 一次已完成的遍历，以及它在开始时观察到的失效计数器。 */
interface SettledIndex {
  entries: IndexedPath[]
  startedAt: number
}

/**
 * 以单个代理工作目录为根、可取消且可复用的模糊索引。
 * 带目录作用域的查询列出实时状态；裸模糊查询共享同一次有界遍历。
 * 只有工作区的第一次查询会等待那次遍历——失效的索引会继续应答，
 * 而其替代索引则在光标之后于后台构建。
 */
export class WorkspaceFileSearch {
  private readonly excludedDirectories: ReadonlySet<string>
  private settled: SettledIndex | undefined
  private generation: IndexGeneration | undefined
  /** 单调递增的失效计数器；低于它的已结算索引即为陈旧。 */
  private invalidations = 0
  private disposed = false

  constructor(
    private readonly root: string,
    private readonly config: FileSearchConfig,
  ) {
    if (!Number.isSafeInteger(config.maxResults) || config.maxResults <= 0) {
      throw new Error('file search maxResults must be a positive safe integer')
    }
    if (!Number.isSafeInteger(config.maxEntries) || config.maxEntries <= 0) {
      throw new Error('file search maxEntries must be a positive safe integer')
    }
    if (config.excludedDirectories.some(name => name.length === 0 || name.includes('/') || name.includes('\\'))) {
      throw new Error('file search excludedDirectories entries must be non-empty directory basenames')
    }
    this.excludedDirectories = new Set(config.excludedDirectories)
  }

  /**
   * 为当前标记返回排名后的路径候选。
   * @param rawQuery - `@` 或 `@"` 之后的路径文本。
   * @param signal - 取消本次调用方的等待，但不会终止被更新查询共享的索引。
   * @returns 至多 `maxResults` 个确定性的候选。
   */
  async list(rawQuery: string, signal: AbortSignal): Promise<FileReferenceCandidate[]> {
    signal.throwIfAborted()
    if (this.disposed) return []
    const query = rawQuery.replaceAll('\\', '/')
    const slash = query.lastIndexOf('/')
    if (query === '' || slash >= 0) {
      const directory = slash < 0 ? '' : query.slice(0, slash + 1)
      const fragment = slash < 0 ? '' : query.slice(slash + 1)
      return this.listDirectory(directory, fragment, signal)
    }
    const indexed = await this.indexFor(signal)
    return rankCandidates(
      indexed.filter(candidate => visibleForGlobalQuery(candidate.path, query)),
      query,
      this.config.maxResults,
    )
  }

  /**
   * 将索引标记为陈旧，使后续的裸查询观察到一棵新的树。
   *
   * 陈旧的条目会被保留并继续应答：一次重建需要遍历整个工作区，
   * 而将其置于光标之前，正是每个工具结果都触发失效的调用方原本要付出的代价。
   */
  invalidate(): void {
    this.invalidations += 1
  }

  /** 中止遍历并使后续查询返回空候选。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.generation?.controller.abort(new Error('file search index disposed'))
    this.generation = undefined
    this.settled = undefined
  }

  /**
   * 一个裸模糊查询所排名的条目。只有工作区的第一次查询会等待一次遍历；
   * 此后陈旧的索引会立即应答，而其替代索引在后台构建。
   * @param signal - 取消本次调用方的等待，但不会终止共享的遍历。
   * @returns 索引路径，最多落后树一次失效。
   */
  private async indexFor(signal: AbortSignal): Promise<readonly IndexedPath[]> {
    const settled = this.settled
    if (settled === undefined) return waitForPromise(this.ensureIndex(), signal)
    if (settled.startedAt < this.invalidations) {
      void this.ensureIndex().catch(() => {
        // 后台刷新失败并非本次调用方的错误：陈旧的条目仍在应答，
        // 且 `settled.startedAt` 仍落后，因此下一次裸查询会发起一次新的尝试。
      })
    }
    return settled.entries
  }

  private ensureIndex(): Promise<IndexedPath[]> {
    if (this.generation !== undefined) return this.generation.promise
    const controller = new AbortController()
    const startedAt = this.invalidations
    const generation = {
      controller,
      promise: Promise.resolve([] as IndexedPath[]),
    } satisfies IndexGeneration
    generation.promise = this.scanWorkspace(controller.signal).then(
      (entries) => {
        /* v8 ignore next -- 处置会中止本次遍历，因此它走的是拒绝处理器；
         * 此守卫只覆盖在取消生效前一瞬完成最后一个目录的扫描，
         * 且绝不能把已处置索引的条目交还回去。 */
        if (this.disposed) return entries
        this.generation = undefined
        this.settled = { entries, startedAt }
        return entries
      },
      (error: unknown) => {
        /* v8 ignore next -- dispose 同步地清空 `generation`；此处仅防御一次意外的扫描失败 */
        if (this.generation === generation) this.generation = undefined
        throw error
      },
    )
    this.generation = generation
    return generation.promise
  }

  private async scanWorkspace(signal: AbortSignal): Promise<IndexedPath[]> {
    const indexed: IndexedPath[] = []
    const directories: { absolute: string; relative: string }[] = [{ absolute: this.root, relative: '' }]
    for (let cursor = 0; cursor < directories.length && indexed.length < this.config.maxEntries; cursor += 1) {
      signal.throwIfAborted()
      const directory = directories[cursor]
      /* v8 ignore next 3 -- cursor is bounded by this exact queue's length. */
      if (directory === undefined) {
        throw new Error('file search selected a missing directory')
      }
      // 根目录不是子树：一个不可读的支系只损失其自身的候选，
      // 但一个不可读的根目录意味着这次遍历什么也没学到。让它结算，
      // 会让一个空索引覆盖仍有效的条目，且没有失效可供重试。
      const entries = cursor === 0
        ? await readWorkspaceRoot(directory.absolute, signal)
        : await readDirectory(directory.absolute, signal)
      for (const entry of entries) {
        signal.throwIfAborted()
        const path = directory.relative === '' ? entry.name : `${directory.relative}/${entry.name}`
        if (entry.isDirectory()) {
          if (this.excludedDirectories.has(entry.name)) continue
          indexed.push({ path, kind: 'directory' })
          directories.push({ absolute: join(directory.absolute, entry.name), relative: path })
        } else if (entry.isFile()) {
          indexed.push({ path, kind: 'file' })
        }
        if (indexed.length >= this.config.maxEntries) break
      }
    }
    return indexed
  }

  private async listDirectory(
    displayDirectory: string,
    fragment: string,
    signal: AbortSignal,
  ): Promise<FileReferenceCandidate[]> {
    if (displayDirectory.split('/').some(segment => this.excludedDirectories.has(segment))) return []
    const absolute = await resolveDisplayDirectory(this.root, displayDirectory, signal)
    if (absolute === undefined) return []
    const entries = await readDirectory(absolute, signal)
    const candidates: FileReferenceCandidate[] = []
    for (const entry of entries) {
      if (entry.name.startsWith('.') && !fragment.startsWith('.')) continue
      if (entry.isDirectory()) {
        if (this.excludedDirectories.has(entry.name)) continue
        candidates.push({ path: `${displayDirectory}${entry.name}`, kind: 'directory' })
      } else if (entry.isFile()) {
        candidates.push({ path: `${displayDirectory}${entry.name}`, kind: 'file' })
      }
    }
    return rankCandidates(candidates, fragment, this.config.maxResults)
  }
}

async function resolveDisplayDirectory(
  root: string,
  displayDirectory: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const resolvedRoot = resolve(root)
  const absolute = resolve(resolvedRoot, displayDirectory === '' ? '.' : displayDirectory)
  const fromRoot = relative(resolvedRoot, absolute)
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) return undefined
  /* v8 ignore next -- 只有 Windows 才会产生跨卷的绝对相对路径 */
  if (isAbsolute(fromRoot)) return undefined
  let current = resolvedRoot
  for (const segment of fromRoot.split(sep).filter(Boolean)) {
    signal.throwIfAborted()
    current = join(current, segment)
    try {
      const status = await lstat(current)
      signal.throwIfAborted()
      if (status.isSymbolicLink() || !status.isDirectory()) return undefined
    } catch (_error: unknown) {
      signal.throwIfAborted()
      return undefined
    }
  }
  return absolute
}

async function readWorkspaceRoot(absolute: string, signal: AbortSignal) {
  signal.throwIfAborted()
  const entries = await readdir(absolute, { withFileTypes: true })
  signal.throwIfAborted()
  return entries.sort((left, right) => compareText(left.name, right.name))
}

async function readDirectory(absolute: string, signal: AbortSignal) {
  signal.throwIfAborted()
  try {
    const entries = await readdir(absolute, { withFileTypes: true })
    signal.throwIfAborted()
    return entries.sort((left, right) => compareText(left.name, right.name))
  } catch (_error: unknown) {
    /* v8 ignore start -- Windows chmod cannot make the unreadable-directory fixture fail readdir; POSIX behavior covers this fallback. */
    signal.throwIfAborted()
    // 一个不可读/缺失的子树不贡献任何候选；其他可读的支系仍有用，
    // 且自动补全仅为建议性质。
    return []
    /* v8 ignore stop */
  }
}

function visibleForGlobalQuery(path: string, query: string): boolean {
  if (query.startsWith('.') || query.includes('/.')) return true
  return !path.split('/').some(segment => segment.startsWith('.'))
}

function rankCandidates(
  candidates: readonly FileReferenceCandidate[],
  query: string,
  limit: number,
): FileReferenceCandidate[] {
  const ranked: RankedPath[] = []
  for (const candidate of candidates) {
    const score = scoreCandidate(candidate, query)
    if (score !== undefined) ranked.push({ candidate, score })
  }
  ranked.sort((left, right) =>
    right.score - left.score
    || kindRank(left.candidate.kind) - kindRank(right.candidate.kind)
    || (query === '' ? 0 : left.candidate.path.length - right.candidate.path.length)
    || compareText(left.candidate.path, right.candidate.path))
  return ranked.slice(0, limit).map(entry => entry.candidate)
}

function scoreCandidate(candidate: FileReferenceCandidate, query: string): number | undefined {
  if (query === '') return 0
  const path = candidate.path.toLowerCase()
  const name = path.slice(path.lastIndexOf('/') + 1)
  const needle = query.toLowerCase()
  const directoryBonus = candidate.kind === 'directory' ? 25 : 0
  if (name === needle) return 1_000 + directoryBonus
  if (name.startsWith(needle)) return 900 + directoryBonus
  if (name.includes(needle)) return 700 + directoryBonus
  if (path.includes(needle)) return 500 + directoryBonus
  const subsequence = subsequenceScore(path, needle)
  return subsequence === undefined ? undefined : 300 + subsequence + directoryBonus
}

function subsequenceScore(target: string, query: string): number | undefined {
  let targetIndex = 0
  let gap = 0
  for (const character of query) {
    const found = target.indexOf(character, targetIndex)
    if (found < 0) return undefined
    gap += found - targetIndex
    targetIndex = found + 1
  }
  return Math.max(0, 100 - gap)
}

function kindRank(kind: FileReferenceCandidate['kind']): number {
  return kind === 'directory' ? 0 : 1
}

function compareText(left: string, right: string): number {
  /* v8 ignore next -- 条目与候选是唯一的；具体比较方向由宿主枚举顺序决定。 */
  return left < right ? -1 : left > right ? 1 : 0
}

function waitForPromise<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  /* v8 ignore next -- `list()` 在同步调用本辅助函数之前立即检查了该信号 */
  if (signal.aborted) return Promise.reject(errorReason(signal.reason, 'file search aborted'))
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const onAbort = (): void => { rejectPromise(errorReason(signal.reason, 'file search aborted')) }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolvePromise(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        rejectPromise(errorReason(error, 'file search index failed'))
      },
    )
  })
}

function errorReason(reason: unknown, fallback: string): Error {
  return reason instanceof Error ? reason : new Error(fallback, { cause: reason })
}
