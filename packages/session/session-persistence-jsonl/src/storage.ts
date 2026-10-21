/**
 * JSONL 提供方的会话存储运行时：其具体的写/读句柄，带有按句柄划分的变更链
 * 与一个由路由驱动的实时写回缓冲；强制每个会话 id 只有一个活跃写入者的
 * 进程内记账；以及该后端的实时事件路由与拆卸。刻意保持为提供方局部实现：
 * 持久化接缝只暴露服务与句柄契约，而共享的契约测试套件负责在各提供方之间
 * 固定等价的可观测行为。
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import {
  assertContiguous,
  SessionAlreadyExistsError,
  materializeAppendBatch,
  SessionAlreadyOwnedError,
  SessionHandleClosedError,
  SessionPersistenceNotFoundError,
  SessionPersistenceRevision,
  SessionReadOnlyError,
} from '@deepseek-ai/dsh-session-persistence'
import type {
  SessionAccess,
  SessionHandle,
  SessionHandleAppendOptions,
  SessionHandleFlushOptions,
  SessionHandleReadOptions,
  SessionHandleReadResult,
} from '@deepseek-ai/dsh-session-persistence'
import type { SessionWriteLease } from './lease.ts'

/** 在被路由的实时会话批次开始写入之前，允许的最大有意等待时间。 */
export const LIVE_WRITE_BATCH_MAX_DELAY_MS = 200

/** 句柄在其所属服务上驱动的文件存储原语。 */
export interface JsonlHandleStorage {
  /** 追加已编码的行；`isMaterialized` 决定是“创建式”还是“扩展式”发布。 */
  persistBatch(
    header: SessionHeader,
    events: readonly SessionEvent[],
    isMaterialized: boolean,
    inheritedEventCount: SessionLogOffset,
  ): Promise<void>
  /** 为一个被显式 flush 的空会话物化只含头部的制品。 */
  persistHeader(header: SessionHeader, inheritedEventCount: SessionLogOffset): Promise<void>
  /** 在首次新追加落地之前截断被撕裂的物理尾部。 */
  truncateTornTail(header: SessionHeader, truncateTo: number): Promise<void>
  /** 解析当前代际的制品路径；不存在时为 `undefined`。 */
  resolveCurrentLog(id: SessionId, signal?: AbortSignal): Promise<string | undefined>
  /** 读取并校验位于 `path` 的已存储日志，包括其已确立的事件别名状态。 */
  readStoredLog(path: string, expectedId: SessionId, signal?: AbortSignal): Promise<SessionHandleReadResult>
  /** 该 id 在此处是否仍是一个已创建但未物化的会话。 */
  hasPendingSession(id: SessionId): boolean
  /** 在该会话的制品目录中获取其跨进程写锁。 */
  acquireWriteLease(header: SessionHeader): Promise<SessionWriteLease>
  /** 在关闭时丢弃句柄的记账信息。 */
  releaseHandle(handle: JsonlSessionHandle, materialized: boolean): void
}

/** 可变的、按句柄划分的日志状态；写句柄是其会话的唯一修改者。 */
export interface StorageHandleState {
  /** 已存储的 next-seq（本句柄所知的逻辑末端）。 */
  cursor: number
  /** 该会话是否已有持久制品。 */
  materialized: boolean
  /** 撕裂尾部的截断点，由首次新追加消费。 */
  tornTruncateTo?: number | undefined
  /** 从被撕裂的末尾帧中恢复出的完整事件；首次变更会持久地重写它们。 */
  recoveredTail?: SessionEvent[] | undefined
  /** 随日志一起存储的精确 fork 继承前缀长度；未播种时为 `0`。 */
  inheritedEventCount: SessionLogOffset
  /** 写打开时得到的已校验存储前缀，在首次追加之前供读取使用。 */
  primed?: SessionHandleReadResult | undefined
}

