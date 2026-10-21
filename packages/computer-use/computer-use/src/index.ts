/**
 * 计算机使用能力的独占式命名注册。
 * @module @deepseek-ai/dsh-computer-use
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { ComputerUseProviderName } from './brand.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    computerUse: ComputerUseRegistry
  }
}

/** 在共享的计算机使用服务中持有一次可选的提供方注册。 */
export class ComputerUseRegistry extends Service {
  private registration: ComputerUseProviderName | undefined

  constructor(ctx: Context) {
    super(ctx, 'computerUse')
  }

  /** 已注册提供方的名称，包括其资源正在关闭的期间。 */
  get providerName(): ComputerUseProviderName | undefined {
    return this.registration
  }

  /**
   * 保留唯一的提供方槽位，直到该贡献被释放为止。
   * 即便是重复当前名称的第二次注册也会失败。提供方在释放此注册之前，
   * 必须停止其工具并等待自有工作完成。
   * @param name - 在注册诊断中使用的、由提供方拥有的名称。
   * @returns 针对此次确切注册的副作用释放器。
   */
  register(name: ComputerUseProviderName): () => Promise<void> {
    if (this.registration !== undefined) {
      throw new Error(`computer use provider "${this.registration}" is already registered`)
    }
    return this.ctx.effect(() => {
      this.registration = name
      return () => {
        this.registration = undefined
      }
    }, 'computerUse.register()')
  }
}

export default ComputerUseRegistry
