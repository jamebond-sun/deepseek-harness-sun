/**
 * `lsp` 工具的纯格式化与坐标转换：从 1 开始与从零开始的 UTF-16 光标互转、按工作区分组的
 * 位置渲染（含 `file:` URI 解析）、完整结果上限约束，以及 UI 呈现。无 I/O——
 * UI 会在实时流式与回放两种情形下调用该呈现器，因此它只依赖工具参数。
 * @module @deepseek-ai/dsh-tool-lsp/render
 */

import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type { LspHover, LspLocation, LspOperation, LspPosition } from '@deepseek-ai/dsh-lsp'
import { posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 工具暴露的四个操作，作为 schema 枚举与校验用的运行时元组。 */
export const LSP_OPERATIONS: readonly LspOperation[] = ['goToDefinition', 'findReferences', 'goToImplementation', 'hover']

/** 追加省略标记之前渲染位置的默认上限。 */
export const DEFAULT_MAX_LOCATIONS = 100

/** 完整渲染工具结果的默认上限，包含截断元信息。 */
export const DEFAULT_MAX_RESULT_CHARS = 16_000

/** 坐标校验之后的合法 `lsp` 参数。 */
export interface LspToolInput {
  readonly operation: LspOperation
  readonly filePath: string
  /** 由从 1 开始的模型坐标转换而来的从零开始 UTF-16 位置。 */
  readonly position: LspPosition
}

/** 原始的、schema 类型化的参数形态。 */
export interface LspToolArgs {
  readonly operation: string
  readonly file_path: string
  readonly line: number
  readonly character: number
}

/**
 * 校验并转换模型参数：`operation` 必须是四个之一；`line`/`character` 是从 1 开始的
 * 正整数，转换为接缝的从零开始位置。
 * @param args - 经 schema 校验的原始参数。
 * @returns 带从零开始位置的合法输入。
 * @throws Error 当操作未知或坐标不是正整数时。
 */
export function parseLspArgs(args: LspToolArgs): LspToolInput {
  if (!isOperation(args.operation)) {
    throw new Error(`operation must be one of ${LSP_OPERATIONS.join(', ')}`)
  }
  if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')
  const line = oneBased(args.line, 'line')
  const character = oneBased(args.character, 'character')
  return {
    operation: args.operation,
    filePath: args.file_path,
    // 模型从 1 开始计数；接缝（与协议）从 0 开始。
    position: { line: line - 1, character: character - 1 },
  }
}

/** 判断一个字符串是否是四个操作之一。 */
function isOperation(value: string): value is LspOperation {
  return (LSP_OPERATIONS as readonly string[]).includes(value)
}

/** 校验一个从 1 开始的坐标是正整数。 */
function oneBased(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer (one-based)`)
  }
  return value
}

/**
 * 渲染按文件分组的位置结果，把每个从零开始的位置换回从 1 开始的
 * `path:line:character` 条目。工作区内的 `file:` URI 变成工作区相对路径；
 * 工作区外的变成由 URI 推导出的绝对路径；非 `file:` URI 保持原样。
 * 应用 `maxLocations`，按条数截断时追加省略标记，然后应用完整结果上限。
 * @param locations - 接缝给出的位置（可能为空）。
 * @param workspaceUri - provider 的规范工作区 `file:` URI。
 * @param maxLocations - 截断前的条数上限。
 * @param maxResultChars - 完整渲染文本的上限，包含截断元信息。
 * @returns 渲染出的文本；没有结果时是一行明确的无结果提示。
 */
export function formatLocations(
  locations: readonly LspLocation[],
  workspaceUri: string,
  maxLocations: number,
  maxResultChars: number,
): string {
  if (locations.length === 0) return boundResult('No results.', maxResultChars, 'locations')
  const shown = locations.slice(0, maxLocations)
  const omitted = locations.length - shown.length
  const grouped = new Map<string, string[]>()
  for (const location of shown) {
    const path = renderUri(location.uri, workspaceUri)
    const line = location.range.start.line + 1
    const character = location.range.start.character + 1
    const entries = grouped.get(path) ?? []
    entries.push(`${path}:${line}:${character}`)
    grouped.set(path, entries)
  }
  const lines: string[] = []
  for (const entries of grouped.values()) lines.push(...entries)
  if (omitted > 0) {
    lines.push(`… ${omitted} more location${omitted === 1 ? '' : 's'} omitted (limit ${maxLocations}).`)
  }
  return boundResult(lines.join('\n'), maxResultChars, 'locations')
}

/**
 * 渲染悬停结果，最后应用 `maxResultChars`，并把其标记保留在上限之内。
 * @param hover - 规范化的悬停内容，没有悬停信息时为 `null`。
 * @param maxResultChars - 完整渲染文本的上限，包含截断元信息。
 * @returns 渲染出的悬停文本；`null` 时是一行明确的无结果提示。
 */
export function formatHover(hover: LspHover | null, maxResultChars: number): string {
  const text = hover === null ? 'No hover information.' : hover.contents
  return boundResult(text, maxResultChars, 'hover')
}

/** 约束完整渲染结果，包含截断提示自身。 */
function boundResult(text: string, maxChars: number, label: string): string {
  if (text.length <= maxChars) return text
  const notice = `\n… ${label} truncated (limit ${maxChars} characters).`
  if (notice.length >= maxChars) return notice.slice(0, maxChars)
  return `${text.slice(0, maxChars - notice.length)}${notice}`
}

/**
 * 解析一个位置 URI，而不套用 harness 宿主的路径规则。合法的 `file:` URI 位于 provider 的
 * 规范工作区 URI 之下时变成工作区相对路径，否则变成由 URI 推导出的绝对路径；
 * 畸形与非 `file:` URI 保持原样。
 * @param uri - 接缝给出的目标 URI。
 * @param workspaceUri - provider 的规范工作区 `file:` URI。
 * @returns 展示路径，或原样的 URI。
 */
export function renderUri(uri: string, workspaceUri: string): string {
  if (!uri.startsWith('file:')) return uri
  let target: URL
  let workspace: URL
  try {
    target = new URL(uri)
    workspace = new URL(workspaceUri)
  } catch {
    return uri
  }
  if (workspace.protocol !== 'file:') return uri
  // `file:` URI 不带自身所处世界的操作系统信息，因此前导的 `/X:` 段
  // 会被读作 Windows 盘符。一个字面上以 `/c:/...` 为根的 POSIX 工作区
  // 会渲染错误（仅影响展示；读取与编辑使用精确的 URI）。
  const drivePath = /^\/[a-z](?::|%3A)/iu
  const windowsWorld = workspace.hostname.length > 0 || drivePath.test(workspace.pathname)
  const targetWindowsWorld = windowsWorld && (target.hostname.length > 0 || drivePath.test(target.pathname))
  const workspacePath = filePath(workspace, windowsWorld)
  const targetPath = filePath(target, targetWindowsWorld)
  if (workspacePath === undefined || targetPath === undefined) return uri
  if (windowsWorld !== targetWindowsWorld) return targetPath
  const path = windowsWorld ? win32 : posix
  const relative = path.relative(workspacePath, targetPath)
  const outside = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
  const rendered = relative === '' ? '.' : outside ? targetPath : relative
  return windowsWorld ? rendered.replaceAll('\\', '/') : rendered
}

/** 解码一个 file URL 到其执行世界，同时把畸形 URL 的失败收束起来。 */
function filePath(url: URL, windows: boolean): string | undefined {
  try {
    const path = fileURLToPath(url, { windows })
    return path.includes('\0') ? undefined : path
  } catch {
    // `fileURLToPath` 会拒绝畸形的转义、authority 与编码后的路径分隔符。
    return undefined
  }
}

/**
 * 一个进行中的 `lsp` 调用的 UI 呈现。使用通用搜索卡片；标题携带操作与从 1 开始的光标，
 * 而 `locations` 聚焦被查询的行。共享的位置形态没有字符列，因此标题保留了列号。
 * @param args - 原始工具参数。
 * @returns 通用的调用视图。
 */
export function presentLspCall(args: LspToolArgs): GenericCallView {
  return {
    card: 'generic',
    kind: 'search',
    title: `LSP ${args.operation} ${args.file_path}:${args.line}:${args.character}`,
    locations: [{ path: args.file_path, line: args.line }],
  }
}
