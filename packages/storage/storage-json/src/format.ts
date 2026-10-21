/**
 * 磁盘上的 JSON 单元格式：文件始终是当前的净状态，并保持人类可读（美化打印、插入顺序的稳定键序）——
 * 这种可读性正是此后端存在的理由。`single` 布局单元是一个带单元头的文档；`per-record` 布局单元是一个目录，
 * 每条记录一个带版本戳的文档（`<table>/<key>.json`），外加一个 `global.json` 用于全局槽位，
 * 因此一次写入只重写一条记录而非整个单元。
 * @module @deepseek-ai/dsh-storage-json/src/format
 */

import { StorageError } from '@deepseek-ai/dsh-storage'
import type { KvUnitDescriptor } from '@deepseek-ai/dsh-storage'

/** 一个单元的内存权威状态；文件是其投影。`global` 在首次写入前为 `null`。 */
export interface UnitState {
  version: number
  global: unknown
  tables: Map<string, Map<string, unknown>>
}

/**
 * 将一个单元状态序列化为文件内容。
 * @param name - 单元名，盖入头中。
 * @param state - 权威的内存内状态。
 * @returns 带末尾换行的美化打印 JSON 文档。
 */
export function serialize(name: string, state: UnitState): string {
  const tables: Record<string, Record<string, unknown>> = {}
  for (const [table, records] of state.tables) {
    tables[table] = Object.fromEntries(records)
  }
  const document = {
    unit: { name, version: state.version },
    global: state.global,
    tables,
  }
  return `${JSON.stringify(document, null, 2)}\n`
}

/**
 * 将文件内容解析为单元状态，校验形态与版本。
 * @param text - 原始文件内容。
 * @param descriptor - 期望身份；版本不符则拒绝。
 * @returns 解析后的状态。
 */
export function parse(text: string, descriptor: KvUnitDescriptor): UnitState {
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch (error) {
    throw new StorageError('malformed-medium', `unit '${descriptor.name}': file is not valid JSON`, { cause: error })
  }
  if (typeof document !== 'object' || document === null) {
    throw new StorageError('malformed-medium', `unit '${descriptor.name}': file is not a JSON object`)
  }
  const { unit, global: globalValue, tables } = document as Record<string, unknown>
  if (
    typeof unit !== 'object' || unit === null ||
    (unit as Record<string, unknown>)['name'] !== descriptor.name ||
    typeof (unit as Record<string, unknown>)['version'] !== 'number'
  ) {
    throw new StorageError('malformed-medium', `unit '${descriptor.name}': missing or foreign unit header`)
  }
  const version = (unit as Record<string, unknown>)['version'] as number
  if (version !== descriptor.version) {
    throw new StorageError(
      'version-mismatch',
      `unit '${descriptor.name}': stored version ${version} != expected ${descriptor.version}`,
    )
  }
  // 仅 `typeof` 会放行数组：将一个数组读作表映射会把每个已声明表都报为缺失，
  // 而下次发布会用那个空视图替换文件，丢弃此读者看不到的记录。
  if (typeof tables !== 'object' || tables === null || Array.isArray(tables)) {
    throw new StorageError('malformed-medium', `unit '${descriptor.name}': tables is not an object`)
  }
  const state: UnitState = { version, global: globalValue ?? null, tables: new Map() }
  for (const table of descriptor.tables) {
    const records = (tables as Record<string, unknown>)[table]
    if (records === undefined) {
      state.tables.set(table, new Map())
      continue
    }
    if (typeof records !== 'object' || records === null || Array.isArray(records)) {
      throw new StorageError('malformed-medium', `unit '${descriptor.name}': table '${table}' is not an object`)
    }
    state.tables.set(table, new Map(Object.entries(records as Record<string, unknown>)))
  }
  return state
}

/**
 * 序列化一条逐记录文档：单元的版本戳加上记录值，与整单元文档同样美化打印。
 * @param version - 单元格式版本，盖入头中。
 * @param value - 记录值（或全局单例值）。
 * @returns 带末尾换行的美化打印 JSON 文档。
 */
export function serializeRecord(version: number, value: unknown): string {
  return `${JSON.stringify({ version, record: value }, null, 2)}\n`
}

/**
 * 解析一条逐记录文档，校验其版本戳。畸形或盖有未被接受版本的文档是外部文档，读作缺失——
 * 逐记录契约：一个损坏或过期的记录文件不得拖垮整个单元，且未被接受的版本戳丢弃该记录而非迁移它
 * （整单元格式选择拒绝，因为那里恰好只有一个文档）。
 * @param text - 原始逐记录文档内容。
 * @param versions - 可接受的单元版本（当前版本加上 descriptor 的 compatibleVersions）；任何其他戳都会丢弃该文档。
 * @returns 记录值；外部文档为 `undefined`。
 */
export function parseRecord(text: string, versions: readonly number[]): unknown {
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof document !== 'object' || document === null) return undefined
  const { version: stamped, record } = document as Record<string, unknown>
  if (typeof stamped !== 'number' || !versions.includes(stamped)) return undefined
  return record
}
