/**
 * 建立在打包的 ripgrep 二进制（`@vscode/ripgrep`）之上、面向模型的文件系统发现工具套件
 * （`glob`、`grep`）。这单个插件注册这两个工具；该二进制随 npm 依赖一起分发，
 * 因此不需要系统安装 `rg`，也不涉及任何 shell 层。
 *
 * ## 由 spawn 支撑，而非 `ctx.fs` 的提供者方法
 *
 * 本地工作区发现是一个由进程支撑的 `rg` 工作流，因此这些工具通过
 * `ctx.subprocess.spawn()` 以固定的 ripgrep argv 模板执行 —— 绝不经由 `ctx.shell`、
 * `ctx.shell.start()`，也绝不是模型可见的后台任务。工具层负责模式、参数校验、argv 构造
 * （{@link module:@deepseek-ai/dsh-tool-fs-search/glob} /
 * {@link module:@deepseek-ai/dsh-tool-fs-search/grep}）、结果解析、保留策略、
 * 格式化结果的转储以及超时声明；subprocess 接缝则负责 spawn 执行、进程树终止、
 * 环境变量清理与原始输出捕获。本包注入 `tools`、`systemPrompt` 与 `subprocess` ——
 * 刻意**不**注入 `fs`；而 `ctx.spillStore` 是以 `ctx.get()` 机会式读取的，
 * 因为格式化结果的转储是可选的。
 *
 * 返回的路径以相对已解析工作目录的形式展示，且只有在"工作目录与文件系统 `read` 根目录是
 * 同一个工作区"的同地部署下才能被后续读取 —— 这是 v1 已记录的部署要求，运行时并不校验。
 *
 * @module @deepseek-ai/dsh-tool-fs-search
 */

import type {} from '@deepseek-ai/dsh-working-directory'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { GLOB_MAX_RESULTS, applyGlobTool } from './glob.ts'
import { GREP_MAX_LINE_BYTES, GREP_MAX_MATCHES, applyGrepTool } from './grep.ts'
import { RAW_OUTPUT_MAX_BYTES, SEARCH_GRACE_MS, SEARCH_META_MAX_BYTES, SEARCH_STDERR_MAX_BYTES, SEARCH_TIMEOUT_MS } from './search-core.ts'

export { GLOB_MAX_RESULTS, GLOB_VCS_EXCLUDES, applyGlobTool, buildGlobCommand, formatGlobOutput, parseGlobArgs, presentGlobCall, presentGlobResult, sampleAcrossTopLevel } from './glob.ts'
export type { GlobInput, GlobSample, GlobToolCaps } from './glob.ts'
export {
  GREP_MAX_LINE_BYTES,
  GREP_MAX_MATCHES,
  applyGrepTool,
  buildGrepCommand,
  formatGrepMatches,
  formatGrepOutput,
  parseGrepArgs,
  parseGrepMatches,
  presentGrepCall,
  presentGrepResult,
} from './grep.ts'
export type { GrepInput, GrepToolCaps } from './grep.ts'
export {
  RAW_OUTPUT_MAX_BYTES,
  SEARCH_GRACE_MS,
  SEARCH_META_MAX_BYTES,
  SEARCH_STDERR_MAX_BYTES,
  SEARCH_TIMEOUT_MS,
  SearchError,
  previewLine,
  resolveRgPath,
  runRipgrep,
  toWorkdirRelative,
  trySaveFormattedResult,
} from './search-core.ts'
export type { GrepMatch, RipgrepRun, SearchErrorCode } from './search-core.ts'

/** 供加载器诊断使用的 Cordis 插件名。 */
export const name = 'tool-fs-search'

/** 搜索工具套件所需的服务（`spillStore` 是可选的，通过 `ctx.get()` 读取）。 */
export const inject = ['tools', 'systemPrompt', 'subprocess', 'workingDirectory']

