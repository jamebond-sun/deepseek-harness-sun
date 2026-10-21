/**
 * open-in-app 目录的平台解析：每个条目的定位器链解析为一个经过校验的
 * {@link OpenInAppResolvedLaunch}——本宿主真实持有的一个启动器——而一轮解析产出的映射表
 * 就是路由所服务并从中启动的映射，因此一次点击永远不会重跑检测。PATH 名字通过注入的
 * subprocess 能力在进程内解析；其余宿主命令（`xcode-select`、`reg.exe`）通过
 * `@deepseek-ai/dsh-native-command` 运行（argv，绝不走 shell）。应用程序适配器以分离方式
 * 派生，使用已剔除凭据的环境以及其声明的 Windows 可见性策略（{@link launchDetachedApp}）；
 * `shell-open` 启动（文件管理器）则走同一个包的路径打开器——即操作系统 shell 的 open
 * 动作——而不是直接派生进程。
 */

import { spawn } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir, platform as osPlatform } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import {
  canOpenNativePath, openNativePath, runNativeCommand, desktopEntryFields, desktopDataDirectories, type NativeCommandRunner,
} from '@deepseek-ai/dsh-native-command'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import {
  OPEN_IN_APP_CATALOG, PATH_TOKEN,
  type OpenInAppApp, type OpenInAppLaunch, type OpenInAppLocator, type OpenInAppPlatformSpec,
} from './catalog.ts'

/** 本宿主保存某个已解析应用程序图标像素的位置。 */
export type OpenInAppIconSource =
  | { readonly kind: 'app-bundle'; readonly path: string }
  | { readonly kind: 'executable'; readonly path: string }

/** 某个条目在本宿主机上经过校验的启动器与图标来源。 */
export interface OpenInAppResolvedLaunch {
  readonly launch: OpenInAppLaunch
  readonly fallbackLaunch?: OpenInAppLaunch | undefined
  /**
   * 图标像素来源；Linux 上缺省（图标路由改为跟随规格中的 desktop entry），以及那些自身
   * 没有美术资源的启动器也缺省。
   */
  readonly icon?: OpenInAppIconSource | undefined
}

/** 一次分离的 GUI 启动：派生进程，然后观察窗口是否出现早期失败。 */
export type OpenInAppLauncher = (
  command: string,
  args: readonly string[],
  options: {
    readonly watchMs: number
    readonly env?: Readonly<Record<string, string>> | undefined
    readonly windowsHide?: boolean | undefined
  },
) => Promise<void>

/** 一次启动尝试的结束方式；`missing` 表示解析已过期（ENOENT）。 */
export type OpenInAppLaunchOutcome = 'launched' | 'missing' | 'failed'

/**
 * 以与本进程分离的方式启动一个应用程序适配器：子进程获得一份已剔除凭据的环境（绝不包含
 * 框架的 `*KEY*`/`*SECRET*` 变量）再加上适配器显式的环境条目，不持有任何 stdio 管道，并
 * 比 dsh 活得更久。Windows 的 GUI 进程保持可见，除非适配器显式隐藏自己的 CLI 进程。
 * 启动成功与进程退出是解耦的——像 kitty 或 JetBrains IDE 这类启动器会在其窗口的整个生命
 * 周期内留在前台，因此观察窗口只用于捕捉那些立即失败的启动器：派生失败以及窗口内非零
 * 退出会被拒绝；窗口关闭时仍在运行的子进程会被 unref 并计为已启动，绝不被杀掉。
 * @param command - 可执行文件路径或 PATH 名字。
 * @param args - argv（绝不是一个 shell 字符串）。
 * @param options - 观察窗口长度与适配器特有的进程选项。
 * @returns 在启动被计为成功之后返回；发生早期失败时拒绝。
 */