/**
 * JSONL 会话句柄。变更在按句柄划分的 Promise 链上串行执行；读取按需重新
 * 扫描制品，并且永不观测到比本句柄前一次读取更短的日志。被路由的实时事件
 * 在一个有界窗口内缓冲，并通过与显式追加相同的链排空。
 */
export class JsonlSessionHandle implements SessionHandle {
  private chain: Promise<unknown> = Promise.resolve()
  private closing: Promise<void> | undefined
  private observedLength = 0
  /** 等待其批处理截止时间的、被路由的实时事件（持久化持有的副本）。 */
  private buffered: SessionEvent[] = []
  private batchTimer: ReturnType<typeof setTimeout> | undefined
  /** 当一次排空失败时置位；在下一次排空之前，自动定时器保持静默。 */
  private drainPaused = false
  private draining: Promise<void> | undefined

  constructor(
    private readonly storage: JsonlHandleStorage,
    readonly id: SessionId,
    readonly header: SessionHeader,
    readonly access: SessionAccess,
    private readonly state: StorageHandleState,
    /** 跨进程写锁；创建型句柄在首次物化时惰性获取它。 */
    private lease?: SessionWriteLease,
  ) {}

  /** 随本会话日志一起存储的精确 fork 继承前缀长度。 */
  get inheritedEventCount(): SessionLogOffset {
    return this.state.inheritedEventCount
  }

