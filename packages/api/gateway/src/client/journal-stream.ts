/** 在可重连 Remote 流之上协调游标、页面与实时尾随。 */

import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { RemoteStreamCarrierError } from './stream-client.ts'
import type {
  RemoteStream,
  RemoteStreamItem,
  RemoteStreamOptions,
} from './remote-stream.ts'

/** Host 侧的流协议违规，已加标记，使消费方将其呈现为错误状态。 */
function protocolViolation(message: string): RemoteError<'gateway/internal'> {
  return new RemoteError('gateway/internal', message, {})
}

/** 与传输无关的起始快照、持久条目或无游标通知。 */
export type RemoteJournalFrame<Entry, Cursor, Page, Notification = never> =
  | { readonly type: 'opened'; readonly cursor: Cursor; readonly page: Page }
  | { readonly type: 'entry'; readonly entry: Entry }
  | ([Notification] extends [never]
    ? never
    : { readonly type: 'notification'; readonly notification: Notification })

/** 一次日志流窗口更新或无游标领域通知。 */
export type RemoteJournalChange<Page, Entry, Notification = never> =
  | {
    readonly type: 'replace'
    readonly page: Page
    readonly entries: readonly Entry[]
    readonly hasMore: boolean
  }
  | {
    readonly type: 'prepend'
    readonly page: Page
    readonly entries: readonly Entry[]
    readonly hasMore: boolean
  }
  | { readonly type: 'append'; readonly entry: Entry }
  | ([Notification] extends [never]
    ? never
    : { readonly type: 'notification'; readonly notification: Notification })

type JournalStreamItem<Page, Entry, Cursor, Notification> = RemoteStreamItem<
  RemoteJournalFrame<Entry, Cursor, Page, Notification>
>

/** 用于创建一个可重连 Remote 流的 Gateway 能力。 */
export interface RemoteStreamFactory {
  /**
   * 创建一个可独立取消的逻辑流。
   * @param options - 领域自有的打开器与代结束分类。
   * @returns 一个可重连的单消费方流。
   */
  $stream<Item>(options: RemoteStreamOptions<Item>): RemoteStream<Item>
}

/** 一个已寻址日志流的领域发布与游标操作。 */
export interface RemoteJournalStreamOptions<Page, Entry, Cursor, Notification = never> {
  /** 协议失败中使用的诊断性流名称。 */
  readonly name: string
  /** 表示没有条目的日志流的游标。 */
  readonly emptyCursor: Cursor
  /** 读取一个页面承载的有序条目。 */
  readonly entries: (page: Page) => readonly Entry[]
  /** 读取是否存在更早的页面。 */
  readonly hasMore: (page: Page) => boolean
  /** 读取一个条目覆盖的首个持久游标（含端点）。 */
  readonly first: (entry: Entry) => Cursor
  /** 读取最终的游标（含端点），它不得早于首个游标。 */
  readonly last: (entry: Entry) => Cursor
  /** 比较两个游标。 */
  readonly compare: (left: Cursor, right: Cursor) => number
  /** 测试右侧游标是否紧随左侧游标。 */
  readonly follows: (left: Cursor, right: Cursor) => boolean
  /** 应用一次完整的日志流窗口变更或无游标通知。 */
  readonly publish: (change: RemoteJournalChange<Page, Entry, Notification>) => void
  /** 在重连之前观察一次可重试的载体丢失。 */
  readonly carrierFailed?: (error: RemoteStreamCarrierError) => void
  /** 在打开之后发布终止性的流、页面或协议失败。 */
  readonly failed: (error: unknown) => void
}

/**
 * 拥有快照优先的打开、有序的实时交付、分页与修复。
 *
 * 重连期间，领域保留其已发布的窗口。只有起始页面抵达该代的
 * 游标之后，替换才会发布。通知绝不改变游标，并在进行中的
 * 缺口修复之后等待。
 */
export abstract class RemoteJournalStream<
  Page, Entry, Cursor, PageRequest = void, Notification = never,
