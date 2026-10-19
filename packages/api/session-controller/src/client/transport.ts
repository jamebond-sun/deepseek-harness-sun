/** 针对 Gateway 持有的 Remote 流生命周期的 Session 专用适配器。 */

import type {} from '@deepseek-ai/dsh-api-session-controller/remote'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import {
  RemoteJournalStream,
  RemoteSnapshotStream,
  RemoteStreamCarrierError,
  type ClientRemote,
  type RemoteJournalChange,
  type RemoteJournalFrame,
} from '@deepseek-ai/dsh-api-gateway/client'
import type {
  SessionAddress,
  SessionAssistantStreamBaseline,
  SessionAssistantStreamFrame,
  SessionControlFrame,
  SessionHistoryRecord,
  SessionPage,
  SessionPageRequest,
  SessionProjectionBaseline,
} from '../types.ts'
import {
  historyEntries,
  historyRecordFirstSeq,
  historyRecordLastSeq,
} from './sessions/history-records.ts'
import type { SessionEventLikeEntry, SessionLiveEventEntry } from './contract/events.ts'
import type { SessionRemotes } from './sessions/remotes.ts'
import { assertSessionWireEvent } from './session-wire-event.ts'

export {
  SESSION_SEARCH_RESULT_LIMIT,
  SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS,
} from '../types.ts'

/** 绑定到一个已寻址 Session 日志的分页字段。 */
export type ClientSessionPageRequest = Omit<SessionPageRequest, 'address' | 'throughSeq'>

/** 完整的生成 `ctx.remote.session` 命名空间。 */
export type SessionRemote = ClientRemote['session']

/** 仅由跟随快照携带、绝不由 loadOlder 页携带的打开元数据。 */
interface SessionJournalPage extends SessionPage {
  readonly projections?: SessionProjectionBaseline
  readonly assistantStream?: SessionAssistantStreamBaseline
}

/** Session 日志流的一次完整发布。 */
export type SessionJournalChange =
  | {
    readonly type: 'replace' | 'prepend'
    readonly page: SessionJournalPage
    readonly entries: readonly SessionEventLikeEntry[]
    readonly hasMore: boolean
  }
  | { readonly type: 'append'; readonly entry: SessionLiveEventEntry }
  | { readonly type: 'assistant-stream'; readonly frame: SessionAssistantStreamFrame }

function toSessionJournalChange(
  change: RemoteJournalChange<
    SessionJournalPage, SessionHistoryRecord, SessionAssistantStreamFrame
  >,
): SessionJournalChange {
  switch (change.type) {
    case 'replace':
    case 'prepend':
      return { ...change, entries: historyEntries(change.entries) }
    case 'append': {
      return {
        type: 'append',
        entry: change.entry as unknown as SessionLiveEventEntry,
      }
    }
    case 'notification':
      return { type: 'assistant-stream', frame: change.notification }
  }
}

type SessionControlBaselineFrame = Extract<SessionControlFrame, { type: 'baseline' }>
type SessionControlDeltaFrame = Exclude<SessionControlFrame, SessionControlBaselineFrame>

/** 为 Session 帧配置的 Gateway 持有控制快照流。 */
export type SessionControlStream = RemoteSnapshotStream<
  SessionControlBaselineFrame,
  SessionControlDeltaFrame
>

/** 全局 Session 控制流使用的领域槽。 */
export interface SessionControlStreamOptions {
  /** 应用完整基线或一个稍后的更新。 */
  readonly accept: (frame: SessionControlFrame) => void
  /** 在重连之前观察一次可重试的载体丢失。 */
  readonly carrierFailed?: (error: RemoteStreamCarrierError) => void
  /** 发布一次终结性的业务或协议失败。 */
  readonly failed: (error: unknown) => void
}

/** 一个已寻址 Session 事件日志使用的领域槽。 */
export interface SessionEventStreamOptions {
  /** 应用一次完整的事件窗口变更。 */
  readonly publish: (change: SessionJournalChange) => void
  /** 在重连之前观察一次可重试的载体丢失。 */
  readonly carrierFailed?: (error: RemoteStreamCarrierError) => void
  /** 在打开之后发布一次终结性的流、页或协议失败。 */
  readonly failed: (error: unknown) => void
}

/**
 * 创建全局 Session 控制快照流。
 * @param remote - 生成的 Session 命名空间与 Gateway 流工厂。
 * @param options - Session 状态目的地。
 * @returns 一个未启动的、由 Client Session 运行时拥有的流。
 */
