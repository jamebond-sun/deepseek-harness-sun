/**
 * 命令定义的身份标识与执行 id，用于发现机制与生命周期配对。
 *
 * `Branded<B>` 原语位于 `@deepseek-ai/dsh-brand`；本模块是纯粹的类型/构造
 * 出口（不导入 cordis，不做模块增强），因此 wire 与 Client 程序无需加载
 * Host 插件的 Context 合并即可引用这些 brand —— 与 `dsh-llm/brand` 形状一致。
 *
 * @module @deepseek-ai/dsh-commands/brand
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** 命令定义由插件持有的稳定身份，与其名称和文案无关。 */
export type CommandDefinitionId = Branded<'CommandDefinitionId'>

/**
 * 为一个以插件名命名的命令定义身份打上 brand。
 * @param id - 注册插件选定的稳定身份。
 * @returns 原字符串并带上 brand；不做任何校验。
 */
export function CommandDefinitionId(id: string): CommandDefinitionId {
  return id as CommandDefinitionId
}

/**
 * 把一次命令执行的 `command/run`/`command/done` 生命周期记录彼此配对，
 * 并与 `command.execute` 准入响应配对。由执行器铸造，按服务实例单调自增。
 */
export type CommandId = Branded<'CommandId'>

/**
 * 把字符串标为 {@link CommandId}。
 * @param id - 执行器铸造的配对 id。
 * @returns 原字符串并带上 brand；不做任何校验。
 */
export function CommandId(id: string): CommandId {
  return id as CommandId
}
