/**
 * 增量的块到消息组装器。这是 agent 循环用来在记录原始块以保障回放
 * 保真度的同时、从块流构建一条助手消息的唯一的规范装配算法。
 *
 * @module @deepseek-ai/dsh-llm/assembler
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { ToolCallId } from './brand.ts'
import { createAssistantMessage } from './message.ts'
import type { AssistantMessage, ModelMessageSource } from './message.ts'
import type { ContentBlock, FinishReason, ReplayEnvelope, StreamChunk, TokenUsage } from './types.ts'

interface PartialBlock {
  blockType: string
  text: string
  toolCallId?: ToolCallId
  toolCallName?: string
  toolCallArguments: string
  /** 由 `block-end` 设置——具有权威性，并冻结该部分块。 */
  block?: ContentBlock
}

/**
 * 增量地把原始 {@link StreamChunk} 装配为完整的 {@link ContentBlock}
 * 与一条最终的助手 {@link Message}。
 *
 * agent 循环在为回放保真度记录原始块的同时喂给它，然后在流结束后
 * 读取 `blocks()` / `message()` / `usage` / `finish`，
 * 或在取消截断了流时读取 `interruptedBlocks()`。
 *
 * 能容忍只有增量的协议（没有 block-start/end）；为一个已被 `block-end`
 * 关闭的索引到达的增量会被忽略（格式错误的流），因此一个行为异常的
 * 适配器既无法增长内存，也无法破坏一个已完成的块。
 */
export class BlockAssembler {
  private partials = new Map<number, PartialBlock>()
  private order: number[] = []
  private _usage: TokenUsage | undefined
  private _finish: FinishReason | undefined
  private _replayState: ReplayEnvelope | undefined

  /**
   * 把一个块喂入装配状态。
   * @param chunk - 按流顺序排列的下一个原始块。
   */
  push(chunk: StreamChunk): void {
    switch (chunk.type) {
      case 'block-start': {
        if (!this.partials.has(chunk.index)) {
          this.order.push(chunk.index)
          this.partials.set(chunk.index, {
            blockType: chunk.blockType,
            text: '',
            toolCallArguments: '',
          })
        }
        return
      }
      case 'text-delta':
      case 'reasoning-delta': {
        const partial = this.ensure(chunk.index, chunk.type === 'text-delta' ? 'text' : 'reasoning')
        if (partial.block) return // 已被 block-end 关闭；忽略滞后的增量
        partial.text += chunk.text
        return
      }
      case 'tool-call-delta': {
        const partial = this.ensure(chunk.index, 'tool-call')
        if (partial.block) return // 已被 block-end 关闭；忽略滞后的增量
        partial.toolCallId = chunk.id
        if (chunk.name) partial.toolCallName = chunk.name
        partial.toolCallArguments += chunk.argumentsDelta
        return
      }
      case 'block-end': {
        const partial = this.ensure(chunk.index, chunk.block.type)
        // 首次关闭者胜出；忽略滞后的重复关闭，使流式输出与
        // 最终装配出来的块保持一致。
        if (partial.block) return
        partial.block = chunk.block
        return
      }
      case 'usage': {
        this._usage = chunk.usage
        return
      }
      case 'finish': {
        this._finish = chunk.reason
        this._replayState = chunk.replayState
        return
      }
      default: return assertNever(chunk, 'BlockAssembler.push')
    }
  }

  private ensure(index: number, blockType: string): PartialBlock {
    let partial = this.partials.get(index)
    if (!partial) {
      partial = { blockType, text: '', toolCallArguments: '' }
      this.partials.set(index, partial)
      this.order.push(index)
    }
    return partial
  }

  private assemble(partial: PartialBlock, index: number): ContentBlock {
    if (partial.block) return partial.block
    switch (partial.blockType) {
      case 'text': return { type: 'text', text: partial.text }
      case 'reasoning': return { type: 'reasoning', text: partial.text }
      case 'tool-call': return {
        type: 'tool-call',
        id: partial.toolCallId ?? brandString<ToolCallId>(`call-${index}`),
        name: partial.toolCallName ?? '',
        arguments: partial.toolCallArguments,
      }
      default: throw new Error(`cannot assemble incomplete block of type "${partial.blockType}"`)
    }
  }

