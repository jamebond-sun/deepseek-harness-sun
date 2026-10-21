/**
 * dsh-lsp 自有的品牌化 id：{@link LspProviderId}，即 provider 在 `ctx.lsp` 上预留的不透明身份。
 * `Branded<B>` 原语位于 `@deepseek-ai/dsh-brand`；把类型和它的工厂放在一起，
 * 使 `index.ts` 能以同一个名字同时再导出二者。
 * @module @deepseek-ai/dsh-lsp/brand
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** 不透明的 provider 身份，在注册时与其扩展名映射一起被原子地预留。 */
export type LspProviderId = Branded<'LspProviderId'>

/**
 * 把一个字符串标记为 {@link LspProviderId}。不做校验——注册表会在注册时拒绝空 id。
 * @param id - provider 的稳定标识符。
 * @returns 同一个字符串，已加品牌标记。
 */
export function LspProviderId(id: string): LspProviderId {
  return id as LspProviderId
}
