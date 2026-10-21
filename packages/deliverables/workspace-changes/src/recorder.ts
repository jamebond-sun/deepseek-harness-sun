/** 每个 Session 的回合记录器：快照、文件工具编辑周围的捕获、回合结束差异，以及保留至释放的记录。 */
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { captureFile, sameCapture, type Capture } from './capture.ts'
import { compareText } from './compare.ts'
import {
  blobText, diffTrees, gitlinkPaths, ignoredPaths, locateGitWorkspace, snapshotTree, treeBlob, type GitRunner, type GitWorkspace,
} from './git.ts'
import { canonicalPath, compareDisplay, displayPathOf, durablePathOf, isInside, isTemporaryPath, temporaryRoots, toPosix } from './paths.ts'
import type { WorkspaceChangedFile, WorkspaceChangesSummary, WorkspaceFileDiff } from './types.ts'

/** 一个插件实例的所有记录器所共享的事实。 */
export interface RecorderEnvironment {
  /** 解析为运行器；当 git 不可用、且不拍摄快照时为 null。 */
  git: Promise<GitRunner | null>
  /** 接收每个 Session 临时目录的目录。 */
  tempRoot: string
  /** 一个摘要所携带的最大文件数。 */
  maxFiles: number
  /** 已捕获副本与为比较而读取的快照 blob 的、含上限的字节数。 */
  maxFileBytes: number
  /** 行比较在退化为整文件替换之前可运行的毫秒数。 */
  diffTimeoutMs: number
  /** 失败报告器；失败的回合不记录任何内容，下一个回合重试。 */
  warn: (message: string) => void
}

/** 每次比较与显示所使用的规范路径，每个 Session 解析一次。 */
interface Paths {
  /** 用于仓库发现与显示路径的、规范的原始项目目录。 */
  cwd: string
  /** 在显示路径中被缩写为 `~` 的规范 home 目录。 */
  home: string
  /** 其位于工作区之外的文件永不进入摘要的临时根。 */
  temporaryRoots: readonly string[]
}

/** 包围工作目录的仓库，以及为其拍摄快照的运行器。 */
interface Repository {
  git: GitRunner
  workspace: GitWorkspace
}

/** 一个已定位仓库的回合开始快照。 */
interface Baseline extends Repository { tree: string }

/** 一个被列出文件内容的、可读一侧所在之处。 */
type ContentSource =
  /** 快照树中的一条路径；缺失、大小与文本在需要时才从 git 读取。 */
  | { kind: 'snapshot'; repository: Repository; tree: string; path: string }
  | Exclude<Capture, { kind: 'oversized' }>

/**
 * 一个被列出文件的比较由何提供：在回合被记录时决定的拒绝，
 * 或在需要时才读取并比较的两侧。
 */
type FileSources =
  | { refusal: 'binary' | 'oversized' }
  | { refusal?: undefined; before: ContentSource; after: ContentSource }

/** 一份已提供的摘要，带有其被列出文件的内容来源，与 `summary.files` 索引对齐。 */
interface TurnRecord {
  summary: WorkspaceChangesSummary
  sources: FileSources[]
}

/** 一个回合所累积的一切；新回合获得新对象，从而为较早回合排队的任务保留其自身。 */
interface TurnState {
  readonly turn: number
  /**
   * 一旦存在的回合开始快照。`null` 表示没有仓库或没有 git，因此该回合仅汇总文件工具
   * 捕获；`'failed'` 表示仓库存在但其快照失败，因此该回合不记录任何内容。
   */
  baseline: Baseline | null | 'failed'
  /** 每个被文件工具变更的路径、在回合首次变更它之前的内容，按规范绝对路径索引。 */
  readonly captures: Map<string, Capture>
  lastToolResultSeq: number
  /** 最近一次记录尝试开始时的日志长度；`end()` 会跳过在最后一次工具结果之后已尝试过的回合。 */
  attemptedAfterSeq: number
  /** 最近一次追加事件的序列号，或 -1。 */
  recordedAfterSeq: number
}

function freshState(turn: number): TurnState {
  return { turn, baseline: null, captures: new Map(), lastToolResultSeq: -1, attemptedAfterSeq: -1, recordedAfterSeq: -1 }
}

/** 一个带有其两侧来源的、被列出的文件。 */
interface Listed { file: WorkspaceChangedFile; sources: FileSources }

/** 大于字节上限的快照侧。 */
const OVERSIZED = Symbol('oversized')

