/**
 * open-in-app 应用程序目录：一张编译期的可启动应用表，每个应用按平台声明按顺序尝试的
 * 启动器来源。该表只是数据——平台解析在 `resolver.ts`，图标提取在 `icons.ts`。某个平台
 * 若没有声明任何条目，则解析为空目录。
 */

/** 目录为其声明条目的平台；其他宿主一律解析为空。 */
export type OpenInAppPlatform = 'darwin' | 'win32' | 'linux'

/** 承载工作区目录的启动参数占位符（`--cd={path}`）。 */
export const PATH_TOKEN = '{path}'

/**
 * 已解析的应用程序如何接收工作区目录。`argv` 以分离方式派生启动器，并把目录代入（或追加
 * 到）其 argv。其可选的环境条目会覆盖在已剔除凭据的父环境之上；`windowsHide` 保留给那些
 * 子进程会打开可见 GUI 的 CLI 适配器。`shell-open` 则通过 `dsh-native-command` 的路径
 * 打开器把目录交给操作系统 shell 的 open 动作——也就是文件管理器使用的通道，因为它们是
 * 操作系统对目录的默认处理方式，而直接派生 `explorer.exe <dir>` 并不总能可靠地唤起窗口。
 */
export type OpenInAppLaunch =
  | {
    readonly kind: 'argv'
    readonly command: string
    readonly args: readonly string[]
    readonly env?: Readonly<Record<string, string>> | undefined
    readonly windowsHide?: boolean | undefined
  }
  | { readonly kind: 'shell-open' }

/**
 * 某个平台如何推导出一个经过校验的启动器。每种类型都解析为本宿主真实持有的产物——一个
 * 存在的 `.app` bundle、磁盘上的一个可执行文件，或一次 PATH 解析——绝不只是一个安装记录：
 * `fixed` 随操作系统一起提供；`app` 在已知的 `.app` 目录（`/Applications`、
 * `~/Applications`）中查找命名过的 bundle；`xcode` 跟随 `xcode-select -p`，因此能找到
 * Beta 版或改名过的安装；`cli` 通过 subprocess 能力在进程内解析一个 PATH 名字（PATH/PATHEXT
 * stat，不经 shell，也不用 `which`）；`file` 取第一个存在的展开候选；`scan` 选取最新匹配
 * 的带版本安装目录（Windows 上的 JetBrains）；`app-paths` 读取 Windows 的 `App Paths`
 * 注册表键；`install-record` 读取 Windows 的卸载记录并校验它们指向的可执行文件；
 * `github-desktop` 同时解析 GitHub Desktop 的带版本可执行文件与其打包的 CLI；`desktop`
 * 读取 Linux XDG desktop entry 并校验其 `TryExec`/`Exec` 可执行文件。
 */
export type OpenInAppLocator =
  | {
    readonly kind: 'fixed'
    readonly launch: OpenInAppLaunch
    /** 图标来源模板（macOS 上的 `.app` 目录，Windows 上的可执行文件）。 */
    readonly iconPath: string
  }
  | { readonly kind: 'app'; readonly fsNames: readonly string[] }
  | { readonly kind: 'xcode' }
  | {
    readonly kind: 'cli'
    readonly name: string
    readonly args: readonly string[]
    /** 在提供这个原生 GUI 启动器之前要求存在桌面会话。 */
    readonly requiresDesktop?: boolean | undefined
  }
  | { readonly kind: 'file'; readonly candidates: readonly string[]; readonly args: readonly string[] }
  | {
    readonly kind: 'scan'
    readonly root: string
    readonly namePrefix: string
    readonly relativeLauncher: string
    readonly args: readonly string[]
  }
  | { readonly kind: 'app-paths'; readonly exe: string; readonly args: readonly string[] }
  | {
    readonly kind: 'install-record'
    readonly displayNamePrefix: string
    /** 位于记录 `InstallLocation` 之下的启动器；缺省表示使用该记录的 `DisplayIcon` 可执行文件。 */
    readonly relativeLauncher?: string | undefined
    readonly args: readonly string[]
  }
  | { readonly kind: 'github-desktop'; readonly root: string }
  | { readonly kind: 'desktop'; readonly desktopId: string; readonly args: readonly string[] }

