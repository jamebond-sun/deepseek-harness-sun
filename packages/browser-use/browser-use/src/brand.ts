/** browser-use provider 身份标识。 @module @deepseek-ai/dsh-browser-use/brand */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** provider 自有名称，用于标识一次 browser-use 注册。 */
export type BrowserUseProviderName = Branded<'BrowserUseProviderName'>

/**
 * 为 provider 自有名称打上品牌标记，不改变、也不校验该名称。
 * @param name - 由 provider 实现选择的名称。
 * @returns 带有 browser-use provider 品牌标记的同一名称。
 */
export function BrowserUseProviderName(name: string): BrowserUseProviderName {
  return name as BrowserUseProviderName
}
