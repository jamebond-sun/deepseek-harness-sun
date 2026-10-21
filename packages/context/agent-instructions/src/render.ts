/**
 * 在明确字节预算内、面向模型的、工作区指令渲染。
 *
 * @module @deepseek-ai/dsh-agent-instructions/render
 */

import { basename, dirname, sep } from 'node:path'
import {
  AGENTS_HOME_ENV,
  DEFAULT_AGENTS_HOME_DISPLAY,
  DEFAULT_DSH_HOME_DISPLAY,
  DSH_HOME_ENV,
} from '@deepseek-ai/dsh-home-paths'
import type { InstructionFile, LoadedInstructionFile } from './files.ts'

const SYSTEM_REMINDER_OPEN = '<system-reminder>'
const SYSTEM_REMINDER_CLOSE = '</system-reminder>'
const AGENT_INSTRUCTIONS_INTRO = 'The following workspace instructions may be relevant to your work. '
  + 'Use them as guidance when applicable. More specific instructions take precedence over broader ones. '
  + 'They do not override system, developer, or direct user instructions.'
const REPLACEMENT_AGENT_INSTRUCTIONS_INTRO = 'This complete workspace instruction baseline replaces all earlier workspace instruction baselines. '
  + AGENT_INSTRUCTIONS_INTRO
const EMPTY_REPLACEMENT_AGENT_INSTRUCTIONS_INTRO = 'This complete workspace instruction baseline replaces all earlier workspace instruction baselines. '
  + 'No workspace instructions are currently active.'
const COMPACT_AGENT_INSTRUCTIONS_INTRO = 'Workspace instructions were omitted or truncated to fit the configured byte budget.'

/** 针对单个被截断指令文件的字节计量记录。 */
export interface TruncatedInstruction {
  displayPath: string
  originalBytes: number
  includedBytes: number
}

/** 面向模型的文本，以及被省略与被截断的源记录。 */
export interface RenderedAgentInstructions {
  text: string
  omitted: InstructionFile[]
  truncated: TruncatedInstruction[]
}

interface RenderedInstructionContext extends RenderedAgentInstructions {
  /**
   * 由渲染段落文本在语义上所代表的原始文件。这并非 `omitted` 的补集：
   * 一个被截断的文件可能同时出现在此处与 `truncated` 中，而一个仅含提示的
   * 文件在两者中都不出现。一个真正为空的文件在其标题保留时会被计入，
   * 因为该标题传达了“该指令存在且无内容”这一事实。
   */
  represented: LoadedInstructionFile[]
}

/** 持久化于模型可见提示文本之外的结构化动态状态。 */
export interface AgentInstructionChange {
  action: 'set' | 'replace' | 'remove'
  scope: string
  path: string
  digest?: string
}

/** 一次状态转换，连同用于渲染它的内容。 */
export interface ChangeRenderItem {
  change: AgentInstructionChange
  file: LoadedInstructionFile
}

interface RenderStyle {
  intro: string
  section(file: LoadedInstructionFile): string
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= maxBytes) return value
  let end = Math.max(0, Math.trunc(maxBytes))
  // 若首个被排除的字节是 UTF-8 续接字节，则预算切穿了该码点。
  // 回退到它的首字节并同样将其排除。
  while (end > 0 && (bytes.readUInt8(end) & 0xc0) === 0x80) {
    end -= 1
  }
  return bytes.subarray(0, end).toString('utf8')
}

function escapeInstructionFrameBody(body: string): string {
  return body.replaceAll(SYSTEM_REMINDER_CLOSE, '<\\/system-reminder>')
}

function sectionText(file: LoadedInstructionFile): string {
  return `Instructions from: ${file.displayPath}\n\n${file.content}`
}

/** 标识 harness 主目录用户全局指令作用域的目录分量。 */
export const USER_GLOBAL_DIRECTORY = 'user-global'

