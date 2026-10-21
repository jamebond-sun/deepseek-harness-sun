/**
 * 工作区实体注册表（`ctx.workspaceRegistry`）：持久化的工作区记录、
 * 稳定的注册表顺序，以及基于域数据形式的头部校验的会话成员资格。
 * @module @deepseek-ai/dsh-workspace
 */

import { randomUUID } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'
import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { DomainGlobal, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { WorkspaceEntity } from './entity.ts'
import type { WorkspaceEntityHost } from './entity.ts'

export { WorkspaceMoveInvalidError } from './entity.ts'
import { defaultWorkspaceTitle, fullyQualifiedWorkspacePath, realpathNormalize } from './paths.ts'
import { workspaceDomainSpec } from './spec.ts'
import type { WorkspaceDomainState, WorkspaceRecord } from './spec.ts'
import type { SessionActivity, Workspace, WorkspaceId as WorkspaceIdBrand } from './types.ts'

export type {
  SessionActivity, SessionActivityItem, SessionActivityKind, SessionActivityKindMap, Workspace,
} from './types.ts'
export { workspaceDomainState, workspaceRecord, workspaceDomainSpec } from './spec.ts'
export type { WorkspaceDomainState, WorkspaceRecord } from './spec.ts'
export { realpathNormalize } from './paths.ts'

/** 标识一条工作区记录（品牌缘由见 `src/types.ts`）。 */
export type WorkspaceId = WorkspaceIdBrand

/**
 * 将一个字符串打上 {@link WorkspaceId} 品牌。
 * @param id - 原始的工作区 id 字符串。
 * @returns 同一个字符串，在编译期被打上品牌。
 */
export function WorkspaceId(id: string): WorkspaceId {
  return id as WorkspaceId
}

/**
 * archiveSession 或 pinSession 请求指定了一个既非活动、
 * 也不在会话持久化中的会话——仅为明确的缺失；存储故障按原样传播。
 */
export class WorkspaceUnknownSessionError extends Error {
  /**
   * @param sessionId - 未知的会话 id。
   * @param verb - 指定该会话的注册表操作。
   */
  constructor(readonly sessionId: SessionId, verb: 'archive' | 'pin') {
    super(`cannot ${verb} session '${sessionId}': live sessions and session persistence hold no such session`)
    this.name = 'WorkspaceUnknownSessionError'
  }
}

/**
 * archiveSession 请求指定了一个至少被一个
 * `workspace/session-activity` 监听器报告为活动的会话。未写入任何内容；
 * `activity` 列出了在该会话可被归档前必须停止的内容。
 */
export class WorkspaceActiveSessionError extends Error {
  /**
   * @param sessionId - 活动的会话 id。
   * @param activity - 报告的活动，按监听器顺序。
   */
  constructor(readonly sessionId: SessionId, readonly activity: readonly SessionActivity[]) {
    super(`cannot archive session '${sessionId}': the session is active (${activity.map(entry => entry.kind).join(', ')})`)
    this.name = 'WorkspaceActiveSessionError'
  }
}

/** pinSession 请求指定了一个当前位于归档集合中的会话；固定与归档互斥。 */
export class WorkspaceArchivedSessionPinError extends Error {
  /**
   * @param sessionId - 已归档的会话 id。
   */
  constructor(readonly sessionId: SessionId) {
    super(`cannot pin session '${sessionId}': the session is archived`)
    this.name = 'WorkspaceArchivedSessionPinError'
  }
}

/** 工作区重排序指定了一个缺失于持久化注册表顺序的源或锚点。 */
export class WorkspaceOrderInvalidError extends Error {
  /**
   * @param workspaceId - 缺失的源或锚点 id。
   */
  constructor(readonly workspaceId: WorkspaceId) {
    super(`cannot reorder unknown workspace '${workspaceId}'`)
    this.name = 'WorkspaceOrderInvalidError'
  }
}


/** 归档请求即将写入归档集合的会话。 */
export interface SessionActivityRequest {
  readonly sessionId: SessionId
}

/** {@link WorkspaceRegistry.archiveSession} 的调用方选项。 */
export interface ArchiveSessionOptions {
  /**
   * 要求组合后的提供方停止该会话正在运行的工作，而非
   * 因此拒绝归档。先写入归档，然后
   * 请求停止；运行中的工作从不被等待到结算，且
   * 提供方失败时只会记录日志，不会撤销归档。
   */
  readonly stopActivity?: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    workspaceRegistry: WorkspaceRegistry
  }

  interface Events {
    /**
     * 在会话被归档前，询问组合后的提供方该会话还有哪些工作在运行。
     * 监听器将自身的 {@link SessionActivity} 条目前置到
     * `next()` 的结果之前；注册表最内层的回调返回空列表，
     * 因此没有提供方的组合可自由归档。任何非空结果都会
     * 在不写入的情况下拒绝归档。
     * @param request - 即将被归档的会话。
     * @param next - 委托给其余的提供方。
     * @mode waterfall
     */
    'workspace/session-activity'(
      request: SessionActivityRequest,
      next: () => Promise<readonly SessionActivity[]>,
    ): Promise<readonly SessionActivity[]>
    /**
     * 因为调用方以 `stopActivity` 归档而停止该会话正在运行的工作；
     * 分发此事件时归档集合已持久化。每个提供方通过其自身
     * 的族——取消一个回合、其子代理后代、其拥有的任务或活动的计划——
     * 经由用户自身停止动作所使用的同一取消路径来停止，
     * 从而使会话日志正常结束每一个开放回合，且之后的解除归档可继续对话。
     * 监听器发出停止请求时不会等待运行中的工作结算；监听器可等待其自身的持久化屏障。
     * 拒绝由注册表记录日志，且不会撤销归档。
     * @param request - 正在被归档的会话。
     * @mode parallel
     */
    'workspace/session-stop'(request: SessionActivityRequest): Promise<void> | void
  }
}

