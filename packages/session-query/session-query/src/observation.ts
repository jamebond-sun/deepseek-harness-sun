/** 面向 Session 页面与生命周期消费方的共享 live/prepared 观察。 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader, SessionId , SessionLogOffset as SessionLogOffsetType , SessionSeqCursor } from '@deepseek-ai/dsh-session'
import type SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import type {
  SessionPersistenceRevision,
  SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import { SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE, SessionQueryError } from './config.ts'
import { readColdSessionLog, type ColdSessionLog } from './cold-read.ts'

/** 在调用方的读取生命周期内保留的一份精确、不可变的 Session 切片。 */
export interface SessionObservation extends Disposable {
  /** 该切片来自已挂载的 Session，还是来自被保留的 prepared 结果。 */
  readonly source: 'live' | 'prepared'
  /** 不可变的 Session 身份元数据。 */
  readonly header: SessionHeader
  /** 与 {@link header} 配对、精确的 fork 继承事件数。 */
  readonly inheritedEventCount: SessionLogOffsetType
  /**
   * {@link cursor} 处不可变的连续事件。live 观察在首次读取时才物化该数组，
   * 因此只读取头部、游标或投影的消费方永远不会复制日志。
   */
  readonly events: readonly SessionEvent[]
  /** 最后观察到的事件 seq；空日志为 -1。 */
  readonly cursor: SessionSeqCursor
  /** 冷 prepared 观察对应的持久源修订版本。 */
  readonly revision?: SessionPersistenceRevision
  /** 注册表已挂载时，{@link cursor} 处精确的投影基线。 */
  readonly projections?: ProjectionSnapshot
  /**
   * 为另一个 Host 属主保留同一份不可变切片。
   * @returns 覆盖该观察、可独立释放的一份租约。
   */
  retain(): SessionObservation
}

/** 一次精确观察所请求的投影工作与取消控制。 */
export interface SessionObservationOptions {
  /** 解析冷源期间的可选取消信号。 */
  readonly signal?: AbortSignal
  /** 计算全部投影，还是完全不触碰投影状态。 */
  readonly projectionMode?: 'all' | 'none'
}

/**
 * 一份可复用的冷观察：一个未发布的、已恢复的 Session，加上它所代表的精确平衡日志；
 * 只要生成它的持久化实例仍报告相同的修订版本，它就有效。
 */
interface PreparedEntry {
  /** 产出该修订版本的稳定服务身份，其 `stat` 调用；代理引用不是实例身份。 */
  readonly persistenceIdentity: symbol
  /** 在读取日志之前由 `stat` 立刻观察到的持久修订版本。 */
  readonly revision: SessionPersistenceRevision
  /** 由平衡日志恢复出的、未发布的 Session；从不进入存储。 */
  readonly session: Session
  /** 不可变的平衡日志（已存储事件加上内存中的中断回合闭合事件）。 */
  readonly events: readonly SessionEvent[]
  /** 活动的观察租约；被固定的条目（`refs > 0`）永不被驱逐。 */
  refs: number
}

/**
 * 无需语料列举预检即可构建点观察。
 *
 * 冷读取按会话 id 缓存，键为持久化实例以及在读取日志之前观察到的 `stat` 修订版本：
 * 修订版本未变时复用已恢复的 Session，不再重读日志。缓存是有界的（超出容量时
 * 淘汰最近最少使用的未固定条目），而被活动租约固定的条目可以免于淘汰与替换——
 * 即使之后落下了更新的修订版本，租约持有的切片在租约生命周期内依然有效。
 */
export class SessionObservationReader {
  private readonly cache = new Map<SessionId, PreparedEntry>()

  /**
   * @param ctx - 承载 Session 以及可选持久化/投影服务的上下文。
   * @param cacheCapacity - 保留以供复用的未固定冷观察的最大数量。
   */
  constructor(
    private readonly ctx: Context,
    private readonly cacheCapacity: number = SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE,
  ) {}

