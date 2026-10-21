/**
 * 存储中枢的具名后端注册表。
 * @module @deepseek-ai/dsh-storage/src/registry
 */

import type { StorageBackend } from './backend.ts'
import { StorageError } from './error.ts'

/**
 * 可变的 名称 → 后端 表。多个后端并排保持挂载状态；哪个后端服务哪个消费者由消费者的配置决定
 * （例如领域层的路由表），而绝非中枢的全局选择。
 */
export class BackendRegistry {
  private readonly backends = new Map<string, StorageBackend>()

  /**
   * 注册一个具名后端。注册是一种 effect：返回的 disposer 会移除该名称。disposal 并不关闭后端——
   * 所属的插件会在注销后关闭它。
   * @param name - 后端名称，例如 `json` 或 `sqlite`。
   * @param backend - 后端实例。
   * @returns 注销该名称的 disposer。
   */
  register(name: string, backend: StorageBackend): () => void {
    if (this.backends.has(name)) {
      throw new StorageError('duplicate-backend', `storage backend '${name}' is already registered`)
    }
    this.backends.set(name, backend)
    return () => {
      // 仅移除本次注册所贡献的部分：在 dispose + 重新注册之后，过期的 disposer 再次触发时不得移除后继者。
      if (this.backends.get(name) === backend) {
        this.backends.delete(name)
      }
    }
  }

  /**
   * 按名称解析一个后端。
   * @param name - 已注册的后端名称。
   * @returns 后端。
   */
  get(name: string): StorageBackend {
    const backend = this.backends.get(name)
    if (!backend) {
      throw new StorageError(
        'backend-not-found',
        `storage backend '${name}' is not registered (registered: ${[...this.backends.keys()].join(', ') || 'none'})`,
      )
    }
    return backend
  }

  /**
   * 已注册的后端名称，用于诊断。
   * @returns 名称的快照数组。
   */
  names(): string[] {
    return [...this.backends.keys()]
  }
}
