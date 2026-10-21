/** DeepSeek Files API 的上传复用、失效与配额恢复。 @module dsh-llm-deepseek/file-store */

import type { RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { DeepSeekFilesClient, isFilesQuotaError } from './files-api.ts'
import type { DeepSeekFileId } from './file-id.ts'
import { messagesApiRoot } from './messages-api.ts'
import { deepSeekFileScope, DeepSeekUploadIndex } from './upload-index.ts'
import type { DeepSeekUploadRecord } from './upload-index.ts'

/** 每张请求图像（含文件 id 引用）共享的 Files 存储上限。 */
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024
const OWNED_FILE_PREFIX = 'dsh-'

/** 由插件配置解析出的 Files 存储策略。 */
export interface DeepSeekFilePolicy {
  expiresAfterSeconds: number
  refreshMarginSeconds: number
  quotaCleanupBatch: number
}

/** 文件操作所需的连接事实。 */
export interface DeepSeekFileConnection {
  baseURL: string
  /** 由提供方为该端点解析出的认证头。 */
  headers: Readonly<Record<string, string>>
}

/** 一次文件 id 解析的结果。 */
export interface DeepSeekFileReference {
  record: DeepSeekUploadRecord
  uploaded: boolean
}

interface FileStoreOptions {
  index?: DeepSeekUploadIndex
  now?: () => number
  fetch?: typeof fetch
}

interface SharedUpload {
  controller: AbortController
  promise: Promise<DeepSeekFileReference>
  settled: boolean
  waiters: number
}

/** Files 资源的父 URL 标识了上传命名空间。 */
function fileScope(connection: DeepSeekFileConnection) {
  return deepSeekFileScope(
    messagesApiRoot(connection.baseURL),
    JSON.stringify(Object.entries(connection.headers).sort(([left], [right]) => left.localeCompare(right))),
  )
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error
    ? reason
    : new Error('DeepSeek file upload cancelled with a non-Error reason.', { cause: reason })
}

function uploadFailure(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error('DeepSeek file upload failed with a non-Error reason.', { cause: error })
}

function waitForUpload(operation: SharedUpload, signal: AbortSignal | undefined): Promise<DeepSeekFileReference> {
  signal?.throwIfAborted()
  operation.waiters += 1
  let released = false
  const release = (cancelledReason?: Error): void => {
    if (released) return
    released = true
    operation.waiters -= 1
    if (cancelledReason !== undefined && operation.waiters === 0 && !operation.settled) {
      operation.controller.abort(cancelledReason)
    }
  }
  if (signal === undefined) {
    return operation.promise.finally(() => {
      release()
    })
  }
  return new Promise<DeepSeekFileReference>((resolve, reject) => {
    const abort = (): void => {
      const reason = abortReason(signal)
      release(reason)
      reject(reason)
    }
    signal.addEventListener('abort', abort, { once: true })
    void operation.promise.then((value) => {
      signal.removeEventListener('abort', abort)
      release()
      resolve(value)
    }, (error: unknown) => {
      signal.removeEventListener('abort', abort)
      release()
      reject(uploadFailure(error))
    })
  })
}

function extension(mediaType: RequestImageAttachment['mediaType']): 'png' | 'jpeg' | 'webp' | 'gif' {
  switch (mediaType) {
    case 'image/png': return 'png'
    case 'image/jpeg': return 'jpeg'
    case 'image/webp': return 'webp'
    case 'image/gif': return 'gif'
  }
}

function filename(version: RequestImageAttachment): string {
  const attachment = String(version.attachment.attachmentId).slice('sha256:'.length, 'sha256:'.length + 16)
  const variant = String(version.variantId).slice('sha256:'.length, 'sha256:'.length + 8)
  return `${OWNED_FILE_PREFIX}${attachment}-${variant}.${extension(version.mediaType)}`
}

/** DeepSeek 路由上按用户范围隔离的、持久化的文件 id 复用。 */
export class DeepSeekFileStore {
  private readonly index: DeepSeekUploadIndex
  private readonly now: () => number
  private readonly fetchImpl: typeof fetch | undefined
  private readonly inflight = new Map<string, SharedUpload>()

  /**
   * @param options - 可测试的索引、时钟与传输边界。
   */
  constructor(options: FileStoreOptions = {}) {
    this.index = options.index ?? new DeepSeekUploadIndex()
    this.now = options.now ?? Date.now
    this.fetchImpl = options.fetch
  }

  private client(connection: DeepSeekFileConnection): DeepSeekFilesClient {
    return new DeepSeekFilesClient({
      baseURL: connection.baseURL,
      headers: connection.headers,
      ...this.fetchImpl === undefined ? {} : { fetch: this.fetchImpl },
    })
  }

  /**
   * 解析或上传一张确定性的请求图像。并发调用共享同一次上传，同时各自保留独立的等待。
   * @param version - 确定性的模型请求字节与完整的转换身份。
   * @param connection - 端点与 API 密钥快照。
   * @param policy - 过期与配额恢复策略。
   * @param signal - 本次等待的取消信号；当没有等待者时，共享传输会停止。
   * @returns 可复用的文件 id，以及本次调用是否发布了一次新的上传。
   */
  ensureUploaded(
    version: RequestImageAttachment,
    connection: DeepSeekFileConnection,
    policy: DeepSeekFilePolicy,
    signal?: AbortSignal,
  ): Promise<DeepSeekFileReference> {
    signal?.throwIfAborted()
    const scope = fileScope(connection)
    const key = `${scope}\0${version.variantId}`
    let active = this.inflight.get(key)
    if (active?.controller.signal.aborted) {
      this.inflight.delete(key)
      active = undefined
    }
    if (active !== undefined) return waitForUpload(active, signal)
    const controller = new AbortController()
    const shared: SharedUpload = {
      controller,
      settled: false,
      waiters: 0,
      promise: undefined as never,
    }
    shared.promise = this.ensureUploadedOnce(version, connection, policy, controller.signal).then((value) => {
      shared.settled = true
      return value
    }, (error: unknown) => {
      shared.settled = true
      throw uploadFailure(error)
    })
    this.inflight.set(key, shared)
    void shared.promise.finally(() => {
      if (this.inflight.get(key) === shared) this.inflight.delete(key)
    }).catch(() => {})
    return waitForUpload(shared, signal)
  }

  private async ensureUploadedOnce(
    version: RequestImageAttachment,
    connection: DeepSeekFileConnection,
    policy: DeepSeekFilePolicy,
    signal: AbortSignal,
  ): Promise<DeepSeekFileReference> {
    if (version.bytes > MAX_IMAGE_BYTES) {
      throw new LlmError('DeepSeek image exceeds the 32 MiB per-image limit.', 'INVALID_REQUEST')
    }
    const scope = fileScope(connection)
    const now = this.now()
    const marginMs = policy.refreshMarginSeconds * 1_000
    const cached = await this.index.get(scope, version.variantId, now, marginMs)
    if (cached !== undefined) return { record: cached, uploaded: false }

    const client = this.client(connection)
    const upload = async (): Promise<DeepSeekUploadRecord> => {
      const remote = await client.upload({
        data: version.data,
        mediaType: version.mediaType,
        filename: filename(version),
        expiresAfterSeconds: policy.expiresAfterSeconds,
        signal,
      })
      if (remote.bytes !== version.data.byteLength) {
        throw new LlmError('DeepSeek Files API upload response does not match the submitted image.', 'INVALID_RESPONSE')
      }
      return {
        scope,
        attachmentId: version.attachment.attachmentId,
        variantId: version.variantId,
        fileId: remote.id,
        bytes: remote.bytes,
        createdAt: remote.createdAt * 1_000,
        expiresAt: remote.expiresAt * 1_000,
      }
    }

    let candidate: DeepSeekUploadRecord
    try {
      candidate = await upload()
    } catch (error: unknown) {
      if (!isFilesQuotaError(error)) throw error
      const deleted = await this.reclaimOldestOwned(connection, policy.quotaCleanupBatch, signal)
      if (deleted === 0) throw error
      candidate = await upload()
    }
    const committed = await this.index.commit(candidate, this.now(), marginMs)
    if (!committed.accepted) {
      try {
        await client.delete(candidate.fileId, signal)
      } catch {
        // 胜出的映射是持久化的。一次失败的重复清理只影响配额，并会由恢复机制重试。
      }
    }
    return { record: committed.record, uploaded: committed.accepted }
  }

  /**
   * 在一次模型请求拒绝了它们的远端 id 之后，通过一次索引更新让精确的本地映射失效。
   * @param generations - 请求图像变体，以及每次请求为它所使用的精确文件 id。
   * @param connection - 端点与 API 密钥快照。
   */
  async invalidate(
    generations: readonly Pick<DeepSeekUploadRecord, 'variantId' | 'fileId'>[],
    connection: DeepSeekFileConnection,
  ): Promise<void> {
    await this.index.remove(fileScope(connection), generations)
  }

  /**
   * 删除某个附件在索引中的远端文件，并移除它的本地映射。
   * @param version - 要释放的精确请求图像版本。
   * @param connection - 端点与 API 密钥快照。
   * @param policy - 用于定位可复用映射的过期策略。
   * @param signal - 请求取消信号。
   * @returns 是否存在一个已索引的文件并被删除。
   */
  async release(
    version: RequestImageAttachment,
    connection: DeepSeekFileConnection,
    policy: DeepSeekFilePolicy,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const scope = fileScope(connection)
    const record = await this.index.get(
      scope,
      version.variantId,
      this.now(),
      policy.refreshMarginSeconds * 1_000,
    )
    if (record === undefined) return false
    await this.client(connection).delete(record.fileId, signal)
    await this.index.remove(scope, [{ variantId: version.variantId, fileId: record.fileId }])
    return true
  }

  /**
   * 删除名称能标识 harness 归属的、最早的提供方文件。
   * @param connection - 端点与 API 密钥快照。
   * @param count - 要删除的文件数量的正值上限。
   * @param signal - 请求取消信号。
   * @returns 成功删除的文件数量。
   */
  async reclaimOldestOwned(
    connection: DeepSeekFileConnection,
    count: number,
    signal?: AbortSignal,
  ): Promise<number> {
    const client = this.client(connection)
    let after: DeepSeekFileId | undefined
    const owned: { id: DeepSeekFileId; createdAt: number }[] = []
    while (true) {
      const page = await client.list({
        ...after === undefined ? {} : { after },
        limit: 1_000,
        ...signal === undefined ? {} : { signal },
      })
      for (const file of page.data) {
        if (!file.filename.startsWith(OWNED_FILE_PREFIX)) continue
        owned.push({ id: file.id, createdAt: file.createdAt })
      }
      // 该 API 不提供升序查询；跨所有分页保留最早的候选。
      owned.sort((left, right) => left.createdAt - right.createdAt)
      owned.splice(count)
      if (!page.hasMore || page.lastId === undefined || page.lastId === after) break
      after = page.lastId
    }
    for (const file of owned) await client.delete(file.id, signal)
    return owned.length
  }

  /**
   * 删除当前 API 密钥命名空间中所有由 harness 持有的远端文件，并清空其索引。
   * @param connection - 端点与 API 密钥快照。
   * @param signal - 请求取消信号。
   * @returns 已删除的文件数量。
   */
  async releaseAll(connection: DeepSeekFileConnection, signal?: AbortSignal): Promise<number> {
    let total = 0
    for (;;) {
      const deleted = await this.reclaimOldestOwned(connection, 1_000, signal)
      total += deleted
      if (deleted < 1_000) break
    }
    await this.index.clear(fileScope(connection))
    return total
  }
}
