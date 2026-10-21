/** 在被挂载的 PTC 运行时的 Node 进程内执行一个 workflow VM。 */

import type { WorkflowResult } from '@deepseek-ai/dsh-workflow'
import type { WorkflowGuestHost, WorkflowProgress } from './guest-types.ts'
import { renderThrown } from './realm.ts'
import { WorkflowExecution } from './runtime.ts'
import type { ExecutionObserver } from './runtime.ts'
import type { ChildPort } from './types.ts'

/**
 * 运行一个 workflow，同时只允许一批进度在途。在子项释放与终结结果之前
 * 先排空进度；PTC 与宿主拥有取消与清理。
 * @param host - 本 workflow 运行拥有的 JSON 回调。
 * @returns 进度投递后的脚本结果；初始化失败会 reject。
 */
export async function runWorkflowGuest(host: WorkflowGuestHost): Promise<WorkflowResult> {
  const init = await host.begin({})
  let queued: WorkflowProgress[] = []
  let inFlight: Promise<void> | undefined
  let progressError: string | undefined
  const flush = (): void => {
    if (inFlight !== undefined || queued.length === 0) return
    const batch = queued
    queued = []
    inFlight = host.progress(batch).then(
      () => { inFlight = undefined; flush() },
      (error: unknown) => {
        progressError = renderThrown(error)
        queued = []
        inFlight = undefined
      },
    )
  }
  const send = (event: WorkflowProgress): void => {
    if (progressError !== undefined) return
    queued.push(event)
    // 首批进度会在同步脚本抢占其循环之前到达宿主。
    flush()
  }
  const drain = async (): Promise<void> => {
    while (inFlight !== undefined) await inFlight
  }
  const observer: ExecutionObserver = {
    phase: (title) => { send({ type: 'phase', title }) },
    log: (message) => { send({ type: 'log', message }) },
    agentStart: (info) => { send({ type: 'agent-start', info }) },
    agentEnd: (info) => { send({ type: 'agent-end', info }) },
  }
  const children: ChildPort = {
    async startAgent(request) {
      const { callId, childId } = await host.startChild(request)
      const result = host.childResult({ callId })
      // 一个被丢弃的 agent() 调用不得将子项失败变成未处理拒绝。
      void result.catch(() => {})
      return {
        id: childId,
        result,
        async dispose() {
          // 启动观察者在子项的宿主注册仍然存活时就必须收到它。
          await drain()
          await host.disposeChild({ callId })
        },
      }
    },
  }
  const execution = new WorkflowExecution(init.meta, init.body, init.args, init.limits, observer, children)
  const result = await execution.drive()
  await drain()
  return progressError === undefined ? result : {
    value: null,
    stopReason: 'error',
    error: progressError,
    agentsStarted: result.agentsStarted,
  }
}
