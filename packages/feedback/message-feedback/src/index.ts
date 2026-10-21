/**
 * 已定稿 assistant 消息的规范会话日志反馈。
 * @module @deepseek-ai/dsh-message-feedback
 */

import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { Context, Service } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { FEEDBACK_CATEGORIES } from '@deepseek-ai/dsh-command-feedback'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import { deriveEventMessage, isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-session'
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type {
  MessageFeedbackDeleteRequest,
  MessageFeedbackDeleteResult,
  MessageFeedbackFailure,
  MessageFeedbackItem,
  MessageFeedbackListRequest,
  MessageFeedbackListResult,
  MessageFeedbackNoteBlank,
  MessageFeedbackNoteTooLarge,
  MessageFeedbackPutRequest,
  MessageFeedbackPutResult,
  MessageFeedbackRejected,
  MessageFeedbackSessionNotFound,
  MessageFeedbackSuccess,
  MessageFeedbackVersion,
  MessageFeedbackVersionConflict,
} from './types.ts'

export type * from './types.ts'

/** 可选说明所必需的部署策略。 */
export interface Config {
  /** 单条说明可接受的最大 UTF-8 字节长度。 */
  readonly maxNoteBytes: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    messageFeedback: MessageFeedbackService
  }
  interface Events {
    /**
     * 观察一次持久化的冷路径反馈变更，而不发布实时会话。
     * 观察者运行于写所有权释放之前，且不得为同一会话等待另一个
     * 消息反馈操作。载荷为只读借用；转移所有权前（例如传给
     * Session.fromRestore）需先做深拷贝。
     * @param inspection - 已提交的规范前缀，其最后一个事件即该反馈。
     * @mode parallel
     */
    'feedback/committed'(inspection: SessionInspection): void
  }
}

const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const itemSchema = z.object({
  messageId: z.string().min(1),
  rating: z.enum(['positive', 'negative']),
  note: z.string().refine(note => note.trim().length > 0).optional(),
  category: z.enum(FEEDBACK_CATEGORIES).optional(),
  version: z.uuid(),
  createdAt: timestamp,
  updatedAt: timestamp,
}).refine(item => item.updatedAt >= item.createdAt)
const putSchema = z.object({ sessionId: z.string().min(1), item: itemSchema })
const deleteSchema = z.object({ sessionId: z.string().min(1), messageId: z.string().min(1) })

type FeedbackEvent = SessionEvent<'feedback/message-put' | 'feedback/message-delete'>
type Mutation = Pick<SessionEvent<'feedback/message-put'>, 'type' | 'data'>
  | Pick<SessionEvent<'feedback/message-delete'>, 'type' | 'data'>
type Append = (event?: Mutation) => Promise<void>
type MissingSession = MessageFeedbackRejected<MessageFeedbackSessionNotFound>
type ResolvedNote = MessageFeedbackSuccess<string | undefined>
  | MessageFeedbackRejected<MessageFeedbackNoteBlank | MessageFeedbackNoteTooLarge>

/** 返回调用方持有的、与日志解耦的不可变值。 */
function snapshotItem(item: MessageFeedbackItem): MessageFeedbackItem {
  return Object.freeze({ ...item })
}

function success<T>(value: T): MessageFeedbackSuccess<T> {
  return Object.freeze({ ok: true, value })
}

function rejected<E extends MessageFeedbackFailure>(error: E): MessageFeedbackRejected<E> {
  return Object.freeze({ ok: false, error: Object.freeze(error) })
}

/** 在派生当前的会话所属反馈之前，先校验已持久化的载荷。 */
function currentItems(sessionId: SessionId, events: readonly SessionEvent[]): MessageFeedbackItem[] {
  const items = new Map<MessageFeedbackItem['messageId'], MessageFeedbackItem>()
  for (const event of events) {
    switch (event.type) {
      case 'feedback/message-put':
        putSchema.parse(event.data)
        if (event.data.sessionId === sessionId) items.set(event.data.item.messageId, event.data.item)
        break
      case 'feedback/message-delete':
        deleteSchema.parse(event.data)
        if (event.data.sessionId === sessionId) items.delete(event.data.messageId)
        break
      default:
        // 其他插件的事件不会改变消息反馈。
        break
    }
  }
  return [...items.values()]
}

