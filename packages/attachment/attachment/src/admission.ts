/** base64 编码图像上传的线上形式准入。@module @deepseek-ai/dsh-attachment/admission */

import { Buffer } from 'node:buffer'
import { AttachmentError } from './error.ts'
import type { AttachmentStore } from './index.ts'
import type {
  EncodedFileAttachment,
  EncodedImageAttachment,
  FileAttachmentRef,
  ImageAttachmentRef,
  SaveImageAttachment,
} from './types.ts'

/** 解码一个上传载荷，同时拒绝非规范形式的 base64。 */
function decodeCanonicalBase64(data: string, empty: 'reject' | 'accept', code: 'INVALID_IMAGE_BASE64' | 'INVALID_FILE_BASE64'): Uint8Array {
  const decoded = Buffer.from(data, 'base64')
  if ((data.length === 0 && empty === 'reject') || decoded.toString('base64') !== data) {
    throw new AttachmentError(
      code === 'INVALID_IMAGE_BASE64' ? 'Image upload is not canonical base64.' : 'File upload is not canonical base64.',
      code,
    )
  }
  return new Uint8Array(decoded)
}

function decodeBase64(data: string): Uint8Array {
  return decodeCanonicalBase64(data, 'reject', 'INVALID_IMAGE_BASE64')
}

/** 某个已解码上传的存储输入。 */
function saveInput(image: EncodedImageAttachment): SaveImageAttachment {
  return {
    data: decodeBase64(image.data),
    mediaType: image.mediaType,
    ...image.name === undefined ? {} : { name: image.name },
  }
}

/**
 * 准入一批线上图像：对每个成员强制校验规范 base64，然后把批量准入
 * ——数量与聚合字节限制、媒体类型与逐图校验、按序提交——委托给
 * {@link AttachmentStore.saveImages}。这是所有接受浏览器上传的 RPC 端点的共享入口。
 * @param attachments - 持有批量策略的部署附件存储。
 * @param images - 按调用方顺序排列的 base64 编码上传。
 * @returns 与 `images` 顺序一致的持久化引用。
 * @throws AttachmentError 当载荷非规范或批量被拒绝时。
 */
export async function admitEncodedImages(
  attachments: AttachmentStore,
  images: readonly EncodedImageAttachment[],
): Promise<readonly ImageAttachmentRef[]> {
  return attachments.saveImages(images.map(saveInput))
}

/**
 * 准入一个线上文件上传：强制校验规范 base64（空文件是合法的零字节载荷），
 * 然后把逐字节提交委托给 {@link AttachmentStore.saveFile}。这是所有接受浏览器
 * 文件上传的 RPC 端点的共享入口。
 * @param attachments - 部署附件存储。
 * @param file - base64 编码的上传和可选显示名。
 * @returns 持久化的按内容寻址文件引用。
 * @throws AttachmentError 当载荷非规范或存储失败时。
 */
export async function admitEncodedFile(
  attachments: AttachmentStore,
  file: EncodedFileAttachment,
): Promise<FileAttachmentRef> {
  return attachments.saveFile({
    data: decodeCanonicalBase64(file.data, 'accept', 'INVALID_FILE_BASE64'),
    ...file.name === undefined ? {} : { name: file.name },
  })
}
