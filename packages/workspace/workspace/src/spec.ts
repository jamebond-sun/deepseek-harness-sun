/**
 * 工作区域声明：记录模式以及注册表所打开的 `defineDomain`
 * 规范。zod 模式在持久化边界处校验已发布的格式，并且是未来 RPC
 * 线投影的直接来源。
 * @module @deepseek-ai/dsh-workspace/src/spec
 */

import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { WorkspaceId } from './types.ts'

/** 持久化边界处的工作区 id 模式；品牌没有运行时表示。 */
const workspaceId = z.string().transform(value => value as WorkspaceId)

const sessionId = z.string().transform(value => brandString<SessionId>(value))

/**
 * 一条工作区记录的持久化形态。`path` 是创建时盖戳的 `fs.realpath`
 * 规范；`sessionIds` 是有序的所有权记账（数组顺序即显示顺序）；
 * 时间戳为 ISO-8601 字符串。
 */
export const workspaceRecord = z.object({
  path: z.string(),
  title: z.string(),
  sessionIds: z.array(sessionId),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** 一条已存储的工作区记录，从 {@link workspaceRecord} 推断而来。 */
export type WorkspaceRecord = z.infer<typeof workspaceRecord>

/**
 * 可恢复的双写变更标记。该标记在记录/顺序这一对发生分歧之前
 * 被持久化，因此启动时能够区分一次被中断的注册表操作
 * 与无法解释的中介损坏。
 */
const workspacePendingMutation = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('create'), workspaceId }),
  z.object({ operation: z.literal('delete'), workspaceId }),
])

/**
 * 持久化注册表状态。`initialized` 用于区分一个有效的空注册表
 * 与一个仍需进行仅有头部引导的注册表；`workspaceIds` 是权威的显示顺序。
 * `archivedSessionIds` 是叠加在工作区记账之上的注册表全局归档集合：
 * 已归档的会话保留其 `sessionIds` 槽位（解除归档必须恢复其位置），
 * 因此该集合从不参与单一所有者的记账不变式。`pinnedSessionIds` 是
 * 按固定顺序的注册表全局固定集合（最近固定的在最前）；
 * 固定与归档互斥，因此归档会丢弃该会话的固定。两个会话集合都
 * 带有默认值，以便这些字段出现之前写入的记录在解析时保持不变。
 */
export const workspaceDomainState = z.object({
  initialized: z.boolean(),
  /** 首次使用的工作区身份，在其注册被删除后仍然保留。 */
  defaultWorkspaceId: workspaceId.optional(),
  workspaceIds: z.array(workspaceId),
  archivedSessionIds: z.array(sessionId).default([]),
  pinnedSessionIds: z.array(sessionId).default([]),
  pendingMutation: workspacePendingMutation.optional(),
})

/** 从 {@link workspaceDomainState} 推断而来的持久化注册表状态。 */
export type WorkspaceDomainState = z.infer<typeof workspaceDomainState>

/**
 * 工作区域规范：一张以 {@link WorkspaceId} 为键的 `workspaces`
 * 表，加上引导/顺序单例。注册表通过 `ctx.storage.domain`
 * 打开它；该规范对象是域的身份、版本与模式的唯一来源。
 */
export const workspaceDomainSpec = defineDomain({
  name: 'workspace',
  version: 2,
  global: {
    schema: workspaceDomainState,
    initial: { initialized: false, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] },
  },
  tables: { workspaces: domainTable<WorkspaceId, WorkspaceRecord>(workspaceRecord) },
})
