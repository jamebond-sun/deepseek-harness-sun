import { notifySubscribers } from '@deepseek-ai/dsh-client-store'

/**
 * 在微任务中批量处理结构性更新，按动画帧批量处理流更新。
 * 读取方可以在不消费待处理订阅者通知的情况下重建脏快照。
 */
export class Notifier {
  private listeners = new Set<() => void>()
  private dirty = false
  private notifyPending = false
  private scheduled: 'none' | 'microtask' | 'frame' = 'none'
  private scheduleGeneration = 0

  /** @param rebuild - 由持有者注入的快照重建函数（写入持有者的 snapshotCache）。 */
  constructor(private readonly rebuild: () => void) {}

  /**
   * uSES 订阅入口。
   * @param listener - 变更回调。
   * @returns 取消订阅函数。
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 把快照标记为脏，并在一个微任务中通知。 */
  markDirty(): void {
    this.dirty = true
    this.notifyPending = true
    if (this.scheduled === 'microtask') return
    this.schedule('microtask')
  }

  /** 把快照标记为脏，并每帧至多发布一次累积状态。 */
  markFrameDirty(): void {
    this.dirty = true
    this.notifyPending = true
    if (this.scheduled !== 'none') return
    this.schedule(typeof globalThis.requestAnimationFrame === 'function' ? 'frame' : 'microtask')
  }

  /**
   * 同步刷新：受控输入的写入必须与 onChange 在同一个 tick 内通知，
   * 否则 React 会把 DOM 回滚到旧值，光标跳到末尾。
   */
  notifyNow(): void {
    this.dirty = true
    this.notifyPending = true
    this.invalidateSchedule()
    this.flush()
  }

  /**
   * getSnapshot 前置检查：脏时同步重建（首次订阅前的读取路径
   * / 无观察者期间）。通知保持待处理。
   */
  ensureFresh(): void {
    if (!this.dirty) return
    this.dirty = false
    this.rebuild()
  }

  private schedule(kind: 'microtask' | 'frame'): void {
    const generation = ++this.scheduleGeneration
    this.scheduled = kind
    const publish = () => {
      if (generation !== this.scheduleGeneration) return
      this.scheduled = 'none'
      this.flush()
    }
    if (kind === 'frame') {
      globalThis.requestAnimationFrame(publish)
    } else {
      queueMicrotask(publish)
    }
  }

  private invalidateSchedule(): void {
    this.scheduleGeneration++
    this.scheduled = 'none'
  }

  private flush(): void {
    if (!this.notifyPending) return
    if (this.listeners.size === 0) return // 惰性：脏（若仍置位）在下一次 getSnapshot 时重建
    this.notifyPending = false
    if (this.dirty) {
      this.dirty = false
      this.rebuild()
    }
    notifySubscribers(this.listeners, '[session-controller]')
  }
}
