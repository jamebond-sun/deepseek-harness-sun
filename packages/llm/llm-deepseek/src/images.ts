/** 确定性的 Messages 图像准备：Files 引用与有界的内联回退。 */

import type { AttachmentStore, ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { contentHasImage, IMAGE_OFFLOAD_REQUIRED_CODE, LlmError, offloadedImageText, projectOffloadedImages, requiredImageOffload } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ImageAttachmentAccessResolver, RequestMessage } from '@deepseek-ai/dsh-llm'
import type { DeepSeekConnectionOptions as Connection } from './types.ts'
import { resolveRequestImageTarget } from './request-pricing.ts'
import type { DeepSeekFileId } from './file-id.ts'
import type { RequestFiles } from './request-files.ts'

export { deepSeekImageRequestPricing as imagePricing } from './request-pricing.ts'

function bounds(connection: Connection, representation: 'raw' | 'base64') {
  return {
    representation,
    maxBytes: representation === 'raw' ? connection.maxRequestFilesBytes : connection.maxInlineRequestImageBytes,
    maxImages: connection.maxImagesPerRequest,
    byteQuantum: representation === 'raw' ? connection.imageOffloadByteQuantum : connection.inlineImageOffloadByteQuantum,
    countQuantum: connection.imageOffloadCountQuantum,
  }
}

function* imageRefs(blocks: readonly ContentBlock[]): Generator<ImageAttachmentRef> {
  for (const block of blocks) {
    if (block.type === 'image') yield block.attachment
  }
}

/** 在转换 Messages 内容之前，规范化被保留下来的图像引用。
 * @param history - 持久化历史；从不被改动。
 * @param connection - 请求级的图像预算。
 * @param modelId - 目标模型 id。
 * @param attachments - 已挂载的附件存储；仅图像请求需要它。
 * @param access - 当前执行世界的路径解析器。
 * @param signal - 请求取消信号。
 * @returns 投影后的历史，以及按附件 id 组织的、已准备好的图像字节。
 */
export async function prepareImages(
  history: readonly RequestMessage[], connection: Connection, modelId: string,
  attachments: AttachmentStore | undefined, access: ImageAttachmentAccessResolver, signal: AbortSignal,
): Promise<{ messages: readonly RequestMessage[]; versions: Map<ImageAttachmentRef['attachmentId'], RequestImageAttachment> }> {
  const versions = new Map<ImageAttachmentRef['attachmentId'], RequestImageAttachment>()
  const messages = projectOffloadedImages(history, ref => offloadedImageText(ref, access(ref)))
  if (!messages.some(message => contentHasImage(message.content))) return { messages, versions }
  const model = connection.models.find(entry => entry.id === modelId)
  if (model?.inputModalities?.includes('image') !== true || attachments === undefined) {
    throw new LlmError('DeepSeek Messages image input requires a vision model and attachment service', 'UNSUPPORTED_CONTENT')
  }
  if (messages.some(message => message.role !== 'user' && message.role !== 'tool' && contentHasImage(message.content))) {
    throw new LlmError('DeepSeek Messages supports images only in user messages and tool results', 'UNSUPPORTED_CONTENT')
  }
  for (const message of messages) {
    for (const ref of imageRefs(message.content)) {
      if (!versions.has(ref.attachmentId)) {
        versions.set(ref.attachmentId, await attachments.readImageRequest(ref, resolveRequestImageTarget(model, ref), signal))
      }
    }
  }
  assertImagesFit(messages, versions, connection, 'raw')
  return { messages, versions }
}

/** 在重试超出内联预算的图像之前，要求先有已记录的卸载。
 * @param messages - 已处于 Files 预算之内的历史。
 * @param versions - 为被保留的引用准备好的、规范化后的版本。
 * @param connection - 已解析的内联边界。
 * @returns 同时满足字节与图像数量限制、且未被改动的历史。
 */
export function inlineImages(
  messages: readonly RequestMessage[], versions: ReadonlyMap<ImageAttachmentRef['attachmentId'], RequestImageAttachment>,
  connection: Connection,
): readonly RequestMessage[] {
  assertImagesFit(messages, versions, connection, 'base64')
  return messages
}

/** 统计按其精确表示字节数、需要持久卸载的、额外的更早出现次数。 */
function assertImagesFit(
  messages: readonly RequestMessage[], versions: ReadonlyMap<ImageAttachmentRef['attachmentId'], RequestImageAttachment>,
  connection: Connection, representation: 'raw' | 'base64',
): void {
  const offloadImages = requiredImageOffload(messages, bounds(connection, representation),
    block => (versions.get(block.attachment.attachmentId) as RequestImageAttachment).bytes)
  if (offloadImages > 0) {
    throw new LlmError(
      `DeepSeek Messages ${representation} request images exceed the route budget; ${offloadImages} more oldest occurrence(s) must be offloaded.`,
      IMAGE_OFFLOAD_REQUIRED_CODE,
      { offloadImages },
    )
  }
}

/** 把被保留的图像解析为 Files id，并记录每次出现以便失败诊断。
 * @param messages - 处于 Files 字节/数量预算之内的历史。
 * @param versions - 每个被保留引用的规范化版本。
 * @param files - 由请求持有的 Files 解析与恢复机制。
 * @returns 以持久化附件身份为键的 id。
 */
export async function prepareFileIds(
  messages: readonly RequestMessage[], versions: ReadonlyMap<ImageAttachmentRef['attachmentId'], RequestImageAttachment>, files: RequestFiles,
): Promise<Map<ImageAttachmentRef['attachmentId'], DeepSeekFileId>> {
  const ids = new Map<ImageAttachmentRef['attachmentId'], DeepSeekFileId>()
  for (const [index, message] of messages.entries()) {
    let image = 0
    for (const ref of imageRefs(message.content)) {
      const version = versions.get(ref.attachmentId) as RequestImageAttachment
      ids.set(ref.attachmentId, await files.resolve(version, { message: index + 1, image: ++image }))
    }
  }
  return ids
}
