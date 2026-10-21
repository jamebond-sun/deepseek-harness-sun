/**
 * `per-record` 布局下一个已打开的 JSON 单元：单元是 `dir` 处的一个目录，在 `<dir>/<table>/<key>.json` 下每条记录一个文档，
 * 外加 `global.json` 用于全局槽位。目录即状态——本单元不持有自身的内存状态：`loadAll` 重新读取树，
 * 每次写入都是一次持久化的文件操作。领域层拥有存活的内存内表（由打开时的 `loadAll` 播种）并通过其写入链串行化写入，
 * 因此本单元从不修改内存，也无需回滚——一次失败的写入只会让文件与领域内存保持未变。
 *
 * 逐记录契约：一个畸形或盖有可接受集合之外版本（descriptor 当前版本加其 `compatibleVersions`）的记录文档读作缺失记录——
 * 一个损坏或过期文件永不拖垮整个单元，且未被接受的版本戳丢弃该记录而非迁移它。记录键成为路径片段，
 * 因此必须路径安全（`[a-zA-Z0-9_-]+`）；不安全的键在写入时拒绝。
 *
 * 遗留引导：当新树没有文档路径时，遗留整单元文件 `<root>/<name>.json`（per-record 之前的布局）会为逐记录文档播种，
 * 前提是其已存储单元版本在可接受集合内——盖有任何其他版本的遗留文件原样保留并读作空单元。任何新的文档路径，
 * 包括内容不可读或过期的，都会抑制整个单元的引导。遗留文件从不被更改或删除。
 * @module @deepseek-ai/dsh-storage-json/src/per-record-unit
 */

import { mkdir, readFile, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Dirent } from 'node:fs'
import { StorageError } from '@deepseek-ai/dsh-storage'
import type { KvUnit, KvUnitDescriptor } from '@deepseek-ai/dsh-storage'
import { writeAtomic } from './atomic.ts'
import { parseRecord, serializeRecord } from './format.ts'
import type { UnitState } from './format.ts'

/** 在此布局中键成为路径片段；此集合在每个操作系统上都路径安全。 */
const SAFE_KEY_RE = /^[a-zA-Z0-9_-]+$/

/**
 * 在 `root` 下打开一个 `per-record` 布局单元：单元目录为 `<root>/<name>/`。在首个 `loadAll` 时惰性加载——
 * 本单元不持有状态，因此打开不触及介质。
 * @param descriptor - 单元的静态身份与形态。
 * @param root - 绝对后端根目录。
 * @param onClose - 释放单元打开槽位的后端回调。
 * @returns 已打开的单元。
 */
// oxlint-disable-next-line typescript/require-await -- async 让两个打开者的调用点保持一致
export async function openPerRecordUnit(
  descriptor: KvUnitDescriptor,
  root: string,
  onClose: () => void,
): Promise<KvUnit> {
  return new PerRecordJsonUnit(descriptor, join(root, descriptor.name), onClose)
}

/**
 * 读取单元目录下每个记录的文档：每个已声明表的 `<key>.json` 文件外加 `global.json`。
 * 缺失目录即空单元（物化推迟到首次写入）；外部文档（缺失、畸形或盖有未被接受版本）按逐记录契约读作缺失记录。
 * @param descriptor - 单元的静态身份与形态。
 * @param dir - 绝对单元目录路径。
 * @returns 从树重建的权威状态。
 */
async function loadPerRecordState(descriptor: KvUnitDescriptor, dir: string): Promise<UnitState> {
  const versions = acceptedStamps(descriptor)
  const state: UnitState = {
    version: descriptor.version,
    global: null,
    tables: new Map(descriptor.tables.map(table => [table, new Map<string, unknown>()])),
  }
  let entries: Dirent[] | undefined
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // 缺失目录 = 空单元；下方的遗留引导仍运行（全新升级的形态恰恰就是一个缺失的新树）。
  }
  const hasNewDocuments = entries === undefined
    ? false
    : (await Promise.all(entries.map(async (entry) => {
      if (entry.isDirectory()) {
        const records = state.tables.get(entry.name)
        if (records !== undefined) {
          return loadTableRecords(records, versions, join(dir, entry.name))
        }
      }
      if (entry.name === 'global.json' && descriptor.hasGlobal) {
        const global = await readRecord(join(dir, entry.name), versions)
        if (global !== undefined) state.global = global
        return true
      }
      return false
    }))).some(Boolean)
  if (!hasNewDocuments) await bootstrapLegacyUnit(descriptor, dir, state)
  return state
}