  /**
   * 读取有效连续逻辑日志的一个切片；参见接缝契约。
   * @param offset - 要包含的首个逻辑 seq（默认 0）。
   * @param length - 返回的最大事件数（默认：其余全部）。
   * @param options - 可选取消信号。
   * @returns 一个切片，带有由其生产者确立的别名状态。
   */
  async read(offset = 0, length = Number.MAX_SAFE_INTEGER, options?: SessionHandleReadOptions): Promise<SessionHandleReadResult> {
    // 对已关闭句柄的拒绝先于参数校验：无论参数如何，已关闭的句柄
    // 都以 SessionHandleClosedError 拒绝。
    this.assertOpen('read')
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new TypeError(`read offset must be a non-negative safe integer, got ${String(offset)}`)
    }
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new TypeError(`read length must be a non-negative safe integer, got ${String(length)}`)
    }
    options?.signal?.throwIfAborted()
    let result: SessionHandleReadResult
    const primed = this.state.primed
    if (primed !== undefined) {
      if (this.access === 'write') {
        result = this.readPrimed(primed, offset, length)
      } else {
        const currentPath = await this.storage.resolveCurrentLog(this.id, options?.signal)
        if (currentPath === undefined) {
          result = this.readPrimed(primed, offset, length)
        } else {
          this.state.primed = undefined
          result = await this.readCurrent(currentPath, offset, length, options?.signal)
        }
      }
    } else if (this.access === 'write' && !this.state.materialized) {
      result = { eventState: 'detached', events: [] }
    } else {
      const currentPath = await this.storage.resolveCurrentLog(this.id, options?.signal)
      if (currentPath !== undefined) {
        result = await this.readCurrent(currentPath, offset, length, options?.signal)
      } else if (this.storage.hasPendingSession(this.id)) {
        result = { eventState: 'detached', events: [] }
      } else {
        throw new SessionPersistenceNotFoundError(this.id)
      }
    }
    return result
  }

  /** 从本句柄保留的、已准备好的历史前缀中读取一个切片。 */
  private readPrimed(source: SessionHandleReadResult, offset: number, length: number): SessionHandleReadResult {
    this.observedLength = Math.max(this.observedLength, source.events.length)
    return { eventState: source.eventState, events: source.events.slice(offset, offset + length) }
  }

  /** 读取一个当前物理代际，并强制维持本句柄的单调视图。 */
  private async readCurrent(
    path: string,
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<SessionHandleReadResult> {
    const source = await this.storage.readStoredLog(path, this.id, signal)
    if (source.events.length < this.observedLength) {
      throw new Error(`session "${this.id}": stored log shrank below a previously observed prefix (${source.events.length} < ${this.observedLength})`)
    }
    this.observedLength = source.events.length
    return {
      eventState: source.eventState,
      events: source.events.slice(offset, offset + length),
    }
  }

  /**
   * 持久地追加一个连续批次；参见接缝契约。
   * @param events - 按 seq 排序的连续批次。
   * @param options - 可选取消信号，在写入开始之前被观测。
   */
  async append(events: readonly SessionEvent[], options?: SessionHandleAppendOptions): Promise<void> {
    this.assertOpen('append')
    // 在这里、也就是排到链上之前校验并深度快照该批次，
    // 使被检查的值恰好就是被持久化的值。
    const batch = materializeAppendBatch(events)
    return this.run('append', async () => {
      options?.signal?.throwIfAborted()
      await this.persistContiguous(batch)
    })
  }

  /**
   * 持久性屏障；当尚未追加任何内容时物化制品，使一个被显式 flush 的
   * 空会话能在本进程之外继续存在。
   * @param options - 可选取消信号，在屏障开始之前被观测。
   */
  flush(options?: SessionHandleFlushOptions): Promise<void> {
    return this.run('flush', async () => {
      options?.signal?.throwIfAborted()
      if (this.access !== 'write') throw new SessionReadOnlyError(this.id, 'flush')
      if (this.state.materialized) return // 追加在 resolve 时即已持久
      await this.ensureLease()
      await this.storage.persistHeader(this.header, this.state.inheritedEventCount)
      this.state.materialized = true
    })
  }

  /**
   * 释放该句柄；参见接缝契约。幂等且不可取消。写句柄会先通过仍然打开的
   * 存储排空其被路由的实时缓冲，因此无论哪个纤程先回卷，后端拆卸都不会
   * 丢东西；排空或锁释放的失败仍会先释放进程内的申领，然后再拒绝——
   * 两个失败合在一起作为一个 `AggregateError` 拒绝。
   * @returns 释放操作的结算。
   */
  close(): Promise<void> {
    return this.closing ??= (async () => {
      let drainFailure: unknown
      // 在 close 等待在途变更时（根处置是并发的），其它纤程上的生产者可能
      // 仍在发布，因此要反复排空，直到一整轮之后被路由的缓冲区为空。
      // 该链从不拒绝，因为 run() 会在调用方观测到之后吞掉每个操作的拒绝。
      for (;;) {
        try {
          await this.drainLive()
        } catch (error: unknown) {
          drainFailure = error
          break
        }
        await this.chain
        if (this.buffered.length === 0) break
      }
      // 一次排空失败之后，链上可能仍持有在途变更。
      await this.chain
      // 无论内核锁释放结果如何，都要释放进程内的申领：跳过 releaseHandle
      // 会让该 id 卡在本进程中，其背后是一把内核可能早已丢弃的锁。
      const failures: Error[] = []
      if (drainFailure !== undefined) {
        failures.push(drainFailure instanceof Error ? drainFailure : new Error(errorChain(drainFailure)))
      }
      try {
        await this.lease?.release()
      } catch (releaseFailure: unknown) {
        /* v8 ignore next -- 锁释放以 Error 拒绝 */
        failures.push(releaseFailure instanceof Error ? releaseFailure : new Error(errorChain(releaseFailure)))
      }
      this.storage.releaseHandle(this, this.state.materialized)
      if (failures.length > 1) throw new AggregateError(failures, `session "${this.id}": close failed to drain and to release its write lock`)
      if (failures[0] !== undefined) throw failures[0]
    })()
  }

  /** 支持 `await using`：委托给 {@link close}。 */
  [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }

  /**
   * 缓冲一个已发布的实时会话事件，并在批处理窗口空闲时启动这个有界窗口。
   * 路由安装器是唯一的调用方。
   * @param event - 实时事件，作为持久化持有的副本保留。
   * @param reportBackgroundFailure - 观测由截止时间驱动的排空失败
   *   （事件仍留在缓冲区中；下一次 {@link drainLive} 会响亮地重试）。
   */
  enqueueLive(event: SessionEvent, reportBackgroundFailure: (error: unknown) => void): void {
    this.buffered.push(structuredClone(event))
    if (this.batchTimer !== undefined || this.drainPaused) return
    this.batchTimer = setTimeout(() => {
      this.batchTimer = undefined
      this.drainLive().catch(reportBackgroundFailure)
    }, LIVE_WRITE_BATCH_MAX_DELAY_MS)
  }

  /**
   * 通过变更链持久地排空被路由的实时缓冲；并发调用方会并入同一次排空，
   * 而失败会按顺序保留该批次，以便 `session/flush` 能重试并响亮地拒绝。
   */
  drainLive(): Promise<void> {
    return this.draining ??= this.drainBuffered().finally(() => {
      this.draining = undefined
    })
  }

  private async drainBuffered(): Promise<void> {
    if (this.batchTimer !== undefined) {
      clearTimeout(this.batchTimer)
      this.batchTimer = undefined
    }
    this.drainPaused = false
    while (this.buffered.length > 0) {
      // 在链式回合内部捕获，这样在较早批次写入期间到达的事件
      // 会按顺序合并到下一个批次中。
      await this.enqueueChain(async () => {
        // 只有这次单飞的排空会切分缓冲区，因此在链式回合运行时，
        // while 守卫看到的那个批次仍然存在。
        const batch = this.buffered.splice(0)
        try {
          await this.persistContiguous(materializeAppendBatch(batch))
        } catch (error: unknown) {
          this.buffered = batch.concat(this.buffered)
          this.drainPaused = true
          throw error
        }
      })
    }
  }

  /** 共享的持久追加主体：连续性、所有权、撕裂尾部修复、存储写入与状态推进。 */
  private async persistContiguous(batch: readonly SessionEvent[]): Promise<void> {
    if (this.access !== 'write') throw new SessionReadOnlyError(this.id, 'append')
    if (batch.length === 0) return
    await this.ensureLease()
    assertContiguous(this.id, batch, this.state.cursor)
    // 先提交任何待处理的撕裂尾部修复，并且只在每一步落地之后才清除其状态，
    // 这样失败的步骤会在下一次变更时重试：先截断被撕裂的字节，然后持久地
    // 重写从它们中恢复出的完整事件（这些事件已计入 primed 游标）。
    if (this.state.tornTruncateTo !== undefined) {
      await this.storage.truncateTornTail(this.header, this.state.tornTruncateTo)
      this.state.tornTruncateTo = undefined
    }
    if (this.state.recoveredTail !== undefined) {
      if (this.state.recoveredTail.length > 0) {
        await this.storage.persistBatch(this.header, this.state.recoveredTail, this.state.materialized, this.state.inheritedEventCount)
      }
      this.state.recoveredTail = undefined
    }
    await this.storage.persistBatch(this.header, batch, this.state.materialized, this.state.inheritedEventCount)
    this.state.materialized = true
    this.state.cursor += batch.length
    this.state.primed = undefined
    this.observedLength = this.state.cursor
  }

  /**
   * 在本会话的首次持久写入之前持有跨进程写锁。一个已打开的写句柄从构造时
   * 就持有它；创建型句柄在此处获取它——就在首批日志字节发布之前——并且
   * 即使随后物化失败也一直持有到 close，这样一个正在物化的会话在多次
   * 重试之间始终保持独占所有。
   */
  private async ensureLease(): Promise<void> {
    this.lease ??= await this.storage.acquireWriteLease(this.header)
  }

  /** 把一个操作串到链上，但不做已关闭句柄的拒绝判断（close 触发的排空）。 */
  private enqueueChain(op: () => Promise<void>): Promise<void> {
    const next = this.chain.then(op)
    this.chain = next.catch(() => {})
    return next
  }

  /** 把一个公开的变更操作串到本句柄的链上。 */
  private async run(operation: string, op: () => Promise<void>): Promise<void> {
    this.assertOpen(operation)
    return this.enqueueChain(async () => {
      this.assertOpen(operation)
      return op()
    })
  }

  private assertOpen(operation: string): void {
    if (this.closing !== undefined) throw new SessionHandleClosedError(this.id, operation)
  }
}

