/**
 * 纯粹的读取展示：把提供者解码出的文本转成有界的、带行号的窗口以及面向模型的信封。
 * 分块扫描会为当前行设限，因此即便是一行没有换行的超长行，也无法无界地增长内存。
 * @module @deepseek-ai/dsh-tool-fs/read-render
 */

import { FsError } from '@deepseek-ai/dsh-fs'

/** 单行返回的默认最大字符数（即 `readMaxLineLength` 配置）。 */
export const READ_MAX_LINE_LENGTH = 2000

/** 所选文件行返回的默认最大字节数（即 `readMaxBytes` 配置）。 */
export const READ_MAX_BYTES = 50 * 1024

/** 已解析的读取窗口。调用方在调用之前已应用其默认值/上限。 */
export interface ReadWindow {
  /** 返回的 1 基首行行号。 */
  offset: number
  /** 返回的最大行数。 */
  limit: number
  /** 单行返回的最大字符数；超出部分截断并附带后缀。 */
  maxLineLength: number
  /** 所选输出的最大字节数；超出即停止扫描并标记 `truncatedByBytes`。 */
  maxBytes: number
}

/** 从文本文件返回的一行。 */
export interface FileTextLine {
  /** 文件中的 1 基行号。 */
  number: number
  /** 不含结尾换行符的行文本。 */
  text: string
}

/** {@link buildWindow} 依据文件解码文本产出的带窗口结果。 */
export interface WindowResult {
  /** 已编号的返回行。 */
  lines: FileTextLine[]
  /** 文件中的精确总行数。 */
  totalLines: number
  /** 所选输出是否触及字节上限。 */
  truncatedByBytes: boolean
}

/** 一次有界文本读取的结果 —— 即 {@link formatReadOutput} 渲染的对象。 */
export interface FileReadOutcome {
  /** 请求的 1 基首行行号。 */
  offset: number
  /** 已编号的返回行。 */
  lines: FileTextLine[]
  /** 文件中的精确总行数。 */
  totalLines: number
  /** 所选输出是否触及字节上限。 */
  truncatedByBytes?: true
}

interface WindowAccumulator {
  lines: FileTextLine[]
  totalLines: number
  outputBytes: number
  truncatedByBytes: boolean
}

function newAccumulator(): WindowAccumulator {
  return { lines: [], totalLines: 0, outputBytes: 0, truncatedByBytes: false }
}

function truncateLine(line: string, maxLineLength: number): string {
  return line.length > maxLineLength ? `${line.substring(0, maxLineLength)}... (line truncated to ${maxLineLength} chars)` : line
}

function lineByteSize(line: string, currentLineCount: number): number {
  return Buffer.byteLength(line, 'utf8') + (currentLineCount > 0 ? 1 : 0)
}

function consumeLine(acc: WindowAccumulator, rawLine: string, request: ReadWindow): void {
  acc.totalLines += 1
  if (acc.truncatedByBytes || acc.totalLines < request.offset || acc.lines.length >= request.limit) return

  const text = truncateLine(rawLine, request.maxLineLength)
  const bytes = lineByteSize(text, acc.lines.length)
  if (acc.outputBytes + bytes > request.maxBytes) {
    acc.truncatedByBytes = true
    return
  }
  acc.outputBytes += bytes
  acc.lines.push({ number: acc.totalLines, text })
}

function stripCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

function finish(acc: WindowAccumulator, request: ReadWindow, displayPath: string): WindowResult {
  if (!acc.truncatedByBytes && request.offset > acc.totalLines && !(acc.totalLines === 0 && request.offset === 1)) {
    throw new FsError(`offset ${request.offset} is out of range for "${displayPath}" (${acc.totalLines} lines)`, 'FS_NOT_FOUND')
  }
  return { lines: acc.lines, totalLines: acc.totalLines, truncatedByBytes: acc.truncatedByBytes }
}

/**
 * 由流式或整文件的分块构建出一个窗口，在强制行数与字节上限的同时仍扫描出精确的总行数，
 * 并在请求的 offset 越过文件末尾时抛出 `FS_NOT_FOUND`。
 * @param chunks - 按文件顺序排列的已解码文本分块；分块边界不携带任何含义。
 * @param request - 已解析的窗口；调用方已应用其默认值与上限。
 * @param displayPath - 面向调用方、用于 offset 越界错误的路径。
 * @returns 已编号的窗口行、所见的总行数，以及触及字节上限的截断标记。
 */
export async function buildWindow(
  chunks: AsyncIterable<string> | Iterable<string>,
  request: ReadWindow,
  displayPath: string,
): Promise<WindowResult> {
  const acc = newAccumulator()
  // 比截断点多保留一个字符，就足以证明某一行溢出了。
  const lineBufferCap = request.maxLineLength + 1
  let lineBuffer = ''

  function appendToLineBuffer(segment: string): void {
    if (lineBuffer.length >= lineBufferCap) return
    lineBuffer += segment
    if (lineBuffer.length > lineBufferCap) lineBuffer = lineBuffer.slice(0, lineBufferCap)
  }

  function flushLine(): void {
    consumeLine(acc, stripCarriageReturn(lineBuffer), request)
    lineBuffer = ''
  }

  for await (const chunk of chunks) {
    let startPos = 0
    let newlinePos: number
    while ((newlinePos = chunk.indexOf('\n', startPos)) !== -1) {
      appendToLineBuffer(chunk.slice(startPos, newlinePos))
      flushLine()
      startPos = newlinePos + 1
    }
    appendToLineBuffer(chunk.slice(startPos))
  }
  if (lineBuffer.length > 0) flushLine()
  return finish(acc, request, displayPath)
}

