/** 两个整文件文本的行比较，受超时约束，超时时退化为整文件替换。 */
import { structuredPatch } from 'diff'
import type { WorkspaceDiffHunk } from './types.ts'

/** 每次变更周围的上下文行数，即统一差异的默认值。 */
const CONTEXT_LINES = 3

/** 差异块、超时是否使其退化，以及它们所携带的变更行总数。 */
export interface Comparison {
  hunks: WorkspaceDiffHunk[]
  coarse: boolean
  added: number
  deleted: number
}

/**
 * 一侧的文本，每行都已终止，从而最后一行仅凭内容比较，且空文本读作
 * 零行而非一行空行。
 */
function terminated(text: string): string {
  return text === '' || text.endsWith('\n') ? text : `${text}\n`
}

/** 已终止文本的内容行；空文本为零行。 */
function lines(text: string): string[] {
  return text === '' ? [] : text.slice(0, -1).split('\n')
}

/**
 * 逐行比较两个文本。为 null 的一侧表示文件不存在。超过 `timeoutMs` 的
 * 比较会产生一个差异块，删除每一行旧行并添加每一行新行。
 * @param before - 回合开始时的文本，或 null。
 * @param after - 回合结束时的文本，或 null。
 * @param timeoutMs - 行比较可运行的毫秒数。
 * @returns 差异块与总数；两侧内容相同时无差异块。
 */
export function compareText(before: string | null, after: string | null, timeoutMs: number): Comparison {
  const oldText = terminated(before ?? '')
  const newText = terminated(after ?? '')
  const patch = structuredPatch('', '', oldText, newText, undefined, undefined, { context: CONTEXT_LINES, timeout: timeoutMs })
  let hunks: WorkspaceDiffHunk[]
  let coarse = false
  if (patch === undefined) {
    coarse = true
    const oldLines = lines(oldText)
    const newLines = lines(newText)
    hunks = [{
      oldStart: 1, oldLines: oldLines.length,
      newStart: 1, newLines: newLines.length,
      lines: [...oldLines.map(line => `-${line}`), ...newLines.map(line => `+${line}`)],
    }]
  } else {
    hunks = patch.hunks.map(({ oldStart, oldLines, newStart, newLines, lines: body }) =>
      ({ oldStart, oldLines, newStart, newLines, lines: body }))
  }
  let added = 0
  let deleted = 0
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added += 1
      else if (line.startsWith('-')) deleted += 1
    }
  }
  return { hunks, coarse, added, deleted }
}
