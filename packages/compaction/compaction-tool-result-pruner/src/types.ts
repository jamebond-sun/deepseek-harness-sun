import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'

/** 确定性工具结果修剪的字符预算策略。 */
export interface ToolResultPruneConfig {
  /** 当文本总量超过该数量的 Unicode 码点时进行修剪。默认 `8192`。 */
  thresholdChars?: number
  /** 保留的最大前导 Unicode 码点数量。默认 `4096`。 */
  headChars?: number
  /** 保留的最大尾部 Unicode 码点数量。默认 `1024`。 */
  tailChars?: number
}

/** 经过校验、解耦、深度不可变的修剪配置。 */
export interface ResolvedConfig {
  readonly thresholdChars: number
  readonly headChars: number
  readonly tailChars: number
}

/** 一次落地表层替换所引用的来源事件与尺寸计量。 */
export interface PrunedEntry {
  /** 被替换所遮蔽的、全保真的工具结果事件。 */
  readonly originalSeq: SessionSeq
  /** 新追加的、已修剪的工具结果事件。 */
  readonly replacementSeq: SessionSeq
  /** 原始与替换所共享的工具调用。 */
  readonly callId: ToolCallId
  /** 原始文本大小，以 Unicode 码点计。 */
  readonly charsBefore: number
  /** 替换文本大小，以 Unicode 码点计。 */
  readonly charsAfter: number
}

/** 一次稳定表层修剪遍的聚合结果。 */
export interface PruneResult {
  /** 按快照表层顺序的替换项。 */
  readonly pruned: readonly PrunedEntry[]
  /** 跨所有替换移除的 Unicode 码点总数。 */
  readonly charsRemoved: number
}