/** 本单元读作自身的版本戳：当前版本加声明的兼容版本。 */
function acceptedStamps(descriptor: KvUnitDescriptor): readonly number[] {
  return [descriptor.version, ...descriptor.compatibleVersions ?? []]
}

/**
 * 从一个遗留整单元文件（`<root>/<name>.json`，per-record 之前的布局）引导一个空的逐记录树。
 * 每个已声明表的记录都被复制为一个当前版本的文档，而遗留文件保持不变。缺失、外部（另一单元名）、畸形或非单元性质的
 * 遗留文件原样保留，存储单元版本在可接受集合之外的同样如此——迁移属主从未担保的记峰会用当前版本为其盖戳，
 * 并在领域层将可丢弃的过期缓存变成 schema 失败。其他读取失败会传播。
 * @param descriptor - 单元的静态身份与形态。
 * @param dir - 逐记录单元目录（`<root>/<name>`）。
 * @param state - 空树状态；引导所得记录被加入。
 */
async function bootstrapLegacyUnit(descriptor: KvUnitDescriptor, dir: string, state: UnitState): Promise<void> {
  const legacyPath = join(dirname(dir), `${descriptor.name}.json`)
  let text: string | undefined
  try {
    text = await readFile(legacyPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return
  }
  // 遗留文档是运行时数据：此处仅检查 `unit.name`、`unit.version` 与表映射形态——记录值按原样迁移，
  // 由领域层的 schema 判定它们。
  let document: { unit?: { name?: unknown; version?: unknown }; tables?: unknown }
  try {
    document = JSON.parse(text) as { unit?: { name?: unknown; version?: unknown }; tables?: unknown }
  } catch {
    return // 畸形遗留文件：非我方负责解释或删除。
  }
  if (document.unit?.name !== descriptor.name) return
  const stamped = document.unit.version
  if (typeof stamped !== 'number' || !acceptedStamps(descriptor).includes(stamped)) return
  const tables = document.tables
  if (typeof tables !== 'object' || tables === null) return
  const recordsByTable = tables as Record<string, Record<string, unknown>>
  for (const [table, records] of Object.entries(recordsByTable)) {
    const target = state.tables.get(table)
    if (target === undefined) continue
    for (const [key, value] of Object.entries(records)) {
      const path = join(dir, table, `${key}.json`)
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await writeAtomic(path, serializeRecord(descriptor.version, value))
      target.set(key, value)
    }
  }
}

/**
 * 将一个已声明表的记录文档读入 `records`。
 * @returns 该目录是否包含任何 `.json` 文档路径，与键安全、可读性、已存储版本无关。
 */
async function loadTableRecords(records: Map<string, unknown>, versions: readonly number[], dir: string): Promise<boolean> {
  const files = await readdir(dir, { withFileTypes: true })
  const hasDocuments = files.some(file => file.name.endsWith('.json'))
  const loaded = await Promise.all(files.map(async (file) => {
    if (!file.name.endsWith('.json')) return
    const key = file.name.slice(0, -'.json'.length)
    if (!SAFE_KEY_RE.test(key)) return
    const record = await readRecord(join(dir, file.name), versions)
    if (record !== undefined) return [key, record] as const
  }))
  for (const record of loaded) {
    if (record !== undefined) records.set(...record)
  }
  return hasDocuments
}

/** 读取一条记录文档；外部（不可读或过期）的读作缺失。 */
async function readRecord(path: string, versions: readonly number[]): Promise<unknown> {
  try {
    return parseRecord(await readFile(path, 'utf8'), versions)
  } catch {
    return undefined
  }
}

/**
 * 一个已打开的 `per-record` 布局单元。按设计无状态：目录即介质，领域层拥有存活内存，此处的每个方法都是一次持久化的文件操作。
 * 写入顺序属于调用方（领域层的写入链），与 `single` 布局单元完全一致。
 */
export class PerRecordJsonUnit implements KvUnit {
  private closed = false
  /** 在途持久化写入；close() 在释放单元前将其排干。 */
  private readonly inFlight = new Set<Promise<void>>()

  constructor(
    private readonly descriptor: KvUnitDescriptor,
    private readonly dir: string,
    private readonly onClose: () => void,
  ) {}

  /** 重新读取树：目录即权威状态。 */
  async loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }> {
    this.assertOpen()
    const state = await loadPerRecordState(this.descriptor, this.dir)
    const tables: Record<string, Record<string, unknown>> = {}
    for (const [table, records] of state.tables) {
      tables[table] = Object.fromEntries(records)
    }
    return { tables, global: state.global }
  }

  /** 持久化地替换一条记录：其自身的文档，原子性地。 */
  async putRecord(table: string, key: string, value: unknown): Promise<void> {
    this.assertOpen()
    assertSafeKey(this.descriptor.name, key)
    await this.tracked(this.writeDocument(join(this.tableDir(table), `${key}.json`), value))
  }

  /** 持久化地删除一条记录。幂等：缺失的键为无操作。 */
  async deleteRecord(table: string, key: string): Promise<void> {
    this.assertOpen()
    assertSafeKey(this.descriptor.name, key)
    await this.tracked(rm(join(this.tableDir(table), `${key}.json`), { force: true }))
  }

  /**
   * 将一条记录的文档移开为 `<key>.json.bak.<YYYYMMDDHHmm>`。被移动的文档不再以 `.json` 结尾，
   * 因此随后的每次读取都忽略它；字节保留在磁盘上以供检查。同一分钟内对同一键的备份会覆盖先前的备份
   * （较新的字节才值得保留）。
   */
  async backupRecord(table: string, key: string): Promise<string> {
    this.assertOpen()
    assertSafeKey(this.descriptor.name, key)
    const path = join(this.tableDir(table), `${key}.json`)
    const moved = `${path}.bak.${backupStamp(new Date())}`
    await this.tracked(rename(path, moved))
    return moved
  }

  /** 持久化地替换全局单例。仅在声明时有效。 */
  async setGlobal(value: unknown): Promise<void> {
    this.assertOpen()
    if (!this.descriptor.hasGlobal) {
      throw new Error(`unit '${this.descriptor.name}' does not declare a global slot`)
    }
    await this.tracked(this.writeDocument(join(this.dir, 'global.json'), value))
  }

  /* jscpd:ignore-start -- 两个单元类相互独立；排干/守卫生命周期镜像共享的 KvUnit 契约 */
  /** 排干在途写入并释放单元。幂等。 */
  async close(): Promise<void> {
    if (this.closed) {
      await Promise.allSettled(this.inFlight)
      return
    }
    this.closed = true
    await Promise.allSettled(this.inFlight)
    this.onClose()
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new StorageError('closed', `unit '${this.descriptor.name}' is closed`)
    }
  }
  /* jscpd:ignore-end */

  /** 解析一个已声明表的目录；未声明的表属于调用方错误并抛出。 */
  private tableDir(table: string): string {
    if (!this.descriptor.tables.includes(table)) {
      throw new Error(`unit '${this.descriptor.name}' does not declare table '${table}'`)
    }
    return join(this.dir, table)
  }

  /** 持久化地替换一个文档，创建其父目录。 */
  private writeDocument(path: string, value: unknown): Promise<void> {
    return (async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await writeAtomic(path, serializeRecord(this.descriptor.version, value))
    })()
  }

  /** 跟踪一次持久化写入以便 close() 排干它。 */
  private tracked(write: Promise<void>): Promise<void> {
    this.inFlight.add(write)
    // 仅在跟踪分支上吞掉：调用方仍等待 `write` 本身，因此拒绝恰好被观察一次。
    write.catch(() => {}).finally(() => this.inFlight.delete(write))
    return write
  }
}

/** 被备份文档的本地时间 `YYYYMMDDHHmm` 后缀。 */
function backupStamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}`
}

/** 拒绝一个作为路径片段不安全的记录键。 */
function assertSafeKey(unit: string, key: string): void {
  if (!SAFE_KEY_RE.test(key)) {
    throw new Error(`unit '${unit}': per-record key '${key}' is not path-safe (must match ${SAFE_KEY_RE})`)
  }
}
