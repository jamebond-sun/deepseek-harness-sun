/**
 * 注册表读取的面向模型的渲染：像 shell 工具一贯呈现的那样呈现消费型增量（stdout，
 * 然后一个带标记的 stderr 段）、`[status: …]` 行，以及工具 schema 所暴露的公开任务投影。
 * @module @deepseek-ai/dsh-tool-jobs/render
 */

import type { JobChunk, JobView } from '@deepseek-ai/dsh-jobs/view'

/** 对模型编写的程序安全的任务状态；所有权与偏移被省略。 */
export interface PublicJobSnapshot {
  id: string
  kind: string
  label: string
  status: JobView['status']
  /** 运行中的实时进度行，结算后的终态原因。 */
  detail?: string
  startedAt: number
  finishedAt?: number
}

/**
 * 模型在状态旁边读到的那一行限定词：任务运行时的实时进度，结算之后的终态原因。
 * @param job - 任务投影。
 * @returns 该限定词；任务两者都没有时为 undefined。
 */
export function jobDetail(job: Pick<JobView, 'progress' | 'detail'>): string | undefined {
  return job.progress ?? job.detail
}

/**
 * 从注册表投影中移除所有权、偏移与上限。
 * @param job - 注册表投影。
 * @returns 对模型安全的投影。
 */
export function publicJob(job: JobView): PublicJobSnapshot {
  const detail = jobDetail(job)
  return {
    id: job.id,
    kind: job.kind,
    label: job.label,
    status: job.status,
    ...detail !== undefined ? { detail } : {},
    startedAt: job.startedAt,
    ...job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {},
  }
}

/**
 * 渲染带可选 detail 的通用状态。
 * @param snapshot - 要渲染的任务状态。
 * @returns 一个方括号包裹的状态行。
 */
export function statusLine(snapshot: Pick<PublicJobSnapshot, 'status' | 'detail'>): string {
  return snapshot.detail !== undefined
    ? `[status: ${snapshot.status}, ${snapshot.detail}]`
    : `[status: ${snapshot.status}]`
}

/**
 * 为模型渲染一次消费型读取：按序给出 stdout 与无标签的块，然后在一个 `[stderr]` 段里给出
 * 全部 stderr 块，与 shell 工具渲染前台结果的方式完全一致。`log` 块是给观察者看的生产者
 * 叙述，从不到达模型。丢失的字节——游标落后于环形缓冲区的保留区，或某个模型可见的块带有
 * 生产者侧的断点——会以 shell 工具的丢弃输出通知结束这次读取，并点名该任务各源保存的
 * 溢出文件。
 * @param chunks - 自模型游标以来的块，按偏移顺序。
 * @param lossy - `chunks` 之前的字节是否已被淘汰而未读。
 * @param spillPaths - 任务当前通告的完整流文件（`JobView.output.spillPaths`）。
 * @returns 增量文本，可能为空。
 */
export function renderModelDelta(chunks: readonly JobChunk[], lossy: boolean, spillPaths: readonly string[]): string {
  const visible = chunks.filter(chunk => chunk.channel !== 'log')
  const out = visible.filter(chunk => chunk.channel !== 'stderr').map(chunk => chunk.text).join('')
  const err = visible.filter(chunk => chunk.channel === 'stderr').map(chunk => chunk.text).join('')
  const separator = out.length > 0 && !out.endsWith('\n') ? '\n' : ''
  const body = out + (err.length > 0 ? `${separator}[stderr]\n${err}` : '')
  if (!lossy && !visible.some(chunk => chunk.gapBefore === true)) return body
  const notice = `[some output was dropped from memory; full output: ${spillPaths.length > 0 ? spillPaths.join(', ') : '(unavailable)'}]`
  return `${body}${body.length > 0 && !body.endsWith('\n') ? '\n' : ''}${notice}`
}