/** 会话日志服务；冷路径操作从不构造 Session 或 Agent。 */
export class MessageFeedbackService extends TypertRemoteService {
  static inject = ['sessionPersistence', 'sessions']

  /** 对必需的说明大小策略做加载期校验。 */
  static Config: s<Config> = s.object({
    maxNoteBytes: s.number().step(1).min(1).required(),
  })

  private readonly maxNoteBytes: number
  private readonly operationTails = new Map<SessionId, Promise<void>>()
  private mutationAdmissionOpen = true

  /**
   * @param ctx - 持有会话持久化与实时持有者的 Host 上下文。
   * @param config - 必需的说明大小策略。
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'messageFeedback')
    if (!Number.isSafeInteger(config.maxNoteBytes) || config.maxNoteBytes < 1) {
      throw new TypeError('message-feedback: maxNoteBytes must be a positive safe integer')
    }
    this.maxNoteBytes = config.maxNoteBytes
  }

  protected [Service.init](): void {
    this.ctx.effect(() => async () => {
      this.mutationAdmissionOpen = false
      await Promise.all(this.operationTails.values())
    }, 'message-feedback.drain')
  }

  /**
   * 从规范日志读取当前反馈。
   * @param request - 待检查的会话。
   * @returns 不可变的条目，或明确的持久化未命中。
   */
  @Remote('list')
  list(request: MessageFeedbackListRequest): Promise<MessageFeedbackListResult> {
    return this.enqueue(request.sessionId, () => this.withSession(request.sessionId, false, events =>
      success(Object.freeze({ items: Object.freeze(currentItems(request.sessionId, events).map(snapshotItem)) }))))
  }

  /**
   * 校验当前版本后创建或替换反馈。
   * 值未变化的空操作会保留版本且不追加事件。
   * @param request - 目标、期望值与观察到的条目版本。
   * @returns 已持久化的条目，或明确的业务失败。
   */
  @Remote('put')
  put(request: MessageFeedbackPutRequest): Promise<MessageFeedbackPutResult> {
    const note = this.resolveNote(request.note)
    if (!note.ok) return Promise.resolve(note)
    return this.enqueue(request.sessionId, () => this.withSession(request.sessionId, true, async (events, append) => {
      const items = currentItems(request.sessionId, events)
      if (!events.some(event => event.type === 'assistant/message'
        && isAppendSurfaceEvent(event)
        && deriveEventMessage(event)?.id === request.messageId)) {
        return rejected({ code: 'target-not-found', sessionId: request.sessionId, messageId: request.messageId })
      }
      const existing = items.find(item => item.messageId === request.messageId)
      if (request.ifVersion !== (existing?.version ?? null)) {
        return rejected(this.versionConflict(existing ?? null))
      }
      if (existing !== undefined && existing.rating === request.rating && existing.note === note.value
        && existing.category === request.category) {
        await append()
        return success(snapshotItem(existing))
      }
      const now = Date.now()
      const item: MessageFeedbackItem = {
        messageId: request.messageId,
        rating: request.rating,
        ...(note.value === undefined ? {} : { note: note.value }),
        ...(request.category === undefined ? {} : { category: request.category }),
        version: randomUUID() as MessageFeedbackVersion,
        createdAt: existing?.createdAt ?? now,
        updatedAt: existing === undefined ? now : Math.max(now, existing.updatedAt),
      }
      await append({ type: 'feedback/message-put', data: { sessionId: request.sessionId, item } })
      return success(snapshotItem(item))
    }))
  }

  /**
   * 校验版本后删除一个条目；本就缺失时直接成功且不产生事件。
   * @param request - 会话、消息与观察到的条目版本。
   * @returns 稳定的缺失后置条件，或明确的失败。
   */
  @Remote('delete')
  delete(request: MessageFeedbackDeleteRequest): Promise<MessageFeedbackDeleteResult> {
    return this.enqueue(request.sessionId, () => this.withSession(request.sessionId, true, async (events, append) => {
      const existing = currentItems(request.sessionId, events).find(item => item.messageId === request.messageId)
      if (existing !== undefined) {
        if (request.ifVersion !== existing.version) return rejected(this.versionConflict(existing))
        await append({ type: 'feedback/message-delete', data: { sessionId: request.sessionId, messageId: request.messageId } })
      } else {
        await append()
      }
      return success(Object.freeze({ absent: true as const }))
    }))
  }