  /** 不变量访问器：`order` 中的每个索引都有一个部分块。 */
  private mustGet(index: number): PartialBlock {
    const partial = this.partials.get(index)
    if (!partial) throw new Error(`BlockAssembler invariant violated: no partial for index ${index}`)
    return partial
  }

  /**
   * 对所有已见块做出的唯一共享保留/丢弃决策：max-token 截断会丢弃
   * 无法安全执行的工具调用。已发出的块与回放元数据都从这一结果派生，
   * 因此它们不可能互相矛盾。
   */
  private assembled(): { blocks: ContentBlock[]; replay: ReplayEnvelope | undefined } {
    const all = this.order.map(index => this.assemble(this.mustGet(index), index))
    const kept = this.finish.kind === 'max-tokens'
      ? all.map(block => block.type !== 'tool-call')
      : undefined
    const blocks = kept === undefined ? all : all.filter((_, position) => kept[position])
    const envelope = this._replayState
    if (envelope?.blocks === undefined) return { blocks, replay: envelope }
    if (envelope.blocks.length !== all.length) return { blocks, replay: undefined }
    return {
      blocks,
      replay: kept === undefined || blocks.length === all.length
        ? envelope
        : { response: envelope.response, blocks: envelope.blocks.filter((_, position) => kept[position]) },
    }
  }

  /**
   * 按流顺序装配到目前为止所见到的全部块。
   * @returns 每个已见索引一个块，除了 max-token 截断会丢弃
   *   无法安全执行的工具调用；一个未关闭的块由它累计的增量装配而成
   *   （一个从未被 `block-end` 关闭的未知块类型会抛出）。
   */
  blocks(): ContentBlock[] {
    return this.assembled().blocks
  }

  /**
   * 装配一条被中断的流可以安全定稿的前缀：按流顺序排列的、
   * 带有非空白内容的、已关闭或未关闭的 text/reasoning 块。
   * 工具调用被省略，因为中断发生在分发之前；保留一个工具调用
   * 就需要伪造一个结果。未关闭的未知块同样被省略。
   * @returns 被保留的块；当中断之前没有任何流式输出时为空。
   */
  interruptedBlocks(): ContentBlock[] {
    return this.order
      .map((index) => {
        const partial = this.mustGet(index)
        const type = partial.block?.type ?? partial.blockType
        if (type !== 'text' && type !== 'reasoning') return undefined
        return this.assemble(partial, index)
      })
      .filter((block): block is ContentBlock =>
        (block?.type === 'text' || block?.type === 'reasoning') && block.text.trim() !== '')
  }

  /** 来自 `usage` 块的用量；在它到达之前为 undefined。 */
  get usage(): TokenUsage | undefined {
    return this._usage
  }

  /** 来自 `finish` 块的结束原因；当流在没有它的情况下结束时为 `{kind: 'stop'}`。 */
  get finish(): FinishReason {
    return this._finish ?? { kind: 'stop' }
  }

  /**
   * 来自终止性 finish 块的回放元数据（若有），其中按块的条目
   * 与 {@link blocks} 同步裁剪。当信封的条目与已发出的块不对齐时为 undefined。
   */
  get replayState(): ReplayEnvelope | undefined {
    return this.assembled().replay
  }

  /**
   * 已装配的助手消息。
   * @param source - 供已装配消息使用的提供方/模型归因（不含 `kind` 标签）。
   * @returns 一条覆盖 `blocks()` 的、已冻结的 assistant 角色消息
   *   （遵循同样的未关闭块装配规则）。
   */
  message(source: Omit<ModelMessageSource, 'kind'>): AssistantMessage {
    return createAssistantMessage({ content: this.blocks(), source })
  }
}