/** 一个只在本进程中被跟踪的、已创建但未物化的会话。 */
export interface PendingSession {
  readonly header: SessionHeader
  readonly revision: SessionPersistenceRevision
  /** 在 create 时提供的精确 fork 继承前缀长度。 */
  readonly inheritedEventCount: SessionLogOffset
}

/**
 * JSONL 后端的进程内记账：每个会话 id 对应的唯一活跃写入者（同时充当实时
 * 事件路由）、拆卸清扫会关闭的打开句柄集合，以及本进程已经可以观测到的
 * 已创建但未物化的会话。
 */
export class JsonlBackendTracker {
  /** 每个打开的句柄；拆卸会关闭仍然剩下的那些。 */
  readonly openHandles = new Set<SessionHandle>()
  /** `null` 标记一个其句柄仍在构造中的申领。 */
  private readonly writers = new Map<SessionId, JsonlSessionHandle | null>()
  private readonly pending = new Map<SessionId, PendingSession>()
  private counter = 0

  /** @param name - 后端标签，用于内存中的修订令牌与拆卸错误。 */
  constructor(private readonly name: string) {}

  /**
   * 申领写所有权，并把已创建的会话记录为 pending，使其在物化之前就能被
   * 本进程观测到。在物化之前，这个注册是唯一的守卫——会话 id 不会跨进程
   * 冲突，而且也不存在可供另一个进程打开的持久制品；句柄会在其首次
   * 物化写入时取得跨进程锁。
   * @param header - 已校验的、已分离的头部。
   * @param inheritedEventCount - 精确的 fork 继承前缀长度。
   * @throws {SessionAlreadyExistsError} 当一次并发 create 或一个已打开的
   *   写句柄持有该 id 时抛出——对 create 而言，重复本身就是事实。
   */
  registerCreated(header: SessionHeader, inheritedEventCount: SessionLogOffset): void {
    if (this.writers.has(header.id)) throw new SessionAlreadyExistsError(header.id)
    this.writers.set(header.id, null)
    this.pending.set(header.id, {
      header,
      revision: SessionPersistenceRevision(`memory:${this.name}:${++this.counter}`),
      inheritedEventCount,
    })
  }

