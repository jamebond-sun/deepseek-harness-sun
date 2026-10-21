/**
 * 面向模型的 `glob` 工具：发现路径匹配某个 glob 模式的文件，按修改时间排序。执行时通过
 * subprocess 接缝以朴素的 argv 向量直接 spawn 打包的 ripgrep 二进制（`@vscode/ripgrep`）
 * —— 本模块负责面向模型的模式、参数校验、argv 构造、结果解析、内联采样与格式化；
 * 进程相关的关注点（spawn 执行、进程树终止、环境变量清理、输出捕获）留在 `ctx.subprocess` 之后。
 * @module @deepseek-ai/dsh-tool-fs-search/glob
 */

import type { Context } from '@deepseek-ai/cordis'
import { sep } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, SearchResultView, ToolResult } from '@deepseek-ai/dsh-tools'
import type { SpillRef } from '@deepseek-ai/dsh-spill'
import { runRipgrep, toWorkdirRelative, trySaveFormattedResult } from './search-core.ts'
import { globSearchMeta, searchViewFromMeta } from './presentation.ts'
import { acceptedDirectCallValue } from './direct-call.ts'

/**
 * 单次 `glob` 调用内联保留的路径数的默认上限（即 `globMaxResults` 配置），
 * 与 Claude Code 默认 `GlobTool` 的结果上限一致。
 */
export const GLOB_MAX_RESULTS = 100

/**
 * ripgrep 在一次发现式列举中绝不能下潜进去的目录名：版本控制系统的元数据存储。
 * 否则 `--no-ignore --hidden` 会在每一次宽泛搜索中把它们都翻出来。每个名字用**两个**
 * 取反的 `--glob` 排除（见 {@link buildGlobCommand}）：一个匹配任意深度目录的 glob 在遍历
 * 期间命中并**剪枝**该目录，以及一个内容 glob，用于在搜索根本身位于或处于该目录之内时
 * （显式传入 `path` 为 `.git` 或 `sub/.git`）仍然排除其内部 ——
 * 这种情况下单靠剪枝 glob 永远匹配不到。
 */
export const GLOB_VCS_EXCLUDES: readonly string[] = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl']

