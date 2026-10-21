/** 被更改文件的路径分类与显示形式。 */
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'

/**
 * 原生相对路径的、以斜杠分隔的形式。
 * @param path - 原生路径。
 * @returns 使用 `/` 分隔符的同一路径。
 */
export function toPosix(path: string): string {
  return path.split(sep).join('/')
}

/**
 * `path` 是否为 `root` 或位于其之下。
 * @param root - 绝对目录。
 * @param path - 待测试的绝对路径。
 * @returns 对根本身及其每个后代为真。
 */
export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * 工作区写入沙箱所授予的临时目录的规范拼写：宿主的 `/tmp` 与
 * 平台临时区域，各自还以其符号链接解析后的形式出现，从而 `/tmp` 与
 * `/private/tmp` 能被同等匹配。
 * @param candidates - 待规范化的目录。
 * @returns 绝对的目录路径。
 */
export async function temporaryRoots(candidates: readonly string[] = ['/tmp', tmpdir()]): Promise<string[]> {
  const roots = new Set<string>()
  for (const root of candidates) {
    roots.add(root)
    roots.add(await canonicalPath(root))
  }
  return [...roots]
}

/**
 * 符号链接解析后的路径。尚不存在的路径通过其最近的
 * 现存祖先解析，从而一个经由目录符号链接创建的文件在
 * 其存在前后具有相同的规范拼写。
 * @param path - 绝对路径。
 * @returns git 为该路径报告的规范拼写。
 */
export async function canonicalPath(path: string): Promise<string> {
  const missing: string[] = []
  let head = path
  while (true) {
    try {
      return join(await realpath(head), ...missing)
    } catch {
      // 缺失或不可读的组件在其最近的、可解析的祖先之下按词法保留；
      // 一个除根之外没有现存祖先的路径则完全保留其拼写。
      const parent = dirname(head)
      if (parent === head || dirname(parent) === parent) return path
      missing.unshift(basename(head))
      head = parent
    }
  }
}

/**
 * 一个文件是否位于临时根之下——模型在那里存放临时性工作。
 * @param path - 绝对文件路径。
 * @param roots - {@link temporaryRoots}。
 * @returns 对永不进入变更摘要的临时路径为真。
 */
export function isTemporaryPath(path: string, roots: readonly string[]): boolean {
  return roots.some(root => isInside(root, path))
}

/**
 * 一个被更改文件的排序键与标签；参见 `WorkspaceChangedFile.display`。
 * @param absolute - 规范的绝对文件路径。
 * @param cwd - 规范的 Session 工作目录。
 * @param root - 仓库顶层目录。
 * @param home - 规范的 home 目录；为空则跳过 `~` 形式。
 * @returns 以斜杠分隔的显示路径。
 */
export function displayPathOf(absolute: string, cwd: string, root: string, home: string): string {
  if (isInside(cwd, absolute) || isInside(root, absolute)) return toPosix(relative(cwd, absolute))
  if (home !== '' && isInside(home, absolute)) return `~/${toPosix(relative(home, absolute))}`
  return toPosix(absolute)
}

/**
 * 持久的 `path` 字段：在工作目录内为相对路径，在别处为绝对路径。
 * @param absolute - 规范的绝对文件路径。
 * @param cwd - 规范的 Session 工作目录。
 * @returns Web 客户端借以打开文件的路径。
 */
export function durablePathOf(absolute: string, cwd: string): string {
  return isInside(cwd, absolute) ? toPosix(relative(cwd, absolute)) : absolute
}

/**
 * 显示路径的码元顺序，它将 `../` 与绝对路径排在字母之前，
 * 并与 git 自身对相对路径的列出顺序一致。
 * @param a - 第一个文件。
 * @param b - 第二个文件。
 * @returns 负数、零或正数，依 `Array.prototype.sort` 之所期。
 */
export function compareDisplay(a: { display: string }, b: { display: string }): number {
  return a.display < b.display ? -1 : a.display > b.display ? 1 : 0
}
