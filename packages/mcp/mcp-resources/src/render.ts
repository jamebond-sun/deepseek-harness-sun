/**
 * 资源结果的投影把二进制负载挡在模型历史之外。
 *
 * @module @deepseek-ai/dsh-mcp-resources
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/**
 * 渲染资源 JSON，同时只为程序化调用方保留原始二进制数据。
 * @param server - 已配置的服务端归属。
 * @param value - 规范化的资源结果。
 * @returns 带归属信息的文本，其中对二进制负载给出描述。
 */
export function renderResourceResult(server: string, value: JsonValue): ContentBlock[] {
  const rendered = JSON.stringify(value, (key, item: unknown) => {
    if (key === 'blob' && typeof item === 'string') {
      return `[binary resource: ${item.length} base64 characters; available to programmatic callers]`
    }
    return item
  })
  return [{ type: 'text', text: `MCP server: ${server}\n${rendered}` }]
}
