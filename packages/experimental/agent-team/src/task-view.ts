/** 由任务看板与客户端投影共享的、纯函数式的任务视图派生。 */

import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TeamState } from './projection.ts'
import type { TeamTaskSnapshot, TeamTaskView } from './types.ts'

/**
 * 两个归一化后的文件或目录前缀是否在路径组件上重叠。
 * @param left - 归一化后的写入作用域。
 * @param right - 归一化后的写入作用域。
 * @returns 任一作用域是否包含另一个。
 */
function scopesOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

/**
 * 某个任务的每一个当前阻塞项是否都已完成。
 * @param state - 提供同级任务的 Team 状态。
 * @param task - 待测试的持久化任务快照。
 * @returns 该任务是否没有未完成的阻塞项。
 */
export function taskReady(state: TeamState, task: TeamTaskSnapshot): boolean {
  return task.blockedBy.every(id => state.tasks.find(candidate => candidate.id === id)?.status === 'completed')
}

/**
 * 派生一份带有属主名称、就绪状态与建议性写入重叠的任务视图。
 * 一次正在提交的调用方可以传入它在追加之前的状态，因为 `task` 显式提供了
 * 新值；当该快照被追加时，属主名称、阻塞项就绪状态以及其他任务作用域都不会变化。
 * @param state - 提供成员与同级任务的 Team 状态。
 * @param task - 待查看的持久化任务快照。
 * @returns 一份已分离的任务视图。
 */
export function projectTaskView(state: TeamState, task: TeamTaskSnapshot): TeamTaskView {
  const ownerName = task.ownerId === undefined
    ? undefined
    : task.ownerId === brandString<SessionId>(state.id)
      ? 'lead'
      : state.members.find(member => member.id === task.ownerId)?.name
  const warnings = new Set<string>()
  for (const other of state.tasks) {
    if (other.id === task.id || other.status !== 'in_progress') continue
    if (task.writeScopes.some(left => other.writeScopes.some(right => scopesOverlap(left, right)))) {
      warnings.add(`write scopes overlap with ${other.id}`)
    }
  }
  return {
    id: task.id,
    revision: task.revision,
    subject: task.subject,
    description: task.description,
    status: task.status,
    blockedBy: [...task.blockedBy],
    writeScopes: [...task.writeScopes],
    ...ownerName === undefined ? {} : { ownerName },
    ready: task.status === 'pending' && taskReady(state, task),
    writeScopeWarnings: [...warnings],
  }
}