export const launchDetachedApp: OpenInAppLauncher = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      detached: true,
      stdio: 'ignore',
      windowsHide: options.windowsHide,
      env: { ...scrubbedParentEnv(), ...options.env },
    })
    let settled = false
    const settle = (outcome: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(watch)
      child.unref()
      outcome()
    }
    const watch = setTimeout(() => { settle(resolve) }, options.watchMs)
    child.on('error', (error) => { settle(() => { reject(error) }) })
    child.on('exit', (code, signalName) => {
      if (code === 0) settle(resolve)
      else settle(() => { reject(new Error(`launcher exited with code ${String(code)}, signal ${String(signalName)}`)) })
    })
  })

/** 为确定性测试注入的平台事实。 */
export interface OpenInAppInternals {
  platform?: NodeJS.Platform
  /** 来自继承进程层的 SSH 启动事实，与 `.env` 取值无关。 */
  ssh?: boolean
  /** 替代 `/Applications` 与 `~/Applications` 的 bundle 目录根。 */
  applicationRoots?: readonly string[]
  /** 用于展开候选与注册表中 `${VAR}`/`%VAR%` 的环境。 */
  env?: Readonly<Record<string, string | undefined>>
  /** 替代候选中前导 `~/` 的主目录。 */
  home?: string
  run?: NativeCommandRunner
  launch?: OpenInAppLauncher
  /** 进程内的 PATH 名字解析；名字不在 PATH 上时返回 null。 */
  resolveExecutable?: (name: string) => Promise<string | null>
}

/** 在每个公开入口处经过一次显式补全步骤之后的平台事实。 */
export interface ResolvedInternals {
  platform: NodeJS.Platform
  ssh: boolean
  applicationRoots: readonly string[]
  env: Readonly<Record<string, string | undefined>>
  home: string
  run: NativeCommandRunner
  launch: OpenInAppLauncher
  resolveExecutable: (name: string) => Promise<string | null>
}

/**
 * 依据当前运行的宿主补全可注入的事实。`resolveExecutable` 没有宿主默认值——它由插件提供
 * 组合中的 subprocess 能力——因此省略它的调用方会在此大声失败，而不是把每个 `cli` 定位器
 * 静默地解析为缺失。
 * @param internals - 可注入的事实。
 * @returns 补全后的事实。
 */
export function resolveInternals(internals: OpenInAppInternals): ResolvedInternals {
  const home = internals.home ?? homedir()
  const resolveExecutable = internals.resolveExecutable
  if (resolveExecutable === undefined) {
    throw new Error('open-in-app: internals.resolveExecutable is required (the subprocess capability provides it)')
  }
  return {
    platform: internals.platform ?? osPlatform(),
    ssh: internals.ssh ?? false,
    applicationRoots: internals.applicationRoots ?? ['/Applications', join(home, 'Applications')],
    env: internals.env ?? process.env,
    home,
    run: internals.run ?? runNativeCommand,
    launch: internals.launch ?? launchDetachedApp,
    resolveExecutable,
  }
}

/** 目录定位器 kind 的封闭联合穷尽性栅栏。 */
/* v8 ignore next 3 -- 封闭的目录联合类型；仅在条目被伪造时才会到达 */
function assertNever(value: never): never {
  throw new Error(`unhandled open-in-app catalog kind: ${JSON.stringify(value)}`)
}

/**
 * 运行一条有界的宿主命令。
 * @param command - 可执行文件路径或 PATH 名字。
 * @param args - argv（绝不是一个 shell 字符串）。
 * @param timeoutMs - 命令时限。
 * @param internals - 补全后的平台事实。
 * @returns 退出码为 0 时返回 stdout；任何失败（派生、非零退出、超时）返回 null。
 */
export async function output(
  command: string, args: readonly string[], timeoutMs: number, internals: ResolvedInternals,
): Promise<string | null> {
  try {
    const { stdout } = await internals.run(command, args, AbortSignal.timeout(timeoutMs), 'hidden')
    return stdout
  } catch {
    // 同等对待派生失败、非零退出与超时中止：一条失败的宿主命令在此只有一种含义——不可用。
    return null
  }
}

