/**
 * 领域数据形式的错误概念词汇。
 * @module @deepseek-ai/dsh-storage-domain/src/error
 */

/** 每个 {@link DomainError} 携带的判别码。 */
export type DomainErrorCode =
  | 'already-open'
  | 'facet-unsupported'
  | 'invalid-record'
  | 'missing-key'
  | 'closed'

/** 在持久化边界处 schema 校验失败的记录位置。 */
export interface InvalidRecordDetail {
  /** 持有被拒记录的表；全局单例为 `''`。 */
  readonly table: string
  /** 被拒记录的键；全局单例为 `''`。 */
  readonly key: string
}

/** 构造选项：标准 `cause` 外加 `invalid-record` 的位置。 */
export interface DomainErrorOptions extends ErrorOptions {
  /** 仅当 `code` 为 `invalid-record` 时存在。 */
  readonly detail?: InvalidRecordDetail
}

/**
 * 由领域层抛出的错误。`code` 是消费者可据此分支判断的稳定契约，`message` 为诊断性叙述。
 * 后端失败（`backend-not-found`、`version-mismatch` 等）作为 `StorageError` 透传——领域层不会重新包装它们。
 */
export class DomainError extends Error {
  override readonly name = 'DomainError'

  /** 仅当 `code` 为 `invalid-record` 时存在。 */
  readonly detail?: InvalidRecordDetail

  /**
   * @param code - 失败类别的稳定判别码。
   * @param message - 人类可读的诊断细节。
   * @param options - 标准错误选项外加 `invalid-record` 的位置。
   */
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    options?: DomainErrorOptions,
  ) {
    super(message, options)
    if (options?.detail) this.detail = options.detail
  }
}
