/**
 * 宿主为一次会话绘制的提示词上方横幅：经由 mod 的 `ui.render` 钩子渲染，
 * 保留最新树形结构并把按钮回调握在宿主一侧，当某次渲染读到的 `$.state`
 * 值发生变化或 mod 主动请求时重绘，并向观察者交付每一代新画面。
 * @module
 */

import { serializeTree, treeProblem } from './elements.ts'
import type { UiNode } from './elements.ts'
import { messageOf } from './values.ts'
import type { SerializedNode, SurfaceSnapshot, UiRenderInput } from './types.ts'

export type { SurfaceSnapshot } from './types.ts'

/** 该表从宿主处需要的内容。 */
export interface SurfaceHost {
  /** 横幅向 `ui.render` 报告的列数，作为 `bodyColumns` 与 `viewport.columns`。 */
  readonly columns: number
  /** 横幅报告的行数，作为 `maxRows`。 */
  readonly rows: number
  /** 为一次会话经由 mod 触发 `ui.render` 并返回树形结构。 */
  render(sessionId: string, input: UiRenderInput): Promise<UiNode>
  /** 在会话内部运行某个按钮的回调；宿主拥有调用及其上报。 */
  runAction(sessionId: string, callback: () => unknown): Promise<void>
  /** 接收诊断信息：无效树、失败的按下操作。 */
  report(line: string): void
}

class SessionBand {
  generation = 0
  tree: readonly SerializedNode[] | null = null
  /** 最近一次渲染读到的 `$.state` 槽位，形如 `<plugin>\u0000<key>`。 */
  readonly subscribed = new Set<string>()
  /** 当前这一代的按钮回调，按序列化树携带的 `actionId` 索引。 */
  readonly actions = new Map<string, () => unknown>()
  readonly watchers = new Set<(snapshot: SurfaceSnapshot) => void>()
  /** 正在进行的渲染；渲染期间的刷新会并入它在结束时启动的下一轮。 */
  rendering: Promise<void> | undefined
  pending: Promise<void> | undefined
  /** 由 `forget` 设置：观察者在下次唤醒时结束，不再有后续渲染。 */
  closed = false
  /** 唤醒每一个停驻的观察者，使已关闭的横幅结束其流。 */
  readonly wakers = new Set<() => void>()
  /** 渲染进行期间设置：`$.state` 读取会订阅。 */
  collecting: Set<string> | undefined

  snapshot(): SurfaceSnapshot {
    return { generation: this.generation, tree: this.tree }
  }
}

/**
 * 按会话 id 索引的横幅。
 */
export class SurfaceTable {
  private readonly bands = new Map<string, SessionBand>()
  private disposed = false

  constructor(private readonly host: SurfaceHost) {}

  /**
   * 一次会话横幅的最新快照，若尚未绘制则先绘制。
   * @param sessionId - 会话。
   * @returns 当前代。
   */
  async current(sessionId: string): Promise<SurfaceSnapshot> {
    const band = this.bandOf(sessionId)
    if (band.generation === 0) await this.refresh(sessionId)
    return band.snapshot()
  }

