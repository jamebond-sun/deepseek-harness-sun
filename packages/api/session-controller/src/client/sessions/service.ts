/** Client 目录与带来源标签的精确 Session 代际所有权。 */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import { SessionSeq, type SessionId } from '@deepseek-ai/dsh-session/types'
import { workspaceTitleOf } from '@deepseek-ai/dsh-util-workspace-path'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { SESSION_SEARCH_RESULT_LIMIT } from '../../types.ts'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import {
  createSnapshotStore, notifySubscribers, type ObservableSnapshot, type SnapshotStore,
} from '@deepseek-ai/dsh-client-store'
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionEventSource } from '../contract/events.ts'
import type { SessionFace } from '../contract/session.ts'
import type {
  AgentContext, ISessions, SessionReference, SessionRetainInfo, SessionRetainOptions, SessionTarget,
} from '../contract/sessions.ts'
import type { SessionReferenceSource } from '../index.ts'
import { createScope, scopeIdentityOf, scopeOf as scopeTagOf } from '../scope.ts'
import { SessionManager } from './manager.ts'
import type { SessionRemotes } from './remotes.ts'
import type { SessionListPhase, SessionSearchResultItem, SessionProjectionSnapshot } from './manager.ts'
import type { Session } from './session.ts'
import type { SessionListEntry } from './lineage.ts'

/** 由 Host 列表 RPC 加实时流增量投影出的 Session 列表行。 */
export interface SessionSummary {
  id: SessionId
  /** 最新的持久化日志标题，在 Host 投影出标题前缺失。 */
  title?: string
  /** 面向人的标签：持久化标题、项目基名，然后是 session id。 */
  displayTitle: string
  cwd?: string
  parentId?: SessionId
  /** 用于导航过滤的粗粒度持久化来源；不是继续会话的能力。 */
  origin?: 'subagent'
  /** Host 列表提供的格式分类（可用时）。 */
  formatStatus?: SessionListEntry['formatStatus']
  /** `ids` 成员的 Host running 状态；其他行的展示回退。 */
  running: boolean
  /** 本地持有计数；Host 元数据刷新不能覆盖它们。 */
  readonly retainedBy: SessionRetainInfo['retainedBy']
  /**
   * New Session 呈现与复用资格，从 Host 摘要、`sessionListMetadata`
   * 与客户端的接纳/running 观察推导。同一 workspace 的重连可以复用
   * 该 workspace 内的空白 Session。过滤由消费方负责：存储携带
   * 每一行，而 Workspace 浏览器只显示选中的空白条目。
   */
  blank: boolean
  updatedAt: number
  /** 由对象层保持的当前 Host 计算投影值。 */
  projectionValues?: Readonly<Partial<SessionProjectionMap>>
}

/** 目录元数据与本地来源计数；目录成员关系不拥有任何 Client 代际。 */
export interface SessionListState {
  /** Host 列表顺序；同一快照中每个 id 都有对应的 byId 行。 */
  ids: SessionId[]
  /** Host/目录行加上持有的 subagent 回退；只有 `ids` 表达 Host 列表成员关系。 */
  byId: Record<SessionId, SessionSummary>
  /** 从 manager 快照 1:1 投影的到达生命周期（见 SessionListPhase）：empty-with-ready 表示"确实没有会话"。 */
  phase: SessionListPhase
  /** 共享投影值与显式读取状态，包括未打开的 Session。 */
  projectionsBySession: Readonly<Record<SessionId, SessionProjectionSnapshot>>
}

/** 结构化的 session 创建失败。 */
export class SessionCreateError extends Error {
  override readonly name = 'SessionCreateError'

  /**
   * @param rpcError - Host 业务或折叠后的传输层错误。
   * @param requestedSessionId - 调用方预分配的 id，用于稍后的流/列表调和。
   */
  constructor(
    readonly rpcError: RemoteFailure,
    readonly requestedSessionId: SessionId | undefined,
  ) {
    super(`session create failed: ${rpcError.code}: ${rpcError.message}`)
  }
}