/**
 * 探测某个路径是否为已存在的目录。
 * @param path - 候选路径。
 * @returns 该路径存在且为目录时为 true。
 */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    // 吞掉 ENOENT/EACCES：不可读的候选不是一个 bundle。
    return false
  }
}

/**
 * 探测某个路径是否为已存在的常规文件。
 * @param path - 候选路径。
 * @returns 该路径存在且为常规文件时为 true。
 */
export async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    // 吞掉 ENOENT/EACCES：不可读的候选不是一个启动器。
    return false
  }
}

/**
 * 展开 `${VAR}` 引用与前导 `~/`。展开是字符串替换：候选在展开前缀之后保留其模板的 `/`
 * 分隔符，而 Win32 路径 API 接受这种写法。
 * @param template - 候选模板。
 * @param internals - 补全后的平台事实。
 * @returns 展开后的候选；某个变量未设置时为 null。
 */
export function expandCandidate(template: string, internals: ResolvedInternals): string | null {
  const unset: string[] = []
  const expanded = template.replace(/\$\{([^}]+)\}/g, (token, name: string) => {
    const value = internals.env[name]
    if (value === undefined) unset.push(name)
    return value ?? token
  })
  if (unset.length > 0) return null
  return expanded.startsWith('~/') ? join(internals.home, expanded.slice(2)) : expanded
}

/** 展开 Windows 注册表值中的 `%VAR%` 引用；某个变量未设置时为 null。 */
function expandRegistryValue(value: string, internals: ResolvedInternals): string | null {
  const unset: string[] = []
  const expanded = value.replace(/%([^%]+)%/g, (token, name: string) => {
    const found = internals.env[name]
    if (found === undefined) unset.push(name)
    return found ?? token
  })
  return unset.length > 0 ? null : expanded
}

/** 一条 Windows 卸载记录中与推导启动器相关的字段。 */
interface WindowsInstallRecord {
  readonly displayName: string
  readonly installLocation?: string | undefined
  readonly displayIcon?: string | undefined
}

/** 一轮解析共享的、惰性构建的 Windows 注册表事实。 */
export interface WindowsRegistryView {
  /** 已注册可执行文件的小写名称到其 `App Paths` 默认值的映射。 */
  readonly appPaths: ReadonlyMap<string, string>
  readonly installRecords: readonly WindowsInstallRecord[]
}

/** `App Paths` 的根键，用户 hive 在前（按用户安装覆盖机器级安装）。 */
const APP_PATHS_ROOTS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths',
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths',
] as const

/** 卸载记录的根键：用户 hive、64 位机器 hive、32 位机器视图。 */
const UNINSTALL_ROOTS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
] as const

/**
 * 把 `reg.exe query <root> /s` 的输出解析为各子键的字符串值。`reg.exe` 为每个子键打印一行
 * 键路径，其后是缩进的值行；值名/类型/数据三列通过 `REG_*` 类型标记来匹配，因为默认值
 * 标记会本地化（`(Default)`、`(默认)`）。
 * @param dump - `reg.exe` 的原始 stdout。
 * @returns 子键路径到其按值名索引的 `REG_SZ`/`REG_EXPAND_SZ` 值的映射（默认值一律以
 *   `(Default)` 为名，不受区域影响）。
 */
export function parseRegistryDump(dump: string): ReadonlyMap<string, ReadonlyMap<string, string>> {
  const keys = new Map<string, Map<string, string>>()
  let current: Map<string, string> | undefined
  for (const line of dump.split(/\r?\n/)) {
    if (/^HK/.test(line)) {
      current = new Map()
      keys.set(line.trim(), current)
      continue
    }
    const value = /^\s+(.*?)\s+(REG_SZ|REG_EXPAND_SZ)\s+(.*)$/.exec(line)
    if (value === null || current === undefined) continue
    // oxlint-disable-next-line typescript/no-non-null-assertion -- 任何匹配上都存在这两个捕获组
    const [name, data] = [value[1]!, value[3]!]
    // reg.exe 会本地化默认值标记；每种区域语言都用括号包裹它。
    current.set(/^\(.*\)$/.test(name) ? '(Default)' : name, data.trim())
  }
  return keys
}

