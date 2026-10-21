/**
 * 面向 Host UI 集成的、跨平台原生路径与文本文档打开器。
 *
 * 默认意图优先使用平台能指名时、由浏览器渲染的文档所对应的默认浏览器，然后回退到
 * 默认应用。WSL 将每个路径翻译为 Windows 桌面，而非假定一个 Linux GUI。文本编辑器
 * 意图从不咨询浏览器。Windows 将每个意图都交给 Explorer：shell 自身那个双击所用的
 * 默认应用解析来选择应用，而一个自己去解析关联关系的进程读到的是更窄的记录，并报告
 * 无应用。
 * @module @deepseek-ai/dsh-native-command/path-opener
 */

import { release as osRelease } from 'node:os'
import { dirname, extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runNativeCommand, type NativeCommandRunner } from './runner.ts'

/** 可测试的命令边界；原生实现绝不调用 shell。 */
export type PathOpenerRunner = NativeCommandRunner

/** 用于确定性适配器测试的可注入平台事实。 */
export interface PathOpenerInternals {
  platform?: NodeJS.Platform
  /** 用于区分 WSL 与桌面 Linux 的内核发行覆盖值。 */
  osRelease?: string
  /** 用于 WSL 标记与桌面 Linux 浏览器约定的环境。 */
  env?: NodeJS.ProcessEnv
  run?: PathOpenerRunner
}

/** 浏览器所渲染的文档，而非编辑器仅做编辑的那些。 */
const BROWSER_DOCUMENTS = new Set(['.html', '.htm', '.xhtml', '.svg'])

/**
 * 为 `https` 注册的 macOS bundle——即默认浏览器，正如 LaunchServices 所记录的那样。
 * 嵌套的版本字典会先被剥离，因为它携带自身的 `LSHandlerRoleAll`。
 */
function macBundleForHttps(plist: string): string | undefined {
  const stripped = plist.replace(/LSHandlerPreferredVersions\s*=\s*\{[^}]*\};/g, '')
  const block = /\{[^{}]*LSHandlerURLScheme\s*=\s*"?https"?;[^{}]*\}/.exec(stripped)?.[0]
  if (block === undefined) return undefined
  return /LSHandlerRoleAll\s*=\s*"?([\w.-]+)"?;/.exec(block)?.[1]
}

/**
 * 用默认浏览器打开一份浏览器可渲染的文档。
 * @returns 当浏览器接管时为 true；当本平台无法指名一个，或指名失败时为 false——
 *   此时调用方改用默认应用。
 */
async function openInBrowser(
  path: string, signal: AbortSignal, platform: NodeJS.Platform,
  run: PathOpenerRunner, env: NodeJS.ProcessEnv,
): Promise<boolean> {
  if (platform === 'darwin') {
    let bundle: string | undefined
    try {
      const { stdout } = await run(
        'defaults', ['read', 'com.apple.LaunchServices/com.apple.launchservices.secure'], signal, 'hidden')
      bundle = macBundleForHttps(stdout)
    } catch {
      // 没有 LaunchServices 记录（一个从未改过默认的新账户）：内容类型处理程序
      // 本就由系统自行选择。
      return false
    }
    if (bundle === undefined) return false
    await run('open', ['-b', bundle, path], signal, 'hidden')
    return true
  }
  if (platform === 'linux') {
    // $BROWSER 是可移植约定；经 xdg-settings 的 desktop-entry 解析需要一个本包不该
    // 发布的启动器。
    const browser = env.BROWSER
    if (browser === undefined || browser === '') return false
    await run(browser, [path], signal, 'hidden')
    return true
  }
  // Windows 在不读取 UserChoice 注册表的情况下指名不了浏览器，且其 .html 关联在通常
  // 情形下就是这个浏览器。
  return false
}

/** 原生路径打开意图；macOS 区分文本编辑与文件关联。 */
type PathOpenIntent = 'default' | 'association' | 'text-editor'

/** 某个环境标记是否被设为一个非空值。 */
function present(value: string | undefined): boolean {
  return value !== undefined && value !== ''
}

/** 用其进程与内核标记区分 WSL 与桌面 Linux。 */
function isWsl(internals: PathOpenerInternals): boolean {
  const env = internals.env ?? process.env
  if (present(env.WSL_DISTRO_NAME) || present(env.WSL_INTEROP)) return true
  return (internals.osRelease ?? osRelease()).toLowerCase().includes('microsoft')
}

