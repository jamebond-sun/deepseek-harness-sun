/**
 * 持久化的 session-persistence 服务定义（`ctx.sessionPersistence`）。后端将
 * {@link SessionEvent} 作为事件溯源日志存储，并把不可回放的
 * {@link SessionHeader} 元数据分开携带；调用方通过从 `create`/`open`
 * 获得的 {@link SessionHandle} 来寻址一个已存储的会话。
 * @module @deepseek-ai/dsh-session-persistence
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionHandle, SessionAccess } from './handle.ts'
import type { SessionPersistenceRevision } from './revision.ts'

// 重新导出元数据词表，以便消费方从服务定义处导入它。
export type { SessionHeader } from '@deepseek-ai/dsh-session'
export { SessionPersistenceRevision } from './revision.ts'
export type {
  SessionAccess,
  SessionHandle,
  SessionHandleAppendOptions,
  SessionHandleFlushOptions,
  SessionHandleReadOptions,
  SessionHandleReadResult,
} from './handle.ts'
export {
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionFormatUnsupportedError,
  SessionHandleClosedError,
  SessionOwnershipLostError,
  SessionPersistenceCorruptionError,
  SessionPersistenceNotFoundError,
  SessionReadOnlyError,
  sessionFormatVersionRefusal,
} from './errors.ts'
export type { SessionLocation } from './errors.ts'
export {
  assertContiguous,
  assertStoredId,
  assertVersion,
  materializeAppendBatch,
  materializeCreateHeader,
  validateStoredEvents,
} from './storage-contract.ts'

/**
 * 由 {@link SessionPersistence.stat} 与 {@link SessionPersistence.list} 返回的
 * 轻量级已存储会话观测结果，无需读取完整事件日志。
 */
export interface SessionPersistenceSnapshot {
  /** 某个已存储会话的已分离元数据。 */
  readonly header: SessionHeader
  /** 仅看头部的格式分类；缺少带版本的制品元数据时不存在。 */
  readonly formatStatus?: 'current' | 'migration-required'
  /** 不透明的变更令牌；参见 {@link SessionPersistence.stat}。 */
  readonly revision: SessionPersistenceRevision
  /** 逻辑事件数，当后端能从元数据低成本地提供时才存在；否则不存在。 */
  readonly eventCount?: number
  /** 物理制品字节大小，当后端能低成本地提供时（JSONL）才存在；否则不存在。 */
  readonly sizeBytes?: number
}

/** {@link SessionPersistence.create} 的选项。 */
export interface SessionPersistenceCreateOptions {
  /** 可选取消信号，在后端工作开始之前被观测。 */
  readonly signal?: AbortSignal
  /**
   * 精确的 fork 继承前缀长度。当 `header.isSeeded` 为 true 时必需，
   * 否则必须省略（或为 `0`）；后端会在 create 时拒绝不匹配的情况。
   */
  readonly inheritedEventCount?: SessionLogOffset
}

/**
 * 逻辑 Session 头部与其精确继承切点配对，用于承载事件体的存储操作。
 * `isSeeded` 在头部上标记 fork 血缘；数值切点随其一起传递，
 * 从不在可回放的事件日志之内。
 */
export interface SessionStorageMetadata {
  /** 已校验的不可变 Session 头部。 */
  readonly meta: SessionHeader
  /** 从该 Session 的 fork 父会话继承的前置事件数量。 */
  readonly inheritedEventCount: SessionLogOffset
}

/** 不可变的逻辑会话读取：存储元数据加上完整且已校验的事件日志。 */
export interface SessionInspection extends SessionStorageMetadata {
  /** 从 seq 0 开始的连续已校验事件。 */
  readonly events: readonly SessionEvent[]
}

/** {@link SessionPersistence.open} 的选项。 */
export interface SessionPersistenceOpenOptions {
  /** 可选取消信号，在后端工作开始之前被观测。 */
  readonly signal?: AbortSignal
}

/** {@link SessionPersistence.stat} 的选项。 */
export interface SessionPersistenceStatOptions {
  /** 可选取消信号，用于后端元数据读取。 */
  readonly signal?: AbortSignal
}

