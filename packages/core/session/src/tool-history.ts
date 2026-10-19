/** 面向请求投影的历史工具定义的有状态重建。 */

import type { ToolHistory, ToolSchema } from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { SessionEvent, SessionSeq } from './types.ts'

/** 折叠已提交的 header 与 developer 消息，独立于模型能力。 */
export class ToolHistoryProjection {
  /** 按新增所引用的 header 序号索引的历史声明。 */
  private readonly headers = new Map<SessionSeq, readonly ToolSchema[]>()
  /** 当前声明序列中保留的定义，包括已移除的工具。 */
  private declared = new Map<string, ToolSchema>()
  /** 来自最新请求 header 的活跃定义。 */
  private active: readonly ToolSchema[] = []
  /** 由基线与已记录更新重建的活跃名称。 */
  private available = new Set<string>()
  /** 开启当前声明序列的 header；第一个 header 之前不存在。 */
  private baselineSeq: SessionSeq | undefined
  /** 当前基线与已解析更新的不可变请求快照。 */
  private history: ToolHistory = deepFreeze({ tools: [], updates: [] })

  /**
   * 按日志顺序消费下一个已提交事件。
   * @param event - 一个 session 事件，包括恢复期间的继承事件。
   */
  apply(event: SessionEvent): void {
    if (event.type === 'request/header') {
      const tools = event.data.header.tools ?? []
      this.headers.set(event.seq, tools)
      // 一个保留的名称不能在不丢失前缀复用的情况下获得不同定义；
      // 未变化的恢复名称会由其已记录的新增重新提供。
      const redeclared = tools.some((tool) => {
        const before = this.declared.get(tool.name)
        return before !== undefined && JSON.stringify(before) !== JSON.stringify(tool)
      })
      if (this.baselineSeq === undefined || event.data.reason === 'series' || event.data.startsSeries || redeclared) {
        this.baselineSeq = event.seq
        this.declared = new Map(tools.map(tool => [tool.name, tool]))
        this.history = deepFreeze({ tools, updates: [] })
        this.available = new Set(tools.map(tool => tool.name))
      }
      this.active = tools
    } else if (event.type === 'developer/message') {
      const { message, headerSeq } = event.data
      const definitions = headerSeq === undefined ? [] : this.headers.get(headerSeq)
      const additions = message.content.flatMap((block) => {
        if (block.type !== 'tool-addition') return []
        const tool = definitions?.find(tool => tool.name === block.toolName)
        if (tool === undefined) throw new Error(`tool history: missing definition for ${block.toolName}`)
        return [tool]
      })
      for (const tool of additions) this.declared.set(tool.name, tool)
      for (const block of message.content) {
        if (block.type === 'tool-addition') this.available.add(block.toolName)
        else if (block.type === 'tool-removal') this.available.delete(block.toolName)
      }
      this.history = deepFreeze({
        tools: this.history.tools,
        updates: [...this.history.updates, { messageId: message.id, additions }],
      })
    }
  }

  /**
   * 读取不可变快照；后续事件不会改变它。
   * @returns 当前序列的初始声明与历史解析的新增。
   */
  snapshot(): ToolHistory {
    // 在工具更新发出之前写入的 session，其 header 没有匹配的更新。
    if (this.active.length !== this.available.size || this.active.some(tool => !this.available.has(tool.name))) {
      return deepFreeze({ tools: this.active, updates: [] })
    }
    return this.history
  }
}
