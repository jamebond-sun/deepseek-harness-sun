/** 通过子进程能力实现的 git 工作树快照、树差异与忽略检查。 */
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { parseNumstat, type NumstatEntry } from './numstat.ts'
import { canonicalPath, isInside, toPosix } from './paths.ts'

/** git 子进程在终止开始之后获准退出的毫秒数；一个固定的生命周期常量。 */
const TERMINATE_GRACE_MS = 2_000
/** 为诊断而保留的 stderr 尾部。 */
const STDERR_TAIL_BYTES = 16 * 1024

/** 已落定的 git 命令事实；非零退出码是一种结果，而非异常。 */
export interface GitRunResult {
  exitCode: number | null
  stdout: string
  stderr: string
  /** 当 stdout 超过输出上限并丢失了头部时为真。 */
  truncated: boolean
}

/** 每次命令的生成事实。 */
export interface GitRunOptions {
  cwd: string
  env?: Readonly<Record<string, string>> | undefined
  stdin?: string | undefined
  /** 此命令的内存 stdout 上限，取代运行器的 `outputMaxBytes`。 */
  maxBytes?: number | undefined
  signal: AbortSignal
}

/** 每条 git 命令运行所遵守的边界。 */
export interface GitLimits {
  /** 命令被终止之前的毫秒数。 */
  timeoutMs: number
  /** 内存 stdout 上限（以字节计）。 */
  outputMaxBytes: number
}

/** 运行一个已解析的 git 可执行文件，带有清洗后的环境、超时与受限输出。 */
export class GitRunner {
  constructor(
    private readonly subprocess: SubprocessRuntime,
    private readonly executable: string,
    private readonly limits: GitLimits,
  ) {}