  /**
   * 为一个已存在的会话申领写所有权。
   * @param id - 要申领的会话。
   * @throws {SessionAlreadyOwnedError} 当已存在活跃写句柄时抛出。
   */
  claimWrite(id: SessionId): void {
    if (this.writers.has(id)) throw new SessionAlreadyOwnedError(id)
    this.writers.set(id, null)
  }

  /**
   * 回滚一次失败的写打开。
   * @param id - 其申领被丢弃的会话。
   */
  releaseClaim(id: SessionId): void {
    this.writers.delete(id)
  }

  /**
   * 某个已创建但未物化会话的 pending 条目（如果存在）。
   * @param id - 要查找的会话。
   * @returns pending 头部与内存中的修订值。
   */
  pendingOf(id: SessionId): PendingSession | undefined {
    return this.pending.get(id)
  }

  /**
   * 本进程是否仍在跟踪一个已创建但未物化的会话。
   * @param id - 要检测的会话。
   * @returns pending 条目存在时为 true。
   */
  hasPending(id: SessionId): boolean {
    return this.pending.has(id)
  }

  /**
   * 遍历 pending 会话以供列举。
   * @returns 以会话 id 为键的 pending 条目。
   */
  pendingEntries(): IterableIterator<[SessionId, PendingSession]> {
    return this.pending.entries()
  }

