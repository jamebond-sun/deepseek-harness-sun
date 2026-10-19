/** 一个终端拥有者的窗口持有与保守的空闲回收。 */
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { SubprocessTerminalActivity } from '@deepseek-ai/dsh-subprocess'
import type { TerminalRetentionFrame } from './types.ts'

/** 用于无人值守终端清理的已验证 Host 时序策略。 */
export interface TerminalRetentionPolicy {
  readonly unattendedTimeoutMs: number
  readonly activityPollIntervalMs: number
  readonly cleanupRetryMs: number
}

/** 恰好一个拥有者统一安排持有、观察与可重试的进程清理。 */
export class TerminalRetention {
  private readonly lifetime = new AbortController()
  private readonly holders = new Set<object>()
  private epoch = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private observation: Promise<void> | undefined
  private idle: { since: number; revision: number; observedAt: number } | undefined
  private closing = false
  private disposed = false
  private cleanup: Promise<void> | undefined

  /**
   * @param policy - 部署时序选择。
   * @param inspect - 对 shell 与其所属作业的最新观察。
   * @param terminate - 将标识标记为已关闭，等待进程静止，并移除其拥有者记录。
   * @param failed - 自动清理失败时的诊断接收器。
   */
  constructor(
    private readonly policy: TerminalRetentionPolicy,
    private readonly inspect: () => Promise<SubprocessTerminalActivity>,
    private readonly terminate: () => Promise<void>,
    private readonly failed: (error: unknown) => void,
  ) { this.schedule(0) }

  /**
   * 为一条物理 Remote 流持有一个终端，独立于屏幕订阅。
   * @param signal - 传输世代的生命周期。
   * @returns 先返回确认，随后是保持打开的流，直到取消或终端关闭。
   */
  async *retain(signal: AbortSignal): AsyncIterable<TerminalRetentionFrame> {
    signal.throwIfAborted()
    if (this.closing || this.disposed) throw new RemoteError('terminal/unavailable', 'Terminal is closing or unavailable', {})
    const holder = {}
    const ended = Promise.withResolvers<void>()
    const combined = AbortSignal.any([signal, this.lifetime.signal])
    const release = (): void => {
      if (!this.holders.delete(holder)) return
      combined.removeEventListener('abort', release)
      this.invalidate()
      ended.resolve()
      this.schedule(0)
    }
    this.holders.add(holder)
    this.invalidate()
    this.cancelTimer()
    combined.addEventListener('abort', release, { once: true })
    try { yield { type: 'retained' }; await ended.promise }
    finally { release() }
  }

  /** 在接受输入之前使尚未完成的空闲观察失效。 */
  invalidate(): void { this.epoch++; this.idle = undefined }

  /**
   * 启动或加入清理；失败时标识保持关闭状态，并安排一次重试。
   * @returns 所辖进程清理成功后返回，或以其失败拒绝。
   */
  close(): Promise<void> {
    if (this.cleanup !== undefined) return this.cleanup
    this.closing = true
    this.invalidate()
    this.lifetime.abort(new Error('Terminal closed'))
    this.cancelTimer()
    this.cleanup = this.terminate().catch((error: unknown) => {
      this.cleanup = undefined
      this.schedule(this.policy.cleanupRetryMs)
      throw error
    })
    return this.cleanup
  }

  /**
   * 停止计时器与流，并等待观察与最终清理都完成。
   * @returns 进程静止后返回；清理失败会报告给正在释放的拥有者。
   */
  async dispose(): Promise<void> {
    this.disposed = true
    this.cancelTimer()
    const observation = this.observation
    try { await this.close() }
    finally { await observation }
  }

  private cancelTimer(): void { clearTimeout(this.timer); this.timer = undefined }

  private schedule(delay: number): void {
    if (this.disposed || this.timer !== undefined) return
    if (!this.closing && (this.holders.size > 0 || this.policy.unattendedTimeoutMs === 0)) return
    const due = performance.now() + delay
    this.timer = setTimeout(() => {
      this.timer = undefined
      const remaining = due - performance.now()
      if (remaining > 0) { this.schedule(remaining); return }
      if (this.closing) { void this.close().catch(this.failed); return }
      this.observe()
    }, Math.min(delay, 2_147_483_647))
    this.timer.unref()
  }

  private observe(): void {
    if (this.observation !== undefined) return
    const epoch = this.epoch
    this.observation = (async () => {
      let activity: SubprocessTerminalActivity
      try { activity = await this.inspect() }
      catch (_activityUnavailable) { activity = { state: 'unknown', revision: 0 } }
      if (this.disposed || this.closing || this.holders.size > 0 || epoch !== this.epoch) return
      const now = performance.now()
      if (activity.state !== 'idle') { this.idle = undefined; return }
      if (this.idle?.revision !== activity.revision || now - this.idle.observedAt > this.policy.activityPollIntervalMs * 2) {
        this.idle = { since: now, observedAt: now, revision: activity.revision }
      } else this.idle.observedAt = now
      if (now - this.idle.since >= this.policy.unattendedTimeoutMs) await this.close()
    })().catch(this.failed).finally(() => {
      this.observation = undefined
      if (!this.closing) this.schedule(this.policy.activityPollIntervalMs)
    })
  }
}
