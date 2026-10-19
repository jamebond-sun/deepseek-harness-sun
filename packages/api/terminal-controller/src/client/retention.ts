/** 一个可重连的窗口持有，由终端的所有出现项共享。 */
import type { ClientRemote, RemoteStream } from '@deepseek-ai/dsh-api-gateway/client'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TerminalRetentionFrame, WebTerminalId } from '../types.ts'
import type { TerminalRemote } from './model.ts'

/** 流确认对每次物理连接的输出连接进行门控。 */
export class TerminalWindowHold {
  private readonly stream: RemoteStream<TerminalRetentionFrame>
  private readonly waiters = new Set<{ resolve: () => void; reject: (error: unknown) => void }>()
  private generation: AbortSignal | undefined
  private failure: Error | undefined

  /**
   * @param gateway - 可重连流的拥有者。
   * @param remote - 类型化的终端命名空间。
   * @param sessionId - 已保存布局的 Session，不激活 Agent。
   * @param id - 现有的 Host 终端。
   */
  constructor(gateway: Pick<ClientRemote, '$stream'>, remote: TerminalRemote, sessionId: SessionId, id: WebTerminalId) {
    this.stream = gateway.$stream<TerminalRetentionFrame>({
      name: 'Browser terminal window hold',
      open: signal => remote.retain(sessionId, id, signal),
      ended: () => new RemoteError('terminal/unavailable', 'Terminal hold ended', {}),
    })
    void this.consume()
  }

  /** 终端域的失败是否已终结此持有，从而允许显式重试。 */
  get failed(): boolean { return this.failure !== undefined }

  /**
   * 在跟随其屏幕之前，等待已确认的当前物理持有。
   * @param signal - 输出请求或视图的生命周期。
   * @returns 确认之后返回；取消或不可用时拒绝。
   */
  async ready(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (this.failure !== undefined) throw this.failure
    if (this.generation !== undefined && !this.generation.aborted) return
    const waiting = Promise.withResolvers<void>()
    const abort = (): void => { waiting.reject(signal.reason) }
    this.waiters.add(waiting)
    signal.addEventListener('abort', abort, { once: true })
    try { await waiting.promise }
    finally { this.waiters.delete(waiting); signal.removeEventListener('abort', abort) }
  }

  /**
   * 释放此窗口的流与所有确认等待者。
   * @returns 流消费方关闭之后。
   */
  dispose(): Promise<void> {
    this.reject(new Error('Terminal window hold released'))
    return this.stream.dispose()
  }

  private async consume(): Promise<void> {
    try {
      for await (const item of this.stream) {
        item.accept()
        this.generation = item.signal
        for (const waiter of this.waiters) waiter.resolve()
        this.waiters.clear()
      }
    } catch (error) { this.reject(error) }
  }

  private reject(error: unknown): void {
    this.failure = error instanceof Error ? error : new Error('Terminal window hold failed', { cause: error })
    this.generation = undefined
    for (const waiter of this.waiters) waiter.reject(error)
    this.waiters.clear()
  }
}
