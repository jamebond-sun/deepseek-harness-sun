/** 以 `DSH_HOME` 为根的本地持久附件后端。@module @deepseek-ai/dsh-attachment-local */

import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type {
  FileAttachmentRef,
  ImageAttachmentLimits,
  ImageAttachmentRef,
  ImageRequestTarget,
  RequestImageAttachment,
  SaveFileAttachment,
  SaveFileStreamAttachment,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { dshCachePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { NormalizationPolicy } from './normalization.ts'
import { CompressionLimiter, compressionFailure } from './compression-limiter.ts'
import { commitPreparedImageFile, normalizedImagePath, prepareImageFile, readImageFile, validateImageFile } from './store.ts'
import {
  readFileStreamVerbatim, saveFileStreamVerbatim, saveFileVerbatim, storedFilePath,
} from './file-store.ts'
import { readRequestImageFile, requestImageVariantId } from './request-image.ts'

export { canPassThroughNormalization, normalizeImage } from './normalization.ts'
export type { NormalizedImage, NormalizationPolicy } from './normalization.ts'
export { commitPreparedImageFile, prepareImageFile, readImageFile, saveImageFile, validateImageFile } from './store.ts'
export type { PreparedImageFile } from './store.ts'
export { readRequestImageFile, requestImageVariantId } from './request-image.ts'

/** 单张提交图像的默认最大编码字节数；超限的源会被拒绝，而不是缩小。 */
export const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024
/** 单个提示中的默认最大图像数量。 */
export const DEFAULT_MAX_IMAGES_PER_MESSAGE = 20
/** 单个提示中的默认最大图像字节总量。 */
export const DEFAULT_MAX_MESSAGE_IMAGE_BYTES = 200 * 1024 * 1024
/** 单张提交图像的默认最大固有像素数。 */
export const DEFAULT_MAX_IMAGE_PIXELS = 64_000_000
/** 单张提交图像的默认单边像素上限。 */
export const DEFAULT_MAX_IMAGE_DIMENSION = 8192
/**
 * 存储归一化图像的默认总像素预算。更大的源会被准入并按比例缩小，
 * 因此准入限制了每次后续模型请求所携带的内容，而无需拒绝普通的大图；
 * 极端宽高比保留其短边分辨率，而不是在长边规则下坍缩。
 */
export const DEFAULT_NORMALIZED_IMAGE_MAX_PIXELS = 2048 * 2048
/** 存储归一化图像的默认长边上限，在总像素预算之后应用。 */
export const DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION = 8192
/** 单个存储归一化图像的默认编码字节目标。 */
export const DEFAULT_NORMALIZED_IMAGE_MAX_BYTES = 4 * 1024 * 1024
/** 每个存储默认同时进行的原生图像变换数的保守值。 */
export const DEFAULT_IMAGE_COMPRESSION_CONCURRENCY = 2
/** 每个存储可配置的最大原生图像变换数。 */
export const MAX_IMAGE_COMPRESSION_CONCURRENCY = 8

/** 本地附件后端配置。 */
export interface Config {
  /** 显式的 harness 主目录；省略时依次遵循 `DSH_HOME` 与 `~/.dsh`。 */
  dshHome?: string
  /** 单张提交图像接受的最大编码字节数。默认：20 MiB。 */
  maxImageBytes?: number
  /** 单条提交消息接受的最大图像数量。默认：20。 */
  maxImagesPerMessage?: number
  /** 单条提交消息接受的最大图像编码字节总量。默认：200 MiB。 */
  maxMessageImageBytes?: number
  /** 单张提交图像接受的最大固有宽度乘高度。默认：64,000,000。 */
  maxImagePixels?: number
  /** 单张提交图像接受的最大固有宽度与最大固有高度。默认：8192px。 */
  maxImageDimension?: number
  /** 存储的与提供方无关的归一化图像的总像素预算。 */
  normalizedImageMaxPixels?: number
  /** 存储的与提供方无关的归一化图像的长边像素上限，在总像素预算之后应用。 */
  normalizedImageMaxDimension?: number
  /**
   * 存储的与提供方无关的归一化图像的编码字节目标；
   * 没有质量档符合时保留质量阶梯的最小输出。
   */
  normalizedImageMaxBytes?: number
  /** 本服务实例中同时进行的归一化或请求图像变换的最大数量。 */
  imageCompressionConcurrency?: number
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error
    ? reason
    : new Error('Attachment request cancelled with a non-Error reason.', { cause: reason })
}

class SharedRequest<T> {
  readonly controller = new AbortController()
  readonly promise: Promise<T>
  private settled = false
  private waiters = 0

  constructor(start: (signal: AbortSignal) => Promise<T>) {
    this.promise = start(this.controller.signal).finally(() => {
      this.settled = true
    })
  }

  wait(signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    this.waiters += 1
    if (signal === undefined) {
      return this.promise.finally(() => {
        this.release(false)
      })
    }
    let released = false
    const release = (cancelled: boolean): void => {
      if (released) return
      released = true
      this.release(cancelled, signal)
    }
    return new Promise<T>((resolve, reject) => {
      const abort = (): void => {
        release(true)
        reject(abortReason(signal))
      }
      signal.addEventListener('abort', abort, { once: true })
      void this.promise.then((value) => {
        signal.removeEventListener('abort', abort)
        release(false)
        resolve(value)
      }, (error: unknown) => {
        signal.removeEventListener('abort', abort)
        release(false)
        reject(compressionFailure(error))
      })
    })
  }

  private release(cancelled: boolean, signal?: AbortSignal): void {
    this.waiters -= 1
    if (cancelled && this.waiters === 0 && !this.settled && signal !== undefined) {
      this.controller.abort(abortReason(signal))
    }
  }
}

/** 持久的内容寻址本地附件存储。 */
export class LocalAttachmentStore extends AttachmentStore {
  static Config: z<Config> = z.object({
    dshHome: z.string(),
    maxImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGE_BYTES),
    maxImagesPerMessage: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGES_PER_MESSAGE),
    maxMessageImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_MESSAGE_IMAGE_BYTES),
    maxImagePixels: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGE_PIXELS),
    maxImageDimension: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGE_DIMENSION),
    normalizedImageMaxPixels: z.number().step(1).min(1).default(DEFAULT_NORMALIZED_IMAGE_MAX_PIXELS),
    normalizedImageMaxDimension: z.number().step(1).min(1).default(DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION),
    normalizedImageMaxBytes: z.number().step(1).min(1).default(DEFAULT_NORMALIZED_IMAGE_MAX_BYTES),
    imageCompressionConcurrency: z.number().step(1).min(1).max(MAX_IMAGE_COMPRESSION_CONCURRENCY)
      .default(DEFAULT_IMAGE_COMPRESSION_CONCURRENCY),
  })

  /** 绝对的版本化存储根目录。 */
  readonly root: string
  readonly imageLimits: ImageAttachmentLimits
  /** 已解析的与提供方无关的归一化策略。 */
  readonly normalizationPolicy: Readonly<NormalizationPolicy>
  /** 已解析的实例级压缩并发限制。 */
  readonly imageCompressionConcurrency: number
  private readonly cacheRoot: string
  private readonly compression: CompressionLimiter
  private readonly requestInflight = new Map<string, SharedRequest<RequestImageAttachment>>()

  constructor(ctx: Context, config: Config) {
    super(ctx)
    const dshHome = resolveDshHome(config.dshHome)
    this.root = join(dshHome, 'attachments', 'v1')
    this.cacheRoot = dshCachePath({ dshHome }, 'attachments')
    this.imageLimits = Object.freeze({
      maxImageBytes: config.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES,
      maxImagesPerMessage: config.maxImagesPerMessage ?? DEFAULT_MAX_IMAGES_PER_MESSAGE,
      maxMessageImageBytes: config.maxMessageImageBytes ?? DEFAULT_MAX_MESSAGE_IMAGE_BYTES,
      maxImagePixels: config.maxImagePixels ?? DEFAULT_MAX_IMAGE_PIXELS,
      maxImageDimension: config.maxImageDimension ?? DEFAULT_MAX_IMAGE_DIMENSION,
      mediaTypes: Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const),
    })
    this.normalizationPolicy = Object.freeze({
      maxPixels: config.normalizedImageMaxPixels ?? DEFAULT_NORMALIZED_IMAGE_MAX_PIXELS,
      maxDimension: config.normalizedImageMaxDimension ?? DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION,
      maxBytes: config.normalizedImageMaxBytes ?? DEFAULT_NORMALIZED_IMAGE_MAX_BYTES,
    })
    const compressionConcurrency = config.imageCompressionConcurrency ?? DEFAULT_IMAGE_COMPRESSION_CONCURRENCY
    if (!Number.isSafeInteger(compressionConcurrency)
      || compressionConcurrency < 1
      || compressionConcurrency > MAX_IMAGE_COMPRESSION_CONCURRENCY) {
      throw new Error(
        `attachment-local: imageCompressionConcurrency must be an integer from 1 through ${MAX_IMAGE_COMPRESSION_CONCURRENCY}`,
      )
    }
    this.imageCompressionConcurrency = compressionConcurrency
    this.compression = new CompressionLimiter(compressionConcurrency)
  }

  async validateImage(input: SaveImageAttachment): Promise<void> {
    await this.compression.run(() => validateImageFile(input, this.imageLimits, this.normalizationPolicy))
  }

  override async saveImages(inputs: readonly SaveImageAttachment[]): Promise<readonly ImageAttachmentRef[]> {
    this.validateImageBatch(inputs)
    const prepared = await Promise.all(inputs.map(input => this.compression.run(
      () => prepareImageFile(input, this.imageLimits, this.normalizationPolicy),
    )))
    const refs: ImageAttachmentRef[] = []
    for (const image of prepared) refs.push(await commitPreparedImageFile(this.root, image))
    return refs
  }

  async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    const prepared = await this.compression.run(
      () => prepareImageFile(input, this.imageLimits, this.normalizationPolicy),
    )
    return commitPreparedImageFile(this.root, prepared)
  }

  async readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment> {
    return readImageFile(this.root, ref, signal)
  }

  override imageHostPath(ref: ImageAttachmentRef): string {
    return normalizedImagePath(this.root, ref)
  }

  override async saveFile(input: SaveFileAttachment): Promise<FileAttachmentRef> {
    return saveFileVerbatim(this.root, input)
  }

  override async saveFileStream(input: SaveFileStreamAttachment): Promise<FileAttachmentRef> {
    return saveFileStreamVerbatim(this.root, input)
  }

  override readFileStream(ref: FileAttachmentRef, signal?: AbortSignal): AsyncIterable<Uint8Array> {
    return readFileStreamVerbatim(this.root, ref, signal)
  }

  override fileHostPath(ref: FileAttachmentRef): string {
    return storedFilePath(this.root, ref)
  }

  override async readImageRequest(
    ref: ImageAttachmentRef,
    target: ImageRequestTarget,
    signal?: AbortSignal,
  ): Promise<RequestImageAttachment> {
    return this.requestVersion(ref, target, undefined, signal)
  }

  private requestVersion(
    ref: ImageAttachmentRef,
    target: ImageRequestTarget,
    stored: StoredImageAttachment | undefined,
    signal: AbortSignal | undefined,
  ): Promise<RequestImageAttachment> {
    signal?.throwIfAborted()
    const variantId = requestImageVariantId(ref, target)
    const key = String(variantId)
    let operation = this.requestInflight.get(key)
    if (operation?.controller.signal.aborted) {
      this.requestInflight.delete(key)
      operation = undefined
    }
    if (operation === undefined) {
      const shared = new SharedRequest<RequestImageAttachment>(sharedSignal => this.compression.run(async () => {
        const request = await readRequestImageFile(
          this.cacheRoot,
          stored ?? await this.readImage(ref, sharedSignal),
          target,
          sharedSignal,
        )
        return request
      }))
      operation = shared
      this.requestInflight.set(key, shared)
      void shared.promise.finally(() => {
        if (this.requestInflight.get(key) === shared) this.requestInflight.delete(key)
      }).catch(() => {})
    }
    return operation.wait(signal)
  }

}

export default LocalAttachmentStore
