/**
 * 本包拥有的 Workspace 与目录选择 Remote 命名空间的浏览器安全请求、
 * 结果与状态流词汇。目录选择接缝自有的列表类型在此重新导出而非重述：
 * 浏览器消费方读到的正是后端应答的那个声明。
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionActivity, WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

export type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
export type {
  SessionActivity, SessionActivityItem, SessionActivityKind, SessionActivityKindMap,
} from '@deepseek-ai/dsh-workspace/types'
export type { DirectoryEntry, DirectoryListing } from '@deepseek-ai/dsh-host-directory-picker/types'

/** 投影给浏览器消费方的一个持久 Workspace。 */
export interface WorkspaceView {
  readonly workspaceId: WorkspaceId
  /** 规范化的 Host 目录路径。 */
  readonly path: string
  /** 用户可见标题。 */
  readonly title: string
  /** 归入此 Workspace 的 Session，按手动顺序。 */
  readonly sessionIds: readonly SessionId[]
  /** ISO-8601 创建时刻。 */
  readonly createdAt: string
  /** ISO-8601 最近变更时刻。 */
  readonly updatedAt: string
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** 所请求的目录无法支撑一个 Workspace。 */
    'workspace/invalid-path': { readonly path: string }
    /** 另一个 Workspace 已使用所请求的名称。 */
    'workspace/name-conflict': { readonly name: string }
    /**
     * 该 Session 仍有运行中的工作——其自身的 turn、subagent、
     * 后台任务或活跃的 schedule——因此归档被拒绝且未发生写入；
     * `activity` 指明必须先停止什么。
     */
    'workspace/session-active': {
      readonly sessionId: SessionId
      readonly activity: readonly SessionActivity[]
    }
    /** 该 Session 或其锚点不在 Workspace 的手动顺序中。 */
    'workspace/move-invalid': {
      readonly workspaceId: WorkspaceId
      readonly sessionId: SessionId
      readonly beforeSessionId?: SessionId
    }
    /** 该动词需要组合后端不提供的交互。 */
    'directory-picker/unavailable': { readonly capability: string }
    /** 目标不是完全限定路径，或后端无法列出它。 */
    'directory-picker/unreadable': { readonly path: string }
    /** 该名称的子项已存在。 */
    'directory-picker/exists': { readonly path: string }
    /** 父目录不是完全限定路径、名称不是单一段，或创建失败。 */
    'directory-picker/create-failed': { readonly path: string }
  }
}

/** 请求用于收编为 Workspace 的现有目录。 */
export interface WorkspaceCreateRequest {
  readonly path: string
}

/** 新创建或此前已注册的 Workspace。 */
export interface WorkspaceCreateValue {
  readonly workspace: WorkspaceView
  readonly created: boolean
}

/** Workspace 标题变更。 */
export interface WorkspaceRenameRequest {
  readonly workspaceId: WorkspaceId
  readonly title: string
}

/** 返回完整变更行的 Workspace 变更。 */
export interface WorkspaceValue {
  readonly workspace: WorkspaceView
}

/** Workspace 注册删除。 */
export interface WorkspaceDeleteRequest {
  readonly workspaceId: WorkspaceId
}

/** 一个 Workspace 注册被删除后的回执。 */
export interface WorkspaceDeleteValue {
  readonly deleted: true
}

/** 类似 DOM insertBefore 的 Workspace 顺序变更。 */
export interface WorkspaceInsertBeforeRequest {
  readonly workspaceId: WorkspaceId
  readonly beforeWorkspaceId?: WorkspaceId
}

/** 变更后的完整 Workspace 注册顺序。 */
export interface WorkspaceOrderValue {
  readonly workspaceIds: readonly WorkspaceId[]
}

/** 类似 DOM insertBefore 的 Session 成员顺序变更。 */
export interface WorkspaceInsertSessionBeforeRequest {
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
  readonly beforeSessionId?: SessionId
}

/** 从 Workspace 分组界面请求归档的 Session。 */
export interface WorkspaceArchiveSessionRequest {
  readonly sessionId: SessionId
  /**
   * 停止该 Session 的运行中工作——其 turn、subagent 后代、拥有的
   * 后台任务与活跃 schedule——而不是像 `workspace/session-active` 那样
   * 拒绝归档。停止请求在归档写入之前发出且不被等待；响应在归档
   * 集合持久化后送达。
   */
  readonly stopActivity?: boolean
}

/** 请求从已归档 Session 列表恢复的 Session。 */
export interface WorkspaceUnarchiveSessionRequest {
  readonly sessionId: SessionId
}

/** 变更后的完整已归档 Session 集合。 */
export interface WorkspaceArchiveValue {
  readonly archivedSessionIds: readonly SessionId[]
}

/** 请求在分组界面上置于未置顶 Session 之前的 Session。 */
export interface WorkspacePinSessionRequest {
  readonly sessionId: SessionId
}

/** 请求从置顶集合移除的 Session。 */
export interface WorkspaceUnpinSessionRequest {
  readonly sessionId: SessionId
}

/** 变更后的完整置顶 Session 集合，最近置顶的在前。 */
export interface WorkspacePinValue {
  readonly pinnedSessionIds: readonly SessionId[]
}

/** Workspace 浏览器状态的完整重连基线。 */
export interface WorkspaceBaseline {
  readonly items: readonly WorkspaceView[]
  readonly archivedSessionIds: readonly SessionId[]
  /** 注册表全局置顶集合，最近置顶的在前。 */
  readonly pinnedSessionIds: readonly SessionId[]
}

/**
 * 一个生成的基线之后的一次有序 Workspace 变更。`replace` 携带
 * 取代该生成中此前一切已交付内容的完整状态；它是一次变更，
 * 而非新生成的起始帧。
 */
export type WorkspaceFollowIncrement =
  | { readonly type: 'replace'; readonly value: WorkspaceBaseline }
  | { readonly type: 'upsert'; readonly workspace: WorkspaceView }
  | { readonly type: 'remove'; readonly workspaceId: WorkspaceId }
  | { readonly type: 'order'; readonly workspaceIds: readonly WorkspaceId[] }
  | { readonly type: 'archived'; readonly archivedSessionIds: readonly SessionId[] }
  | { readonly type: 'pinned'; readonly pinnedSessionIds: readonly SessionId[] }

/** Workspace 状态流；每个生成恰好以一个基线开始。 */
export type WorkspaceFollowFrame =
  | { readonly type: 'baseline'; readonly value: WorkspaceBaseline }
  | WorkspaceFollowIncrement
