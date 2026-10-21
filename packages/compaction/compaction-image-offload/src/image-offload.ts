/** 按当前模型请求顺序选择并记录永久性的图像省略项。 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import type { ImageOffloadTarget } from './projection.ts'

/**
 * 记录一个省略最旧保留输入图像出现项的决策。
 * 助手节点携带模型输出，因此被排除。图像索引在每条消息内
 * 统计每一个出现项，包括先前已卸载的那些。
 * @param session - 其下一次请求将应用该决策的会话。
 * @param sourceEventSeqs - 失败请求顺序下的输入消息事件。
 * @param count - 适配器需要省略的额外保留出现项数量。
 * @returns 是否仍有出现项可供卸载。
 */
export function offloadOldestImages(session: Session, sourceEventSeqs: readonly SessionSeq[], count: number): boolean {
  const targets: ImageOffloadTarget[] = []
  for (const seq of sourceEventSeqs) {
    if (count === 0) break
    // 既有 Session 历史读取；迁移暂缓。当前表层节点索引持久化日志。
    // oxlint-disable-next-line typescript/no-non-null-assertion, typescript/no-deprecated
    const event = session.eventAt(seq)!
    if (event.type !== 'user/message' && event.type !== 'tool/result') continue
    // oxlint-disable-next-line typescript/no-non-null-assertion -- 两种输入节点类型都会产生一条消息
    const message = session.deriveEventMessage(event)!
    const imageIndexes: number[] = []
    let imageIndex = 0
    const visit = (blocks: readonly ContentBlock[]): void => {
      for (const block of blocks) {
        if (count === 0) break
        if (block.type === 'image') {
          if (block.offloaded !== true) {
            imageIndexes.push(imageIndex)
            count -= 1
          }
          imageIndex += 1
        }
      }
    }
    visit(message.content)
    if (imageIndexes.length > 0) targets.push({ seq, imageIndexes })
  }
  if (targets.length === 0) return false
  session.append('image/offload', { targets })
  return true
}
