/** Client Session 对象层、Agent scope 与 Remote 生命周期接线。 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent/types'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-file-upload/client'
import { typertOwnedValue } from '@deepseek-ai/dsh-typert-protocol'
import { createSessionControlStream } from './transport.ts'
import { ClientSessions } from './sessions/service.ts'
import type { SessionRemotes } from './sessions/remotes.ts'
import type {} from '../remote-events.ts'

export {
  createSessionControlStream,
  SessionEventStream,
  SESSION_SEARCH_RESULT_LIMIT,
  SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS,
} from './transport.ts'
export type {
  ClientSessionPageRequest,
  SessionControlStream,
  SessionControlStreamOptions,
  SessionEventStreamOptions,
  SessionJournalChange,
  SessionRemote,
} from './transport.ts'
export { createScope, scopeOf } from './scope.ts'
export type { AgentContext, AgentScopeHandle } from './scope.ts'
export { SessionCreateError, SessionForkError } from './sessions/service.ts'
export type { SessionBinding, SessionListState, SessionSummary } from './sessions/service.ts'
export type {
  SessionListPhase,
  SessionListSnapshot,
  SessionSearchResultItem,
  SessionProjectionSnapshot,
} from './sessions/manager.ts'
export type { Session } from './sessions/session.ts'
export type {
  ProjectionsBaseline,
  ProjectionValueStore,
  SessionProjectionMap,
  UseProjection,
} from './sessions/projection-store.ts'
export type {
  BeginSubmissionInput,
  ISession,
  PendingSubmissionRetirement,
  ProjectionsFace,
  SessionFace,
  SubmissionHandle,
} from './contract/session.ts'
export type {
  ISessions, SessionReference, SessionRetainInfo, SessionRetainOptions, SessionTarget,
} from './contract/sessions.ts'
export { MutableSessionEventSource } from './contract/events.ts'
export type {
  AssistantLiveChunkEvent,
  SessionAssistantSettlementEntry,
  SessionEventChange,
  SessionEventLike,
  SessionEventLikeEntry,
  SessionEventSource,
  SessionEventWindow,
  SessionLiveEventEntry,
  SessionTransientEventEntry,
} from './contract/events.ts'
export type {
  OpenState,
  PendingSubmission,
  PendingSubmissionAttachment,
  PendingSubmissionFileAttachment,
  PendingSubmissionImage,
  PendingSubmissionImageAttachment,
  PendingSubmissionPlacement,
  PromptError,
  SessionSnapshot,
} from './contract/snapshot.ts'

/** 消费方持有的引用标签；经由包的规范 /client 入口扩展此映射。 */
export interface SessionReferenceSourceMap {
  /** 临时的 Client Controller 工作，包括 fork 标题准备。 */
  controllerOperation: unknown
  /** 一次 Client Gateway 调用的同步 Context 所有权。 */
  gateway: unknown
}

/** 由独立 Client 引用携带的声明合并可扩展标签。 */
export type SessionReferenceSource = Extract<keyof SessionReferenceSourceMap, string>

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Client Session 对象层与 Agent scope 持有者。 */
    sessions: import('./contract/sessions.ts').ISessions
  }
}

/** 必需的 Remote 与 Context 投影服务。 */
export const inject = [
  'connection',
  'fileUpload',
  'typert',
  'remote',
  'remote.commands',
  'remote.session',
  'remote.subagents',
]

/**
 * 安装 Client Session 状态及其重连控制流。
 * @param ctx - Client Cordis 上下文。
 */
export function apply(ctx: Context): void {
  const remotes = ctx.remote as unknown as SessionRemotes
  const connection = ctx.get('connection') as ConnectionHandle
  const sessions = new ClientSessions(ctx, remotes)
  ctx.remote.$on('api-session/added', (summary) => { sessions.handleSessionAdded(summary) })
  ctx.remote.$on('api-session/removed', (sessionId) => { sessions.handleSessionRemoved(sessionId) })
  ctx.remote.$on('api-session/status', (sessionId, running) => {
    sessions.handleSessionStatus(sessionId, running)
  })
  ctx.remote.$on('api-session/activity', (sessionId, updatedAt) => {
    sessions.handleSessionActivity(sessionId, updatedAt)
  })
  ctx.remote.$on('api-session/error', (sessionId, message) => {
    sessions.handleSessionError(sessionId, message)
  })

  const control = createSessionControlStream(remotes, {
    accept: (frame) => { sessions.handleControlFrame(frame) },
    failed: (error) => { console.error('[session-controller] control stream failed:', error) },
  })
  const connected = (): void => {
    if (connection.generation.getSnapshot() === undefined) return
    // 就绪的控制基线可能在 Cordis 交付 connection/reset 之前到达。
    sessions.handleConnected()
    control.restart()
    control.start()
  }
  ctx.effect(() => connection.generation.subscribe(connected), 'session-controller.client.generation')
  connected()
  ctx.typert.contexts.registerClient('agent', {
    identity: candidate => sessions.sessionOf(candidate)?.sessionId,
    resolve: (sessionId) => {
      const reference = sessions.retainAgentScope(sessionId)
      return typertOwnedValue(reference.binding.ctx, () => { reference.release() })
    },
  })
  ctx.effect(() => async () => { await control.dispose() }, 'session-controller.client.control')
}
