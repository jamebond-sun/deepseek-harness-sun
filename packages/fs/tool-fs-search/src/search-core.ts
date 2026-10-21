/**
 * `glob` / `grep` 搜索工具共享的执行管道：本包自有的 `SEARCH_*` 错误词汇表、
 * 一个以朴素 argv 向量运行**打包的** ripgrep 二进制（`@vscode/ripgrep`）并返回完整原始
 * stdout 的 spawn 辅助函数、尽力而为的格式化结果转储交接，以及相对工作目录的路径展示。
 *
 * 两个工具都作为普通的前台 spawn 通过 `ctx.subprocess` 执行 —— 绝不经由 `ctx.shell`、
 * `ctx.shell.start()`，也绝不是模型可见的后台任务。ripgrep 二进制随 npm 包分发，
 * 因此不需要系统安装 `rg`；argv 向量与 ripgrep 之间不存在 shell 层，因此也不涉及任何
 * shell 引用。原始的 `rg` stdout 只是一个内部传输细节：这些工具向 subprocess 接缝申请
 * 每次运行的 stdout 捕获预算，只在 `rawOutputMaxBytes` 之内解析完整且位于内存中的
 * stdout，且从不读取转储文件。面向模型的补救产物是通过
 * `ctx.spillStore.saveText()`（{@link trySaveFormattedResult}）保存的格式化结果。
 *
 * @module @deepseek-ai/dsh-tool-fs-search/search-core
 */

