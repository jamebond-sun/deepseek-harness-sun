/**
 * Host job Remote 持有者：通过生成的 `job` 命名空间向浏览器流式输出一个
 * session 能看到的后台 job roster 与一个 job 的保留输出，并代表人类停止
 * 一个 job。这些流是 `ctx.jobs` 的投影；模型的消费游标与通知状态从不观察
 * 它们，而且人工 kill 不是模型自己发起的，因此完成通知仍会到达拥有它的
 * agent。
 * @module @deepseek-ai/dsh-api-job-controller
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-jobs'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { observeJobOutput } from './observe.ts'
import { streamJobRows } from './rows.ts'
import type { JobKillRequest, JobKillValue, JobFollowFrame, JobFollowRequest, JobListFrame, JobListRequest } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host job Remote 命名空间持有者。 */
    jobController: JobController
  }
}

/** 读取之间默认的合并窗口，单位毫秒。 */
const DEFAULT_OBSERVE_FLUSH_MS = 100

/** 每个输出帧默认的软字节预算。 */
const DEFAULT_OBSERVE_MAX_FRAME_BYTES = 64 * 1024

/** Job Controller 部署策略。 */
export interface Config {
  /** registry 提交后到下一次 rows 或输出读取之间的合并窗口，单位毫秒（默认 100）。 */
  readonly observeFlushMs?: number
  /** 每个观察输出帧的软字节预算（默认 65536）；超出的单个 chunk 整块发送。 */
  readonly observeMaxFrameBytes?: number
}

/** 支撑生成的 `ctx.remote.job` 命名空间的 Host 服务。 */
export class JobController extends TypertRemoteService {
  static inject = ['jobs', 'typert']

  static Config: z<Config> = z.object({
    observeFlushMs: z.natural().min(1).default(DEFAULT_OBSERVE_FLUSH_MS),
    observeMaxFrameBytes: z.natural().min(1).default(DEFAULT_OBSERVE_MAX_FRAME_BYTES),
  })

  private readonly observeFlushMs: number
  private readonly observeMaxFrameBytes: number

  /**
   * @param ctx - 携带活动中的 Agent registry 与 job registry 的 Host 上下文。
   * @param config - 观察节奏与组帧策略。
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'jobController', { namespace: 'job' })
    // schemastery（导出的 Config schema）已填好带默认值的字段；该断言记录
    // 的是这一解析结果，而不是隐藏的回退值。
    const resolved = config as Required<Config>
    this.observeFlushMs = resolved.observeFlushMs
    this.observeMaxFrameBytes = resolved.observeMaxFrameBytes
  }

  /**
   * 流式输出一个 session 能看到的 job——其自身加上所有无主 job——以整集
   * 帧的形式：打开时一帧，之后每波合并的生命周期提交后一帧。该流没有自然
   * 终点；由载体关闭它。
   * @param request - 要镜像其可见集合的 session。
   * @param signal - 由 Remote 流载体持有的取消信号。
   * @returns roster 帧。
   */
  @Remote({ mode: 'stream' })
  list(request: JobListRequest, signal: AbortSignal): AsyncIterable<JobListFrame> {
    return streamJobRows(this.ctx.jobs, request, { flushMs: this.observeFlushMs }, signal)
  }

  /**
   * 从绝对字节偏移量开始流式输出一个 job 的保留输出，待其落定并排空后再
   * 输出其终结投影。非消费性：面向模型的游标与通知状态从不观察这些读取。
   * 请求中的 session 是围栏读取的调用方；registry 会拒绝该 session 看不到
   * 的 job 与未知的 job。
   * @param request - 目标 job、拥有 session 与可选的恢复偏移量。
   * @param signal - 由 Remote 流载体持有的取消信号。
   * @returns 锚点、合并后的输出帧与终结 status。
   */
  @Remote({ mode: 'stream' })
  follow(request: JobFollowRequest, signal: AbortSignal): AsyncIterable<JobFollowFrame> {
    return observeJobOutput(this.ctx.jobs, request, {
      flushMs: this.observeFlushMs,
      maxFrameBytes: this.observeMaxFrameBytes,
    }, signal)
  }

  /**
   * 代表人类 kill 一个后台 job。请求中的 session 是围栏读取的调用方，因此
   * 该 job 必须是该 session 能看到的：registry 的 owner 围栏是唯一的访问
   * 规则，子 session 自己的 job 与其他 job 一样可从其列表中 kill。kill 记录
   * `cancelled by the user` 作为原因；它不是模型请求的，因此拥有它的 agent
   * 仍会收到完成通知，等待该 job 的 shell 工具也会在自己的结果中读到该
   * 原因。
   * @param request - 其 job 列表携带该 job 的 session，以及 job id。
   * @returns registry 对 kill 请求的受理结果。
   */
  @Remote('kill')
  kill(request: JobKillRequest): JobKillValue {
    const jobs = this.ctx.jobs
    try {
      jobs.get(request.jobId, request.sessionId)
    } catch (error) {
      // `unknown job` 与 `belongs to another session` 都表示该 session 的
      // 列表已没有可 kill 的行；client 对两者呈现同一个说法。
      throw new RemoteError('job/not-found', String(error), {
        sessionId: request.sessionId,
        jobId: request.jobId,
      })
    }
    // 与查找处于同一个同步跨度，因此其间不可能有东西移除该 job——而且
    // 生产者取消的抛出会按 registry 契约传播（job 状态不变），而不是伪装
    // 成 job-not-found。
    const outcome = jobs.kill(request.jobId, request.sessionId, 'cancelled by the user')
    return { outcome }
  }
}

export default JobController
