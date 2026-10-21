/**
 * 后台 workflow 运行的实时进度镜像：将引擎的
 * `workflow/phase`、`workflow/log` 以及成员生命周期事件作为 `log`
 * 片段流入所属 job 的输出环形缓冲 —— 这类观察性的叙述是模型的
 * `job_output` 永远不会渲染的 —— 并将 job 的实时进度行保持在当前阶段。
 * 对已结算 job 日志的追加落在注册表内部，因此结算后零星到达的事件是无害的。
 * @module @deepseek-ai/dsh-tool-workflow/record
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JobHandle } from '@deepseek-ai/dsh-jobs'
import type { WorkflowRunId } from '@deepseek-ai/dsh-workflow'

/** 该工具所跟踪的后台运行对应的 job 环形缓冲接入点。 */
export interface WorkflowRecordMirror {
  /**
   * 将一个运行的进度事件路由到某个 job 的环形缓冲。每个后台运行调用一次，
   * 在 worker 发布其首个事件之前、由 job 启动器调用。
   * @param runId - 已启动的运行。
   * @param job - 所属 job 的生产者接口。
   */
  start(runId: WorkflowRunId, job: JobHandle): void
  /**
   * 停止路由一个已结算或被放弃的运行。幂等。
   * @param runId - 要丢弃的运行。
   */
  stop(runId: WorkflowRunId): void
}

/**
 * 创建运行到环形缓冲的镜像，并为它所跟踪的运行订阅引擎的实时进度事件。
 * @param ctx - 事件总线承载 `workflow/*` 事件的插件上下文。
 * @returns 该工具在每个后台运行周围接入的镜像接入点。
 */
export function createWorkflowRecordMirror(ctx: Context): WorkflowRecordMirror {
  const active = new Map<WorkflowRunId, JobHandle>()

  ctx.on('workflow/phase', (info, title) => {
    const job = active.get(info.id)
    if (job === undefined) return
    job.updateProgress(title)
    job.append(`▸ ${title}\n`, { channel: 'log' })
  })
  ctx.on('workflow/log', (info, message) => {
    active.get(info.id)?.append(`${message}\n`, { channel: 'log' })
  })
  ctx.on('workflow/agent-start', (info, agent) => {
    active.get(info.id)?.append(`agent #${agent.seq} ${agent.label} started\n`, { channel: 'log' })
  })
  ctx.on('workflow/agent-end', (info, agent) => {
    active.get(info.id)?.append(`agent #${agent.seq} ${agent.outcome}\n`, { channel: 'log' })
  })

  return {
    start(runId, job) {
      active.set(runId, job)
    },
    stop(runId) {
      active.delete(runId)
    },
  }
}
