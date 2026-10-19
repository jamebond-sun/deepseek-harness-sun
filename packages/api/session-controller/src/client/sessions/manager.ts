/** Host 目录、持久化投影缓存与显式持有的 Client 实例。 */

import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import { SessionSeq, type SessionId, type SessionSeqCursor } from '@deepseek-ai/dsh-session/types'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type {
  SessionControlBaseline,
  SessionControlFrame,
  SessionProjectionHints,
  SessionRenameValue,
  SessionSummary,
} from '../../types.ts'
import { mergeOrderedBaseline } from '../ordered-baseline.ts'
import { isRemoteFailure } from '@deepseek-ai/dsh-api-gateway/client'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionListEntry, TitledSessionSummary } from './lineage.ts'
import { flattenLineage } from './lineage.ts'
// 纯类型合并边：标题领域的 client 命名空间出口声明了本 manager
// 投影进列表行的 'title' 投影键（以及任何 useProjection('title')
// 消费方读取的键）。按构造零值导入。
import type {} from '@deepseek-ai/dsh-session-title/client'
import { Notifier } from './notifier.ts'
import { ProjectionValueStore } from './projection-store.ts'
import { Session } from './session.ts'
import type { SessionRemotes } from './remotes.ts'
import type { SessionTarget } from '../contract/sessions.ts'

function sessionSeqCursor(value: number): SessionSeqCursor {
  return value === -1 ? -1 : SessionSeq(value)
}

/**
 * 列表到达生命周期，与拉取活跃度的 `state` 轴正交：
 * `pending`（尚无成功拉取 —— 空的 items 数组意味着"没有到达"，
 * 而不是"不存在任何会话"）→ `ready`（至少一次拉取已落地）。
 * 单调：`ready` 绝不回退 —— 之后的拉取失败与重连重新拉取
 * 走 `state`/`error` 轴，失败就建模在那里（此处没有 `error`
 * 相位；那会重复 `state`）。
 */
export type SessionListPhase = 'pending' | 'ready'

/** 返回给侧栏搜索消费方的请求局部内容命中。 */
export interface SessionSearchResultItem {
  sessionId: SessionId
  snippet: string
}

/** 供 useSessionList 使用的不可变 session 列表快照。 */
export interface SessionListSnapshot {
  items: readonly SessionListEntry[]
  state: 'idle' | 'loading' | 'error'
  /** 到达生命周期（见 {@link SessionListPhase}）；`state` 仍是拉取活跃度轴。 */
  phase: SessionListPhase
  error: RemoteFailure | null
  projectionsBySession: Readonly<Record<SessionId, SessionProjectionSnapshot>>

}

/** 共享投影值与其显式基线读取的生命周期。 */
export interface SessionProjectionSnapshot {
  readonly values: Readonly<Partial<SessionProjectionMap>>
  readonly state: 'idle' | 'loading' | 'ready' | 'migration-required' | 'error'
  readonly error: RemoteFailure | null
}

interface ProjectionInflight {
  readonly promise: Promise<void>
  readonly controller: AbortController
}

type ProjectionLoad = Omit<SessionProjectionSnapshot, 'values'>

type SessionListMutation =
  | { kind: 'upsert' | 'placeholder'; summary: SessionSummary }
  | { kind: 'remove'; sessionId: SessionId }
  | { kind: 'status'; sessionId: SessionId; running: boolean; agentAvailable: boolean }
  | { kind: 'activity'; sessionId: SessionId; updatedAt: number }
  /** 本地首次发送翻转：发送方不等 host 帧就清除 blank。 */
  | { kind: 'engaged'; sessionId: SessionId }

/** 实例集群 + 帧入口 + session 列表。 */
export class SessionManager {
  private readonly sessions = new Map<SessionId, Session>()
  /** 进行中的 Session 释放在实例离开 `sessions` 后仍留在此处，使 manager 释放可等待静息。 */
  private readonly sessionDisposals = new Set<Promise<void>>()
  /**
   * 已接纳/running 的呈现状态必须在稍后的空历史列表响应中存活。
   * Host 断言的 running 在任何行、实例或地址持有该身份之前就被记录
   * —— 本应持有它的列表可能尚未落地 —— 而客户端本地接纳回调需要
   * 当前持有者，因为它可能来自已被替换或已丢弃的 Session。
   */
  private readonly engagedSessions = new Set<SessionId>()
  private disposed = false
  /** 每 session 的投影值存储，独立于实例到达而保持（
   *  title-snapshot 先例的泛化）：推送帧无论 Session 是否实例化都落在此处
   *  （列表行读取 'title' 键），而实例化的 Session 采纳
   *  同一存储，使历史基线播种与帧汇聚到同一行集合。 */
  private readonly projectionStores = new Map<SessionId, ProjectionValueStore>()
  private summaries: SessionSummary[] = []
  private listState: 'idle' | 'loading' | 'error' = 'idle'
  /** 到达相位；pending → ready 边沿在首次成功拉取时触发（见 SessionListPhase）。 */
  private listPhase: SessionListPhase = 'pending'
  private listError: RemoteFailure | null = null
  private listInflight: Promise<void> | null = null
  /** 活跃列表请求的变更日志；其身份也在重连后守护完成。 */
  private listMutations: SessionListMutation[] | null = null
  private readonly addresses = new Map<SessionId, SubagentAddress>()
  private readonly projectionLoads = new Map<SessionId, ProjectionLoad>()
  private readonly projectionInflight = new Map<SessionId, ProjectionInflight>()


