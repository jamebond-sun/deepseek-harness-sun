/**
 * 面向模型的 `grep` 工具：用 ripgrep 正则表达式搜索文件内容。执行时通过 subprocess 接缝
 * 以朴素的 argv 向量直接 spawn 打包的 ripgrep 二进制（`@vscode/ripgrep`），使用一条固定的
 * 面向行的 `rg --json` 命令，使文件路径、行号与行文本可以在没有"按冒号切分"歧义的情况下
 * 被解析 —— 本模块负责面向模型的模式、参数校验、argv 构造、`--json` 记录解析、
 * 按行预览的保留、命中保留、分组与格式化；进程相关的关注点留在 `ctx.subprocess` 之后。
 *
 * @module @deepseek-ai/dsh-tool-fs-search/grep
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, SearchResultView, ToolResult } from '@deepseek-ai/dsh-tools'
import type { RetainedItems } from '@deepseek-ai/dsh-output-retention'
import type { SpillRef } from '@deepseek-ai/dsh-spill'
import type { GrepMatch } from './search-core.ts'
import { SearchError, previewLine, retainGrepMatches, runRipgrep, toWorkdirRelative, trySaveFormattedResult } from './search-core.ts'
import { grepSearchMeta, searchViewFromMeta } from './presentation.ts'
import { acceptedDirectCallValue } from './direct-call.ts'

/**
 * 单次 `grep` 调用内联保留的扁平命中数的默认上限（即 `grepMaxMatches` 配置），
 * 与 Claude Code 默认 `GrepTool` 的 `head_limit` 一致。
 */
export const GREP_MAX_MATCHES = 250

/**
 * 单行命中预览的默认字节上限（即 `grepMaxLineBytes` 配置）；截断处保持 UTF-8 边界。
 */
export const GREP_MAX_LINE_BYTES = 2000

/** 已解析的 grep 工具上限 —— 完成默认值填充后的插件配置（见 index.ts 的 `Config`）。 */
export interface GrepToolCaps {
  /** 内联保留的最大扁平命中数；超出的命中进入格式化的转储文件。 */
  maxMatches: number
  /** 每条命中行预览保留的最大字节数。 */
  maxLineBytes: number
  /** 序列化后 `presentationMeta` 的最大字节数；超过则丢弃尾部的文件分组。 */
  maxMetaBytes: number
  /** 该工具会去解析的完整原始 `rg` stdout 的上限。 */
  rawOutputMaxBytes: number
  /** 搜索进程的终止升级宽限期（毫秒）。 */
  graceMs: number
  /** 保留的诊断用 stderr 尾部的上限。 */
  stderrMaxBytes: number
  /** 作为 `ToolDefinition.timeoutMs` 附加的协作式工具调用预算（毫秒）。 */
  timeoutMs: number
}

/** 已校验的 `grep` 参数。 */
export interface GrepInput {
  pattern: string
  path?: string
  include?: string
}

/**
 * 拒绝不是**一个**正向 glob 过滤器的 `include`：空白字符串、取反模式（`!…`），
 * 以及逗号分隔的列表。花括号组内部的逗号是允许的 —— `*.{ts,tsx}` 是一个带择一的 glob，
 * 而不是一个列表。
 */
function validateInclude(include: string): void {
  if (include.trim().length === 0) throw new Error('include must be a non-empty glob when given')
  if (include.startsWith('!')) throw new Error('include must be a positive glob filter; negated patterns ("!…") are not supported')
  let braceDepth = 0
  for (const char of include) {
    if (char === '{') braceDepth++
    else if (char === '}') braceDepth = Math.max(0, braceDepth - 1)
    else if (char === ',' && braceDepth === 0) {
      throw new Error('include must be one glob, not a comma-separated list (use {a,b} alternation instead)')
    }
  }
}

/**
 * 校验模式 DSL 无法表达的值约束：非**空**的 `pattern`（空白是合法的正则）、
 * 在给出了 `path` 时它不能是空白，以及单个正向的 `include` glob（{@link GrepInput}）。
 * 否则抛出普通的 `Error`（一个寻常的工具参数错误）。
 *
 * @param args - 经模式校验过的 `grep` 参数。
 * @returns 被接受的、未加改动的输入。
 */