/**
 * 为一轮解析构建 Windows 注册表事实：`App Paths` 表与卸载记录，每个根键一次
 * `reg.exe query /s`。某个根键失败或不存在则不贡献任何内容。
 * @param timeoutMs - 每次 `reg.exe` 的时限。
 * @param internals - 补全后的平台事实。
 * @returns 解析后的视图。
 */
export async function readWindowsRegistryView(
  timeoutMs: number, internals: ResolvedInternals,
): Promise<WindowsRegistryView> {
  const appPaths = new Map<string, string>()
  const installRecords: WindowsInstallRecord[] = []
  for (const root of APP_PATHS_ROOTS) {
    const dump = await output('reg.exe', ['query', root, '/s'], timeoutMs, internals)
    if (dump === null) continue
    for (const [key, values] of parseRegistryDump(dump)) {
      // 本解析器所运行的任何宿主上，注册表键都以 '\' 分隔（测试在 POSIX 上解析夹具），
      // 因此 path.basename 不适用。
      const exe = key.slice(key.lastIndexOf('\\') + 1).toLowerCase()
      const target = values.get('(Default)')
      if (!exe.endsWith('.exe') || target === undefined || appPaths.has(exe)) continue
      const expanded = expandRegistryValue(target.replace(/^"|"$/g, ''), internals)
      if (expanded !== null) appPaths.set(exe, expanded)
    }
  }
  for (const root of UNINSTALL_ROOTS) {
    const dump = await output('reg.exe', ['query', root, '/s'], timeoutMs, internals)
    if (dump === null) continue
    for (const values of parseRegistryDump(dump).values()) {
      const displayName = values.get('DisplayName')
      if (displayName === undefined) continue
      installRecords.push({
        displayName,
        installLocation: values.get('InstallLocation'),
        displayIcon: values.get('DisplayIcon'),
      })
    }
  }
  return { appPaths, installRecords }
}

/** 按轮次作用域的惰性持有者，使一轮检测最多读取一次注册表。 */
class RegistryViewOnce {
  private view: Promise<WindowsRegistryView> | undefined
  constructor(private readonly timeoutMs: number, private readonly internals: ResolvedInternals) {}

  /** 本轮的注册表视图，首次使用时读取。 */
  read(): Promise<WindowsRegistryView> {
    this.view ??= readWindowsRegistryView(this.timeoutMs, this.internals)
    return this.view
  }
}

/** 一条 Windows 卸载记录所证明的可执行文件，未证明任何文件时为 null。 */
async function recordLauncher(
  record: WindowsInstallRecord,
  relativeLauncher: string | undefined,
  internals: ResolvedInternals,
): Promise<string | null> {
  if (relativeLauncher !== undefined && record.installLocation !== undefined && record.installLocation !== '') {
    const expanded = expandRegistryValue(record.installLocation.replace(/^"|"$/g, ''), internals)
    if (expanded !== null) {
      const candidate = join(expanded, relativeLauncher)
      if (await isFile(candidate)) return candidate
    }
  }
  if (record.displayIcon !== undefined) {
    // DisplayIcon 可能带有 `,<index>` 后缀以及包裹路径的引号。
    const bare = record.displayIcon.replace(/,-?\d+$/, '').replace(/^"|"$/g, '').trim()
    const expanded = expandRegistryValue(bare, internals)
    if (expanded !== null && expanded.toLowerCase().endsWith('.exe') && await isFile(expanded)) return expanded
  }
  return null
}

/** 解析器与图标路由所读取的、一个已解析 XDG desktop entry 的字段。 */
export interface DesktopEntry {
  readonly exec?: string
  readonly tryExec?: string
  readonly icon?: string
}