/**
 * 序列化一个 Session 的记录工作：回合开始快照、每次文件工具
 * 变更之前的整文件捕获、带差异的回合结束快照，以及本记录器所保留其
 * 摘要与比较的、被追加的 `workspace/changes` 事件。快照对象与捕获副本
 * 存于记录器拥有的临时目录中；释放会将该目录连同摘要一并移除。工具执行
 * 等待待处理工作，从而快照或捕获永远不会与变更竞争。位于任何仓库之外的工作目录，
 * 或没有 git 的 Host，不会获得快照；其摘要列出文件工具所更改的文件。
 */
export class TurnRecorder {
  private chain: Promise<void> = Promise.resolve()
  /** 开放的回合；在第一次 `turn/start` 之前，它是一个没有任何事件能匹配的空占位符。 */
  private state = freshState(0)
  /** 由第一个回合解析出的规范路径。 */
  private paths: Paths | undefined
  /** 已定位的仓库，一旦找到便跨回合复用；null 表示每个回合持续重试。 */
  private repository: Repository | null = null
  /** 持有本 Session 的快照对象、临时索引与捕获副本的临时目录。 */
  private scratch: Promise<string> | undefined
  /** 按宣布它们的事件的序列号索引的记录。 */
  private readonly records = new Map<number, TurnRecord>()
  private readonly lifetime = new AbortController()

  constructor(
    private readonly session: Session,
    private readonly cwd: string,
    private readonly env: RecorderEnvironment,
  ) {}

  /**
   * 以全新的每回合状态开启一个回合，并将其基线快照排入队列。
   * @param turn - 来自 `turn/start` 的回合号。
   */
  start(turn: number): void {
    const state = freshState(turn)
    this.state = state
    void this.enqueue(async (signal) => {
      try {
        this.paths ??= { cwd: await realpath(this.cwd), home: await canonicalPath(homedir()), temporaryRoots: await temporaryRoots() }
        const repository = await this.locate(this.paths.cwd, signal)
        if (repository === null) return
        const tree = await snapshotTree(repository.git, repository.workspace, signal)
        state.baseline = { ...repository, tree }
      } catch (error: unknown) {
        // 快照失败的仓库绝不能被当作没有任何仓库那样去汇总。
        state.baseline = 'failed'
        throw error
      }
    })
  }

  /**
   * 在工具运行之前，将文件工具即将变更的路径的捕获排入队列；
   * 只有回合首次变更某路径时才会捕获它。之后须等待
   * {@link settled}，从而工具无法抢在捕获之前。
   * @param path - 文件系统提供方已解析的变更目标的绝对进程路径。
   */
  capture(path: string): void {
    const state = this.state
    void this.enqueue(async () => {
      const paths = this.paths
      if (paths === undefined) return
      const absolute = await canonicalPath(path)
      if (state.captures.has(absolute)) return
      const capture = await captureFile(absolute, join(await this.scratchDir(), 'captures'), this.env.maxFileBytes)
      if (capture !== undefined) state.captures.set(absolute, capture)
    })
  }

  /**
   * 记住一个已落定的工具结果，从而 `turn/end` 之后的记录能覆盖它。
   * @param event - 被追加的 `tool/result` 事件。
   */
  observe(event: SessionEvent<'tool/result'>): void {
    const state = this.state
    if (event.data.turn === state.turn) state.lastToolResultSeq = event.seq
  }

  /**
   * 在回合内部、`turn/end` 提交之前记录该回合的变更。
   * @param turn - 正在停止的回合。
   * @returns 在事件被追加或尝试失败之后。
   */
  stopping(turn: number): Promise<void> {
    const state = this.state
    if (turn !== state.turn) return Promise.resolve()
    return this.enqueue(signal => this.record(state, signal))
  }

  /**
   * 在 `turn/end` 之后记录，除非在回合最后一次工具结果之后已经尝试过记录。
   * @param turn - 来自 `turn/end` 的回合号。
   */
  end(turn: number): void {
    const state = this.state
    if (turn !== state.turn || state.attemptedAfterSeq >= state.lastToolResultSeq) return
    void this.enqueue(signal => this.record(state, signal))
  }

  /** 一旦每个排队的快照、捕获与记录都已落定即解析。 */
  settled(): Promise<void> {
    return this.chain
  }

  /**
   * 本 Session 的一次 `workspace/changes` 事件所宣布的摘要。
   * @param seq - 该事件的序列号。
   * @returns 摘要；对本记录器未宣布的序列号则为 undefined。
   */
  summary(seq: number): WorkspaceChangesSummary | undefined {
    return this.records.get(seq)?.summary
  }