  /**
   * 完整运行 `git <args>`。
   * @param args - git 参数；永不被 shell 解释。
   * @param options - 工作目录、额外环境、stdin 数据与取消信号。
   * @returns 退出事实与收集到的输出。
   * @throws 当命令超时、被中止，或无法生成时抛出。
   */
  async run(args: readonly string[], options: GitRunOptions): Promise<GitRunResult> {
    const timeout = AbortSignal.timeout(this.limits.timeoutMs)
    const signal = AbortSignal.any([options.signal, timeout])
    const handle = this.subprocess.spawn({
      argv: [this.executable, ...args],
      cwd: options.cwd,
      stdio: {
        stdin: options.stdin === undefined ? 'ignore' : { data: options.stdin },
        stdout: { maxBytes: options.maxBytes ?? this.limits.outputMaxBytes },
        stderr: { maxBytes: STDERR_TAIL_BYTES },
      },
      graceMs: TERMINATE_GRACE_MS,
      signal,
      // 子进程的凭据清洗会移除环境里的 GIT_CONFIG_KEY_n 条目。
      env: { GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', ...options.env },
    })
    const outcome = await handle.done
    if (signal.aborted) {
      throw new Error(`git ${args.join(' ')} ${timeout.aborted ? `timed out after ${this.limits.timeoutMs}ms` : 'was aborted'}`)
    }
    /* v8 ignore start -- 收集模式的 stdio 总是产出两个读取器。 */
    const stdout = handle.collected.stdout?.readFrom(0) ?? { text: '', lossy: false }
    const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
    /* v8 ignore stop */
    return { exitCode: outcome.exitCode, stdout: stdout.text, stderr, truncated: stdout.lossy }
  }
}

/**
 * 以命令的 stderr 拒绝一次失败的执行。
 * @param result - 已落定的命令事实。
 * @param what - 用于错误消息的命令描述。
 * @returns 当退出码为 0 时返回同一结果。
 */
function ok(result: GitRunResult, what: string): GitRunResult {
  if (result.exitCode !== 0) throw new Error(`${what} failed: ${result.stderr.trim()}`)
  return result
}

/** 包围一个 Session 工作目录的仓库，及其快照所写入的私有目录。 */
export interface GitWorkspace {
  /** 仓库顶层目录，每个差异路径都相对于它。 */
  root: string
  /** 持有仓库索引的绝对 git 目录。 */
  gitDir: string
  /** 持有快照对象存储与每个快照的临时索引的私有目录。 */
  scratch: string
  /** 将对象写入路由到私有存储、并将对象读取透过仓库存储进行的环境。 */
  env: Readonly<Record<string, string>>
  /** 快照必须跳过的、工作树中的路径：当临时根位于工作树之内时，即私有目录。 */
  excludes: readonly string[]
}

/** 一个文件系统错误是否指向缺失的路径。 */
function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

/**
 * 定位包围工作目录的仓库，并准备其快照所写入的私有
 * 目录。仓库自身的对象存储被以只读方式作为备用附加，从而快照从
 * 它读取已提交内容，而不向其中写入任何内容。位于工作树
 * 之内的私有目录（如同工作区下的临时根那样）会在每次快照中被排除。
 * 位于任何仓库之外的目录返回 null；其它任何 git 失败都会抛出。
 * @param git - 命令运行器。
 * @param cwd - 绝对的 Session 工作目录。
 * @param scratch - 产出快照对象与临时索引所用的私有目录；仅对定位到的仓库调用。
 * @param signal - 取消信号。
 * @returns 仓库；当目录不在任何仓库内时为 null。
 */
export async function locateGitWorkspace(
  git: GitRunner, cwd: string, scratch: () => Promise<string>, signal: AbortSignal,
): Promise<GitWorkspace | null> {
  const found = await git.run(['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-path', 'objects'], { cwd, signal })
  if (found.exitCode === 128 && /not a git repository/i.test(found.stderr)) return null
  const lines = ok(found, 'git rev-parse').stdout.split('\n').map(line => resolve(cwd, line))
  const [root, gitDir, repositoryObjects] = lines as [string, string, string]
  // git 报告规范根目录；以相同的拼写比较私有目录。
  const directory = await canonicalPath(await scratch())
  const objects = join(directory, 'objects')
  await mkdir(objects, { recursive: true })
  const excludes = isInside(root, directory) ? [toPosix(relative(root, directory))] : []
  const env = { GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: repositoryObjects }
  return { root, gitDir, scratch: directory, env, excludes }
}

/**
 * 将完整的工作树（包含未跟踪与已修改的文件，但不包含被忽略的文件）
 * 作为一个树对象写入，通过一个由仓库索引播种的私有索引。新的 blob 与树
 * 落在私有对象存储中；仓库的索引、对象存储、工作树与引用保持
 * 不变，且进行中的合并保留其未合并条目。
 * @param git - 命令运行器。
 * @param workspace - 被寻址的仓库。
 * @param signal - 取消信号。
 * @returns 树对象 id。
 */
export async function snapshotTree(git: GitRunner, workspace: GitWorkspace, signal: AbortSignal): Promise<string> {
  const scratch = await mkdtemp(join(workspace.scratch, 'index-'))
  try {
    const index = join(scratch, 'index')
    // 尚未拥有索引的仓库（全新的 `git init`）从零开始。
    await copyFile(join(workspace.gitDir, 'index'), index).catch((error: unknown) => {
      if (!isMissing(error)) throw error
    })
    const env = { ...workspace.env, GIT_INDEX_FILE: index }
    // `--ignore-errors` 会跳过不可读的文件，并通过退出码 1 报告它们；索引仍然是完整的。
    const pathspec = workspace.excludes.length === 0 ? [] : ['--', '.', ...workspace.excludes.map(path => `:(exclude)${path}`)]
    const added = await git.run(['add', '--all', '--ignore-errors', ...pathspec], { cwd: workspace.root, env, signal })
    /* v8 ignore next -- git 仅在权限可被测试撤销的宿主上才会报告被跳过的不可读文件。 */
    if (added.exitCode !== 1) ok(added, `git add in ${workspace.root}`)
    return ok(await git.run(['write-tree'], { cwd: workspace.root, env, signal }), 'git write-tree').stdout.trim()
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/** 一个快照树在某一路径处持有的 blob。 */
export interface TreeBlob {
  oid: string
  /** 对象大小（以字节计）。 */
  size: number
}

/**
 * 一个快照树在某一路径处持有的 blob。
 * @param git - 命令运行器。
 * @param workspace - 被寻址的仓库。
 * @param tree - 快照树 id。
 * @param path - 相对于仓库根的、以斜杠分隔的路径。
 * @param signal - 取消信号。
 * @returns blob；当树在该路径处没有任何内容、或持有 gitlink 或树时，为 null。
 */
export async function treeBlob(
  git: GitRunner, workspace: GitWorkspace, tree: string, path: string, signal: AbortSignal,
): Promise<TreeBlob | null> {
  // 该路径是一个 pathspec；字面匹配可避免文件名中的 `*`、`?` 与 `[` 选中其它条目。
  const result = ok(await git.run(['ls-tree', '-z', '-l', tree, '--', path], {
    cwd: workspace.root, env: { ...workspace.env, GIT_LITERAL_PATHSPECS: '1' }, signal,
  }), 'git ls-tree')
  const entry = result.stdout.split('\0')[0] as string
  const match = /^\d+ (\S+) ([0-9a-f]+) +(\d+)\t/.exec(entry)
  if (match === null || match[1] !== 'blob') return null
  return { oid: match[2] as string, size: Number(match[3]) }
}

/**
 * 一个 blob 的文本，其大小已由 {@link treeBlob} 报告在上限之内。
 * @param git - 命令运行器。
 * @param workspace - 被寻址的仓库。
 * @param oid - blob id。
 * @param maxBytes - 调用方据以检查 blob 大小的、含上限的字节数。
 * @param signal - 取消信号。
 * @returns 以 UTF-8 解码的 blob。
 */
export async function blobText(
  git: GitRunner, workspace: GitWorkspace, oid: string, maxBytes: number, signal: AbortSignal,
): Promise<string> {
  const result = ok(await git.run(['cat-file', 'blob', oid], { cwd: workspace.root, env: workspace.env, maxBytes, signal }), 'git cat-file')
  /* v8 ignore next -- 调用方先用 treeBlob 量取 blob 大小；blob 不可变，因此上限在此不可能被超过。 */
  if (result.truncated) throw new Error(`blob ${oid} exceeds ${maxBytes} bytes`)
  return result.stdout
}

/**
 * 两棵快照树之间、逐文件的行数，并检测重命名。
 * @param git - 命令运行器。
 * @param workspace - 被寻址的仓库。
 * @param before - 回合开始的树 id。
 * @param after - 回合结束的树 id。
 * @param signal - 取消信号。
 * @returns 相对于仓库根的被更改文件。
 * @throws 当 git 失败或输出超过上限时抛出。
 */
export async function diffTrees(
  git: GitRunner, workspace: GitWorkspace, before: string, after: string, signal: AbortSignal,
): Promise<NumstatEntry[]> {
  if (before === after) return []
  const result = ok(await git.run(['diff-tree', '-r', '-M', '-z', '--numstat', before, after], {
    cwd: workspace.root, env: workspace.env, signal,
  }), 'git diff-tree')
  if (result.truncated) throw new Error('git diff-tree output exceeded the configured cap')
  return parseNumstat(result.stdout)
}

/**
 * 索引记录为 gitlink 的工作树目录：嵌套仓库与
 * 子模块，其内容是快照永远不会深入、且 `check-ignore` 拒绝分类的。
 * @param git - 命令运行器。
 * @param workspace - 被寻址的仓库。
 * @param signal - 取消信号。
 * @returns 相对于仓库根的、以斜杠分隔的 gitlink 路径。
 */
export async function gitlinkPaths(git: GitRunner, workspace: GitWorkspace, signal: AbortSignal): Promise<Set<string>> {
  const result = ok(await git.run(['ls-files', '-z', '--stage'], { cwd: workspace.root, env: workspace.env, signal }), 'git ls-files')
  const links = new Set<string>()
  for (const entry of result.stdout.split('\0')) {
    if (entry.startsWith('160000 ')) links.add(entry.slice(entry.indexOf('\t') + 1))
  }
  return links
}

/**
 * 仓库所忽略的那部分工作树路径。被跟踪的文件
 * 永不被报告，因此与忽略模式匹配的被跟踪文件仍
 * 算作被快照覆盖。
 * @param git - 命令运行器。
 * @param workspace - 被寻址的仓库。
 * @param paths - 相对于仓库根的、以斜杠分隔的路径。
 * @param signal - 取消信号。
 * @returns `paths` 中被忽略的成员。
 */
export async function ignoredPaths(
  git: GitRunner, workspace: GitWorkspace, paths: readonly string[], signal: AbortSignal,
): Promise<Set<string>> {
  if (paths.length === 0) return new Set()
  const result = await git.run(['check-ignore', '-z', '--stdin'], {
    cwd: workspace.root, env: workspace.env, stdin: `${paths.join('\0')}\0`, signal,
  })
  if (result.exitCode === 1) return new Set()
  return new Set(ok(result, 'git check-ignore').stdout.split('\0').filter(path => path !== ''))
}
