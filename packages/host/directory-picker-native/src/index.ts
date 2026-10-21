/**
 * 目录选择接缝的原生后端：以 `native` 能力注册 `ctx.directoryPicker`，每次选择在宿主
 * 显示器上打开一个原生操作系统选择器（macOS 上是脚本化的 AppKit 面板，在打开
 * `NSOpenPanel` 之前装上标准 Edit 菜单；Linux 上用 Zenity，KDialog 作为回退；Windows
 * 则在派生的子进程中打开现代 `IFileOpenDialog`——在子进程主线程上由 koffi 驱动的 COM
 * 会话，并在此之前合成一次 Alt 按下，使对话框即使在后台宿主派生子进程的情况下也能作为
 * 前台窗口激活）。仅当操作者就在宿主屏幕前时才可用；远程部署应改用 browse 后端。
 * @module @deepseek-ai/dsh-host-directory-picker-native
 */

import { DirectoryPicker } from '@deepseek-ai/dsh-host-directory-picker'
import type { DirectoryPickerCapability } from '@deepseek-ai/dsh-host-directory-picker'
import { pickNativeDirectory } from './native-picker.ts'

export type { DirectoryPickerInternals, DirectoryPickerRunner } from './native-picker.ts'
export { pickNativeDirectory } from './native-picker.ts'

/** `ctx.directoryPicker` 的原生实现（每个服务生命周期内能力对象保持稳定）。 */
export default class NativeDirectoryPicker extends DirectoryPicker {
  private readonly nativeCapability: DirectoryPickerCapability = {
    kind: 'native',
    /* v8 ignore next -- 纯转发到 pickNativeDirectory（其行为由其测试负责）；在此处调用会真的打开一个选择器。 */
    pick: signal => pickNativeDirectory(signal),
  }

  /**
   * 原生交互能力。
   * @returns 稳定的 `native` 能力对象。
   */
  capability(): DirectoryPickerCapability {
    return this.nativeCapability
  }
}
