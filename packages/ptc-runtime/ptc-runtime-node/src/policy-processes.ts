/** 在已提交的 Session 文件策略变更之后，作废 Node PTC 进程。 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'

interface Process {
  sessionId: SessionId
  mode: SandboxMode
  release: () => Promise<void>
  invalidated: boolean
  cleanup?: Promise<void>
}

/** 负责异步进程清理，同时不拖慢权限设置方。 */
export class PolicyProcesses {
  private readonly processes = new Set<Process>()

  /**
   * 在策略变更时启动清理，即使之后不再有程序运行。
   * @param ctx - Node provider 生命周期与 Session 服务。
   */
  constructor(private readonly ctx: Context) {
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'sandbox/mode') return
      for (const process of this.processes) {
        if (process.sessionId !== session.id || process.mode === event.data.mode) continue
        process.invalidated = true
        void this.release(process).catch((error: unknown) => { ctx.logger.warn(error) })
      }
    }, { global: true })
    ctx.effect(() => async () => {
      await this.settle([...this.processes])
    }, 'Node PTC policy cleanup')
  }

  /**
   * 跟踪一次已受理的调用或一个保留进程，直到其所有者确认清理完成。
   * @param policy - 已解析的进程策略，含可选的 Session 身份。
   * @param release - 幂等的取消与可被 await 的清理。
   * @returns 进程清理成功之后的移除函数。
   */
  register(policy: SandboxExecutionPolicy, release: () => Promise<void>): () => void {
    if (policy.sessionId === undefined) return () => {}
    const session = this.ctx.get('sessions')?.get(policy.sessionId)
    const process: Process = {
      sessionId: policy.sessionId,
      mode: session === undefined ? policy.mode : this.ctx.sandboxPolicy.resolve({ session }).mode,
      release,
      invalidated: false,
    }
    this.processes.add(process)
    return () => { this.processes.delete(process) }
  }

  /**
   * 在受理另一个程序之前，等待已作废的进程清理完成。
   * @param sessionId - 已解析策略所携带的 Session。
   * @returns 此前清理完成后的决议；失败会拒绝且仍可重试。
   */
  async wait(sessionId: SessionId | undefined): Promise<void> {
    await this.settle([...this.processes].filter(process => process.sessionId === sessionId && process.invalidated))
  }

  private release(process: Process): Promise<void> {
    if (process.cleanup !== undefined) return process.cleanup
    process.cleanup = process.release().then(() => { this.processes.delete(process) }, (error: unknown) => {
      delete process.cleanup
      throw error
    })
    return process.cleanup
  }

  private async settle(processes: Process[]): Promise<void> {
    const results = await Promise.allSettled(processes.map(process => this.release(process)))
    const failed = results.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }
}