  /**
   * 观察一个 live 优先的 Session，并在释放之前保留一份冷 prepared 结果。
   * @param sessionId - 逻辑 Session 身份。
   * @param options - 本次读取的取消控制与全量/全不投影计算选择。
   * @returns 一份精确的不可变观察。
   * @throws 当 live 或 prepared 的投影计算失败时，抛出 code 为 `SESSION_QUERY_CORRUPT_SESSION` 的 {@link SessionQueryError}。
   */
  async read(
    sessionId: SessionId,
    options: SessionObservationOptions = {},
  ): Promise<SessionObservation> {
    const { signal, projectionMode = 'all' } = options
    for (;;) {
      throwIfObservationAborted(signal)
      const live = this.ctx.sessions.get(sessionId)
      if (live !== undefined) return this.live(live, projectionMode)
      const persistence = this.ctx.get('sessionPersistence')
      if (persistence === undefined) throw notFound(sessionId)

      const snapshot = await this.statSource(persistence, sessionId, signal)
      const attachedDuringStat = this.ctx.sessions.get(sessionId)
      if (attachedDuringStat !== undefined) return this.live(attachedDuringStat, projectionMode)
      let entry = this.cachedEntry(persistence.identity, sessionId, snapshot.revision)
      if (entry === undefined) {
        const loaded = await this.loadSource(persistence, sessionId, signal)
        throwIfObservationAborted(signal)
        const attached = this.ctx.sessions.get(sessionId)
        if (attached !== undefined) return this.live(attached, projectionMode)
        // 句柄把持久化事件标记为可领养；合成的闭合事件由本次读取持有，
        // 因此合并后的种子无需复制。
        const seed = loaded.events
        let session: Session
        try {
          session = this.ctx.sessions.prepare(sessionId, {
            seed,
            meta: structuredClone(loaded.header),
            inheritedEventCount: loaded.inheritedEventCount,
            eventState: loaded.eventState,
          })
        } catch (error: unknown) {
          // 存储会拒绝已被 live 属主占用的 id：该属主是更新的源，因此重试 live 路径。
          // 其他任何拒绝都意味着已存储日志未能通过恢复校验。
          if (this.ctx.sessions.get(sessionId) !== undefined) continue
          throw new SessionQueryError(
            `stored session "${sessionId}" is corrupt: ${errorMessage(error)}`,
            'SESSION_QUERY_CORRUPT_SESSION',
            { cause: error },
          )
        }
        entry = {
          persistenceIdentity: persistence.identity,
          revision: snapshot.revision,
          session,
          events: Object.freeze(seed),
          refs: 0,
        }
        this.store(sessionId, entry)
      }

      let projections: ProjectionSnapshot | undefined
      try {
        projections = projectionMode === 'none' ? undefined : this.preparedProjections(entry)
      } catch (error: unknown) {
        throw new SessionQueryError(
          `failed to project session "${sessionId}": ${errorMessage(error)}`,
          'SESSION_QUERY_CORRUPT_SESSION',
          { cause: error },
        )
      }
      return this.preparedLease(sessionId, entry, projections)
    }
  }

  /** 观察已存储的快照，把缺失与后端失败映射到查询错误分类。 */
  private async statSource(
    persistence: SessionPersistence,
    sessionId: SessionId,
    signal: AbortSignal | undefined,
  ): Promise<SessionPersistenceSnapshot> {
    let snapshot: SessionPersistenceSnapshot | undefined
    try {
      snapshot = await persistence.stat(sessionId, signal === undefined ? undefined : { signal })
    } catch (error: unknown) {
      throwIfObservationAborted(signal)
      throw mapPersistenceFailure(sessionId, error)
    }
    throwIfObservationAborted(signal)
    if (snapshot === undefined) throw notFound(sessionId)
    if (snapshot.header.id !== sessionId) {
      throw new SessionQueryError(
        `session persistence returned "${snapshot.header.id}" for "${sessionId}"`,
        'SESSION_QUERY_SOURCE_CONFLICT',
      )
    }
    return snapshot
  }

  /** 读取完整的平衡冷日志，把后端失败映射到查询错误分类。 */
  private async loadSource(
    persistence: SessionPersistence,
    sessionId: SessionId,
    signal: AbortSignal | undefined,
  ): Promise<ColdSessionLog> {
    try {
      return await readColdSessionLog(persistence, sessionId, signal)
    } catch (error: unknown) {
      throwIfObservationAborted(signal)
      throw mapPersistenceFailure(sessionId, error)
    }
  }

  /** 返回仍然有效的缓存条目，并把它标记为最近使用。 */
  private cachedEntry(
    persistenceIdentity: symbol,
    sessionId: SessionId,
    revision: SessionPersistenceRevision,
  ): PreparedEntry | undefined {
    const cached = this.cache.get(sessionId)
    if (cached === undefined || cached.persistenceIdentity !== persistenceIdentity || cached.revision !== revision) {
      return undefined
    }
    this.cache.delete(sessionId)
    this.cache.set(sessionId, cached)
    return cached
  }

  /** 插入或替换某个 id 的条目，再淘汰超出容量的部分。 */
  private store(sessionId: SessionId, entry: PreparedEntry): void {
    // 替换过期修订版本只会丢弃 map 的引用；活动租约通过自身引用让旧条目继续存活。
    this.cache.delete(sessionId)
    this.cache.set(sessionId, entry)
    this.evictPastCapacity(entry)
  }