export function createSessionControlStream(
  remote: SessionRemotes,
  options: SessionControlStreamOptions,
): SessionControlStream {
  const stream = remote.$stream<SessionControlFrame>({
    name: 'session control stream',
    open: signal => remote.session.control(signal),
    ended: accepted => accepted
      ? new RemoteStreamCarrierError('session control stream ended without a terminal result')
      : new Error('session control stream ended before its opening snapshot'),
    ...(options.carrierFailed === undefined ? {} : { carrierFailed: options.carrierFailed }),
  })
  return new RemoteSnapshotStream(stream, {
    name: 'session control stream',
    isSnapshot: (frame): frame is SessionControlBaselineFrame => frame.type === 'baseline',
    replace: options.accept,
    update: options.accept,
    failed: options.failed,
  })
}

/** 绑定到一个普通或直接子级 subagent Session 地址的 Gateway 持有事件日志。 */
export class SessionEventStream extends RemoteJournalStream<
  SessionJournalPage,
  SessionHistoryRecord,
  number,
  ClientSessionPageRequest,
  SessionAssistantStreamFrame
> {
  /**
   * @param remote - 生成的 Session 命名空间与 Gateway 流工厂。
   * @param address - 持久化的普通 Session 或直接子级 subagent 地址。
   * @param options - Session 事件窗口目的地。
   */
  constructor(
    private readonly remote: SessionRemotes,
    private readonly address: SessionAddress,
    options: SessionEventStreamOptions,
  ) {
    super(remote, {
      name: 'session event stream',
      emptyCursor: -1,
      entries: page => page.records,
      hasMore: page => page.hasMore,
      first: historyRecordFirstSeq,
      last: historyRecordLastSeq,
      compare: (left, right) => left - right,
      follows: (left, right) => right === left + 1,
      publish: (change) => { options.publish(toSessionJournalChange(change)) },
      ...(options.carrierFailed === undefined
        ? {}
        : { carrierFailed: options.carrierFailed }),
      failed: options.failed,
    })
  }

  /** @inheritdoc */
  protected override async * follow(
    request: ClientSessionPageRequest,
    signal: AbortSignal,
  ): AsyncIterable<RemoteJournalFrame<
    SessionHistoryRecord, number, SessionJournalPage, SessionAssistantStreamFrame
  >> {
    let assistantRevision: number | undefined
    for await (const frame of this.remote.session.follow({
      address: this.address,
      assistantStream: true,
      ...this.repairRequest(request),
    }, signal)) {
      if (frame.type === 'snapshot') {
        for (const record of frame.records) assertSessionWireEvent(record.event)
        if (frame.assistantStream === undefined) {
          throw new RemoteError(
            'gateway/internal',
            'session assistant stream omitted its opted-in opening baseline',
            {},
          )
        }
        assistantRevision = frame.assistantStream.revision
        yield {
          type: 'opened',
          cursor: frame.cursor,
          page: {
            records: frame.records,
            hasMore: frame.hasMore,
            projections: frame.projections,
            assistantStream: frame.assistantStream,
          },
        }
        continue
      }
      if (frame.type === 'assistant-stream') {
        const expected = (assistantRevision ?? 0) + 1
        if (frame.frame.revision !== expected) {
          throw new RemoteStreamCarrierError(
            `session assistant stream skipped revision ${String(expected)}`,
          )
        }
        assistantRevision = frame.frame.revision
        yield { type: 'notification', notification: frame.frame }
        continue
      }
      assertSessionWireEvent(frame.event)
      yield { type: 'entry', entry: frame }
    }
  }

  /** @inheritdoc */
  protected override async readPage(
    request: ClientSessionPageRequest,
    throughSeq: number,
    signal: AbortSignal,
  ): Promise<SessionJournalPage> {
    const result = await this.remote.session.page(
      { address: this.address, throughSeq, ...request },
      signal,
    )
    if (!result.ok) throw result.error
    for (const record of result.value.records) assertSessionWireEvent(record.event)
    return result.value
  }

  /** @inheritdoc */
  protected override repairRequest(
    request: ClientSessionPageRequest,
  ): ClientSessionPageRequest {
    return {
      ...(request.maxMessages === undefined ? {} : { maxMessages: request.maxMessages }),
      ...(request.turnWindow === undefined ? {} : { turnWindow: request.turnWindow }),
    }
  }
}
