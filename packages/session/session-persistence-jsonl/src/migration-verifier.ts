/** 对一个已暂存或与之竞争的当前 JSONL 代际做隔离式校验。 */

import { Worker } from 'node:worker_threads'
import type { WorkerOptions } from 'node:worker_threads'
import type { JsonlCompression } from './format.ts'
import type { JsonlExpectedPrefix, JsonlVerifiedGeneration } from './generation.ts'

interface VerificationRequest {
  readonly path: string
  readonly compression: JsonlCompression
  readonly expectedId: string
  readonly expectedEventCount: number
  readonly expectedPrefix?: JsonlExpectedPrefix
}

type VerificationResponse =
  | { readonly ok: true; readonly result: JsonlVerifiedGeneration }
  | { readonly ok: false; readonly message: string; readonly stack?: string }

/** 面向全代际校验隔离环境的进程级内存上限。 */
const MAX_CONCURRENT_VERIFIERS = 2

class VerificationScheduler {
  private active = 0
  private readonly waiting: Array<{ grant(): void }> = []

  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const permit = this.acquire(signal)
    if (permit !== undefined) await permit
    try {
      signal?.throwIfAborted()
      return await operation()
    } finally {
      this.release()
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> | undefined {
    signal?.throwIfAborted()
    if (this.active < MAX_CONCURRENT_VERIFIERS) {
      this.active += 1
      return
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        grant: (): void => {
          signal?.removeEventListener('abort', abort)
          resolve()
        },
      }
      const abort = (): void => {
        const index = this.waiting.indexOf(waiter)
        this.waiting.splice(index, 1)
        reject(verifierAbortError(signal))
      }
      this.waiting.push(waiter)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }

  private release(): void {
    const next = this.waiting.shift()
    if (next === undefined) {
      this.active -= 1
      return
    }
    next.grant()
  }
}

const verificationScheduler = new VerificationScheduler()

function workerSpawn(request: VerificationRequest): { readonly entry: string | URL; readonly options: WorkerOptions } {
  /* v8 ignore next 3 -- 已构建 worker 的覆盖负责打包后的路径。 */
  if (!import.meta.url.endsWith('.ts')) {
    return {
      entry: new URL('./worker.cjs', import.meta.url),
      options: { workerData: request, execArgv: [] },
    }
  }
  const workerEntry = new URL('./worker.ts', import.meta.url)
  const bootstrap = [
    `import { register as registerEsm } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))}`,
    `import { register as registerCjs } from ${JSON.stringify(import.meta.resolve('tsx/cjs/api'))}`,
    'registerCjs()',
    'registerEsm()',
    `await import(${JSON.stringify(workerEntry.href)})`,
  ].join('\n')
  return {
    entry: new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`),
    options: {
      workerData: request,
      execArgv: [],
    },
  }
}

/**
 * 在一个全新的 Worker 线程中校验一个当前代际。
 * @param path - 已暂存或与之竞争的当前代际路径。
 * @param compression - 已配置的物理编码方式。
 * @param expectedId - 已解码头部中预期的 Session id。
 * @param expectedEventCount - 解码之后预期的精确逻辑事件数。
 * @param expectedPrefix - 已校验的物理前缀；可能存在追加尾部，且不会被校验。
 * @param signal - 可选取消信号，用于调度器等待与 Worker 执行。
 * @returns 在 worker 自然以 0 退出之后的物理身份与摘要。
 */
export function verifyCurrentGenerationInWorker(
  path: string,
  compression: JsonlCompression,
  expectedId: string,
  expectedEventCount: number,
  expectedPrefix?: JsonlExpectedPrefix,
  signal?: AbortSignal,
): Promise<JsonlVerifiedGeneration> {
  return verificationScheduler.run(() => runVerificationWorker(
    path,
    compression,
    expectedId,
    expectedEventCount,
    expectedPrefix,
    signal,
  ), signal)
}

function runVerificationWorker(
  path: string,
  compression: JsonlCompression,
  expectedId: string,
  expectedEventCount: number,
  expectedPrefix?: JsonlExpectedPrefix,
  signal?: AbortSignal,
): Promise<JsonlVerifiedGeneration> {
  signal?.throwIfAborted()
  const request: VerificationRequest = {
    path, compression, expectedId, expectedEventCount,
    ...(expectedPrefix === undefined ? {} : { expectedPrefix }),
  }
  const { entry, options } = workerSpawn(request)
  const worker = new Worker(entry, options)
  return new Promise((resolve, reject) => {
    let settled = false
    let success: Extract<VerificationResponse, { ok: true }> | undefined
    const cleanup = (): void => {
      signal?.removeEventListener('abort', abort)
    }
    const fail = (error: Error): void => {
      /* v8 ignore next -- 迟到的错误/退出只在另一个终结回调已结算之后才可能竞态。 */
      if (settled) return
      settled = true
      cleanup()
      void worker.terminate().then(
        () => { reject(error) },
        (cleanup: unknown) => {
          reject(new AggregateError([error, cleanup], 'migration verifier termination failed'))
        },
      )
    }
    worker.once('message', (value: unknown) => {
      /* v8 ignore next -- 重复的消息只在另一个终结回调已结算之后才可能竞态。 */
      if (settled) return
      if (typeof value !== 'object' || value === null || typeof (value as { ok?: unknown }).ok !== 'boolean') {
        fail(new Error('migration verifier returned an invalid response'))
        return
      }
      const response = value as VerificationResponse
      if (!response.ok) {
        const error = new Error(response.message)
        if (response.stack !== undefined) error.stack = response.stack
        fail(error)
        return
      }
      success = response
    })
    worker.once('error', fail)
    worker.once('exit', (code) => {
      if (settled) return
      settled = true
      cleanup()
      if (success === undefined) {
        reject(new Error(`migration verifier exited before reporting a result (code ${code})`))
      } else if (code !== 0) {
        reject(new Error(`migration verifier exited after reporting a result (code ${code})`))
      } else {
        resolve(success.result)
      }
    })
    const abort = (): void => { fail(verifierAbortError(signal)) }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

function verifierAbortError(signal?: AbortSignal): Error {
  const reason: unknown = signal?.reason
  return reason instanceof Error
    ? reason
    : new Error('migration verifier aborted', { cause: reason })
}
