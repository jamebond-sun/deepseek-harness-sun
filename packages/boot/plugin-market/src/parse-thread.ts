/** 在全新的 Worker 线程中运行索引解析，使大索引不会阻塞 Host 的事件循环。 */
import { Worker, type WorkerOptions } from 'node:worker_threads'
import type { IndexParseRequest, IndexParseResult } from './parse.ts'

function workerSpawn(): { readonly entry: URL; readonly options: WorkerOptions } {
  /* v8 ignore next -- built-artifact runs own the bundled path. */
  if (!import.meta.url.endsWith('.ts')) return { entry: new URL('./worker.cjs', import.meta.url), options: { execArgv: [] } }
  const bootstrap = [
    `import { register as registerEsm } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))}`,
    `import { register as registerCjs } from ${JSON.stringify(import.meta.resolve('tsx/cjs/api'))}`,
    'registerCjs()',
    'registerEsm()',
    `await import(${JSON.stringify(new URL('./worker.ts', import.meta.url).href)})`,
  ].join('\n')
  return { entry: new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`), options: { execArgv: [] } }
}

/** 一个 Worker 消息是否为解析结果：一个索引对象，或一处违规的路径、原因与诊断信息。 */
function isResult(value: unknown): value is IndexParseResult {
  if (typeof value !== 'object' || value === null) return false
  const result = value as Record<string, unknown>
  return result.ok === true
    ? typeof result.index === 'object' && result.index !== null
    : result.ok === false && [result.path, result.reason, result.message].every(field => typeof field === 'string')
}

/**
 * 在全新的 Worker 线程中运行 `parseIndexBody`。响应体的 buffer 会被转移给 Worker，
 * 此后便不可再用；结果通过结构化克隆复制回来。
 * @param body - 完整的响应体；它必须拥有自己的整个 buffer。
 * @param url - 索引 URL。
 * @param signal - 终止 Worker 并以该信号的理由拒绝。
 * @returns 该 Worker 的结果。
 * @throws 中止理由，或当 Worker 失败、在未产出结果前退出、或报告了意外值时抛出的 Error。
 */
export async function parseIndexInWorker(body: Uint8Array, url: string, signal: AbortSignal): Promise<IndexParseResult> {
  signal.throwIfAborted()
  const { entry, options } = workerSpawn()
  const request: IndexParseRequest = { body, url }
  const worker = new Worker(entry, { ...options, workerData: request, transferList: [body.buffer as ArrayBuffer] })
  return await new Promise((resolve, reject) => {
    let settled = false
    const settle = (finish: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      // 无论终止是否成功，结果都已确定。
      void worker.terminate().then(finish, finish)
    }
    const abort = (): void => { settle(() => { reject(signal.reason as Error) }) }
    signal.addEventListener('abort', abort, { once: true })
    worker.once('message', (value: unknown) => {
      settle(() => { if (isResult(value)) resolve(value); else reject(new Error('index parser reported an unexpected value')) })
    })
    worker.once('error', (error) => { settle(() => { reject(error) }) })
    worker.once('exit', (code) => { settle(() => { reject(new Error(`index parser exited before reporting a result (code ${String(code)})`)) }) })
  })
}
