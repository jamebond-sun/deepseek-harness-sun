/**
 * 组合式会话历史读取、追踪、过滤与全文搜索的服务定义。
 *
 * @module @deepseek-ai/dsh-session-query
 */

import { currentSessionMessageProjections } from '@deepseek-ai/dsh-session-format-catalog/message-projections'
import { Context, Service } from '@deepseek-ai/cordis'
import {
  Session,
  SessionSeq,
  snapshotSessionEvent,
  type SessionId,
  type SessionSeq as SessionSeqType,
} from '@deepseek-ai/dsh-session'
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title'
import type { SessionTitleSnapshot } from '@deepseek-ai/dsh-session-title'
import type {
  SessionEventResultFilter,
  SessionEventSearchPage,
  SessionEventReadRequest,
  SessionEventRecord,
  SessionEventSearchDocument,
  SessionEventSearchRequest,
  SessionEventTraceObservation,
  SessionEventTraceRequest,
  SessionEventWindow,
  SessionLineageTrace,
  SessionLogSnapshot,
  SessionRecord,
  SessionResultFilter,
  SessionSearchExecContext,
  SessionSearchHit,
  SessionSearchPage,
  SessionSearchRequest,
  SessionSurfaceSnapshot,
  SessionTitleObservation,
  SessionTitleObservationResult,
} from './types.ts'
import {
  SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY,
  SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE,
  SESSION_QUERY_READ_WINDOW_MAX,
  SessionQueryError,
  type Config,
} from './config.ts'
import { SessionCorpus } from './corpus.ts'
import {
  SessionObservationReader,
  type SessionObservation,
  type SessionObservationOptions,
} from './observation.ts'
import { buildSessionEventSearchDocuments } from './documents.ts'
import {
  filterSessionEventDocuments,
  filterSessionResults,
  materializeSessionEventResultFilters,
  materializeSessionResultFilters,
} from './filters.ts'
import * as tracing from './tracing.ts'

export type * from './types.ts'
export { SessionSearchCursor } from './cursor.ts'
export type { Config, SessionQueryErrorCode } from './config.ts'
export {
  SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY,
  SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE,
  SESSION_QUERY_READ_WINDOW_MAX,
  SessionQueryError,
} from './config.ts'
export { readColdSessionLog } from './cold-read.ts'
export type { ColdSessionLog } from './cold-read.ts'
export { extractSessionEventText } from './extraction.ts'
export { buildSessionEventRecords, buildSessionEventSearchDocuments } from './documents.ts'
export {
  compileSessionTextFilter,
  filterSessionEventDocuments,
  filterSessionResults,
  materializeSessionEventResultFilters,
  materializeSessionResultFilters,
} from './filters.ts'
export { assertSessionHeadersCompatible } from './sources.ts'
export type { SessionObservation, SessionObservationOptions } from './observation.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionQuery: SessionQueryEngine
  }
}

/**
 * 统一的 live 优先会话查询服务。
 *
 * 精确读取、过滤与追踪是与后端无关的具体行为。后端在同一个 `ctx.sessionQuery`
 * 服务上实现全文观察、对账、排序、游标代次与查询执行。
 */
export abstract class SessionQueryEngine extends Service {
  static inject = ['sessions']

