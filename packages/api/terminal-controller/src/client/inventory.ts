/** 跨视图出现项共享的 Session 终端发现。 */
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { WebTerminalId, WebTerminalInfo } from '../types.ts'

type Inventory = ReadonlyMap<WebTerminalId, WebTerminalInfo>
interface Loading {
  readonly kind: 'loading'
  readonly promise: Promise<Inventory>
  readonly updates: Map<WebTerminalId, WebTerminalInfo | undefined>
}
type LoadState = { readonly kind: 'unloaded' | 'ready' | 'disposed' }
  | { readonly kind: 'failed'; readonly error: Error }
  | Loading

/** 一个 Session 的缓存列表、保留的失败与进行中的变更调和。 */
export class TerminalInventory {
  private state: LoadState = { kind: 'unloaded' }
  private items = new Map<WebTerminalId, WebTerminalInfo>()
  private readonly pending = new Set<Promise<Inventory>>()

  /** @param load - 获取该 Session 已保留的 Host 终端。 */
  constructor(private readonly load: () => Promise<RemoteResult<WebTerminalInfo[]>>) {}

  /**
   * 读取缓存的列表，或加入其唯一一个进行中的请求。
   * @param refresh - 显式替换已落定的结果或失败；重叠的刷新共享一个请求。
   * @returns 当前终端元数据；失败会一直缓存，直到刷新或重置。
   */
  read(refresh: boolean = false): Promise<Inventory> {
    if (this.state.kind === 'disposed') return Promise.reject(new Error('Terminal inventory disposed'))
    if (this.state.kind === 'loading') return this.state.promise
    if (!refresh && this.state.kind === 'ready') return Promise.resolve(this.items)
    if (!refresh && this.state.kind === 'failed') return Promise.reject(this.state.error)
    const completed = Promise.withResolvers<Inventory>()
    const request: Loading = { kind: 'loading', promise: completed.promise, updates: new Map() }
    this.state = request
    this.pending.add(completed.promise)
    void this.loadRequest(request).then(completed.resolve, completed.reject)
    void completed.promise.then(() => { this.pending.delete(completed.promise) }, () => { this.pending.delete(completed.promise) })
    return completed.promise
  }

  private async loadRequest(request: Loading): Promise<Inventory> {
    try {
      const result = await this.load()
      if (this.state !== request) return await this.read()
      if (!result.ok) throw result.error
      const items = new Map(result.value.map(info => [info.id, info]))
      for (const [id, info] of request.updates) {
        if (info === undefined) items.delete(id)
        else items.set(id, info)
      }
      this.items = items
      this.state = { kind: 'ready' }
      return items
    } catch (error) {
      if (this.state !== request) return this.read()
      const failure = error instanceof Error ? error : new Error('Terminal discovery failed', { cause: error })
      this.state = { kind: 'failed', error: failure }
      throw failure
    }
  }

  /**
   * 在列表响应未决期间保留已确认的变更与连接元数据。
   * @param info - 最新确认的终端元数据。
   */
  update(info: WebTerminalInfo): void {
    if (this.state.kind === 'disposed') return
    this.items.set(info.id, info)
    if (this.state.kind === 'loading') this.state.updates.set(info.id, info)
  }

  /**
   * 在确认关闭或不可用之后移除终端。
   * @param id - 终端标识。
   */
  remove(id: WebTerminalId): void {
    if (this.state.kind === 'disposed') return
    this.items.delete(id)
    if (this.state.kind === 'loading') this.state.updates.set(id, undefined)
  }

  /**
   * 在连接变更之后替换发现；绝不发现尚未需要过列表的 Session。
   * @returns 替换后的查找，未使用或已释放的清单则返回 undefined。
   */
  reset(): Promise<Inventory> | undefined {
    if (this.state.kind === 'unloaded' || this.state.kind === 'disposed') return undefined
    this.state = { kind: 'unloaded' }
    return this.read()
  }

  /**
   * 丢弃元数据并阻止迟到的响应发布。
   * @returns 其拥有的全部列表请求落定之后。
   */
  async dispose(): Promise<void> {
    this.state = { kind: 'disposed' }
    this.items.clear()
    await Promise.allSettled(this.pending)
  }
}
