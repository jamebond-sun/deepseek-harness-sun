/**
 * `ctx.jobs` 的 client 服务：`job` 命名空间之上的引用计数流——每个被监视
 * session 一条 `job.list` roster 流、每个被观察 job 一条 `job.follow` 流
 * ——使重叠的观看者共享一条流，roster 在重连后整体恢复，观察从模型的游标
 * 恢复；外加经 `job.kill` 透传的人工 kill。
 * @module @deepseek-ai/dsh-api-job-controller/client/service
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { RemoteStreamCarrierError, type ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { JobId } from '@deepseek-ai/dsh-jobs/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { JobKillRequest, JobKillValue, JobFollowFrame, JobFollowRequest, JobListFrame, JobListRequest } from '../types.ts'
import type { ClientJobsModel, JobsSource } from './model.ts'

/** 流运行器驱动的生成的 `job` 命名空间面。 */
export interface JobRemote {
  /**
   * 打开一次 roster 生成。
   * @param request - 要镜像其可见集合的 session。
   * @param signal - 本次生成的取消信号。
   * @returns 一次生成的整集帧序列。
   */
  list(request: JobListRequest, signal?: AbortSignal): AsyncIterable<JobListFrame>
  /**
   * 打开一次观察生成。
   * @param request - 目标 job、拥有 session 与可选的恢复偏移量。
   * @param signal - 本次生成的取消信号。
   * @returns 一次生成的帧序列。
   */
  follow(request: JobFollowRequest, signal?: AbortSignal): AsyncIterable<JobFollowFrame>
  /**
   * 代表人类 kill 一个 job。
   * @param request - 其列表携带该 job 的 session，以及 job id。
   * @returns registry 的受理结果，或业务/传输失败。
   */
  kill(request: JobKillRequest): Promise<RemoteResult<JobKillValue>>
}

/** 运行器驱动的 Remote 面：Gateway 流工厂与 `job` 命名空间。 */
export interface JobsRemote {
  readonly $stream: ClientRemote['$stream']
  readonly job: JobRemote
}

/** client jobs 服务面。 */
export interface IJobs {
  /** roster 与每 job 的观察状态。 */
  readonly state: JobsSource
  /**
   * 使一个 session 的 roster 保持最新；引用计数，因此同一 session 的两个
   * 监视者共享一条流，行随最后一个离开。
   * @param sessionId - 要镜像其可见 job 的 session。
   * @returns 释放该监视者引用的停止函数。
   */
  watchRows(sessionId: SessionId): () => void
  /**
   * 开始观察一个 job 的实时输出；引用计数，因此同一 job 的两个观看者共享
   * 一条流。
   * @param sessionId - 围栏读取所用的拥有 session；无主 job 则为 undefined。
   * @param id - 要观察的 job。
   * @returns 释放该观察者引用的停止函数。
   */
  observe(sessionId: SessionId | undefined, id: JobId): () => void
  /**
   * 从一个 session 的 job 列表 kill 一个后台 job。纯 RPC 透传：行状态经由
   * roster 流收敛，错误呈现由调用方（job 列表控件）负责。
   * @param sessionId - 其 job 列表携带该 job 的 session。
   * @param id - 该 job 行的 registry id。
   * @returns registry 的受理结果，或业务/传输失败。
   */
  kill(sessionId: SessionId, id: JobId): Promise<RemoteResult<JobKillValue>>
}

/** 一条引用计数的流。 */
interface StreamEntry {
  refs: number
  stopped: boolean
  dispose: () => Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 不依赖 React 的 client job roster 与观察控制。 */
    jobs: IJobs
  }
}

/** 持有裸 jobs 快照以及每 session 与每 job 的流。 */
export class ClientJobs extends Service implements IJobs {
  readonly state: JobsSource
  private readonly rowsEntries = new Map<string, StreamEntry>()
  private readonly observations = new Map<string, StreamEntry>()

  /**
   * @param ctx - client 根 Context。
   * @param remote - Gateway 流工厂与生成的 `job` 命名空间，均由调用方解析。
   * @param model - 共享的 client jobs 模型。
   */
  constructor(
    ctx: Context,
    private readonly remote: JobsRemote,
    private readonly model: ClientJobsModel,
  ) {
    super(ctx, 'jobs')
    this.state = model
    ctx.effect(() => async () => {
      const open = [...this.rowsEntries.values(), ...this.observations.values()]
      this.rowsEntries.clear()
      this.observations.clear()
      for (const entry of open) entry.stopped = true
      // Cordis 会等待异步释放器，因此 fiber 保持卸载中，直到每一条载体迭代
      // 器都关闭，后继插件实例才无法与之重叠。清理失败的载体同样会被停止；
      // 其失败在这里没有消费方。
      await Promise.allSettled(open.map(entry => entry.dispose()))
    }, 'job-controller.client.streams')
  }