/** 插件配置；对超出上限的 glob 做采样是一项显式的部署选择，其余字段均有默认值。 */
export interface Config {
  /** 超上限的 `glob` 页是跨顶层条目采样，还是取修改时间的头部。 */
  sampleOverCapGlobResults: boolean
  /** 单次 `glob` 调用内联保留的最大路径数；超出的路径进入格式化的转储文件。 */
  globMaxResults?: number
  /** 单次 `grep` 调用内联保留的最大扁平命中数；超出的命中进入格式化的转储文件。 */
  grepMaxMatches?: number
  /** 单行命中预览保留的最大字节数（截断处保持 UTF-8 边界）。 */
  grepMaxLineBytes?: number
  /** 单次搜索序列化后的 `presentationMeta` 最大字节数；超过则丢弃尾部的分组/路径，
   * 使持久化的卡片保持有界。 */
  searchMetaMaxBytes?: number
  /** 单次搜索会去解析的 `rg` 原始 stdout 最大完整字节数；更大的原始输出以
   * `SEARCH_RAW_OUTPUT_OVERFLOW` 失败。 */
  rawOutputMaxBytes?: number
  /** 终止升级的宽限期（毫秒），交给 subprocess 接缝，并受 `MAX_TIMER_DELAY_MS` 约束。 */
  graceMs?: number
  /** 单次搜索保留的 stderr 尾部最大字节数；该摘要会被嵌入 `SEARCH_*` 错误消息，
   * 成功时绝不展示。 */
  stderrMaxBytes?: number
  /**
   * 两个工具上共同的协作式工具调用超时预算（毫秒），由
   * `@deepseek-ai/dsh-tool-call-timeout-policy` 通过 `exec.signal` 强制执行。
   */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  sampleOverCapGlobResults: z.boolean().required(),
  globMaxResults: z.number().default(GLOB_MAX_RESULTS),
  grepMaxMatches: z.number().default(GREP_MAX_MATCHES),
  grepMaxLineBytes: z.number().default(GREP_MAX_LINE_BYTES),
  searchMetaMaxBytes: z.number().default(SEARCH_META_MAX_BYTES),
  rawOutputMaxBytes: z.number().default(RAW_OUTPUT_MAX_BYTES),
  graceMs: z.number().default(SEARCH_GRACE_MS),
  stderrMaxBytes: z.number().default(SEARCH_STDERR_MAX_BYTES),
  timeoutMs: z.number().default(SEARCH_TIMEOUT_MS),
})

/** schemastery 应用默认值之后的形状。 */
type ResolvedConfig = Required<Config>

/** 每个搜索上限都以条目/字节/毫秒计 —— 必须是正整数，否则保留策略与超时算术会静默出错。 */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-fs-search: ${name} must be a positive integer`)
  }
}

/**
 * 注册 `glob`/`grep` 文件系统发现工具套件。打包的 ripgrep 二进制始终可用
 * （作为 npm 依赖），因此注册是无条件的。
 *
 * @param ctx - 插件上下文；所有注册都是以该插件为作用域的 effect。
 * @param config - 由 schemastery 解析出的插件配置。
 */
// oxlint-disable-next-line typescript/require-await -- async keeps a load-time config rejection a rejection, not a synchronous throw
export async function apply(ctx: Context, config: Config): Promise<void> {
  // schemastery（Config）已经填好所有带默认值的字段。
  const resolved = config as ResolvedConfig
  assertPositiveInteger('globMaxResults', resolved.globMaxResults)
  assertPositiveInteger('grepMaxMatches', resolved.grepMaxMatches)
  assertPositiveInteger('grepMaxLineBytes', resolved.grepMaxLineBytes)
  assertPositiveInteger('searchMetaMaxBytes', resolved.searchMetaMaxBytes)
  assertPositiveInteger('rawOutputMaxBytes', resolved.rawOutputMaxBytes)
  assertPositiveInteger('graceMs', resolved.graceMs)
  if (resolved.graceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`tool-fs-search: graceMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  assertPositiveInteger('stderrMaxBytes', resolved.stderrMaxBytes)
  assertPositiveInteger('timeoutMs', resolved.timeoutMs)
  applyGlobTool(ctx, {
    sampleOverCapGlobResults: resolved.sampleOverCapGlobResults,
    maxResults: resolved.globMaxResults,
    maxMetaBytes: resolved.searchMetaMaxBytes,
    rawOutputMaxBytes: resolved.rawOutputMaxBytes,
    graceMs: resolved.graceMs,
    stderrMaxBytes: resolved.stderrMaxBytes,
    timeoutMs: resolved.timeoutMs,
  })
  applyGrepTool(ctx, {
    maxMatches: resolved.grepMaxMatches,
    maxLineBytes: resolved.grepMaxLineBytes,
    maxMetaBytes: resolved.searchMetaMaxBytes,
    rawOutputMaxBytes: resolved.rawOutputMaxBytes,
    graceMs: resolved.graceMs,
    stderrMaxBytes: resolved.stderrMaxBytes,
    timeoutMs: resolved.timeoutMs,
  })
}