import { existsSync } from 'node:fs'
import { isAbsolute, join, parse, relative, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { ItemRetainer, TextRetainer } from '@deepseek-ai/dsh-output-retention'
import type { RetainedItems } from '@deepseek-ai/dsh-output-retention'
import type { SubprocessHandle, SubprocessOutcome, SubprocessOutputRead, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { SaveTextSpill, SpillRef } from '@deepseek-ai/dsh-spill'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

/**
 * 这些工具会去解析的 `rg` 完整原始 stdout 的默认上限（即 `rawOutputMaxBytes` 配置），
 * 与 Claude Code 的 ripgrep 原始缓冲区一致。
 */
export const RAW_OUTPUT_MAX_BYTES = 20_000_000

/**
 * 默认的协作式工具调用超时预算（毫秒，即 `timeoutMs` 配置），挂在两个工具定义上，
 * 由 `@deepseek-ai/dsh-tool-call-timeout-policy` 通过 `exec.signal` 强制执行。
 */
export const SEARCH_TIMEOUT_MS = 30_000

/**
 * 单次搜索运行保留的 stderr 尾部的默认字节上限 —— 仅作为诊断摘要
 * （该工具从不读取 stderr 的转储路径，收集处置也不需要任何转储）。
 */
export const SEARCH_STDERR_MAX_BYTES = 64 * 1024

/** 搜索进程的默认终止宽限期（毫秒）。 */
export const SEARCH_GRACE_MS = 3_000

/**
 * 单次搜索序列化后的 `presentationMeta` 的默认字节上限（即 `searchMetaMaxBytes` 配置）。
 * 内联的命中/路径上限已经约束了条目的**数量**，但一次宽泛搜索所保留的命中（大量长行）
 * 仍可能序列化出几百 KB，而 `meta` 会随会话日志持久化并在每次请求时被重新发送。
 * 部署的最终输出预算（`dsh-spill-policy`）只会缩减结果的 `content`，永不缩减其 `meta`，
 * 因此这个上限由投影持有。64 KiB 足以容纳一次典型搜索在默认上限下的完整结果，
 * 同时为病态情形设界。
 */
export const SEARCH_META_MAX_BYTES = 65_536

/**
 * 稳定、可被机器路由的搜索失败码。由本包拥有（而不是 `FsErrorCode`），因为这两个工具是
 * 由 spawn 支撑的发现动作，而非 `ctx.fs` 的提供者操作：`SEARCH_INVALID_PATTERN` ——
 * ripgrep 拒绝了正则或 glob；`SEARCH_FAILED` —— 搜索无法运行或其输出无法解析
 * （`rg` 启动失败、目标不可访问、被信号杀死、`--json` 格式错误）；
 * `SEARCH_RAW_OUTPUT_OVERFLOW` —— 原始 `rg` 输出超出 `rawOutputMaxBytes`，
 * 或在所申请的 stdout 预算之内仍是截断的；`SEARCH_ABORTED` —— 协作式工具超时或
 * 调用方取消把搜索提前掐断。
 */
export type SearchErrorCode =
  | 'SEARCH_INVALID_PATTERN'
  | 'SEARCH_FAILED'
  | 'SEARCH_RAW_OUTPUT_OVERFLOW'
  | 'SEARCH_ABORTED'

/**
 * 类型化的搜索失败。继承 {@link HarnessError}，因此带有稳定的 {@link SearchErrorCode}
 * 并串联 `cause`；工具注册表在 `isError` 结果上暴露 `{ name, code }`，
 * 使重试/权限/UI 层无需解析消息文本即可分支处理。
 */
export class SearchError extends HarnessError {
  override readonly code: SearchErrorCode

  constructor(message: string, code: SearchErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.code = code
  }
}

/** 一次 `rg` 运行的一次完整采集：完整的 stdout 加上已解析的工作目录。 */
export interface RipgrepRun {
  /** 由 subprocess 接缝在请求上限之内保留下来的完整原始 stdout。 */
  stdout: string
  /** ripgrep 以 1 退出时为真：一次成功但零命中的搜索。 */
  noMatches: boolean
  /** 命令运行时所用的已解析工作目录（即展示相对化的基准）。 */
  workdir: string
}

/**
 * 把保留下来的 stderr 尾部作为诊断摘要，并在 subprocess 接缝丢弃了字节时附上截断说明。
 */
function stderrExcerpt(stderrText: string, truncated: boolean): string {
  const text = stderrText.trim()
  if (text.length === 0) return ''
  return truncated ? `${text} [stderr truncated]` : text
}

/**
 * 把一次非零退出的 `rg` 运行归类到搜索错误词汇表。由于不存在 shell 层，
 * 因此不可能出现 127 退出或 shell 的 "command not found" 文本 ——
 * 启动失败会在 spawn 处被 reject（见 {@link runRipgrep}）。
 */
function classifyRunFailure(toolName: string, exitCode: number, stderrText: string, stderrTruncated: boolean): SearchError {
  const stderr = stderrExcerpt(stderrText, stderrTruncated)
  if (/regex parse error|error parsing glob/i.test(stderr)) {
    return new SearchError(`${toolName} pattern rejected by ripgrep: ${stderr}`, 'SEARCH_INVALID_PATTERN')
  }
  return new SearchError(`${toolName} search failed (exit ${exitCode})${stderr.length > 0 ? `: ${stderr}` : ''}`, 'SEARCH_FAILED')
}

/**
 * 采集一次已完成运行的**完整**原始 stdout，并在内存中的传输结果上强制
 * `rawOutputMaxBytes`。结果被截断意味着 subprocess 接缝无法在所请求的预算之内保留完整的
 * stdout，因此该工具明确失败，而不是去解析一段被静默截断的流。
 */
function completeStdout(toolName: string, stdout: SubprocessOutputRead, rawOutputMaxBytes: number): string {
  const narrow = 'narrow pattern, path, or include and retry'
  if (!stdout.lossy) {
    const inlineBytes = Buffer.byteLength(stdout.text, 'utf8')
    if (inlineBytes > rawOutputMaxBytes) {
      throw new SearchError(
        `${toolName} produced ${inlineBytes} bytes of raw output, over the ${rawOutputMaxBytes}-byte cap; ${narrow}`,
        'SEARCH_RAW_OUTPUT_OVERFLOW',
      )
    }
    return stdout.text
  }
  throw new SearchError(
    `${toolName} produced more raw output than the subprocess seam retained within the ${rawOutputMaxBytes}-byte cap; ${narrow}`,
    'SEARCH_RAW_OUTPUT_OVERFLOW',
  )
}

let rgPathPromise: Promise<string> | undefined

/**
 * 打包的 ripgrep 二进制路径，每个进程惰性解析一次。
 *
 * 单文件运行时使用可执行文件的 `-rg` 附带文件，因为原生辅助程序无法从 pkg 的虚拟文件系统中
 * 被 spawn。Node 模式的构建则回退到由 `@vscode/ripgrep` 选出的平台包。在调用边界处解析，
 * 可以把一个缺失或损坏的二进制留在第一次搜索调用时报成 `SEARCH_FAILED`，
 * 而不是让 Loader 的组合直接失败。
 *
 * @returns 打包二进制的绝对路径；当平台包无法解析时，这个被记忆化的 promise 会 reject。
 */
export function resolveRgPath(): Promise<string> {
  rgPathPromise ??= Promise.resolve().then(async () => {
    const executable = parse(process.execPath)
    const executableSidecar = process.platform === 'win32'
      ? join(executable.dir, `${executable.name}-rg.exe`)
      : `${process.execPath}-rg`
    if ('pkg' in process && existsSync(executableSidecar)) return executableSidecar
    const dependency = (await import('@vscode/ripgrep')).rgPath
    return process.versions.electron === undefined
      ? dependency
      : dependency.replace(/\.asar(?=[\\/])/u, '.asar.unpacked')
  })
  return rgPathPromise
}

/**
 * 以朴素的 argv 向量运行打包的 ripgrep 二进制，并返回其完整的原始 stdout。工作目录在可用时
 * 取调用方 agent 会话的当前目录，否则取 `process.cwd()`。`exec.signal` 会被转发，
 * 使协作式工具超时（`@deepseek-ai/dsh-tool-call-timeout-policy`）与调用方取消
 * 能够终止进程树。
 *
 * 这次 spawn 是不受 confinement 的（一次普通的 `ctx.subprocess` 调用），因此会前置
 * `--no-config`：否则宿主上的 `RIPGREP_CONFIG_PATH`（或二进制旁边的 `rg.conf`）
 * 就可能注入 `--pre`，让 ripgrep 对每个命中文件执行任意预处理器。收集处置取的是该接缝的
 * 诊断尾部形态（没有转储文件）：这些工具从不读取原始转储路径，而截断的 stdout 会以
 * `SEARCH_RAW_OUTPUT_OVERFLOW` 失败。
 *
 * 退出语义由工具自己拥有：退出 0 是带结果的成功，退出 1 是零命中的成功（`noMatches`），
 * 其他情况抛出 {@link SearchError}（中止/超时 → `SEARCH_ABORTED`，模式非法 →
 * `SEARCH_INVALID_PATTERN`，其余 → `SEARCH_FAILED` / `SEARCH_RAW_OUTPUT_OVERFLOW`）。
 * 两个启动期的失败域都会被归类：在 spawn **创建**时同步抛出的异常（argv 中的 NUL、
 * 抢在上述检查之前发生的 abort、`@vscode/ripgrep` 解析被 reject）报告命令无法启动，
 * 而 `handle.done` 的拒绝则报告提供者失败，不断言执行是否已经开始。两者都变成带着原始
 * 错误作为 `cause` 的 `SEARCH_FAILED`；而在创建时刻就已观察到的 abort 则变成
 * `SEARCH_ABORTED`。
 *
 * @param ctx - 插件上下文；执行时使用它的 `subprocess` 服务。
 * @param exec - 工具执行上下文；提供所属的 Agent 与中止信号。
 * @param toolName - `glob` 或 `grep`，用于错误消息。
 * @param argv - ripgrep 的参数（每个模型值都是一个未加引号的 argv 元素；其间不存在 shell 层）。
 * @param rawOutputMaxBytes - 该工具会去解析的完整原始 stdout 的上限。
 * @param graceMs - 该接缝的终止升级宽限期。
 * @param stderrMaxBytes - 保留的诊断用 stderr 尾部的上限。
 * @returns 完整的 stdout、零命中标志，以及已解析的工作目录。
 */
export async function runRipgrep(
  ctx: Context,
  exec: ToolExecution,
  toolName: string,
  argv: readonly string[],
  rawOutputMaxBytes: number,
  graceMs: number,
  stderrMaxBytes: number,
): Promise<RipgrepRun> {
  if (exec.signal.aborted) {
    throw new SearchError(`${toolName} was aborted before completion (tool timeout or caller cancellation)`, 'SEARCH_ABORTED')
  }
  const workdir = exec.agent === undefined
    ? process.cwd()
    : await ctx.workingDirectory.ensure(exec.agent, exec.signal)
  let handle: SubprocessHandle
  try {
    handle = ctx.subprocess.spawn({
      argv: [await resolveRgPath(), '--no-config', ...argv],
      cwd: workdir,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: rawOutputMaxBytes },
        stderr: { maxBytes: stderrMaxBytes },
      },
      graceMs,
      signal: exec.signal,
    } satisfies SubprocessSpawnSpec)
  } catch (error: unknown) {
    // Node 的 spawn() 会在 argv 含 NUL 时同步抛出，而本地实现在信号于上面的检查与本次
    // 调用之间中止时（或平台包解析被 reject 时）也会同步抛出。
    // 无法看到 AbortSignal 状态变化的静态收窄，会误判这次复检"永远为假"。
    // oxlint-disable-next-line typescript/no-unnecessary-condition
    if (exec.signal.aborted) {
      throw new SearchError(`${toolName} was aborted before completion (tool timeout or caller cancellation)`, 'SEARCH_ABORTED')
    }
    throw new SearchError(`${toolName} could not start its search command (ripgrep launch failed)`, 'SEARCH_FAILED', { cause: error })
  }
  let outcome: SubprocessOutcome
  try {
    outcome = await handle.done
  } catch (error: unknown) {
    throw new SearchError(`${toolName} subprocess failed before reporting an outcome (ripgrep provider failure)`, 'SEARCH_FAILED', { cause: error })
  }
  const stdout = handle.collected.stdout?.readFrom(0)
  const stderr = handle.collected.stderr?.readFrom(0)
  if (stdout === undefined || stderr === undefined) {
    throw new SearchError(`${toolName} search command produced no collected output streams`, 'SEARCH_FAILED')
  }
  // 信号可能在等待 spawn 期间中止；无法看到 AbortSignal 状态变化的静态收窄，
  // 会误判这次复检"永远为假"。
  // oxlint-disable-next-line typescript/no-unnecessary-condition
  if (exec.signal.aborted) {
    throw new SearchError(`${toolName} was aborted before completion (tool timeout or caller cancellation)`, 'SEARCH_ABORTED')
  }
  if (outcome.signal !== null || outcome.exitCode === null) {
    throw new SearchError(`${toolName} search command was killed by signal ${outcome.signal ?? '(unknown)'}`, 'SEARCH_FAILED')
  }
  if (outcome.exitCode !== 0 && outcome.exitCode !== 1) {
    throw classifyRunFailure(toolName, outcome.exitCode, stderr.text, stderr.lossy)
  }
  const text = completeStdout(toolName, stdout, rawOutputMaxBytes)
  return { stdout: text, noMatches: outcome.exitCode === 1, workdir }
}