/** 已解析的 glob 工具上限 —— 完成默认值填充后的插件配置（见 index.ts 的 `Config`）。 */
export interface GlobToolCaps {
  /** 超上限的页是跨顶层条目采样，还是取修改时间的头部。 */
  sampleOverCapGlobResults: boolean
  /** 内联保留的最大路径数；超出的路径进入格式化的转储文件。 */
  maxResults: number
  /** 序列化后 `presentationMeta` 的最大字节数；超过则丢弃尾部的路径。 */
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

/** 已校验的 `glob` 参数。 */
export interface GlobInput {
  pattern: string
  path?: string
}

/**
 * 校验模式 DSL 无法表达的值约束：非空白的 `pattern`，以及在给出了 `path` 时它也不能是空白。
 * 否则抛出普通的 `Error`（一个寻常的工具参数错误）。
 *
 * @param args - 经模式校验过的 `glob` 参数。
 * @returns 被接受的、未加改动的输入。
 */
export function parseGlobArgs(args: { pattern: string; path?: string }): GlobInput {
  if (args.pattern.trim().length === 0) throw new Error('pattern must be a non-empty string')
  if (args.path !== undefined && args.path.trim().length === 0) throw new Error('path must be a non-empty string when given')
  return { pattern: args.pattern, ...args.path !== undefined ? { path: args.path } : {} }
}

/**
 * 为一次 `glob` 调用构造固定的 `rg --files` argv。每个模型可控的值
 * （{@link GlobInput.pattern}、{@link GlobInput.path}）都是一个朴素的 argv 元素 ——
 * 其间不存在 shell 层，因此不涉及引用；搜索根放在 `--` 之后，
 * 这样以连字符开头的路径永远不会被解析成标志位。`--sort=modified` 按修改时间排序，
 * `--no-ignore --hidden` 搜索被忽略与隐藏的文件，而 {@link GLOB_VCS_EXCLUDES}
 * 则把版本控制元数据排除在外。
 *
 * @param input - 已校验的参数。
 * @returns 完整的 ripgrep 参数向量（不含二进制本身）。
 */
export function buildGlobCommand(input: GlobInput): string[] {
  const parts = [
    '--files',
    `--glob=${input.pattern}`,
    '--sort=modified',
    '--no-ignore',
    '--hidden',
    // 每个版本控制名字用两个取反的 glob：裸形式在遍历期间剪枝该目录；
    // /** 形式则在搜索根"位于"或"处于"该目录之内时（此时裸形式针对带根前缀的路径匹配，
    // 永远不会触发）仍然排除其内容。
    ...GLOB_VCS_EXCLUDES.flatMap(name => [
      `--glob=!**/${name}`,
      `--glob=!**/${name}/**`,
    ]),
  ]
  if (input.path !== undefined) parts.push('--', input.path)
  return parts
}

/**
 * 一个被截断的 `glob` 结果的内联页，以及它覆盖了完整结果顶层的多少。
 */
export interface GlobSample {
  /** 要内联展示的路径：按顶层条目分组，组内按修改时间排序。 */
  items: string[]
  /** 所展示路径触及到的不同顶层条目数。 */
  shown: number
  /** 完整结果中不同顶层条目数。 */
  total: number
}

/** 在选择顶层分组之前，先去掉展示出来的搜索根前缀。 */
function relativeToSearchRoot(path: string, root: string): string {
  if (root === '.') return path.startsWith(`.${sep}`) ? path.slice(2) : path
  let rootEnd = root.length
  while (rootEnd > 0 && root[rootEnd - 1] === sep) rootEnd -= 1
  const trimmedRoot = root.slice(0, rootEnd)
  if (trimmedRoot.length === 0) return stripLeadingSeparators(path)
  if (path === trimmedRoot) return ''
  if (path.startsWith(`${trimmedRoot}${sep}`)) {
    return path.slice(trimmedRoot.length + 1)
  }
  return path
}

/** 只剥离该执行平台所识别的分隔符。 */
function stripLeadingSeparators(path: string): string {
  let start = 0
  while (path[start] === sep) start += 1
  return path.slice(start)
}

/**
 * 一个展示路径的首段路径分量 —— 即该路径所处的、相对搜索根的那个顶层条目。
 * 不含分隔符的路径本身就是它自己的顶层条目。先剥离前导分隔符，使一个绝对路径
 * （位于工作目录之外、{@link toWorkdirRelative} 未做处理的那种）按它第一个真实的名字
 * 分组，而不是把所有这类路径都塌缩进同一个空组。
 */
function topLevelSegment(path: string): string {
  const trimmed = stripLeadingSeparators(path)
  const cut = trimmed.indexOf(sep)
  return cut === -1 ? trimmed : trimmed.slice(0, cut)
}

/**
 * 通过在完整结果的顶层条目之间轮转来选择超上限结果的内联页，而不是取其头部。
 *
 * 每个顶层条目在任何一个拿到第二个名额之前都会先得到一个；耗尽的分组出局。
 * 分组顺序与组内顺序都遵循 `paths`，因此扁平的结果会复现出修改时间的头部。
 *
 * @param paths - 按 ripgrep 修改时间顺序排列的完整结果。
 * @param maxItems - 该页最多容纳多少路径；调用方已确认它小于 `paths`。
 * @param root - 与 `paths` 处于同一展示路径空间中的搜索根。
 * @returns 按顶层条目分组的那一页，连同已展示/总共的顶层分布。
 */
export function sampleAcrossTopLevel(paths: readonly string[], maxItems: number, root = '.'): GlobSample {
  type ActiveGroup = { key: string; items: string[]; index: number; current: string }
  const groups = new Map<string, string[]>()
  let active: ActiveGroup[] = []
  for (const path of paths) {
    const key = topLevelSegment(relativeToSearchRoot(path, root))
    const group = groups.get(key)
    if (group === undefined) {
      const items = [path]
      groups.set(key, items)
      active.push({ key, items, index: 0, current: path })
    } else {
      group.push(path)
    }
  }
  const taken = new Map<string, string[]>()
  let count = 0
  while (active.length > 0 && count < maxItems) {
    const nextActive: ActiveGroup[] = []
    for (const { key, items, index, current } of active) {
      if (count >= maxItems) break
      count += 1
      const bucket = taken.get(key)
      if (bucket === undefined) taken.set(key, [current])
      else bucket.push(current)
      const nextIndex = index + 1
      const nextPath = items[nextIndex]
      if (nextPath !== undefined) nextActive.push({ key, items, index: nextIndex, current: nextPath })
    }
    active = nextActive
  }
  return { items: [...taken.values()].flat(), shown: taken.size, total: groups.size }
}

/**
 * 格式化一个被截断的采样页及其完整结果的补救路径。扁平的结果保留朴素脚注，
 * 因为它的采样结果就是修改时间的头部。
 *
 * @param sample - 内联页及其顶层分布。
 * @param seen - 完整结果包含多少路径；总是多于该页。
 * @param spillRef - 已保存的完整结果引用；未能保存时为 `undefined`。
 * @returns 面向模型的文本。
 */
export function formatGlobOutput(sample: GlobSample, seen: number, spillRef: SpillRef | undefined): string {
  const basis = sample.total === seen
    ? '.'
    : `, sampled across ${sample.shown} of the ${sample.total} top-level entries this pattern matched instead of taken in modification-time order.`
      + (sample.shown < sample.total ? ' Narrow path to inspect a specific subtree.' : '')
  return formatGlobPage(sample.items, seen, spillRef, basis)
}

/** 格式化一个有界的页，以及其完整排序结果的补救路径。 */
function formatGlobPage(items: readonly string[], seen: number, spillRef: SpillRef | undefined, basis: string): string {
  const body = items.join('\n')
  const recovery = spillRef !== undefined
    ? `Full sorted result stored at: ${spillRef.locator}. ${spillRef.retrievalHint}`
    : 'The complete result could not be saved; narrow pattern or path to see more.'
  return `${body}\n\n(Showing ${items.length} of ${seen} paths${basis} ${recovery})`
}

/** 为一个规范路径列表相对于其搜索根做限界与格式化，输出给 Native 面。 */
function renderGlobPaths(paths: string[], caps: GlobToolCaps, root: string, spillRef?: SpillRef): string {
  if (paths.length === 0) return 'No files found'
  // 装得下的结果整个展示，不做改动：修改时间顺序是该工具的契约，
  // 而且在一个完整结果之上，它才是回答"新旧"问题的依据。
  if (paths.length <= caps.maxResults) return paths.join('\n')
  if (!caps.sampleOverCapGlobResults) {
    return formatGlobPage(paths.slice(0, caps.maxResults), paths.length, spillRef, '.')
  }
  return formatGlobOutput(sampleAcrossTopLevel(paths, caps.maxResults, root), paths.length, spillRef)
}

/**
 * 一张已完成的 `glob` 卡片所展示的内联路径页，其计算方式与 {@link renderGlobPaths}
 * 计算其面向模型的页面**完全相同**，因此卡片与文本在"哪些路径跨过了上限"上保持一致。
 * 在上限之内的结果整个展示；超上限的结果要么是修改时间的头部，要么是顶层采样，
 * 取决于该部署的 `sampleOverCapGlobResults`。
 *
 * @param paths - 按修改时间顺序排列的完整发现路径列表。
 * @param caps - 已解析的 glob 上限（内联上限与采样开关）。
 * @param root - 与 `paths` 处于同一展示路径空间中的搜索根。
 * @returns 内联页，以及完整结果是否被截断。
 */
function globCardPage(paths: string[], caps: GlobToolCaps, root: string): { items: string[]; truncated: boolean } {
  if (paths.length <= caps.maxResults) return { items: paths, truncated: false }
  if (!caps.sampleOverCapGlobResults) return { items: paths.slice(0, caps.maxResults), truncated: true }
  return { items: sampleAcrossTopLevel(paths, caps.maxResults, root).items, truncated: true }
}

/**
 * 进行中调用的展示：一张以模式（以及根目录）为标题的搜索卡片。
 *
 * @param args - 原始的工具参数；`pattern` 与 `path` 用于标题。
 * @returns 调用运行期间展示的通用卡片视图（`kind: 'search'`）。
 */
export function presentGlobCall(args: { pattern: string; path?: string }): GenericCallView {
  const where = args.path !== undefined ? ` in ${args.path}` : ''
  return { card: 'generic', title: `Glob ${args.pattern}${where}`, kind: 'search', rawInput: args.pattern }
}

/**
 * 已完成调用的展示：由结果的 `presentationMeta`（发现到的路径列表，外加截断信号）投影出的
 * 搜索卡片。没有搜索卡片的 UI 会回退到原始的 `tool/result` 内容，因此该视图自身不携带
 * 任何结果文本。元数据缺失或格式有误（一段过时或被手工编辑过的重放日志）时回退到通用卡片。
 *
 * @param _args - 原始的工具参数；未使用，该视图由结果派生。
 * @param result - 携带被投影元数据的、最终的面向模型工具结果。
 * @returns 搜索卡片视图；走通用回退时为 `undefined`。
 */
export function presentGlobResult(_args: { pattern: string; path?: string }, result: ToolResult): SearchResultView | undefined {
  if (result.isError) return undefined
  const view = searchViewFromMeta(result.meta)
  if (view === undefined || view.shape !== 'paths') return undefined
  return view
}

/**
 * 注册 `glob` 工具及其随作用域变化的系统提示语。
 *
 * @param ctx - 插件上下文；所有注册都是以它为作用域的 effect，
 *   执行时使用它的 `subprocess` 服务。
 * @param caps - 该部署已解析的 glob 上限（完成默认值填充后的插件配置）。
 */
export function applyGlobTool(ctx: Context, caps: GlobToolCaps): void {
  ctx.systemPrompt.section({
    name: 'tool:glob',
    order: ctx.systemPrompt.getSectionOrder('TOOL_GLOB'),
    text: ({ scope }) => ctx.tools.get('glob', scope) === undefined
      ? ''
      : 'Use the glob tool — not shell find — to discover files by path pattern.',
  })

  const overCapDescription = caps.sampleOverCapGlobResults ? 'is sampled across top-level entries' : 'keeps the first paths'
  const tool = defineTool({
    name: 'glob',
    description: 'Find files, not directories, whose paths match a glob pattern, including hidden and ignored files. '
      + `Returns up to ${caps.maxResults} paths in modification-time order; a larger result ${overCapDescription} `
      + 'and reports where the complete list was saved.',
    parameters: {
      pattern: {
        type: 'string',
        required: true,
        description: 'Glob pattern to match file paths against (e.g. "**/*.ts", "src/**/*.test.js"). '
          + 'A pattern with no "/" matches the basename at any depth, so "*" and "*.ts" both search the whole tree; include a separator to anchor the depth.',
      },
      path: { type: 'string', description: 'Directory to search in. Defaults to the session workspace; a relative path resolves against it.' },
    },
    timeoutMs: caps.timeoutMs,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true },
          paths: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderGlobPaths(value.paths, caps, value.root) }],
      presentationMeta: (_args, value) => {
        const page = globCardPage(value.paths, caps, value.root)
        return globSearchMeta({ items: page.items, truncated: page.truncated, seen: value.paths.length }, caps.maxMetaBytes)
      },
    },
    async execute(args, exec) {
      const input = parseGlobArgs(args)
      const run = await runRipgrep(ctx, exec, 'glob', buildGlobCommand(input), caps.rawOutputMaxBytes, caps.graceMs, caps.stderrMaxBytes)
      const root = input.path === undefined ? '.' : toWorkdirRelative(input.path, run.workdir)
      if (run.noMatches) return { root, paths: [] }

      const all: string[] = []
      for (const line of run.stdout.split('\n')) {
        if (line.length === 0) continue
        const displayPath = toWorkdirRelative(line, run.workdir)
        all.push(displayPath)
      }
      return { root, paths: all }
    },
    presentCall: presentGlobCall,
    presentResult: presentGlobResult,
  })
  ctx.tools.register(tool)

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    const value = acceptedDirectCallValue(ctx, tool, exec, result, decision) as { root: string; paths: string[] } | undefined
    if (value === undefined) return decision
    const paths = value.paths
    if (paths.length <= caps.maxResults) return decision
    const spillRef = await trySaveFormattedResult(ctx, exec, 'glob-results.txt', paths.join('\n'))
    return {
      kind: 'accept',
      content: [{ type: 'text', text: renderGlobPaths(paths, caps, value.root, spillRef) }],
      ...decision.additionalContexts !== undefined ? { additionalContexts: decision.additionalContexts } : {},
    }
  })
}
