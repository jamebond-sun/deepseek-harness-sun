/**
 * 由日志支撑的会话标题服务、确定性回退与提供方契约。
 * @module @deepseek-ai/dsh-session-title
 */

import { Context, FiberState, Service, type Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { assertNever, deepFreeze } from '@deepseek-ai/dsh-util-values'
import type {
  Session,
  SessionEvent,
} from '@deepseek-ai/dsh-session'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-agent'
export type {
  SessionTitleEventData,
  SessionTitleModelIdentity,
  SessionTitleSnapshot,
  SessionTitleSource,
  SessionTitleUserMessage,
  TitleProjection,
} from './types.ts'
import { fallbackSessionTitle, normalizeSessionTitle } from './normalize.ts'
import type {
  SessionTitleEventData,
  SessionTitleModelIdentity,
  SessionTitleSnapshot,
  SessionTitleSource,
  SessionTitleUserMessage,
  TitleInputState,
  TitleProjection,
} from './types.ts'

/** 标识一次会话标题提供方注册。 */
export type SessionTitleProviderId = Branded<'SessionTitleProviderId'>

/**
 * 给一个原始提供方 id 打上品牌。
 * @param id - 由插件提供的、稳定的非空提供方标识符。
 * @returns 带会话标题提供方品牌的同一个字符串。
 */
export function SessionTitleProviderId(id: string): SessionTitleProviderId {
  return id as SessionTitleProviderId
}

export { fallbackSessionTitle, normalizeSessionTitle, truncateTitleUtf8 } from './normalize.ts'

/** 必需的确定性回退与可接受标题的限制。 */
export interface Config {
  /** 内置回退中以空白分隔的词的最大数量。 */
  readonly fallbackMaxWords: number
  /** 内置回退的最大 UTF-8 字节数。 */
  readonly fallbackMaxBytes: number
  /** 任何被接受标题的最大 UTF-8 字节数。 */
  readonly maxTitleBytes: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionTitle: SessionTitleService
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * 最新者胜的会话标题快照。仅日志：它从不进入模型 surface 或派生历史。
     */
    'session/title': SessionTitleEventData
  }
}

/**
 * 对一条文本归一化后为空、因而被拒绝的显式用户标题——这是 {@link
 * SessionTitleService.rename} 中唯一把责任归咎于输入的失败。把 rename
 * 失败翻译到线上（`title-invalid`）的调用方会针对这个类收窄；活性与处置
 * 失败仍保持为普通的 `Error`。
 */
export class SessionTitleInvalidError extends Error {
  override readonly name = 'SessionTitleInvalidError'
}

/** 由已注册提供方拥有的自动生成节奏。 */
export type SessionTitleAutomaticMode = 'first-prompt' | 'all-prompts'

/** 提供给一次标题提供方调用的、不可变的输入。 */
export interface SessionTitleProviderRequest {
  /** 正在被加标题的活跃会话。 */
  readonly session: Session
  /** 直到本次生成修订为止、所有合格的人类消息。 */
  readonly messages: readonly SessionTitleUserMessage[]
  /** 确切的、当前已记录的主动请求路由，已记录时存在。 */
  readonly route?: SessionTitleModelIdentity
  /**
   * 在调用时捕获的最新已接受标题，包括其事件可能位于最后一条合格消息
   * 之后的一个已接受回退。在任何标题被接受之前不存在。提供方自行决定是否
   * 以及如何使用它。
   */
  readonly currentTitle?: SessionTitleSnapshot
  /** 用于取代、处置、超时组合或显式调用方的取消。 */
  readonly signal: AbortSignal
}

/** 介于服务自有归一化与日志接受之间的提供方输出。 */
export interface SessionTitleProviderResult {
  /** 提议的标题文本。 */
  readonly title: string
  /** 本结果使用的、来自 `request.messages` 的确切 seq。 */
  readonly messageSeqs: readonly SessionSeq[]
  /** 辅助的 LLM 路由，当生成使用了一个模型时存在。 */
  readonly model?: SessionTitleModelIdentity
}

