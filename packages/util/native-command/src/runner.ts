/**
 * 面向宿主原生 OS 集成的、共享的无 shell `execFile` 运行器。
 * @module @deepseek-ai/dsh-native-command/runner
 */

import { execFile } from 'node:child_process'

/** 可测试的命令边界；原生实现绝不调用 shell。 */
export type NativeCommandRunner = (
  command: string,
  args: readonly string[],
  signal: AbortSignal,
  window: 'hidden' | 'visible',
) => Promise<{ stdout: string; stderr: string }>

/**
 * 以 utf8 stdio、abort 传播，以及显式 GUI 可见性运行一个宿主命令。
 * @param command - 可执行文件路径或 PATH 名称。
 * @param args - argv（绝不为 shell 字符串）。
 * @param signal - 调用方/连接生命周期；abort 会终止子进程。
 * @param window - Windows 启动可见性：`hidden` 用于后台命令，`visible` 用于 GUI 启动器。其他平台忽略。
 * @returns 退出码 0 时捕获的 stdout/stderr。
 */
export const runNativeCommand: NativeCommandRunner = (command, args, signal, window) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { encoding: 'utf8', signal, windowsHide: window === 'hidden' },
      (error, stdout, stderr) => {
        if (error !== null) {
          const failure = Object.assign(new Error(error.message, { cause: error }), {
            code: error.code,
            stdout,
            stderr,
          })
          reject(failure)
          return
        }
        resolve({ stdout, stderr })
      },
    )
  })
