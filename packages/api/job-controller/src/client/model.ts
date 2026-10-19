/**
 * 不依赖 React 的 client job 状态：每个被监视 session 能看到的 roster，由
 * `job.list` 帧供给；以及每个 job 的累计输出视图，由 `job.follow` 帧供给。
 * 纯数据加订阅——传输接线留在 client 服务中，UI 留在 slot 组件中。
 * @module @deepseek-ai/dsh-api-job-controller/client/model
 */

import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
import type { JobId } from '@deepseek-ai/dsh-jobs/brand'
import type { JobView } from '@deepseek-ai/dsh-jobs/view'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { JobFollowFrame } from '../types.ts'

/** 每 job 有界的渲染尾部，单位为 UTF-16 码元。 */
const RENDER_TAIL_LIMIT = 128 * 1024

/** 一个被观察 job 的实时视图状态。 */
export interface ObservedJob {
  readonly jobId: JobId
  /** 累计的输出尾部，限制在渲染上限内。 */
  readonly text: string
  /** 当 {@link text} 之前的字节被丢弃时为 true（驱逐、恢复缺口或渲染上限）。 */
  readonly gapBefore: boolean
  /** 观察流仍打开且 job 尚未落定时为 true。 */
  readonly streaming: boolean
  /** 观察的终结性失败，即流异常结束时。 */
  readonly error?: string
}

/** 不可变的 client job 状态。 */
export interface JobsSnapshot {
  /**
   * 每个被监视 session 能看到的 job，以 session id 为键。无人监视的
   * session，或看不到任何 job 的 session，不会有键，因此消费方读到的是
   * 缺席而不是哨兵值。
   */
  readonly rows: Readonly<Record<string, readonly JobView[]>>
  /** 以 job id 为键的实时观察状态。 */
  readonly observed: Readonly<Record<string, ObservedJob>>
}

/** client job 快照的裸可观察源。 */
export interface JobsSource {
  /** 读取标识稳定的当前快照。 */
  getSnapshot(): JobsSnapshot
  /**
   * 订阅快照变更。
   * @param listener - 失效回调。
   * @returns 取消订阅函数。
   */
  subscribe(listener: () => void): () => void
}

/** 一个 {@link ObservedJob} 视图背后的可变观察记账。 */
interface ObservedState {
  view: ObservedJob
  /** 下一次生成 `from` 所用的恢复偏移量。 */
  cursor: number | undefined
}

/** 持有每 session 的 roster 与每 job 的观察状态。 */
export class ClientJobsModel implements JobsSource {
  private readonly rowsBySession = new Map<string, readonly JobView[]>()
  private readonly observedStates = new Map<string, ObservedState>()
  private readonly listeners = new Set<() => void>()
  private snapshotCache: JobsSnapshot = { rows: {}, observed: {} }
  private snapshotDirty = false

