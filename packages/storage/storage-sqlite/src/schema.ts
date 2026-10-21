/**
 * SQLite 存储后端用的 schema + 打开期辅助：物理布局版本、数据库打开/配置序列（权限、pragma、版本戳/拒绝），
 * 以及单元元数据表。单元记录表在 `unit.ts` 中按 descriptor 创建。
 * @module @deepseek-ai/dsh-storage-sqlite/schema
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { StorageError } from '@deepseek-ai/dsh-storage'

/**
 * 磁盘上的物理布局版本，存储在 `PRAGMA user_version` 中。与每个单元自身的 `version`（按单元盖在 `units` 行中）正交。
 * 仅在表布局发生破坏性变更时递增；任何其他已盖版本都拒绝——此未发布格式没有迁移。
 */
export const STORAGE_SQLITE_SCHEMA_VERSION = 1

/**
 * 后端运行的日志模式。`wal` 是默认；回滚日志模式（`delete`/`truncate`/`persist`）用于 WAL 的共享内存文件不工作的文件系统（网络挂载）。
 * `memory`/`off` 被排除：丢弃日志持久性会悄然违背 KV 后端契约的持久性条款。
 */
export type JournalMode = 'wal' | 'delete' | 'truncate' | 'persist'

/* jscpd:ignore-start -- 刻意镜像 session-query-sqlite 的打开序列。每个包拥有独立的数据库身份与 schema，
   因此共享辅助会耦合本应相互独立的存储提供方（见领域 KV 存储 Agent Note 的复用审计）。 */
/**
 * 以仅属主权限排他地创建缺失的数据库文件。已存在的文件保留其模式，且除 `EEXIST` 外的错误会传播。
 * `DatabaseSync` 按路径重新打开，因此当其他主体可在其父目录中替换数据库条目时，这并不保护机密性或完整性。
 */
async function createDatabaseFile(path: string): Promise<void> {
  try {
    const handle = await open(path, 'wx', 0o600)
    await handle.close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/**
 * 打开数据库并应用其 schema 与 pragma。缺失的目录与数据库文件以仅属主权限创建（`:memory:` 跳过文件系统设置）。
 * 零 `user_version` 会盖上 {@link STORAGE_SQLITE_SCHEMA_VERSION}；每个其他非当前版本都会被拒绝而非就地迁移。
 * @param path - 要打开的 SQLite 数据库文件，或 `:memory:`。
 * @param journalMode - 已校验的日志 pragma。
 * @returns 已应用 pragma 并确保单元元数据表存在的打开句柄。
 */
export async function openDatabase(path: string, journalMode: JournalMode): Promise<DatabaseSync> {
  const actual = path === ':memory:' ? path : resolve(path)
  if (actual !== ':memory:') {
    await mkdir(dirname(actual), { recursive: true, mode: 0o700 })
    await createDatabaseFile(actual)
  }
  const db = new DatabaseSync(actual)
  try {
    configureDatabase(db, actual, journalMode)
    return db
  } catch (error: unknown) {
    db.close()
    throw error
  }
}

function configureDatabase(db: DatabaseSync, path: string, journalMode: JournalMode): void {
  db.exec('PRAGMA foreign_keys = ON')
  // 已校验的联合可安全插值到不可绑定的 PRAGMA 中。
  db.exec(`PRAGMA journal_mode = ${journalMode.toUpperCase()}`)
  // `PRAGMA user_version` 总是恰好返回一行 { user_version }。
  const { user_version: onDisk } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  if (onDisk !== 0 && onDisk !== STORAGE_SQLITE_SCHEMA_VERSION) {
    throw new StorageError(
      'version-mismatch',
      `storage database at "${path}" has schema version ${onDisk}, incompatible with this build (${STORAGE_SQLITE_SCHEMA_VERSION})`,
    )
  }
  /* jscpd:ignore-end */
  db.exec(`
    CREATE TABLE IF NOT EXISTS units (
      name    TEXT PRIMARY KEY,
      version INTEGER NOT NULL
    ) STRICT
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS unit_globals (
      unit  TEXT PRIMARY KEY REFERENCES units(name),
      value TEXT NOT NULL
    ) STRICT
  `)
  if (onDisk === 0) {
    // 最后才为全新数据库盖戳：盖戳断言布局已完整，因此上方的失败必须让介质保持未盖戳
    // （障碍清除后重新打开会从头重试物化）。
    db.exec(`PRAGMA user_version = ${STORAGE_SQLITE_SCHEMA_VERSION}`)
  }
}

/**
 * 一个单元表的物理表名。两段在到达此处之前都按 `UNIT_NAME_RE` 校验，因此结果可安全插值到 DDL 与预处理语句文本中。
 * @param unit - 已校验的单元名。
 * @param table - 已校验的表名。
 * @returns `u_<unit>_<table>` 标识符。
 */
export function recordTableName(unit: string, table: string): string {
  return `u_${unit}_${table}`
}
