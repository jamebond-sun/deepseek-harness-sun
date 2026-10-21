/** 用于共享 PDF 复用的源定位符与转换器拥有的标识。 */
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'

/** 由消费者编码的、已授权的执行作用域与规范源路径。 */
export type OfficeSourceKey = Branded<'OfficeSourceKey'>
/**
 * 为一个经授权的源定位符加标签，用于读取前的去重。
 * @param key - 授权作用域、执行世界与规范路径的无歧义编码。
 * @returns 加标签的源定位符；源授权仍是调用方的责任。
 */
export function OfficeSourceKey(key: string): OfficeSourceKey { return brandString<OfficeSourceKey>(key) }

/** 一个提供方生命周期，包含其引擎、渲染设置与字体配置。 */
export type OfficeToPdfGeneration = Branded<'OfficeToPdfGeneration'>
/**
 * 为一个提供方生命周期加标签。
 * @param value - 由提供方创建的唯一生成。
 * @returns 加标签的转换器生成。
 */
export function OfficeToPdfGeneration(value: string): OfficeToPdfGeneration {
  return brandString<OfficeToPdfGeneration>(value)
}

/** 提供方生成与源内容摘要；消费者不得解析它。 */
export type OfficeToPdfKey = Branded<'OfficeToPdfKey'>
/**
 * 为一个转换器拥有的内容标识加标签。
 * @param value - 由提供方创建的生成与内容标识。
 * @returns 加标签的转换标识。
 */
export function OfficeToPdfKey(value: string): OfficeToPdfKey { return brandString<OfficeToPdfKey>(value) }
