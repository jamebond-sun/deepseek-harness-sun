/**
 * 浏览器安全的 Workspace 路径与显示辅助工具。
 * @module @deepseek-ai/dsh-util-workspace-path
 */
import { sessionFileAddress } from './file-address.ts'

/** 一个路径是否使用 Windows 盘符或 UNC 前缀。 */
function isWindowsStylePath(value: string): boolean {
  return /^[A-Za-z]:[/\\]/.test(value) || value.startsWith('\\\\')
}

/**
 * 一个路径是否在 Host 接受的任一种写法中是绝对的：POSIX（`/a/b`）或 Windows 盘符或 UNC。
 * @param path - 待分类的路径。
 * @returns 绝对路径为 `true`；工作区相对路径为 `false`。
 */
export function isAbsoluteWorkspacePath(path: string): boolean {
  return path.startsWith('/') || isWindowsStylePath(path)
}

/**
 * 将一个工作区相对路径解析为路径操作所用的、面向 Host 的写法。
 * @param cwd - 已知的 Session 工作区根。
 * @param path - 绝对或工作区相对路径。
 * @returns 当工作区根可用时为绝对路径，否则为原始路径。
 */
export function resolveWorkspacePath(cwd: string | undefined, path: string): string {
  if (isAbsoluteWorkspacePath(path)) return path
  if (cwd === undefined || cwd === '') return path
  const separator = isWindowsStylePath(cwd) && cwd.includes('\\') ? '\\' : '/'
  const base = cwd.replace(/[/\\]+$/, '')
  const relative = path.replace(/^[/\\]+/, '')
  return `${base}${separator}${relative}`
}

/**
 * 缩写 POSIX home 目录用于显示。
 * @param path - 绝对或已经简短的显示路径。
 * @param home - Host 账户 home；缺席则跳过缩写。
 * @returns POSIX home 及其后代显示为 `~` 或 `~/…`，否则为 `path`。
 */
export function abbreviateHomePath(path: string, home?: string): string {
  if (home === undefined || home === '') return path
  if (isWindowsStylePath(path) || isWindowsStylePath(home)) return path
  const root = home.replace(/\/+$/, '')
  if (root === '' || root === '/') return path
  if (path.replace(/\/+$/, '') === root) return '~'
  if (path.startsWith(`${root}/`)) return `~${path.slice(root.length)}`
  return path
}

/**
 * 读取 Workspace 路径的最后一个非空段用于显示。
 * Workspace 标签界面使用此辅助工具，而非另起一个 basename。
 * @param path - 使用 POSIX 或 Windows 分隔符的 Workspace 目录路径。
 * @returns 最后一个段，或对于仅含分隔符的路径为空字符串。
 */
export function workspaceTitleOf(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '')
  const separator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return trimmed.slice(separator + 1)
}

/**
 * 为显示拆分一个路径：直到最后一个分隔符的目录，以及其后的最终段。两种 `/`
 * 和 `\` 都分隔，因此 Windows 路径在其自身段结束处分拆；尾部分隔符先被丢弃，
 * 因此目录路径命名其自身的最后一段。没有分隔符的路径，或仅含分隔符的路径，
 * 全是名称。
 * @param path - 使用 POSIX 或 Windows 分隔符的文件或目录路径。
 * @returns 目录前缀（可能为空）与最后一段。
 */
export function pathPartsOf(path: string): { readonly directory: string; readonly name: string } {
  const trimmed = path.replace(/[/\\]+$/, '')
  if (trimmed === '') return { directory: '', name: path }
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1
  return { directory: trimmed.slice(0, cut), name: trimmed.slice(cut) }
}

export * from './file-address.ts'

/**
 * 调用方所持路径的地址：相对路径，或 Session 工作区内的绝对路径，变为
 * `session` 作用域地址；其外的绝对路径，或工作区根未知的，在该 Session 地址中
 * 保留其绝对路径。
 * @param sessionId - 读取该路径的 Session。
 * @param cwd - 该 Session 的工作区根（若已知）。
 * @param path - 绝对或工作区相对路径，任一种分隔符写法。
 * @returns `dsh-resource://file/…` 地址。
 */
export function fileAddressFor(sessionId: string, cwd: string | undefined, path: string): string {
  const normalized = path.replace(/\\/g, '/')
  if (!isAbsoluteWorkspacePath(normalized)) return sessionFileAddress(sessionId, normalized)
  const root = cwd === undefined ? '' : cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  if (root !== '' && normalized === root) return sessionFileAddress(sessionId, '')
  if (root !== '' && normalized.startsWith(`${root}/`)) return sessionFileAddress(sessionId, normalized.slice(root.length + 1))
  return sessionFileAddress(sessionId, normalized)
}

/**
 * 从以工作区为根的绝刘路径中剥离工作区根（仅供显示）。
 * @param text - 待缩短的路径。
 * @param cwd - Session 工作区根；缺席或为空则保持路径不变。
 * @returns 相对于工作区根的路径，或当它并非以该根为根时保持不变。
 */
export function relativizeToCwd(text: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd === '') return text
  const root = cwd.replace(/[/\\]+$/, '')
  if (text.startsWith(`${root}/`) || text.startsWith(`${root}\\`)) return text.slice(root.length + 1)
  return text
}

/**
 * 通过已认证的文件路由为一个已解码的绝对文件路径生成地址。
 * @param base - HTTP(S) 应用基址，含其部署前缀，或 `dsh-app://app/`。
 * @param path - 原生文件路径；编写的 Markdown 中的 URL 转义必须已解码。
 * @returns 文件 URL，或对于不支持的传输与非绝对路径为 undefined。
 */
export function fileMediaUrl(base: string, path: string): string | undefined {
  if ((!/^https?:/u.test(base) && !base.startsWith('dsh-app://app/')) || !isAbsoluteWorkspacePath(path)
    || /^[/\\]{2}/u.test(path) || /[\u0000-\u001f\u007f]/u.test(path)) return undefined
  return new URL(`api/file?path=${encodeURIComponent(path)}`, base).href
}
