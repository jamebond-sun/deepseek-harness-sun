/**
 * 按会话划分的存储句柄：通向某个已存储会话的追加式事件日志的一条开放通道，
 * 由 `SessionPersistence.create`/`open` 返回。
 * @module @deepseek-ai/dsh-session-persistence/handle
 */

import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset, SessionSeedEventState } from '@deepseek-ai/dsh-session'

/**
 * 一次打开所授予的日志访问方式。`write` 是可读写的：它是该会话的唯一
 * 修改者，同时也能读取自身的日志。`read` 只做观察——它从不取得所有权，
 * 并且在另一个句柄或进程持有 `write` 时依然可用。
 */
export type SessionAccess = 'read' | 'write'

/** {@link SessionHandle.read} 的选项。 */
export interface SessionHandleReadOptions {
  /** 可选取消信号，用于后端读取工作。 */
  readonly signal?: AbortSignal
}

/** {@link SessionHandle.read} 返回的一个持久化事件切片。 */
export interface SessionHandleReadResult {
  /**
   * 事件值是独占所有的，还是仅在深度冻结之后共享。切片会保留生产者的状态，
   * 即使没有任何事件剩余。
   */
  readonly eventState: SessionSeedEventState
  /** 放在由调用方持有的外层数组中的事件值。 */
  readonly events: readonly SessionEvent[]
}

/** {@link SessionHandle.append} 的选项。 */
export interface SessionHandleAppendOptions {
  /** 可选取消信号，在写入开始之前被观测。 */
  readonly signal?: AbortSignal
}

/** {@link SessionHandle.flush} 的选项。 */
export interface SessionHandleFlushOptions {
  /** 可选取消信号，在屏障开始之前被观测。 */
  readonly signal?: AbortSignal
}

/**
 * 通向一个已存储会话的开放通道。句柄是单持有者状态，而非共享服务：
 * `read` 永不回退到该句柄此前已观测到的位置之下，`write` 句柄能读到自己
 * 成功追加的内容，`close()` 是唯一的拆卸操作（幂等、不可取消；
 * `Symbol.asyncDispose` 会委托给它）。对已关闭句柄的任何操作都会以
 * `SessionHandleClosedError` 拒绝。
 *
 * 跨句柄的新鲜度：一旦某个写句柄上的 `append` 或 `flush` 完成，之后在
 * 同一个后端实例上开始的每一次读取——无论在哪个句柄上，或通过
 * `stat`/`list`——都至少能观测到该前缀。与变更并发进行的读取，
 * 除了有效的连续前缀之外不提供任何顺序承诺。
 */
export interface SessionHandle extends AsyncDisposable {
  /** 该句柄所寻址的已存储会话。 */
  readonly id: SessionId
  /** 不可变的已存储头部，在 `create`/`open` 时固定。 */
  readonly header: SessionHeader
  /**
   * 随日志一起存储的精确 fork 继承前缀长度；当 `header.isSeeded` 为 false 时为 `0`。
   * 这是与头部配对的存储元数据，供每次事件体读取使用，从不属于可回放的事件日志。
   */
  readonly inheritedEventCount: SessionLogOffset
  /** 该句柄是否可以修改日志。 */
  readonly access: SessionAccess

  /**
   * 读取有效连续逻辑日志的一个切片。该切片是一段合法的日志前缀片段：
   * 绝不返回被撕裂的物理尾部，并且在该句柄上重复读取永不观测到比前一次
   * 读取更旧的状态。
   * @param offset - 要包含的首个逻辑事件 seq；默认为 `0`。
   * @param length - 要返回的最大事件数；默认为日志的剩余部分。
   *   位于末尾或超出末尾的 offset 会返回空列表。
   * @param options - 可选取消信号。
   * @returns 由调用方持有的外层切片，以及其事件值的持有状态。
   */
  read(offset?: number, length?: number, options?: SessionHandleReadOptions): Promise<SessionHandleReadResult>

  /**
   * 追加一批延续当前逻辑末端的连续事件。首个事件的 `seq` 必须等于已存储的
   * next-seq；已提交的事件永不被重写。持久化是尽力而为的：resolve 时该批次
   * 已被接受、排序，并且对该后端实例上的读取可见，但只有已 resolve 的
   * {@link flush} 才承诺它能抵御崩溃——后端可以把物理写入缓冲或批量化在
   * append 之后。在读句柄上会以 `SessionReadOnlyError` 拒绝；当写所有权
   * 丧失时以 `SessionOwnershipLostError` 拒绝。
   * @param events - 按 seq 排序的连续批次。
   * @param options - 可选取消信号，在写入开始之前被观测。
   */
  append(events: readonly SessionEvent[], options?: SessionHandleAppendOptions): Promise<void>

  /**
   * 持久性屏障——唯一承诺已存储的操作：resolve 时每个已被确认的追加都是
   * 持久的，并且该会话已为其它进程物化；空的已创建会话在此处变为可持久列举。
   * 必须抵御崩溃的调用方应当 flush；对于 append 在 resolve 时即已持久化的后端，
   * 这里按“需要时才物化”处理。在读句柄上会以 `SessionReadOnlyError` 拒绝。
   * @param options - 可选取消信号，在屏障开始之前被观测。
   */
  flush(options?: SessionHandleFlushOptions): Promise<void>

  /**
   * 释放该句柄：读句柄释放本地资源；写句柄完成待处理的持久化并释放写所有权。
   * 该操作幂等、异步，且刻意不可取消。
   */
  close(): Promise<void>
}
