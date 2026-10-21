/**
 * 在会话当前目录下执行文件系统调用所用的解析选项。
 * 非 agent 调用把目录默认值留给文件系统提供者决定。
 * @module @deepseek-ai/dsh-tool-fs/session-cwd
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'

/**
 * 解析一次文件系统调用所用的当前目录与取消信号。
 * @param ctx - 包含工作目录服务的上下文。
 * @param exec - 提供 agent 与取消信号的工具执行。
 * @returns 本次调用的文件系统解析选项。
 */
export async function sessionResolveOptions(
  ctx: Context,
  exec: ToolExecution,
): Promise<{ cwd?: string; signal?: AbortSignal }> {
  const cwd = exec.agent === undefined
    ? undefined
    : await ctx.workingDirectory.ensure(exec.agent, exec.signal)
  return { ...cwd !== undefined ? { cwd } : {}, signal: exec.signal }
}
