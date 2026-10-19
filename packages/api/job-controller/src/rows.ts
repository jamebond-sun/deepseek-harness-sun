/** 每 session 的 roster 生成：调用方可见的 job 集合，在每次生命周期变更后整体替换。 */

import type { JobRegistry } from '@deepseek-ai/dsh-jobs'
import type { JobListFrame, JobListRequest } from './types.ts'
import { OutputWaiter, sleep } from './wake.ts'

/** 一次 roster 生成的节奏上限。 */
export interface RowsOptions {
  /** 生命周期事件后到下一次 rows 读取之间的合并窗口，单位毫秒。 */
  readonly flushMs: number
}

/**
 * 流式输出一个 session 能看到的 job：打开时一帧，之后每次触及可见 job 的
 * 生命周期提交（注册、进度、停止、落定、移除）后一帧，按 `flushMs` 合并。
 * 输出追加从不刷新 roster——已落定的投影已携带最终字节数——因此 job 仅仅
 * 写入时流保持安静。读取是投影；模型的游标与通知状态从不观察它们。
 * @param registry - 活动中的 job registry。
 * @param request - 要镜像其可见集合的 session。
 * @param options - 合并窗口。
 * @param signal - 由 Remote 流载体持有的本次生成取消信号。
 * @returns 一次生成的 roster 帧序列。
 */
export async function* streamJobRows(
  registry: JobRegistry,
  request: JobListRequest,
  options: RowsOptions,
  signal: AbortSignal,
): AsyncIterable<JobListFrame> {
  signal.throwIfAborted()
  const waiter = new OutputWaiter()
  // 在首次读取前订阅，这样读取与等待之间的
  // 提交就不会被错过。
  const unsubscribe = registry.events.subscribe({ owners: 'all' }, (event) => {
    if (event.type === 'output') return
    const owner = event.job.owner
    if (owner === undefined || owner === request.sessionId) waiter.wake()
  })
  try {
    yield { type: 'rows', jobs: registry.list(request.sessionId) }
    while (true) {
      await waiter.wait(signal)
      // 让一波提交合并为一帧。
      await sleep(options.flushMs, signal)
      if (signal.aborted) return
      yield { type: 'rows', jobs: registry.list(request.sessionId) }
    }
  } finally {
    unsubscribe()
  }
}
