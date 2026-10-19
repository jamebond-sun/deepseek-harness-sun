/** 附件失败类。@module @deepseek-ai/dsh-attachment/error */

const IMAGE_ADMISSION_ERROR_CODES = [
  'TOO_MANY_IMAGES',
  'IMAGES_TOO_LARGE',
  'UNSUPPORTED_IMAGE_TYPE',
  'INVALID_IMAGE_BASE64',
  'INVALID_IMAGE',
  'IMAGE_TYPE_MISMATCH',
  'IMAGE_TOO_LARGE',
  'IMAGE_TOO_MANY_PIXELS',
  'IMAGE_DIMENSION_TOO_LARGE',
] as const

/** 准入图像输入时引发的、调用方可自行纠正的附件失败代码。 */
export type ImageAdmissionErrorCode = typeof IMAGE_ADMISSION_ERROR_CODES[number]

const ATTACHMENT_ERROR_CODES = [
  ...IMAGE_ADMISSION_ERROR_CODES,
  'INVALID_FILE_BASE64',
  'INVALID_ATTACHMENT_REF',
  'ATTACHMENT_CORRUPT',
  'ATTACHMENT_WRITE_FAILED',
  'ATTACHMENT_NOT_FOUND',
  'ATTACHMENT_READ_FAILED',
  'ATTACHMENT_PROJECTION_UNSUPPORTED',
  'ATTACHMENT_FILES_UNSUPPORTED',
] as const

/** 用于协议错误路由的稳定附件失败代码。 */
export type AttachmentErrorCode = typeof ATTACHMENT_ERROR_CODES[number]

/** 供跨包边界传递的结构兼容错误使用的运行时成员判断。 */
const IMAGE_ADMISSION_ERROR_CODE_SET: ReadonlySet<string> = new Set(IMAGE_ADMISSION_ERROR_CODES)
const ATTACHMENT_ERROR_CODE_SET: ReadonlySet<string> = new Set(ATTACHMENT_ERROR_CODES)

/**
 * 适合 Host RPC 错误映射的稳定失败。
 *
 * 刻意重新实现 `HarnessError` 的形式而不扩展它：
 * 基类位于 `@deepseek-ai/dsh-llm`，而后者本身依赖本
 * 包（`ImageBlock` 引用 `ImageAttachmentRef`），共享基类
 * 会造成依赖循环。消费方基于 `code` 路由，绝不基于
 * 原型链，因此两种形式在 wire 边界保持可互换。
 */
export class AttachmentError extends Error {
  /** 供机器路由使用的稳定失败代码。 */
  readonly code: AttachmentErrorCode

  /**
   * @param message - 人类可读的失败描述，不含原始字节或主机路径。
   * @param code - 供机器路由使用的稳定代码。
   * @param options - 可选的链式原因。
   */
  constructor(message: string, code: AttachmentErrorCode, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AttachmentError'
    this.code = code
  }
}

/**
 * 跨重复安装的包，按稳定代码识别附件失败。
 * @param error - 校验、持久化或读取附件时引发的失败。
 * @returns 该失败是否带有可识别的附件错误代码。
 */
export function isAttachmentError(error: unknown): error is AttachmentError {
  return error instanceof Error
    && 'code' in error
    && typeof error.code === 'string'
    && ATTACHMENT_ERROR_CODE_SET.has(error.code)
}

/**
 * 把调用方可纠正的图像准入失败与存储故障区分开。
 * @param error - 校验或持久化图像批量时引发的失败。
 * @returns 调用方能否纠正所提交的图像内容或批量。
 */
export function isImageAdmissionError(
  error: unknown,
): error is AttachmentError & { readonly code: ImageAdmissionErrorCode } {
  return error instanceof Error
    && 'code' in error
    && typeof error.code === 'string'
    && IMAGE_ADMISSION_ERROR_CODE_SET.has(error.code)
}
