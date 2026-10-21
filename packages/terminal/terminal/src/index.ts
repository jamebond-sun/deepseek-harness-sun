/**
 * 按所有者划分作用域的持久化 PTY 注册表。后端负责终端机制，而本服务负责
 * id、发布、授权以及被 await 的清理工作。
 * @module @deepseek-ai/dsh-terminal
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TerminalBackendCleanupError } from './types.ts'
import type {
  TerminalBackend,
  TerminalBackendSession,
  TerminalReadRequest,
  TerminalReadResult,
  TerminalSendOperation,
  TerminalSendRequest,
  TerminalSessionIdValue,
  TerminalSessionSnapshot,
  TerminalSignal,
  TerminalSignalResult,
  TerminalSpawnRequest,
  TerminalSpawnResult,
} from './types.ts'

export type {
  TerminalBackend,
  TerminalBackendSession,
  TerminalBackendSpawnSpec,
  TerminalReadRequest,
  TerminalReadResult,
  TerminalSendOperation,
  TerminalSendRead,
  TerminalSendRequest,
  TerminalSendResult,
  TerminalSessionSnapshot,
  TerminalSessionStatus,
  TerminalSignal,
  TerminalSignalResult,
  TerminalSpawnRequest,
  TerminalSpawnResult,
  TerminalWaitReason,
} from './types.ts'
export { TerminalBackendCleanupError } from './types.ts'

/** 由 {@link TerminalSessionService} 为一个活动 PTY 会话铸造的不透明身份。 */
export type TerminalSessionId = TerminalSessionIdValue

declare module '@deepseek-ai/cordis' {
  interface Context {
    terminals: TerminalSessionService
  }
}

/** 可由机器路由的 PTY 服务失败类型。 */
export type TerminalErrorCode =
  | 'DUPLICATE_BACKEND'
  | 'DUPLICATE_NAME'
  | 'FOREIGN_SESSION'
  | 'NO_BACKEND'
  | 'NO_SESSION'
  | 'OWNER_NOT_LIVE'
  | 'SEND_ACTIVE'
  | 'SERVICE_DISPOSING'

/** 携带稳定 {@link TerminalErrorCode} 的错误。 */
export class TerminalError extends Error {
  constructor(message: string, readonly code: TerminalErrorCode) {
    super(message)
    this.name = 'TerminalError'
  }
}

/**
 * 将一个由注册表铸造的字符串铸为 {@link TerminalSessionId}。
 * @param value - 注册表发布的原始 id。
 * @returns 带有 PTY 会话品牌的同一字符串。
 */
export function TerminalSessionId(value: string): TerminalSessionId {
  return value as TerminalSessionId
}

interface SessionRecord {
  readonly id: TerminalSessionId
  readonly owner: Agent
  readonly name: string | undefined
  readonly type: string
  readonly session: TerminalBackendSession
  active: TerminalSendOperation | undefined
  closing: Promise<void> | undefined
}

interface PendingSpawn {
  readonly owner: Agent
  readonly controller: AbortController
  readonly settled: Promise<void>
  cleanupFailure: { error: unknown } | undefined
}

interface SpawnReservation {
  readonly signal: AbortSignal
  release(cleanupFailure: { error: unknown } | undefined): void
}

/** In-process registry for replaceable PTY backends and exact-Agent sessions. */
export class TerminalSessionService extends Service {
  private readonly backends = new Map<string, TerminalBackend>()
  private readonly sessions = new Map<TerminalSessionId, SessionRecord>()
  private readonly reservedNames = new Map<Agent, Set<string>>()
  private readonly pendingSpawns = new Map<Agent, Set<PendingSpawn>>()
  private readonly ownerCleanups = new Map<Agent, () => Promise<void> | void>()
  private readonly disposedOwners = new WeakSet<Agent>()
  private nextId = 0
  private disposing = false

  constructor(ctx: Context) {
    super(ctx, 'terminals')
    ctx.effect(() => () => this.disposeAll(), 'pty teardown')
  }

  /**
   * 为当前 effect 作用域注册一个后端类型。
   * @param backend - 携带非空唯一类型的提供者。
   * @returns 仅移除这一项贡献的处置器。
   */
  registerBackend(backend: TerminalBackend): () => void {
    if (backend.type.length === 0) throw new Error('pty backend type must be non-empty')
    if (this.backends.has(backend.type)) {
      throw new TerminalError(`a PTY backend named "${backend.type}" is already registered`, 'DUPLICATE_BACKEND')
    }
    const dispose = this.ctx.effect(() => {
      this.backends.set(backend.type, backend)
      return () => {
        if (this.backends.get(backend.type) === backend) this.backends.delete(backend.type)
      }
    }, 'pty.registerBackend()')
    return () => void dispose()
  }