/**
 * 解析 `[Desktop Entry]` 段中的 `Exec`/`TryExec`/`Icon` 键。
 * @param text - desktop entry 文件的文本。
 * @returns 已识别的字段；该段之外的键被忽略。
 */
export function parseDesktopEntry(text: string): DesktopEntry {
  const fields = desktopEntryFields(text)
  return {
    ...(fields.Exec === undefined ? {} : { exec: fields.Exec }),
    ...(fields.TryExec === undefined ? {} : { tryExec: fields.TryExec }),
    ...(fields.Icon === undefined ? {} : { icon: fields.Icon }),
  }
}

/**
 * 按优先级排列的 XDG 数据目录（`XDG_DATA_HOME`，然后是 `XDG_DATA_DIRS`）。
 * @param internals - 补全后的平台事实。
 * @returns 应用了 freedesktop 默认值的数据目录。
 */
export function xdgDataDirectories(internals: ResolvedInternals): readonly string[] {
  return desktopDataDirectories(internals.home, internals.env)
}

/**
 * 从 XDG 应用程序目录中按 id 读取一个 desktop entry。
 * @param desktopId - 不带 `.desktop` 后缀的条目 id。
 * @param internals - 补全后的平台事实。
 * @returns 解析出的条目；没有任何目录持有它时为 null。
 */
export async function findDesktopEntry(
  desktopId: string, internals: ResolvedInternals,
): Promise<DesktopEntry | null> {
  for (const dataDir of xdgDataDirectories(internals)) {
    const path = join(dataDir, 'applications', `${desktopId}.desktop`)
    try {
      return parseDesktopEntry(await readFile(path, 'utf8'))
    } catch {
      // 吞掉 ENOENT/EACCES：继续尝试下一个数据目录。
    }
  }
  return null
}

/**
 * 一个 desktop entry 所证明的可执行文件：存在 `TryExec` 时用它，否则用 `Exec` 的第一个
 * token（带引号或裸写）；绝对路径在磁盘上校验，裸名字则通过 subprocess 能力在进程内解析。
 */
async function desktopLauncher(entry: DesktopEntry, internals: ResolvedInternals): Promise<string | null> {
  const candidate = entry.tryExec ?? execCommand(entry.exec)
  if (candidate === null || candidate === '') return null
  if (isAbsolute(candidate)) return await isFile(candidate) ? candidate : null
  return internals.resolveExecutable(candidate)
}

/**
 * `Exec=` 值的第一个 token。
 * @param exec - 原始的 `Exec=` 值（当该条目带有此键时）。
 * @returns 带引号的路径或直到空白之前的部分；缺失或为空白时返回 null。
 */
export function execCommand(exec: string | undefined): string | null {
  if (exec === undefined) return null
  const quoted = /^"([^"]+)"/.exec(exec)
  if (quoted?.[1] !== undefined) return quoted[1]
  const bare = /^\S+/.exec(exec)
  return bare === null ? null : bare[0]
}

/**
 * 某个平台下该目录条目的规格。
 * @param app - 目录条目。
 * @param platform - 宿主平台。
 * @returns 已声明的规格；不在已声明的三个平台之内时为 undefined。
 */
export function specFor(app: OpenInAppApp, platform: NodeJS.Platform): OpenInAppPlatformSpec | undefined {
  return platform === 'darwin' || platform === 'win32' || platform === 'linux'
    ? app.platforms[platform]
    : undefined
}

/** 已解析可执行文件的图标来源：Windows 从二进制自身提取。 */
function executableIcon(path: string, internals: ResolvedInternals): OpenInAppIconSource | undefined {
  return internals.platform === 'win32' ? { kind: 'executable', path } : undefined
}