/**
 * 把一次读取结果格式化为一个 OpenCode 风格的、带行号的文本块正文。
 * @param displayPath - 由后端解析、渲染在信封 `<path>` 元素中的路径。
 * @param outcome - 待渲染的带窗口读取结果。
 * @returns 面向模型的信封：编号后的行，外加一段续读或文件结束的脚注。
 */
export function formatReadOutput(displayPath: string, outcome: FileReadOutcome): string {
  const endLine = outcome.lines.at(-1)?.number ?? Math.max(0, outcome.offset - 1)
  let footer: string
  if (outcome.truncatedByBytes) {
    footer = `(Output capped. Showing lines ${outcome.offset}-${endLine}. Use offset=${endLine + 1} to continue.)`
  } else if (endLine < outcome.totalLines) {
    footer = `(Showing lines ${outcome.offset}-${endLine} of ${outcome.totalLines}. Use offset=${endLine + 1} to continue.)`
  } else {
    footer = `(End of file - total ${outcome.totalLines} lines)`
  }
  const body = outcome.lines.length > 0
    ? `${outcome.lines.map(line => `${line.number}: ${line.text}`).join('\n')}\n\n${footer}`
    : footer
  return `<path>${displayPath}</path>
<type>file</type>
<content>
${body}
</content>`
}

/**
 * 依据读取路径的文件扩展名派生出持久化的 `lang` 提示。`@deepseek-ai/dsh-util-code-language`
 * 里的共享表掌管被识别的后缀名与路径规则（两种分隔符、以开头的点作为扩展名分隔符，
 * 以及原型键安全性）；`readLangHintForPath` 在其上投影出读取卡片使用的短 id，
 * 因此某个已记录在会话中的后缀值会保持逐字节不变，而其他后缀则使用其语言的短名。
 * @param path - 本次读取上报的、面向模型的路径。
 * @returns 持久化的语言提示；扩展名没有映射时返回 `undefined`。
 */
export { readLangHintForPath as langFromPath } from '@deepseek-ai/dsh-util-code-language'

/**
 * `read` 工具私有的 `tool/result` `meta` 载荷：有能力的 UI 会把它渲染成代码视图的那个
 * 结构化行号窗口。它以不透明形式（作为 `unknown`）挂在工具结果上并随会话日志持久化 ——
 * 因此它必须是可 JSON 序列化的（会话在 `append` 时会校验这一点），这样当原始的结构化输出
 * 不再在线路上时，`presentResult` 仍能在重放时复现这张读取卡片。产出该结果的工具拥有并
 * 收窄这个不透明结构。
 */
export interface FsReadMeta {
  /** 被读取文件的、面向模型的路径。 */
  path: string
  /** 窗口请求的 1 基首行行号，即使 `lines` 为空也保留。 */
  offset: number
  /** 返回窗口中的行，各行保留其在文件中的行号。 */
  lines: FileTextLine[]
  /** 文件中的精确总行数。 */
  totalLines: number
  /** 由扩展名得出的语法高亮语言提示；纯文本时省略。 */
  lang?: string
}

/**
 * `value` 是否为合法的 {@link FileTextLine}（从不透明的 `meta` 做防御性收窄）。
 * `number` 必须是 1 基的整数行号，因为由 0、小数或非有限行号渲染出的卡片会违反
 * 读取窗口所承诺的 1 基编号契约。
 */
function isFileTextLine(value: unknown): value is FileTextLine {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { number, text } = value as Record<string, unknown>
  return typeof number === 'number' && Number.isInteger(number) && number >= 1 && typeof text === 'string'
}

/**
 * 把不透明的实时或重放结果元数据收窄为一个结构化的读取窗口。元数据格式有误时返回
 * `undefined`，使展示层可以回退到通用文本卡片，而不是在重放期间抛错。除形状之外，
 * 还会对"类型正确但越界"的重放 JSON 强制读取窗口的语义契约：`offset` 必须是 1 基整数，
 * `totalLines` 必须是非负整数，每个行号必须是不小于 `offset` 的 1 基整数，
 * 行号必须严格递增，且任何行号都不得超过 `totalLines`。任何违反都退化为通用回退方案，
 * 而不是发出一张编号错乱或计数虚高的卡片。
 * @param meta - 结果元数据。
 * @returns 已校验的读取窗口；数据缺失、格式有误或语义非法时为 `undefined`。
 */
export function readMetaFromMeta(meta: unknown): FsReadMeta | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const { path, offset, lines, totalLines, lang } = meta as Record<string, unknown>
  if (typeof path !== 'string' || typeof totalLines !== 'number' || typeof offset !== 'number') return undefined
  if (!Number.isInteger(offset) || offset < 1) return undefined
  if (!Number.isInteger(totalLines) || totalLines < 0) return undefined
  if (!Array.isArray(lines) || !lines.every(isFileTextLine)) return undefined
  if (lang !== undefined && typeof lang !== 'string') return undefined
  let previous = offset - 1
  for (const { number } of lines) {
    if (number <= previous || number > totalLines) return undefined
    previous = number
  }
  return { path, offset, lines, totalLines, ...lang === undefined ? {} : { lang } }
}