/**
 * 把 `rg` 输出的一个路径映射成它的展示形态：落在已解析工作目录内的绝对路径会变成
 * 相对工作目录的形式；其余一切（相对输出、工作目录之外的路径）原样透传。仅用于展示 ——
 * 返回的路径只有在工作目录与文件系统两者解析到同一个工作区的同地部署中才能被后续读取
 * （这是 v1 已记录的部署要求）。
 *
 * @param path - ripgrep 打印出的一个路径。
 * @param workdir - 命令运行时所用的已解析工作目录。
 * @returns 可能时给出相对工作目录的展示路径，否则原样返回 `path`。
 */
export function toWorkdirRelative(path: string, workdir: string): string {
  if (!isAbsolute(path)) return path
  const rel = relative(workdir, path)
  if (rel.length === 0) return '.'
  if (rel === '..' || rel.startsWith(`..${sep}`)) return path
  return rel
}

/** 一个已解析的命中：文件、1 基行号，以及（可能被预览截断的）行文本。 */
export interface GrepMatch {
  path: string
  lineNumber: number
  line: string
}

/**
 * 把单行命中预览限制在 `maxBytes` 之内（保持 UTF-8 边界）并标记这一刀。
 * 该上限是按行的预算事实；完整的行仍留在被搜索的文件里，可供 `read` 读取。
 *
 * @param line - 命中的行文本（结尾换行符已被剥离）。
 * @param maxBytes - 以字节计的预览预算。
 * @returns 预览文本；有字节被截断时附以 ` (line truncated)` 后缀。
 */
