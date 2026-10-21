/**
 * 溢出存储服务定义的词汇。只有类型 —— 抽象服务在 `./index.ts`，
 * 实现在同级的兄弟包（首先是 `@deepseek-ai/dsh-spill-local`）。
 *
 * @module @deepseek-ai/dsh-spill/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

/**
 * 单个溢出产物的不透明、面向模型句柄。本地后端可以使用文件系统路径；
 * 远程或数据库后端可以使用 URI 或键。消费方把它与
 * {@link SpillRef.retrievalHint} 一起渲染，但绝不解析它。
 */
export type SpillLocator = Branded<'SpillLocator'>

/**
 * 把一个字符串标记为 {@link SpillLocator}。
 *
 * @param locator 后端产生的定位信息字符串，将被加上品牌类型。
 * @returns 带品牌类型的溢出定位信息。
 */
export function SpillLocator(locator: string): SpillLocator {
  return locator as SpillLocator
}

/**
 * 溢出产物在保存时的存储命名空间。会话 id 让后端可以按产生它的会话
 * 组织存储，但返回的 {@link SpillLocator} 才是面向模型的句柄。
 * fork 出的会话会继承种子日志中已有的定位信息；那些产物不会被复制或
 * 重新归属，fork 之后产生的溢出则使用子会话 id。
 */
export interface SpillOwner {
  sessionId: SessionId
}

/**
 * 溢出产物的产生者。工具结果携带模型下发的调用 id；
 * 会话引用则改为标识被捕获的源会话。仅作描述性来源说明，
 * 绝不用于访问控制。
 */
export type SpillSource = {
  kind: 'tool'
  /** 结果被溢出的那个工具（例如 `web_fetch`）。 */
  toolName: string
  /** 该结果所属的模型下发调用 id。 */
  callId: ToolCallId
  /** 产物的人类可读短标签（例如 `result`）。 */
  label: string
} | {
  kind: 'session-reference'
  /** 其投映对话被捕获的会话。 */
  sessionId: SessionId
  /** 宿主为被引用会话提供的标签。 */
  label: string
}

/** 一次把文本持久化到溢出产物的请求。 */
export interface SaveTextSpill {
  owner: SpillOwner
  source: SpillSource
  /**
   * 调用方建议的基础名称（例如 `web_fetch.txt`）。后端在使用前会把它
   * 清理成单个安全路径段 —— 它是提示，绝不是路径。
   */
  suggestedName: string
  /** 要持久化的完整文本（UTF-8）。 */
  content: string
}

/** 一个已保存的溢出产物：它的定位信息、字节长度，以及后端特有的取回指引。 */
export interface SpillRef {
  locator: SpillLocator
  bytes: number
  retrievalHint: string
}
