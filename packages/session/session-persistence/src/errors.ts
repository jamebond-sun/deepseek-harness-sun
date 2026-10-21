/**
 * session-persistence 服务及其句柄所暴露的稳定失败类型，
 * 其中包括每个后端共有的格式拒绝：本构建无法忠实解释的已存储日志会被拒绝，
 * 而绝不会被误读；当后端为每个会话保留一份原始制品时，拒绝信息会指向它。
 * @module @deepseek-ai/dsh-session-persistence/errors
 */

import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** 所请求的 Session 身份对本调用方没有可见的持久日志。 */
export class SessionPersistenceNotFoundError extends Error {
  /** @param sessionId - 缺失的持久 Session 身份。 */
  constructor(readonly sessionId: SessionId) {
    super(`session "${sessionId}" not found`)
    this.name = 'SessionPersistenceNotFoundError'
  }
}

/** `create` 指向了一个在该后端中已存在的 Session 身份。 */
export class SessionAlreadyExistsError extends Error {
  /** @param sessionId - 已被占用的持久 Session 身份。 */
  constructor(readonly sessionId: SessionId) {
    super(`session "${sessionId}" already exists`)
    this.name = 'SessionAlreadyExistsError'
  }
}

/** 一次写打开发现该会话已绑定到一个活跃的写句柄。 */
export class SessionAlreadyOwnedError extends Error {
  /** @param sessionId - 其写所有权已被占用的会话。 */
  constructor(readonly sessionId: SessionId) {
    super(`session "${sessionId}" is already owned by an active write handle`)
    this.name = 'SessionAlreadyOwnedError'
  }
}

/** 在只读句柄上调用了变更操作（`append`/`flush`）。 */
export class SessionReadOnlyError extends Error {
  /**
   * @param sessionId - 该读句柄所观测的会话。
   * @param operation - 被拒绝的变更操作名。
   */
  constructor(readonly sessionId: SessionId, operation: string) {
    super(`session "${sessionId}": ${operation} is not available on a read handle`)
    this.name = 'SessionReadOnlyError'
  }
}

/**
 * 某个写句柄的所有权已永久丧失：其租约已过期、续约失败，或持久的所有权记录
 * 不再指向该句柄。该句柄永不重新取得所有权——请关闭它并重新以写方式打开。
 *
 * 该类型为跨进程租约层声明；已发布的进程内后端目前还不会抛出它。
 */
export class SessionOwnershipLostError extends Error {
  /** @param sessionId - 本句柄丧失其写所有权的会话。 */
  constructor(readonly sessionId: SessionId) {
    super(`session "${sessionId}": write ownership was lost; close this handle and reopen`)
    this.name = 'SessionOwnershipLostError'
  }
}

/** 在调用 `close()` 之后又在该句柄上调用了某个操作。 */
export class SessionHandleClosedError extends Error {
  /**
   * @param sessionId - 该已关闭句柄所寻址的会话。
   * @param operation - 被拒绝的操作名。
   */
  constructor(readonly sessionId: SessionId, operation: string) {
    super(`session "${sessionId}": ${operation} on a closed handle`)
    this.name = 'SessionHandleClosedError'
  }
}

/**
 * 由后端解析出的、按会话划分的本地制品位置。只被拒绝诊断信息
 * （{@link SessionFormatUnsupportedError}）携带，以便用户能找到某个构建拒绝
 * 解释的原始日志；它不是面向使用者的查询——日志访问要走会话句柄的 `read`。
 */
export interface SessionLocation {
  /** 后端特有的制品类型，例如 `jsonl`。 */
  readonly kind: string
  /** 该会话由后端持有的制品的绝对路径。 */
  readonly path: string
}

/** 持久会话内容在一次成功的后端读取之后未能通过校验。 */
export class SessionPersistenceCorruptionError extends Error {
  /**
   * @param message - 稳定的损坏上下文。
   * @param options - 原始的校验失败。
   */
  constructor(message: string, options: ErrorOptions) {
    super(message, options)
    this.name = 'SessionPersistenceCorruptionError'
  }
}

/**
 * 已存储日志完好无损，但本运行时无法忠实解释它：头部带有不受支持的格式版本，
 * 或某个事件的类型是本构建所未知的。与 {@link SessionPersistenceCorruptionError}
 * 不同——没有任何东西被损坏；当后端为每个会话保留一份制品时，原始日志在
 * {@link location} 处仍然可读。
 */
export class SessionFormatUnsupportedError extends Error {
  /**
   * @param message - 日志无法被解释的稳定原因，若存在原始日志路径则已包含它。
   * @param location - 后端的制品位置，若存在的话。
   */
  constructor(message: string, readonly location?: SessionLocation) {
    super(message)
    this.name = 'SessionFormatUnsupportedError'
  }
}

/**
 * 针对某个格式版本不被本构建读取的已存储会话，生成方向感知的拒绝文本。
 * 供加载期检查使用，也供那些必须在解码与版本相关的结构之前就拒绝的后端使用
 * （未来的格式可能根本无法满足本构建的结构性检查，并且用户必须看到
 * “升级 harness”，而绝不是“已损坏”）。
 * @param id - 已存储的会话 id，用于消息上下文。
 * @param version - 已存储的格式版本。
 * @returns 稳定的拒绝文本，不含原始日志路径后缀。
 */
export function sessionFormatVersionRefusal(id: string, version: number): string {
  return version > SESSION_FORMAT_VERSION
    ? `session "${id}" uses log format v${version}, but this harness reads only v${SESSION_FORMAT_VERSION}: the log was written by a newer harness — upgrade the harness to open it`
    : `session "${id}" uses log format v${version}, older than the supported v${SESSION_FORMAT_VERSION}, and this build ships no upgrade path for it`
}