/** 一个向服务注册的、可选异步标题实现。 */
export interface SessionTitleProvider {
  /** 随标题一并记录的、稳定的提供方 id。 */
  readonly id: SessionTitleProviderId
  /** 新的哪些人类提示会启动自动生成。 */
  readonly automatic: SessionTitleAutomaticMode
  /**
   * 产生一个标题修订。
   * @param request - 消息快照、当前标题、当前路由、会话与取消信号。
   * @returns 提议的标题，加上确切的输入 seq，以及用于生成它的可选的
   *   提供方/模型路由。
   */
  generate(request: SessionTitleProviderRequest): Promise<SessionTitleProviderResult>
}

/** 从一条会话事件中抽取一条合格的人类文本消息。 */
function sessionTitleUserMessageOf(event: SessionEvent): SessionTitleUserMessage | undefined {
  if (event.type !== 'user/message' || event.data.source.kind !== 'user') return undefined
  const content = event.data.content
  const text = content
    .filter((block): block is Extract<(typeof content)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
  if (normalizeSessionTitle(text, Number.MAX_SAFE_INTEGER).length === 0) return undefined
  return { seq: event.seq, text }
}
/** 对一条已记录标题源的防御性拷贝（快照不得别名到日志所拥有的对象）。 */
function copySessionTitleSource(source: SessionTitleSource): SessionTitleSource {
  switch (source.kind) {
    case 'fallback': return { kind: 'fallback' }
    case 'provider': return {
      kind: 'provider',
      provider: source.provider,
      ...(source.model === undefined ? {} : { model: { ...source.model } }),
    }
    case 'user': return { kind: 'user' }
    /* v8 ignore next -- 封闭联合的穷尽性守卫 */
    default: return assertNever(source, 'SessionTitleSource')
  }
}

/** 服务自有的、已解析的限制。 */
interface ResolvedConfig {
  readonly fallbackMaxWords: number
  readonly fallbackMaxBytes: number
  readonly maxTitleBytes: number
}

/** 一代确切的提供方注册。 */
interface ProviderRegistration {
  readonly provider: SessionTitleProvider
  readonly active: Set<Promise<unknown>>
  closing: boolean
}

/** 正在等待匹配的主动请求头的自动工作。 */
interface PendingAutomaticWork {
  readonly registration: ProviderRegistration
  readonly revision: number
  readonly throughSeq: SessionSeq
}

/** 当前被允许为某个会话提交的提供方调用。 */
interface ActiveProviderWork extends PendingAutomaticWork {
  readonly controller: AbortController
  readonly signal: AbortSignal
}

/** 作用域限定于一个活跃会话的可变并发状态。 */
interface SessionTitleWorkState {
  revision: number
  fallback?: Promise<SessionTitleSnapshot | undefined>
  pending?: PendingAutomaticWork
  active?: ActiveProviderWork
}

/** 校验一个正整数配置字段。 */
function assertPositiveInteger(name: keyof Config, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`session-title: ${name} must be a positive integer`)
  }
}

/**
 * 把标题投影状态转换为一个不可变快照。
 * @param state - 标题单元的折叠状态。
 * @returns 不可变快照。
 */
function titleSnapshotFromState(state: TitleProjection): SessionTitleSnapshot {
  return deepFreeze({
    title: state.title,
    messageSeqs: [...state.messageSeqs],
    source: copySessionTitleSource(state.source),
    eventSeq: state.eventSeq,
    updatedAt: state.updatedAt,
  })
}

const EMPTY_TITLE_INPUT: TitleInputState = { first: null, count: 0, lastSeq: null }

const sessionTitleUserMessageSchema: ZodType<SessionTitleUserMessage> = zod.object({
  seq: zod.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(SessionSeq),
  text: zod.string(),
}).strict()

