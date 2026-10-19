/**
 * browser-use 能力的独占具名注册。
 * @module @deepseek-ai/dsh-browser-use
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { BrowserUseProviderName } from './brand.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    browserUse: BrowserUseRegistry
  }
}

/** 在共享的 browser-use 服务中独占持有一个可选的 provider 注册。 */
export class BrowserUseRegistry extends Service {
  private registration: BrowserUseProviderName | undefined

  constructor(ctx: Context) {
    super(ctx, 'browserUse')
  }

  /** 已注册 provider 的名称，在其资源关闭期间同样可见。 */
  get providerName(): BrowserUseProviderName | undefined {
    return this.registration
  }

  /**
   * 预留唯一的 provider 槽位，直到该贡献被释放。
   * 第二次注册即使重复当前名称也会失败。Provider 必须先停止其工具并等待自身拥有的
   * 工作完成，再释放本次注册。
   * @param name - provider 自有名称，用于注册诊断信息。
   * @returns 该次注册对应的 effect 释放函数。
   */
  register(name: BrowserUseProviderName): () => Promise<void> {
    if (this.registration !== undefined) {
      throw new Error(`browser use provider "${this.registration}" is already registered`)
    }
    return this.ctx.effect(() => {
      this.registration = name
      return () => {
        this.registration = undefined
      }
    }, 'browserUse.register()')
  }
}

export default BrowserUseRegistry