  /**
   * 按注册顺序列出已注册的后端类型。
   * @returns 全新的后端类型名称。
   */
  listBackends(): string[] {
    return [...this.backends.keys()]
  }

  /**
   * 在后端设置成功后，创建并发布一个按所有者划分作用域的会话。
   * @param owner - 拥有访问与清理权限、已精确注册的 Agent。
   * @param request - 后端类型，加上可选的属主本地名称与 cwd。
   * @param signal - 对未发布设置的取消信号。
   * @returns 已发布的身份、元数据、状态与 MOTD。
   */
  async spawn(owner: Agent, request: TerminalSpawnRequest, signal?: AbortSignal): Promise<TerminalSpawnResult> {
    this.assertActive()
    signal?.throwIfAborted()
    this.ensureOwnerCleanup(owner)
    const backend = this.backends.get(request.type)
    if (backend === undefined) throw new TerminalError(`no PTY backend registered for "${request.type}"`, 'NO_BACKEND')
    if (request.name !== undefined && request.name.length === 0) throw new Error('PTY session name must be non-empty')
    const releaseName = this.reserveName(owner, request.name)
    const spawnReservation = this.reserveSpawn(owner)
    const backendSignal = signal === undefined
      ? spawnReservation.signal
      : AbortSignal.any([signal, spawnReservation.signal])
    const sessionId = TerminalSessionId(`pty-${++this.nextId}`)
    let session: TerminalBackendSession | undefined
    let cleanupFailure: { error: unknown } | undefined
    try {
      session = await backend.spawn({
        sessionId,
        owner,
        type: request.type,
        ...request.name !== undefined ? { name: request.name } : {},
        ...request.cwd !== undefined ? { cwd: request.cwd } : {},
        signal: backendSignal,
      })
      signal?.throwIfAborted()
      if (this.disposing) {
        throw new TerminalError('PTY service is disposing', 'SERVICE_DISPOSING')
      }
      if (!this.isLiveOwner(owner)) {
        throw new TerminalError('PTY owner is no longer live', 'OWNER_NOT_LIVE')
      }
      const record: SessionRecord = {
        id: sessionId,
        owner,
        name: request.name,
        type: request.type,
        session,
        active: undefined,
        closing: undefined,
      }
      this.sessions.set(sessionId, record)
      return this.snapshot(record, session.motd)
    } catch (error) {
      if (error instanceof TerminalBackendCleanupError) {
        cleanupFailure = { error: error.cleanupError }
      }
      let rollbackFailure: { error: unknown } | undefined
      if (session !== undefined && !this.sessions.has(sessionId)) {
        try {
          await session.close('PTY spawn rolled back')
        } catch (closeError: unknown) {
          rollbackFailure = { error: closeError }
          cleanupFailure = rollbackFailure
        }
      }
      let failure: unknown = error
      try {
        signal?.throwIfAborted()
        spawnReservation.signal.throwIfAborted()
      } catch (cancellation: unknown) {
        failure = cancellation
      }
      if (rollbackFailure !== undefined && signal?.aborted !== true) {
        throw new AggregateError([failure, rollbackFailure.error], 'PTY spawn and rollback both failed')
      }
      throw failure
    } finally {
      spawnReservation.release(cleanupFailure)
      releaseName()
    }
  }

  /**
   * 检测某个精确所有者是否拥有已发布会话或未发布的生成过程。
   * @param owner - 待检查的精确活动所有者。
   * @returns 在整个“生成到关闭”区间内均为 true，不存在发布间隙。
   */
  hasOwnerActivity(owner: Agent): boolean {
    return (this.pendingSpawns.get(owner)?.size ?? 0) > 0
      || [...this.sessions.values()].some(record => record.owner === owner)
  }

  /**
   * 启动一次独占的交互式发送。
   * @param owner - 精确的会话所有者。
   * @param id - 目标 PTY 身份。
   * @param request - 显式文本、提交行为与取消信号。
   * @returns 用于前台 await 或任务注册的实时操作句柄。
   */
  startSend(owner: Agent, id: TerminalSessionId, request: TerminalSendRequest): TerminalSendOperation {
    const record = this.expectOwned(owner, id)
    if (record.closing !== undefined) throw new Error(`PTY session ${id} is closing`)
    if (record.active !== undefined) throw new TerminalError(`PTY session ${id} already has an active send`, 'SEND_ACTIVE')
    const operation = record.session.startSend(request)
    record.active = operation
    void operation.done.then(
      () => { record.active = undefined },
      () => { record.active = undefined },
    )
    return operation
  }

