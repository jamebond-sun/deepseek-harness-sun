/** 为首次使用 Workspace 创建解析 Host 账户的 Documents 目录。 */

import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { runNativeCommand, type NativeCommandRunner } from '@deepseek-ai/dsh-native-command'
import { DEFAULT_WORKSPACE_DIRECTORY } from './default-workspace.ts'

/** 目录解析测试中可替换的平台观察。 */
interface DocumentsDirectoryInternals {
  readonly platform?: NodeJS.Platform
  readonly home?: string
  readonly run?: NativeCommandRunner
}

/**
 * 校验配置的或操作系统返回的 Documents 路径，不相对 cwd 解析它。
 * @param directory - 完全限定的目录写法。
 * @param platform - Host 平台。
 * @returns 归一化后的目录。
 */
export function validateDocumentsDirectory(directory: string, platform: NodeJS.Platform = process.platform): string {
  const paths = platform === 'win32' ? win32 : posix
  const root = paths.parse(directory).root
  if (!paths.isAbsolute(directory) || (platform === 'win32' && (root === '\\' || root === '/'))) {
    throw new Error(`Documents directory must be fully qualified: '${directory}'`)
  }
  return paths.normalize(directory)
}

/**
 * 在 Host 上解析首次使用目录，不创建文件。
 * @param documentsDirectory - 对系统 Documents 目录的显式部署覆盖。
 * @param signal - 调用方生命周期与查询期限。
 * @param internals - 平台事实与原生命令执行器。
 * @returns 绝对候选路径。
 */
export async function defaultWorkspaceDirectory(
  documentsDirectory: string | undefined,
  signal: AbortSignal,
  internals: DocumentsDirectoryInternals = {},
): Promise<string> {
  const platform = internals.platform ?? process.platform
  const paths = platform === 'win32' ? win32 : posix
  signal.throwIfAborted()
  let directory = documentsDirectory
  if (directory === undefined) {
    const run = internals.run ?? runNativeCommand
    let stdout: string
    switch (platform) {
      case 'darwin':
        ({ stdout } = await run('osascript', [
          '-e', 'POSIX path of (path to documents folder from user domain without folder creation)',
        ], signal, 'hidden'))
        break
      case 'win32':
        ({ stdout } = await run('powershell.exe', [
          '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
          '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); '
          + '[Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments, '
          + '[Environment+SpecialFolderOption]::DoNotVerify)',
        ], signal, 'hidden'))
        break
      case 'linux':
        ({ stdout } = await run('xdg-user-dir', ['DOCUMENTS'], signal, 'hidden'))
        break
      default:
        throw new Error(`system Documents directory is unavailable on ${platform}`)
    }
    directory = stdout.replace(/[\r\n]+$/, '')
    // 该用户目录被禁用时，XDG 报告主目录。
    if (directory === '' || (platform === 'linux' && paths.normalize(directory) === (internals.home ?? homedir()))) {
      throw new Error('system Documents directory is unavailable')
    }
  }
  directory = validateDocumentsDirectory(directory, platform)
  signal.throwIfAborted()
  return paths.join(directory, 'deepseek-harness', DEFAULT_WORKSPACE_DIRECTORY)
}
