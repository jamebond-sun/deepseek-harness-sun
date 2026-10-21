/**
 * Workspace 注册表归档准入的 `job` 族：一个 Session 拥有但尚未结算的后台任务，
 * 以及在 Session 连同其工作一起被归档时对它们的 kill。它由每一种注册表实现通过
 * seam 的构造函数安装，因此仅凭抽象的 `list` 与 `kill` 就对每一种实现都成立。
 *
 * @module @deepseek-ai/dsh-jobs
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionActivity } from '@deepseek-ai/dsh-workspace'
import type { JobRegistry } from './index.ts'
import type { JobView } from './view.ts'

/**
 * 用被询问的 Session 所拥有的、仍在运行或 stopping 的任务回答 `workspace/session-activity`，
 * 并通过逐个 kill 它们来回答 `workspace/session-stop`。两个监听器与 `ctx` 的 fiber
 * ——即注册表自己的 fiber——同生命周期。
 * @param ctx - 注册表的注册上下文。
 * @param registry - 用其 `list` 与 `kill` 作答的那个注册表。
 */
export function installJobArchiveAdmission(ctx: Context, registry: JobRegistry): void {
  ctx.on('workspace/session-activity', async ({ sessionId }, next) => {
    const jobs = runningJobs(registry, sessionId)
    const rest = await next()
    if (jobs.length === 0) return rest
    const own: SessionActivity = { kind: 'job', items: jobs.map(job => ({ id: job.id, label: job.label })) }
    return [own, ...rest]
  })
  ctx.on('workspace/session-stop', ({ sessionId }) => {
    for (const job of runningJobs(registry, sessionId)) {
      try {
        registry.kill(job.id, sessionId, 'session archived')
      } catch (error: unknown) {
        // 生产者取消时抛出不能让 Session 归档后其余的任务继续运行。
        ctx.logger.warn(`jobs: killing "${job.id}" for an archived Session failed: ${String(error)}`)
      }
    }
  })
}

/** 该 Session 拥有但尚未结算的任务；同一份列表里的无主任务不属于任何人。 */
function runningJobs(registry: JobRegistry, owner: SessionId): JobView[] {
  return registry.list(owner)
    .filter(job => job.owner === owner && (job.status === 'running' || job.status === 'stopping'))
}