export function previewLine(line: string, maxBytes: number): string {
  const retainer = new TextRetainer({ kind: 'head', maxBytes })
  retainer.push(line)
  const kept = retainer.finish()
  return kept.truncated ? `${kept.text} (line truncated)` : kept.text
}

/**
 * 对一个规范的 `grep` 命中列表施加共享的内联上限：把每条保留下来的行预览到
 * `maxLineBytes`，并保留前 `maxMatches` 条。这一次保留过程同时被面向模型的渲染
 * （{@link module:@deepseek-ai/dsh-tool-fs-search/grep} 的 `formatGrepOutput`）与搜索卡片
 * 投影（{@link module:@deepseek-ai/dsh-tool-fs-search/presentation} 的 `grepSearchMeta`）
 * 所消费，因此文本与卡片永远不会在"哪些命中存活下来"上产生分歧。
 *
 * @param matches - 搜索解析出的全部命中（即规范值中的命中）。
 * @param maxMatches - 内联命中上限（即 `grepMaxMatches` 配置）。
 * @param maxLineBytes - 每条命中行的预览预算（字节）。
 * @returns 针对已预览命中的保留结果。
 */
export function retainGrepMatches(matches: GrepMatch[], maxMatches: number, maxLineBytes: number): RetainedItems<GrepMatch> {
  const retainer = new ItemRetainer<GrepMatch>({ kind: 'head', maxItems: maxMatches })
  for (const match of matches) retainer.push({ ...match, line: previewLine(match.line, maxLineBytes) })
  return retainer.finish()
}