  kill(sessionId: SessionId, id: JobId): Promise<RemoteResult<JobKillValue>> {
    return this.remote.job.kill({ sessionId, jobId: id })
  }

  watchRows(sessionId: SessionId): () => void {
    return this.acquire(
      this.rowsEntries,
      String(sessionId),
      () => this.startRows(sessionId),
      () => { this.model.rowsDropped(sessionId) },
    )
  }

  observe(sessionId: SessionId | undefined, id: JobId): () => void {
    return this.acquire(
      this.observations,
      String(id),
      () => this.startObservation(sessionId, id),
      () => { this.model.observeStopped(id) },
    )
  }

  /** 共享 `key` 下的现存条目或启动一个，并交还其释放函数。 */
  private acquire(
    entries: Map<string, StreamEntry>,
    key: string,
    start: () => StreamEntry,
    cleared: () => void,
  ): () => void {
    const existing = entries.get(key)
    if (existing !== undefined && !existing.stopped) {
      existing.refs += 1
      return this.releaser(entries, key, existing, cleared)
    }
    const entry = start()
    entries.set(key, entry)
    return this.releaser(entries, key, entry, cleared)
  }

  /**
   * 释放闭包绑定它们铸造时的确切条目，而不是映射的当前占用者：同一 key 上
   * 稍后的获取可能已替换掉一个已停止的条目，仅凭 key 递减或释放会拆毁那条
   * 更新的流的引用。
   */
  private releaser(entries: Map<string, StreamEntry>, key: string, entry: StreamEntry, cleared: () => void): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      entry.refs -= 1
      if (entry.refs > 0) return
      if (entries.get(key) === entry) entries.delete(key)
      entry.stopped = true
      void entry.dispose().then(() => {
        // 仅在没有后继者持有该 key 时清除状态：释放往返期间的重新获取已经
        // 重新填充了模型，一次过期的清除会把它永久清空。
        if (entries.has(key)) return
        cleared()
      })
    }
  }

  private startRows(sessionId: SessionId): StreamEntry {
    const name = `job rows ${String(sessionId)}`
    const stream = this.remote.$stream<JobListFrame>({
      name,
      open: signal => this.remote.job.list({ sessionId }, signal),
      // roster 在被监视期间没有自然终点：第一帧之后的结束是载体中断（Host
      // 重载会关闭该生成），下一次生成的整集不丢失任何内容。第一帧之前的
      // 结束是终结性的。
      ended: accepted => accepted
        ? new RemoteStreamCarrierError(`${name} ended before release`)
        : new Error(`${name} ended before its first frame`),
    })
    const entry: StreamEntry = {
      refs: 1,
      stopped: false,
      dispose: () => stream.dispose(),
    }
    void (async () => {
      try {
        for await (const item of stream) {
          this.model.rowsReplaced(sessionId, item.value.jobs)
          item.accept()
        }
      } catch {
        // 流的终结性失败不留下任何可显示的当前内容；模型丢弃 roster，而不
        // 是在屏幕上保留过期集合。
        if (!entry.stopped) this.model.rowsDropped(sessionId)
      } finally {
        entry.stopped = true
        void entry.dispose()
      }
    })()
    return entry
  }

  private startObservation(sessionId: SessionId | undefined, id: JobId): StreamEntry {
    const name = `job observation ${String(id)}`
    const stream = this.remote.$stream<JobFollowFrame>({
      name,
      open: (signal) => {
        const from = this.model.cursorOf(id)
        return this.remote.job.follow(
          {
            jobId: id,
            ...sessionId !== undefined ? { sessionId } : {},
            ...from !== undefined ? { from } : {},
          },
          signal,
        )
      },
      // 锚点之后的过早结束可重试（Host 重载会关闭该生成）；从游标恢复不
      // 丢失任何内容。锚点之前的结束是终结性的。
      ended: accepted => accepted
        ? new RemoteStreamCarrierError(`${name} ended before settlement`)
        : new Error(`${name} ended before its anchor`),
    })
    const entry: StreamEntry = {
      refs: 1,
      stopped: false,
      dispose: () => stream.dispose(),
    }
    void (async () => {
      try {
        for await (const item of stream) {
          const frame = item.value
          if (frame.type === 'opened') {
            this.model.observeOpened(id, frame)
            item.accept()
            continue
          }
          if (frame.type === 'output') {
            this.model.observeOutput(id, frame)
            continue
          }
          // 终结 status：在生成结束被归类之前离开循环，然后永久关闭流。
          this.model.observeSettled(id)
          break
        }
      } catch (error) {
        if (!entry.stopped) this.model.observeFailed(id, error)
      } finally {
        entry.stopped = true
        void entry.dispose()
      }
    })()
    return entry
  }
}
