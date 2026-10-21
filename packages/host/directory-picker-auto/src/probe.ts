/**
 * 对原生后端 Linux 选择器可执行文件的 PATH 探测：为解析器提供一个启动时采样的事实，
 * 从而在缺少 zenity/kdialog 的有值守 Linux 宿主上保留可用的 `browse` 交互形态，而不是
 * 选一个每次选择都失败的后端。
 * @module @deepseek-ai/dsh-host-directory-picker-auto/probe
 */

import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'

/** 原生后端在 Linux 上可驱动的选择器可执行文件（zenity，KDialog 作为回退）。 */
const LINUX_CHOOSER_BINARIES = ['zenity', 'kdialog'] as const

/**
 * 当前进程是否可以执行该候选路径。
 * @param candidate - 绝对路径或由 PATH 拼接而成的文件路径。
 * @returns 仅当该文件存在且可执行时为 true。
 */
export function canExecute(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK)
  } catch {
    // 候选文件不存在或不可执行——这是 accessSync(X_OK) 仅有的两种信号。
    return false
  }
  return true
}

/**
 * 在 PATH 值中扫描原生后端可用的 Linux 选择器可执行文件。
 * @param pathValue - `PATH` 环境变量值（缺失或为空时不扫描任何内容）。
 * @param isExecutable - 可执行性判定谓词（生产环境为 {@link canExecute}；注入以便测试确定性）。
 * @returns PATH 中是否存在任一目录包含可执行的选择器二进制文件。
 */
export function hasLinuxChooserBinary(pathValue: string | undefined, isExecutable: (candidate: string) => boolean): boolean {
  for (const dir of (pathValue ?? '').split(delimiter)) {
    if (dir === '') continue
    for (const name of LINUX_CHOOSER_BINARIES) {
      if (isExecutable(join(dir, name))) return true
    }
  }
  return false
}
