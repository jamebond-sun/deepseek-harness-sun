/** 绑定到单个普通子进程句柄的最小化受管范围所有权。 */

import type { Duplex, Readable, Writable } from 'node:stream'
import type { SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'

/** 由终止与整个范围结算所使用的平台所有者。 */
export interface BoundProcessOwner {
  /** 向受管范围发信号；`cancellationReason` 仅用于 Windows 目标提交之前。 */
  signal(signal: 'SIGTERM' | 'SIGKILL', cancellationReason?: unknown): void
  /** 等待同一受管范围变为空；当无法观察时拒绝。 */
  waitForExit(): Promise<void>
  /**
   * Count tasks in the native range, including descendants outside the observable process tree.
   * @returns the current count, or undefined when observation is unavailable.
   */
  inspectTaskCount?(): number | undefined
  /** 在 JavaScript 可观察的主机退出期间，同步强制最终终止。 */
  terminateForHostExit(): void
  /** 在结果与范围结算之后，释放提供方私有的协议产物。 */
  cleanup?(): void
}

/** 由通用 stdio 与结果生命周期所使用的平台启动事实。 */
export interface ManagedProcessLaunch {
  stdin: Writable | null
  stdout: Readable | null
  stderr: Readable | null
  control?: Duplex | undefined
  direct: Promise<SubprocessOutcome>
  owner: BoundProcessOwner
}

/**
 * 将一个可选的中止边界应用到一份共享的等待承诺上。
 * @param pending - 所有调用方共享的受管范围等待。
 * @param signal - 可选的调用方取消信号。
 * @returns 受管范围等待是否在取消之前完成。
 */
export async function waitWithAbort(pending: Promise<void>, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) {
    void pending.catch(() => {})
    return false
  }
  if (signal === undefined) {
    await pending
    return true
  }
  const aborted = Promise.withResolvers<boolean>()
  const onAbort = (): void => { aborted.resolve(false) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([pending.then(() => true), aborted.promise])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
