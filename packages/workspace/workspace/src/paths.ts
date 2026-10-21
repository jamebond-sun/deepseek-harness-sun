/**
 * 用于工作区身份的路径规范化。
 * @module @deepseek-ai/dsh-workspace/src/paths
 */

import { realpath } from 'node:fs/promises'
import { posix, win32 } from 'node:path'

/**
 * 检查一个路径是否在不经过进程 cwd 或当前驱动器解析的情况下
 * 命名一个固定的 Host 位置。
 * @param path - 候选的工作区路径。
 * @param platform - Host 平台；可注入以进行确定性路径测试。
 * @returns 该路径在该平台上是否完全限定。
 */
export function fullyQualifiedWorkspacePath(
  path: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'win32') return posix.isAbsolute(path)
  const root = win32.parse(path).root
  return win32.isAbsolute(path) && root !== '\\' && root !== '/'
}

/**
 * 从规范化工作区路径派生一个非空的默认标题。
 * @param path - 规范化工作区路径。
 * @param platform - Host 平台；可注入以进行确定性路径测试。
 * @returns 存在时为其最后一段，否则为完整的根拼写。
 */
export function defaultWorkspaceTitle(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const pathApi = platform === 'win32' ? win32 : posix
  return pathApi.basename(path) || pathApi.parse(path).root
}

/**
 * 通过 `fs.realpath` 规范化一个完全限定的目录路径：末尾斜杠、
 * `..` 段以及符号链接都会被解析。这是本包唯一的唯一性
 * 规范——工作区路径以规范化形式存储，唯一性即规范化路径的
 * 字符串相等（指向已有工作区目录的符号链接会冲突），且附加时的会话 `cwd`
 * 检查也走同一规范。相对路径会在 `realpath` 能够从其 Host cwd 或
 * 当前 Windows 驱动器解析它们之前被拒绝。不存在的路径会以原始的
 * `ENOENT` 拒绝——这正是 `create` 的拒绝路径（工作区必须指向一个已存在的目录）。
 * @param path - 要规范化的路径。
 * @returns 规范化的绝对路径。
 */
export async function realpathNormalize(path: string): Promise<string> {
  if (!fullyQualifiedWorkspacePath(path)) {
    throw new TypeError(`Workspace path is not fully qualified: '${path}'`)
  }
  return await realpath(path)
}