export function parseGrepArgs(args: { pattern: string; path?: string; include?: string }): GrepInput {
  if (args.pattern.length === 0) throw new Error('pattern must be a non-empty string')
  if (args.path !== undefined && args.path.trim().length === 0) throw new Error('path must be a non-empty string when given')
  if (args.include !== undefined) validateInclude(args.include)
  return {
    pattern: args.pattern,
    ...args.path !== undefined ? { path: args.path } : {},
    ...args.include !== undefined ? { include: args.include } : {},
  }
}

/**
 * 为一次 `grep` 调用构造固定的、面向行的 `rg --json` argv。每个模型可控的值
 * （{@link GrepInput.pattern}、{@link GrepInput.path}、{@link GrepInput.include}）
 * 都是一个朴素的 argv 元素 —— 其间不存在 shell 层，因此不涉及引用；pattern 与 include
 * 以 `--flag=value` 形式承载，目标则放在 `--` 之后，这样以连字符开头的值永远不会被
 * 解析成标志位。
 *
 * @param input - 已校验的参数。
 * @returns 完整的 ripgrep 参数向量（不含二进制本身）。
 */
export function buildGrepCommand(input: GrepInput): string[] {
  const parts = ['--json', `--regexp=${input.pattern}`]
  if (input.include !== undefined) parts.push(`--glob=${input.include}`)
  if (input.path !== undefined) parts.push('--', input.path)
  return parts
}

/**
 * 统一的"输出格式有误"失败：原始的 `rg --json` 只是内部传输格式，
 * 因此缺失或非法的响应字段导致一次搜索失败，而不是一份残缺的结果。
 */
function malformedRecord(detail: string, cause?: unknown): SearchError {
  return new SearchError(`grep received malformed ripgrep --json output (${detail})`, 'SEARCH_FAILED', cause !== undefined ? { cause } : undefined)
}

/**
 * 把一行 `rg --json` NDJSON 解析为一个命中；对非命中类型的记录
 * （`begin`/`end`/`context`/`summary`）返回 `undefined`。不是 JSON 的行，或者缺少路径 /
 * 行号 / 行内容的 `match` 记录，会抛出 {@link SearchError} `SEARCH_FAILED`。
 * 行内容不是合法 UTF-8 的命中（ripgrep 此时发送 base64 的 `bytes` 而非 `text`）
 * 会得到一个占位预览，而不是让整次搜索失败。
 */
function parseRecord(line: string): GrepMatch | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (error: unknown) {
    throw malformedRecord('a line is not JSON', error)
  }
  if (typeof parsed !== 'object' || parsed === null) throw malformedRecord('a record is not an object')
  const record = parsed as { type?: unknown; data?: unknown }
  // 非命中的记录类型（begin/end/context/summary —— 以及任何未来的类型）
  // 属于传输层的框架信息而不是结果：跳过，不算格式有误。
  if (record.type !== 'match') return undefined
  if (typeof record.data !== 'object' || record.data === null) throw malformedRecord('a match record has no data')
  const data = record.data as { path?: unknown; line_number?: unknown; lines?: unknown }
  const pathText = typeof data.path === 'object' && data.path !== null ? (data.path as { text?: unknown }).text : undefined
  if (typeof pathText !== 'string') throw malformedRecord('a match record has no path text')
  if (typeof data.line_number !== 'number') throw malformedRecord('a match record has no line number')
  if (typeof data.lines !== 'object' || data.lines === null) throw malformedRecord('a match record has no line content')
  const lines = data.lines as { text?: unknown; bytes?: unknown }
  if (typeof lines.text === 'string') {
    return { path: pathText, lineNumber: data.line_number, line: lines.text.replace(/\r?\n$/, '') }
  }
  if (typeof lines.bytes === 'string') {
    return { path: pathText, lineNumber: data.line_number, line: '(line is not valid UTF-8)' }
  }
  throw malformedRecord('a match record has neither line text nor bytes')
}

