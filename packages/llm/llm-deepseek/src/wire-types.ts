/** DeepSeek 所支持的 Anthropic Messages 请求协议子集。 */

/** 用户消息与工具结果中可接受的文本，以及内联或文件引用的图像。 */
export type WireInput =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'image'; source: { type: 'file'; file_id: string } }

/** 序列化进一次 Messages 对话轮次的内容。 */
export type WireBlock = WireInput
  /** 按对话顺序启用或移除一个已声明的工具。 */
  | { type: 'tool_addition' | 'tool_removal'; tool: { type: 'tool_reference'; name: string } }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: WireInput[]; is_error?: boolean }

/** 对话轮次；具备相应能力的路由会把较晚的系统更新保留在消息历史中。 */
export type WireMessage = {
  role: 'user' | 'assistant' | 'system'
  content: WireBlock[]
}

/** 提交给已解析 Messages 端点的 JSON 请求体。 */
export type WireRequest = {
  model: string
  stream: true
  max_tokens: number
  messages: WireMessage[]
  system?: string
  thinking: { type: 'enabled' | 'disabled' }
  output_config?: { effort: 'low' | 'high' | 'max' }
  temperature?: number
  stop_sequences?: string[]
  tools?: {
    name: string
    description: string
    input_schema: Record<string, unknown>
    /** 把工具的可用性推迟到一个 tool_addition 块启用它时。 */
    defer_loading?: true
  }[]
}
