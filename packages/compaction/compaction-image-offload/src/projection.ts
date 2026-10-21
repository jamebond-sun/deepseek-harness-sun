/** 浏览器安全的持久化图像选择声明与纯重放定义。 */

import type { Message } from '@deepseek-ai/dsh-llm'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionMessageProjection } from '@deepseek-ai/dsh-session/surface'
import { offloadMessageImages } from './project-message.ts'

/** 由一次持久化卸载决策所选中的精确输入图像出现项。 */
export interface ImageOffloadTarget {
  /** 包含这些出现项的、当前产生消息的事件。 */
  seq: SessionSeq
  /** 不可变消息内、从零开始的深度优先图像索引。 */
  imageIndexes: number[]
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * 从后续模型请求中永久省略所选的输入图像出现项。
     * 目标以唯一当前的 user/message 或 tool/result 节点命名。非空、严格递增的索引
     * 以深度优先顺序统计所有图像，包括嵌套的工具结果与已省略的图像。
     * 消息节点与标识保持不变。
     * @messageProjection
     */
    'image/offload': { targets: ImageOffloadTarget[] }
  }
}

/** 判断某个持久化值是否为 JSON 对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 判断某个持久化出现项索引或序列是否规范。 */
function isIndex(value: unknown): value is SessionSeq {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

/** 在线会话与独立重放所共享的原子化校验与重建。 */
export const imageOffloadProjection: SessionMessageProjection<'image/offload'> = {
  type: 'image/offload',
  project(event, context) {
    const data: unknown = event.data
    if (!isRecord(data) || Object.keys(data).length !== 1 || !Array.isArray(data['targets']) || data['targets'].length === 0) {
      throw new Error('image/offload: data must contain a nonempty targets array')
    }
    const messages = new Map<SessionSeq, Message>()
    const nodes = new Set(context.nodes)
    for (const target of data['targets'] as unknown[]) {
      if (!isRecord(target) || Object.keys(target).length !== 2 || !isIndex(target['seq'])
        || !Array.isArray(target['imageIndexes']) || target['imageIndexes'].length === 0) {
        throw new Error('image/offload: each target must contain a seq and nonempty imageIndexes')
      }
      const seq = target['seq']
      if (messages.has(seq)) throw new Error(`image/offload: duplicate target seq ${seq}`)
      if (!nodes.has(seq)) throw new Error(`image/offload: target seq ${seq} is not a current surface node`)
      const source = context.events[seq - context.baseSeq]
      if (source?.type !== 'user/message' && source?.type !== 'tool/result') {
        throw new Error(`image/offload: target seq ${seq} must be user/message or tool/result`)
      }
      let previous = -1
      for (const index of target['imageIndexes'] as unknown[]) {
        if (!isIndex(index) || index <= previous) {
          throw new Error('image/offload: imageIndexes must be strictly increasing non-negative safe integers')
        }
        previous = index
      }
      const message = context.messages.get(seq)
        ?? (source.type === 'user/message' ? source.data : source.data.message)
      messages.set(seq, offloadMessageImages(message, target['imageIndexes'] as number[]))
    }
    return messages
  },
}