/** 某个平台的启动器来源，以及在 Linux 上拥有其图标的 desktop entry。 */
export interface OpenInAppPlatformSpec {
  /** 按顺序尝试；第一个产出已校验启动器的定位器胜出。 */
  readonly locators: readonly OpenInAppLocator[]
  /**
   * 其 `Icon=` 键命名了本应用图标的 XDG desktop-entry id（仅 Linux 规格；macOS 的图标来自
   * 已解析的 bundle，Windows 的图标来自已解析的可执行文件）。
   */
  readonly desktopId?: string
}

/** 一个可启动的应用程序以及能够提供它的各个平台。 */
export interface OpenInAppApp {
  readonly id: string
  readonly platforms: Readonly<Partial<Record<OpenInAppPlatform, OpenInAppPlatformSpec>>>
}

/** 在已知应用目录中查找命名 bundle 的 macOS 规格。 */
function macApp(...fsNames: string[]): OpenInAppPlatformSpec {
  return { locators: [{ kind: 'app', fsNames }] }
}

/** 由其定位器链构成的无图标规格。 */
function spec(...locators: OpenInAppLocator[]): OpenInAppPlatformSpec {
  return { locators }
}

/** 由其定位器链加上持有其图标的 Linux desktop entry 构成的规格。 */
function desktopSpec(desktopId: string, ...locators: OpenInAppLocator[]): OpenInAppPlatformSpec {
  return { locators, desktopId }
}

/** 启动已解析可执行文件的进程内 PATH 名字定位器。 */
function cli(name: string, ...args: string[]): OpenInAppLocator {
  return { kind: 'cli', name, args }
}

/** 仅在存在桌面会话时才有意义的进程内 PATH 名字定位器。 */
function desktopCli(name: string, ...args: string[]): OpenInAppLocator {
  return { kind: 'cli', name, args, requiresDesktop: true }
}

/** 启动所匹配候选的第一个存在文件定位器。 */
function file(candidates: string[], ...args: string[]): OpenInAppLocator {
  return { kind: 'file', candidates, args }
}

/** 针对某个已注册可执行文件名的 Windows `App Paths` 注册表定位器。 */
function appPaths(exe: string, ...args: string[]): OpenInAppLocator {
  return { kind: 'app-paths', exe, args }
}

/** 通过其所指向的可执行文件来校验的 Windows 卸载记录定位器。 */
function installRecord(displayNamePrefix: string, relativeLauncher?: string, ...args: string[]): OpenInAppLocator {
  return { kind: 'install-record', displayNamePrefix, relativeLauncher, args }
}

/**
 * JetBrains 产品条目：macOS 上为已知的 bundle 名（直接下载版与 Toolbox 版的写法），
 * Windows 上为最新的带版本 `%ProgramFiles%\JetBrains` 安装或一条已校验的卸载记录，
 * Linux 上为 PATH 命令或 Toolbox shell 脚本。
 */
function jetBrains(
  id: string, productName: string, cliName: string, winExe: string, macNames: readonly string[],
): OpenInAppApp {
  return {
    id,
    platforms: {
      darwin: macApp(...macNames),
      win32: spec(
        {
          kind: 'scan',
          root: '${ProgramFiles}/JetBrains',
          namePrefix: productName,
          relativeLauncher: `bin/${winExe}`,
          args: [],
        },
        installRecord(productName, `bin/${winExe}`),
      ),
      linux: spec(cli(cliName), file([`~/.local/share/JetBrains/Toolbox/scripts/${cliName}`])),
    },
  }
}

/**
 * 按菜单顺序排列的启动目录：文件管理器、编辑器与 IDE、Git GUI、终端。Finder、Terminal
 * 与 Explorer 随各自的操作系统一起提供，因此它们的定位器在这些系统上总是能解析。macOS 的
 * bundle 名列出了常见的安装写法；被改名或移出 `/Applications` 与 `~/Applications` 的
 * bundle 不会被检测到（README 已知限制）。
 */
