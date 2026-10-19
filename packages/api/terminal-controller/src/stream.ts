/** 一条 Remote 流世代的有界输出队列。 */
import { Deque } from '@deepseek-ai/dsh-deque'
import type { TerminalFrame } from './types.ts'

/** 缓慢的跟随端会显式失败；稍后的连接可从屏幕恢复。 */
export class TerminalFollower {
  private readonly queue = new Deque<{ frame: TerminalFrame; bytes: number }>()
  private bytes = 0
  private wake: (() => void) | undefined
  private closed = false
  private finished = false
  private failure: Error | undefined

  /** 此连接是否仍接受输入与输出。 */
  get active(): boolean { return !this.closed && !this.finished }

  /** @param maxBytes - 此跟随端可入队的 UTF-8 字节数上限。 */
  constructor(private readonly maxBytes: number) {}

  /**
   * 将一帧入队；超出字节上限时使此跟随端失败。
   * @param frame - 下一个有序帧。
   */
  push(frame: TerminalFrame): void {
    if (this.closed || this.finished) return
    const bytes = Buffer.byteLength(JSON.stringify(frame), 'utf8')
    if (this.bytes + bytes > this.maxBytes) {
      this.fail(new Error('Terminal output consumer exceeded its buffer; reconnect to recover the current screen'))
      return
    }
    this.queue.pushBack({ frame, bytes })
    this.bytes += bytes
    this.wake?.()
  }

  /**
   * 使此连接失败而不停止其终端；finish 或 close 之后的失败被忽略。
   * @param error - 报告给所连接消费方的输入或输出失败。
   */
  fail(error: Error): void {
    if (!this.active) return
    this.failure = error
    this.close()
  }

  /** 在交付完每个已入队帧（包括最终退出状态）之后结束。 */
  finish(): void {
    this.finished = true
    this.wake?.()
  }

  /** 停止此跟随端而不停止其终端。 */
  close(): void {
    this.closed = true
    this.queue.clear()
    this.bytes = 0
    this.wake?.()
  }

  /**
   * 持续排空，直到分离或失败。
   * @param signal - Remote 世代取消。
   * @returns 有序的终端帧。
   */
  async *read(signal: AbortSignal): AsyncIterable<TerminalFrame> {
    const abort = (): void => { this.close() }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    try {
      while (!this.closed) {
        const next = this.queue.popFront()
        if (next !== undefined) {
          this.bytes -= next.bytes
          yield next.frame
        } else {
          if (this.finished) break
          await new Promise<void>((resolve) => { this.wake = resolve })
          this.wake = undefined
        }
      }
      if (this.failure !== undefined) throw this.failure
    } finally {
      signal.removeEventListener('abort', abort)
      this.close()
    }
  }
}