/**
 * 把完整的 `rg --json` stdout 按输出顺序解析为扁平的命中（ripgrep 会把一个文件的命中
 * 连续地发出）。只消费 `match` 记录。
 *
 * @param stdout - 完整的原始 `rg --json` stdout。
 * @returns 扁平的命中；输出中没有 match 记录时为空。
 */
export function parseGrepMatches(stdout: string): GrepMatch[] {
  const matches: GrepMatch[] = []
  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue
    const match = parseRecord(line)
    if (match !== undefined) matches.push(match)
  }
  return matches
}

/** 依据数量给出 `match` / `matches`。 */
function matchNoun(count: number): string {
  return count === 1 ? 'match' : 'matches'
}

/**
 * 把扁平的命中按文件（首次出现顺序）分组，形成面向模型的正文：
 * 先是每个文件的展示路径，然后每条命中一行 `Line N: <text>`。
 *
 * @param matches - 待渲染的扁平命中。
 * @returns 分组后的正文文本。
 */
export function formatGrepMatches(matches: GrepMatch[]): string {
  const byFile = new Map<string, GrepMatch[]>()
  for (const match of matches) {
    const group = byFile.get(match.path)
    if (group !== undefined) group.push(match)
    else byFile.set(match.path, [match])
  }
  const sections: string[] = []
  for (const [path, group] of byFile) {
    sections.push(`${path}\n${group.map(m => `Line ${m.lineNumber}: ${m.line}`).join('\n')}`)
  }
  return sections.join('\n\n')
}

/**
 * 格式化面向模型的 `grep` 结果：一个命中数头部、按文件分组的保留命中，
 * 然后 —— 当结果被截断时 —— 一段脚注，承载格式化的转储补救定位符或"无法保存"的说明。
 * 被省略的数量只是一个预算事实：搜索本身已经完成了。
 *
 * @param retained - 针对全部已解析命中的保留结果。
 * @param spillRef - 已保存的完整结果引用；未能保存时为 `undefined`。
 * @returns 面向模型的文本。
 */
export function formatGrepOutput(retained: RetainedItems<GrepMatch>, spillRef: SpillRef | undefined): string {
  const header = retained.truncated
    ? `Found ${retained.kept} of ${retained.seen} matches`
    : `Found ${retained.seen} ${matchNoun(retained.seen)}`
  const body = formatGrepMatches(retained.items)
  if (!retained.truncated) return `${header}\n\n${body}`
  const recovery = spillRef !== undefined
    ? `Full grep result stored at: ${spillRef.locator}. ${spillRef.retrievalHint}`
    : 'The complete result could not be saved; narrow pattern, path, or include to see more.'
  return `${header}\n\n${body}\n\n(${recovery})`
}

/** 为一个已经完成保留的命中列表格式化给 Native 面。 */
function formatRetainedGrep(retained: RetainedItems<GrepMatch>, spillRef?: SpillRef): string {
  if (retained.seen === 0) return 'No matches found'
  return formatGrepOutput(retained, spillRef)
}

/**
 * 进行中调用的展示：一张以模式（以及目标 / include 过滤器）为标题的搜索卡片。
 *
 * @param args - 原始的工具参数；`pattern`、`path` 与 `include` 用于标题。
 * @returns 调用运行期间展示的通用卡片视图（`kind: 'search'`）。
 */
export function presentGrepCall(args: { pattern: string; path?: string; include?: string }): GenericCallView {
  const where = args.path !== undefined ? ` in ${args.path}` : ''
  const filter = args.include !== undefined ? ` (${args.include})` : ''
  return { card: 'generic', title: `Grep ${args.pattern}${where}${filter}`, kind: 'search', rawInput: args.pattern }
}

/**
 * 已完成调用的展示：由结果的 `presentationMeta`（按文件分组的命中，外加截断信号）投影出的
 * 搜索卡片。没有搜索卡片的 UI 会回退到原始的 `tool/result` 内容，因此该视图自身不携带
 * 任何结果文本。元数据缺失或格式有误（一段过时或被手工编辑过的重放日志）时回退到通用卡片。
 *
 * @param _args - 原始的工具参数；未使用，该视图由结果派生。
 * @param result - 携带被投影元数据的、最终的面向模型工具结果。
 * @returns 搜索卡片视图；走通用回退时为 `undefined`。
 */
