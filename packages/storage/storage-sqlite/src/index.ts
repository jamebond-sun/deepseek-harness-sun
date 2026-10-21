/**
 * 存储中枢的 SQLite 存储后端：一个数据库文件承载每个被路由的单元，每行一个文档（`key TEXT` / `value TEXT` JSON）。
 * 注册为后端 `sqlite`；disposer 先注销，再关闭介质。
 * @module @deepseek-ai/dsh-storage-sqlite
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { DatabaseSync } from 'node:sqlite'
import { StorageError, UNIT_NAME_RE, storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import type { KvFacet, KvUnit, KvUnitDescriptor, StorageBackend } from '@deepseek-ai/dsh-storage'
import { openDatabase, recordTableName, type JournalMode } from './schema.ts'
import { SqliteKvUnit } from './unit.ts'

export { STORAGE_SQLITE_SCHEMA_VERSION, type JournalMode } from './schema.ts'

/** Cordis 插件名称。 */
export const name = 'storage-sqlite'
/** 后端注册到存储中枢上。 */
export const inject = ['storage']

/** 插件配置。 */
export interface Config {
  /**
   * SQLite 数据库文件的文件系统路径。特殊值 `:memory:` 打开一个进程内数据库（测试用）。
   * 在具有 POSIX 模式的文件系统上，缺失的目录与数据库以仅属主权限创建；已存在路径的模式被保留。
   * 除已存在数据库外的文件系统设置错误会使打开失败。当其他主体可在其父目录中替换数据库条目时，
   * 后端不保护机密性或完整性。
   */
  path: string
  /**
   * SQLite `journal_mode` pragma。`wal`（默认）适合本地磁盘；在 WAL 的共享内存文件不工作的文件系统（网络挂载）上，
   * 选择回滚日志模式（`delete`/`truncate`/`persist`）。见 {@link JournalMode}。
   */
  journalMode?: JournalMode
}

/** 针对 {@link Config} 的 schemastery 校验器。 */
export const Config: z<Config> = z.object({
  path: z.string().required(),
  journalMode: z.union(['wal', 'delete', 'truncate', 'persist'] as const).default('wal'),
})

/**
 * SQLite {@link StorageBackend}。拥有一个 `DatabaseSync` 连接与已打开单元表；`kv.open` 校验名称，
 * 在 `units` 中强制每个单元的版本戳，并确保该单元的记录表存在。
 */
export class SqliteStorageBackend implements StorageBackend {
  /** 键值 facet；是此后端服务的唯一形态。 */
  readonly kv: KvFacet = { open: descriptor => this.openUnit(descriptor) }

  private readonly ready: Promise<DatabaseSync>
  /** 已打开（或仍在打开中）的单元，以名为键；存在即双重打开守卫。 */
  private readonly units = new Map<string, Promise<SqliteKvUnit>>()
  private closing: Promise<void> | undefined

  /**
   * @param config - 已校验的插件配置。
   */
  constructor(config: Config) {
    this.ready = openDatabase(config.path, (config as Required<Config>).journalMode)
    // 将拒绝标记为已处理：每个原语都会重新等待 `ready`，因此打开失败仍会浮现给每个调用方；
    // 此守卫仅防止在首次使用之前失败导致未处理拒绝崩溃。
    this.ready.catch(() => {})
  }

  private openUnit(descriptor: KvUnitDescriptor): Promise<KvUnit> {
    if (this.closing !== undefined) {
      return Promise.reject(new StorageError('closed', 'sqlite storage backend is closed'))
    }
    if (!UNIT_NAME_RE.test(descriptor.name)) {
      return Promise.reject(new Error(`kv unit name '${descriptor.name}' violates ${UNIT_NAME_RE}`))
    }
    for (const table of descriptor.tables) {
      if (!UNIT_NAME_RE.test(table)) {
        return Promise.reject(new Error(`kv table name '${table}' in unit '${descriptor.name}' violates ${UNIT_NAME_RE}`))
      }
    }
    if (this.units.has(descriptor.name)) {
      return Promise.reject(new Error(`kv unit '${descriptor.name}' is already open (double-open is a caller bug)`))
    }
    // 同步保留名称，以便同一名称的并发第二次打开被拒绝，而非在下方 await 期间竞态越过守卫。
    const pending = this.materializeUnit(descriptor)
    this.units.set(descriptor.name, pending)
    pending.catch(() => this.units.delete(descriptor.name))
    return pending
  }

  private async materializeUnit(descriptor: KvUnitDescriptor): Promise<SqliteKvUnit> {
    const db = await this.ready
    const row = db.prepare('SELECT version FROM units WHERE name = ?').get(descriptor.name) as
      | { version: number }
      | undefined
    if (row === undefined) {
      db.prepare('INSERT INTO units (name, version) VALUES (?, ?)').run(descriptor.name, descriptor.version)
    } else if (row.version !== descriptor.version) {
      throw new StorageError(
        'version-mismatch',
        `kv unit '${descriptor.name}' is stamped version ${row.version} on the medium, incompatible with descriptor version ${descriptor.version}`,
      )
    }
    for (const table of descriptor.tables) {
      // 两段都通过 UNIT_NAME_RE，因此标识符在 DDL 中安全。
      db.exec(`
        CREATE TABLE IF NOT EXISTS "${recordTableName(descriptor.name, table)}" (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        ) STRICT
      `)
    }
    return new SqliteKvUnit(db, descriptor, () => {
      this.units.delete(descriptor.name)
    })
  }

  /**
   * 关闭每个已打开的单元并释放数据库。幂等；并发与重复调用会在拆卸完成后统一结算。
   * @returns 介质释放后的结算。
   */
  close(): Promise<void> {
    this.closing ??= this.doClose()
    return this.closing
  }

  private async doClose(): Promise<void> {
    let db: DatabaseSync
    try {
      db = await this.ready
    } catch {
      // 介质从未打开；该失败已经拒绝了打开者与每个单元调用，因此此处无可释放之物。
      return
    }
    for (const pending of [...this.units.values()]) {
      const unit = await pending.catch(() => undefined)
      await unit?.close()
    }
    db.close()
  }
}

/**
 * 在存储中枢上注册 SQLite 后端为 `sqlite`。disposer 先注销名称，再关闭后端。
 * @param ctx - 插件 Context（必须注入 `storage`）。
 * @param config - 已校验的插件配置。
 */
export function apply(ctx: Context, config: Config) {
  const backend = new SqliteStorageBackend(config)
  ctx.effect(() => {
    const dispose = ctx.storage.backend.register('sqlite', backend)
    return async () => {
      dispose()
      await backend.close()
    }
  }, 'storage-sqlite.registerBackend')
  ctx.provide(storageBackendServiceKey('sqlite'), backend)
}
