/** 公开的 Agent Teams 身份、持久化记录，以及服务请求取值。 */

import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** 标识以一个顶层 Session 为根的隐式 Team。 */
export type TeamId = Branded<'TeamId'>

/**
 * 将一个 root Session 身份品牌化为它的隐式 Team 身份。
 * @param id - Root Session 身份。
 * @returns 同一个被品牌化为 Team 身份的字符串。
 */
export function TeamId(id: SessionId | string): TeamId {
  return id as TeamId
}

/** Team 中某条任务的稳定标识符。 */
export type TeamTaskId = Branded<'TeamTaskId'>

/**
 * 品牌化一个已校验的任务 id。
 * @param id - Team 本地的任务身份。
 * @returns 同一个被品牌化为 Team 任务身份的字符串。
 */
export function TeamTaskId(id: string): TeamTaskId {
  return id as TeamTaskId
}

/** 一条持久化对等消息的稳定标识符。 */
export type TeamMessageId = Branded<'TeamMessageId'>

/**
 * 品牌化一个生成的对等消息 id。
 * @param id - 持久的邮箱消息身份。
 * @returns 同一个被品牌化为 Team 消息身份的字符串。
 */
export function TeamMessageId(id: string): TeamMessageId {
  return id as TeamMessageId
}

/** 持久化的队友生命周期。 */
export type TeamMemberPhase = 'provisioning' | 'active' | 'failed'

/** 在每次队友生命周期变化时写入的完整持久化取值。 */
export interface TeamMemberSnapshot {
  readonly id: SessionId
  readonly name: string
  readonly description: string
  readonly provider: string
  readonly context: 'fresh' | 'fork'
  readonly phase: TeamMemberPhase
  readonly error?: string
}

/** 当前经运行时充实后的花名册行。 */
export interface TeamMemberView {
  readonly id: SessionId
  readonly name: string
  readonly role: 'lead' | 'teammate'
  readonly status: 'running' | 'inactive' | 'provisioning' | 'failed'
  readonly description?: string
  readonly provider?: string
  readonly context?: 'fresh' | 'fork'
  readonly model?: string
  readonly diagnostics: string[]
}

/** 持久化的任务生命周期。 */
export type TeamTaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted'

/** 完整的持久化任务快照；每一次变更都会使 {@link revision} 自增。 */
export interface TeamTaskSnapshot {
  readonly id: TeamTaskId
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: TeamTaskStatus
  readonly ownerId?: SessionId
  readonly blockedBy: TeamTaskId[]
  readonly writeScopes: string[]
}

/** 返回给工具与宿主的、经运行时充实后的任务视图。 */
export interface TeamTaskView {
  readonly id: TeamTaskId
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: TeamTaskStatus
  readonly blockedBy: TeamTaskId[]
  readonly writeScopes: string[]
  readonly ownerName?: string
  readonly ready: boolean
  readonly writeScopeWarnings: string[]
}

/** 通过 `agentTeam` Session 投影发布的一条持久化花名册行。 */
export interface TeamMemberProjection {
  readonly id: SessionId
  readonly name: string
  readonly role: 'lead' | 'teammate'
  /** 持久化生命周期；Lead 行始终为 `active`。轮次活动来自 Session 状态。 */
  readonly phase: TeamMemberPhase
  readonly error?: string
}

/**
 * 通过 Lead Session 的 `agentTeam` 投影发布给浏览器客户端的、持久化的 Team 状态。
 * `failure` 命名第一条被拒绝的、持久化的 Team 记录；成员与任务随后停留在
 * 最后一个有效状态。
 */
export interface TeamProjection {
  readonly members: TeamMemberProjection[]
  readonly tasks: TeamTaskView[]
  readonly failure?: string
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** 以被投影 Session 为根的 Team 的、持久化的花名册与未删除任务看板。 */
    agentTeam: TeamProjection
  }
}

/** 由历史的 Team 邮箱记录的一条对等消息。 */
export interface TeamMessageSnapshot {
  readonly id: TeamMessageId
  readonly senderId: SessionId
  readonly senderName: string
  readonly targetId: SessionId
  readonly content: ContentBlock[]
}

/** 目标 Session 为一次历史的 Team 邮箱投递所记录的来源。 */
export interface TeamMessageSource {
  readonly kind: 'team-message'
  readonly teamId: TeamId
  readonly messageId: TeamMessageId
  readonly senderId: SessionId
  readonly senderName: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'team-message': TeamMessageSource
  }
}

/** Team 服务的部署上限。 */
export interface Config {
  /** 一个 Team 保留的、不可变的队友名称的最大数量。 */
  readonly maxMembers?: number
  /** 一个 Team 保留的、未删除任务的最大数量。 */
  readonly maxTasks?: number
  /** 一次完整的、发送方加框的投递中，UTF-8 字节数的上限。 */
  readonly maxMessageBytes?: number
  /** 共享操作结算以及每个 Team 子级排空的、以毫秒计的最大时长。 */
  readonly disposalTimeoutMs?: number
}

/** 创建一名持久化队友的输入。 */
export interface SpawnTeammateRequest {
  readonly name: string
  readonly description: string
  readonly prompt: ContentBlock[]
  readonly context: 'fresh' | 'fork'
  readonly provider: string
  readonly signal: AbortSignal
}

/** 一名队友抵达持久化的 active 或 failed 边之后的结果。 */
export interface SpawnTeammateResult {
  readonly member: TeamMemberView
}

/** 一次直接对等消息尝试的输入。 */
export interface SendTeamMessageRequest {
  readonly target: string
  readonly content: ContentBlock[]
  readonly signal: AbortSignal
}

/** 在普通 Agent 持久化之下的目标收件箱接受；没有 Team 重试或去重。 */
export interface SendTeamMessageResult {
  readonly messageId: MessageId
}

/** 创建一条共享任务的输入。 */
export interface CreateTeamTaskRequest {
  readonly subject: string
  readonly description: string
  readonly blockedBy?: readonly TeamTaskId[]
  readonly writeScopes?: readonly string[]
}

/** 受支持的任务变更动作。 */
export type TeamTaskAction =
  | 'claim'
  | 'release'
  | 'edit'
  | 'set_dependencies'
  | 'complete'
  | 'reopen'
  | 'reassign'
  | 'delete'

/** 对一条共享任务的比较并交换变更。 */
export interface UpdateTeamTaskRequest {
  readonly taskId: TeamTaskId
  readonly expectedRevision: number
  readonly action: TeamTaskAction
  readonly subject?: string
  readonly description?: string
  readonly blockedBy?: readonly TeamTaskId[]
  readonly writeScopes?: readonly string[]
  readonly owner?: string
}

/** 等待 Team 活动的结果。 */
export interface TeamWaitResult {
  readonly timedOut: boolean
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** 完整的队友生命周期取值，仅存储于 Team Lead Session。 */
    'team/member': { version: 2; teamId: TeamId; member: TeamMemberSnapshot }
    /** 完整的共享任务取值，仅存储于 Team Lead Session。 */
    'team/task': { version: 2; teamId: TeamId; task: TeamTaskSnapshot }
    /** 历史的邮箱入队；新的发送使用目标 Agent 收件箱。 */
    'team/message/queued': { version: 2; teamId: TeamId; message: TeamMessageSnapshot }
    /** 目标 Session 已记录一条入队消息的历史性确认。 */
    'team/message/delivered': {
      version: 2
      teamId: TeamId
      messageId: TeamMessageId
      targetId: SessionId
    }
  }
}