> {
  private readonly stream: RemoteStream<RemoteJournalFrame<Entry, Cursor, Page, Notification>>
  private initialRequest!: PageRequest
  private resumeCursor: Cursor | undefined
  private hasResumeCursor = false
  private generation = 0
  private firstCursor: Cursor | undefined
  private lastCursor: Cursor | undefined
  private started = false
  private opened = false
  private disposed = false
  private done: Promise<void> | undefined
  private closing: Promise<void> | undefined
  private pendingNext: Promise<IteratorResult<JournalStreamItem<Page, Entry, Cursor, Notification>>> | undefined

  /**
   * @param remote - 可重连物理代流的 Gateway 工厂。
   * @param options - 游标代数与领域发布汇。
   */
  protected constructor(
    remote: RemoteStreamFactory,
    private readonly options: RemoteJournalStreamOptions<Page, Entry, Cursor, Notification>,
  ) {
    this.stream = remote.$stream<RemoteJournalFrame<Entry, Cursor, Page, Notification>>({
      name: options.name,
      open: signal => this.follow(this.initialRequest, signal),
      ended: accepted => accepted
        ? new RemoteStreamCarrierError(`${options.name} ended without a terminal result`)
        : protocolViolation(
          `${this.hasResumeCursor ? 'resumed ' : ''}${options.name} ended before its opening cursor`,
        ),
      ...(options.carrierFailed === undefined
        ? {}
        : { carrierFailed: options.carrierFailed }),
    })
  }

  /**
   * 以完整的当前快照打开一个物理日志流代。
   * @param request - 为后续修复保留的打开窗口请求。
   * @param signal - 物理代的取消生命周期。
   * @returns 起始游标，其后是实时条目。
   */
  protected abstract follow(
    request: PageRequest,
    signal: AbortSignal,
  ): AsyncIterable<RemoteJournalFrame<Entry, Cursor, Page, Notification>>

  /**
   * 通过已寻址的领域源读取一个日志流页面。
   * @param request - 领域页面请求。
   * @param through - 固定源读取范围的日志流游标（含端点）。
   * @param signal - 与逻辑流共享的取消生命周期。
   * @returns 请求的页面，其尾部等于 `through`，除非领域请求选择了更早的条目。
   */
  protected abstract readPage(request: PageRequest, through: Cursor, signal: AbortSignal): Promise<Page>

  /**
   * 从初始页面请求派生一个无界尾部的请求。
   * @param initial - 用于打开日志流窗口的请求。
   * @returns 适用于重连与缺口修复的请求。
   */
  protected abstract repairRequest(initial: PageRequest): PageRequest

  /** follow 与页面调用共享的取消生命周期。 */
  get signal(): AbortSignal {
    return this.stream.signal
  }

  /**
   * 建立跟随，并发布其首帧携带的起始快照。
   * @param request - 初始的尾部页面请求。
   * @returns 在第一个完整窗口发布之后。
   */
  async open(request: PageRequest): Promise<void> {
    if (this.started) throw new Error(`${this.options.name} already opened`)
    this.started = true
    this.initialRequest = request
    const iterator = this.stream[Symbol.asyncIterator]()
    try {
      const first = await this.takeNext(iterator)
      if (first.done) throw protocolViolation(`${this.options.name} ended before its opening cursor`)
      this.replaceGeneration(first.value, false)
      this.opened = true
      this.done = this.consume(iterator)
    } catch (error) {
      await this.stream.dispose()
      throw error
    }
  }

  /**
   * 在成功打开之后读取并前插一个更早的页面。
   * @param request - 绑定到此流地址的领域页面请求。
   * @returns 在该页面被应用，或因不连续而被拒绝之后。
   */
  async prepend(request: PageRequest): Promise<void> {
    if (!this.opened || this.disposed) throw new Error(`${this.options.name} is not open`)
    const page = await this.readPage(request, this.currentCursor(), this.stream.signal)
    this.stream.signal.throwIfAborted()
    const entries = this.options.entries(page)
    this.assertPage(entries)
    const before = this.firstCursor
    const accepted = before === undefined
      ? [...entries]
      : entries.filter(entry => this.options.compare(this.options.first(entry), before) < 0)
    const tail = accepted.at(-1)
    if (tail !== undefined && before !== undefined
      && !this.options.follows(this.options.last(tail), before)) {
      this.options.publish({ type: 'prepend', page, entries: [], hasMore: false })
      throw protocolViolation(`${this.options.name} history page is discontinuous`)
    }
    const first = accepted[0]
    if (first !== undefined) this.firstCursor = this.options.first(first)
    this.options.publish({
      type: 'prepend',
      page,
      entries: accepted,
      hasMore: this.options.hasMore(page),
    })
  }

  /** 在保留已发布窗口的同时替换活跃的物理代。 */
  restart(): void {
    this.stream.restart()
  }

  /**
   * 永久停止跟随、页面请求与后台消费方。
   * @returns 不再有任何流工作或发布回调可以运行时。
   */
  dispose(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.disposed = true
    const done = this.done
    const closing = (async () => {
      await this.stream.dispose()
      await done
    })()
    this.closing = closing
    return closing
  }

  private async consume(
    iterator: AsyncIterator<JournalStreamItem<Page, Entry, Cursor, Notification>>,
  ): Promise<void> {
    try {
      while (true) {
        const next = await this.takeNext(iterator)
        if (next.done) return
        const item = next.value
        if (item.generation !== this.generation) {
          this.replaceGeneration(item, true)
          continue
        }
        if (item.value.type === 'opened') {
          throw protocolViolation(`${this.options.name} emitted more than one opening cursor`)
        }
        if (item.value.type === 'notification') {
          this.publishNotification(item.value.notification)
          continue
        }
        await this.acceptEntry(item.value.entry, item, iterator)
      }
    } catch (error) {
      if (!this.disposed) this.options.failed(error)
    }
  }

  private replaceGeneration(
    initial: JournalStreamItem<Page, Entry, Cursor, Notification>,
    resumed: boolean,
  ): void {
    const opening = this.opening(initial, resumed)
    this.replaceFromOpening(opening.page, opening.cursor)
  }

  private opening(
    item: RemoteStreamItem<RemoteJournalFrame<Entry, Cursor, Page, Notification>>,
    resumed: boolean,
  ): { readonly cursor: Cursor; readonly page: Page } {
    if (item.value.type !== 'opened') {
      throw protocolViolation(`${resumed ? 'resumed ' : ''}${this.options.name} emitted an entry before its opening cursor`)
    }
    const cursor = item.value.cursor
    if (resumed && this.lastCursor !== undefined
      && this.options.compare(cursor, this.lastCursor) < 0) {
      throw protocolViolation(
        `${this.options.name} resumed at a cursor behind the last applied entry`,
      )
    }
    this.generation = item.generation
    item.accept()
    return { cursor, page: item.value.page }
  }

  /** 发布一个代的起始页面，而不发出第二次 Remote 调用。 */
  private replaceFromOpening(page: Page, cursor: Cursor): void {
    this.assertPageThrough(page, cursor)
    const entries = [...this.options.entries(page)]
    this.assertPage(entries)
    const first = entries[0]
    this.firstCursor = first === undefined ? undefined : this.options.first(first)
    this.lastCursor = cursor
    this.setResumeCursor(cursor)
    this.options.publish({
      type: 'replace',
      page,
      entries,
      hasMore: this.options.hasMore(page),
    })
  }

  private async acceptEntry(
    entry: Entry,
    item: JournalStreamItem<Page, Entry, Cursor, Notification>,
    iterator: AsyncIterator<JournalStreamItem<Page, Entry, Cursor, Notification>>,
  ): Promise<void> {
    const { first, last: cursor } = this.entryRange(entry)
    const last = this.lastCursor as Cursor
    if (this.options.compare(cursor, last) <= 0) return
    if (this.options.compare(first, last) <= 0) {
      throw protocolViolation(`${this.options.name} emitted a partially overlapping entry`)
    }
    if (!this.options.follows(last, first)) {
      const request = this.repairPageRequest()
      const superseded = await this.replaceThrough(
        request,
        cursor,
        item.generation,
        item.signal,
        iterator,
        [entry],
        [],
      )
      if (superseded !== undefined) {
        this.replaceGeneration(superseded, true)
      }
      return
    }
    if (this.firstCursor === undefined) this.firstCursor = first
    this.lastCursor = cursor
    this.setResumeCursor(cursor)
    this.options.publish({ type: 'append', entry })
  }

  private async replaceThrough(
    request: PageRequest,
    requiredCursor: Cursor,
    generation: number,
    signal: AbortSignal,
    iterator: AsyncIterator<JournalStreamItem<Page, Entry, Cursor, Notification>>,
    queued: Entry[],
    notifications: Notification[],
  ): Promise<JournalStreamItem<Page, Entry, Cursor, Notification> | undefined> {
    let read = await this.readPageWhileFollowing(
      request,
      requiredCursor,
      generation,
      signal,
      iterator,
      queued,
      notifications,
    )
    if (read.type === 'superseded') return read.item
    let page = read.page
    this.assertPageThrough(page, requiredCursor)
    let entries = this.mergeReplacement(page, queued)
    let target = this.maxCursor(requiredCursor, queued)
    if (entries === undefined || this.options.compare(this.tailCursor(entries), target) < 0) {
      read = await this.readPageWhileFollowing(
        this.repairPageRequest(),
        target,
        generation,
        signal,
        iterator,
        queued,
        notifications,
      )
      if (read.type === 'superseded') return read.item
      page = read.page
      this.assertPageThrough(page, target)
      entries = this.mergeReplacement(page, queued)
      target = this.maxCursor(requiredCursor, queued)
    }
    if (entries === undefined || this.options.compare(this.tailCursor(entries), target) < 0) {
      throw protocolViolation(`${this.options.name} page did not reach its opening cursor`)
    }
    const first = entries[0]
    /* v8 ignore next -- a successful positive-cursor replacement page cannot be empty. */
    this.firstCursor = first === undefined ? undefined : this.options.first(first)
    this.lastCursor = this.tailCursor(entries)
    this.setResumeCursor(this.lastCursor)
    this.options.publish({
      type: 'replace',
      page,
      entries,
      hasMore: this.options.hasMore(page),
    })
    for (const notification of notifications) {
      this.publishNotification(notification)
    }
    return undefined
  }

  private async readPageWhileFollowing(
    request: PageRequest,
    through: Cursor,
    generation: number,
    signal: AbortSignal,
    iterator: AsyncIterator<JournalStreamItem<Page, Entry, Cursor, Notification>>,
    queued: Entry[],
    notifications: Notification[],
  ): Promise<
    | { readonly type: 'page'; readonly page: Page }
    | { readonly type: 'superseded'; readonly item: JournalStreamItem<Page, Entry, Cursor, Notification> }
  > {
    const page = this.readPage(request, through, signal).then(
      value => ({ type: 'page' as const, value }),
      (error: unknown) => ({ type: 'page-error' as const, error }),
    )
    while (true) {
      const pending = this.nextResult(iterator)
      const next = pending.then(
        value => ({ type: 'next' as const, value }),
        (error: unknown) => ({ type: 'next-error' as const, error }),
      )
      const result = await Promise.race([page, next])
      if (result.type === 'page') {
        signal.throwIfAborted()
        return { type: 'page', page: result.value }
      }
      if (result.type === 'page-error') {
        if (!signal.aborted || this.stream.signal.aborted) throw result.error
        return this.awaitReplacementGeneration(generation, iterator, pending)
      }
      this.releaseNext()
      if (result.type === 'next-error') throw result.error
      if (result.value.done) {
        signal.throwIfAborted()
        throw protocolViolation(`${this.options.name} ended while reading its replacement page`)
      }
      const item = result.value.value
      if (item.generation !== generation) return { type: 'superseded', item }
      if (item.value.type === 'opened') {
        throw protocolViolation(`${this.options.name} emitted more than one opening cursor`)
      }
      if (item.value.type === 'notification') {
        notifications.push(item.value.notification)
        continue
      }
      queued.push(item.value.entry)
    }
  }

  private async awaitReplacementGeneration(
    generation: number,
    iterator: AsyncIterator<JournalStreamItem<Page, Entry, Cursor, Notification>>,
    initial: Promise<IteratorResult<JournalStreamItem<Page, Entry, Cursor, Notification>>>,
  ): Promise<{ readonly type: 'superseded'; readonly item: JournalStreamItem<Page, Entry, Cursor, Notification> }> {
    let pending = initial
    while (true) {
      let next: IteratorResult<JournalStreamItem<Page, Entry, Cursor, Notification>>
      try {
        next = await pending
      } finally {
        this.releaseNext()
      }
      if (next.done) {
        this.stream.signal.throwIfAborted()
        throw protocolViolation(`${this.options.name} ended while replacing an aborted page generation`)
      }
      const item = next.value
      if (item.generation !== generation) return { type: 'superseded', item }
      if (item.value.type === 'opened') {
        throw protocolViolation(`${this.options.name} emitted more than one opening cursor`)
      }
      pending = this.nextResult(iterator)
    }
  }

  private mergeReplacement(page: Page, queued: readonly Entry[]): Entry[] | undefined {
    const entries = [...this.options.entries(page)]
    this.assertPage(entries)
    for (const entry of queued) this.entryRange(entry)
    const sorted = [...queued].sort((left, right) => (
      this.options.compare(this.options.first(left), this.options.first(right))
    ))
    let tail = this.tailCursor(entries)
    for (const entry of sorted) {
      const first = this.options.first(entry)
      const last = this.options.last(entry)
      if (this.options.compare(last, tail) <= 0) continue
      if (this.options.compare(first, tail) <= 0) {
        throw protocolViolation(`${this.options.name} replacement contains a partially overlapping entry`)
      }
      if (!this.options.follows(tail, first)) return undefined
      entries.push(entry)
      tail = last
    }
    return entries
  }

  private maxCursor(cursor: Cursor, entries: readonly Entry[]): Cursor {
    let result = cursor
    for (const entry of entries) {
      const candidate = this.options.last(entry)
      if (this.options.compare(candidate, result) > 0) result = candidate
    }
    return result
  }

  private nextResult(
    iterator: AsyncIterator<JournalStreamItem<Page, Entry, Cursor, Notification>>,
  ): Promise<IteratorResult<JournalStreamItem<Page, Entry, Cursor, Notification>>> {
    this.pendingNext ??= iterator.next()
    return this.pendingNext
  }

  private async takeNext(
    iterator: AsyncIterator<JournalStreamItem<Page, Entry, Cursor, Notification>>,
  ): Promise<IteratorResult<JournalStreamItem<Page, Entry, Cursor, Notification>>> {
    const pending = this.nextResult(iterator)
    try {
      return await pending
    } finally {
      this.releaseNext()
    }
  }

  private releaseNext(): void {
    this.pendingNext = undefined
  }

  private publishNotification(notification: Notification): void {
    this.options.publish({
      type: 'notification',
      notification,
    } as RemoteJournalChange<Page, Entry, Notification>)
  }

  private repairPageRequest(): PageRequest {
    return this.repairRequest(this.initialRequest)
  }

  private setResumeCursor(cursor: Cursor): void {
    this.resumeCursor = cursor
    this.hasResumeCursor = true
  }

  private currentCursor(): Cursor {
    return this.resumeCursor as Cursor
  }

  private tailCursor(entries: readonly Entry[]): Cursor {
    const tail = entries.at(-1)
    return tail === undefined ? this.options.emptyCursor : this.options.last(tail)
  }

  private assertPage(entries: readonly Entry[]): void {
    const iterator = entries[Symbol.iterator]()
    const first = iterator.next()
    if (first.done) return
    let previousRange = this.entryRange(first.value)
    for (const entry of iterator) {
      const range = this.entryRange(entry)
      if (!this.options.follows(previousRange.last, range.first)) {
        throw protocolViolation(`${this.options.name} page contains discontinuous entries`)
      }
      previousRange = range
    }
  }

  private entryRange(entry: Entry): { readonly first: Cursor; readonly last: Cursor } {
    const first = this.options.first(entry)
    const last = this.options.last(entry)
    if (this.options.compare(first, last) > 0) {
      throw protocolViolation(`${this.options.name} entry has an inverted cursor range`)
    }
    return { first, last }
  }

  private assertPageThrough(page: Page, through: Cursor): void {
    const tail = this.tailCursor(this.options.entries(page))
    if (this.options.compare(tail, through) !== 0) {
      throw protocolViolation(`${this.options.name} page did not end at its requested cursor`)
    }
  }
}