/** 将某个 Windows 路径编码为 Explorer 能完好接收的目标。 */
function explorerTarget(windowsPath: string): string {
  const href = pathToFileURL(windowsPath, { windows: true }).href
  // 一段其每个字节都高于 ASCII 的转义，是一个非 ASCII 字符。
  return href
    .replace(/(?:%[89A-F][0-9A-F])+/gi, escaped => decodeURIComponent(escaped))
    .replaceAll(',', '%2C')
    .replaceAll('=', '%3D')
}

/**
 * 将某个目标交给 Explorer，接受其委托交接的退出码。
 *
 * Explorer 在将请求交给已经运行的桌面进程后会以退出码 1 退出，因此退出码 1 意味着
 * shell 已接管。其余每个失败仍会拒绝，且取消优先于一个委托方的退出码 1。
 * @param args - Explorer 的 argv：仅编码目标以打开它，或 `/select,<编码目标>` 以揭示它。
 * @param signal - 调用方生命周期；abort 终止命令。
 * @param run - 无 shell 的命令运行器。
 * @throws 除非是 Explorer 的委托退出码 1，否则抛出运行器的失败。
 */
async function runExplorer(args: readonly string[], signal: AbortSignal, run: PathOpenerRunner): Promise<void> {
  try {
    // SW_HIDE 同时隐藏 Explorer 的文件夹窗口，而不仅仅是控制台窗口。
    await run('explorer.exe', args, signal, 'visible')
  } catch (error: unknown) {
    signal.throwIfAborted()
    // Explorer 在委托给已存在的桌面进程后可能退出 1。
    if (!(error instanceof Error) || !('code' in error) || error.code !== 1) throw error
  }
}

/**
 * 经由 Explorer 打开一个 Windows 可解析的路径——那个拥有双击所用的默认应用解析的 shell。
 * @param path - Windows 可解析的路径；Explorer 将其编码后的文件 URI 作为单一 argv 元素
 *   接收，绝不作为一个命令字符串。
 * @param signal - 调用方生命周期；abort 终止命令。
 * @param run - 无 shell 的命令运行器。
 */
async function openWindowsPath(path: string, signal: AbortSignal, run: PathOpenerRunner): Promise<void> {
  await runExplorer([explorerTarget(path)], signal, run)
}

/** 在交给 Windows 桌面之前翻译一个 WSL 路径。 */
async function openWslPath(path: string, signal: AbortSignal, run: PathOpenerRunner): Promise<void> {
  const translated = await run('wslpath', ['-w', path], signal, 'hidden')
  signal.throwIfAborted()
  const windowsPath = translated.stdout.replace(/[\r\n]+$/, '')
  if (windowsPath === '') throw new Error('wslpath returned no Windows path')
  await openWindowsPath(windowsPath, signal, run)
}

/** 为所请求的打开意图分发某个无 shell 的平台命令。 */
async function openNativePathWithIntent(
  path: string,
  signal: AbortSignal,
  intent: PathOpenIntent,
  internals: PathOpenerInternals = {},
): Promise<void> {
  const platform = internals.platform ?? process.platform
  const run = internals.run ?? runNativeCommand
  const env = internals.env ?? process.env
  const wsl = platform === 'linux' && isWsl(internals)

  if (!wsl && intent === 'default' && BROWSER_DOCUMENTS.has(extname(path).toLowerCase())
    && await openInBrowser(path, signal, platform, run, env)) return

  if (platform === 'darwin') {
    await run('open', intent === 'text-editor' ? ['-t', path] : [path], signal, 'hidden')
    return
  }

  if (platform === 'win32') {
    await openWindowsPath(path, signal, run)
    return
  }

  if (platform === 'linux') {
    if (wsl) {
      await openWslPath(path, signal, run)
      return
    }
    await run('xdg-open', [path], signal, 'hidden')
    return
  }

  throw new Error(`native path opener is unsupported on ${platform}`)
}

/**
 * {@link openNativePath} 是否能在本宿主上合理地抵达一个桌面。
 *
 * macOS 与 Windows 总带有桌面打开器；Linux 在它是 WSL（Windows 桌面接管该路径）或
 * 已通告显示服务器时也是如此。无头或容器化的 Linux 宿主回答 false，这正是一个界面
 * 把路径显示为文本、而非提供会向空处 spawn `xdg-open` 的按钮的原因。
 * @param internals - 用于确定性测试的平台与环境接缝。
 * @returns 将路径交给原生打开器时是否根本可行。
 */
