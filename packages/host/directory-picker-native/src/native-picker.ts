/** 原生后端能力背后的跨平台原生单目录选择器。 */

import { runNativeCommand, type NativeCommandRunner } from '@deepseek-ai/dsh-native-command'
import { pickWin32Directory } from './win32-dialog.ts'

/** 可测试的命令边界；原生实现从不经由 shell 调用。 */
export type DirectoryPickerRunner = NativeCommandRunner

/** 为确定性适配器测试注入的平台事实。 */
export interface DirectoryPickerInternals {
  platform?: NodeJS.Platform
  run?: DirectoryPickerRunner
  /** 替换进程内的 Win32 对话框（`pickWin32Directory`），便于确定性测试。 */
  pickWin32Dialog?: (signal: AbortSignal) => Promise<string | null>
}

/** 每个原生选择器都显示的提示语。 */
const DIALOG_TITLE = 'Select Workspace Directory'

/**
 * macOS 面板源码，由系统 JXA 宿主执行（`osascript -l JavaScript`）。
 *
 * 原生面板会把 ⌘C/⌘V/⌘A/⌘X 当作主菜单快捷键处理，而非当作焦点字段的行为，因此脚本在
 * 打开 `NSOpenPanel` 之前先装上该菜单；AppleScript 的 `choose folder` 运行在一个没有菜单
 * 的辅助程序中，导致其面板的每个文本框（前往文件夹、搜索、标签）都无法粘贴。菜单项保持
 * 无 target 状态，这样 AppKit 会针对持有面板字段编辑器的响应者链来启用它们。提示语通过
 * argv 传入，绝不作为可执行源码；取消时打印一个空行而不是失败。被取消的面板仍会在
 * `URLs` 中报告其高亮或当前目录，因此只有 OK 响应才读取选择结果。
 */
const MAC_PANEL = `
ObjC.import('AppKit');
function run(argv) {
  var app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  var mainMenu = $.NSMenu.alloc.init;
  mainMenu.addItem($.NSMenuItem.alloc.init);
  var editMenu = $.NSMenu.alloc.initWithTitle('Edit');
  var editItem = $.NSMenuItem.alloc.init;
  editItem.submenu = editMenu;
  mainMenu.addItem(editItem);
  editMenu.addItemWithTitleActionKeyEquivalent('Undo', 'undo:', 'z');
  editMenu.addItemWithTitleActionKeyEquivalent('Redo', 'redo:', 'Z');
  editMenu.addItemWithTitleActionKeyEquivalent('Cut', 'cut:', 'x');
  editMenu.addItemWithTitleActionKeyEquivalent('Copy', 'copy:', 'c');
  editMenu.addItemWithTitleActionKeyEquivalent('Paste', 'paste:', 'v');
  editMenu.addItemWithTitleActionKeyEquivalent('Select All', 'selectAll:', 'a');
  app.mainMenu = mainMenu;
  app.activateIgnoringOtherApps(true);
  var panel = $.NSOpenPanel.openPanel;
  panel.canChooseFiles = false;
  panel.canChooseDirectories = true;
  panel.canCreateDirectories = true;
  panel.allowsMultipleSelection = false;
  panel.message = argv[0];
  if (panel.runModal !== $.NSModalResponseOK) return '';
  var urls = panel.URLs;
  if (urls.count < 1) return '';
  return ObjC.unwrap(urls.objectAtIndex(0).path);
}`

function outputPath(stdout: string): string | null {
  const path = stdout.replace(/[\r\n]+$/, '')
  return path === '' ? null : path
}

function errorCode(error: unknown): string | number | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' || typeof code === 'number' ? code : undefined
}

function isMissingCommand(error: unknown): boolean {
  return errorCode(error) === 'ENOENT'
}

function rethrowIfAborted(signal: AbortSignal, error: unknown): void {
  if (signal.aborted) throw error
}

/**
 * 打开平台目录选择器。
 * @param signal - 调用方/连接生命周期；终止信号会结束原生命令。
 * @param internals - 供确定性测试注入的平台与运行器钩子。
 * @returns 选中的路径；用户取消时为 null。
 */
export async function pickNativeDirectory(
  signal: AbortSignal,
  internals: DirectoryPickerInternals = {},
): Promise<string | null> {
  const platform = internals.platform ?? process.platform
  const run = internals.run ?? runNativeCommand

  if (platform === 'darwin') {
    const result = await run('osascript', ['-l', 'JavaScript', '-e', MAC_PANEL, DIALOG_TITLE], signal, 'hidden')
    return outputPath(result.stdout)
  }

  if (platform === 'win32') {
    // 由 koffi 驱动的 IFileOpenDialog 子进程——支持 per-monitor-v2 DPI 与中止的现代选择器。
    // koffi 是打包依赖，安装即保证其可用，因此没有回退层：任何失败都原样暴露（不再有
    // PowerShell 回退层；见
    // .agents/notes/archived/simplification/2026-08-04-drop-windows-powershell-picker-fallback.md）。
    const pickDialog = internals.pickWin32Dialog ?? pickWin32Directory
    return await pickDialog(signal)
  }

  if (platform === 'linux') {
    try {
      const result = await run('zenity', [
        '--file-selection', '--directory', `--title=${DIALOG_TITLE}`,
      ], signal, 'hidden')
      return outputPath(result.stdout)
    } catch (error: unknown) {
      rethrowIfAborted(signal, error)
      if (errorCode(error) === 1) return null
      if (!isMissingCommand(error)) throw error
    }

    try {
      const result = await run('kdialog', [
        '--getexistingdirectory', '.', '--title', DIALOG_TITLE,
      ], signal, 'hidden')
      return outputPath(result.stdout)
    } catch (error: unknown) {
      rethrowIfAborted(signal, error)
      if (errorCode(error) === 1) return null
      if (isMissingCommand(error)) {
        throw new Error('no supported native directory picker found (install zenity or kdialog)')
      }
      throw error
    }
  }

  throw new Error(`native directory picker is unsupported on ${platform}`)
}