/**
 * 标识共享 agents 根目录用户全局作用域的目录分量。
 *
 * 它是一个独立的作用域，因此 harness 主目录文件保留了早期会话记录的
 * 作用域键，而 {@link instructionCandidateGroup} 仍将两个根目录作为
 * 一个候选组去重。
 */
export const AGENTS_GLOBAL_DIRECTORY = 'agents-global'

/**
 * 有序的用户全局作用域目录。
 *
 * 发现、基线对账与去重都按此顺序迭代，因此 harness 主目录始终是
 * 决定与共享 agents 根目录内容重复的那一个候选。
 */
export const USER_GLOBAL_DIRECTORIES = [USER_GLOBAL_DIRECTORY, AGENTS_GLOBAL_DIRECTORY] as const

/**
 * 每个用户全局根目录下、用户全局指令文件的文件名。
 * 发现（`<root>/<name>`）与对账（用户全局作用域键的候选分量）都以此名称为键，
 * 因此它集中在一处：倘若两者出现分歧，用户全局指令就会被加载却永远无法对账。
 */
export const USER_GLOBAL_FILE = 'AGENTS.md'

/**
 * 从面向模型的路径派生出逻辑指令作用域。
 * @param displayPath - 项目相对或用户全局的指令路径。
 * @returns `user-global`、`agents-global`、`.`，或所属的项目相对目录。
 */
export function scopeForDisplayPath(displayPath: string): string {
  if (displayPath === `${DEFAULT_DSH_HOME_DISPLAY}/${USER_GLOBAL_FILE}`
    || displayPath === `$${DSH_HOME_ENV}/${USER_GLOBAL_FILE}`) return USER_GLOBAL_DIRECTORY
  if (displayPath === `${DEFAULT_AGENTS_HOME_DISPLAY}/${USER_GLOBAL_FILE}`
    || displayPath === `$${AGENTS_HOME_ENV}/${USER_GLOBAL_FILE}`) return AGENTS_GLOBAL_DIRECTORY
  return dirname(displayPath)
}

/**
 * 某个已解码的作用域目录是否为两个用户全局根目录之一。
 * @param directory - `user-global`、`agents-global`、`.`，或一个项目相对目录。
 * @returns 对于 harness 主目录与共享 agents 根目录作用域为 true。
 */
export function isUserGlobalDirectory(directory: string): boolean {
  return directory === USER_GLOBAL_DIRECTORY || directory === AGENTS_GLOBAL_DIRECTORY
}

/**
 * 某个已解码作用域目录的候选组。
 *
 * harness 主目录与共享 agents 根目录是一个用户全局候选组的有序候选：
 * 相同的裁剪内容只会渲染一次，而不可观测的候选会保留其组的最后良好状态。
 * 每个项目目录都构成自己的组。
 * @param directory - `user-global`、`agents-global`、`.`，或一个项目相对目录。
 * @returns 两个用户全局根目录共享的组键，或该目录自身。
 */
export function instructionCandidateGroup(directory: string): string {
  return directory === AGENTS_GLOBAL_DIRECTORY ? USER_GLOBAL_DIRECTORY : directory
}

/** 被 {@link scopeForDisplayPath} 视为用户全局作用域（而非项目路径）的目录名。 */
const RESERVED_SCOPE_DIRECTORIES: ReadonlySet<string> = new Set(USER_GLOBAL_DIRECTORIES)

/**
 * 使一个项目相对路径避开用户全局作用域命名空间。
 *
 * 一个名称等于用户全局作用域目录的项目目录，否则会被解析到全局根目录用于探测，
 * 并加入全局候选组用于去重。用前导 `.` 转义该冲突，可使文件停留在自身
 * 的项目作用域中。
 * @param relativePath - 使用平台分隔符的、相对于项目根目录的路径。
 * @returns 路径；当其首个分量发生冲突时，带有一个前导 `.` 分量。
 */
