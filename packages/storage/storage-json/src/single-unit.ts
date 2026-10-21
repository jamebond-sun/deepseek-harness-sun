/**
 * `single` 布局下一个已打开的 JSON 单元：整个单元是 `<root>/<name>.json` 处的一个文档。
 * 内存内状态是权威的；每个写入原语修改它并原子性地重新发布整个文件。写入在此处并不排队——
 * 按后端契约，写入顺序属于调用方（领域层的写入链）；本单元仅保证每次单一调用发布一个完整、持久的文件。
 * `per-record` 布局是 `per-record-unit.ts` 中独立的单元类。
 * @module @deepseek-ai/dsh-storage-json/src/single-unit
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { StorageError } from '@deepseek-ai/dsh-storage'
import type { KvUnit, KvUnitDescriptor } from '@deepseek-ai/dsh-storage'
import { writeAtomic } from './atomic.ts'
import { parse, serialize } from './format.ts'
import type { UnitState } from './format.ts'

/**
 * 打开（加载或惰性创建）`root` 下一个 `single` 布局单元：单元文件为 `<root>/<name>.json`。
 * @param descriptor - 单元的静态身份与形态。
 * @param root - 绝对后端根目录。
 * @param onClose - 释放单元打开槽位的后端回调。
 * @returns 已打开的单元。
 */
export async function openSingleUnit(
  descriptor: KvUnitDescriptor,
  root: string,
  onClose: () => void,
): Promise<KvUnit> {
  const path = join(root, `${descriptor.name}.json`)
  let text: string | undefined
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // 缺失文件 = 空单元；物化推迟到首次写入。
  }
  const state: UnitState =
    text === undefined
      ? {
        version: descriptor.version,
        global: null,
        tables: new Map(descriptor.tables.map(table => [table, new Map<string, unknown>()])),
      }
      : parse(text, descriptor)
  return new SingleJsonUnit(descriptor, path, state, onClose)
}

class SingleJsonUnit implements KvUnit {
  private closed = false
  /** 在途发布；close() 在释放单元前将其排干。 */
  private readonly inFlight = new Set<Promise<void>>()

  constructor(
    private readonly descriptor: KvUnitDescriptor,
    private readonly path: string,
    private readonly state: UnitState,
    private readonly onClose: () => void,
  ) {}

  // oxlint-disable-next-line typescript/require-await -- async 让 closed 守卫成为拒绝而非同步抛出
  async loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }> {
    this.assertOpen()
    const tables: Record<string, Record<string, unknown>> = {}
    for (const [table, records] of this.state.tables) {
      tables[table] = Object.fromEntries(records)
    }
    return { tables, global: this.state.global }
  }

  async putRecord(table: string, key: string, value: unknown): Promise<void> {
    this.assertOpen()
    const records = this.records(table)
    const hadKey = records.has(key)
    const previous = records.get(key)
    records.set(key, value)
    // 发布失败时回滚：内存是权威的，因此被拒绝的写入不得存活在内存中（或随下次发布顺带而出）。
    await this.publish().catch((error: unknown) => {
      if (hadKey) records.set(key, previous)
      else records.delete(key)
      throw error
    })
  }

  async deleteRecord(table: string, key: string): Promise<void> {
    this.assertOpen()
    const records = this.records(table)
    if (!records.has(key)) return
    const previous = records.get(key)
    records.delete(key)
    await this.publish().catch((error: unknown) => {
      records.set(key, previous)
      throw error
    })
  }

  async setGlobal(value: unknown): Promise<void> {
    this.assertOpen()
    if (!this.descriptor.hasGlobal) {
      throw new Error(`unit '${this.descriptor.name}' does not declare a global slot`)
    }
    const previous = this.state.global
    this.state.global = value
    await this.publish().catch((error: unknown) => {
      this.state.global = previous
      throw error
    })
  }

  /* jscpd:ignore-start -- 两个单元类相互独立；排干/守卫生命周期镜像共享的 KvUnit 契约 */
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

  private records(table: string): Map<string, unknown> {
    const records = this.state.tables.get(table)
    if (!records) {
      throw new Error(`unit '${this.descriptor.name}' does not declare table '${table}'`)
    }
    return records
  }

  private publish(): Promise<void> {
    const write = writeAtomic(this.path, serialize(this.descriptor.name, this.state))
    this.inFlight.add(write)
    // 仅在跟踪分支上吞掉：调用方仍等待 `write` 本身，因此拒绝恰好被观察一次。
    write.catch(() => {}).finally(() => this.inFlight.delete(write))
    return write
  }
}
