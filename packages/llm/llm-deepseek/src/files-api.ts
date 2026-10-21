/** DeepSeek Files API 传输。 @module dsh-llm-deepseek/files-api */

import { attributionHeaders, LlmError } from '@deepseek-ai/dsh-llm'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { DeepSeekFileId } from './file-id.ts'
import type { DeepSeekFileId as DeepSeekFileIdType } from './file-id.ts'
import { messagesApiRoot, MESSAGES_FILES_BETA } from './messages-api.ts'

/** 提供方支持的最短文件生命周期。 */
export const MIN_FILE_EXPIRY_SECONDS = 3_600
/** 提供方支持的最长文件生命周期。 */
export const MAX_FILE_EXPIRY_SECONDS = 2_592_000
/** Files API 上传大小上限。 */
export const MAX_FILE_UPLOAD_BYTES = 128 * 1024 * 1024
/** 当前的按密钥文件数量配额。 */
export const MAX_STORED_FILE_COUNT = 10_000
/** 当前的按密钥存储配额。 */
export const MAX_STORED_FILE_BYTES = 25 * 1024 * 1024 * 1024

/** 已校验的提供方文件元数据。 */
export interface DeepSeekFileObject {
  id: DeepSeekFileIdType
  bytes: number
  createdAt: number
  filename: string
  /** 上传时的复用截止时刻；列举与取回响应会省略该字段。 */
  expiresAt?: number
}

/** `GET /files` 返回的一页结果。 */
export interface DeepSeekFilePage {
  data: DeepSeekFileObject[]
  firstId?: DeepSeekFileIdType
  lastId?: DeepSeekFileIdType
  hasMore: boolean
}

/** Files API 操作失败，保留其 HTTP 状态码以供恢复策略使用。 */
export class DeepSeekFilesError extends LlmError {
  /** 已解析的提供方细节，仅用于错误分类。 */
  readonly detail: string

  /**
   * @param message - 面向用户的提供方失败信息。
   * @param status - Files API 返回的 HTTP 状态码。
   * @param detail - 为分类而拼接起来的提供方错误字段。
   */
  constructor(message: string, status: number, detail: string) {
    super(message, status === 401 || status === 403
      ? 'AUTH'
      : status === 429
        ? 'RATE_LIMIT'
        : status >= 500
          ? 'SERVER'
          : 'FILES_API', { status })
    this.name = 'DeepSeekFilesError'
    this.detail = detail
  }
}

/**
 * 一次上传失败是否报告了提供方的存储或文件数量配额。
 * @param error - Files API 操作失败。
 * @returns 一次有界的远程清理与上传重试是否可能恢复。
 */
export function isFilesQuotaError(error: unknown): error is DeepSeekFilesError {
  return error instanceof DeepSeekFilesError
    && /(?:quota|storage|stored files|file count|too many files)/iu.test(error.detail)
}

interface FilesApiOptions {
  baseURL: string
  /** 由提供方为该端点解析出的认证头。 */
  headers: Readonly<Record<string, string>>
  fetch?: typeof fetch
}

function invalidResponse(operation: string): LlmError {
  return new LlmError(`DeepSeek Files API returned an invalid ${operation} response.`, 'INVALID_RESPONSE')
}

/** 解码成功的 Files JSON 并带上操作上下文；响应体传输与中止失败保持其原有身份。 */
async function responseJson(response: Response, operation: string): Promise<unknown> {
  try {
    return await response.json()
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) throw error
    throw new LlmError(`DeepSeek Files API returned invalid JSON for ${operation} (HTTP ${response.status}).`, 'INVALID_RESPONSE', {
      status: response.status,
      cause: error,
    })
  }
}

function parseFileObject(value: unknown, operation: string): DeepSeekFileObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse(operation)
  const wire = value as Record<string, unknown>
  const createdAt = typeof wire.created_at === 'string' ? Math.floor(Date.parse(wire.created_at) / 1_000) : NaN
  if (typeof wire.id !== 'string' || wire.id.length === 0
    || wire.type !== 'file'
    || typeof wire.mime_type !== 'string'
    || typeof wire.size_bytes !== 'number' || !Number.isSafeInteger(wire.size_bytes) || wire.size_bytes < 0
    || !Number.isSafeInteger(createdAt) || createdAt < 0
    || typeof wire.filename !== 'string' || wire.filename.length === 0
  ) {
    throw invalidResponse(operation)
  }
  return {
    id: DeepSeekFileId(wire.id),
    bytes: wire.size_bytes,
    createdAt,
    filename: wire.filename,
  }
}

function providerErrorDetail(value: unknown): { message?: string; detail: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { detail: '' }
  const error = (value as { error?: unknown }).error
  if (error === null || typeof error !== 'object' || Array.isArray(error)) return { detail: '' }
  const fields = error as { message?: unknown; type?: unknown; code?: unknown }
  const message = typeof fields.message === 'string' ? fields.message : undefined
  return {
    ...message === undefined ? {} : { message },
    detail: [fields.code, fields.type, fields.message]
      .filter((field): field is string => typeof field === 'string')
      .join(' '),
  }
}

/** 直接的 Files 客户端：保留已配置的 URL 根路径，并在凭据可能离开其源之前拒绝重定向。 */
export class DeepSeekFilesClient {
  private readonly baseURL: string
  private readonly authHeaders: Readonly<Record<string, string>>
  private readonly fetchImpl: typeof fetch

