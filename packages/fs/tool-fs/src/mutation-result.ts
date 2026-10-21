/** 成功的文件修改操作共享的观测与结果字段。 */

import type { Context } from '@deepseek-ai/cordis'
import type { FsTarget, FsVersion } from '@deepseek-ai/dsh-fs'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

/**
 * 记录文件的新版本，并以规范路径暴露本次修改的结果。
 * @param ctx - 文件系统与观测事件的所有者。
 * @param target - 被修改的已解析文件。
 * @param outcome - 提供者返回的成功结果；其版本留在观测事件里。
 * @param exec - 发起调用的工具执行。
 * @returns 提供者结果中除版本以外的字段，外加规范的绝对路径。
 */
export function mutationResult<T extends { version: FsVersion }>(
  ctx: Context, target: FsTarget, outcome: T, exec: ToolExecution,
): Omit<T, 'version'> & { path: string } {
  const { version, ...result } = outcome
  ctx.emit('fs/observed', target, { kind: 'present', version }, exec)
  return { path: ctx.fs.processPath(target), ...result }
}
