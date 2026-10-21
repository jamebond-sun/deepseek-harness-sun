/** 由 image/offload 所记录图像出现项的不可变应用。 */

import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'

/**
 * 将所选图像出现项投影为不可变的卸载块。
 * @param message - 本次决策之前被投影的消息。
 * @param indexes - 非空、严格递增的深度优先图像索引。
 * @returns 具有相同标识、且所选图像被标记了的不可变消息。
 * @throws 当某个所选出现项缺失或已被卸载时。
 */
export function offloadMessageImages(message: Message, indexes: readonly number[]): Message {
  let imageIndex = 0
  let selected = 0
  const visit = (blocks: readonly ContentBlock[]): ContentBlock[] => {
    let next: ContentBlock[] | undefined
    for (const [index, block] of blocks.entries()) {
      let projected = block
      if (block.type === 'image') {
        if (imageIndex === indexes[selected]) {
          if (block.offloaded === true) throw new Error(`image/offload: image index ${imageIndex} is already offloaded`)
          projected = { ...block, offloaded: true }
          selected += 1
        }
        imageIndex += 1
      }
      if (projected !== block) next ??= blocks.slice(0, index)
      next?.push(projected)
    }
    return next ?? blocks as ContentBlock[]
  }
  const content = visit(message.content)
  if (selected !== indexes.length) throw new Error(`image/offload: image index ${indexes[selected]} does not exist`)
  return deepFreeze({ ...message, content })
}