  /**
   * @param options - 端点、认证头，以及可选的测试传输。
   */
  constructor(options: FilesApiOptions) {
    this.authHeaders = options.headers
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.baseURL = messagesApiRoot(options.baseURL)
  }

  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    let response: Response
    try {
      const headers = new Headers(attributionHeaders())
      for (const [name, value] of Object.entries(this.authHeaders)) headers.set(name, value)
      headers.set('anthropic-version', '2023-06-01')
      headers.set('anthropic-beta', MESSAGES_FILES_BETA)
      response = await this.fetchImpl(`${this.baseURL}${path}`, {
        ...init,
        redirect: 'error',
        headers,
        ...signal === undefined ? {} : { signal },
      })
    } catch (error: unknown) {
      if (signal?.aborted) throw error
      throw new LlmError(`DeepSeek Files API request to ${this.baseURL} failed`, 'TRANSPORT', { cause: error })
    }
    if (response.ok) return response
    let parsed: unknown
    try {
      parsed = await response.json()
    } catch {
      // 仅凭状态码就足以报告这次提供方失败。
    }
    const { message, detail } = providerErrorDetail(parsed)
    throw new DeepSeekFilesError(
      message ?? `DeepSeek Files API error (HTTP ${response.status})`,
      response.status,
      detail,
    )
  }

  /**
   * 上传一张带有显式过期时间的图像。
   * @param input - 确定性的请求版本字节、媒体类型、文件名、生命周期与取消信号。
   * @returns 已校验的文件与复用截止时刻。Messages 会省略过期元数据；
   *   它的截止时刻用上传创建时间加上所请求的生命周期。
   */
  async upload(input: {
    data: Uint8Array
    mediaType: ImageMediaType
    filename: string
    expiresAfterSeconds: number
    signal?: AbortSignal
  }): Promise<DeepSeekFileObject & { expiresAt: number }> {
    if (input.data.byteLength > MAX_FILE_UPLOAD_BYTES) {
      throw new LlmError('DeepSeek Files API upload exceeds 128 MiB.', 'INVALID_REQUEST')
    }
    if (!Number.isSafeInteger(input.expiresAfterSeconds)
      || input.expiresAfterSeconds < MIN_FILE_EXPIRY_SECONDS
      || input.expiresAfterSeconds > MAX_FILE_EXPIRY_SECONDS) {
      throw new LlmError('DeepSeek file expiry must be between 3600 and 2592000 seconds.', 'INVALID_REQUEST')
    }
    const form = new FormData()
    form.set('expires_after[anchor]', 'created_at')
    form.set('expires_after[seconds]', String(input.expiresAfterSeconds))
    form.set('file', new Blob([Uint8Array.from(input.data).buffer], { type: input.mediaType }), input.filename)
    const response = await this.request('/files', { method: 'POST', body: form }, input.signal)
    const file = parseFileObject(await responseJson(response, 'upload'), 'upload')
    return { ...file, expiresAt: file.createdAt + input.expiresAfterSeconds }
  }

  /**
   * 列举按提供方排序的一页文件。
   * @param options - 分页与取消。
   * @returns 已校验的页，其中空的游标被省略。
   */
  async list(options: {
    after?: DeepSeekFileIdType
    limit?: number
    signal?: AbortSignal
  } = {}): Promise<DeepSeekFilePage> {
    const query = new URLSearchParams()
    if (options.after !== undefined) query.set('after_id', options.after)
    if (options.limit !== undefined) query.set('limit', String(options.limit))
    const response = await this.request(`/files?${query.toString()}`, { method: 'GET' }, options.signal)
    const value: unknown = await responseJson(response, 'list')
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse('list')
    const wire = value as { data?: unknown; first_id?: unknown; last_id?: unknown; has_more?: unknown }
    const firstId = wire.first_id ?? undefined
    const lastId = wire.last_id ?? undefined
    if (!Array.isArray(wire.data) || typeof wire.has_more !== 'boolean'
      || (firstId !== undefined && typeof firstId !== 'string')
      || (lastId !== undefined && typeof lastId !== 'string')) {
      throw invalidResponse('list')
    }
    return {
      data: wire.data.map(item => parseFileObject(item, 'list')),
      ...typeof firstId === 'string' ? { firstId: DeepSeekFileId(firstId) } : {},
      ...typeof lastId === 'string' ? { lastId: DeepSeekFileId(lastId) } : {},
      hasMore: wire.has_more,
    }
  }

  /**
   * 取回一个文件对象。
   * @param fileId - 提供方文件标识符。
   * @param signal - 请求取消信号。
   * @returns 已校验的文件对象。
   */
  async retrieve(fileId: DeepSeekFileIdType, signal?: AbortSignal): Promise<DeepSeekFileObject> {
    const response = await this.request(`/files/${encodeURIComponent(fileId)}`, { method: 'GET' }, signal)
    return parseFileObject(await responseJson(response, 'retrieve'), 'retrieve')
  }

  /**
   * 删除一个提供方文件。
   * @param fileId - 提供方文件标识符。
   * @param signal - 请求取消信号。
   */
  async delete(fileId: DeepSeekFileIdType, signal?: AbortSignal): Promise<void> {
    const response = await this.request(`/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' }, signal)
    const value: unknown = await responseJson(response, 'delete')
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse('delete')
    const wire = value as { id?: unknown; type?: unknown }
    if (wire.id !== fileId || wire.type !== 'file_deleted') throw invalidResponse('delete')
  }
}
