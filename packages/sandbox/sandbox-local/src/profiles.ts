/**
 * 本地沙箱提供者内部使用的各平台配置构建器。
 *
 * @module @deepseek-ai/dsh-sandbox-local/profiles
 */

import { grantArgs as landlockGrantArgs } from '@deepseek-ai/node-addon-system/landlock-run'
import { writableRoots } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'

/**
 * 为一份文件效应策略构建 bwrap 配置参数。
 * @param policy - 要表达为 bwrap 挂载的文件效应策略。
 * @returns 位于尾部分隔符与命令 argv 之前的配置参数。
 */
export function bwrapProfileArgs(policy: SandboxPolicy): string[] {
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']
  if (policy.mode === 'workspace-write') {
    args.push('--tmpfs', '/tmp')
    args.push('--bind', policy.workspaceRoot, policy.workspaceRoot)
  }
  return args
}

/**
 * 为一份文件效应策略构建 Landlock 启动器的授予项。
 * @param policy - 要表达为 Landlock 允许列表授予项的文件效应策略。
 * @returns 位于尾部分隔符与命令 argv 之前的启动器授予参数。
 */
export function landlockProfileArgs(policy: SandboxPolicy): string[] {
  const readWrite = ['/dev/null']
  if (policy.mode === 'workspace-write') {
    readWrite.push('/tmp', policy.workspaceRoot)
  }
  return landlockGrantArgs({ readOnly: ['/'], readWrite })
}

/** 把一个路径引用为 SBPL 字符串字面量。 */
function sbplString(path: string): string {
  return `"${path.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`
}

/**
 * 为一份策略构建 sandbox-exec 参数与 SBPL 配置。可写根来自共用的
 * {@link writableRoots} 辅助函数（规范化、已去重），因此 Seatbelt 的授予
 * 与进程内 fs 围栏（`@deepseek-ai/dsh-fs-sandbox`）永远不会彼此漂移。
 * @param policy - 要表达为 SBPL 配置的文件效应策略。
 * @returns 位于尾部分隔符与命令 argv 之前的 sandbox-exec 参数。
 */
export function seatbeltProfileArgs(policy: SandboxPolicy): string[] {
  const forms = ['(version 1)', '(allow default)', '(deny file-write*)', `(allow file-write* (literal ${sbplString('/dev/null')}))`]
  const roots = writableRoots(policy)
  if (roots.length > 0) {
    forms.push(`(allow file-write* ${roots.map(root => `(subpath ${sbplString(root)})`).join(' ')})`)
  }
  return ['-p', forms.join(' ')]
}