  /**
   * 当会话已持久物化之后丢弃其 pending 条目。
   * @param id - 已到达持久存储的会话。
   */
  materialized(id: SessionId): void {
    this.pending.delete(id)
  }

  /**
   * 跟踪一个打开的句柄以便拆卸；对于写句柄，还把它绑定为该会话的
   * 实时事件路由。
   * @param handle - 刚构造好的句柄。
   * @returns 同一个句柄，便于在构造处链式调用。
   */
  adopt(handle: JsonlSessionHandle): JsonlSessionHandle {
    this.openHandles.add(handle)
    if (handle.access === 'write') this.writers.set(handle.id, handle)
    return handle
  }

  /**
   * 在关闭时释放某个句柄的记账信息。写句柄丢弃其所有权申领；
   * 一个从未物化的创建者不会留下任何东西——该会话从未存在过。
   * @param handle - 正在关闭的句柄。
   * @param materialized - 该会话是否到达了持久存储。
   */
  release(handle: JsonlSessionHandle, materialized: boolean): void {
    this.openHandles.delete(handle)
    if (handle.access !== 'write') return
    this.writers.delete(handle.id)
    if (!materialized) this.pending.delete(handle.id)
  }

  /**
   * 排空并刷新每个活跃的写句柄——即 `SessionPersistence.flush` 背后的
   * 服务级持久性屏障。
   * @throws {AggregateError} 指出每个刷新失败的会话；其余句柄仍会刷新。
   */
  async flushAll(): Promise<void> {
    const errors: unknown[] = []
    for (const writer of [...this.writers.values()]) {
      if (writer === null) continue // 构造中的申领还没有路由任何东西
      try {
        await writer.drainLive()
        await writer.flush()
      } catch (error: unknown) {
        // 在清扫期间被关闭的句柄视为已刷新：close 本身在拒绝这次 flush
        // 之前就已经持久地排空了被路由的缓冲区。
        if (error instanceof SessionHandleClosedError) continue
        errors.push(error)
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, `${this.name} flush failed`)
  }

  /**
   * 安装后端的实时会话路由与拆卸。持久化为每个 id 强制一个活跃写句柄，
   * 因此这些监听器按 id 路由已发布会话的事件；拆卸 effect 会关闭每个
   * 打开的句柄——close 会排空被路由的缓冲区——并聚合失败。本提供方不持有
   * 单独的存储连接，因此关闭句柄就是完整的拆卸。返回的 effect 会在关闭
   * 句柄之前先移除监听器。
   * @param ctx - 后端持有资源的上下文。
   * @returns 在持久化消费方完成卸载之后要运行的 disposer。
   */
  install(ctx: Context): () => Promise<void> {
    const { writers, openHandles, name } = this
    return ctx.effect(function* () {
      yield async () => {
        const errors: unknown[] = []
        for (const handle of [...openHandles]) {
          try {
            await handle.close()
          } catch (error: unknown) {
            errors.push(error)
          }
        }
        if (errors.length > 0) throw new AggregateError(errors, `${name} dispose failed`)
      }
      yield ctx.on('session/event', (session: Session, event) => {
        writers.get(session.id)?.enqueueLive(event, (error) => {
          ctx.logger.warn(`session-persistence: background write for session "${session.id}" failed (buffered events retained): ${String(error)}`)
        })
      })
      yield ctx.on('session/flush', (session: Session) => {
        const writer = writers.get(session.id)
        if (writer === null || writer === undefined) return undefined
        return (async () => {
          await writer.drainLive()
          await writer.flush()
        })()
      })
      yield ctx.on('session/disposed', (session: Session) => {
        const writer = writers.get(session.id)
        if (writer === null || writer === undefined) return
        writer.close().catch((error: unknown) => {
          ctx.logger.warn(`session-persistence: final drain for session "${session.id}" failed: ${String(error)}`)
        })
      })
    }, `${this.name} live routing and open handles`)
  }
}
