/** 持久化附件词汇表。@module @deepseek-ai/dsh-attachment/types */

import type { AttachmentId, ImageVariantId } from './brand.ts'

export type { AttachmentId } from './brand.ts'

/** 第一版附件路径所接受的位图图像格式。 */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** 指向一个不可变规范化图像的持久化、可序列化引用。 */
export interface ImageAttachmentRef {
  /** 不透明的存储标识符；绝不是文件系统路径或 bearer URL。 */
  attachmentId: AttachmentId
  /** 依据已存储字节校验过的媒体类型。 */
  mediaType: ImageMediaType
  /** 精确的编码字节长度。 */
  bytes: number
  /** 编码后的固有宽度（像素）。 */
  width: number
  /** 编码后的固有高度（像素）。 */
  height: number
  /** 可选的显示名，已剥离本地路径信息。 */
  name?: string
  /**
   * 应用 EXIF 方向之后、规范化缩放之前的输入尺寸。
   * 仅当规范化缩小了图像时才存在。
   */
  originalDimensions?: {
    width: number
    height: number
  }
}

/**
 * 指向一个逐字节存储文件的持久化、可序列化引用。文件按字节原样存储，
 * 不做规范化；`attachmentId` 正是这些字节的 sha256 摘要。
 */
export interface FileAttachmentRef {
  /** 不透明的按内容寻址存储标识符；绝不是文件系统路径或 bearer URL。 */
  attachmentId: AttachmentId
  /** 净化后的显示文件名，同时也是存储对象的叶子名。 */
  name: string
  /** 精确的字节长度。 */
  bytes: number
}

/** 随一次线上请求提交的 base64 编码文件上传。 */
export interface EncodedFileAttachment {
  /** 文件字节的规范 base64 编码。 */
  data: string
  /** 可选的显示名；它绝不会被当作路径解析。 */
  name?: string
}

/** 逐字节持久化提交一个文件的请求。 */
export interface SaveFileAttachment {
  data: Uint8Array
  /** 可选的浏览器/提供方显示名；它绝不会被当作路径解析。 */
  name?: string
}

/** 从有界字节块持久化提交一个文件的请求。 */
export interface SaveFileStreamAttachment {
  /** 有序的精确文件字节；提供方不得在内存中保留完整序列。 */
  data: AsyncIterable<Uint8Array>
  /** 可选的取消信号，用于源读取和存储写入。 */
  signal?: AbortSignal
  /** 可选的浏览器/提供方显示名；它绝不会被当作路径解析。 */
  name?: string
}

/** 上传准入与请求缓冲所使用的、按部署解析出的限制。 */
export interface ImageAttachmentLimits {
  maxImageBytes: number
  maxImagesPerMessage: number
  maxMessageImageBytes: number
  maxImagePixels: number
  /** 单张图像允许的最大固有宽度和最大固有高度（像素）。 */
  maxImageDimension: number
  mediaTypes: readonly ImageMediaType[]
}

/** 随一次线上请求提交的 base64 编码图像上传。 */
export interface EncodedImageAttachment {
  /** 调用方声明的媒体类型，在准入时依据解码后的字节进行校验。 */
  mediaType: ImageMediaType
  /** 图像字节的规范 base64 编码。 */
  data: string
  /** 可选的显示名；它绝不会被当作路径解析。 */
  name?: string
}

/**
 * Host 提示端点所接受的、由浏览器提交的提示内容；接受该内容的 Host 会在
 * 创建任何消息之前，通过 `ctx.attachments.admitPromptContent()` 将图像部分
 * 提升为持久化引用，因此线上调用方永远无法引用它未上传的附件。
 */
export type PromptContentPart =
  | { readonly type: 'text'; readonly text: string }
  | {
    readonly type: 'image'
    readonly mediaType: ImageMediaType
    readonly data: string
    readonly name?: string
  }

/** 文件凭证已解析、图像字节等待准入的 Host 提示内容。 */
export type AttachmentAdmissionPart =
  | PromptContentPart
  | { readonly type: 'file'; readonly attachment: FileAttachmentRef }

/** 经 Host 准入的提示内容，其中每个附件都以其持久化引用表示。 */
export type AdmittedPromptContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly attachment: ImageAttachmentRef }
  | { readonly type: 'file'; readonly attachment: FileAttachmentRef }

/** 校验并持久化提交一张图像的请求。 */
export interface SaveImageAttachment {
  data: Uint8Array
  /** 调用方声明的媒体类型，会依据完全解码后的字节进行检查。 */
  mediaType: ImageMediaType
  /** 可选的浏览器/提供方显示名；它绝不会被当作路径解析。 */
  name?: string
}

/** 通过引用与摘要校验后返回的已存储图像字节。 */
export interface StoredImageAttachment {
  ref: ImageAttachmentRef
  data: Uint8Array
}

/** 某个确切模型路由为某个附件选定的确定性请求图像目标。 */
export interface ImageRequestTarget {
  /** 目标宽度（像素）；目标高于源时保留源宽度。 */
  width: number
  /** 目标高度（像素）；目标高于源时保留源高度。 */
  height: number
  /** base64 膨胀或 Files API 上传之前的编码字节目标；当没有任何质量档满足时，保留质量阶梯中最小的输出。 */
  maxBytes: number
}

/** 由某个与提供方无关的规范化附件派生出的缓存请求版本。 */
export interface RequestImageAttachment {
  /** 覆盖附件 id、策略与固定编码器参数的缓存键和上传索引键。 */
  variantId: ImageVariantId
  /** 派生此请求版本所依据的持久化规范化附件。 */
  attachment: ImageAttachmentRef
  /** 编码后的请求字节。 */
  data: Uint8Array
  mediaType: ImageMediaType
  bytes: number
  width: number
  height: number
  /** 请求编码之后确认的、与提供方兼容的采样位深。 */
  depth: 'uchar'
  /** 请求编码之后确认的、与提供方兼容的色彩空间。 */
  space: 'srgb'
  /** 编码后的请求版本是否保留 alpha 通道。 */
  hasAlpha: boolean
}