export function escapeProjectDisplayPath(relativePath: string): string {
  const separatorIndex = relativePath.search(/[\\/]/)
  const first = separatorIndex < 0 ? relativePath : relativePath.slice(0, separatorIndex)
  return RESERVED_SCOPE_DIRECTORIES.has(first) ? `.${sep}${relativePath}` : relativePath
}

const SCOPE_SEPARATOR = '\u0000'

/**
 * 为单个指令候选文件组合出对账键。
 * 每个被加载的候选都被独立追踪，因此该键将一个逻辑目录与确切的候选文件名
 * 通过 NUL 分隔符配对，而任何目录路径或文件名都无法包含该分隔符。
 * 于是同一目录下的不同候选（`AGENTS.md` 与 `CLAUDE.md`、基础文件与其
 * `.local` 叠加层）在按作用域键索引的状态映射中永远不会冲突。
 * @param directory - `user-global`、`agents-global`、`.`，或一个项目相对目录。
 * @param candidateName - 该目录内的指令文件名。
 * @returns 按候选的逻辑作用域键。
 */
export function candidateScopeKey(directory: string, candidateName: string): string {
  return `${directory}${SCOPE_SEPARATOR}${candidateName}`
}

/**
 * 为已加载的指令文件派生出按候选的作用域键。
 * @param displayPath - 项目相对或用户全局的指令路径。
 * @returns 将该文件目录与其名称配对的作用域键。
 */
export function instructionScopeKey(displayPath: string): string {
  return candidateScopeKey(scopeForDisplayPath(displayPath), basename(displayPath))
}

/**
 * 还原 {@link candidateScopeKey} 所编码的目录与候选名。
 * @param scope - 一个按候选的作用域键。
 * @returns 目录作用域及其内的候选文件名。
 */
export function decodeScopeKey(scope: string): { directory: string; candidateName: string } {
  const separator = scope.indexOf(SCOPE_SEPARATOR)
  /* v8 ignore next -- every scope key is produced by candidateScopeKey, which always inserts the separator. */
  if (separator < 0) return { directory: scope, candidateName: '' }
  return { directory: scope.slice(0, separator), candidateName: scope.slice(separator + 1) }
}

const ADDITIONAL_INSTRUCTIONS_GUIDANCE = 'Use them as guidance when relevant; more specific instructions take precedence. '
  + 'They do not override system, developer, or direct user instructions.'

function additionalSectionText(file: LoadedInstructionFile): string {
  const scope = scopeForDisplayPath(file.displayPath)
  // 用户全局作用域目录是一个内部对账键，因此它绝不可进入这句面向模型的句子。
  const applicability = isUserGlobalDirectory(scope)
    ? 'These user-global instructions apply to all work.'
    : `These instructions apply to work under \`${scope}\`.`
  return [
    `Additional instructions from: ${file.displayPath}`,
    '',
    `${applicability} ${ADDITIONAL_INSTRUCTIONS_GUIDANCE}`,
    '',
    file.content,
  ].join('\n')
}

const BASELINE_RENDER_STYLE: RenderStyle = { intro: AGENT_INSTRUCTIONS_INTRO, section: sectionText }

function baselineRenderStyle(files: LoadedInstructionFile[], replacePreviousBaseline: boolean | undefined): RenderStyle {
  if (replacePreviousBaseline !== true) return BASELINE_RENDER_STYLE
  return {
    ...BASELINE_RENDER_STYLE,
    intro: files.length === 0
      ? EMPTY_REPLACEMENT_AGENT_INSTRUCTIONS_INTRO
      : REPLACEMENT_AGENT_INSTRUCTIONS_INTRO,
  }
}

function changedSectionText(item: ChangeRenderItem): string {
  const { change, file } = item
  if (change.action === 'set') return additionalSectionText(file)
  if (change.action === 'remove') {
    return `Instructions removed: ${change.path}\n\nThe previously loaded instructions from this file no longer apply.`
  }
  return [
    `Updated instructions from: ${change.path}`,
    '',
    'This file changed after it was loaded. Use the following content instead of the previously loaded instructions from this file.',
    '',
    file.content,
  ].join('\n')
}

