/** 每 job 的观察生成：锚点、合并后的输出、终结 status。 */

import type { JobId } from '@deepseek-ai/dsh-jobs/brand'
import type { JobChunk, JobRegistry, JobStatus, JobView } from '@deepseek-ai/dsh-jobs'
import type { JobFollowFrame, JobFollowRequest } from './types.ts'
import { OutputWaiter, sleep } from './wake.ts'

/** 一次观察生成的节奏与组帧上限。 */
export interface ObserveJobOptions {
  /** wake 之后到读取之前的合并窗口，单位毫秒。 */
  readonly flushMs: number
  /**
   * 每个 `output` 帧的软字节预算。累计 chunk 一达到预算就冲刷；超过预算的
   * 单个 chunk 整块发送（registry 的保留上限是任何单个 chunk 的硬上限）。
   */
  readonly maxFrameBytes: number
}

function isTerminal(status: JobStatus): boolean {
  return status !== 'running' && status !== 'stopping'
}

/**
 * 从绝对偏移量开始流式输出一个 job 的保留输出：一个 `opened` 锚点，随环形
 * 缓冲推进而来的合并 `output` 帧，然后在落定的 job 排空之后一个终结
 * `status`，此后生成正常关闭。生成中途宣布的移除（owner 的清理）会以被
 * 移除 job 的终结投影关闭它，而不是以一次失败的读取。读取是非消费性的
 * ——面向模型的游标与通知状态从不观察它们；重连的调用方把上一帧的
 * `next` 作为 `from` 传入即可恢复。请求中的 session 是围栏读取的调用方：
 * registry 会拒绝该 session 看不到的 job 与未知的 job。
 * @param registry - 活动中的 job registry。
 * @param request - 目标 job、拥有 session 与可选的恢复偏移量。
 * @param options - 节奏与组帧上限。
 * @param signal - 由 Remote 流载体持有的本次生成取消信号。
 * @returns 一次生成的观察帧序列。
 */
export async function* observeJobOutput(
  registry: JobRegistry,
  request: JobFollowRequest,
  options: ObserveJobOptions,
  signal: AbortSignal,
): AsyncIterable<JobFollowFrame> {
  if (request.from !== undefined && (!Number.isSafeInteger(request.from) || request.from < 0)) {
    throw new Error(`invalid observe offset: expected a non-negative safe integer, got ${JSON.stringify(request.from)}`)
  }
  signal.throwIfAborted()
  // 品牌仅作名义类型用；wire 边界在此加盖品牌，而不是值导入 registry 包
  // 的构造函数。
  const id = String(request.jobId) as JobId
  const waiter = new OutputWaiter()
  // 生成期间宣布的移除：owner 的清理已落定并删除了记录，因此它宣布的投影
  // 就是最终结论，而冲刷窗口之后的读取只会找到未知 id。
  let removed: JobView | undefined
  // 在首次读取前订阅，这样锚点读取与等待之间的
  // 追加就不会被错过。
  const unsubscribe = registry.events.subscribe({ owners: 'all' }, (event) => {
    const changed = event.type === 'output' ? event.id : event.job.id
    if (changed !== id) return
    if (event.type === 'removed') removed = event.job
    waiter.wake()
  })
  try {
    let job = registry.get(id, request.sessionId)
    let cursor = request.from ?? job.output.earliest
    yield { type: 'opened', job, from: cursor }
    while (!signal.aborted) {
      if (removed !== undefined) {
        yield { type: 'status', job: removed }
        return
      }
      const read = registry.readAt(id, cursor, request.sessionId)
      if (read.chunks.length > 0 || read.lossy) {
        yield* outputFrames(read.chunks, read.next, read.lossy, options.maxFrameBytes)
      }
      cursor = read.next
      job = registry.get(id, request.sessionId)
      if (isTerminal(job.status) && cursor >= job.output.total) {
        yield { type: 'status', job }
        return
      }
      await waiter.wait(signal)
      // 让突发累积，使生产者的嘈杂输出成为有界帧。
      await sleep(options.flushMs, signal)
    }
  } finally {
    unsubscribe()
  }
}

/** 按每帧软字节预算把一次读取切分为多帧。 */
function* outputFrames(
  chunks: readonly JobChunk[],
  next: number,
  lossy: boolean,
  maxFrameBytes: number,
): Iterable<JobFollowFrame> {
  let batch: JobChunk[] = []
  let batchBytes = 0
  let flaggedLossy = lossy
  for (const chunk of chunks) {
    batch.push(chunk)
    batchBytes += Buffer.byteLength(chunk.text, 'utf8')
    if (batchBytes >= maxFrameBytes) {
      const last = batch[batch.length - 1]
      /* v8 ignore start -- a non-empty batch always has a last chunk; the arm only discharges noUncheckedIndexedAccess. */
      const end = last === undefined ? next : last.at + Buffer.byteLength(last.text, 'utf8')
      /* v8 ignore stop */
      yield {
        type: 'output',
        chunks: batch,
        next: end,
        ...flaggedLossy ? { lossy: true as const } : {},
      }
      flaggedLossy = false
      batch = []
      batchBytes = 0
    }
  }
  if (batch.length > 0 || flaggedLossy) {
    yield {
      type: 'output',
      chunks: batch,
      next,
      ...flaggedLossy ? { lossy: true as const } : {},
    }
  }
}
