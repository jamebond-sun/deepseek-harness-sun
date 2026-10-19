/** 不依赖 React 的 Client Workspace 服务与命令门面。 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { WorkspaceView } from '../types.ts'
import type { ClientWorkspaceModel, WorkspaceSnapshot } from './model.ts'

/** 供调用方区分 Host 业务错误的结构化创建失败。 */
export class WorkspaceCreateError extends Error {
  override readonly name = 'WorkspaceCreateError'

  /** @param rpcError - Host 业务失败或折叠后的 carrier 失败。 */
  constructor(readonly rpcError: RemoteFailure) {
    super(`workspace create failed: ${rpcError.code}: ${rpcError.message}`)
  }
}

/**
 * 在 Host 上归档失败。`rpcError.code` 区分活跃 Session 拒绝
 * （`workspace/session-active`，其详情指明仍在运行的内容）与
 * session 缺失或 carrier 故障。
 */
export class WorkspaceArchiveError extends Error {
  override readonly name = 'WorkspaceArchiveError'

  /** @param rpcError - Host 业务失败或折叠后的 carrier 失败。 */
  constructor(readonly rpcError: RemoteFailure) {
    super(`workspace session archive failed: ${rpcError.code}: ${rpcError.message}`)
  }
}

/** Workspace 控制器快照的裸可观察来源。 */
export interface WorkspaceSource {
  /** 读取身份稳定的当前快照。 */
  getSnapshot(): WorkspaceSnapshot
  /**
   * 订阅快照变更。
   * @param listener - 失效回调。
   * @returns 取消订阅函数。
   */
  subscribe(listener: () => void): () => void
}

/** Workspace 控制器的 Client 服务接口面。 */
export interface IWorkspaces {
  /** Host 权威的 Workspace 行、顺序、归档集合与 follow 生命周期。 */
  readonly list: WorkspaceSource
  /**
   * 将现有路径注册为 Workspace。
   * @param input - Host 创建载荷。
   * @returns 创建或幂等解析出的 Workspace。
   */
  create(input: { path: string }): Promise<WorkspaceView>
  /**
   * 初始化或复用默认 Workspace。
   * @param signal - 调用方生命周期。
   * @returns 准备好的 Workspace，首次使用初始化不符合条件时为 undefined；准备失败时 reject。
   */
  initializeDefault(signal?: AbortSignal): Promise<WorkspaceView | undefined>
  /**
   * 重命名一个 Workspace。
   * @param workspaceId - 目标 Workspace。
   * @param title - 新显示标题。
   * @returns 重命名后的 Workspace。
   */
  rename(workspaceId: WorkspaceId, title: string): Promise<WorkspaceView>
  /**
   * 删除一个 Workspace 注册，而不删除 Session 或文件。
   * @param workspaceId - 目标 Workspace。
   */
  delete(workspaceId: WorkspaceId): Promise<void>
  /**
   * 在 Host 注册表顺序中移动一个 Workspace。
   * @param workspaceId - 要移动的 Workspace。
   * @param beforeWorkspaceId - 锚点 Workspace；省略时追加到末尾。
   */
  insertBefore(workspaceId: WorkspaceId, beforeWorkspaceId?: WorkspaceId): Promise<void>
  /**
   * 从 Workspace 分组界面归档一个 Session。
   * @param sessionId - 要归档的 Session。
   * @param options - `stopActivity` 要求 Host 停止该 Session 的运行中工作，而不是拒绝。
   * @throws {WorkspaceArchiveError} 当 Host 拒绝时；不传 `stopActivity` 时，有
   *   运行中工作的 Session 以 `workspace/session-active` 失败，其详情指明正在运行的内容。
   */
  archiveSession(sessionId: SessionId, options?: { readonly stopActivity?: boolean }): Promise<void>
  /**
   * 将一个 Session 从已归档 Session 列表恢复。
   * @param sessionId - 要取消归档的 Session。
   */
  unarchiveSession(sessionId: SessionId): Promise<void>
  /**
   * 在 Workspace 分组界面上将一个 Session 置于未置顶 Session 之前。
   * @param sessionId - 要置顶的 Session。
   */
  pinSession(sessionId: SessionId): Promise<void>
  /**
   * 移除一个 Session 的置顶，而不改变其已保存的 Session 顺序。
   * @param sessionId - 要取消置顶的 Session。
   */
  unpinSession(sessionId: SessionId): Promise<void>
  /**
   * 在一个 Workspace 的归入顺序中移动一个 Session。
   * @param workspaceId - 所属 Workspace。
   * @param sessionId - 要移动的 Session。
   * @param beforeSessionId - 锚点 Session；省略时追加到末尾。
   * @returns 变更后的 Workspace。
   */
  insertSessionBefore(
    workspaceId: WorkspaceId,
    sessionId: SessionId,
    beforeSessionId?: SessionId,
  ): Promise<WorkspaceView>
}

