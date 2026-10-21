/**
 * 由终端与 Web 客户端共享的、浏览器安全的 `@file` 标记语法。
 *
 * @module @deepseek-ai/dsh-file-reference/grammar
 */

import type { FileReferenceCandidate } from './types.ts'

/** 结束于编辑器光标的、处于活动状态的 `@` 标记。 */
export interface ActiveAtToken {
  /** 用户接受补全时被替换的完整标记。 */
  prefix: string
  /** `@` 或 `@"` 之后的路径查询。 */
  query: string
  /** 用户是否打开了带引号的路径。 */
  quoted: boolean
}

/**
 * 在光标处提取一个 `@path` 或 `@"path with spaces` 标记。位于另一个标记
 * 内部的 `@`（例如电子邮件地址）不是补全触发器。
 * @param line - 当前编辑器行。
 * @param cursorCol - 该行内的光标列。
 * @returns 活动标记；当不在 `@` 标记内时为 `undefined`。
 */
export function activeAtToken(line: string, cursorCol: number): ActiveAtToken | undefined {
  const beforeCursor = line.slice(0, cursorCol)
  const quoted = /(?:^|\s)(@"([^"]*))$/u.exec(beforeCursor)
  if (quoted?.[1] !== undefined && quoted[2] !== undefined) {
    return { prefix: quoted[1], query: quoted[2], quoted: true }
  }
  const plain = /(?:^|\s)(@([^\s]*))$/u.exec(beforeCursor)
  if (plain?.[1] === undefined || plain[2] === undefined) return undefined
  return { prefix: plain[1], query: plain[2], quoted: false }
}

/**
 * 将一个被选中的路径格式化为提示文本。空白使用带引号的 `@"path"` 语法；
 * 带引号的目录在其尾部斜杠之后仍保持引号打开，以便补全能再下钻一层。
 * @param candidate - 被选中的文件或目录。
 * @param preserveQuote - 即使并非必要，也保留一个显式打开的引号。
 * @returns 插入值；当编辑器语法无法安全表示某路径时为 `undefined`。
 */
export function formatFileMention(
  candidate: FileReferenceCandidate,
  preserveQuote: boolean,
): string | undefined {
  const path = candidate.kind === 'directory' ? `${candidate.path}/` : candidate.path
  if (/[\u0000-\u001f\u007f-\u009f"]/u.test(path)) return undefined
  const quoted = preserveQuote || /\s/u.test(path)
  if (!quoted) return `@${path}`
  if (candidate.kind === 'directory') return `@"${path}`
  return `@"${path}"`
}