/** {@link SessionPersistence.list} 的选项。 */
export interface SessionPersistenceListOptions {
  /** 可选取消信号，用于后端列举工作。 */
  readonly signal?: AbortSignal
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionPersistence: SessionPersistence
  }
}

/**
 * 通过按会话划分的句柄寻址的、仅可追加的持久会话存储。
 *
 * 每个后端共有的存储语义：事件从 seq 0 开始连续且永不被重写；被撕裂的物理
 * 尾部永不返回给读取方，并由写入路径在其首次追加之前截断；读取只校验当前
 * 格式的记录，并以失败关闭的方式拒绝未知词表。`append` 是尽力而为地持久化；
 * `flush`——按句柄或整个服务范围——才是持久性屏障。
 *
 * 可见性：从 `create` resolve 的那一刻起，已创建的会话在本进程中即可通过
 * `stat`/`list`/`open` 被观测到，即使后端推迟了物理物化（纯粹的优化）；
 * 其它进程只有在该会话物化之后才能看到它，而在崩溃前从未物化的会话就等同于
 * 从未存在过。`SessionHandle.flush` 会强制物化。
 *
 * 新鲜度：一旦某个 `append` 或 `flush` resolve，之后在该后端实例上开始的
 * 读取至少能观测到该前缀。
 */
export abstract class SessionPersistence extends Service {
  /** 进程内实例身份，经由 Context 代理保持稳定，且在服务被替换后不同。 */
  readonly identity: symbol = Symbol('sessionPersistence')

  constructor(ctx: Context) {
    super(ctx, 'sessionPersistence')
  }

  /**
   * 创建一个新的已存储会话并取得其写所有权。
   * @param header - 要存储的不可变头部（id、version、cwd、血缘）。
   * @param options - 可选取消信号。
   * @returns 由调用方持有的 `write` 句柄；关闭它以释放所有权。
   * @throws {SessionAlreadyExistsError} 当该 id 已存在时抛出。
   */
  abstract create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandle>

  /**
   * 打开一个已存在的已存储会话。
   *
   * `read` 从不取得所有权，并且在另一个句柄（或进程）持有写所有权时依然可用。
   * `write` 以原子方式申领单写者所有权；若已存在活跃持有者则拒绝。
   * @param id - 要打开的已存储会话。
   * @param access - `read` 或 `write`。
   * @param options - 可选取消信号。
   * @returns 已打开的句柄。
   * @throws {SessionPersistenceNotFoundError} 当该会话不存在时抛出。
   * @throws {SessionAlreadyOwnedError} 以 `write` 打开且所有权已被占用时抛出。
   */
  abstract open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle>

  /**
   * 在一个持久性屏障中刷新本服务实例持有的每个活跃写句柄：每个句柄所路由的
   * 实时事件被持久地排空，其会话被物化，效果与该句柄自身的
   * `SessionHandle.flush` 完全一致。读句柄不缓冲任何内容，因此不受影响。
   * 并发关闭的句柄视为已刷新——关闭操作本身就会持久地排空。
   * @returns 当调用时处于活跃状态的每个写句柄都刷新完成后 resolve。
   * @throws {AggregateError} 指出每个刷新失败的会话；其余句柄仍会刷新。
   */
  abstract flush(): Promise<void>

  /**
   * 观测一个已存储的会话，不读取其事件日志，也不取得所有权。
   *
   * 快照中的 `revision` 是一个不透明的变更令牌，只能与来自同一服务实例和
   * 同一会话 id 的修订值比较：修订值相等可视为日志未变更；修订值不相等则不
   * 提供任何承诺。写所有权的更替不会改变修订值。它服务于以 `stat`/`list`
   * 为键的派生读模型缓存；在 open、read 或 resume 中不起作用。
   * @param id - 要观测的已存储会话。
   * @param options - 可选取消信号。
   * @returns 该快照；当会话不存在时为 `undefined`。
   */
  abstract stat(id: SessionId, options?: SessionPersistenceStatOptions): Promise<SessionPersistenceSnapshot | undefined>

  /**
   * 列出本进程可见的每个已存储会话，不承诺任何顺序。
   * @param options - 可选取消信号。
   * @returns 每个已存储会话对应一个快照。
   */
  abstract list(options?: SessionPersistenceListOptions): Promise<readonly SessionPersistenceSnapshot[]>
}

export default SessionPersistence