export const OPEN_IN_APP_CATALOG: readonly OpenInAppApp[] = [
  {
    id: 'finder',
    platforms: {
      darwin: spec({
        kind: 'fixed',
        launch: { kind: 'shell-open' },
        iconPath: '/System/Library/CoreServices/Finder.app',
      }),
    },
  },
  {
    id: 'explorer',
    platforms: {
      win32: spec({
        kind: 'fixed',
        launch: { kind: 'shell-open' },
        iconPath: '${SystemRoot}/explorer.exe',
      }),
    },
  },
  { id: 'filemanager', platforms: { linux: spec(desktopCli('xdg-open')) } },
  {
    id: 'cursor',
    platforms: {
      darwin: macApp('Cursor.app'),
      win32: spec(
        appPaths('Cursor.exe'),
        installRecord('Cursor'),
        file(['${LOCALAPPDATA}/Programs/cursor/Cursor.exe']),
      ),
      linux: spec(cli('cursor')),
    },
  },
  {
    id: 'vscode',
    platforms: {
      darwin: macApp('Visual Studio Code.app'),
      win32: spec(
        appPaths('Code.exe'),
        installRecord('Microsoft Visual Studio Code', 'Code.exe'),
        file([
          '${LOCALAPPDATA}/Programs/Microsoft VS Code/Code.exe',
          '${ProgramFiles}/Microsoft VS Code/Code.exe',
        ]),
      ),
      linux: desktopSpec('code', cli('code')),
    },
  },
  {
    id: 'vscodeinsiders',
    platforms: {
      darwin: macApp('Visual Studio Code - Insiders.app'),
      win32: spec(
        appPaths('Code - Insiders.exe'),
        installRecord('Microsoft Visual Studio Code Insiders', 'Code - Insiders.exe'),
        file(['${LOCALAPPDATA}/Programs/Microsoft VS Code Insiders/Code - Insiders.exe']),
      ),
      linux: desktopSpec('code-insiders', cli('code-insiders')),
    },
  },
  {
    id: 'windsurf',
    platforms: {
      darwin: macApp('Windsurf.app'),
      win32: spec(
        appPaths('Windsurf.exe'),
        installRecord('Windsurf'),
        file(['${LOCALAPPDATA}/Programs/Windsurf/Windsurf.exe']),
      ),
      linux: spec(cli('windsurf')),
    },
  },
  {
    id: 'zed',
    platforms: {
      darwin: macApp('Zed.app', 'Zed Preview.app'),
      linux: desktopSpec('dev.zed.Zed', cli('zed'), { kind: 'desktop', desktopId: 'dev.zed.Zed', args: [] }),
    },
  },
  {
    id: 'sublimetext',
    platforms: {
      darwin: macApp('Sublime Text.app'),
      win32: spec(
        appPaths('sublime_text.exe'),
        installRecord('Sublime Text'),
        file(['${ProgramFiles}/Sublime Text/sublime_text.exe']),
      ),
      linux: desktopSpec('sublime_text', cli('subl')),
    },
  },
  { id: 'xcode', platforms: { darwin: spec({ kind: 'xcode' }) } },
  {
    id: 'androidstudio',
    platforms: {
      darwin: macApp('Android Studio.app'),
      win32: spec(
        installRecord('Android Studio', 'bin/studio64.exe'),
        file(['${ProgramFiles}/Android/Android Studio/bin/studio64.exe']),
      ),
      linux: spec(cli('studio'), file([
        '~/.local/share/JetBrains/Toolbox/scripts/studio',
        '/opt/android-studio/bin/studio.sh',
      ])),
    },
  },
  jetBrains('intellij', 'IntelliJ IDEA', 'idea', 'idea64.exe',
    ['IntelliJ IDEA.app', 'IntelliJ IDEA Ultimate.app', 'IntelliJ IDEA CE.app']),
  jetBrains('pycharm', 'PyCharm', 'pycharm', 'pycharm64.exe',
    ['PyCharm.app', 'PyCharm Professional.app', 'PyCharm CE.app', 'PyCharm Community.app']),
  jetBrains('webstorm', 'WebStorm', 'webstorm', 'webstorm64.exe', ['WebStorm.app']),
  jetBrains('phpstorm', 'PhpStorm', 'phpstorm', 'phpstorm64.exe', ['PhpStorm.app']),
  jetBrains('goland', 'GoLand', 'goland', 'goland64.exe', ['GoLand.app']),
  jetBrains('rider', 'Rider', 'rider', 'rider64.exe', ['Rider.app', 'JetBrains Rider.app']),
  jetBrains('rustrover', 'RustRover', 'rustrover', 'rustrover64.exe', ['RustRover.app']),
  {
    id: 'fork',
    platforms: {
      darwin: macApp('Fork.app'),
      win32: spec(installRecord('Fork'), file(['${LOCALAPPDATA}/Fork/Fork.exe'])),
    },
  },
  { id: 'sourcetree', platforms: { darwin: macApp('Sourcetree.app') } },
  {
    id: 'github',
    platforms: {
      darwin: macApp('GitHub Desktop.app'),
      win32: spec({ kind: 'github-desktop', root: '${LOCALAPPDATA}/GitHubDesktop' }),
    },
  },
  { id: 'tower', platforms: { darwin: macApp('Tower.app') } },
  { id: 'gitkraken', platforms: { darwin: macApp('GitKraken.app') } },
  { id: 'smartgit', platforms: { darwin: macApp('SmartGit.app') } },
  {
    id: 'sublimemerge',
    platforms: {
      darwin: macApp('Sublime Merge.app'),
      win32: spec(
        appPaths('sublime_merge.exe'),
        installRecord('Sublime Merge'),
        file(['${ProgramFiles}/Sublime Merge/sublime_merge.exe']),
      ),
      linux: desktopSpec('sublime_merge', cli('smerge')),
    },
  },
  {
    id: 'ghostty',
    platforms: {
      darwin: macApp('Ghostty.app'),
      linux: desktopSpec(
        'com.mitchellh.ghostty',
        cli('ghostty', `--working-directory=${PATH_TOKEN}`),
        { kind: 'desktop', desktopId: 'com.mitchellh.ghostty', args: [`--working-directory=${PATH_TOKEN}`] },
      ),
    },
  },
  { id: 'warp', platforms: { darwin: macApp('Warp.app') } },
  { id: 'iterm', platforms: { darwin: macApp('iTerm.app') } },
  {
    id: 'kitty',
    platforms: {
      darwin: macApp('kitty.app'),
      linux: desktopSpec(
        'kitty',
        cli('kitty', '--directory'),
        { kind: 'desktop', desktopId: 'kitty', args: ['--directory'] },
      ),
    },
  },
  {
    id: 'terminal',
    platforms: {
      darwin: spec({
        kind: 'fixed',
        launch: { kind: 'argv', command: 'open', args: ['-a', 'Terminal'] },
        iconPath: '/System/Applications/Utilities/Terminal.app',
      }),
    },
  },
  { id: 'windowsterminal', platforms: { win32: spec(cli('wt', '-d')) } },
  {
    id: 'gitbash',
    platforms: {
      win32: spec(
        // Git for Windows 注册为 "Git version <x.y.z>"；而裸的 "Git" 前缀也会匹配
        // "GitHub Desktop"。
        installRecord('Git version', 'git-bash.exe', `--cd=${PATH_TOKEN}`),
        file(['${ProgramFiles}/Git/git-bash.exe'], `--cd=${PATH_TOKEN}`),
      ),
    },
  },
  {
    id: 'gnometerminal',
    platforms: {
      linux: desktopSpec(
        'org.gnome.Terminal',
        cli('gnome-terminal', `--working-directory=${PATH_TOKEN}`),
        { kind: 'desktop', desktopId: 'org.gnome.Terminal', args: [`--working-directory=${PATH_TOKEN}`] },
      ),
    },
  },
  {
    id: 'konsole',
    platforms: {
      linux: desktopSpec(
        'org.kde.konsole',
        cli('konsole', '--workdir'),
        { kind: 'desktop', desktopId: 'org.kde.konsole', args: ['--workdir'] },
      ),
    },
  },
]
