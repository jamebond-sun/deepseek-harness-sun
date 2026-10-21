/** 面向 session-query 的 live/persisted 逻辑语料解析。 */

import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { Session, SessionEvent, SessionHeader, SessionId , SessionLogOffset } from '@deepseek-ai/dsh-session'
import type SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import type { SessionRecord } from './types.ts'
import { SessionQueryError } from './config.ts'
import { readColdSessionLog, type ColdSessionLog } from './cold-read.ts'
import { assertSessionHeadersCompatible } from './sources.ts'

/** 为一次精确读取选出的分离源。 */
export interface LogicalSession {
  /** 克隆的源头部。 */
  header: SessionHeader
  /** 与 {@link header} 配对、精确的 fork 继承事件数。 */
  inheritedEventCount: SessionLogOffset
  /** 克隆的原始事件日志。 */
  events: SessionEvent[]
}

/** 仅在一次同步批量投影期间可见的借用源。 */
export interface LogicalSessionSource {
  /** 与 `events` 一同选出的头部；调用方必须克隆所保留的输出。 */
  readonly header: SessionHeader
  /** 与 `header` 一同选出的原始事件；仅在该投影调用期间有效。 */
  readonly events: readonly SessionEvent[]
}

/** 一次批量逻辑语料观察中的一个源投影结果。 */
export type LogicalProjectionResult<Value> =
  | { sessionId: SessionId; status: 'fulfilled'; value: Value }
  | { sessionId: SessionId; status: 'rejected'; reason: unknown }

/** 针对当前挂载的持久化服务解析出一份 live 优先的语料。 */
export class SessionCorpus {
  private _persistence: SessionPersistence | undefined
  private readonly _optionalPersistenceFiber: Fiber

  constructor(
    private readonly _ctx: Context,
    private readonly _persistedReadConcurrency: number,
  ) {
    this._optionalPersistenceFiber = _ctx.inject(['sessionPersistence'], (childCtx: Context) => {
      const service = childCtx.sessionPersistence
      this._persistence = service
      childCtx.effect(() => () => {
        /* v8 ignore next -- 过期的可选服务 disposer 无法清除替换后的实例 */
        if (this._persistence === service) this._persistence = undefined
      }, 'sessionQuery.persistenceBinding')
    })
    _ctx.effect(() => {
      return () => this._optionalPersistenceFiber.dispose()
    }, 'sessionQuery.optionalPersistence')
  }

  /**
   * 以 live 优先和克隆头部列出完整的逻辑语料。
   * @param signal - 持久化列举的可选取消信号。
   * @returns 按确定性的最新优先顺序排列的记录。
   */
  async listSessions(signal?: AbortSignal): Promise<SessionRecord[]> {
    signal?.throwIfAborted()
    const persistence = this._persistence
    const persisted = persistence === undefined ? [] : await listPersisted(persistence, signal)
    signal?.throwIfAborted()
    const records = new Map<SessionId, SessionRecord>()
    for (const { header, formatStatus } of persisted) {
      records.set(header.id, {
        header: structuredClone(header),
        live: false,
        persisted: true,
        ...(formatStatus === undefined ? {} : { formatStatus }),
      })
    }
    for (const session of this._ctx.sessions.list()) {
      const durable = records.get(session.id)
      if (durable !== undefined) assertSessionHeadersCompatible(session.header, durable.header)
      records.set(session.id, {
        header: structuredClone(session.header),
        live: true,
        persisted: durable !== undefined,
        formatStatus: 'current',
      })
    }
    return [...records.values()].sort(compareSessions)
  }

