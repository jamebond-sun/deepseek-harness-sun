/** 持久化附件存储接缝（`ctx.attachments`）。@module @deepseek-ai/dsh-attachment */

import { Context, Service } from '@deepseek-ai/cordis'
import { admitEncodedFile as admitFileInput, admitEncodedImages } from './admission.ts'
import { AttachmentError, isAttachmentError as matchesAttachmentError } from './error.ts'
import type {
  AdmittedPromptContentPart,
  AttachmentAdmissionPart,
  EncodedFileAttachment,
  FileAttachmentRef,
  ImageAttachmentLimits,
  ImageAttachmentRef,
  ImageRequestTarget,
  RequestImageAttachment,
  SaveFileAttachment,
  SaveFileStreamAttachment,
  SaveImageAttachment,
  StoredImageAttachment,
} from './types.ts'

export { AttachmentId, ImageVariantId } from './brand.ts'
export { AttachmentError, isAttachmentError, isImageAdmissionError } from './error.ts'
export type { AttachmentErrorCode, ImageAdmissionErrorCode } from './error.ts'
export { admitEncodedFile, admitEncodedImages } from './admission.ts'
export { longEdgeDimensions, requestImageDimensions } from './request-projection.ts'
export type { ProjectedDimensions } from './request-projection.ts'
export type {
  AttachmentId as AttachmentIdType,
  AdmittedPromptContentPart,
  AttachmentAdmissionPart,
  EncodedFileAttachment,
  EncodedImageAttachment,
  FileAttachmentRef,
  ImageAttachmentLimits,
  ImageAttachmentRef,
  ImageRequestTarget,
  ImageMediaType,
  PromptContentPart,
  RequestImageAttachment,
  SaveFileAttachment,
  SaveFileStreamAttachment,
  SaveImageAttachment,
  StoredImageAttachment,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    attachments: AttachmentStore
  }
}

/** 不可变的二进制附件服务。实现必须在发布引用之前校验字节。 */
export abstract class AttachmentStore extends Service {
  constructor(ctx: Context) {
    super(ctx, 'attachments')
  }

  /** 按部署解析出的图像策略，供权威校验与快速路径校验使用。 */
  abstract readonly imageLimits: ImageAttachmentLimits

  /**
   * 校验单张图像而不持久化它。
   * 批量调用方在保存任何成员之前校验每个成员。
   * @param input - 编码字节、声明的媒体类型和可选显示名。
   * @returns 编码光栅完全解码后完成。
   */
  abstract validateImage(input: SaveImageAttachment): Promise<void>

  /**
   * 在提交任何成员之前校验一个有序图像批量。
   * 校验失败不会开始任何写入；存储失败不返回部分引用，
   * 但已发布的内容寻址对象可能保持不可达，
   * 直到未来的保留策略回收它们。
   * @param inputs - 按其所属消息顺序排列的编码图像。
   * @returns 与输入顺序完全一致的持久化引用。
   */
  protected validateImageBatch(inputs: readonly SaveImageAttachment[]): void {
    const { maxImagesPerMessage, maxMessageImageBytes, mediaTypes } = this.imageLimits
    if (inputs.length > maxImagesPerMessage) {
      throw new AttachmentError('Image batch exceeds the configured image-count limit.', 'TOO_MANY_IMAGES')
    }
    const totalBytes = inputs.reduce((sum, input) => sum + input.data.byteLength, 0)
    if (totalBytes > maxMessageImageBytes) {
      throw new AttachmentError('Image batch exceeds the configured aggregate image-byte limit.', 'IMAGES_TOO_LARGE')
    }
    for (const input of inputs) {
      if (!mediaTypes.includes(input.mediaType)) {
        throw new AttachmentError(`Image type ${input.mediaType} is not accepted by this deployment.`, 'UNSUPPORTED_IMAGE_TYPE')
      }
    }
  }

  /**
   * 校验并持久化提交一个有序图像批量。
   * @param inputs - 按所属消息顺序排列的编码图像。
   * @returns 每个成员都成功后，同序的持久化规范化附件引用。
   */
  async saveImages(inputs: readonly SaveImageAttachment[]): Promise<readonly ImageAttachmentRef[]> {
    this.validateImageBatch(inputs)
    for (const input of inputs) await this.validateImage(input)

    const refs: ImageAttachmentRef[] = []
    for (const input of inputs) refs.push(await this.saveImage(input))
    return refs
  }

  /**
   * 准入一个 Host 提示，并把每个上传图像替换为其持久化引用。
   * 文本与持久化文件引用原样通过。不含图像部分的提示不执行任何存储操作。
   * @param content - 文件凭证解析之后、按消息顺序排列的提示部分。
   * @returns 与 `content` 同序的已准入提示部分。
   * @throws AttachmentError 当图像批量被拒绝时。
   */
  async admitPromptContent(
    content: readonly AttachmentAdmissionPart[],
  ): Promise<AdmittedPromptContentPart[]> {
    if (content.every(part => part.type !== 'image')) {
      return content.map(part => part.type === 'text'
        ? { type: 'text', text: part.text }
        : { type: 'file', attachment: part.attachment })
    }
    const refs = await admitEncodedImages(this, content.filter(part => part.type === 'image'))
    let next = 0
    return content.map((part) => {
      if (part.type === 'text') return { type: 'text', text: part.text }
      if (part.type === 'file') return { type: 'file', attachment: part.attachment }
      return { type: 'image', attachment: refs[next++] as ImageAttachmentRef }
    })
  }

