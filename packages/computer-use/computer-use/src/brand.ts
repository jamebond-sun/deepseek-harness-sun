/** 计算机使用提供方标识。@module @deepseek-ai/dsh-computer-use/brand */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** 由提供方拥有、用于标识一次计算机使用注册的名称。 */
export type ComputerUseProviderName = Branded<'ComputerUseProviderName'>

/**
 * 为一个提供方拥有的名称加上品牌标注，而不修改或校验它。
 * @param name - 由提供方实现所选择的名称。
 * @returns 加上计算机使用提供方品牌后的同一名称。
 */
export function ComputerUseProviderName(name: string): ComputerUseProviderName {
  return name as ComputerUseProviderName
}