  /**
   * 加载一个逻辑源，优先使用分离的 live 快照。
   *
   * 已知的 live 目标从不查询持久化，因此可选后端的失败无法让当前的内存历史变得不可读。
   * @param sessionId - 要解析的会话。
   * @param signal - 持久化源解析的可选取消信号。
   * @returns 分离的、live 优先的头部与事件。
   */
  async load(sessionId: SessionId, signal?: AbortSignal): Promise<LogicalSession> {
    signal?.throwIfAborted()
    const live = this._ctx.sessions.get(sessionId)
    if (live !== undefined) {
      const snapshot = snapshotLive(live)
      signal?.throwIfAborted()
      return snapshot
    }
    const persistence = this._persistence
    if (persistence === undefined) throw notFound(sessionId)
    const listed = (await listPersisted(persistence, signal)).find(snapshot => snapshot.header.id === sessionId)
    signal?.throwIfAborted()
    if (listed === undefined) throw notFound(sessionId)
    const loaded = await inspectPersisted(persistence, sessionId, signal)
    signal?.throwIfAborted()
    const attached = this._ctx.sessions.get(sessionId)
    if (attached !== undefined) {
      const snapshot = snapshotLive(attached)
      signal?.throwIfAborted()
      return snapshot
    }
    assertSessionHeadersCompatible(loaded.header, listed.header)
    const snapshot = {
      header: structuredClone(loaded.header),
      inheritedEventCount: loaded.inheritedEventCount,
      events: loaded.events.map(event => structuredClone(event)),
    }
    signal?.throwIfAborted()
    return snapshot
  }

  /**
   * 由一次持久化列举立即投影出唯一的逻辑源。
   *
   * 同步投影器在持久化的 worker 认领下一个 id 之前运行；完整日志只在该次调用期间被借用，
   * 批次绝不保留它们。
   * @param sessionIds - 按首次出现顺序解析的会话。
   * @param project - 同步折叠，持有/克隆每一个被保留的值。
   * @param signal - 由列举与每次持久化检查共享的取消信号。
   * @returns 每个唯一请求的 id 对应一个 fulfilled 或 rejected 的投影结果。
   */
  async projectMany<Value>(
    sessionIds: readonly SessionId[],
    project: (source: LogicalSessionSource) => Value,
    signal?: AbortSignal,
  ): Promise<LogicalProjectionResult<Value>[]> {
    const ids = [...new Set(sessionIds)]
    signal?.throwIfAborted()
    const resolved = new Map<SessionId, LogicalProjectionResult<Value>>()
    const unresolved: SessionId[] = []
    for (const id of ids) {
      const session = this._ctx.sessions.get(id)
      if (session === undefined) {
        unresolved.push(id)
      } else {
        resolved.set(id, projectSource(id, sourceLive(session), project, signal))
      }
    }
    if (unresolved.length === 0) return orderedResults(ids, resolved)

    const persistence = this._persistence
    if (persistence === undefined) {
      for (const sessionId of unresolved) {
        resolved.set(sessionId, { sessionId, status: 'rejected', reason: notFound(sessionId) })
      }
      return orderedResults(ids, resolved)
    }

    let persisted: readonly SessionPersistenceSnapshot[]
    try {
      persisted = await listPersisted(persistence, signal)
      signal?.throwIfAborted()
    } catch (error: unknown) {
      if (signal?.aborted) signal.throwIfAborted()
      for (const sessionId of unresolved) {
        resolved.set(sessionId, { sessionId, status: 'rejected', reason: error })
      }
      return orderedResults(ids, resolved)
    }
    const persistedById = new Map(persisted.map(({ header }) => [header.id, header]))
    const resolvePersisted = async (sessionId: SessionId): Promise<void> => {
      const listed = persistedById.get(sessionId)
      if (listed === undefined) {
        const attached = this._ctx.sessions.get(sessionId)
        resolved.set(sessionId, attached === undefined
          ? { sessionId, status: 'rejected', reason: notFound(sessionId) }
          : projectSource(sessionId, sourceLive(attached), project, signal))
        return
      }
      try {
        signal?.throwIfAborted()
        const loaded = await inspectPersisted(persistence, sessionId, signal)
        signal?.throwIfAborted()
        const attached = this._ctx.sessions.get(sessionId)
        if (attached !== undefined) {
          resolved.set(sessionId, projectSource(sessionId, sourceLive(attached), project, signal))
          return
        }
        assertSessionHeadersCompatible(loaded.header, listed)
        resolved.set(sessionId, projectSource(sessionId, {
          header: loaded.header,
          events: loaded.events,
        }, project, signal))
      } catch (error: unknown) {
        if (signal?.aborted) signal.throwIfAborted()
        resolved.set(sessionId, { sessionId, status: 'rejected', reason: error })
      }
    }
    let cursor = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        signal?.throwIfAborted()
        const index = cursor
        if (index >= unresolved.length) return
        cursor += 1
        await resolvePersisted(unresolved[index] as SessionId)
      }
    }
    const workerCount = Math.min(this._persistedReadConcurrency, unresolved.length)
    const settlements = await Promise.allSettled(
      Array.from({ length: workerCount }, () => worker()),
    )
    if (signal?.aborted) signal.throwIfAborted()
    /* v8 ignore start -- 每个 id 的失败都在 resolvePersisted 内结算；worker 仅在上述 abort 情形才 reject */
    for (const settlement of settlements) {
      if (settlement.status === 'rejected') {
        const reason: unknown = settlement.reason
        throw reason
      }
    }
    /* v8 ignore stop */
    signal?.throwIfAborted()
    return orderedResults(ids, resolved)
  }
}

