/** 当持久 Session 制品无法无损恢复或迁移时抛出的错误。 */
export class SessionFormatError extends Error {
  override readonly name: string = 'SessionFormatError'
}

/** 可读制品，但其已发布源策略没有受支持的迁移路径。 */
export class SessionFormatUnsupportedMigrationError extends SessionFormatError {
  override readonly name = 'SessionFormatUnsupportedMigrationError'
}
