/**
 * 生成的 `job` Remote 命名空间的 wire 类型：每 session 的 roster 流、每 job
 * 的观察流，以及人工 kill。对 client 安全：无 Host 导入。
 * @module @deepseek-ai/dsh-api-job-controller/types
 */

import type { JobId } from '@deepseek-ai/dsh-jobs/brand'
import type { JobChunk, JobView } from '@deepseek-ai/dsh-jobs/view'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

export type { JobChunk, JobView } from '@deepseek-ai/dsh-jobs/view'

/** 一条 `job.list` 流的目标：该流镜像其可见 job 的 session。 */
export interface JobListRequest {
  readonly sessionId: SessionId
}

/**
 * 一个 `job.list` 帧：一次生命周期变更后该 session 能看到的完整集合——其
 * 自身的 job 加上所有无主 job。整集替换，因此重连后的第一帧即是事实。
 */
export interface JobListFrame {
  readonly type: 'rows'
  readonly jobs: readonly JobView[]
}

/** 由人类发起、对一个 session 可见的后台 job 的取消。 */
export interface JobKillRequest {
  /** 其 job 列表携带该 job 的 session；围栏查找以该 session 身份执行。 */
  readonly sessionId: SessionId
  readonly jobId: JobId
}

/** registry 受理人工 kill 请求后的回执。 */
export interface JobKillValue {
  readonly outcome: 'requested' | 'already-finished'
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** 该 session 的 job 列表在该 id 下已没有可 kill 的行。 */
    'job/not-found': { readonly sessionId: SessionId; readonly jobId: JobId }
  }
}

/** 一条 `job.follow` 流的目标：job、其拥有 session，以及可选的恢复偏移量。 */
export interface JobFollowRequest {
  /**
   * 围栏读取所用的拥有 session。无主 job 可省略，任何调用方都可观察它。
   */
  readonly sessionId?: SessionId
  readonly jobId: JobId
  /**
   * 恢复读取的绝对字节偏移量（先前某一帧的 `next`）。省略时，流从最早保留
   * 的字节开始。
   */
  readonly from?: number
}

/**
 * job 观察流的帧：一个 `opened` 锚点，承载该 job 的投影（打开时刻的
 * `output.earliest` 与 `output.total`）以及第一个 `output` 帧接续的偏移量，
 * 然后是合并后的 `output` 批次，最后——在该 job 落定且其环形缓冲排空后
 * ——一个承载落定投影的终结 `status`，此后流正常关闭。status 与 output
 * 共用同一条流，因此落定绝不会与仍打开的 output 通道发生竞争。
 */
export type JobFollowFrame =
  | {
    readonly type: 'opened'
    readonly job: JobView
    /** 第一个 `output` 帧接续的偏移量。 */
    readonly from: number
  }
  | {
    readonly type: 'output'
    readonly chunks: readonly JobChunk[]
    /** 此帧之后恢复读取的偏移量。 */
    readonly next: number
    /** 请求偏移量与 `chunks` 之间的字节已被驱逐。 */
    readonly lossy?: true
  }
  | {
    readonly type: 'status'
    readonly job: JobView
  }