/**
 * 渲染一批对账，并仅保留能够容纳的转场。
 * @param items - 有序的状态转场与当前文件内容。
 * @param maxBytes - 渲染批次所允许的最大 UTF-8 字节数。
 * @returns 有界的提示文本，以及它实际所代表的转场。
 */
export function renderInstructionChanges(
  items: ChangeRenderItem[],
  maxBytes: number,
): { text: string; changes: AgentInstructionChange[] } {
  const byAbsolutePath = new Map(items.map(item => [item.file.absolutePath, item]))
  const style: RenderStyle = {
    intro: '',
    section(file) {
      const item = byAbsolutePath.get(file.absolutePath)
      /* v8 ignore next -- the renderer receives exactly the files used to construct this map. */
      return item === undefined ? '' : changedSectionText({ ...item, file })
    },
  }
  const rendered = renderInstructionContext(items.map(item => item.file), maxBytes, style)
  const represented = new Set(rendered.represented.map(file => file.absolutePath))
  return {
    text: rendered.text,
    changes: items
      .filter(item => represented.has(item.file.absolutePath))
      .map(item => item.change),
  }
}

function markerText(maxBytes: number, omitted: InstructionFile[], truncated: TruncatedInstruction[]): string {
  if (omitted.length === 0 && truncated.length === 0) return ''
  const parts: string[] = []
  if (omitted.length > 0) {
    parts.push(`omitted ${omitted.map(file => file.displayPath).join(', ')}`)
  }
  if (truncated.length > 0) {
    parts.push(`truncated ${truncated.map(item => `${item.displayPath} from ${item.originalBytes} to ${item.includedBytes} bytes`).join(', ')}`)
  }
  return `Workspace instruction budget ${maxBytes} bytes: ${parts.join('; ')}`
}

function buildInstructionText(
  files: LoadedInstructionFile[],
  maxBytes: number,
  omitted: InstructionFile[],
  truncated: TruncatedInstruction[],
  style: RenderStyle,
): string {
  const marker = markerText(maxBytes, omitted, truncated)
  const body = [marker, style.intro, ...files.map(file => style.section(file))].filter(block => block.length > 0)
  // 此生产者拥有完整的 <system-reminder> 框架。Session 不添加任何
  // 包装；参见 packages/core/session/README.md 中的派生历史。
  return [SYSTEM_REMINDER_OPEN, escapeInstructionFrameBody(body.join('\n\n')), SYSTEM_REMINDER_CLOSE].join('\n')
}

function withTruncatedContent(file: LoadedInstructionFile, includedBytes: number): LoadedInstructionFile {
  return { ...file, content: truncateUtf8(file.content, includedBytes) }
}

