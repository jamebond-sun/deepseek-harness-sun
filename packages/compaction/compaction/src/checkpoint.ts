/**
 * 压缩检查点来源：各后端用于其替换用户消息的关联构造函数与类型，
 * 以及用于识别已持久化检查点的断言。
 *
 * 该能力接缝本身位于 `@deepseek-ai/dsh-compaction`，它重新导出了这些
 * 约定；本模块是一个纯类型/值/断言出口（不导入 cordis，不做模块增强），
 * 以便客户端与连线（wire）程序在无需加载宿主插件的 Context 合并的情况下
 * 引用检查点来源——即 `dsh-commands/brand` 的形态。
 *
 * @module @deepseek-ai/dsh-compaction/checkpoint
 */

import type { MessageSource } from '@deepseek-ai/dsh-llm/message'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import type { CompactionId } from './brand.ts'

const COMPACT_CHECKPOINT_MARKER = Object.freeze({ kind: 'compact-checkpoint' } as const)

/** 具体压缩检查点所携带的消息来源。 */
export type CompactionCheckpointSource = typeof COMPACT_CHECKPOINT_MARKER & {
  readonly compactionId: CompactionId
  readonly sourceCommandId?: CommandId
}

/**
 * 创建一个与某次压缩事务相关联的检查点来源。
 * @param compactionId - 所属压缩标识。
 * @param sourceCommandId - 发起本次操作的手动命令，存在时提供。
 * @returns 不可变的检查点来源。
 */
export function compactCheckpointSource(
  compactionId: CompactionId,
  sourceCommandId?: CommandId,
): CompactionCheckpointSource {
  return Object.freeze({
    ...COMPACT_CHECKPOINT_MARKER,
    compactionId,
    ...sourceCommandId === undefined ? {} : { sourceCommandId },
  })
}

/**
 * 判断某个已持久化的消息来源是否标识一个压缩检查点。
 * @param source - 从表层用户消息恢复而来的来源。
 * @returns 该来源是否携带与后端无关的检查点标记。
 */
export function isCompactCheckpointSource(source: MessageSource): source is CompactionCheckpointSource {
  return source.kind === 'compact-checkpoint'
}
