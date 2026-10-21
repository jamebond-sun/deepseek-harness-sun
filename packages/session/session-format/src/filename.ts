/** 每个按代际寻址的 Session 制品共用的规范原始日志基名。 */

import { sessionFormatVersion } from './json.ts'

const CANONICAL_LOG_FILENAME = /^session(?:\.v([1-9][0-9]*))?\.jsonl$/u

/**
 * 命名某个不可变 Session 格式代际的原始 JSONL 日志。版本零沿用最初的
 * `session.jsonl`；之后的每个代际在 `.jsonl` 后缀前带有小写的数字 `.vN`
 * 部分。
 * @param version - 非负安全整数形式的 Session 格式版本。
 * @returns 规范基名，不含任何压缩后缀。
 */
export function sessionFormatLogFilename(version: number): string {
  const generation = sessionFormatVersion(version, 'Session log generation version')
  return generation === 0 ? 'session.jsonl' : `session.v${generation}.jsonl`
}

/**
 * 读取某个原始 JSONL 日志基名所指代的代际。临时文件名、大写形式、带前导零、
 * `.v0` 以及带压缩后缀的名字都不是规范名。
 * @param filename - 来自 Session 目录或归档的一个基名。
 * @returns 其 Session 格式版本；名字不规范时为 `undefined`。
 */
export function parseSessionFormatLogFilename(filename: string): number | undefined {
  const match = CANONICAL_LOG_FILENAME.exec(filename)
  if (match === null) return undefined
  if (match[1] === undefined) return 0
  const version = Number(match[1])
  return Number.isSafeInteger(version) ? version : undefined
}