  private readonly _readWindowMax: number
  private readonly _corpus: SessionCorpus
  private readonly _observations: SessionObservationReader

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'sessionQuery')
    this._readWindowMax = config.readWindowMax ?? SESSION_QUERY_READ_WINDOW_MAX
    if (!Number.isInteger(this._readWindowMax) || this._readWindowMax < 0) {
      throw new SessionQueryError(
        'session-query: readWindowMax must be a non-negative integer',
        'SESSION_QUERY_INVALID_CONFIG',
      )
    }
    const persistedReadConcurrency = config.persistedReadConcurrency
      ?? SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY
    if (!Number.isSafeInteger(persistedReadConcurrency) || persistedReadConcurrency < 1) {
      throw new SessionQueryError(
        'session-query: persistedReadConcurrency must be a positive safe integer',
        'SESSION_QUERY_INVALID_CONFIG',
      )
    }
    const preparedSessionCacheSize = config.preparedSessionCacheSize
      ?? SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE
    if (!Number.isSafeInteger(preparedSessionCacheSize) || preparedSessionCacheSize < 1) {
      throw new SessionQueryError(
        'session-query: preparedSessionCacheSize must be a positive safe integer',
        'SESSION_QUERY_INVALID_CONFIG',
      )
    }
    this._corpus = new SessionCorpus(ctx, persistedReadConcurrency)
    this._observations = new SessionObservationReader(ctx, preparedSessionCacheSize)
  }

  /**
   * 无需持久化列举预检即可观察一个精确的 live 或 prepared Session。
   * @param sessionId - 逻辑 Session 身份。
   * @param options - 本次读取的取消控制与投影选择。
   * @returns 由调用方持有的一份观察租约。
   */
  observeSession(
    sessionId: SessionId,
    options: SessionObservationOptions = {},
  ): Promise<SessionObservation> {
    return this._observations.read(sessionId, options)
  }

  /**
   * 搜索 live 优先的逻辑语料，并按会话分组。
   * @param request - 查询文本、元数据过滤器、页大小与游标。
   * @param exec - 可选的取消控制。
   * @returns 按其最强匹配事件排序的会话命中。
   */
  abstract searchSessions(
    request: SessionSearchRequest,
    exec?: SessionSearchExecContext,
  ): Promise<SessionSearchPage<SessionSearchHit>>

  /**
   * 在一个 live 优先的逻辑会话内搜索事件。
   * @param request - 目标会话、查询文本、过滤器、页大小与游标。
   * @param exec - 可选的取消控制。
   * @returns 来自同一个已索引代次的匹配事件命中及其目标头部。
   */
  abstract searchEvents(
    request: SessionEventSearchRequest,
    exec?: SessionSearchExecContext,
  ): Promise<SessionEventSearchPage>

  /**
   * 用 live 优先的记录列出完整的逻辑语料。
   * @param signal - 持久化列举的可选取消信号。
   * @returns 按确定性的最新优先顺序排列的克隆会话记录。
   */
  listSessions(signal?: AbortSignal): Promise<SessionRecord[]> {
    return this._corpus.listSessions(signal)
  }

  /**
   * 读取并重放校验一份完整的逻辑会话日志，而不使其变为 live。
   * @param sessionId - 要读取的 live 或持久化会话 id。
   * @returns 来自同一次观察的克隆头部与完整原始事件日志。
   * @throws 当持久化、头部兼容性或重放校验失败时抛出。
   */
  async readSession(sessionId: SessionId): Promise<SessionLogSnapshot> {
    const loaded = await this._corpus.load(sessionId)
    Session.create(
      sessionId,
      loaded.events,
      loaded.header,
      loaded.inheritedEventCount,
      currentSessionMessageProjections,
    )
    return {
      session: structuredClone(loaded.header),
      inheritedEventCount: loaded.inheritedEventCount,
      events: loaded.events.map(snapshotSessionEvent),
    }
  }

  /**
   * 用与提供方无关的谓词过滤完整的逻辑语料。
   * @param filters - 按 AND 组合的会话元数据与可用性子句。
   * @param signal - 持久化列举的可选取消信号。
   * @returns 按确定性的最新优先顺序排列的、匹配的克隆记录。
   */
  async filterSessions(
    filters: readonly SessionResultFilter[],
    signal?: AbortSignal,
  ): Promise<SessionRecord[]> {
    const ownedFilters = materializeSessionResultFilters(filters)
    return this._filterSessions(ownedFilters, signal)
  }

  /**
   * 从一个 live 优先的逻辑会话中折叠出最新的、以日志为依据的标题。
   * @param sessionId - 要读取的 live 或持久化会话 id。
   * @param signal - 源解析与标题折叠的可选取消信号。
   * @returns 最新标题快照；日志没有标题事件时为 `undefined`。
   */
  async readTitle(
    sessionId: SessionId,
    signal?: AbortSignal,
  ): Promise<SessionTitleSnapshot | undefined> {
    return (await this.readTitleSnapshot(sessionId, signal)).title
  }

  /**
   * 折叠最新标题，并返回来自同一次语料观察的源头部。
   * @param sessionId - 要读取的 live 或持久化会话 id。
   * @param signal - 源解析与标题折叠的可选取消信号。
   * @returns 克隆的源头部与可选的最新标题快照。
   */
  async readTitleSnapshot(
    sessionId: SessionId,
    signal?: AbortSignal,
  ): Promise<SessionTitleObservation> {
    const result = (await this.readTitleSnapshots([sessionId], signal))[0] as SessionTitleObservationResult
    if (result.status === 'rejected') throw result.reason
    return result.value
  }

  /**
   * 从一次可取消的语料观察中为唯一的会话折叠标题。
   *
   * 结果保持输入中的首次出现顺序。操作性失败按会话隔离，而取消会让整个操作 reject。
   * @param sessionIds - 要观察的 live 或持久化会话 id。
   * @param signal - 由所有源读取共享的可选取消信号。
   * @returns 每个唯一请求的 id 对应一个 fulfilled 或 rejected 的结果。
   */
  async readTitleSnapshots(
    sessionIds: readonly SessionId[],
    signal?: AbortSignal,
  ): Promise<SessionTitleObservationResult[]> {
    return this._corpus.projectMany(sessionIds, (source): SessionTitleObservation => {
      const title = foldSessionTitle(source.events)
      return {
        session: structuredClone(source.header),
        ...title === undefined ? {} : { title },
      }
    }, signal)
  }

  /**
   * 列出一个逻辑会话的轻量原始日志事件记录。
   * @param sessionId - 要读取的 live 优先会话 id。
   * @returns 按 seq 升序排列的事件记录。
   */
  async listEvents(sessionId: SessionId): Promise<SessionEventRecord[]> {
    const loaded = await this._corpus.load(sessionId)
    return tracing.eventRecords(sessionId, loaded.events)
  }

  /**
   * 用与提供方无关的过滤器扫描第一方语义事件文档。
   * @param sessionId - 要扫描的 live 优先会话 id。
   * @param filters - 按 AND 组合的元数据谓词与字面文本谓词。
   * @returns 按 seq 升序排列的匹配语义文档。
   */
  async filterEvents(
    sessionId: SessionId,
    filters: readonly SessionEventResultFilter[],
  ): Promise<SessionEventSearchDocument[]> {
    const ownedFilters = materializeSessionEventResultFilters(filters)
    return this._filterEvents(sessionId, ownedFilters)
  }

  private async _filterSessions(
    filters: readonly SessionResultFilter[],
    signal?: AbortSignal,
  ): Promise<SessionRecord[]> {
    return filterSessionResults(await this._corpus.listSessions(signal), filters)
  }

  private async _filterEvents(
    sessionId: SessionId,
    filters: readonly SessionEventResultFilter[],
  ): Promise<SessionEventSearchDocument[]> {
    const loaded = await this._corpus.load(sessionId)
    const documents = buildSessionEventSearchDocuments(sessionId, loaded.events)
    return filterSessionEventDocuments(documents, filters)
  }

  /**
   * 从一次语料观察中读取一个会话完整的当前模型 surface。
   * @param sessionId - 要读取的 live 优先会话 id。
   * @returns 克隆的头部、当前 surface，以及原始日志捕获中包含的最后一个序号。
   * @throws 当源解析失败或会话 surface 非法时抛出。
   */
  async readSurface(sessionId: SessionId): Promise<SessionSurfaceSnapshot> {
    const loaded = await this._corpus.load(sessionId)
    return {
      session: structuredClone(loaded.header),
      inheritedEventCount: loaded.inheritedEventCount,
      capturedThroughSeq: loaded.events.at(-1)?.seq ?? null,
      events: tracing.currentSurfaceEvents(sessionId, loaded.events),
    }
  }

  /**
   * 从一次语料观察中追踪已知的祖先与后代。
   * @param sessionId - 要追踪的逻辑会话 id。
   * @param signal - 持久化列举的可选取消信号。
   * @returns 完整的谱系，或第一个无法解析的父会话。
   * @throws 当语料解析失败、目标缺失，或其已知祖先链成环时抛出。
   */
  async traceSession(sessionId: SessionId, signal?: AbortSignal): Promise<SessionLineageTrace> {
    const records = await this._corpus.listSessions(signal)
    signal?.throwIfAborted()
    return tracing.traceSession(records, sessionId)
  }

  /**
   * 追踪一个事件直接的按位置替换关系与被引用源事件。
   * @param request - 目标会话 id 与事件 seq。
   * @param signal - 持久化源解析的可选取消信号。
   * @returns 源头部、直接关联，以及目标的按位置替换链。
   * @throws 当源解析失败、目标缺失，或 surface/源事件校验失败时抛出。
   */
  async traceEvent(request: SessionEventTraceRequest, signal?: AbortSignal): Promise<SessionEventTraceObservation> {
    const loaded = await this._corpus.load(request.sessionId, signal)
    signal?.throwIfAborted()
    return {
      session: loaded.header,
      ...tracing.traceEvent(request.sessionId, loaded.events, request.seq),
    }
  }

  /**
   * 读取一个完整事件以及一个有界的原始日志上下文窗口。
   * @param request - 目标会话/seq 与上下文长度。
   * @param signal - 持久化源解析的可选取消信号。
   * @returns 克隆的目标事件与相邻事件。
   */
  async readEvent(request: SessionEventReadRequest, signal?: AbortSignal): Promise<SessionEventWindow> {
    const before = this._readWindow('before', request.before)
    const after = this._readWindow('after', request.after)
    const sessionId = request.sessionId
    const seq = request.seq
    return this._readEvent(sessionId, seq, before, after, signal)
  }

  private async _readEvent(
    sessionId: SessionId,
    seq: SessionSeqType,
    before: number,
    after: number,
    signal?: AbortSignal,
  ): Promise<SessionEventWindow> {
    const loaded = await this._corpus.load(sessionId, signal)
    signal?.throwIfAborted()
    const target = loaded.events[seq]
    if (target === undefined || target.seq !== seq) {
      throw new SessionQueryError(
        `session "${sessionId}" has no event at seq ${seq}`,
        'SESSION_QUERY_EVENT_NOT_FOUND',
      )
    }
    const startSeq = SessionSeq(Math.max(0, seq - before))
    const endSeq = SessionSeq(Math.min(loaded.events.length - 1, seq + after))
    const targetSnapshot = snapshotSessionEvent(target)
    const events = loaded.events.slice(startSeq, endSeq + 1)
      .map(event => event === target
        ? targetSnapshot
        : snapshotSessionEvent(event))
    return {
      session: structuredClone(loaded.header),
      inheritedEventCount: loaded.inheritedEventCount,
      target: targetSnapshot,
      events,
      startSeq,
      endSeq,
    }
  }

  private _readWindow(name: 'before' | 'after', value: number | undefined): number {
    if (value === undefined) return 0
    if (!Number.isInteger(value) || value < 0 || value > this._readWindowMax) {
      throw new SessionQueryError(
        `${name} must be an integer between 0 and ${this._readWindowMax}`,
        'SESSION_QUERY_INVALID_WINDOW',
      )
    }
    return value
  }
}

export default SessionQueryEngine