const titleInputStateSchema: ZodType<TitleInputState> = zod.object({
  first: sessionTitleUserMessageSchema.nullable(),
  count: zod.number().int().nonnegative(),
  lastSeq: zod.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(SessionSeq).nullable(),
}).strict().superRefine((state, context) => {
  const empty = state.first === null && state.lastSeq === null && state.count === 0
  const populated = state.first !== null
    && state.lastSeq !== null
    && state.count > 0
    && state.first.seq <= state.lastSeq
  if (!empty && !populated) {
    context.addIssue({
      code: 'custom',
      message: 'title input state must pair its count with first and last message seqs',
    })
  }
})

/**
 * 按 seq 顺序，从一段会话日志中收集合格的人类文本消息。完整的合格前缀
 * 只为一代提供方生成而物化，因此它是在执行时从日志扫描得到，而不是由
 * O(1) 的 `titleInput` 投影保留下来。
 * @param events - 会话事件日志。
 * @param throughSeq - 可选、含尾的 seq 上界。
 * @returns 带确切源 seq 的合格消息。
 */
function collectSessionTitleMessages(
  events: readonly SessionEvent[],
  throughSeq?: SessionSeq,
): SessionTitleUserMessage[] {
  const messages: SessionTitleUserMessage[] = []
  for (const event of events) {
    if (throughSeq !== undefined && event.seq > throughSeq) break
    const message = sessionTitleUserMessageOf(event)
    if (message !== undefined) messages.push(message)
  }
  return messages
}

const titleViewSchema: ZodType<string | null> = zod.string().min(1).nullable()

/** 最新已记录标题文本及其客户端视图。 */
export const titleProjectionDefinition = {
  key: 'title',
  stateVersion: 1,
  stateSchema: titleViewSchema,
  init: () => null,
  apply: (state, event) => (event.type === 'session/title'
    ? event.data.title
    : state),
  wire: {
    viewSchema: titleViewSchema,
    view: state => state,
  },
} satisfies ProjectionDefinition<'title', string | null>

/**
 * 不咨询可变元数据，折叠最新的已记录标题。
 * @param events - 活跃或已持久化的会话日志。
 * @returns 最新的不可变标题快照，或 `undefined`。
 */
export function foldSessionTitle(events: readonly SessionEvent[]): SessionTitleSnapshot | undefined {
  const event = events.findLast(item => item.type === 'session/title')
  if (event === undefined) return undefined
  return titleSnapshotFromState({
    title: event.data.title,
    messageSeqs: event.data.messageSeqs,
    source: event.data.source,
    eventSeq: event.seq,
    updatedAt: event.time,
  })
}

/** 由日志支撑的标题折叠，加上异步回退生成。 */
export class SessionTitleService extends Service {
  static inject = ['sessions', 'sessionProjections']
  static Config: z<Config> = z.object({
    fallbackMaxWords: z.number().step(1).min(1).required(),
    fallbackMaxBytes: z.number().step(1).min(1).required(),
    maxTitleBytes: z.number().step(1).min(1).required(),
  })

