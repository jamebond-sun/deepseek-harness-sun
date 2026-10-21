import type { Branded } from '@deepseek-ai/dsh-brand'

/** 一次压缩事务（start/summary/checkpoint/end）共享的稳定标识。 */
export type CompactionId = Branded<'CompactionId'>

/**
 * 为某个实现生成的压缩标识加上品牌标注。
 * @param id - 不透明的交易标识。
 * @returns 同一个字符串，加上品牌标注；不执行任何校验。
 */
export function CompactionId(id: string): CompactionId {
  return id as CompactionId
}