/** 把一个定位器解析为经过校验的启动方式；未证明任何东西时为 null。 */
async function locate(
  locator: OpenInAppLocator,
  probeTimeoutMs: number,
  registry: RegistryViewOnce,
  internals: ResolvedInternals,
): Promise<OpenInAppResolvedLaunch | null> {
  switch (locator.kind) {
    case 'fixed': {
      // 一个 fixed 条目随其操作系统一起提供，因此图标路径是被信任的而非探测出来的
      // （万一文件缺失，会在提取阶段表现为 404）；只有未设置的变量（`${SystemRoot}`）
      // 才会丢弃图标声明。
      const iconPath = expandCandidate(locator.iconPath, internals)
      const icon = iconPath === null
        ? undefined
        : internals.platform === 'win32'
          ? { kind: 'executable' as const, path: iconPath }
          : { kind: 'app-bundle' as const, path: iconPath }
      return { launch: locator.launch, icon }
    }
    case 'app': {
      for (const root of internals.applicationRoots) {
        for (const fsName of locator.fsNames) {
          const bundle = join(root, fsName)
          if (await isDirectory(bundle)) {
            return {
              launch: { kind: 'argv', command: 'open', args: ['-a', bundle] },
              icon: { kind: 'app-bundle', path: bundle },
            }
          }
        }
      }
      return null
    }
    case 'xcode': {
      const developer = await output('xcode-select', ['-p'], probeTimeoutMs, internals)
      if (developer === null) return null
      const bundle = dirname(dirname(developer.trim()))
      if (!bundle.endsWith('.app') || !await isDirectory(bundle)) return null
      return {
        launch: { kind: 'argv', command: 'xed', args: [] },
        fallbackLaunch: { kind: 'argv', command: 'open', args: ['-a', bundle] },
        icon: { kind: 'app-bundle', path: bundle },
      }
    }
    case 'cli': {
      if (locator.requiresDesktop === true && !canOpenNativePath({
        platform: internals.platform,
        env: { ...internals.env },
      })) return null
      const found = await internals.resolveExecutable(locator.name)
      return found === null
        ? null
        : { launch: { kind: 'argv', command: found, args: locator.args }, icon: executableIcon(found, internals) }
    }
    case 'file': {
      for (const candidate of locator.candidates) {
        const path = expandCandidate(candidate, internals)
        if (path !== null && await isFile(path)) {
          return { launch: { kind: 'argv', command: path, args: locator.args }, icon: executableIcon(path, internals) }
        }
      }
      return null
    }
    case 'scan': {
      const root = expandCandidate(locator.root, internals)
      if (root === null) return null
      let entries: string[]
      try {
        entries = await readdir(root)
      } catch {
        // 吞掉缺失/不可读的根目录：没有可扫描的安装目录。
        return null
      }
      // 带版本后缀的目录名按数值感知比较，最新的在前（'2024.1.10' 高于 '2024.1.9'，
      // 而纯字典序会漏掉这一点）。
      const versions = entries.filter(entry => entry.startsWith(locator.namePrefix))
        .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
      for (const version of versions) {
        const launcher = join(root, version, locator.relativeLauncher)
        if (await isFile(launcher)) {
          return { launch: { kind: 'argv', command: launcher, args: locator.args }, icon: executableIcon(launcher, internals) }
        }
      }
      return null
    }
    case 'app-paths': {
      const target = (await registry.read()).appPaths.get(locator.exe.toLowerCase())
      if (target === undefined || !await isFile(target)) return null
      return { launch: { kind: 'argv', command: target, args: locator.args }, icon: { kind: 'executable', path: target } }
    }
    case 'install-record': {
      for (const record of (await registry.read()).installRecords) {
        if (!record.displayName.startsWith(locator.displayNamePrefix)) continue
        const launcher = await recordLauncher(record, locator.relativeLauncher, internals)
        if (launcher !== null) {
          return { launch: { kind: 'argv', command: launcher, args: locator.args }, icon: { kind: 'executable', path: launcher } }
        }
      }
      return null
    }
    case 'github-desktop': {
      const root = expandCandidate(locator.root, internals)
      if (root === null) return null
      let versions: string[]
      try {
        versions = (await readdir(root))
          .filter(entry => entry.startsWith('app-'))
          .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
      } catch {
        // 吞掉缺失/不可读的安装根目录：GitHub Desktop 不存在。
        return null
      }
      for (const version of versions) {
        const directory = join(root, version)
        const executable = join(directory, 'GitHubDesktop.exe')
        const cli = join(directory, 'resources', 'app', 'cli.js')
        if (await isFile(executable) && await isFile(cli)) {
          return {
            launch: {
              kind: 'argv',
              command: executable,
              args: [cli, 'open'],
              env: { ELECTRON_RUN_AS_NODE: '1' },
              windowsHide: true,
            },
            icon: { kind: 'executable', path: executable },
          }
        }
      }
      return null
    }
    case 'desktop': {
      const entry = await findDesktopEntry(locator.desktopId, internals)
      if (entry === null) return null
      const launcher = await desktopLauncher(entry, internals)
      return launcher === null ? null : { launch: { kind: 'argv', command: launcher, args: locator.args } }
    }
    /* v8 ignore next -- 封闭的定位器联合类型 */
    default: return assertNever(locator)
  }
}

