/** 共享的 Files 解析、有界的过期 id 恢复，以及规范化图像的诊断。 */

import type { RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { deadline } from '@deepseek-ai/dsh-timeout'
import type { DeepSeekFileStore, DeepSeekFileConnection, DeepSeekFilePolicy } from './file-store.ts'
import type { DeepSeekFileId } from './file-id.ts'

/** 一次图像出现在请求的对话消息中的位置。 */
export interface ImageWireLocation {
  message: number
  image: number
}

/** 有资格触发请求级内联回退的一次文件上传失败。 */
export class FileResolutionFailure extends Error {
  constructor(cause: unknown) {
    super('DeepSeek Files API could not resolve a request image.', { cause })
    this.name = 'FileResolutionFailure'
  }
}

function providerRejectedNormalizedImage(detail: string): boolean {
  const reasonBeforeImage = /(?:unsupported|invalid|cannot read|failed to (?:decode|process)).{0,40}image/iu
  const imageBeforeReason = /image.{0,40}(?:unsupported|invalid|cannot be decoded)/iu
  return reasonBeforeImage.test(detail) || imageBeforeReason.test(detail)
}

interface UsedRequestFile {
  version: RequestImageAttachment
  fileId: DeepSeekFileId
  location: ImageWireLocation
}

function providerRejectedFileId(detail: string): boolean {
  const file = /\bfile(?:[_ -]?(?:id|api|not[_ -]?found|deleted|expired))?/iu.test(detail)
  const missing = /(?:expired|not[_ -]?found|deleted|do(?:es)? not exist|not created under (?:this|your) account)/iu.test(detail)
  const invalidId = /(?:invalid.{0,20}file[_ -]?(?:id|api)|file[_ -]?(?:id|api).{0,20}invalid)/iu.test(detail)
  return file && (missing || invalidId)
}

function detailNamesFileId(detail: string, fileId: DeepSeekFileId): boolean {
  let index = detail.indexOf(fileId)
  while (index >= 0) {
    const before = detail[index - 1]
    const after = detail[index + fileId.length]
    if ((before === undefined || !/[\p{L}\p{N}_-]/u.test(before))
      && (after === undefined || !/[\p{L}\p{N}_-]/u.test(after))) return true
    index = detail.indexOf(fileId, index + 1)
  }
  return false
}

function staleMappings(
  files: readonly UsedRequestFile[],
  detail: string,
): UsedRequestFile[] {
  const unique = [...new Map(files.map(file => [`${file.version.variantId}\0${file.fileId}`, file])).values()]
  const exact = unique.filter(file => detailNamesFileId(detail, file.fileId))
  return exact.length > 0 ? exact : unique
}

function normalizedImageFacts(
  file: { version: RequestImageAttachment; location: ImageWireLocation },
): string {
  const version = file.version
  const name = version.attachment.name ?? version.attachment.attachmentId
  const colour = version.hasAlpha ? 'sRGBA' : 'sRGB'
  return `"${name}" at message ${file.location.message}, image ${file.location.image} `
    + `(${version.mediaType}, 8-bit ${colour}, ${version.width}x${version.height})`
}

function normalizedImageDiagnostic(
  files: readonly UsedRequestFile[],
  providerMessage: string,
  providerDetail: string,
): string {
  const exact = files.find(file => detailNamesFileId(providerDetail, file.fileId))
  const target = exact ?? (files.length === 1 ? files[0] : undefined)
  if (target !== undefined) {
    return `DeepSeek rejected normalized image ${normalizedImageFacts(target)}: ${providerMessage}. `
      + 'The provider rejected bytes already normalized by the harness; PNG, JPEG, WebP, and GIF remain supported input formats.'
  }
  const candidates = [...new Map(files.map(file => [
    `${file.version.variantId}\0${file.location.message}\0${file.location.image}`,
    file,
  ])).values()]
  return `DeepSeek rejected a normalized request image: ${providerMessage}. Candidate images: `
    + `${candidates.map(normalizedImageFacts).join('; ')}. `
    + 'The provider rejected bytes already normalized by the harness; PNG, JPEG, WebP, and GIF remain supported input formats.'
}


/** 由一次模型请求持有的 Files 状态，其中最多包含一次过期 id 重试。 */
export class RequestFiles {
  private used: UsedRequestFile[] = []
  private retried = false

  constructor(
    private readonly files: DeepSeekFileStore,
    private readonly connection: DeepSeekFileConnection,
    private readonly policy: DeepSeekFilePolicy,
    private readonly timeoutMs: number,
    private readonly signal: AbortSignal,
    private readonly activity: () => void,
  ) {}

  /** 在序列化下一次 HTTP 尝试之前重置出现跟踪。 */
  beginAttempt(): void { this.used = [] }

  /**
   * 在其自身的上传截止时间之内解析一张被保留的图像。
   * @param version - 已准备好的请求图像。
   * @param location - 供提供方拒绝诊断使用的出现位置。
   * @returns 可复用的提供方 id。
   */
  async resolve(version: RequestImageAttachment, location: ImageWireLocation): Promise<DeepSeekFileId> {
    using limit = deadline(this.signal, this.timeoutMs, 'DEEPSEEK_FILES_API_TIMEOUT')
    let resolved: Awaited<ReturnType<DeepSeekFileStore['ensureUploaded']>>
    try {
      resolved = await this.files.ensureUploaded(version, this.connection, this.policy, limit.signal)
    } catch (error) {
      if (this.signal.aborted) throw error
      throw new FileResolutionFailure(error)
    }
    this.activity()
    this.used.push({ version, fileId: resolved.record.fileId, location })
    return resolved.record.fileId
  }

  /**
   * 在一次索引更新中让所有被拒绝的映射失效；只有首次过期 id 响应才允许再发一次请求。
   * @param detail - 用于过期 id 分类的提供方错误字段。
   * @returns 调用方是否应当重新序列化并再次分发。
   */
  async retry(detail: string): Promise<boolean> {
    if (this.used.length === 0 || !providerRejectedFileId(detail)) return false
    await this.files.invalidate(
      staleMappings(this.used, detail).map(file => ({ variantId: file.version.variantId, fileId: file.fileId })),
      this.connection,
    )
    if (this.retried) return false
    this.retried = true
    return true
  }

  /**
   * 把一次规范化图像拒绝归因到实际上传的图像出现。
   * @param status - 被拒绝请求的 HTTP 状态码。
   * @param message - 提供方的错误消息。
   * @param detail - 提供方错误分类字段。
   * @returns 图像诊断信息，或原始的提供方消息。
   */
  errorMessage(status: number, message: string, detail: string): string {
    return status === 400 && this.used.length > 0 && providerRejectedNormalizedImage(detail)
      ? normalizedImageDiagnostic(this.used, message, detail)
      : message
  }
}