  getSnapshot(): JobsSnapshot {
    if (this.snapshotDirty) {
      const rows: Record<string, readonly JobView[]> = {}
      for (const [id, jobs] of this.rowsBySession) rows[id] = jobs
      const observed: Record<string, ObservedJob> = {}
      for (const [id, state] of this.observedStates) observed[id] = state.view
      this.snapshotCache = { rows, observed }
      this.snapshotDirty = false
    }
    return this.snapshotCache
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * 用 `rows` 帧的整集替换一个 session 的 roster。空集存储为键缺席。
   * @param sessionId - 被监视的 session。
   * @param jobs - 完整的可见集合。
   */
  rowsReplaced(sessionId: SessionId, jobs: readonly JobView[]): void {
    const key = String(sessionId)
    if (jobs.length === 0) {
      if (!this.rowsBySession.delete(key)) return
    } else {
      this.rowsBySession.set(key, jobs)
    }
    this.changed()
  }

  /**
   * 在最后一个监视者停止或其流失败后丢弃一个 session 的 roster。
   * @param sessionId - 不再被监视的 session。
   */
  rowsDropped(sessionId: SessionId): void {
    if (!this.rowsBySession.delete(String(sessionId))) return
    this.changed()
  }

  /**
   * 一个 job 下一次观察生成的恢复偏移量。
   * @param id - 被观察的 job。
   * @returns 最后接受的 `next`，全新观察则为 undefined。
   */
  cursorOf(id: JobId): number | undefined {
    return this.observedStates.get(String(id))?.cursor
  }

  /**
   * 当一个生成的锚点到达时安装或重置观察状态。
   * @param id - 被观察的 job。
   * @param frame - 该生成的 `opened` 锚点。
   */
  observeOpened(id: JobId, frame: Extract<JobFollowFrame, { type: 'opened' }>): void {
    const existing = this.observedStates.get(String(id))
    // 锚定在偏移零之后的全新视图，起始处位于被驱逐的头部之后（全新观察
    // 锚定在 registry 最早保留的字节处），因此它欠下一个与实时观察者从有损
    // 读取中挣得的相同的缺口标记。已累计文本的恢复会保留其记录的缺口状态。
    const freshPastHead = (existing === undefined || existing.view.text === '') && frame.from > 0
    const view: ObservedJob = {
      jobId: id,
      text: existing?.view.text ?? '',
      gapBefore: (existing?.view.gapBefore ?? false) || frame.from < frame.job.output.earliest || freshPastHead,
      streaming: true,
    }
    this.observedStates.set(String(id), { view, cursor: frame.from })
    this.changed()
  }

  /**
   * 把一个输出帧的 chunk 追加到有界的渲染尾部。
   * @param id - 被观察的 job。
   * @param frame - 一个合并后的 `output` 帧。
   */
  observeOutput(id: JobId, frame: Extract<JobFollowFrame, { type: 'output' }>): void {
    const state = this.observedStates.get(String(id))
    /* v8 ignore next -- frames arrive only between opened and stop for a tracked id. */
    if (state === undefined) return
    let text = state.view.text + frame.chunks.map(chunk => chunk.text).join('')
    let gapBefore = state.view.gapBefore || frame.lossy === true
      || frame.chunks.some(chunk => chunk.gapBefore === true)
    if (text.length > RENDER_TAIL_LIMIT) {
      let cut = text.length - RENDER_TAIL_LIMIT
      // 不要在渲染上限处拆开代理对。
      const unit = text.charCodeAt(cut)
      if (unit >= 0xDC00 && unit <= 0xDFFF) cut += 1
      text = text.slice(cut)
      gapBefore = true
    }
    state.view = { ...state.view, text, gapBefore }
    state.cursor = frame.next
    this.changed()
  }

  /**
   * 终结 `status` 帧到达后关闭实时视图：环形缓冲已排空，roster 行携带落定
   * 的投影。
   * @param id - 被观察的 job。
   */
  observeSettled(id: JobId): void {
    const state = this.observedStates.get(String(id))
    /* v8 ignore next -- frames arrive only between opened and stop for a tracked id. */
    if (state === undefined) return
    state.view = { ...state.view, streaming: false }
    this.changed()
  }

  /**
   * 记录一次观察的终结性失败。
   * @param id - 被观察的 job。
   * @param error - 该流的终结性失败。
   */
  observeFailed(id: JobId, error: unknown): void {
    const state = this.observedStates.get(String(id))
    if (state === undefined) {
      // 锚点之前的失败——被拒绝的请求、job 在点击与打开之间消失——仍然
      // 欠面板一个通知；稍后成功的锚点会替换此视图并从无游标处恢复。
      this.observedStates.set(String(id), {
        view: { jobId: id, text: '', gapBefore: false, streaming: false, error: String(error) },
        cursor: undefined,
      })
      this.changed()
      return
    }
    state.view = { ...state.view, streaming: false, error: String(error) }
    this.changed()
  }

  /**
   * 在最后一个观察者停止后丢弃观察状态。
   * @param id - 不再被观察的 job。
   */
  observeStopped(id: JobId): void {
    if (!this.observedStates.delete(String(id))) return
    this.changed()
  }

  private changed(): void {
    this.snapshotDirty = true
    notifySubscribers(this.listeners, 'jobs')
  }
}