/**
 * 在本宿主机上解析一个目录条目：按序尝试该平台的定位器，第一个经过校验的启动器胜出。
 * @param app - 目录条目。
 * @param probeTimeoutMs - 解析用宿主命令的单条命令时限。
 * @param internals - 供确定性测试注入的平台与运行器钩子。
 * @returns 经过校验的启动方式；在 SSH 启动期间或该条目未安装在本机时为 null。
 */
export async function resolveLaunch(
  app: OpenInAppApp, probeTimeoutMs: number, internals: OpenInAppInternals = {},
): Promise<OpenInAppResolvedLaunch | null> {
  const resolved = resolveInternals(internals)
  if (resolved.ssh) return null
  return resolveWithRegistry(app, probeTimeoutMs, new RegistryViewOnce(probeTimeoutMs, resolved), resolved)
}

/** 针对本轮共享的注册表视图解析一个条目。 */
async function resolveWithRegistry(
  app: OpenInAppApp,
  probeTimeoutMs: number,
  registry: RegistryViewOnce,
  internals: ResolvedInternals,
): Promise<OpenInAppResolvedLaunch | null> {
  const platformSpec = specFor(app, internals.platform)
  if (platformSpec === undefined) return null
  for (const locator of platformSpec.locators) {
    const found = await locate(locator, probeTimeoutMs, registry, internals)
    if (found !== null) return found
  }
  return null
}

/**
 * 一次性解析整个目录：本宿主机上每个条目经过校验的启动器，按菜单顺序排列。Windows 注册表
 * 每轮最多读取一次。返回的映射是调用方所拥有的可变权威——路由提供其键并从其值启动，而某
 * 个过期条目会在一次 `ENOENT` 启动之后就地被替换或移除。
 * SSH 启动将返回一个空映射，不做任何探测。
 * @param probeTimeoutMs - 解析用宿主命令的单条命令时限。
 * @param internals - 供确定性测试注入的平台与运行器钩子。
 * @returns 目录 id 到经过校验的启动方式的映射，按目录顺序。
 */
export async function resolveOpenInAppApps(
  probeTimeoutMs: number, internals: OpenInAppInternals = {},
): Promise<Map<string, OpenInAppResolvedLaunch>> {
  const resolved = resolveInternals(internals)
  if (resolved.ssh) {
    return new Map()
  }
  const registry = new RegistryViewOnce(probeTimeoutMs, resolved)
  const entries = await Promise.all(OPEN_IN_APP_CATALOG.map(async app =>
    [app.id, await resolveWithRegistry(app, probeTimeoutMs, registry, resolved)] as const))
  const map = new Map<string, OpenInAppResolvedLaunch>()
  for (const [id, launch] of entries) {
    if (launch !== null) map.set(id, launch)
  }
  return map
}

/**
 * 把目录 token 代入一条启动 argv，当没有任何参数携带它时则把目录追加到末尾。
 */