  /**
   * 淘汰最旧的未固定条目，直到缓存重新符合容量要求。
   * 在 store 时运行，也在租约释放解除条目固定时运行，这样把每个候选都固定住的租约
   * 不会让缓存长期超出预算。
   * @param keep - 正在存储、即将被租用的条目；永不被淘汰。
   */
  private evictPastCapacity(keep?: PreparedEntry): void {
    if (this.cache.size <= this.cacheCapacity) return
    for (const [id, candidate] of this.cache) {
      if (candidate === keep || candidate.refs > 0) continue
      this.cache.delete(id)
      if (this.cache.size <= this.cacheCapacity) return
    }
  }

  /** 在缓存条目上构建一份可释放的租约，固定该条目直到每份租约都被释放。 */
  private preparedLease(
    sessionId: SessionId,
    entry: PreparedEntry,
    projections: ProjectionSnapshot | undefined,
  ): SessionObservation {
    entry.refs += 1
    const lease = (): SessionObservation => {
      let disposed = false
      return {
        source: 'prepared',
        header: entry.session.header,
        inheritedEventCount: entry.session.inheritedEventCount,
        events: entry.events,
        cursor: entry.events.at(-1)?.seq ?? -1,
        revision: entry.revision,
        ...projections === undefined ? {} : { projections },
        retain: () => {
          if (disposed) throw new Error(`session observation "${sessionId}" is disposed`)
          entry.refs += 1
          return lease()
        },
        [Symbol.dispose]: () => {
          if (disposed) return
          disposed = true
          entry.refs -= 1
          if (entry.refs === 0) this.evictPastCapacity()
        },
      }
    }
    return lease()
  }

  private live(
    session: Session,
    projectionMode: NonNullable<SessionObservationOptions['projectionMode']>,
  ): SessionObservation {
    // 切片就是此刻的日志长度。日志只会追加，因此无论消费方何时首次读取 `events`，
    // `seq` 以下的前缀都是同一个数组。
    const seq = session.seq
    let materialized: readonly SessionEvent[] | undefined
    let projections: ProjectionSnapshot | undefined
    try {
      projections = projectionMode === 'none'
        ? undefined
        : this.ctx.get('sessionProjections')?.snapshot(session)
    } catch (error: unknown) {
      throw new SessionQueryError(
        `failed to project session "${session.id}": ${errorMessage(error)}`,
        'SESSION_QUERY_CORRUPT_SESSION',
        { cause: error },
      )
    }
    const lease = (): SessionObservation => {
      let disposed = false
      return {
        source: 'live',
        header: session.header,
        inheritedEventCount: session.inheritedEventCount,
        get events() {
          // oxlint-disable-next-line typescript/no-deprecated -- 既有的 Session 历史读取；迁移延后。
          materialized ??= session.snapshotEvents(SessionLogOffset(0), seq)
          return materialized
        },
        cursor: seq === 0 ? -1 : SessionSeq(seq - 1),
        ...projections === undefined ? {} : { projections },
        retain: () => {
          if (disposed) throw new Error(`session observation "${session.id}" is disposed`)
          return lease()
        },
        [Symbol.dispose]: () => { disposed = true },
      }
    }
    return lease()
  }

  private preparedProjections(entry: PreparedEntry): ProjectionSnapshot | undefined {
    const registry = this.ctx.get('sessionProjections')
    if (registry === undefined) return undefined
    const cache = this.ctx.get('sessionProjectionCache')
    return cache === undefined
      ? registry.hydrate(entry.session, {}, entry.events, SessionLogOffset(0))
      : cache.hydratePrepared(entry.session, entry.events)
  }
}

function throwIfObservationAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return
  throw new SessionQueryError(
    'session observation was aborted',
    'SESSION_QUERY_ABORTED',
    { cause: signal.reason },
  )
}

function mapPersistenceFailure(sessionId: SessionId, error: unknown): SessionQueryError {
  if (hasErrorName(error, 'SessionPersistenceNotFoundError')) return notFound(sessionId, error)
  if (hasErrorName(error, 'SessionPersistenceCorruptionError')) {
    return new SessionQueryError(
      `stored session "${sessionId}" is corrupt: ${error.message}`,
      'SESSION_QUERY_CORRUPT_SESSION',
      { cause: error },
    )
  }
  return new SessionQueryError(
    `failed to observe session "${sessionId}": ${errorMessage(error)}`,
    'SESSION_QUERY_PERSISTENCE_FAILED',
    { cause: error },
  )
}

function notFound(sessionId: SessionId, cause?: unknown): SessionQueryError {
  return new SessionQueryError(
    `session "${sessionId}" not found`,
    'SESSION_QUERY_SESSION_NOT_FOUND',
    cause === undefined ? undefined : { cause },
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}

function hasErrorName(error: unknown, name: string): error is Error {
  return error instanceof Error && error.name === name
}