/** 结构化的 session 分叉失败。 */
export class SessionForkError extends Error {
  override readonly name = 'SessionForkError'

  /**
   * @param rpcError - Host 业务或折叠后的传输层错误。
   * @param sourceSessionId - 分叉切出的源 session。
   */
  constructor(
    readonly rpcError: RemoteFailure,
    readonly sourceSessionId: SessionId,
  ) {
    super(`session fork failed: ${rpcError.code}: ${rpcError.message}`)
  }
}

/** 一个已物化 Client Session 的身份稳定逻辑绑定。 */
export interface SessionBinding {
  readonly sessionId: SessionId
  /** 仅有对外的 session 门面 —— 功能代码永远看不到具体类。 */
  readonly session: SessionFace
  /** 保留给 Conversation 组装的连续事件窗口。 */
  readonly eventSource: SessionEventSource
  readonly ctx: AgentContext
}

// scope 原语位于 ../scope.ts（Host dsh-scope 的 client 镜像，
// 以 Agent 身份为键）；在此重新导出，使既有消费方保持其导入位置。
export { scopeOf } from '../scope.ts'

/**
 * 展示标题投影：持久化标题、项目目录基名，然后
 * 是原始 id。
 */
function displayTitleOf(title: string | undefined, cwd: string | undefined, id: SessionId): string {
  if (title !== undefined) return title
  if (cwd !== undefined && cwd !== '') {
    const base = workspaceTitleOf(cwd)
    if (base !== '') return base
  }
  return id
}

/**
 * 递增尾随的分叉编号，同时保留其半角或
 * 全角括号；无编号的标题从 ` (1)` 开始。
 * @param title - 源 session 的持久化标题。
 * @returns 分派给分叉子级的标题。
 */
function increasedForkTitle(title: string): string {
  const ascii = /^(.*?)\((\d+)\)$/u.exec(title)
  if (ascii?.[1] !== undefined && ascii[2] !== undefined) {
    return `${ascii[1]}(${BigInt(ascii[2]) + 1n})`
  }
  const fullWidth = /^(.*?)（(\d+)）$/u.exec(title)
  if (fullWidth?.[1] !== undefined && fullWidth[2] !== undefined) {
    return `${fullWidth[1]}（${BigInt(fullWidth[2]) + 1n}）`
  }
  return `${title} (1)`
}

/** 来源标签是字典键，包括 Object.prototype 上也存在的名字。 */
function freezeRetainedBy(counts: Partial<Record<SessionReferenceSource, number>>): SessionRetainInfo['retainedBy'] {
  Object.setPrototypeOf(counts, null)
  return Object.freeze(counts)
}

const EMPTY_RETAIN_INFO: SessionRetainInfo = Object.freeze({ referenceCount: 0, retainedBy: freezeRetainedBy({}) })

interface ScopeRecord {
  fiber: Fiber
  ctx: AgentContext
  binding: SessionBinding
  session: Session
  retention: SessionRetainInfo
  live: boolean
}

interface RetentionObserver {
  readonly source: ObservableSnapshot<SessionRetainInfo>
  readonly listeners: Set<() => void>
  published: SessionRetainInfo
}