function launchArgs(args: readonly string[], path: string): readonly string[] {
  return args.some(arg => arg.includes(PATH_TOKEN))
    ? args.map(arg => arg.replaceAll(PATH_TOKEN, path))
    : [...args, path]
}

/** 一次启动拒绝是否指向缺失的可执行文件（解析已过期）。 */
function isMissingExecutable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

/**
 * 通过操作系统 shell 的 open 动作在启动观察窗口内打开一个目录：打开命令是否在窗口内完成
 * 决定结果，而窗口关闭时仍在运行的打开器计为已启动并继续运行（冷启动的 shell 打开器可能
 * 比窗口活得更久；其迟到的结算会被吞掉，因为请求已经应答）。
 */
function runShellOpen(
  path: string, watchMs: number, internals: ResolvedInternals,
): Promise<OpenInAppLaunchOutcome> {
  const opening = openNativePath(path, new AbortController().signal, {
    platform: internals.platform, run: internals.run, env: internals.env,
  })
  return new Promise((resolve) => {
    const watch = setTimeout(() => {
      opening.catch(() => {
        // 窗口已经计为已启动的打开器发生了迟到失败。
      })
      resolve('launched')
    }, watchMs)
    opening.then(
      () => {
        clearTimeout(watch)
        resolve('launched')
      },
      (error: unknown) => {
        clearTimeout(watch)
        resolve(isMissingExecutable(error) ? 'missing' : 'failed')
      },
    )
  })
}

/** 运行一个启动器并判定该次尝试的结束方式。 */
async function runLaunch(
  launch: OpenInAppLaunch, path: string, watchMs: number, internals: ResolvedInternals,
): Promise<OpenInAppLaunchOutcome> {
  switch (launch.kind) {
    case 'shell-open':
      return runShellOpen(path, watchMs, internals)
    case 'argv':
      try {
        await internals.launch(launch.command, launchArgs(launch.args, path), {
          watchMs,
          ...(launch.env === undefined ? {} : { env: launch.env }),
          ...(launch.windowsHide === undefined ? {} : { windowsHide: launch.windowsHide }),
        })
        return 'launched'
      } catch (error: unknown) {
        // 可执行文件缺失意味着解析已过期（调用方会重新解析一次）；其他任何派生或早期退出
        // 失败都只有一种含义——启动器什么都没打开——而调用方仍可尝试回退。
        return isMissingExecutable(error) ? 'missing' : 'failed'
      }
    /* v8 ignore next -- 封闭的启动联合类型 */
    default: return assertNever(launch)
  }
}

/**
 * 在一个目录上启动一个已解析的应用程序：先主启动器，当主启动器在观察窗口内失败时再使用
 * 回退。
 * @param resolved - 该条目经过校验的启动器。
 * @param path - 绝对的工作区目录（已由路由校验）。
 * @param watchMs - 每个启动器的早期失败观察窗口（窗口关闭时仍在运行的子进程计为已启动
 * 并继续运行）。
 * @param internals - 供确定性测试注入的启动器钩子。
 * @returns 该次尝试的结束方式；当某个被尝试的启动器的可执行文件已消失时为 `missing`，
 *   这告诉调用方要重新解析一次。
 */
export async function launchResolved(
  resolved: OpenInAppResolvedLaunch, path: string, watchMs: number, internals: OpenInAppInternals = {},
): Promise<OpenInAppLaunchOutcome> {
  const completed = resolveInternals(internals)
  const primary = await runLaunch(resolved.launch, path, watchMs, completed)
  if (primary === 'launched' || resolved.fallbackLaunch === undefined) return primary
  const fallback = await runLaunch(resolved.fallbackLaunch, path, watchMs, completed)
  if (fallback === 'launched') return 'launched'
  // 任一被尝试的启动器消失，都是刷新解析结果的理由。
  return primary === 'missing' || fallback === 'missing' ? 'missing' : 'failed'
}
