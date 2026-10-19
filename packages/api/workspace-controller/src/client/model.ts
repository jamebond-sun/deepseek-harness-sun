/** 由 Remote 传输与 UI 投影共享的 Client 侧 Workspace 状态模型。 */

import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/remote'
import { isRemoteFailure } from '@deepseek-ai/dsh-api-gateway/client'
import type { RemoteFailure, RemoteResult, TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type {
  WorkspaceArchiveSessionRequest,
  WorkspaceArchiveValue,
  WorkspaceBaseline,
  WorkspaceCreateRequest,
  WorkspaceCreateValue,
  WorkspaceDeleteValue,
  WorkspaceInsertSessionBeforeRequest,
  WorkspaceOrderValue,
  WorkspacePinSessionRequest,
  WorkspacePinValue,
  WorkspaceUnarchiveSessionRequest,
  WorkspaceUnpinSessionRequest,
  WorkspaceValue,
  WorkspaceId,
  WorkspaceView,
} from '../types.ts'

/** 生成的完整 `ctx.remote.workspace` 命名空间。 */
export type WorkspaceRemote = TypertClientRemote['workspace']

/** 单调的 Workspace 列表到达生命周期。 */
export type WorkspaceListPhase = 'pending' | 'ready'

/** 不可变的 Client Workspace 状态。 */
export interface WorkspaceSnapshot {
  readonly items: readonly WorkspaceView[]
  /** Host 顺序下的完整注册表全局归档集合。 */
  readonly archivedSessionIds: WorkspaceArchiveValue['archivedSessionIds']
  /** 完整的注册表全局置顶集合，最近置顶的在前。 */
  readonly pinnedSessionIds: WorkspacePinValue['pinnedSessionIds']
  readonly state: 'idle' | 'loading' | 'error'
  readonly phase: WorkspaceListPhase
  readonly error: RemoteFailure | null
}

/** 解码后的 Workspace follow 生成所发出的状态操作。 */
export interface WorkspaceFollowSink {
  /** 以生成基线替换全部状态。 */
  replaceBaseline(value: WorkspaceBaseline): void
  /** 合并一个 Workspace 行。 */
  upsertView(workspace: WorkspaceView): void
  /** 移除一个 Workspace 行。 */
  removeView(workspaceId: WorkspaceId): void
  /** 替换 Host 确认的 Workspace 顺序。 */
  replaceOrder(workspaceIds: readonly WorkspaceId[]): void
  /** 替换完整的已归档 Session 集合。 */
  replaceArchived(sessionIds: WorkspaceArchiveValue['archivedSessionIds']): void
  /** 替换完整的已置顶 Session 集合。 */
  replacePinned(pinnedSessionIds: WorkspacePinValue['pinnedSessionIds']): void
}

/**
 * 持有 Client Workspace 投影、变更回显，以及流/一元竞争的消解。
 */
export class ClientWorkspaceModel implements WorkspaceFollowSink {
  private items: readonly WorkspaceView[] = []
  private archivedSessionIds: WorkspaceArchiveValue['archivedSessionIds'] = []
  private pinnedSessionIds: WorkspacePinValue['pinnedSessionIds'] = []
  private state: WorkspaceSnapshot['state'] = 'loading'
  private phase: WorkspaceListPhase = 'pending'
  private error: RemoteFailure | null = null
  /** 最近的本地重排请求；只有其对应的一元回显可以安装顺序。 */
  private orderRequestGeneration = 0
  /** 流顺序到来时递增，使更晚的远端提交胜过更早的一元回显。 */
  private orderFrameGeneration = 0
  /** 从基线、增量或当前一元回显接受的最近完整顺序。 */
  private committedOrder: WorkspaceId[] = []
  /** 最近的归档集合请求；更晚的请求或推送的集合会取代它。 */
  private archiveRequestSeq = 0
  /** 最近的置顶集合请求；更晚的请求或推送的集合会取代它。 */
  private pinRequestSeq = 0
  /** Host Workspace id 从不复用，因此迟到的数据无法复活已移除的行。 */
  private readonly removedIds = new Set<WorkspaceId>()
  private readonly listeners = new Set<() => void>()
  private snapshotCache: WorkspaceSnapshot
  private snapshotDirty = false
  private notificationPending = false
  private notificationScheduled = false
  private notificationGeneration = 0

  /** @param remote - 生成的 Workspace Remote 命名空间。 */
  constructor(private readonly remote: WorkspaceRemote) {
    this.snapshotCache = this.buildSnapshot()
  }

  /**
   * 创建或解析一个 Workspace，并立即合并一元结果。
   * @param input - 要收编的现有绝对路径。
   * @returns 生成的 Remote 结果。
   */
  async create(input: WorkspaceCreateRequest): Promise<RemoteResult<WorkspaceCreateValue>> {
    const result = await this.remote.create(input)
    if (result.ok) this.upsert(result.value.workspace)
    return result
  }

  /**
   * 初始化默认 Workspace 并合并其权威行。
   * @param signal - 调用方生命周期。
   * @returns 生成的 Remote 结果。
   */
  async initializeDefault(signal?: AbortSignal): Promise<RemoteResult<WorkspaceValue | undefined>> {
    const result = await this.remote.initializeDefault(signal)
    if (result.ok && result.value !== undefined) this.upsert(result.value.workspace)
    return result
  }

  /**
   * 重命名一个 Workspace 并立即合并一元结果。
   * @param workspaceId - 目标 Workspace。
   * @param title - 新显示标题。
   * @returns 生成的 Remote 结果。
   */
  async rename(workspaceId: WorkspaceId, title: string): Promise<RemoteResult<WorkspaceValue>> {
    const result = await this.remote.rename({ workspaceId, title })
    if (result.ok) this.upsert(result.value.workspace)
    return result
  }

  /**
   * 删除一个 Workspace 并立即将其从本地投影移除。
   * @param workspaceId - 目标 Workspace。
   * @returns 生成的 Remote 结果。
   */
  async delete(workspaceId: WorkspaceId): Promise<RemoteResult<WorkspaceDeleteValue>> {
    const result = await this.remote.delete({ workspaceId })
    if (result.ok) this.remove(workspaceId, true)
    return result
  }

  /**
   * 乐观地移动一个 Workspace，并与返回的完整顺序和解。
   * @param workspaceId - 要移动的 Workspace。
   * @param beforeWorkspaceId - 锚点 Workspace；省略时追加到末尾。
   * @returns 生成的 Remote 结果。
   */
  async insertBefore(
    workspaceId: WorkspaceId,
    beforeWorkspaceId?: WorkspaceId,
  ): Promise<RemoteResult<WorkspaceOrderValue>> {
    const requestGeneration = ++this.orderRequestGeneration
    const frameGeneration = this.orderFrameGeneration
    const localOrder = this.items.map(workspace => workspace.workspaceId)
    this.installOrder(insertIdBefore(localOrder, workspaceId, beforeWorkspaceId))
    const result = await this.remote.insertBefore({
      workspaceId,
      ...beforeWorkspaceId === undefined ? {} : { beforeWorkspaceId },
    })
    if (requestGeneration === this.orderRequestGeneration
      && frameGeneration === this.orderFrameGeneration) {
      this.installOrder(result.ok ? result.value.workspaceIds : this.committedOrder, result.ok)
    }
    return result
  }

  /**
   * 在其 Workspace 内移动一个 Session 并合并返回的行。
   * @param workspaceId - 所属 Workspace。
   * @param sessionId - 要移动的已归入 Session。
   * @param beforeSessionId - 已归入的锚点；省略时追加到末尾。
   * @returns 生成的 Remote 结果。
   */
  async insertSessionBefore(
    workspaceId: WorkspaceInsertSessionBeforeRequest['workspaceId'],
    sessionId: WorkspaceInsertSessionBeforeRequest['sessionId'],
    beforeSessionId?: WorkspaceInsertSessionBeforeRequest['beforeSessionId'],
  ): Promise<RemoteResult<WorkspaceValue>> {
    const result = await this.remote.insertSessionBefore({
      workspaceId,
      sessionId,
      ...beforeSessionId === undefined ? {} : { beforeSessionId },
    })
    if (result.ok) this.upsert(result.value.workspace)
    return result
  }

  /**
   * 归档一个 Session，并安装返回的完整归档集合。
   * 被更晚的归档请求或推送集合取代的应答不安装任何内容。
   * @param sessionId - 要归档的 Session。
   * @param options - Host 是否停止该 Session 的运行中工作而非拒绝。
   * @returns 生成的 Remote 结果。
   */
  async archiveSession(
    sessionId: WorkspaceArchiveSessionRequest['sessionId'],
    options: Pick<WorkspaceArchiveSessionRequest, 'stopActivity'> = {},
  ): Promise<RemoteResult<WorkspaceArchiveValue>> {
    const requestSeq = ++this.archiveRequestSeq
    const result = await this.remote.archiveSession({
      sessionId,
      ...(options.stopActivity === true ? { stopActivity: true } : {}),
    })
    if (result.ok && requestSeq === this.archiveRequestSeq) {
      this.installArchived(result.value.archivedSessionIds)
      // Host 在同一次持久写入中移除已归档 session 的置顶；
      // 本地镜像该行为，使任何帧都不会把该行同时显示为已归档与已置顶。
      this.installPinned(this.pinnedSessionIds.filter(id => id !== sessionId))
    }
    return result
  }

  /**
   * 取消归档一个 Session，并安装返回的完整归档集合。
   * 被更晚的归档请求或推送集合取代的应答不安装任何内容。
   * @param sessionId - 要取消归档的 Session。
   * @returns 生成的 Remote 结果。
   */
  async unarchiveSession(
    sessionId: WorkspaceUnarchiveSessionRequest['sessionId'],
  ): Promise<RemoteResult<WorkspaceArchiveValue>> {
    const requestSeq = ++this.archiveRequestSeq
    const result = await this.remote.unarchiveSession({ sessionId })
    if (result.ok && requestSeq === this.archiveRequestSeq) {
      this.installArchived(result.value.archivedSessionIds)
    }
    return result
  }

  /**
   * 置顶一个 Session，并安装返回的完整置顶集合。
   * 被更晚的置顶请求或推送集合取代的应答不安装任何内容。
   * @param sessionId - 要置顶的 Session。
   * @returns 生成的 Remote 结果。
   */
  async pinSession(
    sessionId: WorkspacePinSessionRequest['sessionId'],
  ): Promise<RemoteResult<WorkspacePinValue>> {
    const requestSeq = ++this.pinRequestSeq
    const result = await this.remote.pinSession({ sessionId })
    if (result.ok && requestSeq === this.pinRequestSeq) {
      this.installPinned(result.value.pinnedSessionIds)
    }
    return result
  }

  /**
   * 取消置顶一个 Session，并安装返回的完整置顶集合。
   * 被更晚的置顶请求或推送集合取代的应答不安装任何内容。
   * @param sessionId - 要取消置顶的 Session。
   * @returns 生成的 Remote 结果。
   */
  async unpinSession(
    sessionId: WorkspaceUnpinSessionRequest['sessionId'],
  ): Promise<RemoteResult<WorkspacePinValue>> {
    const requestSeq = ++this.pinRequestSeq
    const result = await this.remote.unpinSession({ sessionId })
    if (result.ok && requestSeq === this.pinRequestSeq) {
      this.installPinned(result.value.pinnedSessionIds)
    }
    return result
  }

  /**
   * 以一个完整的流生成基线替换投影。
   * @param baseline - 完整的 Workspace 与归档投影。
   */
  replaceBaseline(baseline: WorkspaceBaseline): void {
    this.orderFrameGeneration++
    this.archiveRequestSeq++
    this.pinRequestSeq++
    this.installViews(baseline.items)
    this.installArchived(baseline.archivedSessionIds)
    this.installPinned(baseline.pinnedSessionIds)
    this.state = 'idle'
    this.phase = 'ready'
    this.error = null
    this.invalidate()
  }

  /** 合并来自当前 follow 生成的一个解码后的 Workspace upsert。 */
  upsertView(workspace: WorkspaceView): void {
    this.upsert(workspace)
  }

  /** 应用来自当前 follow 生成的一次解码后的 Workspace 移除。 */
  removeView(workspaceId: WorkspaceId): void {
    this.remove(workspaceId)
  }

  /** 以当前 follow 生成为准替换 Host 确认的顺序。 */
  replaceOrder(workspaceIds: readonly WorkspaceId[]): void {
    this.orderFrameGeneration++
    this.installOrder(workspaceIds, true)
  }

  /**
   * 以当前 follow 生成为准替换已归档 Session 集合。
   * @param archivedSessionIds - Host 确认的完整归档集合。
   */
  replaceArchived(archivedSessionIds: WorkspaceArchiveValue['archivedSessionIds']): void {
    this.archiveRequestSeq++
    this.installArchived(archivedSessionIds)
  }

  /**
   * 以当前 follow 生成为准替换已置顶 Session 集合。
   * @param pinnedSessionIds - Host 确认的完整置顶集合，最近置顶的在前。
   */
  replacePinned(pinnedSessionIds: WorkspacePinValue['pinnedSessionIds']): void {
    this.pinRequestSeq++
    this.installPinned(pinnedSessionIds)
  }

  /** 在丢失的 carrier 重连期间保持最近一次完整投影可见。 */
  handleCarrierFailure(): void {
    this.state = 'loading'
    this.error = null
    this.invalidate()
  }

  /**
   * 发布不可重试的流或协议失败。
   * @param error - 终态流失败。
   */
  handleStreamFailure(error: unknown): void {
    if (!isRemoteFailure(error)) throw error
    this.state = 'error'
    this.error = error
    this.invalidate()
  }

  /**
   * 订阅 Workspace 状态失效。
   * @param listener - 失效回调。
   * @returns 取消订阅函数。
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * 读取缓存状态，必要时先重建它。
   * @returns 当前的稳定 Workspace 列表快照。
   */
  getSnapshot(): WorkspaceSnapshot {
    this.refreshSnapshot()
    return this.snapshotCache
  }

  private buildSnapshot(): WorkspaceSnapshot {
    return {
      items: this.items,
      archivedSessionIds: this.archivedSessionIds,
      pinnedSessionIds: this.pinnedSessionIds,
      state: this.state,
      phase: this.phase,
      error: this.error,
    }
  }

  private installArchived(archivedSessionIds: WorkspaceArchiveValue['archivedSessionIds']): void {
    if (archivedSessionIds.length === this.archivedSessionIds.length
      && archivedSessionIds.every((id, index) => id === this.archivedSessionIds[index])) return
    this.archivedSessionIds = [...archivedSessionIds]
    this.invalidate()
  }

  private installPinned(pinnedSessionIds: WorkspacePinValue['pinnedSessionIds']): void {
    if (pinnedSessionIds.length === this.pinnedSessionIds.length
      && pinnedSessionIds.every((id, index) => id === this.pinnedSessionIds[index])) return
    this.pinnedSessionIds = [...pinnedSessionIds]
    this.invalidate()
  }

  private installOrder(workspaceIds: readonly WorkspaceId[], committed = false): void {
    if (committed) this.committedOrder = [...workspaceIds]
    const rank = new Map(workspaceIds.map((id, index) => [id, index]))
    const items = [...this.items].sort((left, right) =>
      (rank.get(left.workspaceId) ?? Number.MAX_SAFE_INTEGER)
      - (rank.get(right.workspaceId) ?? Number.MAX_SAFE_INTEGER))
    if (items.every((item, index) => item === this.items[index])) return
    this.items = items
    this.invalidate()
  }

  private upsert(view: WorkspaceView): void {
    if (this.removedIds.has(view.workspaceId)) return
    const index = this.items.findIndex(item => item.workspaceId === view.workspaceId)
    const installed = this.items[index]
    // 一元响应与流增量在不同请求上竞争。无论到达顺序如何，
    // 都保留最新的 Host 投影。
    if (installed !== undefined && Date.parse(view.updatedAt) < Date.parse(installed.updatedAt)) return
    if (!this.committedOrder.includes(view.workspaceId)) {
      this.committedOrder = [view.workspaceId, ...this.committedOrder]
    }
    this.items = index === -1
      ? [view, ...this.items]
      : this.items.map((item, position) => position === index ? view : item)
    this.invalidate()
  }

  private remove(workspaceId: WorkspaceId, immediate = false): void {
    this.removedIds.add(workspaceId)
    this.committedOrder = this.committedOrder.filter(id => id !== workspaceId)
    const items = this.items.filter(item => item.workspaceId !== workspaceId)
    if (items.length === this.items.length) {
      // 成功的一元回显在用户操作兑现之前，仍会发布更早增量的
      // 待处理移除。
      if (immediate) this.invalidate(true)
      return
    }
    this.items = items
    this.invalidate(immediate)
  }

  private installViews(views: readonly WorkspaceView[]): void {
    const installed = new Map<WorkspaceId, WorkspaceView>()
    for (const view of views) {
      if (!this.removedIds.has(view.workspaceId)) installed.set(view.workspaceId, view)
    }
    this.items = [...installed.values()]
    this.committedOrder = views.map(view => view.workspaceId)
  }

  private invalidate(immediate = false): void {
    this.snapshotDirty = true
    this.notificationPending = true
    if (immediate) {
      this.notificationGeneration++
      this.notificationScheduled = false
      this.flush()
      return
    }
    if (this.notificationScheduled) return
    this.notificationScheduled = true
    const generation = ++this.notificationGeneration
    queueMicrotask(() => {
      if (generation !== this.notificationGeneration) return
      this.notificationScheduled = false
      this.flush()
    })
  }

  private flush(): void {
    if (!this.notificationPending || this.listeners.size === 0) return
    this.notificationPending = false
    this.refreshSnapshot()
    notifySubscribers(this.listeners, '[workspace-controller]')
  }

  private refreshSnapshot(): void {
    if (!this.snapshotDirty) return
    this.snapshotDirty = false
    this.snapshotCache = this.buildSnapshot()
  }
}

function insertIdBefore(
  ids: readonly WorkspaceId[],
  id: WorkspaceId,
  beforeId?: WorkspaceId,
): WorkspaceId[] {
  if (!ids.includes(id) || (beforeId !== undefined && !ids.includes(beforeId)) || beforeId === id) {
    return [...ids]
  }
  const without = ids.filter(candidate => candidate !== id)
  const at = beforeId === undefined ? without.length : without.indexOf(beforeId)
  return [...without.slice(0, at), id, ...without.slice(at)]
}
