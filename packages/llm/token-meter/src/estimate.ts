/**
 * 由计量器服务与纯上下文分解投影共享的固定密度启发式令牌定价，
 * 因此两个表面对相同内容会给出相同的数字。
 *
 * @module @deepseek-ai/dsh-token-meter/estimate
 */

import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type { EpochHeader } from '@deepseek-ai/dsh-session'

/** 在需要精确分词之前使用的固定文本密度估计。 */
const CHARS_PER_TOKEN = 4

/** 每个块为 JSON 框架与类型标签付出的结构性开销。 */
const BLOCK_OVERHEAD = 4

/** 施加到每个被计价消息上的角色字段框架开销。 */
export const ROLE_OVERHEAD = 4

/**
 * 类型化定价分支之外一个块的结构性 JSON 价格：合并扩展出来的块，
 * 以及图像引用（其请求价格由路由持有而非固定）所使用的固定启发式。
 * 图像卸载标记不改变这个仅作参考的启发式；它们的占位文本由路由定价持有。
 * @param block - 要在不改动的前提下计价的块。
 * @returns 该块 JSON 结构的启发式令牌数。
 */
export function estimateStructuralBlock(block: ContentBlock): number {
  if (block.type === 'image') {
    const { offloaded: _offloaded, ...reference } = block
    return BLOCK_OVERHEAD + Math.ceil(JSON.stringify(reference).length / CHARS_PER_TOKEN)
  }
  return BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN)
}

/**
 * 在固定密度启发式之下递归地对内容块计价。
 * @param blocks - 要在不改动的前提下计价的内容块。
 * @returns 包含每个块结构性开销的启发式令牌数。
 */
export function estimateContent(blocks: readonly ContentBlock[]): number {
  let tokens = 0
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        tokens += Math.ceil(block.text.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
        break
      case 'tool-call':
        tokens += Math.ceil(block.name.length / CHARS_PER_TOKEN)
          + Math.ceil(block.arguments.length / CHARS_PER_TOKEN)
          + BLOCK_OVERHEAD
        break
      default:
        // ContentBlockMap 是可合并扩展的；未知块（以及图像引用，
        // 其请求价格由路由持有）在固定启发式之下保留一个保守的结构性 JSON 价格。
        tokens += estimateStructuralBlock(block)
    }
  }
  return tokens
}

/**
 * 对已渲染的系统提示计价：`system/message` 表面节点的文本。
 * 适配器把提示序列化为普通字符串——一个 system 角色的消息或请求的 system 字段——
 * 而不是一个有类型的内容块，因此该价格是文本密度加上角色框架，没有每块开销。
 * @param message - 要在不改动的前提下计价的 system 角色消息。
 * @returns 系统提示的启发式令牌数；内容为空时为 0（“没有系统提示”）。
 */
export function estimateSystemMessage(message: Message): number {
  if (message.content.length === 0) return 0
  let characters = 0
  for (const block of message.content) {
    characters += block.type === 'text' ? block.text.length : JSON.stringify(block).length
  }
  return Math.ceil(characters / CHARS_PER_TOKEN) + ROLE_OVERHEAD
}

/**
 * 用启发式对一条模型可见的消息计价。
 * @param message - 要在不改动的前提下计价的消息。
 * @returns 固定启发式之下的内容与角色框架令牌数；
 *   system 角色的消息按 {@link estimateSystemMessage} 计价。
 */
export function estimateMessage(message: Message): number {
  if (message.role === 'system') return estimateSystemMessage(message)
  return estimateContent(message.content) + ROLE_OVERHEAD
}

/**
 * 对规范请求信封的工具 schema 部分计价——这是信封中唯一被计价的字段，
 * 因为系统提示是一个表面节点。
 * @param header - 规范信封；在任何请求之前为 undefined。
 * @returns 工具 schema 的启发式令牌数；缺失或为空时为 0。
 */
export function estimateToolsTokens(header: EpochHeader | undefined): number {
  if (header?.tools === undefined || header.tools.length === 0) return 0
  return Math.ceil(JSON.stringify(header.tools).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
}