  private readonly config: ResolvedConfig
  private readonly ownerFiber: Fiber
  private registration: ProviderRegistration | undefined
  private readonly work = new Map<Session, SessionTitleWorkState>()
  private readonly lifetime = new AbortController()
  private readonly inFlight = new Set<Promise<unknown>>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'sessionTitle')
    this.ownerFiber = ctx.fiber
    const candidate: unknown = config
    if (candidate === null || typeof candidate !== 'object') {
      throw new Error('session-title: configuration is required')
    }
    const value = candidate as Config
    assertPositiveInteger('fallbackMaxWords', value.fallbackMaxWords)
    assertPositiveInteger('fallbackMaxBytes', value.fallbackMaxBytes)
    assertPositiveInteger('maxTitleBytes', value.maxTitleBytes)
    if (value.fallbackMaxBytes > value.maxTitleBytes) {
      throw new Error('session-title: fallbackMaxBytes must not exceed maxTitleBytes')
    }
    this.config = deepFreeze({ ...value })

    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('session-title service disposed'))
      if (this.registration !== undefined) this.registration.closing = true
      this.registration = undefined
      for (const state of this.work.values()) {
        delete state.pending
        state.active?.controller.abort(new Error('session-title service disposed'))
      }
      await this.drain(this.inFlight)
      this.work.clear()
    }, 'sessionTitle lifecycle')

    ctx.sessionProjections.register(titleProjectionDefinition)

    ctx.sessionProjections.register<'titleInput', TitleInputState>({
      key: 'titleInput',
      stateVersion: 3,
      stateSchema: titleInputStateSchema,
      init: () => EMPTY_TITLE_INPUT,
      apply: (state, event) => {
        const message = sessionTitleUserMessageOf(event)
        if (message === undefined) return state
        return {
          first: state.first ?? message,
          count: state.count + 1,
          lastSeq: message.seq,
        }
      },
    })

    ctx.on('session/event', (session, event) => {
      switch (event.type) {
        case 'user/message':
          this.onUserMessage(session, event)
          break
        case 'request/header':
          this.onRequestHeader(session, event)
          break
        default:
          break
      }
    })
    ctx.on('llm/stream', (options, next) => {
      this.onMainRequest(options)
      return next()
    }, { global: true, prepend: true })
    ctx.on('session/disposed', (session) => {
      const state = this.work.get(session)
      if (state === undefined) return
      state.active?.controller.abort(new Error('session disposed during title generation'))
      this.work.delete(session)
    })
  }

  /**
   * 从一个活跃或重放的会话读取最新的已折叠标题。
   * @param session - 其日志即标题真相来源的会话。
   * @returns 最新的标题快照，或在出现合格输入之前为 `undefined`。
   */
  get(session: Session): SessionTitleSnapshot | undefined {
    // oxlint-disable-next-line typescript/no-deprecated -- 读取已有会话历史；迁移已推迟。
    return foldSessionTitle(session.snapshotEvents())
  }

  /**
   * 接受一个显式的用户标题。追加一个带 `user` 源的 `session/title` 事件，
   * 它会固定该标题：在途的自动生成被取代，而后来的用户消息不再排程任何
   * 生成（一次显式的 {@link SessionTitleService.refresh} 仍是刻意的“取消固定”）。
   * @param session - 要重命名的、确切的活跃会话。
   * @param title - 原始用户输入；在接受前被归一化。
   * @returns 被接受的标题快照。
   * @throws {SessionTitleInvalidError} 当标题归一化后为空时。
   * @throws {Error} 当会话不活跃或服务已处置时。
   */
  rename(session: Session, title: string): SessionTitleSnapshot {
    this.assertServiceActive()
    if (this.ctx.sessions.get(session.id) !== session) {
      throw new Error(`session "${session.id}" is not live in this store`)
    }
    const normalized = normalizeSessionTitle(title, this.config.maxTitleBytes)
    if (normalized.length === 0) {
      throw new SessionTitleInvalidError('session title must contain visible characters')
    }
    const state = this.stateFor(session)
    this.supersede(state, 'user rename superseded automatic title generation')
    session.append('session/title', {
      title: normalized,
      messageSeqs: [],
      source: { kind: 'user' },
    })
    const snapshot = this.get(session)
    /* v8 ignore next -- unreachable: the append above just committed a session/title event. */
    if (snapshot === undefined) throw new Error('renamed title failed to fold')
    return snapshot
  }

  /**
   * 显式地重试已注册的提供方；当没有注册任何提供方时，物化内置回退。
   * @param session - 要刷新的、确切的活跃会话。
   * @param signal - 可选的调用方取消信号。
   * @returns 最新的已接受标题，或当不存在合格文本时为 `undefined`。
   */
  async refresh(session: Session, signal?: AbortSignal): Promise<SessionTitleSnapshot | undefined> {
    signal?.throwIfAborted()
    this.assertServiceActive()
    if (this.ctx.sessions.get(session.id) !== session) {
      throw new Error(`session "${session.id}" is not live in this store`)
    }
    const registration = this.registration
    const input = this.titleInputOf(session)
    if (registration === undefined || registration.closing || input.lastSeq === null) {
      // 即使没有提供方，显式刷新也是“取消固定”：一个站立的用户标题绝不能
      // 把 ensureFallback 短路成空操作，因此当可以推导出回退时，在上面重新
      // 推导并追加回退。
      const current = this.get(session)
      const first = input.first
      if (current?.source.kind === 'user' && first !== null) {
        this.appendFallback(session, first)
        signal?.throwIfAborted()
        return this.get(session)
      }
      const fallback = await this.ensureFallback(session)
      signal?.throwIfAborted()
      return fallback
    }
    const state = this.stateFor(session)
    const revision = this.supersede(state, 'explicit title refresh superseded older generation')
    const work = this.activate({
      registration,
      revision,
      throughSeq: input.lastSeq,
    }, state, signal)
    const config = session.requestHeader()?.config
    const route = config === undefined ? undefined : { provider: config.provider, model: config.model }
    return this.startProvider(session, work, route)
  }

  /**
   * 注册唯一一个可选的标题提供方。处置会中止其挂起与活跃的工作；一旦处置
   * 开始，可以注册一个替代者，而正在关闭的提供方那些迟来的结果永远不会
   * 提交。
   * @param provider - 提供方身份、节奏与生成函数。
   * @returns 确切的 Cordis effect disposer，在活跃调用静默之后结算。
   */
  register(provider: SessionTitleProvider): () => Promise<void> {
    this.validateProvider(provider)
    if (this.registration !== undefined && !this.registration.closing) {
      throw new Error(`session-title provider "${this.registration.provider.id}" is already registered`)
    }
    const registration: ProviderRegistration = {
      provider,
      active: new Set(),
      closing: false,
    }
    const dispose = this.ctx.effect(function* (this: SessionTitleService) {
      this.registration = registration
      yield async () => {
        registration.closing = true
        for (const state of this.work.values()) {
          if (state.pending?.registration === registration) delete state.pending
          if (state.active?.registration === registration) {
            state.active.controller.abort(new Error(`session-title provider "${provider.id}" was disposed`))
          }
        }
        await this.drain(registration.active)
        if (this.registration === registration) this.registration = undefined
      }
    }.bind(this), 'sessionTitle.register()')
    return dispose
  }

  /** 为一个合格事件排程回退创建，以及任意提供方节奏。 */
  private onUserMessage(session: Session, event: Extract<SessionEvent, { type: 'user/message' }>): void {
    if (!this.serviceActive()) return
    if (event.data.source.kind !== 'user' || sessionTitleUserMessageOf(event) === undefined) return
    // 一次用户重命名固定了标题：任何自动修订都不得覆盖它。
    if (this.get(session)?.source.kind === 'user') return
    const registration = this.registration
    if (registration !== undefined && !registration.closing) {
      const count = this.titleInputOf(session).count
      const shouldSchedule = registration.provider.automatic === 'all-prompts'
        || (session.header.parentSession === undefined && count === 1 && this.get(session) === undefined)
      if (shouldSchedule) {
        const state = this.stateFor(session)
        const revision = this.supersede(state, 'newer user message superseded title generation')
        state.pending = { registration, revision, throughSeq: event.seq }
      }
    }
    this.defer(async () => {
      try {
        await this.ensureFallback(session)
      } catch (error: unknown) {
        if (!this.serviceActive()) return
        this.ctx.logger.warn(`session "${session.id}": fallback title update failed: ${String(error)}`)
      }
    })
  }

  /** 只有在确切的主动请求路由被记录之后，才启动挂起的自动工作。 */
  private onRequestHeader(session: Session, event: Extract<SessionEvent, { type: 'request/header' }>): void {
    if (!this.serviceActive()) return
    const state = this.work.get(session)
    const pending = state?.pending
    if (state === undefined || pending === undefined || pending.throughSeq >= event.seq) return
    const route = {
      provider: event.data.header.config.provider,
      model: event.data.header.config.model,
    }
    this.startPending(session, state, pending, route)
  }

  /** 在标记的循环请求其头部折叠变为当前之后，以未变路由启动其工作。 */
  private onMainRequest(options: GenerateOptions): void {
    if (!this.serviceActive() || options.sessionId === undefined || !isAgentLoopRequest(options)) return
    const session = this.ctx.sessions.get(options.sessionId)
    const state = session === undefined ? undefined : this.work.get(session)
    const pending = state?.pending
    if (session === undefined || state === undefined || pending === undefined) return
    const boundary = this.ctx.sessionProjections.stateOf(session, 'turnBoundary')?.lastStepBoundary
    const route = session.requestHeader()?.config
    if (boundary?.kind !== 'start'
      || route?.provider !== options.provider
      || route.model !== options.model) return
    this.startPending(session, state, pending, { provider: options.provider, model: options.model })
  }

  /** 消费一个挂起修订，并排程其非阻塞的提供方调用。 */
  private startPending(
    session: Session,
    state: SessionTitleWorkState,
    pending: PendingAutomaticWork,
    route: SessionTitleModelIdentity,
  ): void {
    delete state.pending
    this.defer(async () => {
      if (this.registration !== pending.registration
        || pending.registration.closing
        || this.work.get(session) !== state
        || state.revision !== pending.revision) return
      const work = this.activate(pending, state)
      try {
        await this.startProvider(session, work, route)
      } catch (error: unknown) {
        if (work.signal.aborted || !this.serviceActive()) return
        this.ctx.logger.warn(`session "${session.id}": automatic title generation failed: ${String(error)}`)
      }
    })
  }

  /** 在发布其活跃修订之后，启动一个被追踪的提供方调用。 */
  private startProvider(
    session: Session,
    work: ActiveProviderWork,
    route?: SessionTitleModelIdentity,
  ): Promise<SessionTitleSnapshot | undefined> {
    const run = Promise.resolve().then(() => this.runProvider(session, work, route))
    return this.track(run, work.registration)
  }

  /** 执行并接受一个当前的提供方修订。 */
  private async runProvider(
    session: Session,
    work: ActiveProviderWork,
    route?: SessionTitleModelIdentity,
  ): Promise<SessionTitleSnapshot | undefined> {
    try {
      this.assertCurrent(session, work)
      await this.ensureFallback(session)
      this.assertCurrent(session, work)
      // 一份快照同时供应两个输入：消息停在已排程的水位处，而当前标题并不
      // 受该水位约束。
      // oxlint-disable-next-line typescript/no-deprecated -- 读取已有会话历史；迁移已推迟。
      const events = session.snapshotEvents()
      const messages = collectSessionTitleMessages(events, work.throughSeq)
      const currentTitle = foldSessionTitle(events)
      const result = await work.registration.provider.generate({
        session,
        messages,
        ...route === undefined ? {} : { route },
        ...currentTitle === undefined ? {} : { currentTitle },
        signal: work.signal,
      })
      this.assertCurrent(session, work)
      const accepted = this.validateResult(result, messages)
      session.append('session/title', {
        title: accepted.title,
        messageSeqs: [...accepted.messageSeqs],
        source: {
          kind: 'provider',
          provider: work.registration.provider.id,
          ...accepted.model === undefined ? {} : { model: accepted.model },
        },
      })
      return this.get(session)
    } finally {
      const state = this.work.get(session)
      if (state?.active === work) delete state.active
    }
  }

  /** 针对所提供的消息快照，校验并归一化提供方输出。 */
  private validateResult(
    result: unknown,
    messages: readonly SessionTitleUserMessage[],
  ): SessionTitleProviderResult {
    if (result === null || typeof result !== 'object') {
      throw new Error('session-title provider returned an invalid result')
    }
    const candidate = result as Record<string, unknown>
    if (typeof candidate.title !== 'string') throw new Error('session-title provider title must be a string')
    const title = normalizeSessionTitle(candidate.title, this.config.maxTitleBytes)
    if (title.length === 0) throw new Error('session-title provider returned an empty title')
    if (!Array.isArray(candidate.messageSeqs) || candidate.messageSeqs.length === 0) {
      throw new Error('session-title provider must identify at least one source message seq')
    }
    const messageSeqs: SessionSeq[] = []
    const order = new Map(messages.map((message, index) => [message.seq, index]))
    let previous = -1
    for (const seq of candidate.messageSeqs as unknown[]) {
      if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) {
        throw new Error('session-title provider messageSeqs must be unique, ordered seqs from the request')
      }
      const sessionSeq = SessionSeq(seq)
      const index = order.get(sessionSeq)
      if (index === undefined || index <= previous) {
        throw new Error('session-title provider messageSeqs must be unique, ordered seqs from the request')
      }
      messageSeqs.push(sessionSeq)
      previous = index
    }
    const modelCandidate = candidate.model
    let model: SessionTitleModelIdentity | undefined
    if (modelCandidate !== undefined) {
      if (modelCandidate === null || typeof modelCandidate !== 'object') {
        throw new Error('session-title provider result model must contain non-empty provider and model strings')
      }
      const record = modelCandidate as Record<string, unknown>
      if (typeof record.provider !== 'string' || record.provider.length === 0
        || typeof record.model !== 'string' || record.model.length === 0) {
        throw new Error('session-title provider result model must contain non-empty provider and model strings')
      }
      model = { provider: record.provider, model: record.model }
    }
    return {
      title,
      messageSeqs,
      ...(model === undefined ? {} : { model }),
    }
  }

  /** 让一个提供方、修订、会话或信号已过时的完成失败。 */
  private assertCurrent(session: Session, work: ActiveProviderWork): void {
    this.assertServiceActive()
    work.signal.throwIfAborted()
    const state = this.work.get(session)
    /* v8 ignore next -- 每个受支持的取代、提供方处置与会话处置都会在改变本状态之前中止该工作信号。 */
    if (this.registration !== work.registration
      || state?.active !== work
      || state.revision !== work.revision
      || this.ctx.sessions.get(session.id) !== session) {
      throw new Error('session title generation state changed without cancellation')
    }
  }

  /** 从一代固定的修订创建并发布一个活跃的提供方调用。 */
  private activate(
    pending: PendingAutomaticWork,
    state: SessionTitleWorkState,
    upstream?: AbortSignal,
  ): ActiveProviderWork {
    const controller = new AbortController()
    const signal = upstream === undefined
      ? AbortSignal.any([controller.signal, this.lifetime.signal])
      : AbortSignal.any([controller.signal, this.lifetime.signal, upstream])
    const work: ActiveProviderWork = { ...pending, controller, signal }
    state.active = work
    return work
  }

  /** 中止较旧的活跃工作，并预留下一个会话局部的修订。 */
  private supersede(state: SessionTitleWorkState, reason: string): number {
    state.active?.controller.abort(new Error(reason))
    delete state.pending
    state.revision += 1
    return state.revision
  }

  /** 返回某个会话的可变工作状态。 */
  private stateFor(session: Session): SessionTitleWorkState {
    let state = this.work.get(session)
    if (state === undefined) {
      state = { revision: 0 }
      this.work.set(session, state)
    }
    return state
  }

  private titleInputOf(session: Session): TitleInputState {
    return this.ctx.sessionProjections.stateOf(session, 'titleInput') as TitleInputState
  }

  /** 排程分离的服务工作，并在服务处置期间保留它。 */
  private defer(task: () => Promise<void>): void {
    const run = Promise.resolve().then(async () => {
      if (!this.serviceActive()) return
      await task()
    })
    void this.track(run)
  }

  /** 为服务与可选的提供方拆卸，保留一个 promise 直到其结算。 */
  private track<T>(run: Promise<T>, registration?: ProviderRegistration): Promise<T> {
    this.inFlight.add(run)
    registration?.active.add(run)
    const settled = (): void => {
      this.inFlight.delete(run)
      registration?.active.delete(run)
    }
    void run.then(settled, settled)
    return run
  }

  /** 等待一个生命周期注册表中每个当前与正在结算的 promise。 */
  private async drain(active: Set<Promise<unknown>>): Promise<void> {
    while (active.size > 0) await Promise.allSettled([...active])
  }

  /** 所属的插件纤程是否仍能启动或提交标题工作。 */
  private serviceActive(): boolean {
    return !this.lifetime.signal.aborted
      && this.ownerFiber.uid !== null
      && this.ownerFiber.state === FiberState.ACTIVE
  }

  /** 一旦所属插件纤程已开始卸载，就拒绝工作。 */
  private assertServiceActive(): void {
    if (!this.serviceActive()) throw new Error('session-title service disposed')
  }

  /** 在发布一个 effect 之前，拒绝畸形的提供方注册。 */
  private validateProvider(provider: unknown): asserts provider is SessionTitleProvider {
    if (provider === null || typeof provider !== 'object') {
      throw new Error('session-title provider must be an object')
    }
    const candidate = provider as Record<string, unknown>
    if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
      throw new Error('session-title provider id must be a non-empty string')
    }
    if (candidate.automatic !== 'first-prompt' && candidate.automatic !== 'all-prompts') {
      throw new Error('session-title provider automatic mode is invalid')
    }
    if (typeof candidate.generate !== 'function') {
      throw new Error(`session-title provider "${candidate.id}" requires generate()`)
    }
  }

  /**
   * Derive and append the deterministic fallback title over whatever stands
   * (the refresh unpin path: overwriting a pinned user title is the point).
   * Synchronous on purpose — no await may separate derivation from append, so
   * it needs neither ensureFallback's in-flight dedup nor its liveness
   * re-check. An underivable fallback (empty after the caps) appends nothing.
   */
  private appendFallback(session: Session, first: SessionTitleUserMessage): void {
    const title = fallbackSessionTitle(first.text, this.config.fallbackMaxWords, this.config.fallbackMaxBytes)
    if (title.length === 0) return
    session.append('session/title', {
      title,
      messageSeqs: [first.seq],
      source: { kind: 'fallback' },
    })
  }

  /** 如果会话仍然缺少标题，创建第一个确定性回退。 */
  private async ensureFallback(session: Session): Promise<SessionTitleSnapshot | undefined> {
    this.assertServiceActive()
    const current = this.get(session)
    if (current !== undefined) return current
    const first = this.titleInputOf(session).first
    if (first === null) return undefined
    const title = fallbackSessionTitle(
      first.text,
      this.config.fallbackMaxWords,
      this.config.fallbackMaxBytes,
    )
    if (title.length === 0) return undefined
    const state = this.stateFor(session)
    if (state.fallback !== undefined) return state.fallback
    const fallback = Promise.resolve().then(() => {
      this.assertServiceActive()
      if (this.ctx.sessions.get(session.id) !== session) {
        throw new Error(`session "${session.id}" is not live in this store`)
      }
      const accepted = this.get(session)
      if (accepted !== undefined) return accepted
      session.append('session/title', {
        title,
        messageSeqs: [first.seq],
        source: { kind: 'fallback' },
      })
      return this.get(session)
    })
    state.fallback = fallback
    try {
      return await fallback
    } finally {
      delete state.fallback
    }
  }
}

export default SessionTitleService