export function presentGrepResult(
  _args: { pattern: string; path?: string; include?: string },
  result: ToolResult,
): SearchResultView | undefined {
  if (result.isError) return undefined
  const view = searchViewFromMeta(result.meta)
  if (view === undefined || view.shape !== 'matches') return undefined
  return view
}

/**
 * 注册 `grep` 工具及其随作用域变化的系统提示语。
 *
 * @param ctx - 插件上下文；所有注册都是以它为作用域的 effect，
 *   执行时使用它的 `subprocess` 服务。
 * @param caps - 该部署已解析的 grep 上限（完成默认值填充后的插件配置）。
 */
export function applyGrepTool(ctx: Context, caps: GrepToolCaps): void {
  ctx.systemPrompt.section({
    name: 'tool:grep',
    order: ctx.systemPrompt.getSectionOrder('TOOL_GREP'),
    text: ({ scope }) => ctx.tools.get('grep', scope) === undefined
      ? ''
      : 'Use the grep tool — not shell grep or rg — to search file contents.'
        + (ctx.tools.get('read', scope) === undefined ? '' : ' Use read on a matched file when you need surrounding context.'),
  })

  const tool = defineTool({
    name: 'grep',
    description: 'Search file contents with a ripgrep regular expression. Returns matching lines with line numbers, grouped by file. '
      + `Returns up to ${caps.maxMatches} matches; a larger result reports where the complete match list was saved.`,
    parameters: {
      pattern: { type: 'string', required: true, description: 'Regular expression to search for (ripgrep syntax).' },
      path: { type: 'string', description: 'File or directory to search. Defaults to the session workspace; a relative path resolves against it.' },
      include: { type: 'string', description: 'One glob filter for which files to search (e.g. "*.ts", "*.{js,jsx}"). Not a list; negation is not supported.' },
    },
    timeoutMs: caps.timeoutMs,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          matches: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                lineNumber: { type: 'integer', required: true },
                line: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: formatRetainedGrep(retainGrepMatches(value.matches, caps.maxMatches, caps.maxLineBytes)),
      }],
      presentationMeta: (_args, value) =>
        grepSearchMeta(retainGrepMatches(value.matches, caps.maxMatches, caps.maxLineBytes), caps.maxMetaBytes),
    },
    async execute(args, exec) {
      const input = parseGrepArgs(args)
      const run = await runRipgrep(ctx, exec, 'grep', buildGrepCommand(input), caps.rawOutputMaxBytes, caps.graceMs, caps.stderrMaxBytes)
      if (run.noMatches) return { matches: [] }

      const all: GrepMatch[] = []
      for (const raw of parseGrepMatches(run.stdout)) {
        const match: GrepMatch = {
          path: toWorkdirRelative(raw.path, run.workdir),
          lineNumber: raw.lineNumber,
          line: raw.line,
        }
        all.push(match)
      }
      return { matches: all }
    },
    presentCall: presentGrepCall,
    presentResult: presentGrepResult,
  })
  ctx.tools.register(tool)

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    const value = acceptedDirectCallValue(ctx, tool, exec, result, decision) as { matches: GrepMatch[] } | undefined
    if (value === undefined) return decision
    const matches = value.matches
    if (matches.length <= caps.maxMatches) return decision
    // 转储产物保存的是**完整**结果：每行都做预览，但保留全部命中（不施加内联上限），
    // 因此这个补救文件就是完整的搜索结果。
    const previewedAll = matches.map(match => ({ ...match, line: previewLine(match.line, caps.maxLineBytes) }))
    const spillRef = await trySaveFormattedResult(
      ctx,
      exec,
      'grep-results.txt',
      `Found ${matches.length} ${matchNoun(matches.length)}\n\n${formatGrepMatches(previewedAll)}`,
    )
    return {
      kind: 'accept',
      content: [{
        type: 'text',
        text: formatRetainedGrep(retainGrepMatches(matches, caps.maxMatches, caps.maxLineBytes), spillRef),
      }],
      ...decision.additionalContexts !== undefined ? { additionalContexts: decision.additionalContexts } : {},
    }
  })
}
