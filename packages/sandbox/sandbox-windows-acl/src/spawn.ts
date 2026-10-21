/** 构建在共享 Win32 进程所有者之上的受限令牌适配器。 */

import {
  spawnInheritedJobProcess,
  spawnPipedProcess,
  waitForProcessExit,
} from '@deepseek-ai/dsh-win32-process'
import type {
  NativePtr,
  SpawnedJobProcess,
  SpawnedPipedProcess,
} from '@deepseek-ai/dsh-win32-process'
import type { Win32Bindings } from './ffi.ts'

export { drainPipe } from '@deepseek-ai/dsh-win32-process'

/** 带有管道式 stdio 资源的受限令牌子进程。 */
export interface SpawnedNative extends SpawnedPipedProcess {}
/** 被分配到一个"关闭即终止"Job 中的受限令牌子进程。 */
export interface SpawnedInherited extends SpawnedJobProcess {}

/**
 * 派生一个 stdout/stderr 走管道的受限令牌子进程。
 * @param api - ACL/令牌绑定表。
 * @param token - 受限主令牌。
 * @param options - 命令、参数与工作目录。
 * @returns 进程以及由调用方持有的管道句柄。
 */
export function spawnSandboxed(
  api: Win32Bindings,
  token: NativePtr,
  options: { command: string; args: readonly string[]; cwd: string },
): SpawnedNative {
  return spawnPipedProcess(api, { ...options, token })
}

/**
 * 在一个"关闭即终止"的 Job 中派生一个 stdio 继承的受限令牌子进程。
 * @param api - ACL/令牌绑定表。
 * @param token - 受限主令牌。
 * @param options - 命令、参数与工作目录。
 * @returns 完成分配与恢复之后的进程与 Job 句柄。
 */
export function spawnSandboxedInherited(
  api: Win32Bindings,
  token: NativePtr,
  options: { command: string; args: readonly string[]; cwd: string; controlFileDescriptor?: 7 },
): SpawnedInherited {
  return spawnInheritedJobProcess(api, { ...options, token })
}

/**
 * 等待一个受限子进程并关闭其进程句柄。
 * @param api - ACL/令牌绑定表。
 * @param process - 由调用方持有的进程句柄。
 * @returns 进程的直接退出码。
 */
export function waitForExit(api: Win32Bindings, process: NativePtr): number {
  return waitForProcessExit(api, process)
}