export function canOpenNativePath(internals: PathOpenerInternals = {}): boolean {
  const platform = internals.platform ?? process.platform
  if (platform === 'darwin' || platform === 'win32') return true
  if (platform !== 'linux') return false
  const env = internals.env ?? process.env
  return isWsl(internals) || present(env.DISPLAY) || present(env.WAYLAND_DISPLAY)
}

/**
 * 用操作系统的默认应用打开一个文件系统路径；或在路径命名一个浏览器渲染的文档时，
 * 用默认浏览器打开它。
 * @param path - 绝对或宿主可解析的路径（解析由调用方负责）。
 * @param signal - 调用方/连接生命周期；abort 终止原生命令。
 * @param internals - 用于确定性测试的平台、环境及运行器钩子。
 */
export function openNativePath(
  path: string,
  signal: AbortSignal,
  internals: PathOpenerInternals = {},
): Promise<void> {
  return openNativePathWithIntent(path, signal, 'default', internals)
}

/**
 * 经由其文件类型关联打开一个文件系统路径，包括 HTML 与 SVG。
 * @param path - 绝对或宿主可解析的路径；调用方验证本地访问。
 * @param signal - 调用方生命周期；abort 终止原生命令。
 * @param internals - 用于适配器测试的平台、环境及运行器事实。
 * @returns 在关联应用接受该路径之后。
 */
export function openNativeAssociatedPath(
  path: string, signal: AbortSignal, internals: PathOpenerInternals = {},
): Promise<void> {
  return openNativePathWithIntent(path, signal, 'association', internals)
}

/**
 * 打开一个文本文档进行编辑；macOS 绕过文件类型关联，因此一个指向浏览器的 YAML 关联
 * 无法吞掉这个手势。
 * @param path - 绝对或宿主可解析的文本文档路径。
 * @param signal - 调用方/连接生命周期；abort 终止原生命令。
 * @param internals - 用于确定性测试的平台与运行器钩子。
 */
export function openNativeTextFile(
  path: string,
  signal: AbortSignal,
  internals: PathOpenerInternals = {},
): Promise<void> {
  return openNativePathWithIntent(path, signal, 'text-editor', internals)
}

/** 服务宿主上可用的文件管理器行为，包括 WSL 的 Windows 桌面。 */
export type NativeFileManager = 'finder' | 'explorer' | 'directory'

/**
 * 在不检查浏览器平台的情况下识别原生文件管理器动作。
 * @param internals - 平台与 WSL 事实。
 * @returns 受支持的文件管理器动作，或在不支持的平台上的 null。
 */
export function nativeFileManager(internals: PathOpenerInternals = {}): NativeFileManager | null {
  const platform = internals.platform ?? process.platform
  if (platform === 'darwin') return 'finder'
  if (platform === 'win32' || (platform === 'linux' && isWsl(internals))) return 'explorer'
  return platform === 'linux' ? 'directory' : null
}

/**
 * 在 Finder 或 Explorer 中揭示一个文件，或在 Linux 默认文件管理器中打开其父目录。
 * @param path - 已由调用方授权的绝对文件路径。
 * @param signal - 调用方生命周期；abort 终止原生命令。
 * @param internals - 用于适配器测试的平台、环境及命令运行器。
 * @returns 在命令完成后；Explorer 的退出码 1 被视为一次委托交接，而非已选中证明。
 */
export async function revealNativePath(
  path: string, signal: AbortSignal, internals: PathOpenerInternals = {},
): Promise<void> {
  signal.throwIfAborted()
  const platform = internals.platform ?? process.platform
  const run = internals.run ?? runNativeCommand
  const manager = nativeFileManager({ ...internals, platform })
  if (manager === 'finder') {
    await run('open', ['-R', path], signal, 'hidden')
    return
  }
  if (manager === 'explorer') {
    let windowsPath = path
    if (platform === 'linux') {
      const translated = await run('wslpath', ['-w', path], signal, 'hidden')
      signal.throwIfAborted()
      windowsPath = translated.stdout.replace(/[\r\n]+$/, '')
      if (windowsPath === '') throw new Error('wslpath returned no Windows path')
    }
    await runExplorer(['/select,', explorerTarget(windowsPath)], signal, run)
    return
  }
  if (manager === 'directory') {
    await run('xdg-open', [dirname(path)], signal, 'hidden')
    return
  }
  throw new Error(`native file manager is unsupported on ${platform}`)
}
