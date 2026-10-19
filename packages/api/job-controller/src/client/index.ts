/**
 * Job Controller 的 client 半部：在生成的 `job` Remote 命名空间之上安装
 * `ctx.jobs`（roster、观察与人工 kill）。插件在自己的上下文仍然有效时解析
 * 它驱动的两个 Remote 面，因为流的（重）打开运行在调用方栈上——一次 React
 * 事件、一次载体重试——其动态上下文尚未声明 `remote.job`。
 * @module @deepseek-ai/dsh-api-job-controller/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-job-controller/remote'
import { ClientJobsModel } from './model.ts'
import { ClientJobs } from './service.ts'

export type { JobsSnapshot, ObservedJob } from './model.ts'
// `ctx.jobs` 的契约。其模块还携带声明 `ctx.jobs` 的 Context 扩充，消费方
// 只能通过这个导出拿到它：声明产物会丢弃上面的值导入。
export type { IJobs } from './service.ts'
export type {
  JobChunk, JobKillRequest, JobKillValue, JobFollowFrame, JobFollowRequest, JobListFrame, JobListRequest, JobView,
} from '../types.ts'

/** 必需的 Client Remote 服务。 */
export const inject = ['remote', 'remote.job']

/**
 * 安装 client jobs 服务。
 * @param ctx - Client 根 Context。
 */
export function apply(ctx: Context): void {
  // 现在就读取命名空间，而不是在 `open` 内部：见模块 JSDoc。
  const { remote } = ctx
  const { job } = remote
  new ClientJobs(ctx, { $stream: options => remote.$stream(options), job }, new ClientJobsModel())
}