  /**
   * 比较一个被列出文件在回合开始与回合结束时的内容。
   * @param seq - 宣布事件的序列号。
   * @param index - 该文件在摘要 `files` 中的索引。
   * @param signal - 取消读取的信号。
   * @returns 比较结果；对未知的序列号或索引，或在释放之后，则为 undefined。
   * @throws 当记录器存活期间读取失败时抛出。
   */
  async diff(seq: number, index: number, signal: AbortSignal): Promise<WorkspaceFileDiff | undefined> {
    const record = this.records.get(seq)
    const file = record?.summary.files[index]
    const sources = record?.sources[index]
    if (file === undefined || sources === undefined) return undefined
    const { path, display } = file
    if (sources.refusal !== undefined) return { kind: sources.refusal, path, display }
    const combined = AbortSignal.any([signal, this.lifetime.signal])
    try {
      const [before, after] = await Promise.all([this.readSide(sources.before, combined), this.readSide(sources.after, combined)])
      if (before === OVERSIZED || after === OVERSIZED) return { kind: 'oversized', path, display }
      const { hunks, coarse } = compareText(before, after, this.env.diffTimeoutMs)
      return { kind: 'text', path, display, before: before !== null, after: after !== null, hunks, coarse }
    } catch (error: unknown) {
      // 释放会在一次正在进行的读取之下移除临时目录；无论如何 Session 都已不复存在。
      if (this.lifetime.signal.aborted) return undefined
      throw error
    }
  }

