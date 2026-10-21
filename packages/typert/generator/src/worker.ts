/**
 * workspace 模式 Typert 生成的 Worker 线程入口。它生成所请求 workspace 的每一个
 * 显式贡献者，恰好发出一条 {@link WorkspaceWorkerResponse}，然后退出。
 * @module @deepseek-ai/dsh-typert-generator/worker
 */

import { parentPort, workerData } from 'node:worker_threads'
import { WorkspaceTypertGenerator } from './workspace.ts'
import type { WorkspaceEmitResult, WorkspaceTypertGeneratorOptions } from './workspace.ts'
import type { TypertFace } from './model.ts'

/** 作为 `workerData` 传入的生成输入。 */
export interface WorkspaceWorkerRequest {
  /** 包含端聚合 tsconfig 的 workspace 根。 */
  readonly root: string
  /** 要生成的端；缺省时为每个端。 */
  readonly faces?: readonly TypertFace[]
  /** 应用于本次通过的生成器开关。 */
  readonly options: WorkspaceTypertGeneratorOptions
}

/** worker 发出的唯一消息：每个生成的产物，或中止生成的失败。 */
export type WorkspaceWorkerResponse =
  | { readonly kind: 'artifacts'; readonly artifacts: readonly WorkspaceEmitResult[] }
  | { readonly kind: 'failure'; readonly name: string; readonly message: string; readonly stack?: string }

function parseRequest(value: unknown): WorkspaceWorkerRequest {
  const request = typeof value === 'object' && value !== null
    ? value as Partial<Record<keyof WorkspaceWorkerRequest, unknown>>
    : {}
  const { root, faces, options } = request
  const checkDiagnostics = typeof options === 'object' && options !== null
    ? (options as Partial<Record<keyof WorkspaceTypertGeneratorOptions, unknown>>).checkDiagnostics
    : null
  if (typeof root !== 'string'
    || (faces !== undefined
      && (!Array.isArray(faces) || !faces.every((face): face is TypertFace => face === 'host' || face === 'client')))
    || (checkDiagnostics !== undefined && typeof checkDiagnostics !== 'boolean')) {
    throw new TypeError('typert-generator: malformed workspace worker request')
  }
  return {
    root,
    ...(faces === undefined ? {} : { faces }),
    options: checkDiagnostics === undefined ? {} : { checkDiagnostics },
  }
}

function respond(): WorkspaceWorkerResponse {
  try {
    const request = parseRequest(workerData)
    const generator = new WorkspaceTypertGenerator(request.root, request.options)
    return { kind: 'artifacts', artifacts: generator.generateContributors(request.faces) }
  } catch (error) {
    if (!(error instanceof Error)) return { kind: 'failure', name: 'Error', message: String(error) }
    return {
      kind: 'failure',
      name: error.name,
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
    }
  }
}

if (parentPort === null) throw new Error('typert-generator: the workspace worker entry must run in a Worker Thread')
parentPort.postMessage(respond())