interface BootstrapGroup {
  readonly path: string
  readonly headers: SessionHeader[]
  readonly newestAt: number
}

const sameIds = (left: readonly WorkspaceId[], right: readonly WorkspaceId[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index])

const compareHeaders = (left: SessionHeader, right: SessionHeader): number =>
  right.createdAt - left.createdAt || String(left.id).localeCompare(String(right.id))

/**
 * 持久化的工作区注册表。启动时会等待 `sessionPersistence`，
 * 构建一个规范化 cwd 的头部索引，并在服务生效前完成一次性的历史
 * 引导。持久化依赖是强制性的，这样不可用的对等方绝不会被误认为
 * 空历史并提交 initialized 标记。
 */
export class WorkspaceRegistry extends Service {
  static inject = ['storageDomain', 'sessionPersistence']

  private table?: KvTable<WorkspaceId, WorkspaceRecord>
  private global?: DomainGlobal<WorkspaceDomainState>
  private state?: WorkspaceDomainState
  private readonly entities = new Map<WorkspaceId, WorkspaceEntity>()
  private readonly headers = new Map<SessionId, SessionHeader>()
  private readonly sessionPaths = new Map<SessionId, string>()
  private readonly missingSessionPaths = new Set<SessionId>()
  private readonly invalidSessionPaths = new Map<SessionId, string>()
  private operationTail: Promise<void> = Promise.resolve()

  private readonly host: WorkspaceEntityHost = {
    table: () => this.requireTable(),
    candidateMatches: (id, path) => this.sessionPaths.get(id) === path || this.missingSessionPaths.has(id),
    readSessionHeader: id => this.readSessionHeader(id),
    rememberSessionPath: (id, path) => {
      this.sessionPaths.set(id, path)
      this.missingSessionPaths.delete(id)
      this.invalidSessionPaths.delete(id)
    },
  }

  constructor(ctx: Context) {
    super(ctx, 'workspaceRegistry')
  }

  /** 打开域，需要时完成引导，并重建有序缓存。 */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(workspaceDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'workspace.domainClose')
    this.table = domain.table('workspaces')
    this.global = domain.global
    this.state = domain.global.get()

    await this.recoverPendingMutation()
    this.validateStoredState(this.state)
    if (!this.state.initialized) {
      const headers = await this.listStoredHeaders()
      await this.replaceHeaderIndex(headers)
      await this.bootstrap(headers)
    } else if (this.table.size > 0) {
      await this.replaceHeaderIndex(await this.listStoredHeaders())
    }