  /**
   * 观察一次会话的横幅：先是当前快照，之后每次重绘，直到信号中止。
   * @param sessionId - 会话。
   * @param signal - 结束观察。
   * @returns 快照。
   */
  async *watch(sessionId: string, signal: AbortSignal): AsyncIterable<SurfaceSnapshot> {
    const band = this.bandOf(sessionId)
    const queue: SurfaceSnapshot[] = []
    let wake: (() => void) | undefined
    const watcher = (snapshot: SurfaceSnapshot): void => {
      queue.push(snapshot)
      wake?.()
    }
    band.watchers.add(watcher)
    const onAbort = (): void => { wake?.() }
    const waker = (): void => { wake?.() }
    band.wakers.add(waker)
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      const first = await this.current(sessionId)
      let delivered = first.generation
      yield first
      while (!signal.aborted && !band.closed) {
        const next = queue.shift()
        if (next !== undefined) {
          // 第一幅画面可能既作为当前快照、又作为观察者通知到达。
          if (next.generation <= delivered) continue
          delivered = next.generation
          yield next
          continue
        }
        await new Promise<void>((resolve) => { wake = resolve })
        wake = undefined
      }
    } finally {
      band.watchers.delete(watcher)
      band.wakers.delete(waker)
      signal.removeEventListener('abort', onAbort)
    }
  }

  /**
   * 经 mod 重绘一次会话的横幅，并在树形变化后通知观察者。
   * @param sessionId - 会话。
   * @returns 重绘落地后结束。
   */
  refresh(sessionId: string): Promise<void> {
    const band = this.bandOf(sessionId)
    if (band.rendering === undefined) {
      band.rendering = this.renderOnce(sessionId, band).finally(() => { band.rendering = undefined })
      return band.rendering
    }
    // 在途渲染结束后再跑一轮，即可覆盖期间被请求的所有刷新。
    band.pending ??= band.rendering.then(() => {
      band.pending = undefined
      return this.refresh(sessionId)
    })
    return band.pending
  }

  /**
   * 运行按钮所持有的回调并重绘。来自更早一代的按下会被忽略：它所命名的
   * 按钮可能已不存在。
   * @param sessionId - 会话。
   * @param generation - Client 看到的代。
   * @param actionId - 序列化 Button 携带的 id。
   * @returns 按下后的快照。
   */
  async press(sessionId: string, generation: number, actionId: string): Promise<SurfaceSnapshot> {
    const band = this.bandOf(sessionId)
    const action = generation === band.generation ? band.actions.get(actionId) : undefined
    if (action === undefined) {
      this.host.report(`band press ignored: ${actionId} of generation ${generation} is not on the current drawing (${band.generation})`)
      return band.snapshot()
    }
    await this.host.runAction(sessionId, action)
    await this.refresh(sessionId)
    return band.snapshot()
  }

  /**
   * 记录一次 `$.state` 读取：渲染期间会把横幅订阅到该槽位。
   * @param sessionId - 状态所属的会话。
   * @param slot - `<plugin>\u0000<key>` 槽位。
   */
  stateRead(sessionId: string, slot: string): void {
    this.bands.get(sessionId)?.collecting?.add(slot)
  }

  /**
   * 记录一次 `$.state` 写入：已订阅的横幅会重绘。
   * @param sessionId - 状态所属的会话。
   * @param slot - `<plugin>\u0000<key>` 槽位。
   */
  stateWritten(sessionId: string, slot: string): void {
    const band = this.bands.get(sessionId)
    if (band === undefined || !band.subscribed.has(slot)) return
    void this.refresh(sessionId)
  }

  /**
   * 遗忘一次会话的横幅：其观察流结束，不再有后续渲染。
   * @param sessionId - 已被释放的会话。
   */
  forget(sessionId: string): void {
    const band = this.bands.get(sessionId)
    if (band === undefined) return
    this.bands.delete(sessionId)
    band.closed = true
    band.watchers.clear()
    for (const waker of [...band.wakers]) waker()
  }

  /** 停止绘制：所有横幅被遗忘，其观察流结束。 */
  dispose(): void {
    this.disposed = true
    for (const sessionId of [...this.bands.keys()]) this.forget(sessionId)
  }

  private bandOf(sessionId: string): SessionBand {
    let band = this.bands.get(sessionId)
    if (band === undefined) {
      band = new SessionBand()
      this.bands.set(sessionId, band)
    }
    return band
  }

  private async renderOnce(sessionId: string, band: SessionBand): Promise<void> {
    if (this.disposed || band.closed) return
    const input: UiRenderInput = {
      component: 'AbovePrompt',
      surface: 'AbovePrompt',
      props: { bodyColumns: this.host.columns, hasSurvey: false, isWorking: false, maxRows: this.host.rows },
      viewport: { columns: this.host.columns },
    }
    band.collecting = new Set()
    let tree: UiNode
    try {
      tree = await this.host.render(sessionId, input)
    } catch (error: unknown) {
      this.host.report(`band render failed: ${messageOf(error)}`)
      tree = null
    }
    band.subscribed.clear()
    for (const slot of band.collecting) band.subscribed.add(slot)
    band.collecting = undefined
    const problem = treeProblem(tree)
    if (problem !== undefined) {
      this.host.report(`a ui.render hook returned a tree that does not validate: ${problem}`)
      tree = null
    }
    // 每次绘制 action id 递增，因此未变化的树序列化结果相同，从而保持其代不变。
    const actions = new Map<string, () => unknown>()
    const serialized = serializeTree(tree, (callback) => {
      const id = `a${actions.size}`
      actions.set(id, callback)
      return id
    })
    const next = serialized.length === 0 ? null : serialized
    if (band.generation > 0 && JSON.stringify(next) === JSON.stringify(band.tree)) {
      // 同一幅画面，但闭包可能已更新：保留代，持有新的回调。
      band.actions.clear()
      for (const [id, action] of actions) band.actions.set(id, action)
      return
    }
    band.generation += 1
    band.tree = next
    band.actions.clear()
    for (const [id, action] of actions) band.actions.set(id, action)
    for (const watcher of band.watchers) watcher(band.snapshot())
  }
}
