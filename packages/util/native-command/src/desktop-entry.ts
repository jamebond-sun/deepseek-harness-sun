/** 目录与文件应用目录所共享的 XDG desktop-entry 字段与图标查找。 */
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

/** 适合作为图像响应或 data URL 的已解码应用图标字节。 */
export interface DesktopIcon {
  readonly bytes: Buffer
  readonly contentType: 'image/png' | 'image/svg+xml'
}

/**
 * 读取主 desktop-entry 段，而不解释可执行命令。
 * @param text - 已安装的 desktop-entry 文本。
 * @returns 其字面的字段值；操作段被排除。
 */
export function desktopEntryFields(text: string): Readonly<Record<string, string>> {
  let main = false
  const fields = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('[')) { main = trimmed === '[Desktop Entry]'; continue }
    if (!main || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf('=')
    if (separator > 0) fields.set(trimmed.slice(0, separator).trim(), trimmed.slice(separator + 1).trim())
  }
  return Object.fromEntries(fields)
}

/**
 * 按桌面优先级顺序解析 XDG 应用与图标根。
 * @param home - 用户 home 目录。
 * @param env - 桌面环境值。
 * @returns data-home，其后为系统数据目录。
 */
export function desktopDataDirectories(home: string, env: Readonly<Record<string, string | undefined>>): readonly string[] {
  return [env.XDG_DATA_HOME ?? join(home, '.local', 'share'),
    ...(env.XDG_DATA_DIRS ?? '/usr/local/share:/usr/share').split(':').filter(Boolean)]
}

/** 读取一个已安装的 PNG 或 SVG 图标；缺失路径与目录没有像素。 */
async function readIcon(path: string): Promise<DesktopIcon | null> {
  const contentType = path.endsWith('.png') ? 'image/png' : path.endsWith('.svg') ? 'image/svg+xml' : null
  if (contentType === null) return null
  try {
    if (!(await stat(path)).isFile()) return null
    return { bytes: await readFile(path), contentType }
  } catch (_error) {
    // 缺失或不可读的艺术资源不会移除一个本可用应用。
    return null
  }
}

/**
 * 解析一个绝对图标路径或一个已安装的 hicolor/pixmaps 图标名。
 * @param name - desktop-entry 的 Icon 字段。
 * @param directories - 按优先级顺序的 XDG 数据根。
 * @returns 图像字节与媒体类型，或当艺术资源不可用时为 null。
 */
export async function desktopApplicationIcon(name: string, directories: readonly string[]): Promise<DesktopIcon | null> {
  if (isAbsolute(name)) return readIcon(name)
  for (const directory of directories) {
    for (const size of ['512x512', '256x256', '128x128', '64x64', '48x48', '32x32']) {
      for (const extension of ['png', 'svg']) {
        const icon = await readIcon(join(directory, 'icons', 'hicolor', size, 'apps', `${name}.${extension}`))
        if (icon !== null) return icon
      }
    }
    const scalable = await readIcon(join(directory, 'icons', 'hicolor', 'scalable', 'apps', `${name}.svg`))
    if (scalable !== null) return scalable
    for (const extension of ['png', 'svg']) {
      const icon = await readIcon(join(directory, 'pixmaps', `${name}.${extension}`))
      if (icon !== null) return icon
    }
  }
  return null
}