  /**
   * 从所属会话读取一页有界的回滚缓冲。
   * @param owner - 精确的会话所有者。
   * @param id - 目标 PTY 身份。
   * @param request - 可选的相对最新行的偏移与行数。
   * @returns 有界的保留文本与分页元数据。
   */
  read(owner: Agent, id: TerminalSessionId, request: TerminalReadRequest = {}): TerminalReadResult {
    return this.expectOwned(owner, id).session.read(request)
  }

  /**
   * 通过所属后端会话递送一个被允许的信号。
   * @param owner - 精确的会话所有者。
   * @param id - 目标 PTY 身份。
   * @param signal - 被允许的 POSIX 信号名称。
   * @returns 已递送的前台进程组身份。
   */
  signal(owner: Agent, id: TerminalSessionId, signal: TerminalSignal): Promise<TerminalSignalResult> {
    return this.expectOwned(owner, id).session.signal(signal)
  }

  /**
   * 关闭一个所属会话，并仅在后端清理达到静止后才将其移除。
   * @param owner - 精确的会话所有者。
   * @param id - 目标 PTY 身份。
   * @param reason - 诊断性清理原因。
   * @returns 对于新关闭的会话返回 true；当同一关闭已在进行中时返回 false。
   */
  async kill(owner: Agent, id: TerminalSessionId, reason: string = 'model request'): Promise<boolean> {
    const record = this.expectOwned(owner, id)
    if (record.closing !== undefined) {
      await record.closing
      return false
    }
    const closing = record.session.close(reason)
    record.closing = closing
    try {
      await closing
      this.sessions.delete(id)
      return true
    } catch (error) {
      record.closing = undefined
      throw error
    }
  }

  /**
   * 为恰好一个所有者列出全新的快照。
   * @param owner - 会话可见的精确所有者。
   * @returns 按发布顺序排列、对所有者可见的快照。
   */
  list(owner: Agent): TerminalSessionSnapshot[] {
    return [...this.sessions.values()]
      .filter(record => record.owner === owner)
      .map(record => this.snapshot(record))
  }

  private assertActive(): void {
    if (this.disposing) throw new TerminalError('PTY service is disposing', 'SERVICE_DISPOSING')
  }

  private isLiveOwner(owner: Agent): boolean {
    return !this.disposedOwners.has(owner) && this.ctx.get('agents')?.get(owner.id) === owner
  }

  private ensureOwnerCleanup(owner: Agent): void {
    if (!this.isLiveOwner(owner)) {
      throw new TerminalError(`agent "${owner.id}" is not the registered PTY owner`, 'OWNER_NOT_LIVE')
    }
    if (this.ownerCleanups.has(owner)) return
    const detach = owner.ctx.effect(() => async () => {
      this.disposedOwners.add(owner)
      this.ownerCleanups.delete(owner)
      await this.disposeOwned(owner)
    }, 'pty.ownerCleanup()')
    this.ownerCleanups.set(owner, detach)
  }

  private reserveName(owner: Agent, name: string | undefined): () => void {
    if (name === undefined) return () => {}
    if ([...this.sessions.values()].some(record => record.owner === owner && record.name === name)) {
      throw new TerminalError(`PTY session name "${name}" already exists for this owner`, 'DUPLICATE_NAME')
    }
    const reserved = this.reservedNames.get(owner) ?? new Set<string>()
    if (reserved.has(name)) throw new TerminalError(`PTY session name "${name}" is already being created`, 'DUPLICATE_NAME')
    reserved.add(name)
    this.reservedNames.set(owner, reserved)
    return () => {
      reserved.delete(name)
      if (reserved.size === 0) this.reservedNames.delete(owner)
    }
  }

  private reserveSpawn(owner: Agent): SpawnReservation {
    const controller = new AbortController()
    const settlement = Promise.withResolvers<void>()
    const pending: PendingSpawn = { owner, controller, settled: settlement.promise, cleanupFailure: undefined }
    const owned = this.pendingSpawns.get(owner) ?? new Set<PendingSpawn>()
    owned.add(pending)
    this.pendingSpawns.set(owner, owned)
    return {
      signal: controller.signal,
      release: (cleanupFailure) => {
        pending.cleanupFailure = cleanupFailure
        if (cleanupFailure === undefined) this.removePendingSpawn(pending)
        settlement.resolve()
      },
    }
  }

