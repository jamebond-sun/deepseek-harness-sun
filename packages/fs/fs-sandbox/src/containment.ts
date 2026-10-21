/**
 * 文件系统沙箱的路径包含机制。规范拼写走快速的词法比较路径；对于 Windows 8.3 短名与大小写
 * 这类别名等价的根，则由文件系统同一性提供保守的回退。
 * @module @deepseek-ai/dsh-fs-sandbox/containment
 */

import type { BigIntStats } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, sep } from 'node:path'

const MISSING_CODES: ReadonlySet<NodeJS.ErrnoException['code']> = new Set(['ENOENT', 'ENOTDIR'])

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return MISSING_CODES.has(code)
}

function comparablePath(path: string, caseSensitive: boolean): string {
  return caseSensitive ? path : path.toLowerCase()
}

function isLexicallyUnder(path: string, root: string, caseSensitive: boolean): boolean {
  const comparableTarget = comparablePath(path, caseSensitive)
  const comparableRoot = comparablePath(root, caseSensitive)
  if (comparableTarget === comparableRoot) return true
  const prefix = comparableRoot.endsWith(sep) ? comparableRoot : comparableRoot + sep
  return comparableTarget.startsWith(prefix)
}

async function statIfPresent(path: string): Promise<BigIntStats | undefined> {
  try {
    return await stat(path, { bigint: true })
  } catch (error: unknown) {
    /* v8 ignore else -- 非"不存在"的 stat 失败需要宿主权限或 I/O 故障，且 resolve 已到达该祖先之后才会发生。 */
    if (isMissing(error)) return undefined
    /* v8 ignore next -- 需要宿主权限或 I/O 故障，且 resolve 已到达该祖先之后才会发生。 */
    throw error
  }
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

/**
 * 判断一个规范目标是否就是某个可写根，或位于其下。词法快路径处理常规的规范拼写。
 * 当拼写不一致时，沿目标已存在的祖先逐级回溯并与该根比较文件系统同一性；这样能识别
 * Windows 长名/8.3 别名与大小写差异，又不必把包含性降级为文本近似的比较。
 * @param path - 规范的目标键，其末尾可以带一段尚不存在的后缀。
 * @param root - 规范的可写根。
 * @param caseSensitive - 词法比较是否区分大小写；默认为受支持平台所用的宿主文件系统约定。
 * @returns 目标是否为该根或其后代。
 */
export async function isPathUnder(
  path: string,
  root: string,
  caseSensitive = process.platform !== 'win32',
): Promise<boolean> {
  if (isLexicallyUnder(path, root, caseSensitive)) return true

  const rootInfo = await statIfPresent(root)
  if (!rootInfo) return false

  let ancestor = path
  while (true) {
    const ancestorInfo = await statIfPresent(ancestor)
    if (ancestorInfo && sameIdentity(ancestorInfo, rootInfo)) return true
    const parent = dirname(ancestor)
    if (parent === ancestor) return false
    ancestor = parent
  }
}