  /**
   * 中止排队的工作，忘掉每条记录，并移除临时目录。
   * @returns 一旦临时目录被移除。
   */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    this.records.clear()
    await this.chain
    if (this.scratch !== undefined) await rm(await this.scratch, { recursive: true, force: true })
  }

  private enqueue(task: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const run = this.chain.then(async () => {
      if (this.lifetime.signal.aborted) return
      try {
        await task(this.lifetime.signal)
      } catch (error: unknown) {
        this.warnUnlessDisposed(error)
      }
    })
    this.chain = run
    return run
  }

  /** 释放之后的失败属于预期的取消，保持沉默。 */
  private warnUnlessDisposed(error: unknown): void {
    if (!this.lifetime.signal.aborted) this.env.warn(`workspace-changes: ${String(error)}`)
  }

  /** 本 Session 的临时目录，首次使用时创建。 */
  private scratchDir(): Promise<string> {
    this.scratch ??= mkdtemp(join(this.env.tempRoot, 'dsh-workspace-changes-'))
    return this.scratch
  }

  /** 包围工作目录的仓库，定位一次；null 表示每个回合持续重试。 */
  private async locate(cwd: string, signal: AbortSignal): Promise<Repository | null> {
    if (this.repository !== null) return this.repository
    const git = await this.env.git
    if (git === null) return null
    const workspace = await locateGitWorkspace(git, cwd, () => this.scratchDir(), signal)
    if (workspace === null) return null
    this.repository = { git, workspace }
    return this.repository
  }

  /** 一侧的文本；缺失的文件为 null，超过字节上限的快照侧为 {@link OVERSIZED}。 */
  private async readSide(source: ContentSource, signal: AbortSignal): Promise<string | null | typeof OVERSIZED> {
    switch (source.kind) {
      case 'absent': return null
      case 'file': return readFile(source.file, { encoding: 'utf8', signal })
      case 'snapshot': {
        const { git, workspace } = source.repository
        const blob = await treeBlob(git, workspace, source.tree, source.path, signal)
        if (blob === null) return null
        if (blob.size > this.env.maxFileBytes) return OVERSIZED
        return blobText(git, workspace, blob.oid, this.env.maxFileBytes, signal)
      }
    }
  }

  private async record(state: TurnState, signal: AbortSignal): Promise<void> {
    const paths = this.paths
    const { baseline } = state
    if (paths === undefined || baseline === 'failed' || state.lastToolResultSeq < 0) return
    state.attemptedAfterSeq = state.lastToolResultSeq
    // 没有快照时，工作目录本身界定工作区。
    const root = baseline?.workspace.root ?? paths.cwd
    const listed = new Map<string, Listed>()
    let snapshot: WorkspaceChangesSummary['snapshot']
    if (baseline !== null) {
      const after = await snapshotTree(baseline.git, baseline.workspace, signal)
      snapshot = { before: baseline.tree, after }
      const repository: Repository = { git: baseline.git, workspace: baseline.workspace }
      for (const entry of await diffTrees(baseline.git, baseline.workspace, baseline.tree, after, signal)) {
        const absolute = resolve(root, entry.path)
        listed.set(absolute, {
          file: changedFile(paths, root, absolute, entry),
          sources: entry.binary ? { refusal: 'binary' } : {
            before: { kind: 'snapshot', repository, tree: baseline.tree, path: entry.oldPath ?? entry.path },
            after: { kind: 'snapshot', repository, tree: after, path: entry.path },
          },
        })
      }
    }
    // 快照未覆盖的捕获路径，从它们的副本进行比较。
    const captured = [...state.captures.keys()].filter(absolute => !listed.has(absolute))
    const workTreePath = (absolute: string): string => toPosix(relative(root, absolute))
    let inWorkspace = captured.filter(absolute => isInside(root, absolute))
    if (baseline !== null && inWorkspace.length > 0) {
      // 嵌套仓库与子模块是 gitlink：其内容永不进入摘要。
      const gitlinks = await gitlinkPaths(baseline.git, baseline.workspace, signal)
      inWorkspace = inWorkspace.filter(absolute => ![...gitlinks].some(link => isInside(resolve(root, link), absolute)))
    }
    // 快照覆盖除被忽略者之外的每个工作区文件；没有快照时，每次文件工具编辑都计入。
    const uncoveredInWorkspace = baseline === null
      ? new Set(inWorkspace.map(workTreePath))
      : await ignoredPaths(baseline.git, baseline.workspace, inWorkspace.map(workTreePath), signal)
    for (const absolute of captured) {
      // 在工作区之外，临时根之下的临时文件保持在外。
      const uncovered = isInside(root, absolute)
        ? uncoveredInWorkspace.has(workTreePath(absolute))
        : !isTemporaryPath(absolute, paths.temporaryRoots)
      if (!uncovered) continue
      const before = state.captures.get(absolute) as Capture
      const after = await captureFile(absolute, join(await this.scratchDir(), 'captures'), this.env.maxFileBytes)
      if (after === undefined || sameCapture(before, after)) continue
      listed.set(absolute, await this.compared(paths, root, absolute, before, after))
    }
    const sorted = [...listed.values()].sort((a, b) => compareDisplay(a.file, b.file))
    // 在一次较早的回合内记录之后的空列表，会取代那条记录。
    if (sorted.length === 0 && state.recordedAfterSeq < 0) return
    const event = this.session.append('workspace/changes', { turn: state.turn })
    const kept = sorted.slice(0, this.env.maxFiles)
    this.records.set(event.seq, {
      summary: {
        turn: state.turn,
        cwd: this.cwd,
        files: kept.map(entry => entry.file),
        total: sorted.length,
        added: sorted.reduce((sum, entry) => sum + entry.file.added, 0),
        deleted: sorted.reduce((sum, entry) => sum + entry.file.deleted, 0),
        ...snapshot === undefined ? {} : { snapshot },
      },
      sources: kept.map(entry => entry.sources),
    })
    state.recordedAfterSeq = event.seq
  }

  /**
   * 一个捕获对的列出：超大的那一侧列文件而无计数、并拒绝其比较，
   * 二进制侧同理，而两个文本侧携带它们行比较的计数。
   */
  private async compared(paths: Paths, root: string, absolute: string, before: Capture, after: Capture): Promise<Listed> {
    const list = (counts: Counts, sources: FileSources): Listed => ({ file: changedFile(paths, root, absolute, counts), sources })
    if (before.kind === 'oversized' || after.kind === 'oversized') {
      return list({ added: 0, deleted: 0, binary: false, oversized: true }, { refusal: 'oversized' })
    }
    if (isBinary(before) || isBinary(after)) return list({ added: 0, deleted: 0, binary: true }, { refusal: 'binary' })
    const text = async (side: typeof before): Promise<string | null> => side.kind === 'file' ? readFile(side.file, 'utf8') : null
    const { added, deleted } = compareText(await text(before), await text(after), this.env.diffTimeoutMs)
    return list({ added, deleted, binary: false }, { before, after })
  }
}

/** 一个被捕获的侧是否持有二进制内容。 */
function isBinary(capture: Capture): boolean {
  return capture.kind === 'file' && capture.binary
}

interface Counts { added: number; deleted: number; binary: boolean; oversized?: boolean }

function changedFile({ cwd, home }: Paths, root: string, absolute: string, counts: Counts): WorkspaceChangedFile {
  return {
    path: durablePathOf(absolute, cwd),
    display: displayPathOf(absolute, cwd, root, home),
    added: counts.added,
    deleted: counts.deleted,
    ...counts.binary ? { binary: true as const } : {},
    ...counts.oversized === true ? { oversized: true as const } : {},
  }
}
