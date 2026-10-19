/** 附件标识符品牌。@module @deepseek-ai/dsh-attachment/brand */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** 指向一个不可变附件对象的、按内容寻址的不透明标识符。 */
export type AttachmentId = Branded<'AttachmentId'>

/**
 * 为已校验的存储标识符加上品牌标记。
 * @param value - 由后端产生的不透明标识符。
 * @returns 带品牌标记的标识符。
 */
export function AttachmentId(value: string): AttachmentId {
  return value as AttachmentId
}

/** 指向一次请求图像变换的不透明确定性标识。 */
export type ImageVariantId = Branded<'ImageVariantId'>

/**
 * 为已校验的请求图像变换标识符加上品牌标记。
 * @param value - 由附件提供方产生的不透明标识符。
 * @returns 带品牌标记的标识符。
 */
export function ImageVariantId(value: string): ImageVariantId {
  return value as ImageVariantId
}
