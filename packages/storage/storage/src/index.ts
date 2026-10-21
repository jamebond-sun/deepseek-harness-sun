/**
 * 存储中枢（`ctx.storage`）：一个具名后端注册表，外加挂载的数据形态设施。中枢本身不执行任何 IO——后端拥有介质，
 * 数据形态（首先是领域层）拥有语义。
 * @module @deepseek-ai/dsh-storage
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { StorageError } from './error.ts'
import { BackendRegistry } from './registry.ts'

export { BackendRegistry } from './registry.ts'
export { StorageError } from './error.ts'
export type { StorageErrorCode } from './error.ts'
export { UNIT_NAME_RE } from './backend.ts'
export type { StorageBackend, KvFacet, KvUnit, KvUnitDescriptor } from './backend.ts'

/**
 * 派生某个具名后端插件所提供的中枢生命周期服务。数据形态提供方注入这些键，
 * 因此即便调用方仍通过存储注册表解析后端，激活也不会与后端注册产生竞争。
 * @param name - 后端注册表名称。
 * @returns 对应的仅生命周期服务键。
 */
export function storageBackendServiceKey(name: string): string {
  return `storage.backend.${name}`
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    storage: Storage
  }
}

/**
 * 可挂载到中枢的数据形态，以形态名为键。形态属主通过声明合并扩展此映射
 * （领域层合并 `domain: DomainFacility`），并在其 `apply` 中挂载该设施。
 */
export interface StorageForms {}

/**
 * 存储中枢服务。后端注册在 `backend` 下；数据形态挂载在其 `StorageForms` 键下，并作为 `ctx.storage.<form>` 被访问。
 */
export class Storage extends Service {
  /** 具名后端表；多个后端并排保持挂载状态。 */
  readonly backend: BackendRegistry = new BackendRegistry()

  private readonly forms = new Map<keyof StorageForms, unknown>()

  constructor(ctx: Context) {
    super(ctx, 'storage')
  }

  /**
   * 在中枢上挂载一个数据形态设施。挂载是一种 effect：返回的 disposer 会卸载该形态。
   * @param form - 在 {@link StorageForms} 中声明的形态键。
   * @param facility - 要暴露的设施实例。
   * @returns 卸载该形态的 disposer。
   */
  mount<K extends keyof StorageForms>(form: K, facility: StorageForms[K]): () => void {
    if (this.forms.has(form)) {
      throw new StorageError('duplicate-mount', `storage form '${String(form)}' is already mounted`)
    }
    this.forms.set(form, facility)
    return () => {
      // 与 BackendRegistry.register 相同的过期 disposer 守卫。
      if (this.forms.get(form) === facility) {
        this.forms.delete(form)
      }
    }
  }

  /**
   * 解析一个已挂载的数据形态。
   * @param form - 在 {@link StorageForms} 中声明的形态键。
   * @returns 已挂载的设施。
   */
  form<K extends keyof StorageForms>(form: K): StorageForms[K] {
    if (!this.forms.has(form)) {
      throw new StorageError('form-not-mounted', `storage form '${String(form)}' is not mounted`)
    }
    return this.forms.get(form) as StorageForms[K]
  }

  /** 领域数据形态；一旦领域层插件加载即存在。 */
  get domain(): StorageForms extends { domain: infer D } ? D : never {
    return this.form('domain' as keyof StorageForms)
  }
}

// 服务包默认导出其服务类，此外不导出任何 plugin 形态的内容（packages/AGENTS.md）：
// 将默认导出与函数式 plugin 的 `apply` 混用会导致 Loader 丢弃 plugin 命名空间。
export default Storage