    await this.indexLiveSessions()
    this.validateStoredState(this.requireState())
    this.rebuildEntities()
    this.reportFilteredCandidates()
  }

  /**
   * 为现有目录创建或复用工作区。完全限定的路径通过 `fs.realpath`
   * 规范化；相对、不存在或非目录的路径会被拒绝。对同一规范化路径的
   * 重复调用会返回现有实体而不更改其标题。
   * 新创建的工作区会被前置到持久化注册表顺序的头部。
   * 不同的规范化路径可以共享显示标题。
   * @param path - 要拥有的现有目录，以完全限定路径形式给出。
   * @param title - 仅在新记录创建时使用的显示标题。
   * @returns 现有的或新持久化的工作区。
   */
  // TODO: 当网关的 create-by-name 分支被删除时，`title` 失去了它最后一个生产调用方
  // (.agents/notes/archived/simplification/2026-07-31-one-route-to-add-a-workspace.md)；
  // 请连同其 @param 子句以及本包 README 对中的 `create(path, title?)`
  // 行一起移除该参数。
  async create(path: string, title?: string): Promise<Workspace> {
    const canonical = await realpathNormalize(path)
    if (!(await stat(canonical)).isDirectory()) {
      throw new Error(`cannot create a workspace at '${canonical}': path is not a directory`)
    }
    return await this.enqueueOperation(() => this.createCanonical(canonical, title))
  }

  /**
   * 仅在注册表与会话历史都为空时初始化默认工作区。重复的请求会复用其
   * 持久化身份；删除该注册会永久禁用自动创建。
   * @param resolveDirectory - 解析绝对目录；仅在符合创建条件时、
   * 在注册表变更队列内调用。注册前会递归创建缺失的目录，且初始标题为
   * 所请求目录自身的最后一段——而非规范化路径的那一段，这样该路径上的
   * 符号链接在其目标之后不会重新命名工作区。
   * 解析之后，调用方取消不会回滚创建或注册。
   * @returns 已初始化的工作区；当自动创建不符合条件时为 undefined。
   */
  initializeDefault(resolveDirectory: () => Promise<string>): Promise<Workspace | undefined> {
    return this.enqueueOperation(async () => {
      const state = this.requireState()
      if (state.defaultWorkspaceId !== undefined) return this.entities.get(state.defaultWorkspaceId)
      const sessions = this.ctx.get('sessions')
      if (sessions === undefined) throw new Error('default Workspace initialization requires the Session store')
      if (state.workspaceIds.length > 0 || state.archivedSessionIds.length > 0
        || sessions.list().length > 0 || (await this.listStoredHeaders()).length > 0) return undefined

      const path = await resolveDirectory()
      if (!fullyQualifiedWorkspacePath(path)) throw new TypeError(`Workspace path is not fully qualified: '${path}'`)
      await mkdir(path, { recursive: true })
      const canonical = await realpathNormalize(path)
      // 在目录准备等待 I/O 期间，一个会话可能在注册表队列之外启动。
      if ((await this.listStoredHeaders()).length > 0 || sessions.list().length > 0) return undefined
      return this.createCanonical(canonical, defaultWorkspaceTitle(path), true)
    })
  }

  /**
   * 按 id 查找工作区。
   * @param id - 工作区 id。
   * @returns 该工作区；未知时为 `undefined`。
   */
  get(id: WorkspaceId): Workspace | undefined {
    return this.entities.get(id)
  }

  /**
   * 按持久化注册表顺序的同步工作区投影。每个实体的
   * `sessionIds` getter 已被启动期/活动期的规范化 cwd 头部索引过滤；
   * 此方法不执行任何持久化读取。
   * @returns 一个全新的有序工作区实体数组。
   */
  list(): Workspace[] {
    return this.requireState().workspaceIds.map((id) => {
      const entity = this.entities.get(id)
      if (entity === undefined) {
        throw new Error(`workspace registry order references missing workspace '${id}'`)
      }
      return entity
    })
  }

  /**
   * 删除一条工作区注册，同时保留其目录与每条会话日志。持久化顺序会在
   * 表删除之前更新；失败的表写入会恢复先前的顺序并保持该实体
   * 已发布。对域调用方而言，未知的 id 是一次幂等的空操作。
   * @param id - 要移除的工作区注册。
   * @returns 删除记录时为 `true`，未知时为 `false`。
   */
  delete(id: WorkspaceId): Promise<boolean> {
    return this.enqueueOperation(() => this.deleteKnown(id))
  }

  /**
   * 在持久化显示顺序中移动一个工作区，类似 DOM 的 insertBefore。
   * 给定锚点时落在该工作区之前；未给定时追加到末尾。
   * @param id - 要移动的工作区。
   * @param beforeId - 工作区锚点；省略则追加。
   * @returns 完整的已提交工作区顺序。
   */
  insertBefore(id: WorkspaceId, beforeId?: WorkspaceId): Promise<readonly WorkspaceId[]> {
    return this.enqueueOperation(async () => {
      const state = this.requireState()
      if (!state.workspaceIds.includes(id)) throw new WorkspaceOrderInvalidError(id)
      if (beforeId !== undefined && !state.workspaceIds.includes(beforeId)) {
        throw new WorkspaceOrderInvalidError(beforeId)
      }
      if (beforeId === id) return state.workspaceIds
      const without = state.workspaceIds.filter(workspaceId => workspaceId !== id)
      const at = beforeId === undefined ? without.length : without.indexOf(beforeId)
      const workspaceIds = [...without.slice(0, at), id, ...without.slice(at)]
      if (sameIds(workspaceIds, state.workspaceIds)) return state.workspaceIds
      await this.setState({ ...state, workspaceIds })
      return workspaceIds
    })
  }

  /**
   * 注册表全局的归档集合：从每个分组界面隐藏的会话。归档从不会触及工作区
   * 记账——已归档的会话保留其 `sessionIds` 槽位，以便解除归档时恢复其位置。
   * @returns 按归档顺序的已归档会话 id。
   */
  get archivedSessionIds(): readonly SessionId[] {
    return this.requireState().archivedSessionIds
  }

  /**
   * 持久化地归档一个会话。该会话必须存在（活动或在会话持久化中）；其工作区
   * 记账——或缺乏记账——与此无关。
   * 在缺少 `stopActivity` 时，该会话还必须是非活动的：会一次性询问
   * `workspace/session-activity` 瀑布，任何被报告的
   * 活动都会在写入任何内容前以 {@link WorkspaceActiveSessionError} 拒绝。
   * 在带有 `stopActivity` 时，会在不检查活动的情况下写入归档，
   * 随后要求 `workspace/session-stop` 的提供方停止该会话的工作：
   * 持久化的归档集合正是提供方的 `agent/pre-step` 门所读取的内容，
   * 因此停止所引发的每次唤醒都已被阻断。归档会在同一次持久化写入中
   * 丢弃该会话的固定（固定与归档互斥）。已归档的 id
   * 会在不写入、不询问、不停止的情况下解析。
   * @param sessionId - 要归档的会话。
   * @param options - 是否停止运行中的工作而非拒绝。
   * @returns 在持久化之后、且在带有 `stopActivity` 时每次停止请求发出之后的解析结果。
   */
  archiveSession(sessionId: SessionId, options: ArchiveSessionOptions = {}): Promise<void> {
    return this.enqueueOperation(async () => {
      // 链槽会相对于所有其他注册表写入进行串行化，因此这个
      // 先检查后写入的配对不会与另一次归档交错。
      if (this.requireState().archivedSessionIds.includes(sessionId)) return
      if (!(await this.sessionKnown(sessionId))) {
        throw new WorkspaceUnknownSessionError(sessionId, 'archive')
      }
      if (options.stopActivity !== true) {
        const activity = await this.ctx.waterfall(
          'workspace/session-activity', { sessionId }, () => Promise.resolve([]),
        )
        if (activity.length > 0) throw new WorkspaceActiveSessionError(sessionId, activity)
      }
      const state = this.requireState()
      await this.setState({
        ...state,
        archivedSessionIds: [...state.archivedSessionIds, sessionId],
        pinnedSessionIds: state.pinnedSessionIds.filter(id => id !== sessionId),
      })
      if (options.stopActivity === true) await this.stopSessionActivity(sessionId)
    })
  }

  /**
   * 通过将其从注册表全局归档集合中移除，持久化地解除一个会话的归档；
   * 记账槽位从未被触碰，因此该会话会回到其记录的位置。解除归档
   * 不执行会话存在性检查，因为移除一个 id 不可能引入未知的 id，
   * 因此会话已消失的条目仍会解析。未归档的 id
   * 会在不写入的情况下解析。
   * @param sessionId - 要解除归档的会话。
   * @returns 在持久化之后的解析结果。
   */
  unarchiveSession(sessionId: SessionId): Promise<void> {
    return this.enqueueOperation(async () => {
      // 链槽会相对于所有其他注册表写入进行串行化，因此这个
      // 先检查后写入的配对不会与并发的归档交错。
      const state = this.requireState()
      if (!state.archivedSessionIds.includes(sessionId)) return
      await this.setState({
        ...state,
        archivedSessionIds: state.archivedSessionIds.filter(id => id !== sessionId),
      })
    })
  }

  /**
   * 注册表全局的固定集合：在分组界面上排在所有未固定会话之前的会话。
   * 固定从不会触及工作区记账。
   * @returns 按固定顺序的会话 id（最近固定的在最前）。
   */
  get pinnedSessionIds(): readonly SessionId[] {
    return this.requireState().pinnedSessionIds
  }

  /**
   * 持久化地固定一个会话，将其前置到注册表全局固定集合。
   * 该会话必须存在（活动或在会话持久化中）且不能已被归档。
   * 已固定的 id 会在不写入或重排的情况下解析。
   * @param sessionId - 要固定的会话。
   * @returns 在持久化之后的解析结果。
   */
  pinSession(sessionId: SessionId): Promise<void> {
    return this.enqueueOperation(async () => {
      // 链槽会相对于所有其他注册表写入进行串行化，因此这个
      // 先检查后写入的配对不会与另一次固定或归档交错。
      if (this.requireState().pinnedSessionIds.includes(sessionId)) return
      if (this.requireState().archivedSessionIds.includes(sessionId)) {
        throw new WorkspaceArchivedSessionPinError(sessionId)
      }
      if (!(await this.sessionKnown(sessionId))) {
        throw new WorkspaceUnknownSessionError(sessionId, 'pin')
      }
      const state = this.requireState()
      await this.setState({
        ...state,
        pinnedSessionIds: [sessionId, ...state.pinnedSessionIds],
      })
    })
  }

  /**
   * 通过将其从注册表全局固定集合中移除，持久化地取消固定一个会话。
   * 取消固定不执行会话存在性检查，因为移除一个 id 不可能引入未知的 id，
   * 因此会话已消失的条目仍会解析。未固定的 id 会在不写入的情况下解析。
   * @param sessionId - 要取消固定的会话。
   * @returns 在持久化之后的解析结果。
   */
  unpinSession(sessionId: SessionId): Promise<void> {
    return this.enqueueOperation(async () => {
      // 链槽会相对于所有其他注册表写入进行串行化，因此这个
      // 先检查后写入的配对不会与并发的固定交错。
      const state = this.requireState()
      if (!state.pinnedSessionIds.includes(sessionId)) return
      await this.setState({
        ...state,
        pinnedSessionIds: state.pinnedSessionIds.filter(id => id !== sessionId),
      })
    })
  }

  /**
   * 一个会话是否为活动的、已建立头部索引的，或出现在一次新鲜
   * 持久化清单中。只有明确的缺失才会返回 false——失败的
   * `sessionPersistence.list()` 会向上传播，这样存储故障永远不会
   * 伪装成未知的会话。
   */
  private async sessionKnown(id: SessionId): Promise<boolean> {
    if (this.ctx.get('sessions')?.get(id) !== undefined) return true
    if (this.headers.has(id)) return true
    await this.indexHeaders(await this.listStoredHeaders())
    return this.headers.has(id)
  }

  /** 请求每个提供方停止；失败的提供方会被记录日志，但绝不作为保持会话可见的理由。 */
  private async stopSessionActivity(sessionId: SessionId): Promise<void> {
    try {
      await this.ctx.parallel('workspace/session-stop', { sessionId })
    } catch (error: unknown) {
      // ctx.parallel 会等待每个监听器完成，并以一个 AggregateError 拒绝。
      /* v8 ignore next -- 普通分支守卫着一个重新抛出的分发器。 */
      const failures = error instanceof AggregateError ? error.errors : [error]
      for (const failure of failures) {
        this.ctx.logger.warn(`workspace: stopping session '${sessionId}' for archive failed: ${String(failure)}`)
      }
    }
  }

  /**
   * 通过规范化目录路径解析，而不创建或变更一个工作区。缺失的路径会在
   * `realpath` 期间被拒绝；一个已存在但未被拥有的目录返回 `undefined`。
   * @param path - 以完全限定形式给出的现有目录路径。
   * @returns 拥有该规范化路径的工作区（当其存在时）。
   */
  async resolveByPath(path: string): Promise<Workspace | undefined> {
    const canonical = await realpathNormalize(path)
    for (const entity of this.entities.values()) {
      if (entity.path === canonical) return entity
    }
    return undefined
  }

  private async createCanonical(canonical: string, title?: string, firstUse = false): Promise<WorkspaceEntity> {
    for (const entity of this.entities.values()) {
      if (entity.path === canonical) return entity
    }

    const workspaceName = title ?? defaultWorkspaceTitle(canonical)
    const table = this.requireTable()
    const state = this.requireState()
    const id = WorkspaceId(randomUUID())
    const now = new Date().toISOString()
    const record: WorkspaceRecord = {
      path: canonical,
      title: workspaceName,
      sessionIds: [],
      createdAt: now,
      updatedAt: now,
    }
    const entity = new WorkspaceEntity(this.host, id, record)
    this.entities.set(id, entity)
    const pendingState: WorkspaceDomainState = {
      ...state,
      pendingMutation: { operation: 'create', workspaceId: id },
    }
    try {
      await this.setState(pendingState)
    } catch (error) {
      this.entities.delete(id)
      throw error
    }
    try {
      await table.put(id, record)
    } catch (error) {
      this.entities.delete(id)
      try {
        await this.setState(state)
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `workspace '${id}' record write and pending-marker rollback both failed`,
        )
      }
      throw error
    }

    try {
      await this.setState({
        ...state,
        pendingMutation: undefined,
        initialized: true,
        ...(firstUse ? { defaultWorkspaceId: id } : {}),
        workspaceIds: [id, ...state.workspaceIds],
      })
    } catch (error) {
      this.entities.delete(id)
      try {
        await table.delete(id)
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `workspace '${id}' order write and record rollback both failed; the pending marker remains recoverable`,
        )
      }
      try {
        await this.setState(state)
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `workspace '${id}' order write and pending-marker rollback both failed`,
        )
      }
      throw error
    }
    return entity
  }

  private async deleteKnown(id: WorkspaceId): Promise<boolean> {
    const entity = this.entities.get(id)
    if (entity === undefined) return false
    const state = this.requireState()
    const nextState = {
      ...state,
      pendingMutation: undefined,
      initialized: true,
      workspaceIds: state.workspaceIds.filter(workspaceId => workspaceId !== id),
    }
    await this.setState({
      ...nextState,
      pendingMutation: { operation: 'delete', workspaceId: id },
    })
    this.entities.delete(id)
    try {
      await this.requireTable().delete(id)
    } catch (error) {
      this.entities.set(id, entity)
      try {
        await this.setState(state)
      } catch (rollbackError) {
        // 持久化标记仍然指示要完成删除，因此缓存必须
        // 与这一可恢复的方向保持一致，而非重新发布一条
        // 不在已持久化顺序中的行。
        this.entities.delete(id)
        throw new AggregateError(
          [error, rollbackError],
          `workspace '${id}' record deletion and registry-order rollback both failed`,
        )
      }
      throw error
    }
    try {
      await this.setState(nextState)
    } catch (error) {
      // 删除已在表写入时提交，并已发布
      // 到 Host 流。保留持久化标记用于启动恢复，而非在
      // 所请求的状态已变为真之后报告失败。
      this.ctx.logger.warn(
        `workspace '${id}' was deleted but its pending marker could not be cleared: ${String(error)}`,
      )
    }
    return true
  }

  /**
   * 完成由持久化状态明确命名的一次变更。无法解释的顺序/表
   * 分歧仍会到达 {@link validateStoredState} 并大声失败；
   * 此路径绝不会仅凭行的形状去猜测是哪个操作创建了它。
   */
  private async recoverPendingMutation(): Promise<void> {
    const state = this.requireState()
    const pending = state.pendingMutation
    if (pending === undefined) return
    if (state.workspaceIds.includes(pending.workspaceId)) {
      throw new Error(
        `workspace domain is inconsistent: pending ${pending.operation} workspace `
        + `'${pending.workspaceId}' is still present in registry order`,
      )
    }
    await this.requireTable().delete(pending.workspaceId)
    await this.setState({ ...state, pendingMutation: undefined })
  }

  private async bootstrap(headers: readonly SessionHeader[]): Promise<void> {
    const table = this.requireTable()
    const state = this.requireState()
    const groupsByPath = new Map<string, SessionHeader[]>()
    for (const header of headers) {
      const path = this.sessionPaths.get(header.id)
      if (path === undefined) continue
      const group = groupsByPath.get(path)
      if (group === undefined) groupsByPath.set(path, [header])
      else group.push(header)
    }
    const groups: BootstrapGroup[] = [...groupsByPath].map(([path, groupHeaders]) => {
      groupHeaders.sort(compareHeaders)
      const newest = groupHeaders[0] as SessionHeader
      return { path, headers: groupHeaders, newestAt: newest.createdAt }
    }).sort((left, right) =>
      right.newestAt - left.newestAt || left.path.localeCompare(right.path))

    const byPath = new Map<string, WorkspaceId>()
    const accounted = new Map<SessionId, WorkspaceId>()
    for (const [id, record] of table.entries()) {
      byPath.set(record.path, id)
      for (const sessionId of record.sessionIds) accounted.set(sessionId, id)
    }

    for (const group of groups) {
      let id = byPath.get(group.path)
      if (id === undefined) {
        const sessionIds = group.headers
          .map(header => header.id)
          .filter(sessionId => !accounted.has(sessionId))
        if (sessionIds.length === 0) continue
        id = WorkspaceId(randomUUID())
        const createdAt = new Date(group.newestAt).toISOString()
        const record: WorkspaceRecord = {
          path: group.path,
          title: defaultWorkspaceTitle(group.path),
          sessionIds,
          createdAt,
          updatedAt: createdAt,
        }
        await table.put(id, record)
        byPath.set(group.path, id)
        for (const sessionId of sessionIds) accounted.set(sessionId, id)
        continue
      }

      const current = table.get(id) as WorkspaceRecord
      const historical = group.headers
        .map(header => header.id)
        .filter(sessionId => accounted.get(sessionId) === undefined || accounted.get(sessionId) === id)
      const historicalSet = new Set(historical)
      const sessionIds = [
        ...historical,
        ...current.sessionIds.filter(sessionId => !historicalSet.has(sessionId)),
      ]
      if (sameSessionIds(current.sessionIds, sessionIds)) continue
      await table.update(id, record => ({
        ...record,
        sessionIds,
        updatedAt: new Date().toISOString(),
      }))
      for (const sessionId of historical) accounted.set(sessionId, id)
    }

    const groupRank = new Map(groups.map(group => [group.path, group.newestAt]))
    const priorRank = new Map(state.workspaceIds.map((id, index) => [id, index]))
    const workspaceIds = [...table.entries()]
      .sort(([leftId, left], [rightId, right]) => {
        const leftTime = groupRank.get(left.path) ?? Date.parse(left.createdAt)
        const rightTime = groupRank.get(right.path) ?? Date.parse(right.createdAt)
        return rightTime - leftTime
          || (priorRank.get(leftId) ?? Number.MAX_SAFE_INTEGER)
            - (priorRank.get(rightId) ?? Number.MAX_SAFE_INTEGER)
          || String(leftId).localeCompare(String(rightId))
      })
      .map(([id]) => id)

    if (!sameIds(state.workspaceIds, workspaceIds)) {
      await this.setState({
        initialized: false,
        workspaceIds,
        archivedSessionIds: state.archivedSessionIds,
        pinnedSessionIds: state.pinnedSessionIds,
      })
    }
    await this.setState({
      initialized: true,
      workspaceIds,
      archivedSessionIds: state.archivedSessionIds,
      pinnedSessionIds: state.pinnedSessionIds,
    })
  }

  private validateStoredState(state: WorkspaceDomainState): void {
    const table = this.requireTable()
    const order = new Set<WorkspaceId>()
    for (const id of state.workspaceIds) {
      if (order.has(id)) {
        throw new Error(`workspace domain is inconsistent: registry order repeats workspace '${id}'`)
      }
      if (table.get(id) === undefined) {
        throw new Error(`workspace domain is inconsistent: registry order references missing workspace '${id}'`)
      }
      order.add(id)
    }
    if (state.initialized && order.size !== table.size) {
      const orphan = [...table.keys()].find(id => !order.has(id))
      throw new Error(
        `workspace domain is inconsistent: workspace '${orphan as WorkspaceId}' is absent from registry order`,
      )
    }

    const paths = new Map<string, WorkspaceId>()
    const accounted = new Map<SessionId, WorkspaceId>()
    for (const [id, record] of table.entries()) {
      const pathHolder = paths.get(record.path)
      if (pathHolder !== undefined) {
        throw new Error(
          `workspace domain is inconsistent: path '${record.path}' is claimed `
          + `by both workspace '${pathHolder}' and workspace '${id}'`,
        )
      }
      paths.set(record.path, id)
      for (const sessionId of record.sessionIds) {
        const holder = accounted.get(sessionId)
        if (holder !== undefined) {
          throw new Error(
            `workspace domain is inconsistent: session '${sessionId}' is accounted `
            + `by both workspace '${holder}' and workspace '${id}'`,
          )
        }
        accounted.set(sessionId, id)
      }
    }
  }

  private rebuildEntities(): void {
    this.entities.clear()
    for (const id of this.requireState().workspaceIds) {
      const record = this.requireTable().get(id) as WorkspaceRecord
      this.entities.set(id, new WorkspaceEntity(this.host, id, record))
    }
  }

  private async replaceHeaderIndex(headers: readonly SessionHeader[]): Promise<void> {
    this.headers.clear()
    this.sessionPaths.clear()
    this.missingSessionPaths.clear()
    this.invalidSessionPaths.clear()
    await this.indexHeaders(headers)
  }

  private async indexHeaders(headers: readonly SessionHeader[]): Promise<void> {
    for (const header of headers) await this.indexHeader(header)
  }

  private async indexHeader(header: SessionHeader): Promise<void> {
    this.headers.set(header.id, header)
    this.sessionPaths.delete(header.id)
    this.missingSessionPaths.delete(header.id)
    if (header.cwd === undefined) {
      this.invalidSessionPaths.set(header.id, 'header has no cwd')
      return
    }
    try {
      const path = await realpathNormalize(header.cwd)
      if (!(await stat(path)).isDirectory()) {
        this.invalidSessionPaths.set(header.id, `cwd '${header.cwd}' is not a directory`)
        return
      }
      this.sessionPaths.set(header.id, path)
      this.invalidSessionPaths.delete(header.id)
    } catch (error) {
      if (fullyQualifiedWorkspacePath(header.cwd)
        && error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        this.missingSessionPaths.add(header.id)
      }
      this.invalidSessionPaths.set(header.id, `cwd '${header.cwd}' does not resolve`)
    }
  }

  /** 每条已存储会话的头部，从持久化快照清单投影而来。 */
  private async listStoredHeaders(): Promise<SessionHeader[]> {
    const snapshots = await this.ctx.sessionPersistence.list()
    return snapshots.map(snapshot => snapshot.header)
  }

  private async indexLiveSessions(): Promise<void> {
    const sessions = this.ctx.get('sessions')
    if (sessions === undefined) return
    await this.indexHeaders(sessions.list().map(session => session.header))
  }

  private reportFilteredCandidates(): void {
    for (const entity of this.entities.values()) {
      const record = this.requireTable().get(entity.id) as WorkspaceRecord
      for (const sessionId of record.sessionIds) {
        if (this.host.candidateMatches(sessionId, record.path)) continue
        const path = this.sessionPaths.get(sessionId)
        const reason = this.invalidSessionPaths.get(sessionId)
          ?? (this.headers.has(sessionId)
            ? `canonical cwd '${path}' differs from workspace path '${record.path}'`
            : 'session header is missing')
        this.ctx.logger.warn(
          `workspace '${entity.id}' filtered session '${sessionId}' from membership: ${reason}`,
        )
      }
    }
  }

  private async readSessionHeader(id: SessionId): Promise<SessionHeader> {
    const live = this.ctx.get('sessions')?.get(id)
    if (live !== undefined) {
      this.headers.set(id, live.header)
      return live.header
    }
    const cached = this.headers.get(id)
    if (cached !== undefined) return cached

    const headers = await this.listStoredHeaders()
    await this.indexHeaders(headers)
    const header = this.headers.get(id)
    if (header === undefined) {
      throw new Error(`cannot validate session '${id}': session persistence holds no such session`)
    }
    return header
  }

  private requireTable(): KvTable<WorkspaceId, WorkspaceRecord> {
    if (this.table === undefined) throw new Error('workspace registry is not started yet')
    return this.table
  }

  private requireState(): WorkspaceDomainState {
    if (this.state === undefined) throw new Error('workspace registry is not started yet')
    return this.state
  }

  private async setState(state: WorkspaceDomainState): Promise<void> {
    await (this.global as DomainGlobal<WorkspaceDomainState>).set(state)
    this.state = state
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(async () => {
      // 一次已提交的删除可能只留下其标记清理待处理。在另一次创建/删除
      // 覆盖那条待处理操作记录之前重试恢复。
      await this.recoverPendingMutation()
      return await operation()
    })
    this.operationTail = result.then(() => {}, () => {})
    return result
  }
}

const sameSessionIds = (left: readonly SessionId[], right: readonly SessionId[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index])

export default WorkspaceRegistry