function projectSource<Value>(
  sessionId: SessionId,
  source: LogicalSessionSource,
  project: (source: LogicalSessionSource) => Value,
  signal?: AbortSignal,
): LogicalProjectionResult<Value> {
  try {
    signal?.throwIfAborted()
    const value = project(source)
    signal?.throwIfAborted()
    return { sessionId, status: 'fulfilled', value }
  } catch (reason: unknown) {
    /* v8 ignore next -- 同步投影器没有可供外部取消的让出点 */
    if (signal?.aborted) signal.throwIfAborted()
    return { sessionId, status: 'rejected', reason }
  }
}

function sourceLive(session: Session): LogicalSessionSource {
  // oxlint-disable-next-line typescript/no-deprecated -- 既有的 Session 历史读取；迁移延后。
  return { header: session.header, events: session.snapshotEvents() }
}

function orderedResults<Value>(
  ids: readonly SessionId[],
  resolved: ReadonlyMap<SessionId, LogicalProjectionResult<Value>>,
): LogicalProjectionResult<Value>[] {
  return ids.map(sessionId => resolved.get(sessionId) as LogicalProjectionResult<Value>)
}

async function listPersisted(
  persistence: SessionPersistence,
  signal?: AbortSignal,
): Promise<readonly SessionPersistenceSnapshot[]> {
  try {
    return await persistence.list(signal === undefined ? undefined : { signal })
  } catch (error: unknown) {
    if (signal?.aborted) signal.throwIfAborted()
    throw new SessionQueryError(
      `session persistence listing failed: ${errorMessage(error)}`,
      'SESSION_QUERY_PERSISTENCE_FAILED',
      { cause: error },
    )
  }
}

async function inspectPersisted(
  persistence: SessionPersistence,
  sessionId: SessionId,
  signal?: AbortSignal,
): Promise<ColdSessionLog> {
  try {
    return await readColdSessionLog(persistence, sessionId, signal)
  } catch (error: unknown) {
    if (signal?.aborted) signal.throwIfAborted()
    if (error instanceof Error && error.name === 'SessionPersistenceCorruptionError') {
      throw new SessionQueryError(
        `stored session "${sessionId}" is corrupt: ${errorMessage(error)}`,
        'SESSION_QUERY_CORRUPT_SESSION',
        { cause: error },
      )
    }
    throw new SessionQueryError(
      `failed to read stored session "${sessionId}": ${errorMessage(error)}`,
      'SESSION_QUERY_PERSISTENCE_FAILED',
      { cause: error },
    )
  }
}

function snapshotLive(session: Session): LogicalSession {
  return {
    header: structuredClone(session.header),
    inheritedEventCount: session.inheritedEventCount,
    // oxlint-disable-next-line typescript/no-deprecated -- 既有的 Session 历史读取；迁移延后。
    events: session.snapshotEvents().map(event => structuredClone(event)),
  }
}

function compareSessions(a: SessionRecord, b: SessionRecord): number {
  return b.header.createdAt - a.header.createdAt || a.header.id.localeCompare(b.header.id)
}

function notFound(sessionId: SessionId): SessionQueryError {
  return new SessionQueryError(`session "${sessionId}" not found`, 'SESSION_QUERY_SESSION_NOT_FOUND')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}