  private listSnapshotCache: SessionListSnapshot
  /** 条目身份缓存（引用稳定性）：当每个字段都匹配时，列表重建复用
   *  先前的条目对象 —— wire 刷新铸造全新 summary 对象，因此必须按值
   *  恢复身份，否则每个 SessionListItem 的 memo 在每次刷新都失效。 */
  private entryCache = new Map<SessionId, SessionListEntry>()
  private itemsCache: readonly SessionListEntry[] = []
  private readonly notifier = new Notifier(() => {
    this.listSnapshotCache = this.buildListSnapshot()
  })

  /** @param remote - 目录与历史读取器使用的生成 Remote 命名空间。 */
  constructor(private readonly remote: SessionRemotes) {
    this.listSnapshotCache = this.buildListSnapshot()
  }

  /**
   * 解析一个获取目标而不物化 Session。
   * @param target - 已知身份或持久化直接父级地址。
   * @returns 解析出的身份，并安装其显式或目录派生的历史路由。
   */
  resolveTarget(target: SessionTarget): SessionId {
    const id = typeof target === 'string' ? target : target.childSessionId
    const address = typeof target === 'string' ? this.subagentAddress(id) : target
    if (typeof target === 'string'
      && !this.sessions.has(id)
      && !this.summaries.some(summary => summary.sessionId === id)
      && address === undefined) {
      throw new Error(`sessions.retain: unknown session ${id}`)
    }
    if (address !== undefined) this.addresses.set(id, address)
    this.sessions.get(id)?.configureSubagent(
      address,
      address === undefined
        ? undefined
        : this.agentAvailable(address.parentSessionId),
    )
    return id
  }

  /**
   * 为面包屑导航解析一个地址，而不持有传输层权威。
   * @param sessionId - 收到的 Session 元数据中可能的子级 id。
   * @returns 持有中的地址，然后是目录地址，再是从已列出
   *   subagent 头部得到的未知模式地址；没有该证据时返回 undefined。
   */
  subagentAddress(sessionId: SessionId): SubagentAddress | undefined {
    const retained = this.addresses.get(sessionId)
    if (retained !== undefined) return retained
    for (const parentSessionId of this.projectionStores.keys()) {
      const child = this.projectionStores.get(parentSessionId)?.values().subagentCatalog
        ?.find(entry => entry.id === sessionId)
      if (child !== undefined && child.mode !== 'external') {
        return {
          parentSessionId,
          childSessionId: sessionId,
          mode: child.mode,
        }
      }
    }
    const summary = this.summaries.find(summary => summary.sessionId === sessionId)
    if (summary?.origin !== 'subagent' || summary.parentSessionId === undefined) return undefined
    return {
      parentSessionId: summary.parentSessionId,
      childSessionId: sessionId,
      mode: 'unknown',
    }
  }

  // ---- 实例管理 ----

