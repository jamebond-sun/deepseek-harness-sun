/** 组合式 session-query 服务的公共配置与类型化失败。 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/** `before`/`after` 原始事件窗口的默认上限。 */
export const SESSION_QUERY_READ_WINDOW_MAX = 50

/** 一次批量读取中并发持久化日志读取的默认上限。 */
export const SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY = 4

/** 默认保留以供复用的冷 prepared-Session 观察数量上限。 */
export const SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE = 5

/** 与后端无关的配置，被每个 session-query 实现继承。 */
export interface Config {
  /** 任一侧接受的原始读取上下文上限。默认为 50。 */
  readWindowMax?: number
  /** 一次批量读取中并发的持久化日志读取上限。默认为 4。 */
  persistedReadConcurrency?: number
  /**
   * 保留以供复用的冷 prepared-Session 观察数量上限，按持久修订版本键控。
   * 被活动观察租约固定的条目在释放之前不计入该上限。默认为 5。
   */
  preparedSessionCacheSize?: number
}

/** 会话读取、追踪与搜索的稳定、可机器路由的失败分类。 */
export type SessionQueryErrorCode =
  | 'SESSION_QUERY_ABORTED'
  | 'SESSION_QUERY_CORRUPT_SESSION'
  | 'SESSION_QUERY_EVENT_NOT_FOUND'
  | 'SESSION_QUERY_INDEX_FAILED'
  | 'SESSION_QUERY_INVALID_CONFIG'
  | 'SESSION_QUERY_INVALID_CURSOR'
  | 'SESSION_QUERY_INVALID_FILTER'
  | 'SESSION_QUERY_INVALID_LIMIT'
  | 'SESSION_QUERY_INVALID_QUERY'
  | 'SESSION_QUERY_INVALID_LINEAGE'
  | 'SESSION_QUERY_INVALID_SURFACE'
  | 'SESSION_QUERY_INVALID_WINDOW'
  | 'SESSION_QUERY_PERSISTENCE_FAILED'
  | 'SESSION_QUERY_SEARCH_DISABLED'
  | 'SESSION_QUERY_SESSION_NOT_FOUND'
  | 'SESSION_QUERY_STALE_CURSOR'
  | 'SESSION_QUERY_SOURCE_CONFLICT'

/** 类型化的 session-query 失败，其 `code` 是该封闭分类的某个成员。 */
export class SessionQueryError extends HarnessError {
  declare readonly code: SessionQueryErrorCode

  // 基类保存该值；此签名把其开放的字符串 code 收窄。
  // oxlint-disable-next-line typescript/no-useless-constructor
  constructor(message: string, code: SessionQueryErrorCode, options?: ErrorOptions) {
    super(message, code, options)
  }
}
