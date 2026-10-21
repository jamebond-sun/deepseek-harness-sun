/**
 * 本地 LSP provider 在宿主 I/O、队列与协议阶段共用的取消辅助函数。
 * @module @deepseek-ai/dsh-lsp-stdio/abort
 */

import { timeoutOf } from '@deepseek-ai/dsh-timeout'

/**
 * 构造一个携带 signal 原因、并保留超时分类的中止 Error。
 * @param signal - 已中止的 signal，其原因为要呈现的原因。
 * @returns 存在超时原因时返回它，否则返回 Error 原因，再否则返回一个通用的已中止 Error。
 */
export function abortError(signal: AbortSignal): Error {
  const timeout = timeoutOf(signal)
  if (timeout !== undefined) return timeout
  const reason: unknown = signal.reason
  if (reason instanceof Error) return reason
  return new Error('LSP query aborted')
}

/**
 * 当 signal 已经触发时，抛出其已分类的中止错误。
 * @param signal - 可选的查询取消 signal。
 */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal)
}

/**
 * 等待一项工作，同时允许查询 signal 放弃等待；底层工作保留自己的处理器，
 * 并继续运行到其所有者定义的静止边界。
 * @param work - 被拥有的异步工作。
 * @param signal - 可选的查询取消。
 * @returns 工作结果，或一个携带已分类中止原因的拒绝。
 */
export function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return work
  if (signal.aborted) return Promise.reject(abortError(signal))
  const canceled = Promise.withResolvers<never>()
  const onAbort = (): void => { canceled.reject(abortError(signal)) }
  signal.addEventListener('abort', onAbort, { once: true })
  const normalized = work.catch((error: unknown) => {
    /* v8 ignore next -- 自有的 LSP promise 都以 Error 拒绝；此处的强转是为这个通用辅助函数兜底。 */
    throw error instanceof Error ? error : new Error(String(error))
  })
  return Promise.race([normalized, canceled.promise])
    .finally(() => { signal.removeEventListener('abort', onAbort) })
}
