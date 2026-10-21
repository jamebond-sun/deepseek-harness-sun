/** 原生文件关联的浏览器安全元数据。 */

/** 一个能够打开所请求文件的、由 OS 注册的应用。 */
export interface NativeFileApplication {
  /** OS 应用标识符；调用方在打开前必须依据文件当前的处理程序重新校验它。 */
  readonly id: string
  readonly name: string
  readonly default: boolean
  /** PNG 或 SVG 的 data URL，当桌面未提供图标时为 null。 */
  readonly icon: string | null
}

/**
 * 校验从原生进程或已认证 Host 收到的文件关联元数据。
 * @param value - 已解码的应用列表。
 * @returns 已校验的应用元数据。
 * @throws 当条目畸形或图标 URL 不受支持时抛出 Error。
 */
export function parseNativeFileApplications(value: unknown): readonly NativeFileApplication[] {
  if (!Array.isArray(value)) throw new Error('Invalid native application list')
  const applications: NativeFileApplication[] = []
  const entries: readonly unknown[] = value
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null
      || !('id' in entry) || !('name' in entry) || !('default' in entry) || !('icon' in entry)
      || typeof entry.id !== 'string' || entry.id.length === 0
      || typeof entry.name !== 'string' || typeof entry.default !== 'boolean'
      || !(entry.icon === null || (typeof entry.icon === 'string' && /^data:image\/(?:png|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(entry.icon)))) {
      throw new Error('Invalid native application entry')
    }
    applications.push({ id: entry.id, name: entry.name, default: entry.default, icon: entry.icon })
  }
  return applications
}