  /**
   * 解码并持久化提交一个规范 base64 文件上传。
   * @param input - 规范 base64 字节和可选显示名。
   * @returns 持久化的按内容寻址文件引用。
   * @throws AttachmentError 当编码或存储操作被拒绝时。
   */
  admitEncodedFile(input: EncodedFileAttachment): Promise<FileAttachmentRef> {
    return admitFileInput(this, input)
  }

  /**
   * 按稳定代码识别此附件能力发出的失败。
   * @param error - 从附件操作中捕获的值。
   * @returns 该值是否为附件失败。
   */
  isAttachmentError(error: unknown): error is AttachmentError {
    return matchesAttachmentError(error)
  }

  /**
   * 在其所属 session 事件被追加之前校验并持久化提交一张图像。
   * 返回的引用描述已持久化的规范化图像。当规范化
   * 缩小了光栅时，其 `originalDimensions` 记录
   * 应用方向后的输入尺寸。
   * @param input - 编码字节、声明的媒体类型和可选显示名。
   * @returns 持久化的按内容寻址规范化图像引用。
   */
  abstract saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef>

  /**
   * 读取一张图像并校验字节仍与记录的引用相符。
   * @param ref - 来自 session 日志的持久化引用。
   * @param signal - 可选取消信号，用于后端读取与校验工作。
   * @returns 已校验的字节和规范化附件引用。
   * @throws 中止时为 signal 原因，校验失败时为存储错误。
   */
  abstract readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment>

  /**
   * 在 harness 主机文件系统中定位提供方拥有的规范化对象。
   * @param ref - 持久化规范化附件引用。
   * @returns 绝对主机路径；此后端不基于主机文件时为 undefined。
   * @throws AttachmentError 当持久化引用无效时。
   */
  imageHostPath(ref: ImageAttachmentRef): string | undefined {
    void ref
    return undefined
  }

  /**
   * 在其所属 session 事件被追加之前，逐字节持久化提交一个文件。
   * 文件没有准入限制：接受任何字节内容和长度，
   * 存储对象就是精确提交的字节。没有原样文件存储的
   * 后端保留此默认拒绝。
   * @param input - 精确字节和可选显示名。
   * @returns 持久化的按内容寻址文件引用。
   */
  saveFile(input: SaveFileAttachment): Promise<FileAttachmentRef> {
    void input
    return Promise.reject(new AttachmentError(
      'The mounted attachment provider cannot store verbatim files.',
      'ATTACHMENT_FILES_UNSUPPORTED',
    ))
  }

  /**
   * 从有界字节块逐字节持久化提交一个文件。提供方必须
   * 施加背压，且不得在内存中收集完整文件。
   * 没有流式原样存储的后端保留此默认拒绝。
   * @param input - 有序的精确字节、可选取消信号和显示名。
   * @returns 持久化的按内容寻址文件引用。
   */
  saveFileStream(input: SaveFileStreamAttachment): Promise<FileAttachmentRef> {
    void input
    return Promise.reject(new AttachmentError(
      'The mounted attachment provider cannot stream verbatim files.',
      'ATTACHMENT_FILES_UNSUPPORTED',
    ))
  }

  /**
   * 以有界字节块读取并校验一个原样存储的文件。提供方不得
   * 在内存中收集完整文件。没有原样文件读取的
   * 后端保留此默认拒绝。
   * @param ref - 来自 session 日志的持久化引用。
   * @param signal - 可选取消信号，用于后端读取与校验工作。
   * @returns 按序的确切文件字节；完整性失败会拒绝该迭代。
   */
  async *readFileStream(
    ref: FileAttachmentRef,
    signal?: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    signal?.throwIfAborted()
    void ref
    await Promise.reject(new AttachmentError(
      'The mounted attachment provider cannot read verbatim files.',
      'ATTACHMENT_FILES_UNSUPPORTED',
    ))
  }

  /**
   * 在 harness 主机文件系统中定位原样存储的文件对象。
   * @param ref - 持久化文件引用。
   * @returns 绝对主机路径；此后端不基于主机文件时为 undefined。
   * @throws AttachmentError 当持久化引用无效时。
   */
  fileHostPath(ref: FileAttachmentRef): string | undefined {
    void ref
    return undefined
  }

  /**
   * 从已存储的规范化图像生成或读取一个确定性模型请求版本。
   * @param ref - 持久化的与提供方无关的规范化附件引用。
   * @param target - 路由选定的尺寸与字节目标；字节目标无法满足时产生质量阶梯中最小的输出。
   * @param signal - 可选取消信号。
   * @returns 请求字节以及覆盖每个变换输入的缓存/上传标识。
   */
  readImageRequest(
    ref: ImageAttachmentRef,
    target: ImageRequestTarget,
    signal?: AbortSignal,
  ): Promise<RequestImageAttachment> {
    signal?.throwIfAborted()
    void ref
    void target
    return Promise.reject(new AttachmentError(
      'The mounted attachment provider cannot derive model-request images.',
      'ATTACHMENT_PROJECTION_UNSUPPORTED',
    ))
  }

}

export default AttachmentStore