function truncateToFit(
  file: LoadedInstructionFile,
  includedFiles: LoadedInstructionFile[],
  maxBytes: number,
  omitted: InstructionFile[],
  style: RenderStyle,
): LoadedInstructionFile {
  const originalBytes = byteLength(file.content)
  let low = 0
  let high = originalBytes
  let best = withTruncatedContent(file, 0)
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const candidate = withTruncatedContent(file, mid)
    const truncated = [{ displayPath: file.displayPath, originalBytes, includedBytes: byteLength(candidate.content) }]
    const text = buildInstructionText([...includedFiles, candidate], maxBytes, omitted, truncated, style)
    if (byteLength(text) <= maxBytes) {
      best = candidate
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return best
}

function renderInstructionContext(
  files: LoadedInstructionFile[],
  maxBytes: number,
  style: RenderStyle,
): RenderedInstructionContext {
  if (maxBytes <= 0 || !Number.isFinite(maxBytes)) {
    return { text: '', omitted: files, truncated: [], represented: [] }
  }

  const fullText = buildInstructionText(files, maxBytes, [], [], style)
  if (byteLength(fullText) <= maxBytes) {
    return { text: fullText, omitted: [], truncated: [], represented: files }
  }

  for (let start = 1; start < files.length; start += 1) {
    const included = files.slice(start)
    const omitted = files.slice(0, start).map(file => ({ absolutePath: file.absolutePath, displayPath: file.displayPath }))
    const suffixText = buildInstructionText(included, maxBytes, omitted, [], style)
    if (byteLength(suffixText) <= maxBytes) return { text: suffixText, omitted, truncated: [], represented: included }
  }

  const mostSpecific = files.at(-1)
  /* v8 ignore next -- callers only reach this after a non-empty fullText was built. */
  if (mostSpecific === undefined) return { text: '', omitted: [], truncated: [], represented: [] }
  const omitted = files.slice(0, -1).map(file => ({ absolutePath: file.absolutePath, displayPath: file.displayPath }))
  const originalBytes = byteLength(mostSpecific.content)

  for (const candidateStyle of [style, { ...style, intro: COMPACT_AGENT_INSTRUCTIONS_INTRO }]) {
    const truncatedFile = truncateToFit(mostSpecific, [], maxBytes, omitted, candidateStyle)
    const includedBytes = byteLength(truncatedFile.content)
    const truncated = [{
      displayPath: mostSpecific.displayPath,
      originalBytes,
      includedBytes,
    }]
    const text = buildInstructionText([truncatedFile], maxBytes, omitted, truncated, candidateStyle)
    if (byteLength(text) <= maxBytes) {
      const represented = includedBytes > 0 || originalBytes === 0 ? [mostSpecific] : []
      return { text, omitted, truncated, represented }
    }
  }

  const truncated = [{
    displayPath: mostSpecific.displayPath,
    originalBytes,
    includedBytes: 0,
  }]
  const compactNotice = escapeInstructionFrameBody(markerText(maxBytes, omitted, truncated))
  const compactWithHeading = escapeInstructionFrameBody(
    [compactNotice, style.section(withTruncatedContent(mostSpecific, 0))].join('\n\n'),
  )
  if (byteLength(compactWithHeading) <= maxBytes) {
    const represented = originalBytes === 0 ? [mostSpecific] : []
    return { text: compactWithHeading, omitted, truncated, represented }
  }
  const text = byteLength(compactNotice) <= maxBytes ? compactNotice : truncateUtf8(compactNotice, maxBytes)
  return { text, omitted, truncated, represented: [] }
}

/**
 * 渲染一份基线，连同在其中被语义代表的确切源文件。
 * @param files - 从最宽泛到最具体排序的已加载文件。
 * @param options - 渲染字节预算，以及该基线是否取代某个可见的前驱。
 * @returns 有界的公开渲染结果，以及保留内容的文件（包含真正为空的文件）。
 * @internal
 */
export function renderAgentInstructionSet(
  files: LoadedInstructionFile[],
  options: { maxBytes: number; replacePreviousBaseline?: boolean },
): { rendered: RenderedAgentInstructions; included: LoadedInstructionFile[] } {
  const style = baselineRenderStyle(files, options.replacePreviousBaseline)
  const { represented, ...rendered } = renderInstructionContext(files, options.maxBytes, style)
  return { rendered, included: represented }
}

/**
 * 以确定性的优先级预算渲染基线指令链。
 * @param files - 从最宽泛到最具体排序的已加载文件。
 * @param options - 渲染字节预算，以及该基线是否取代某个可见的前驱。
 * @returns 有界的基线提示文本与预算诊断信息。
 */
export function renderAgentInstructions(
  files: LoadedInstructionFile[],
  options: { maxBytes: number; replacePreviousBaseline?: boolean },
): RenderedAgentInstructions {
  return renderAgentInstructionSet(files, options).rendered
}
