/**
 * JSON 存储后端：在配置根目录下每个单元一个人类可读文档——整体单元文件（`single` 布局）或每条记录一个文档
 * （`per-record` 布局），通过原子重写发布。在存储中枢上注册为后端 `json`。
 * @module @deepseek-ai/dsh-storage-json
 */

import { mkdir } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { StorageError, UNIT_NAME_RE, storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import type { KvFacet, KvUnit, KvUnitDescriptor, StorageBackend } from '@deepseek-ai/dsh-storage'
import { openSingleUnit } from './single-unit.ts'
import { openPerRecordUnit } from './per-record-unit.ts'

/** Cordis 插件名称。 */
export const name = 'storage-json'
/** 在后端可注册之前，中枢必须存在。 */
export const inject = ['storage']

/**
 * 插件配置。
 * `root` 刻意不设默认值：若回退为 `process.cwd()`，单元文件会散布到进程恰好启动的任何位置；
 * 装配件需显式声明位置。
 */
export interface Config {
  /** 持有每个单元一个 `<unit>.json` 文件（或 `<unit>/` 树）的目录。 */
  root: string
}

/** 配置 schema。 */
export const Config: z<Config> = z.object({
  root: z.string().required(),
})

/** JSON 后端：拥有文件树根目录并服务 `kv` facet。 */
export class JsonStorageBackend implements StorageBackend {
  private readonly open = new Map<string, KvUnit>()
  // 在 open() 入口同步保留，以便同一单元的并发打开失败，且 close() 能等待仍在途的打开。
  private readonly opening = new Map<string, Promise<KvUnit>>()
  private closed = false

  constructor(private readonly root: string) {}

  readonly kv: KvFacet = {
    // 首个 await 之前的主体同步运行，因此下方的 opening 槽位保留仍能排除同一单元的并发打开。
    open: async (descriptor: KvUnitDescriptor): Promise<KvUnit> => {
      if (this.closed) throw new StorageError('closed', 'json backend is closed')
      validateDescriptor(descriptor)
      if (this.open.has(descriptor.name) || this.opening.has(descriptor.name)) {
        // 双重打开属于调用方错误，而非介质状况。
        throw new Error(`unit '${descriptor.name}' is already open; a unit has exactly one live handle`)
      }
      const opening = this.openUnit(descriptor)
      this.opening.set(descriptor.name, opening)
      return opening.finally(() => this.opening.delete(descriptor.name))
    },
  }

  private async openUnit(descriptor: KvUnitDescriptor): Promise<KvUnit> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    // 两种布局仅在介质形态上有别；各自打开者拥有其在共享根目录下的路径约定。
    const onClose = () => this.open.delete(descriptor.name)
    const unit = descriptor.layout === 'per-record'
      ? await openPerRecordUnit(descriptor, this.root, onClose)
      : await openSingleUnit(descriptor, this.root, onClose)
    if (this.closed) {
      // 打开进行期间后端已关闭：不得在 close() 之后交出存活单元。
      await unit.close()
      throw new StorageError('closed', 'json backend is closed')
    }
    this.open.set(descriptor.name, unit)
    return unit
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true
    }
    await Promise.allSettled([...this.opening.values()])
    for (const unit of [...this.open.values()]) {
      await unit.close()
    }
  }
}

function validateDescriptor(descriptor: KvUnitDescriptor): void {
  if (!UNIT_NAME_RE.test(descriptor.name)) {
    throw new StorageError('malformed-medium', `invalid unit name '${descriptor.name}'`)
  }
  for (const table of descriptor.tables) {
    if (!UNIT_NAME_RE.test(table)) {
      throw new StorageError('malformed-medium', `invalid table name '${table}' in unit '${descriptor.name}'`)
    }
  }
}

/**
 * 在存储中枢上注册 `json` 后端。
 * @param ctx - 插件 Context。
 * @param config - 已校验的配置。
 */
export function apply(ctx: Context, config: Config) {
  const backend = new JsonStorageBackend(config.root)
  ctx.effect(() => {
    const unregister = ctx.storage.backend.register('json', backend)
    return async () => {
      unregister()
      await backend.close()
    }
  })
  ctx.provide(storageBackendServiceKey('json'), backend)
}
