/**
 * 压缩词汇：结果类型与 `compaction/*` 会话事件。
 * 那些声明合并的事件在不进入表层的前提下记录锁与摘要输入，因此它们
 * 不是表层事件；摘要由另一个独立的替换 `user/message` 携带。
 * 后端包拥有配置与保留策略；参见
 * [压缩参考文档](../README.md#understand-the-implementation)。
 * @module @deepseek-ai/dsh-compaction/types
 */

import type { ContentBlock, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { CompactionId } from './brand.ts'

export type { CompactionId }

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * 标记一次压缩的开始——仅记录日志，持有锁直到
     * `compaction/end`。一个带编号的拥有者被严格包含于该开放轮次内；
     * `null` 标识轮次之间一个独立的手动事务。
     */
    'compaction/start': { compactionId: CompactionId; sourceCommandId?: CommandId; turn: number | null }
    /**
     * 已完成的摘要、其输入及其模型调用事实——仅记录日志，无 surfaceOp。
     * 摘要内容位于 `data.summary`；实际的表层替换由紧随其后的、
     * 遮蔽被压缩区间的 `user/message` 事件执行。这种相邻关系是契约性的——
     * 被遮蔽的计价字段即为替换的影子价格，因此消费者可以将一次替换
     * 与它正前方的计量事件配对（`compaction/prune` 记录了该共享协议）。
     */
    'compaction/summary': {
      compactionId: CompactionId
      sourceCommandId?: CommandId
      summary: ContentBlock[]
      shadowedRange: { start: SessionSeq; end: SessionSeq }
      shadowedSeqs: SessionSeq[]
      shadowedTokenCount: number
      /** 写入该摘要的提供方路由。 */
      provider: string
      /**
       * 写入该摘要的模型——即摘要调用的信封，
       * 由发起调用的后端上报，记录日志以便该一次性
       * 请求可从日志加代码重建，并使"哪个模型写入了此摘要"有一个
       * 持久的回答（可重建性 Agent Note）。
       */
      model: string
      /** 摘要调用所发送的生成上限，适用时存在。 */
      maxTokens?: number
      /** 摘要请求由提供方上报的 token 用量，发出时存在。 */
      usage?: TokenUsage
    } & (
      | {
        /** 后端的安全摘要投影之前的完整提供方输出。 */
        rawOutput: ContentBlock[]
        /** 精确标识通过本上下文 `ctx.llm.stream()` 的一次调用。 */
        llmStreamCall: true
      }
      | {
        /** 来自未标记模板、远程或其他摘要器的可选完整输出。 */
        rawOutput?: ContentBlock[]
        /** 未标记的摘要不会标识通过本上下文 LLM 接缝的一次调用。 */
        llmStreamCall?: never
      }
    )
    /**
     * 标记一次压缩的结束——仅记录日志，释放锁。其拥有者
     * 与 `compaction/start` 匹配；`error` 记录一次失败的尝试。
     */
    'compaction/end': { compactionId: CompactionId; sourceCommandId?: CommandId; turn: number | null; error?: string }
    /**
     * 一次无模型修剪替换的影子价格——仅记录日志，无 surfaceOp。
     * 共享的影子价格协议：一个表层 `replace` 事件由其紧前方
     * 的计量事件计价（`compaction/summary` 对应摘要式压缩，本事件对应修剪），
     * 它陈述被精确替换区间的启发式 token 价格，使纯消费者无需保留
     * 逐节点价格即可将其减去。该替换 MUST 在本事件之后同步追加。
     */
    'compaction/prune': {
      /** 被替换区间的首尾表层节点 seq（一个表层位置区间，类似 {@link CompactionResult.shadowedRange}）。 */
      shadowedRange: { start: SessionSeq; end: SessionSeq }
      /** 所有被遮蔽表层节点的 seq，按表层顺序。 */
      shadowedSeqs: SessionSeq[]
      /** 在 token 计量器固定估算器下被遮蔽内容的启发式价格。 */
      shadowedTokenCount: number
    }
  }
}

/** 一次成功压缩操作的结果。 */
export interface CompactionResult {
  /** 本次压缩完整持久化生命周期所共享的稳定标识。 */
  compactionId: CompactionId
  /** 发起本次压缩的人工命令，当其为手动时存在。 */
  sourceCommandId?: CommandId
  /** 追加的 `compaction/start` 事件的 seq。 */
  startSeq: SessionSeq
  /** 追加的 `compaction/summary` 事件的 seq。 */
  summarySeq: SessionSeq
  /** 追加的 `compaction/end` 事件的 seq。 */
  endSeq: SessionSeq
  /** 后端生成的摘要内容块。 */
  summary: ContentBlock[]
  /**
   * 被遮蔽的表层边界对：即被替换区间首个（`start`）与末个（`end`）
   * 表层节点的 seq。这是一个表层位置区间，而非数字 seq 区间——
   * 当先前的替换将一个全新的高 seq 摘要节点落到更旧区间的位置后，
   * `start` 可能大于 `end`。{@link CompactionResult.shadowedSeqs} 是
   * 被遮蔽节点的权威集合，按表层顺序。
   */
  shadowedRange: { start: SessionSeq; end: SessionSeq }
  /** 所有被遮蔽表层节点的 seq，按表层顺序。 */
  shadowedSeqs: SessionSeq[]
  /** 被遮蔽内容的估算 token 数。 */
  shadowedTokenCount: number
}