  private removePendingSpawn(pending: PendingSpawn): void {
    const owned = this.pendingSpawns.get(pending.owner)
    if (owned === undefined) return
    owned.delete(pending)
    if (owned.size === 0) this.pendingSpawns.delete(pending.owner)
  }

  private async abortPendingSpawns(owner: Agent | undefined, reason: TerminalError): Promise<void> {
    const pending = owner === undefined
      ? [...this.pendingSpawns.values()].flatMap(owned => [...owned])
      : [...(this.pendingSpawns.get(owner) ?? [])]
    for (const spawn of pending) spawn.controller.abort(reason)
    await Promise.all(pending.map(spawn => spawn.settled))
    const failures = pending.flatMap(spawn => spawn.cleanupFailure === undefined ? [] : [spawn.cleanupFailure.error])
    for (const spawn of pending) this.removePendingSpawn(spawn)
    if (failures.length > 0) {
      throw new AggregateError(failures, 'failed to roll back unpublished PTY setup')
    }
  }

  private expectOwned(owner: Agent, id: TerminalSessionId): SessionRecord {
    const record = this.sessions.get(id)
    if (record === undefined) throw new TerminalError(`unknown PTY session ${id}`, 'NO_SESSION')
    if (record.owner !== owner) throw new TerminalError(`PTY session ${id} belongs to another agent`, 'FOREIGN_SESSION')
    return record
  }

  private snapshot(record: SessionRecord): TerminalSessionSnapshot
  private snapshot(record: SessionRecord, motd: string): TerminalSpawnResult
  private snapshot(record: SessionRecord, motd?: string): TerminalSpawnResult | TerminalSessionSnapshot {
    return {
      sessionId: record.id,
      ...record.name !== undefined ? { name: record.name } : {},
      type: record.type,
      ...record.session.pid !== undefined ? { pid: record.session.pid } : {},
      status: record.session.status(),
      ...motd !== undefined ? { motd } : {},
    }
  }

  private async abortAndClose(owner: Agent | undefined, abortReason: TerminalError, closeReason: string): Promise<void> {
    const failures: unknown[] = []
    try {
      await this.abortPendingSpawns(owner, abortReason)
    } catch (error: unknown) {
      failures.push(error)
    }
    const records = [...this.sessions.values()].filter(record => owner === undefined || record.owner === owner)
    try {
      await this.closeRecords(records, closeReason)
    } catch (error: unknown) {
      failures.push(error)
    }
    if (failures.length > 0) throw new AggregateError(failures, 'failed to clean up PTY lifecycle')
  }

  private async disposeOwned(owner: Agent): Promise<void> {
    try {
      await this.abortAndClose(
        owner,
        new TerminalError('PTY owner is no longer live', 'OWNER_NOT_LIVE'),
        'PTY owner disposed',
      )
    } finally {
      this.reservedNames.delete(owner)
    }
  }

  private async disposeAll(): Promise<void> {
    this.disposing = true
    // 拆除是尽力而为的：即便关闭失败，也会在聚合错误传播之前清空注册表并运行
    // 所有者清理，因此一个卡住的会话无法让后端、预留项或所有者脱离器变成孤儿。
    try {
      await this.abortAndClose(
        undefined,
        new TerminalError('PTY service is disposing', 'SERVICE_DISPOSING'),
        'PTY service disposed',
      )
    } finally {
      this.backends.clear()
      this.reservedNames.clear()
      this.pendingSpawns.clear()
      const cleanups = [...this.ownerCleanups.values()]
      this.ownerCleanups.clear()
      await Promise.all(cleanups.map(cleanup => Promise.resolve(cleanup())))
    }
  }

  private async closeRecords(records: SessionRecord[], reason: string): Promise<void> {
    const results = await Promise.allSettled(records.map(async (record) => {
      const closing = record.closing ?? record.session.close(reason)
      record.closing = closing
      try {
        await closing
        this.sessions.delete(record.id)
      } catch (error: unknown) {
        // 一个并发的重试可能已经持有一个更新的栅栏；绝不能清除它。
        if (record.closing === closing) record.closing = undefined
        throw error
      }
    }))
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map<unknown>(result => result.reason as unknown)
    if (failures.length > 0) throw new AggregateError(failures, `failed to close ${failures.length} PTY session(s)`)
  }
}

export default TerminalSessionService