  /**
   * 在运行清理回调之前撤回一个精确的 Client 实例。
   * @param sessionId - 要撤回的身份。
   * @param expected - 正在释放的实例；替换实例保持不动。
   * @returns 已分离实例的流清理完成。
   */
  drop(sessionId: SessionId, expected: Session): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session !== expected) return Promise.resolve()
    this.sessions.delete(sessionId)
    this.addresses.delete(sessionId)
    this.pruneEngagement(sessionId, this.retainedIds(this.summaries))
    return this.startSessionDisposal(session)
  }

  /**
   * 停止目录请求并释放每个常驻 Session。
   * @returns 在目录请求与每个 Session 流都停止之后。
   */
  async dispose(): Promise<void> {
    this.disposed = true
    this.listMutations = null
    this.listInflight = null
    this.engagedSessions.clear()
    const reads = [...this.projectionInflight.values()]
    for (const { controller } of reads) controller.abort()
    this.projectionInflight.clear()
    await Promise.all(reads.map(read => read.promise))
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    this.addresses.clear()
    for (const session of sessions) void this.startSessionDisposal(session)
    await this.drainSessionDisposals()
  }

  private startSessionDisposal(session: Session): Promise<void> {
    const disposal = session.dispose()
    this.sessionDisposals.add(disposal)
    void disposal.then(
      () => { this.sessionDisposals.delete(disposal) },
      () => { this.sessionDisposals.delete(disposal) },
    )
    return disposal
  }

  private async drainSessionDisposals(): Promise<void> {
    while (this.sessionDisposals.size > 0) {
      await Promise.allSettled([...this.sessionDisposals])
    }
  }

  /**
   * 惰性构建：返回既有实例或构造一个（不自动打开 ——
   * 引用分配器在绑定 scope 之后打开历史）。
   * 新实例在返回前调和已保持的元数据。
   * @param sessionId - 要获取的 session。
   * @returns 常驻实例。
   */
  get(sessionId: SessionId): Session {
    let session = this.sessions.get(sessionId)
    if (session === undefined) {
      session = this.createSession(sessionId)
      this.sessions.set(sessionId, session)
      // 把列表快照中的 running 与 blank 位同步进新
      // 实例（列表先于打开时的一致性）。
      const summary = this.summaries.find(s => s.sessionId === sessionId)
      if (summary !== undefined) {
        session.handleBlank(this.effectiveBlank(summary))
        session.handleRunning(summary.running)
      } else {
        const address = this.addresses.get(sessionId)
        const child = address === undefined ? undefined : this.projectionStores.get(address.parentSessionId)?.values().subagentCatalog
          ?.find(entry => entry.id === sessionId)
        if (child !== undefined && child.mode !== 'external') {
          // 已编目子级只有在其受委派 session 拥有
          // 持久化历史之后才存在，尽管子级行不携带 `blank`。
          session.handleBlank(false)
          session.handleRunning(false)
        } else {
          // 已保持元数据可能在本 Session 存在之前通知过。
          session.handleBlank(true)
        }
      }
    }
    return session
  }

  private createSession(sessionId: SessionId): Session {
    const address = this.addresses.get(sessionId)
    const parentAvailable = address === undefined
      ? undefined
      : this.agentAvailable(address.parentSessionId)
    return new Session(sessionId, this.remote, {
      ...(address === undefined ? {} : {
        address,
        ...parentAvailable === undefined ? {} : { parentAvailable },
      }),
      // 发送方的本地首次发送翻转镜像进列表行，使 session 展示面
      // （列表按 blank 过滤）在任何 host 帧落地之前可见。
      onEngaged: (engaged) => {
        if (this.disposed || !this.retainedIds(this.summaries).has(engaged.sessionId)) return
        // 已在账本上的身份不需要第二次行变更。
        if (!this.engagedSessions.has(engaged.sessionId)) {
          this.engagedSessions.add(engaged.sessionId)
          this.recordMutation({ kind: 'engaged', sessionId: engaged.sessionId })
        }
        this.sessions.get(engaged.sessionId)?.handleBlank(false)
      },
      projections: this.projectionStore(sessionId),
    })
  }

  private effectiveBlank(summary: SessionSummary): boolean {
    return summary.blank && !this.engagedSessions.has(summary.sessionId)
  }

  /**
   * 一次接可能仍归属的身份：给定列表行、常驻
   * Session 实例与已持有的子级地址。
   * @param summaries - 调用方快照的列表行。
   * @returns 已保持的身份集合。
   */
  private retainedIds(summaries: readonly SessionSummary[]): Set<SessionId> {
    const retained = new Set(summaries.map(summary => summary.sessionId))
    for (const sessionId of this.sessions.keys()) retained.add(sessionId)
    for (const sessionId of this.addresses.keys()) retained.add(sessionId)
    return retained
  }

  /**
   * 遗忘一次没有任何已保持身份持有的接纳。
   * @param sessionId - 其接可能被丢弃的身份。
   * @param retained - 调用方快照的 {@link retainedIds} 身份。
   */
  private pruneEngagement(sessionId: SessionId, retained: ReadonlySet<SessionId>): void {
    if (!retained.has(sessionId)) this.engagedSessions.delete(sessionId)
  }

  /** 常驻的每 session 投影存储（按需创建；生命周期长于实例化）。 */
  private projectionStore(sessionId: SessionId): ProjectionValueStore {
    let store = this.projectionStores.get(sessionId)
    if (store === undefined) {
      store = new ProjectionValueStore()
      const projections = store
      store.subscribeAny(() => {
        // 更新的历史或控制元数据纠正常驻 Session 的过期列表提示。
        if (projections.values().sessionListMetadata?.blank === false) {
          this.sessions.get(sessionId)?.handleBlank(false)
        }
        this.notifier.markDirty()
      })
      this.projectionStores.set(sessionId, store)
    }
    return store
  }

  /**
   * 读取投影而不启动迁移；重试失败或因迁移被推迟的读取。
   * @param sessionId - 要检查的 Session，不打开其会话内容。
   * @returns 当前读取或新启动读取的完成。
   */
  refreshProjections(sessionId: SessionId): Promise<void> {
    const existing = this.projectionInflight.get(sessionId)
    if (existing !== undefined) return existing.promise
    if (this.projectionLoads.get(sessionId)?.state === 'ready') return Promise.resolve()
    const controller = new AbortController()
    const store = this.projectionStore(sessionId)
    const initialValues = store.values()
    this.projectionLoads.set(sessionId, { state: 'loading', error: null })
    this.notifier.markDirty()
    const operation = (async () => {
      try {
        const result = await this.remote.session.projections({ sessionId }, controller.signal)
        if (controller.signal.aborted) return
        if (result.ok) {
          const value = result.value
          if (value !== null) {
            switch (value.kind) {
              case 'sequenced':
                store.seed({ values: value.values, asOfSeq: sessionSeqCursor(value.asOfSeq) })
                break
              case 'migration-required':
                store.applyCached(value.values)
                break
              default:
                assertNever(value, 'session projections result')
            }
          } else if (store.values() === initialValues) {
            // 后来的帧独立于较早的缺失读取证明存在。
            store.clear()
          }
          this.projectionLoads.set(sessionId, {
            state: value?.kind === 'migration-required' ? 'migration-required' : 'ready',
            error: null,
          })
        } else {
          this.projectionLoads.set(sessionId, { state: 'error', error: result.error })
        }
      } catch (error: unknown) {
        if (controller.signal.aborted) return
        if (!isRemoteFailure(error)) throw error
        this.projectionLoads.set(sessionId, { state: 'error', error })
      } finally {
        if (!controller.signal.aborted) {
          this.projectionInflight.delete(sessionId)
          this.notifier.markDirty()
        }
      }
    })()
    this.projectionInflight.set(sessionId, { promise: operation, controller })
    return operation
  }

  private agentAvailable(sessionId: SessionId): boolean | undefined {
    return this.summaries.find(summary => summary.sessionId === sessionId)?.agentAvailable
      ?? (this.listPhase === 'ready' ? false : undefined)
  }

  private updateParentAvailability(): void {
    for (const [childId, address] of this.addresses) {
      const available = this.agentAvailable(address.parentSessionId)
      if (available !== undefined) this.sessions.get(childId)?.handleSubagentParentAvailable(available)
    }
  }

  // ---- 列表 API ----

  /** 经由 session.list 的完整刷新（单个 Host 代际内单飞）。 */
  refreshList(): Promise<void> {
    if (this.listInflight !== null) return this.listInflight
    this.listState = 'loading'
    this.listError = null
    const established = this.summaries
    const mutations: SessionListMutation[] = []
    this.listMutations = mutations
    this.notifier.markDirty()
    this.listInflight = (async () => {
      try {
        const result = await this.remote.session.list({})
        if (this.listMutations !== mutations) return
        if (result.ok) {
          const baseline: SessionSummary[] = this.listPhase === 'pending'
            ? [...result.value.items]
            : mergeOrderedBaseline(established, result.value.items, summary => summary.sessionId)
          // 一次移除取代拉取中观察到的 running，包括重新添加之后。
          const removedSincePull = new Set<SessionId>()
          for (const mutation of mutations) {
            if (mutation.kind === 'remove') removedSincePull.add(mutation.sessionId)
          }
          for (const s of baseline) {
            if (s.running && !removedSincePull.has(s.sessionId)) this.engagedSessions.add(s.sessionId)
          }
          const summaries = mutations.reduce(applyMutation, baseline)
          this.summaries = summaries
          // 完整列表可以在没有移除帧的情况下移除身份。
          const retained = this.retainedIds(summaries)
          for (const sessionId of this.engagedSessions) this.pruneEngagement(sessionId, retained)
          this.listState = 'idle'
          this.listPhase = 'ready'
          this.updateParentAvailability()
          // 常驻 Session 与列表行共享一个展示 blank，并与元数据投影调和。
          for (const s of this.summaries) {
            const session = this.sessions.get(s.sessionId)
            if (session === undefined) continue
            session.handleBlank(this.effectiveBlank(s))
            session.handleRunning(s.running)
          }
          // 把每行的投影块落进每 session 的值存储
          // （冷标题无需打开 session 即可呈现）。列表块是
          // 部分的 —— 只有其来源持有的键 —— 因此缺席的键绝不
          // 清除；当前键如何合并取决于块的 kind。
          for (const s of result.value.items) {
            if (s.projections !== undefined) this.applyListBlock(s.sessionId, s.projections)
          }
        } else {
          this.listState = 'error'
          this.listError = result.error
        }
      } catch (error) {
        if (!isRemoteFailure(error)) throw error
        if (this.listMutations !== mutations) return
        this.listState = 'error'
        this.listError = error
      } finally {
        if (this.listMutations === mutations) {
          this.listMutations = null
          this.listInflight = null
          this.notifier.markDirty()
        }
      }
    })()
    return this.listInflight
  }

  /**
   * 搜索可见的 session 消息内容，而不向列表快照添加瞬态
   * 查询状态。
   * @param query - 非空字面短语。
   * @param signal - 被取代 UI 查询的取消信号。
   * @returns Host 结果或折叠后的传输层错误。
   */
  async search(
    query: string,
    signal: AbortSignal,
  ): Promise<RemoteResult<{ items: SessionSearchResultItem[]; hasMore: boolean }>> {
    const result = await this.remote.session.search({ query }, signal)
    if (!result.ok) return result
    return {
      ok: true,
      value: {
        items: [...result.value.items],
        hasMore: result.value.hasMore,
      },
    }
  }

  /**
   * 对应 contract session.create；成功时立即合并进 summaries（
   * 不等待下一次刷新）。创建的 session 按定义是空白的
   * （实体诞生先于第一条消息）。
   * @param opts - 目标 workspace 或工作目录、可选的待复用空白 Session，以及可选的 Agent preset。
   * @returns 创建结果，指明 Host 创建或复用的 Session。
  */
  async create(
    opts: {
      workspaceId?: WorkspaceId
      cwd?: string
      sessionId?: SessionId
      agentPreset?: string
    } = {},
  ): Promise<RemoteResult<{ sessionId: SessionId }>> {
    const shared = {
      ...(opts.sessionId === undefined ? {} : { sessionId: opts.sessionId }),
      ...(opts.agentPreset === undefined ? {} : { agentPreset: opts.agentPreset }),
    }
    const payload = opts.workspaceId !== undefined
      ? { workspaceId: opts.workspaceId, ...shared }
      : { ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }), ...shared }
    const result = await this.remote.session.create(payload)
    if (result.ok) {
      this.recordMutation({ kind: 'placeholder', summary: { agentAvailable: true,
        sessionId: result.value.sessionId, updatedAt: Date.now(), running: false, blank: true,
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      } })
    } else {
      const publishedSessionId = workspaceAttachSessionId(result.error)
      // 发布先于附接。错误里的 id 是一个真实 Session，
      // 因此立即把它暴露为 Ungrouped，调用方保留提示词缓冲并
      // 决定是否重试附接。
      if (publishedSessionId !== undefined) {
        this.recordMutation({ kind: 'placeholder', summary: { agentAvailable: true,
          sessionId: publishedSessionId,
          updatedAt: Date.now(),
          running: false,
          blank: true,
        } })
      }
    }
    return result
  }

  /**
   * 对应 contract session.fork；成功时立即把子级合并进
   * summaries（与 create 相同的同步可寻址性保证）。
   * 空白初始暂定为 true，让权威的 Host 摘要得以保留它，或在
   * 首个 `turn/start` 之前的精确切割后把它降低；谱系经由
   * parentSessionId 承载。在 Workspace 附接失败之前已发布的子级
   * 也会被调和进列表。
   * @param opts - 源 session、可选的精确包含边界 seq，以及启动迁移的许可。
   * @returns 分叉结果（子级 session id）。
   */
  async fork(
    opts: { sessionId: SessionId; atSeq?: SessionSeq; allowMigration?: boolean },
  ): Promise<RemoteResult<{ sessionId: SessionId }>> {
    const source = this.summaries.find(s => s.sessionId === opts.sessionId)
    const result = await this.remote.session.fork({
      sessionId: opts.sessionId,
      ...opts.atSeq === undefined ? {} : { atSeq: opts.atSeq },
      ...opts.allowMigration === undefined ? {} : { allowMigration: opts.allowMigration },
    })
    const childId = result.ok
      ? result.value.sessionId
      : workspaceAttachSessionId(result.error)
    if (childId !== undefined) {
      this.recordMutation({ kind: 'placeholder', summary: { agentAvailable: true,
        sessionId: childId, updatedAt: Date.now(), running: false, blank: true,
        parentSessionId: opts.sessionId,
        ...(source?.cwd !== undefined ? { cwd: source.cwd } : {}),
      } })
    }
    return result
  }

  /**
   * 重命名一个 Session 并更新其标题投影，而不打开其历史。
   * @param sessionId - 要重命名的 Session。
   * @param title - 供 Host 规范化的原始标题文本。
   * @returns 已接纳标题与事件位置，或 Remote 失败。
   */
  async rename(sessionId: SessionId, title: string): Promise<RemoteResult<SessionRenameValue>> {
    const result = await this.remote.session.rename({ sessionId, title })
    if (result.ok) {
      this.projectionStore(sessionId).apply('title', result.value.title, SessionSeq(result.value.seq))
    }
    return result
  }

  /**
   * 合并一个 Host 摘要，替换实时状态并填充缺失元数据。
   * 本地 create/fork 占位只填充既有行的元数据。
   */
  private mergeSummary(summary: SessionSummary): void {
    this.recordMutation({ kind: 'upsert', summary })
    this.updateParentAvailability()
  }

  /** 立即应用并在列表响应进行中时保留以供重放。 */
  private recordMutation(mutation: SessionListMutation): void {
    if (this.disposed) return
    this.listMutations?.push(mutation)
    this.summaries = applyMutation(this.summaries, mutation)
    this.notifier.markDirty()
  }

  // ---- 订阅 API（供 useSessionList 使用） ----

  /**
   * useSessionList 的 uSES 订阅入口。
   * @param listener - 变更回调。
   * @returns 取消订阅函数。
   */
  subscribe(listener: () => void): () => void {
    return this.notifier.subscribe(listener)
  }

  /**
   * 缓存的列表快照（脏且无监听器时惰性重建）。
   * @returns 缓存的引用（直到下一次刷新前保持稳定）。
   */
  getListSnapshot(): SessionListSnapshot {
    this.notifier.ensureFresh()
    return this.listSnapshotCache
  }

  /**
   * 读取一个可能仅存在于已加载 subagent 目录中的 Session 的缓存投影值。
   * @param sessionId - 其控制或历史基线供出了投影的 Session。
   * @returns 当前值，或在任何投影存储存在前返回 undefined。
   */
  projectionValues(sessionId: SessionId): Readonly<Partial<SessionProjectionMap>> | undefined {
    return this.projectionStores.get(sessionId)?.values()
  }

  // ---- 实时控制与 Host 事件槽 ----

  /**
   * 应用完整的控制基线或一个稍后的替换帧。
   * @param frame - 来自 Session Controller 的基线或实时控制替换。
   */
  handleControlFrame(frame: SessionControlFrame): void {
    if (frame.type === 'baseline') {
      this.replaceControlBaseline(frame.value)
      return
    }
    this.projectionStore(frame.sessionId).apply(frame.key, frame.value, SessionSeq(frame.seq))
    this.notifier.markDirty()
  }

  private replaceControlBaseline(baseline: SessionControlBaseline): void {

    for (const [sessionId, block] of Object.entries(baseline.projections)) {
      const store = this.projectionStore(sessionId as SessionId)
      const asOfSeq = sessionSeqCursor(block.asOfSeq)
      store.seed({ ...block, asOfSeq })
    }
    this.notifier.markDirty()
  }

  /**
   * 应用一条经 `ctx.remote.$on` 转发的 Session 列表新增。
   * @param summary - 新增 Session 的当前 Host 摘要。
   */
  handleSessionAdded(summary: SessionSummary): void {
    this.mergeSummary(summary)
    if (!this.disposed && summary.running) this.engagedSessions.add(summary.sessionId)
    this.sessions.get(summary.sessionId)?.handleBlank(this.effectiveBlank(summary))
    if (summary.projections !== undefined) this.applyListBlock(summary.sessionId, summary.projections)
  }

  /**
   * 按列表层投影块声明的序列空间合并一个块。
   * `sequenced` 块来自 Host 对已附接 Session 的实时注册表，
   * 因此每个键按更高 seq 优先落地，与该 Session 的基线和帧比较。
   * `cached` 块来自仅头部的列表对持久化检查点的一次视图：
   * 其水位线与本连接的 seq 不可比较，因此只填充没有
   * sequenced 行持有的键。
   */
  private applyListBlock(sessionId: SessionId, block: SessionProjectionHints): void {
    const store = this.projectionStore(sessionId)
    switch (block.kind) {
      case 'sequenced': {
        const seq = sessionSeqCursor(block.asOfSeq)
        for (const [key, value] of Object.entries(block.values)) store.apply(key, value, seq)
        return
      }
      case 'cached':
        store.applyCached(block.values)
        return
      default:
        assertNever(block.kind, 'session list projection block kind')
    }
  }

  /**
   * 应用一条经 `ctx.remote.$on` 转发的 Session 移除。
   * @param sessionId - 被移除的 Session 身份。
   */
  handleSessionRemoved(sessionId: SessionId): void {
    const durableSubagent = this.subagentAddress(sessionId) !== undefined
      || this.summaries.some(summary => summary.sessionId === sessionId && summary.origin === 'subagent')
    this.recordMutation(durableSubagent
      ? { kind: 'status', sessionId, running: false, agentAvailable: false }
      : { kind: 'remove', sessionId })
    if (durableSubagent) this.sessions.get(sessionId)?.handleRunning(false)
    else this.sessions.get(sessionId)?.handleRemoved()
    const catalog = this.projectionStores.get(sessionId)?.values().subagentCatalog
    if (!durableSubagent && (catalog === undefined || catalog.length === 0)) {
      this.projectionStores.delete(sessionId)
    }
    this.pruneEngagement(sessionId, this.retainedIds(this.summaries))
    this.projectionInflight.get(sessionId)?.controller.abort()
    this.projectionInflight.delete(sessionId)
    this.projectionLoads.delete(sessionId)
    for (const [childId, address] of this.addresses) {
      if (address.parentSessionId === sessionId) {
        this.sessions.get(childId)?.handleSubagentParentAvailable(false)
      }
    }
  }

  /**
   * 应用一次实时 Agent running 状态变更。
   * @param sessionId - 其 Agent 状态变更的 Session。
   * @param running - 当前 Agent running 状态。
   */
  handleSessionStatus(sessionId: SessionId, running: boolean): void {
    if (!this.disposed && running) this.engagedSessions.add(sessionId)
    this.recordMutation({ kind: 'status', sessionId, running, agentAvailable: true })
    this.updateParentAvailability()
    this.sessions.get(sessionId)?.handleRunning(running)
  }

  /**
   * 从一条用户编写的持久化消息推进 Session 列表活跃度。
   * @param sessionId - 其活跃度变更的 Session。
   * @param updatedAt - 持久化消息时间戳。
   */
  handleSessionActivity(sessionId: SessionId, updatedAt: number): void {
    this.recordMutation({ kind: 'activity', sessionId, updatedAt })
  }

  /**
   * 把一次实时 Agent 失败呈现在已物化的 Session 上。
   * @param sessionId - 其 Agent 失败的 Session。
   * @param message - 调用方可见的失败描述。
   */
  handleSessionError(sessionId: SessionId, message: string): void {
    this.sessions.get(sessionId)?.handleAgentError(message)
  }

  /**
   * 用可查询基线修复一个重建的 Host 事件代际。
   * 在新查询之前丢弃旧的投影切口，包括不在进程本地
   * 控制基线中的冷 Session。
   * 已打开的 Session 跟随流经由 API Gateway 独立恢复。
   */
  handleConnected(): void {
    for (const store of this.projectionStores.values()) store.clear()
    this.listMutations = null
    this.listInflight = null
    void this.refreshList()
    const parents = new Set(this.projectionLoads.keys())
    for (const id of this.sessions.keys()) {
      const address = this.addresses.get(id)
      if (address !== undefined) parents.add(address.parentSessionId)
    }
    for (const { controller } of this.projectionInflight.values()) controller.abort()
    this.projectionInflight.clear()
    this.projectionLoads.clear()
    for (const parentSessionId of parents) void this.refreshProjections(parentSessionId)
  }

  private buildListSnapshot(): SessionListSnapshot {
    const merged: TitledSessionSummary[] = this.summaries.map((summary) => {
      // 列表行读取通用的 'title' 投影键（host 计算的单元
      // 值；没有专用的标题帧）。
      const projectionStore = this.projectionStores.get(summary.sessionId)
      const title = projectionStore?.get('title')
      const projectionValues = projectionStore?.values()
      const metadata = projectionValues?.sessionListMetadata
      return {
        ...summary,
        // 缓存的列表提示可能先于历史打开或控制更新。
        blank: this.effectiveBlank(summary) && metadata?.blank !== false,
        updatedAt: Math.max(summary.updatedAt, metadata?.lastPromptAt ?? 0),
        ...(typeof title === 'string' && title !== '' ? { title } : {}),
        ...(projectionValues === undefined ? {} : { projectionValues }),
      }
    })
    const fresh = flattenLineage(merged)
    const items = fresh.map((entry) => {
      const prev = this.entryCache.get(entry.sessionId)
      if (
        prev !== undefined && prev.updatedAt === entry.updatedAt && prev.running === entry.running
        && prev.blank === entry.blank
        && prev.parentSessionId === entry.parentSessionId && prev.cwd === entry.cwd
        && prev.origin === entry.origin && prev.title === entry.title && prev.depth === entry.depth
        && prev.formatStatus === entry.formatStatus
        && prev.projectionValues === entry.projectionValues
      ) return prev
      this.entryCache.set(entry.sessionId, entry)
      return entry
    })
    const itemIds = new Set(items.map(entry => entry.sessionId))
    for (const id of this.entryCache.keys()) {
      if (!itemIds.has(id)) this.entryCache.delete(id)
    }
    const sameOrder = items.length === this.itemsCache.length && items.every((e, i) => e === this.itemsCache[i])
    if (!sameOrder) this.itemsCache = items
    return {
      items: this.itemsCache,
      state: this.listState,
      phase: this.listPhase,
      error: this.listError,
      projectionsBySession: Object.fromEntries([...this.projectionStores].map(([sessionId, store]) => [
        sessionId,
        { values: store.values(), state: 'idle', error: null, ...this.projectionLoads.get(sessionId) },
      ])),
    }
  }
}

