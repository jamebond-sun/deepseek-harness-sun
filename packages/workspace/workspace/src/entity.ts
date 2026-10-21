/**
 * 包私有的工作区实体：唯一的 {@link Workspace}
 * 实现。持有一条记录快照，在每次持久化变更后被原地替换；所有写入都汇聚到私有的 `mutate`，
 * 从而保证 `updatedAt` 盖章与无效账号剪枝恰好发生一次。
 * 不会从包的入口点重新导出——消费者只能看到
 * `Workspace` 接口。
 * @module @deepseek-ai/dsh-workspace/src/entity
 */

import { stat } from 'node:fs/promises'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { WorkspaceRecord } from './spec.ts'
import type { Workspace, WorkspaceId } from './types.ts'
import { realpathNormalize } from './paths.ts'

/** insertSessionBefore 请求指定了一个不在账号上的会话或锚点（存储失败仍为普通错误）。 */
export class WorkspaceMoveInvalidError extends Error {
  /**
   * @param message - 哪个 id 未被计入及其位置。
   */
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceMoveInvalidError'
  }
}

/**
 * 实体进行变更时依赖的、由注册表拥有的机制。实体从不接触
 * 注册表本身——只能看到已打开的表、支撑 `sessionIds`
 * 投影的规范化会话路径索引，以及附加时的头部读取。
 */
export interface WorkspaceEntityHost {
  /**
   * 解析已打开的 `workspaces` 表。
   * @returns 该表；注册表尚未启动时抛出错误。
   */
  table(): KvTable<WorkspaceId, WorkspaceRecord>

  /**
   * 校验一个已计入的会话，当其完全限定的 cwd 因路径组件缺失而无法解析时，保留其归属。
   * @param id - 已存在于本工作区候选账号中的会话。
   * @param path - 工作区存储的规范化目录。
   * @returns 该候选是否仍属于成员。
   */
  candidateMatches(id: SessionId, path: string): boolean

  /**
   * 读取一条已存储的会话头部用于附加校验。
   * @param id - 要读取头部的会话。
   * @returns 该头部；当会话持久化缺失或没有该 id 的会话时拒绝。
   */
  readSessionHeader(id: SessionId): Promise<SessionHeader>

  /**
   * 将一个校验成功的规范化 cwd 发布到投影索引。
   * @param id - 已校验的会话 id。
   * @param path - 来自不可变头部 cwd 的规范化已存在目录。
   */
  rememberSessionPath(id: SessionId, path: string): void
}

/** 当记录无需变更时，由 update 函数抛出的链式槽位中止哨兵；只有 `mutate` 会观察它。 */
const unchangedSentinel = new Error('workspace record unchanged (internal sentinel)')

/** 唯一的 {@link Workspace} 实现；仅由注册表构造。 */
export class WorkspaceEntity implements Workspace {
  private record: WorkspaceRecord

  /**
   * @param host - 注册表拥有的表、会话路径索引与头部读取。
   * @param id - 记录的稳定 id。
   * @param record - 已加载或刚写入的已校验记录快照。
   */
  constructor(
    private readonly host: WorkspaceEntityHost,
    readonly id: WorkspaceId,
    record: WorkspaceRecord,
  ) {
    this.record = record
  }

  get path(): string {
    return this.record.path
  }

  get title(): string {
    return this.record.title
  }

  get createdAt(): string {
    return this.record.createdAt
  }

  get updatedAt(): string {
    return this.record.updatedAt
  }

  get sessionIds(): readonly SessionId[] {
    return this.record.sessionIds.filter(id => this.host.candidateMatches(id, this.record.path))
  }

  async setTitle(title: string): Promise<void> {
    await this.mutate(record => ({ ...record, title }))
  }