/** 持有裸 Workspace 快照与仅 Workspace 的命令。 */
export class WorkspaceController extends Service implements IWorkspaces {
  readonly list: WorkspaceSource

  /**
   * @param ctx - Client 根上下文。
   * @param model - 以 Remote 为后端的 Workspace 状态模型。
   */
  constructor(ctx: Context, private readonly model: ClientWorkspaceModel) {
    super(ctx, 'workspaces')
    this.list = model
  }

  async create(input: { path: string }): Promise<WorkspaceView> {
    const result = await this.model.create(input)
    if (!result.ok) throw new WorkspaceCreateError(result.error)
    return result.value.workspace
  }

  async initializeDefault(signal?: AbortSignal): Promise<WorkspaceView | undefined> {
    const result = await this.model.initializeDefault(signal)
    if (!result.ok) throw new WorkspaceCreateError(result.error)
    return result.value?.workspace
  }

  async rename(workspaceId: WorkspaceId, title: string): Promise<WorkspaceView> {
    const result = await this.model.rename(workspaceId, title)
    if (!result.ok) throw commandError('rename', result.error)
    return result.value.workspace
  }

  async delete(workspaceId: WorkspaceId): Promise<void> {
    const result = await this.model.delete(workspaceId)
    if (!result.ok) throw commandError('delete', result.error)
  }

  async insertBefore(workspaceId: WorkspaceId, beforeWorkspaceId?: WorkspaceId): Promise<void> {
    const result = await this.model.insertBefore(workspaceId, beforeWorkspaceId)
    if (!result.ok) throw commandError('reorder', result.error)
  }

  async archiveSession(sessionId: SessionId, options: { readonly stopActivity?: boolean } = {}): Promise<void> {
    const result = await this.model.archiveSession(sessionId, options)
    if (!result.ok) throw new WorkspaceArchiveError(result.error)
  }

  async unarchiveSession(sessionId: SessionId): Promise<void> {
    const result = await this.model.unarchiveSession(sessionId)
    if (!result.ok) throw commandError('session unarchive', result.error)
  }

  async pinSession(sessionId: SessionId): Promise<void> {
    const result = await this.model.pinSession(sessionId)
    if (!result.ok) throw commandError('session pin', result.error)
  }

  async unpinSession(sessionId: SessionId): Promise<void> {
    const result = await this.model.unpinSession(sessionId)
    if (!result.ok) throw commandError('session unpin', result.error)
  }

  async insertSessionBefore(
    workspaceId: WorkspaceId,
    sessionId: SessionId,
    beforeSessionId?: SessionId,
  ): Promise<WorkspaceView> {
    const result = await this.model.insertSessionBefore(workspaceId, sessionId, beforeSessionId)
    if (!result.ok) throw commandError('move', result.error)
    return result.value.workspace
  }
}

function commandError(operation: string, failure: RemoteFailure): Error {
  return new Error(`workspace ${operation} failed: ${failure.code}: ${failure.message}`)
}