/**
 * 对一个规范的 `glob` 路径列表施加共享的内联上限：保留前 `maxResults` 个。
 * 这一次保留过程同时被面向模型的渲染与搜索卡片投影所消费。
 *
 * @param paths - 搜索发现的全部路径（即规范值中的路径）。
 * @param maxResults - 内联路径上限（即 `globMaxResults` 配置）。
 * @returns 针对这些路径的保留结果。
 */
export function retainGlobPaths(paths: string[], maxResults: number): RetainedItems<string> {
  const retainer = new ItemRetainer<string>({ kind: 'head', maxItems: maxResults })
  for (const path of paths) retainer.push(path)
  return retainer.finish()
}

/**
 * 通过 `ctx.spillStore.saveText()` 尽力保存一份**完整**的格式化搜索结果 ——
 * 这是被截断结果的面向模型补救路径。`spillStore` 是用 `ctx.get()` 读取的
 * （而非静态 inject），因为格式化结果的转储是可选的；转储的持有者是调用方 agent 的
 * 会话头 id，来源则是工具执行标识。后端缺失、调用没有会话持有者，或者 `saveText()`
 * 被拒绝时，都会记录一条警告并返回 `undefined` —— 调用方保留内联结果，并报告完整结果
 * 未能保存；搜索的成功绝不会因为转储存储不可用而变成 `isError`。
 *
 * @param ctx - 插件上下文；`spillStore` 是机会式查找的。
 * @param exec - 工具执行上下文；提供所属的会话、工具名与调用 id。
 * @param suggestedName - 经后端净化的文件名提示（例如 `grep-results.txt`）。
 * @param content - 待持久化的完整格式化结果。
 * @returns 已保存的转储引用；结果未能保存时为 `undefined`。
 */
export async function trySaveFormattedResult(
  ctx: Context,
  exec: ToolExecution,
  suggestedName: string,
  content: string,
): Promise<SpillRef | undefined> {
  const sessionId = exec.agent?.session.header.id
  if (sessionId === undefined) {
    ctx.logger.warn(`tool-fs-search: no session owner for ${exec.name} result; complete result not saved`)
    return undefined
  }
  const spillStore = ctx.get('spillStore')
  if (!spillStore) {
    ctx.logger.warn(`tool-fs-search: no ctx.spillStore backend loaded; complete ${exec.name} result not saved`)
    return undefined
  }
  const save: SaveTextSpill = {
    owner: { sessionId },
    source: { kind: 'tool', toolName: exec.name, callId: exec.callId, label: 'result' },
    suggestedName,
    content,
  }
  try {
    return await spillStore.saveText(save)
  } catch (error: unknown) {
    // 尽力而为：一次存储失败绝不能让搜索失败或掩盖内联结果 ——
    // 脚注会转而报告未能保存的那部分剩余内容。
    ctx.logger.warn(`tool-fs-search: saveText failed for ${exec.name}: ${String(error)}; complete result not saved`)
    return undefined
  }
}