/** 应用一个列表变更而不推导展示顺序。 */
function applyMutation(summaries: readonly SessionSummary[], mutation: SessionListMutation): SessionSummary[] {
  switch (mutation.kind) {
    case 'upsert':
    case 'placeholder': {
      const existing = summaries.find(summary => summary.sessionId === mutation.summary.sessionId)
      if (existing === undefined) return [mutation.summary, ...summaries]
      const filled: SessionSummary = {
        ...existing,
        // blank 只能降低：过期的 true（session-added 与本地
        // 首次发送竞速）绝不会重新隐藏已呈现的 session。
        blank: existing.blank && mutation.summary.blank,
        ...(mutation.kind === 'upsert' ? {
          agentAvailable: mutation.summary.agentAvailable,
          running: mutation.summary.running,
          ...(mutation.summary.formatStatus === undefined ? {} : { formatStatus: mutation.summary.formatStatus }),
        } : {}),
        ...(existing.cwd === undefined && mutation.summary.cwd !== undefined ? { cwd: mutation.summary.cwd } : {}),
        ...(existing.parentSessionId === undefined && mutation.summary.parentSessionId !== undefined
          ? { parentSessionId: mutation.summary.parentSessionId } : {}),
        ...(existing.origin === undefined && mutation.summary.origin !== undefined
          ? { origin: mutation.summary.origin } : {}),
      }
      if (filled.cwd === existing.cwd && filled.parentSessionId === existing.parentSessionId
        && filled.origin === existing.origin && filled.blank === existing.blank
        && filled.agentAvailable === existing.agentAvailable && filled.running === existing.running
        && filled.formatStatus === existing.formatStatus
      ) return [...summaries]
      return summaries.map(summary => summary.sessionId === mutation.summary.sessionId ? filled : summary)
    }
    case 'remove':
      return summaries.filter(summary => summary.sessionId !== mutation.sessionId)
    case 'status':
      // running 转换展示状态；它不确立持久化历史。
      return summaries.map(summary => summary.sessionId === mutation.sessionId
        && (summary.running !== mutation.running
          || summary.agentAvailable !== mutation.agentAvailable || (mutation.running && summary.blank))
        ? { ...summary, running: mutation.running, agentAvailable: mutation.agentAvailable, blank: summary.blank && !mutation.running }
        : summary)
    case 'activity':
      return summaries.map(summary => summary.sessionId === mutation.sessionId
        && mutation.updatedAt > summary.updatedAt
        ? { ...summary, updatedAt: mutation.updatedAt }
        : summary)
    case 'engaged':
      return summaries.map(summary => summary.sessionId === mutation.sessionId && summary.blank
        ? { ...summary, blank: false }
        : summary)
  }
}

/** Host contract 与 client 投影独立构建期间的临时 source-plane 桥。 */
function workspaceAttachSessionId(error: RemoteFailure): SessionId | undefined {
  return error.code === 'session/workspace-attach-failed' ? error.details.sessionId : undefined
}
