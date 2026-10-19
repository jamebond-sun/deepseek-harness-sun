/** 浏览器本地的 shell 偏好；Host 发现已保存路径是否可用。 */
const KEY = 'dsh.terminal.shell'

/**
 * 读取浏览器偏好。
 * @returns 上次选择的 shell 路径；存储不可用时为 null。
 */
export function preferredShell(): string | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY) }
  catch (_storageUnavailable) { return null }
}

/**
 * 记住所选的 shell，而不让存储成为启动依赖。
 * @param path - Host 提供的已验证可执行路径。
 */
export function rememberShell(path: string): void {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, path) }
  catch (_storageUnavailable) { /* 隐私浏览或配额失败仍让本次启动可用。 */ }
}
