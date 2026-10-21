/** 针对当前 Team 任务快照的完整依赖校验。 */

import type { TeamTaskId, TeamTaskSnapshot } from './types.ts'

/** 被共享图校验器所拒绝的任务依赖关系。 */
export type TeamTaskGraphViolation = 'missing' | 'duplicate' | 'cycle'

/** 包私有的任务依赖失败，保留供命令错误映射使用。 */
export class TeamTaskGraphError extends Error {
  /**
   * @param message - 具体的无效依赖关系。
   * @param violation - Team 命令所用的、稳定的关系类别。
   */
  constructor(message: string, readonly violation: TeamTaskGraphViolation) {
    super(message)
    this.name = 'TeamTaskGraphError'
  }
}

/**
 * 在替换一份候选快照之后，校验完整的活跃任务图。
 * @param current - 候选事件之前的当前任务快照。
 * @param candidate - 新的或下一修订版本的任务快照。
 * @throws {TeamTaskGraphError} 当某个活跃依赖缺失、重复、自引用或成环时。
 */
export function assertTaskGraphCandidate(
  current: readonly TeamTaskSnapshot[],
  candidate: TeamTaskSnapshot,
): void {
  const tasks = new Map(current.map(task => [task.id, task]))
  tasks.set(candidate.id, candidate)

  for (const task of tasks.values()) {
    if (task.status === 'deleted') continue
    const seen = new Set<TeamTaskId>()
    for (const blockerId of task.blockedBy) {
      if (blockerId === task.id) {
        throw new TeamTaskGraphError(`team task "${task.id}" cannot block itself`, 'cycle')
      }
      if (seen.has(blockerId)) {
        throw new TeamTaskGraphError(`team task "${task.id}" repeats blocker "${blockerId}"`, 'duplicate')
      }
      const blocker = tasks.get(blockerId)
      if (blocker === undefined || blocker.status === 'deleted') {
        throw new TeamTaskGraphError(
          `blocker task "${blockerId}" for "${task.id}" is missing or deleted`,
          'missing',
        )
      }
      seen.add(blockerId)
    }
  }

  const visiting = new Set<TeamTaskId>()
  const visited = new Set<TeamTaskId>()
  const visit = (id: TeamTaskId): void => {
    if (visiting.has(id)) {
      throw new TeamTaskGraphError(`task dependency cycle includes "${id}"`, 'cycle')
    }
    if (visited.has(id)) return
    const task = tasks.get(id)
    if (task === undefined || task.status === 'deleted') return
    visiting.add(id)
    for (const blockerId of task.blockedBy) visit(blockerId)
    visiting.delete(id)
    visited.add(id)
  }
  for (const task of tasks.values()) visit(task.id)
}