  async attachSession(sessionId: SessionId): Promise<void> {
    // 当已定稿的快照已经计入该 id 时跳过校验：
    // cwd 事实在首次附加时已检查，且两个输入（存储的头部 cwd、工作区路径）均不可变。
    // 归属本身在 `mutate` 内部的写入链上决定，而非在此快照上。
    if (!this.record.sessionIds.includes(sessionId)) {
      const header = await this.host.readSessionHeader(sessionId)
      if (header.cwd === undefined) {
        throw new Error(
          `cannot attach session '${sessionId}' to workspace '${this.record.path}': `
          + 'its stored header carries no cwd to validate against',
        )
      }
      let cwd: string
      try {
        cwd = await realpathNormalize(header.cwd)
      } catch (error) {
        throw new Error(
          `cannot attach session '${sessionId}' to workspace '${this.record.path}': `
          + `its cwd '${header.cwd}' does not resolve, so it cannot be validated`,
          { cause: error },
        )
      }
      if (!(await stat(cwd)).isDirectory()) {
        throw new Error(
          `cannot attach session '${sessionId}' to workspace '${this.record.path}': `
          + `its cwd '${header.cwd}' is not a directory`,
        )
      }
      if (cwd !== this.record.path) {
        throw new Error(
          `cannot attach session '${sessionId}' to workspace '${this.record.path}': `
          + `its cwd resolves to '${cwd}'`,
        )
      }
      this.host.rememberSessionPath(sessionId, cwd)
    }
    await this.mutate(record => record.sessionIds.includes(sessionId)
      ? record
      : { ...record, sessionIds: [sessionId, ...record.sessionIds] })
  }

  async insertSessionBefore(sessionId: SessionId, beforeSessionId?: SessionId): Promise<void> {
    await this.mutate((record) => {
      if (!record.sessionIds.includes(sessionId)) {
        throw new WorkspaceMoveInvalidError(
          `cannot move session '${sessionId}' in workspace '${record.path}': the session is not accounted`,
        )
      }
      if (beforeSessionId !== undefined && !record.sessionIds.includes(beforeSessionId)) {
        throw new WorkspaceMoveInvalidError(
          `cannot move session '${sessionId}' before '${beforeSessionId}' in workspace '${record.path}': `
          + 'the anchor session is not accounted',
        )
      }
      if (beforeSessionId === sessionId) return record
      const without = record.sessionIds.filter(id => id !== sessionId)
      const at = beforeSessionId === undefined ? without.length : without.indexOf(beforeSessionId)
      const sessionIds = [...without.slice(0, at), sessionId, ...without.slice(at)]
      return sessionIds.every((id, index) => id === record.sessionIds[index])
        ? record
        : { ...record, sessionIds }
    })
  }

  async detachSession(sessionId: SessionId): Promise<void> {
    await this.mutate(record => record.sessionIds.includes(sessionId)
      ? { ...record, sessionIds: record.sessionIds.filter(id => id !== sessionId) }
      : record)
  }

  async status(): Promise<'ok' | 'missing-dir'> {
    try {
      return (await stat(this.record.path)).isDirectory() ? 'ok' : 'missing-dir'
    } catch {
      // 任何 stat 失败（ENOENT、悬空父目录、权限丢失）都意味着该
      // 目录当前不可用；记录本身从不发生变更。
      return 'missing-dir'
    }
  }

  /**
   * 唯一的写入路径：通过 `table.update` 在域写入链上运行 `fn`，
   * 盖章 `updatedAt` 并剪枝不再通过候选成员资格检查的候选项，然后替换快照。
   *
   * `fn` 看到其链槽位置上当前的值，因此成员资格决策
   * （附加/分离的幂等性）相对于排队的写入是无竞争的；当 fn
   * 通过原样返回 `current` 来表示无变更、且剪枝也未发现任何内容时，
   * 会通过哨兵中止该槽位，从而使得一次空操作既不会重写介质，也不会发出变更事件。
   */
  private async mutate(fn: (record: WorkspaceRecord) => WorkspaceRecord): Promise<void> {
    let next: WorkspaceRecord
    try {
      next = await this.host.table().update(this.id, (current) => {
        const changed = fn(current)
        const sessionIds = changed.sessionIds.filter(
          id => this.host.candidateMatches(id, changed.path),
        )
        if (changed === current && sessionIds.length === current.sessionIds.length) {
          throw unchangedSentinel
        }
        return { ...changed, sessionIds, updatedAt: new Date().toISOString() }
      })
    } catch (error) {
      if (error === unchangedSentinel) return
      throw error
    }
    this.record = next
  }
}