  /** 在读取/比较/追加期间持有冷路径写所有权；直接使用实时持有者。 */
  private async withSession<T>(
    sessionId: SessionId,
    write: boolean,
    operation: (events: readonly SessionEvent[], append: Append) => T | Promise<T>,
  ): Promise<T | MissingSession> {
    if (this.ctx.sessions.get(sessionId) === undefined
      && await this.ctx.sessionPersistence.stat(sessionId) === undefined
      && this.ctx.sessions.get(sessionId) === undefined) {
      return rejected({ code: 'session-not-found', sessionId })
    }
    const live = this.ctx.sessions.get(sessionId)
    if (live !== undefined) {
      // oxlint-disable-next-line typescript/no-deprecated -- 读取既有会话历史；迁移延后。
      return operation(live.snapshotEvents(), async (event) => {
        if (event !== undefined) {
          live.append(event.type, event.data)
        }
        // oxlint-disable-next-line typescript/no-deprecated -- 读取既有会话历史；迁移延后。
        const last = live.snapshotEvents().at(-1)
        if (!(await this.ctx.sessions.flush(live))) {
          throw new Error(
            `message-feedback: no durability listener participated for live session '${sessionId}'`,
          )
        }
        // 仅有监听器参与并不能证明该会话存在持久化写入方。
        const handle = await this.ctx.sessionPersistence.open(sessionId, 'read')
        try {
          const { events: stored } = await handle.read(last?.seq ?? 0, 1)
          if (!isDeepStrictEqual(
            [handle.header.id, handle.header.createdAt, handle.header.cwd],
            [live.header.id, live.header.createdAt, live.header.cwd],
          )
            || (last !== undefined && !isDeepStrictEqual(stored[0], last))) {
            throw new Error(`message-feedback: feedback prefix is not durable for live session '${sessionId}'`)
          }
        } finally {
          await handle.close()
        }
      })
    }
    const handle = await this.ctx.sessionPersistence.open(sessionId, write ? 'write' : 'read')
    try {
      const { events } = await handle.read()
      return await operation(events, async (event) => {
        const entry: FeedbackEvent | undefined = event === undefined ? undefined
          : { ...event, seq: SessionSeq(events.length), time: Date.now() }
        if (entry !== undefined) await handle.append([entry])
        await handle.flush()
        if (entry !== undefined) {
          try {
            await this.ctx.parallel('feedback/committed', {
              meta: handle.header,
              inheritedEventCount: handle.inheritedEventCount,
              events: [...events, entry],
            })
          } catch (error) {
            this.ctx.logger.warn('message-feedback: committed feedback observer failed', error)
          }
        }
      })
    } finally {
      await handle.close()
    }
  }

  private resolveNote(note: string | undefined): ResolvedNote {
    if (note === undefined) return success(undefined)
    if (note.trim().length === 0) return rejected({ code: 'note-blank' })
    const actualBytes = Buffer.byteLength(note, 'utf8')
    if (actualBytes > this.maxNoteBytes) {
      return rejected({ code: 'note-too-large', maxBytes: this.maxNoteBytes, actualBytes })
    }
    return success(note)
  }

  private versionConflict(current: MessageFeedbackItem | null): MessageFeedbackVersionConflict {
    return { code: 'version-conflict', current: current === null ? null : snapshotItem(current) }
  }

  /** 串行化完整操作，并在销毁前排空其句柄。 */
  private enqueue<T>(sessionId: SessionId, operation: () => Promise<T>): Promise<T> {
    if (!this.mutationAdmissionOpen) return Promise.reject(new Error('message-feedback: service is disposing'))
    const previous = this.operationTails.get(sessionId) ?? Promise.resolve()
    const result = previous.then(operation)
    const tail = result.then(() => undefined, () => undefined)
    this.operationTails.set(sessionId, tail)
    return result.finally(() => {
      if (this.operationTails.get(sessionId) === tail) this.operationTails.delete(sessionId)
    })
  }
}

export default MessageFeedbackService