/** 被取消的等待者只释放自己的引用，不释放共享的打开过程。 */
async function waitForOpen(opening: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) return opening
  const aborted = Promise.withResolvers<never>()
  const onAbort = (): void => { aborted.reject(signal.reason) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    if (signal.aborted) onAbort()
    await Promise.race([opening, aborted.promise])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

class ClientSessionReference implements SessionReference {
  private readonly released = new AbortController()
  private readonly readiness = Promise.withResolvers<SessionBinding>()
  readonly ready = this.readiness.promise

  constructor(
    readonly sessionId: SessionId,
    private record: ScopeRecord | undefined,
    private releaseReference: (() => void) | undefined,
  ) {
    void this.ready.catch(() => {})
  }

  get binding(): SessionBinding {
    if (this.record === undefined || !this.record.live) throw new Error(`Session reference "${this.sessionId}" is released`)
    return this.record.binding
  }

  attachOpening(opening: Promise<void>, signal?: AbortSignal): void {
    const waitSignal = signal === undefined
      ? this.released.signal
      : AbortSignal.any([this.released.signal, signal])
    void waitForOpen(opening, waitSignal).then(
      () => {
        try {
          waitSignal.throwIfAborted()
          this.readiness.resolve(this.binding)
        } catch (error: unknown) {
          this.readiness.reject(error)
        }
      },
      (error: unknown) => { this.readiness.reject(error) },
    )
  }

  release(): void {
    const reason = new Error(`Session reference "${this.sessionId}" is released`)
    const release = this.releaseReference
    this.released.abort(reason)
    this.readiness.reject(reason)
    this.record = undefined
    this.releaseReference = undefined
    release?.()
  }

  [Symbol.dispose](): void {
    this.release()
  }
}

/** Host 目录与本地引用分配器；视图选择留在 Controller 之外。 */
export class ClientSessions implements ISessions {
  /**
   * wire schema 自己的结果上限，作为注入数据重新暴露给
   * 展示插件。不是按连接的状态：`session.search` 响应
   * schema 把 `items` 限制在该常量，因此每个传输层（包括 fixture）
   * 报告同一个数值。
   */
  readonly searchResultLimit = SESSION_SEARCH_RESULT_LIMIT
  /** 目录元数据与本地引用来源投影。 */
  readonly list: SnapshotStore<SessionListState>
  /** 对象层实例集群与帧分发入口。 */
  private readonly manager: SessionManager
  private readonly scopes = new Map<SessionId, ScopeRecord>()
  /** 为 Client 根生命周期保持的按 id 稳定来源，包括跨代际替换。 */
  private readonly retainObservers = new Map<SessionId, RetentionObserver>()
  private readonly scopeDrops = new Set<Promise<void>>()
  private closed = false

  /**
   * @param ctx - client 根 context（scope fiber 挂载在其下）。
   * @param remote - 与每个 Session 共享的生成 Remote 命名空间。
   */
  constructor(
    private readonly rootCtx: Context,
    remote: SessionRemotes,
  ) {
    this.manager = new SessionManager(remote)
    this.list = createSnapshotStore<SessionListState>({
      ids: [], byId: {}, phase: 'pending', projectionsBySession: {},
    })
    const disposeManagerProjection = this.manager.subscribe(() => { this.projectList() })
    rootCtx.effect(() => async () => {
      this.closed = true
      disposeManagerProjection()
      const scopes = [...this.scopes]
      this.scopes.clear()
      for (const [, record] of scopes) {
        record.live = false
        record.session.unbindScope()
      }
      const managerDisposal = this.manager.dispose()
      for (const [id, record] of scopes) {
        this.startScopeDrop(id, record)
        this.publishRetention(id)
      }
      await this.drainScopeDrops()
      await managerDisposal
    }, 'session-controller.client.sessions')
    rootCtx.reflect.provide('sessions', this, undefined)
  }

  retain(target: SessionTarget, options: SessionRetainOptions): SessionReference {
    const { source, signal } = options
    signal?.throwIfAborted()
    if (this.closed) throw new Error('Session Controller is disposed')
    const id = this.manager.resolveTarget(target)
    const reference = this.retainScope(id, source)
    try {
      reference.attachOpening(this.manager.get(id).open(), signal)
      return reference
    } catch (error) {
      reference.release()
      throw error
    }
  }

  async using<T>(
    target: SessionTarget,
    options: SessionRetainOptions,
    operation: (reference: SessionReference) => T | Promise<T>,
  ): Promise<T> {
    const reference = this.retain(target, options)
    try {
      await reference.ready
      return await operation(reference)
    } finally {
      reference.release()
    }
  }

  retainInfo(id: SessionId): ObservableSnapshot<SessionRetainInfo> {
    let observer = this.retainObservers.get(id)
    if (observer === undefined) {
      const listeners = new Set<() => void>()
      observer = {
        listeners,
        published: this.retentionSnapshot(id),
        source: {
          getSnapshot: () => this.retentionSnapshot(id),
          subscribe: (listener) => {
            listeners.add(listener)
            return () => { listeners.delete(listener) }
          },
        },
      }
      this.retainObservers.set(id, observer)
    }
    return observer.source
  }

  /**
   * 解析一个已发现的直接父级地址，而不打开它。
   * 功能插件用它避免在持久化的子级视图中发起绑定 Agent 的 RPC。
   * @param id - 可能被寻址的子级 id。
   * @returns 持有中的、目录派生的或未知模式的已列出地址，而不持有新的选择或 scope。
   */
  subagentAddress(id: SessionId): SubagentAddress | undefined {
    return this.manager.subagentAddress(id)
  }

  /**
   * 读取投影而不启动迁移；重试失败或因迁移被推迟的读取。
   * @param sessionId - 要检查的 Session，不打开其会话内容。
   */
  refreshProjections(sessionId: SessionId): Promise<void> {
    return this.manager.refreshProjections(sessionId)
  }

  /**
   * 刷新真实的 Session 基线，复用进行中的拉取。
   * @returns 当前拉取或新启动的基线拉取的完成。
   */
  refresh(): Promise<void> {
    return this.manager.refreshList()
  }

  /**
   * 搜索 Host 可见的消息内容索引。结果保持请求局部；
   * 列表快照仍是元数据的权威。
   * @param query - 非空字面短语。
   * @param signal - 被取代搜索的取消信号。
   * @returns 有界结果或业务/传输层错误。
   */
  search(
    query: string,
    signal: AbortSignal,
  ): Promise<RemoteResult<{ items: SessionSearchResultItem[]; hasMore: boolean }>> {
    return this.manager.search(query, signal)
  }

  /**
   * 应用一个 Session Controller 实时控制帧。
   * @param frame - 基线或实时控制替换。
   */
  handleControlFrame(frame: Parameters<SessionManager['handleControlFrame']>[0]): void {
    this.manager.handleControlFrame(frame)
  }

  /**
   * 应用一个远程转发的 Session 列表新增。
   * @param summary - 新增 Session 的当前 Host 摘要。
   */
  handleSessionAdded(summary: Parameters<SessionManager['handleSessionAdded']>[0]): void {
    this.manager.handleSessionAdded(summary)
  }

  /**
   * 应用一个远程转发的 Session 移除。
   * @param sessionId - 被移除的 Session 身份。
   */
  handleSessionRemoved(sessionId: Parameters<SessionManager['handleSessionRemoved']>[0]): void {
    this.manager.handleSessionRemoved(sessionId)
  }

  /**
   * 应用一个远程转发的 running 状态变更。
   * @param args - Session 身份与当前 Agent running 状态。
   */
  handleSessionStatus(...args: Parameters<SessionManager['handleSessionStatus']>): void {
    this.manager.handleSessionStatus(...args)
  }

  /**
   * 应用一个远程转发的列表活跃度变更。
   * @param args - Session 身份与持久化活跃时间戳。
   */
  handleSessionActivity(...args: Parameters<SessionManager['handleSessionActivity']>): void {
    this.manager.handleSessionActivity(...args)
  }

  /**
   * 应用一个远程转发的 Agent 失败。
   * @param args - Session 身份与调用方可见的失败描述。
   */
  handleSessionError(...args: Parameters<SessionManager['handleSessionError']>): void {
    this.manager.handleSessionError(...args)
  }

  /** 在连接之后重建 Session 基线与每个已打开的窗口。 */
  handleConnected(): void {
    this.manager.handleConnected()
  }

  /**
   * 创建一个 Host Session，并在解析之前发布其目录行。
   * 调用方在借用其绑定前先持有返回的身份。
   * @param opts - 目标 workspace 或目录、可选的待复用空白 Session，以及可选的 Agent preset。
   * @returns 创建或复用的 session id。
   * @throws {SessionCreateError} 携带请求的 id。
   */
  async create(opts: {
    workspaceId?: WorkspaceId
    cwd?: string
    sessionId?: SessionId
    agentPreset?: string
  } = {}): Promise<SessionId> {
    const result = await this.manager.create(opts)
    if (!result.ok) throw new SessionCreateError(result.error, opts.sessionId)
    this.projectList()
    return result.value.sessionId
  }

  /**
   * 从源的一个精确且包含的前缀分叉会话（与 {@link ClientSessions.create} 相同的
   * 同步可寻址性保证：解析完成后子级被编目，可被显式持有）。
   * @param opts - 源 session id、可选的精确包含边界
   *   seq（调用方已知的真实事件 seq；开放 turn 内部的切割
   *   由 Host 侧用合成收尾事件平衡，省略则选择
   *   最近已完成 turn 的前缀）、是否在解析前递增继承的持久化标题，以及启动源迁移的许可。
   * @returns 子级 session id。
   * @throws {SessionForkError} 携带源 id。
   * @throws {Error} 当创建后请求的子级标题重命名失败时。
   */
  async fork(opts: {
    sessionId: SessionId
    atSeq?: number
    increaseTitle?: boolean
    onCreated?: (childId: SessionId) => void
    allowMigration?: boolean
  }): Promise<SessionId> {
    const sourceTitle = opts.increaseTitle
      ? this.list.getSnapshot().byId[opts.sessionId]?.title
      : undefined
    const result = await this.manager.fork({
      sessionId: opts.sessionId,
      ...(opts.atSeq === undefined ? {} : { atSeq: SessionSeq(opts.atSeq) }),
      ...(opts.allowMigration === undefined ? {} : { allowMigration: opts.allowMigration }),
    })
    if (!result.ok) throw new SessionForkError(result.error, opts.sessionId)
    this.projectList()
    const childId = result.value.sessionId
    opts.onCreated?.(childId)
    if (sourceTitle !== undefined) {
      const renamed = await this.manager.rename(childId, increasedForkTitle(sourceTitle))
      if (!renamed.ok) throw new Error(`fork child rename failed: ${renamed.error.code}: ${renamed.error.message}`)
    }
    return childId
  }

  /**
   * 借用一个已保持的 Agent 作用域 Context。
   * @param id - session id（agent 身份 —— 一一对应同一坐标轴）。
   * @returns 作用域 Context，或在没有已保持代际时返回 undefined。
   */
  scope(id: SessionId): AgentContext | undefined {
    return this.scopes.get(id)?.ctx
  }

  /**
   * 同步保持一个经校验的 Gateway 身份，无历史或目录 I/O。
   * @param id - Host 投影的 Session 身份，可能尚未编目。
   * @returns 由本次调用拥有的 Gateway 来源引用。
   */
  retainAgentScope(id: SessionId): SessionReference {
    if (this.closed) throw new Error('Session Controller is disposed')
    return this.retainScope(id, 'gateway')
  }

  /**
   * 从一个 context 读取 Agent scope 标签。服务方法分界：获取
   * bundle 必须经由 ctx.sessions 到达 scope 解析 —— 跨 bundle
   * 值导入独立 helper 会内联第二个模块实例，其私有标签 Symbol
   * 永远不匹配。
   * @param ctx - 任意 client context。
   * @returns session id，或在根 context 上返回 undefined。
   */
  scopeOf(ctx: Context): SessionId | undefined {
    return scopeTagOf(ctx)
  }

  /**
   * 解析 Agent 作用域 context 背后的业务 Session —— 每个作用域
   * 消费方（事件监听器、每 session 控制器）从 ctx 空间进入
   * 对象空间的那一跳（Host `agent.session` 的 client 镜像）。与
   * {@link ClientSessions.scopeOf} 相同的服务方法分界。
   * @param ctx - 一个 Agent 作用域 context。
   * @returns 匹配的存活 Session，或对未打标签或已结束的代际返回 undefined。
   */
  sessionOf(ctx: Context): SessionFace | undefined {
    const id = scopeTagOf(ctx)
    if (id === undefined) return undefined
    const record = this.scopes.get(id)
    return record !== undefined && scopeIdentityOf(record.ctx) === scopeIdentityOf(ctx)
      ? record.binding.session
      : undefined
  }

  /**
   * 借用一个已保持的绑定而不延长其生命周期。
   * @param id - Session 身份。
   * @returns 存活的绑定，或在没有已保持代际时返回 undefined。
   */
  binding(id: SessionId): SessionBinding | undefined {
    return this.scopes.get(id)?.binding
  }

  private retainScope(id: SessionId, source: SessionReferenceSource): ClientSessionReference {
    const record = this.scopes.get(id) ?? this.materializeScope(id)
    const previous = record.retention
    record.retention = Object.freeze({
      referenceCount: previous.referenceCount + 1,
      retainedBy: freezeRetainedBy({ ...previous.retainedBy, [source]: (previous.retainedBy[source] ?? 0) + 1 }),
    })
    const reference = new ClientSessionReference(id, record, () => {
      if (!record.live) return
      const count = record.retention.referenceCount - 1
      const { [source]: sourceCount = 0, ...otherSources } = record.retention.retainedBy
      const retainedBy = sourceCount > 1 ? { ...otherSources, [source]: sourceCount - 1 } : otherSources
      record.retention = count === 0
        ? EMPTY_RETAIN_INFO
        : Object.freeze({ referenceCount: count, retainedBy: freezeRetainedBy(retainedBy) })
      if (count === 0) this.retireScope(id, record)
      else this.publishRetention(id)
    })
    if (this.list.getSnapshot().byId[id] === undefined && this.manager.subagentAddress(id) !== undefined) {
      this.projectList()
    }
    this.publishRetention(id)
    return reference
  }

  private retentionSnapshot(id: SessionId): SessionRetainInfo {
    return this.scopes.get(id)?.retention ?? EMPTY_RETAIN_INFO
  }

  private publishRetention(id: SessionId): void {
    const state = this.list.getSnapshot()
    const row = state.byId[id]
    const retainedBy = this.retentionSnapshot(id).retainedBy
    if (row !== undefined && row.retainedBy !== retainedBy) {
      this.list.set({ ...state, byId: { ...state.byId, [id]: { ...row, retainedBy } } })
    }
    const observer = this.retainObservers.get(id)
    const snapshot = this.retentionSnapshot(id)
    if (observer === undefined || observer.published === snapshot) return
    observer.published = snapshot
    notifySubscribers(observer.listeners, '[session-controller] reference sources')
  }

  private retireScope(id: SessionId, record: ScopeRecord, disposeFiber = true): void {
    if (!record.live) return
    record.live = false
    if (this.scopes.get(id) === record) this.scopes.delete(id)
    record.session.unbindScope()
    const sessionDisposal = this.manager.drop(id, record.session)
    this.projectList()
    this.publishRetention(id)
    this.startScopeDrop(id, record, disposeFiber, sessionDisposal)
  }

  /** 在其调用方确认该 id 可被寻址之后物化一个 scope。 */
  private materializeScope(id: SessionId): ScopeRecord {
    const { fiber, ctx } = createScope(this.rootCtx, id)
    const session = this.manager.get(id)
    // Session 拥有自己的作用域分发点（Host Agent.loopCtx 镜像）；
    // 铸出与绑定是一步完成，因此存活的 scope 记录蕴含已绑定的 actx。
    session.bindScope(ctx)
    const binding: SessionBinding = { sessionId: id, session, eventSource: session.eventSource, ctx }
    const record: ScopeRecord = {
      fiber,
      ctx,
      binding,
      session,
      retention: EMPTY_RETAIN_INFO,
      live: true,
    }
    this.scopes.set(id, record)
    ctx.effect(() => () => { this.retireScope(id, record, false) }, 'session-controller: exact generation')
    return record
  }

  /** 把 manager 的列表快照投影进存储（标题推导仅用于展示）。 */
  private projectList(): void {
    const previousById = this.list.getSnapshot().byId
    const {
      items, phase, projectionsBySession,
    } = this.manager.getListSnapshot()
    const ids: SessionId[] = []
    const byId: Record<SessionId, SessionSummary> = {}
    for (const entry of items) {
      ids.push(entry.sessionId)
      byId[entry.sessionId] = {
        id: entry.sessionId,
        displayTitle: displayTitleOf(entry.title, entry.cwd, entry.sessionId),
        running: entry.running,
        retainedBy: this.retentionSnapshot(entry.sessionId).retainedBy,
        blank: entry.blank,
        updatedAt: entry.updatedAt,
        formatStatus: entry.formatStatus,
        ...(entry.projectionValues === undefined
          ? {}
          : { projectionValues: entry.projectionValues }),
        ...(entry.title !== undefined ? { title: entry.title } : {}),
        ...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}),
        ...(entry.parentSessionId !== undefined ? { parentId: entry.parentSessionId } : {}),
        ...(entry.origin !== undefined ? { origin: entry.origin } : {}),
      }
    }
    for (const [parentId, projection] of Object.entries(projectionsBySession)) {
      for (const child of projection.values.subagentCatalog ?? []) {
        if (child.mode === 'external') continue
        const childId = child.id
        const summary = byId[childId]
        const projectionValues = summary?.projectionValues ?? this.manager.projectionValues(childId)
        const projectedTitle = projectionValues?.title
        const title = typeof projectedTitle === 'string' && projectedTitle !== '' ? projectedTitle : undefined
        const displayTitle = title ?? child.label ?? childId
        if (summary === undefined) {
          byId[childId] = {
            id: childId, displayTitle, parentId: parentId as SessionId,
            origin: 'subagent', running: this.scopes.get(childId)?.session.getSnapshot().running ?? false, blank: false, updatedAt: 0,
            retainedBy: this.retentionSnapshot(childId).retainedBy,
            ...(projectionValues === undefined ? {} : { projectionValues }),
            ...(title === undefined ? {} : { title }),
          }
        } else if (summary.displayTitle !== displayTitle || summary.projectionValues !== projectionValues) {
          byId[childId] = {
            ...summary,
            displayTitle,
            ...(projectionValues === undefined ? {} : { projectionValues }),
          }
        }
      }
    }
    for (const [id, record] of this.scopes) {
      if (byId[id] !== undefined) continue
      const address = this.manager.subagentAddress(id)
      if (address === undefined) continue
      const previous = previousById[id]
      const snapshot = record.session.getSnapshot()
      const projectionValues = this.manager.projectionValues(id)
      const projectedTitle = projectionValues?.title
      const title = typeof projectedTitle === 'string' && projectedTitle !== '' ? projectedTitle : previous?.title
      byId[id] = {
        ...(previous ?? { id, displayTitle: id, updatedAt: 0 }),
        running: snapshot.running,
        retainedBy: record.retention.retainedBy,
        blank: snapshot.blank,
        parentId: address.parentSessionId,
        origin: 'subagent',
        ...(projectionValues === undefined ? {} : { projectionValues }),
        ...(title === undefined ? {} : { title, displayTitle: title }),
      }
    }
    this.list.set({ ids, byId, phase, projectionsBySession })
  }

  private startScopeDrop(
    id: SessionId,
    record: ScopeRecord,
    disposeFiber = true,
    sessionDisposal = this.manager.drop(id, record.session),
  ): void {
    const drop = this.dropScope(record, disposeFiber, sessionDisposal)
    this.scopeDrops.add(drop)
    void drop.then(
      () => { this.scopeDrops.delete(drop) },
      () => { this.scopeDrops.delete(drop) },
    )
  }

  private async drainScopeDrops(): Promise<void> {
    while (this.scopeDrops.size > 0) {
      await Promise.allSettled([...this.scopeDrops])
    }
  }

  /** 等待已撤回的 Session 与作用域清理达到静息。 */
  private async dropScope(
    record: ScopeRecord,
    disposeFiber: boolean,
    sessionDisposal: Promise<void>,
  ): Promise<void> {
    await Promise.allSettled([sessionDisposal, ...disposeFiber ? [record.fiber.dispose()] : []])
  }
}
