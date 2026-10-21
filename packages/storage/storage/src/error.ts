/**
 * 存储中枢及其后端的错误概念词汇。
 * @module @deepseek-ai/dsh-storage/src/error
 */

/** 每个 {@link StorageError} 携带的判别码。 */
export type StorageErrorCode =
  | 'backend-not-found'
  | 'form-not-mounted'
  | 'duplicate-backend'
  | 'duplicate-mount'
  | 'version-mismatch'
  | 'malformed-medium'
  | 'closed'

/**
 * 由中枢及后端实现抛出的错误。`code` 是消费者可据此分支判断的稳定契约，`message` 为诊断性叙述。
 */
export class StorageError extends Error {
  override readonly name = 'StorageError'

  /**
   * @param code - 失败类别的稳定判别码。
   * @param message - 人类可读的诊断细节。
   * @param options - 标准错误选项（`cause`）。
   */
  constructor(
    readonly code: StorageErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}
