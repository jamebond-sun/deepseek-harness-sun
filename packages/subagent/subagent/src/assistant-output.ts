/**
 * 子代理最终助手输出的规范选取规则。后端运行结果与
 * `subagent/end.lastAssistantMessage` 采用同一规则：选取最后一条非空的
 * 助手消息。空内容消息仅在循环于 max-tokens 步骤之后且没有可执行块时
 * 追加，仅记录用量，因此不会替代更早的输出。若不存在非空消息，则选取
 * 累积的助手文本。选取与运行的停止原因无关。
 *
 * @module @deepseek-ai/dsh-subagent/assistant-output
 */

import { joinAssistantStreamText, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * 选取规则的增量折叠，供那些在子代理输出流式产生时就观测它的后端使用：
 * 有 session 事件的后端用 {@link push} 推送每个事件，而没有 session 事件的
 * 传输（ACP 内容分块）用 {@link pushText} 把原始文本送入同一个流式兜底。
 */
export class AssistantOutputFold {
  private message: readonly ContentBlock[] | undefined
  private partial: string[] = []

  /**
   * 折叠一个 session 事件：非空助手消息成为候选最终答案，而其内嵌流与
   * 任何仅用于日志的 attempt 扩展流式兜底；其他所有事件不产生贡献。
   * @param event - 下一个被观测到的 session 事件。
   */
  push(event: SessionEvent): void {
    if (event.type === 'assistant/message') {
      const content = event.data.message.content
      if (content.length > 0) this.message = content
    }
    if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      this.pushText(joinAssistantStreamText(event.data.stream))
    }
  }

  /**
   * 用在 session 事件之外观测到的文本扩展流式兜底。
   * @param text - 下一个流式文本片段（空片段为空操作）。
   */
  pushText(text: string): void {
    if (text.length > 0) this.partial.push(text)
  }

  /**
   * 选取到目前为止折叠出的最终输出。
   * @returns 最后一条非空助手消息，否则为累积的流式文本；
   *   若子代理两者都未产生则为 `undefined`。
   */
  collect(): readonly ContentBlock[] | undefined {
    if (this.message !== undefined) return this.message
    const text = this.partial.join('')
    return text.length > 0 ? [{ type: 'text', text }] : undefined
  }
}

/**
 * 将选取规则应用于一段完整的、子代理自有的事件后缀。
 * @param events - 子代理自有的事件（位于任何 seed 或周期边界之后）。
 * @returns 选中的输出，若子代理未产生任何输出则为 `undefined`。
 */
export function finalAssistantOutput(events: readonly SessionEvent[]): readonly ContentBlock[] | undefined {
  // TODO: 这里对完整后缀做一次折叠，按运行/周期结算。若某个很长的可续跑
  // 周期在此处被 profiling 判定为热点，可改为向前扫描并提前退出寻找最后
  // 一条非空消息，仅在无消息兜底分支折叠文本增量。
  const fold = new AssistantOutputFold()
  for (const event of events) fold.push(event)
  return fold.collect()
}
