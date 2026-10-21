/**
 * 投影缓存的领域声明：一张以 {@link SessionId} 为键的 `sessions` 表，每条
 * 记录是一个会话的完整投影检查点（`key → {ver, seq, val}` 行）。该 spec
 * 对象是本领域的身份、版本、布局与记录模式的唯一来源；存储介质由
 * storage-domain 路由决定（所发布组合的 json 后端以 `per-record` 方式存储
 * 本领域：每个会话一个文档，位于 `<root>/session_projcache/sessions/` 下，
 * 因此一次检查点写入只重写一个会话的文档，而非整个单元）。
 * @module @deepseek-ai/dsh-session-projection-cache/src/spec
 */

import { z } from 'zod'
import { isJsonValue } from '@deepseek-ai/dsh-util-values'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionId, SessionSeqCursor } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/**
 * 一行持久化的检查点（RFC 中的 `(sessionId, key, ver, seq, val)`，去掉两条
 * 记录键）。`val` 是单元的内部状态——按单元契约应为纯 JSON。校验使用与写入
 * 相同的无损 JSON 规则，并在不克隆的情况下保留每个状态键。一行永远不会是
 * 错误的，只可能是过时的：`seq` 精确说明有多过时，而与活动单元 `stateVersion`
 * 的 `ver` 不匹配会在读取时丢弃它（绝不是迁移）。
 */
export const checkpointRow = z.object({
  ver: z.number().int().nonnegative(),
  seq: z.number().int().gte(-1).transform((value): SessionSeqCursor =>
    value === -1 ? -1 : SessionSeq(value)),
  val: z.custom<JsonValue>(isJsonValue, { message: 'checkpoint state must be losslessly JSON-serializable' }),
})

/**
 * 一条记录所绑定的、已存储日志的身份：用于区分同一 id 下不同会话生命周期的
 * 不可变头部字段。会话 id 命名的是一个槽位，而非生命周期——否则一个
 * 删除后重建的 id，或一个在存活缓存之下被换掉的持久化根目录，会让旧记录
 * 通过每一道水位检查，并用来自无关日志的状态作为种子折叠。读取在接纳任何
 * 记录之前，都会依据活动头部（列举）或已存储头部（冷读）来校验这一点。
 *
 * format 与 lineage 字段是可选的，因为经由 `compatibleVersions` 接纳的记录
 * 早于它们。读取方（`identityMatches`）会拒绝缺失的格式代际，因为没有任何
 * 当前的 Session 日志能证明那条记录的折叠语义。它只在格式代际匹配之后，
 * 才会把缺失的 lineage 解释为未播种。当前版本的写入始终存储全部三个字段。
 */
export const checkpointIdentity = z.object({
  formatVersion: z.number().int().nonnegative().optional(),
  createdAt: z.number().int().nonnegative(),
  cwd: z.string().optional(),
  isSeeded: z.boolean().optional(),
  inheritedEventCount: z.number().int().nonnegative().transform(SessionLogOffset).optional(),
})

/** 一条记录所绑定的身份字段，从 {@link checkpointIdentity} 推断得出。 */
export type CheckpointIdentity = z.infer<typeof checkpointIdentity>

/**
 * 一个会话的已存储记录：它所折叠自的日志身份，加上以投影键为索引的
 * 检查点行。每次写入都会整体替换整条记录（整体值纪律——注册表检查点始终是
 * 完整的按会话切片）。
 */
export const checkpointRecord = z.object({
  identity: checkpointIdentity,
  rows: z.record(z.string(), checkpointRow),
})

/** 一条已存储的、按会话划分的检查点记录，从 {@link checkpointRecord} 推断得出。 */
export type CheckpointRecord = z.infer<typeof checkpointRecord>

/**
 * session-projcache 领域 spec。`per-record` 布局把版本提升的作用域限定到
 * 每个会话：提升之后，一个过时的会话文档会在打开时被丢弃（缓存语义——
 * 一个过时或不可读的缓存只会让尾部重放更长，绝不会给出错误的值），而
 * 领域的其余部分仍可用，而不是拒绝整个介质。`compatibleVersions` 条目把
 * 结构上合法的前身记录保留下来，供稍后的当前检查点重写使用。没有
 * `formatVersion` 的记录仍无法作为折叠捷径使用，因为它们无法证明是哪套
 * Session 事件语义生成了它们的行；按记录划分的版本映射与处置见本包的 README。
 * 每行 `ver` 守卫与身份匹配仍会丢弃当前折叠语义无法担保的任何内容。
 *
 * 一个生命周期匹配的前身仍可通过缓存服务的“仅列举”提示暴露其版本兼容的
 * 标题；这绝不会放宽水合或另一条折叠捷径对格式的要求。
 *
 * `invalidRecords: 'backup-and-skip'`：一则无论如何都未通过 schema 的已存储
 * 记录属于可丢弃的派生数据，因此它绝不能拖慢启动——领域层会把该文档移到
 * 一旁，命名为 `<key>.json.bak.<stamp>`，记录具体的校验失败，并以未缓存
 * 方式服务该会话（一次冷读会重建并重写它）。
 */
export const projectionCacheDomainSpec = defineDomain({
  name: 'session_projcache',
  version: 7,
  compatibleVersions: [3, 4, 5, 6],
  invalidRecords: 'backup-and-skip',
  layout: 'per-record',
  tables: { sessions: domainTable<SessionId, CheckpointRecord>(checkpointRecord) },
})
