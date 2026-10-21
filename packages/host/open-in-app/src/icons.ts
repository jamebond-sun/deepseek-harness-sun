/**
 * 为已解析的 open-in-app 应用程序在宿主机上提取图标，每个平台一种策略：macOS 把已解析
 * bundle 的 `.icns` 转换为 128px PNG（`plutil` + `sips`）；Windows 通过生成的 PowerShell
 * 脚本把已解析可执行文件的关联图标提取为 32px PNG（这是不借助原生扩展时
 * `ExtractAssociatedIcon` 能给出的最大尺寸）；Linux 则依据规范中 desktop entry 的 `Icon=`
 * 键到 hicolor 主题与 pixmaps 目录中查找（PNG 或 SVG，不启子进程）。任何失败都解析为
 * null，图标路由回答 404，浏览器将其渲染为一个通用字形。
 */

import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { desktopApplicationIcon } from '@deepseek-ai/dsh-native-command'
import type { OpenInAppApp } from './catalog.ts'
import {
  findDesktopEntry, output, resolveInternals, specFor, xdgDataDirectories,
  type OpenInAppInternals, type OpenInAppResolvedLaunch, type ResolvedInternals,
} from './resolver.ts'

/** 一个已提取的图标：原始字节加上路由所服务的媒体类型。 */
export interface OpenInAppIcon {
  readonly bytes: Buffer
  readonly contentType: 'image/png' | 'image/svg+xml'
}

/**
 * 把一个 bundle 的图标提取为 128px PNG：从 Info.plist 读取 `CFBundleIconFile`（用 `plutil`
 * 转 JSON；该值可能省略 .icns 扩展名），回退到第一个 `Resources/*.icns`，然后通过一个
 * 全新的临时文件用 `sips` 转换。
 */
async function extractBundleIconPng(
  bundlePath: string, timeoutMs: number, internals: ResolvedInternals,
): Promise<Buffer | null> {
  const resources = join(bundlePath, 'Contents', 'Resources')
  let iconFile: string | null = null
  const plistJson = await output(
    'plutil', ['-convert', 'json', '-o', '-', join(bundlePath, 'Contents', 'Info.plist')], timeoutMs, internals)
  if (plistJson !== null) {
    try {
      const declared: unknown = (JSON.parse(plistJson) as { CFBundleIconFile?: unknown }).CFBundleIconFile
      if (typeof declared === 'string' && declared !== '') {
        iconFile = declared.endsWith('.icns') ? declared : `${declared}.icns`
      }
    } catch {
      // 吞掉格式错误的 plutil JSON：下面的 Resources 扫描仍然适用。
    }
  }
  if (iconFile === null) {
    try {
      iconFile = (await readdir(resources)).find(entry => entry.endsWith('.icns')) ?? null
    } catch {
      // 吞掉缺失的 Resources 目录：这样的 bundle 没有图标。
      return null
    }
  }
  if (iconFile === null) return null
  const icns = join(resources, iconFile)
  try {
    await stat(icns)
  } catch {
    // 吞掉 ENOENT：Info.plist 可能声明了一个并不在磁盘上的图标文件。
    return null
  }
  const workDir = await mkdtemp(join(tmpdir(), 'dsh-open-in-app-'))
  try {
    const outPng = join(workDir, 'icon.png')
    if (await output('sips', ['-s', 'format', 'png', '-Z', '128', icns, '--out', outPng], timeoutMs, internals) === null) {
      return null
    }
    try {
      return await readFile(outPng)
    } catch {
      // 吞掉以 0 退出却没有写出输出文件的 sips 运行。
      return null
    }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

/**
 * 关联图标提取脚本。用 `-File` 加位置参数，使路径不进入命令行的解析过程（没有引号/转义
 * 面）；`ExtractAssociatedIcon` 产出 32px，这是不借助原生扩展时 .NET 自带接口能给出的
 * 最大尺寸（README 已知限制）。
 */
const EXTRACT_ICON_PS1 = [
  'param([string]$Source, [string]$Target)',
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Drawing',
  '$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($Source)',
  'if ($null -eq $icon) { exit 1 }',
  '$bitmap = $icon.ToBitmap()',
  '$bitmap.Save($Target, [System.Drawing.Imaging.ImageFormat]::Png)',
  '',
].join('\n')

/** 把一个 Windows 可执行文件的关联图标提取为 32px PNG。 */
async function extractExecutableIconPng(
  executablePath: string, timeoutMs: number, internals: ResolvedInternals,
): Promise<Buffer | null> {
  const workDir = await mkdtemp(join(tmpdir(), 'dsh-open-in-app-'))
  try {
    const script = join(workDir, 'extract-icon.ps1')
    const outPng = join(workDir, 'icon.png')
    await writeFile(script, EXTRACT_ICON_PS1, 'utf8')
    const ran = await output('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, executablePath, outPng,
    ], timeoutMs, internals)
    if (ran === null) return null
    try {
      return await readFile(outPng)
    } catch {
      // 吞掉以 0 退出却没有写出输出文件的脚本运行。
      return null
    }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

/** 从 desktop entry 的 `Icon=` 键取一个 Linux 应用程序的图标。 */
async function extractLinuxIcon(
  desktopId: string, internals: ResolvedInternals,
): Promise<OpenInAppIcon | null> {
  const entry = await findDesktopEntry(desktopId, internals)
  const icon = entry?.icon
  if (icon === undefined || icon === '') return null
  return desktopApplicationIcon(icon, xdgDataDirectories(internals))
}

/**
 * 在本宿主机上提取一个已解析应用程序的图标。
 * @param app - 目录条目（其 Linux 规格命名了 desktop entry）。
 * @param resolved - 该条目经过校验的启动方式（macOS/Windows 上的图标来源）。
 * @param timeoutMs - 提取用宿主命令的单条命令时限。
 * @param internals - 供确定性测试注入的平台与运行器钩子。
 * @returns 图标字节与媒体类型；本宿主机无法提供时为 null。
 */
export async function extractAppIcon(
  app: OpenInAppApp,
  resolved: OpenInAppResolvedLaunch,
  timeoutMs: number,
  internals: OpenInAppInternals = {},
): Promise<OpenInAppIcon | null> {
  const completed = resolveInternals(internals)
  if (completed.platform === 'linux') {
    const desktopId = specFor(app, completed.platform)?.desktopId
    return desktopId === undefined ? null : extractLinuxIcon(desktopId, completed)
  }
  if (resolved.icon === undefined) return null
  if (resolved.icon.kind === 'app-bundle') {
    const bytes = await extractBundleIconPng(resolved.icon.path, timeoutMs, completed)
    return bytes === null ? null : { bytes, contentType: 'image/png' }
  }
  const bytes = await extractExecutableIconPng(resolved.icon.path, timeoutMs, completed)
  return bytes === null ? null : { bytes, contentType: 'image/png' }
}
