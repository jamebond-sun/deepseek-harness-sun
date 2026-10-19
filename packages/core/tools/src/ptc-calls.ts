/** 完整 PTC 调用（含嵌套工具）的取消与落定。 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'

interface Call {
  mode: SandboxMode
  controller: AbortController
  done: Promise<void>
}

/** 防止策略变更下的调用与其已取消的前任重叠。 */
export class PtcCalls {
  private readonly calls = new Map<SessionId, Set<Call>>()
  private disposed = false

  /**
   * 为持有的工具注册表观察策略变更。
   * @param ctx - 注册表生命周期与 Session 事件。
   */
  constructor(ctx: Context) {
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'sandbox/mode') return
      for (const call of this.calls.get(session.id) ?? []) {
        if (call.mode !== event.data.mode) call.controller.abort(new Error('sandbox mode changed'))
      }
    }, { global: true })
    ctx.effect(() => async () => {
      this.disposed = true
      const calls = [...this.calls.values()].flatMap(calls => [...calls])
      for (const call of calls) call.controller.abort(new Error('PTC tool registry disposed'))
      await Promise.all(calls.map(call => call.done))
    }, 'PTC calls')
  }

  /**
   * 在解析权限并接纳调用之前，等待已取消的前任完成。
   * @param sessionId - 调用方 Session。
   * @param signal - 调用方取消信号。
   * @param mode - 当前常设模式，在前序清理之后读取。
   * @param run - 完整调用，包括嵌套工具清理。
   * @returns 调用结果。
   */
  async run<T>(sessionId: SessionId, signal: AbortSignal, mode: () => SandboxMode, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    for (;;) {
      const pending = [...this.calls.get(sessionId) ?? []].filter(call => call.controller.signal.aborted)
      if (pending.length === 0) break
      await Promise.all(pending.map(call => call.done))
    }
    signal.throwIfAborted()
    if (this.disposed) throw new Error('PTC tool registry disposed')
    const controller = new AbortController()
    const done = Promise.withResolvers<undefined>()
    const call = { mode: mode(), controller, done: done.promise }
    let calls = this.calls.get(sessionId)
    if (calls === undefined) this.calls.set(sessionId, calls = new Set())
    calls.add(call)
    try { return await run(AbortSignal.any([signal, controller.signal])) } finally {
      calls.delete(call)
      if (calls.size === 0) this.calls.delete(sessionId)
      done.resolve(undefined)
    }
  }
}
