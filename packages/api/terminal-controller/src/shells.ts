/** shell 选择与可执行文件验证使用目标执行提供方。 */
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { TerminalShell } from './types.ts'

/**
 * 解析配置的 shell 或执行环境的默认 shell。
 * @param subprocess - 目标执行提供方。
 * @param configured - 可选配置，用于覆盖环境的默认 shell。
 * @param signal - 解析取消。
 * @returns 一个已验证的 shell；声明的默认 shell 无法解析时拒绝。
 */
export async function resolveShell(
  subprocess: SubprocessRuntime, configured: TerminalShell | undefined, signal: AbortSignal,
): Promise<TerminalShell> {
  let shell = configured
  if (shell === undefined) {
    const environment = await subprocess.terminalEnvironment(signal)
    shell = profile(environment.defaultShell ?? (environment.platform === 'windows' ? 'cmd.exe' : '/bin/sh'))
  }
  const path = await subprocess.resolveExecutable(shell.path, undefined, signal)
  return { ...shell, path }
}

function profile(path: string): TerminalShell {
  const kind = shellKind(path)
  return { path, name: executableName(path), args: kind === 'cmd' ? [] : kind === 'pwsh' || kind === 'powershell' ? ['-NoLogo'] : ['-i'] }
}

function executableName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}

function shellKind(path: string): string {
  return executableName(path).toLowerCase().replace(/\.exe$/u, '')
}

/**
 * 列出排在配置的或环境默认 shell 之后的已验证候选，每个可执行名一个（忽略大小写与 `.exe`）。
 * PATH 查找可能经由另一个目录命中默认 shell，例如合并 `/usr` 的系统上以 `/usr/bin/bash` 对应 `/bin/bash`。
 * @param subprocess - 目标执行提供方。
 * @param configured - 可选的默认配置。
 * @param candidates - 允许用于 shell 选择的可执行名称或路径。
 * @param signal - 发现取消。
 * @returns 已安装的 shell（默认在最前），每个名称保留最早的条目；传输失败时拒绝。
 */
export async function discoverShells(
  subprocess: SubprocessRuntime, configured: TerminalShell | undefined,
  candidates: readonly string[], signal: AbortSignal,
): Promise<TerminalShell[]> {
  const preferred = await resolveShell(subprocess, configured, signal)
  const found = await Promise.all(candidates.map(async (candidate) => {
    try { return await resolveShell(subprocess, profile(candidate), signal) }
    catch (error) {
      if (typeof error === 'object' && error !== null
        && 'name' in error && error.name === 'SubprocessExecutableNotFoundError') return undefined
      throw error
    }
  }))
  const shells = new Map<string, TerminalShell>()
  for (const shell of [preferred, ...found]) {
    if (shell === undefined) continue
    const kind = shellKind(shell.path)
    if (!shells.has(kind)) shells.set(kind, shell)
  }
  return [...shells.values()]
}
