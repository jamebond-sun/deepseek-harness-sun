/**
 * PowerShell 可执行文件解析，无依赖，以便非本包的消费方（仓库中
 * `vitest.config.ts` 里的覆盖率网关探针）与执行器及其测试套件共用唯一的
 * 一份解析定义——若探针的解析方式与被测代码不同，就可能豁免掉一个测试
 * 套件实际会运行的文件。
 *
 * @module @deepseek-ai/dsh-pwsh-local/resolve
 */

import { lstatSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 常见的 Windows PowerShell 安装位置加上 PATH 条目，由新到旧排列。显式
 * 以 env 为参数，使解析在任何平台上都是输入的纯函数。
 * @param env - 待探测的环境；默认为进程环境。
 * @returns 按解析顺序排列的候选 `pwsh` 可执行文件路径。
 */
export function candidatePwshPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
  const systemRoot = env.SystemRoot ?? 'C:\\Windows'
  const candidates = [
    join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
  ]
  // Microsoft Store 安装（以及任何用户自行添加的位置）位于 PATH 上；
  // 这些条目可能带有 `setx` 风格定义留下的包裹引号。
  for (const entry of (env.PATH ?? '').split(';')) {
    const trimmed = entry.trim().replace(/^"|"$/g, '')
    if (trimmed.length === 0) continue
    candidates.push(join(trimmed, 'pwsh.exe'))
  }
  // 在旧版宿主机上，Windows PowerShell 5.1 仍是最后的兜底项。
  candidates.push(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
  return candidates
}

/**
 * 判断某个候选项是否可被 spawn。lstat 打开条目本身而不跟随重解析点，因此
 * 它能看到 Store 应用执行别名，而 stat 会撞上目标自身的 ACL（EACCES）；
 * Node 在当前版本把该别名报告为符号链接，在较旧版本则报告为普通文件，
 * 而 CreateProcess 对这两种形态都能解析。真实的目录永远不会被匹配。
 */
function candidateExists(candidate: string): boolean {
  try {
    const stat = lstatSync(candidate)
    return stat.isFile() || stat.isSymbolicLink()
  } catch {
    // ENOENT（候选项在列举与探测之间消失）是唯一预期的失败；其他任何错误
    // 都指向不可 spawn 的路径，因此对它也以 false 作为安全答案。
    return false
  }
}

/**
 * 解析本执行器要 spawn 的 pwsh 可执行文件。
 * @param configured - 显式的 `pwshPath` 配置值，按原样信任。
 * @param env - 在 Windows 上待探测的环境；默认为进程环境。
 * @param platform - 要解析的目标平台；默认为进程平台。
 * @returns Windows 上第一个存在的常见位置（PowerShell 7 安装位置、诸如
 *   Microsoft Store 安装的 PATH 条目，然后是 Windows PowerShell 5.1），
 *   否则返回 `pwsh` 交由 PATH 解析。
 */
export function resolvePwshPath(
  configured?: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (configured !== undefined && configured.length > 0) return configured
  if (platform === 'win32') {
    for (const candidate of candidatePwshPaths(env)) {
      if (candidateExists(candidate)) return candidate
    }
  }
  return 'pwsh'
}
