/** 持久化的 DeepSeek 附件到文件 id 索引。 @module dsh-llm-deepseek/upload-index */

import { createHash } from 'node:crypto'
import { readFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentId, ImageVariantId as ImageVariantIdType } from '@deepseek-ai/dsh-attachment'
import { DeepSeekFileId, DeepSeekFileScope } from './file-id.ts'
import type { DeepSeekFileId as DeepSeekFileIdType, DeepSeekFileScope as DeepSeekFileScopeType } from './file-id.ts'

/** 一条持久化的远端上传映射。Unix 时间以毫秒计。 */
export interface DeepSeekUploadRecord {
  scope: DeepSeekFileScopeType
  /** 与提供方无关的、已规范化的附件；上传所用的请求版本由它派生而来。 */
  attachmentId: AttachmentId
  /** 完整的请求转换身份，包含路由预算与编码器参数。 */
  variantId: ImageVariantIdType
  fileId: DeepSeekFileIdType
  bytes: number
  createdAt: number
  expiresAt: number
}

interface StoredIndex {
  formatVersion: 3
  records: DeepSeekUploadRecord[]
}

class InvalidUploadIndexError extends Error {}

/** 当另一个进程已经发布了一次可复用的上传时，一次候选提交的结果。 */
export interface UploadIndexCommit {
  record: DeepSeekUploadRecord
  accepted: boolean
}

/**
 * 派生一个非机密的、稳定的索引命名空间，且不持久化或记录认证头。
 * @param baseURL - 已规范化的提供方端点命名空间。
 * @param credentials - 仅作为哈希输入使用的、已序列化的认证头。
 * @returns 带品牌标记的 SHA-256 命名空间摘要。
 */
export function deepSeekFileScope(baseURL: string, credentials: string): DeepSeekFileScopeType {
  const digest = createHash('sha256')
    .update(baseURL.replace(/\/+$/u, ''))
    .update('\0')
    .update(credentials)
    .digest('hex')
  return DeepSeekFileScope(digest)
}

function absent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

function parseRecord(value: unknown): DeepSeekUploadRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidUploadIndexError('llm-deepseek: upload index contains a non-object record')
  }
  const record = value as Record<string, unknown>
  if (typeof record.scope !== 'string' || !/^[0-9a-f]{64}$/u.test(record.scope)
    || typeof record.attachmentId !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(record.attachmentId)
    || typeof record.variantId !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(record.variantId)
    || typeof record.fileId !== 'string' || record.fileId.length === 0
    || !Number.isSafeInteger(record.bytes) || (record.bytes as number) < 0
    || !Number.isSafeInteger(record.createdAt) || (record.createdAt as number) < 0
    || !Number.isSafeInteger(record.expiresAt) || (record.expiresAt as number) < 0) {
    throw new InvalidUploadIndexError('llm-deepseek: upload index contains an invalid record')
  }
  return {
    scope: DeepSeekFileScope(record.scope),
    attachmentId: record.attachmentId as AttachmentId,
    variantId: ImageVariantId(record.variantId),
    fileId: DeepSeekFileId(record.fileId),
    bytes: record.bytes as number,
    createdAt: record.createdAt as number,
    expiresAt: record.expiresAt as number,
  }
}

function parseIndex(text: string): StoredIndex {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error: unknown) {
    throw new InvalidUploadIndexError('llm-deepseek: upload index is not valid JSON', { cause: error })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidUploadIndexError('llm-deepseek: upload index is not an object')
  }
  const index = value as { formatVersion?: unknown; records?: unknown }
  if (index.formatVersion !== 3 || !Array.isArray(index.records)) {
    throw new InvalidUploadIndexError('llm-deepseek: unsupported upload index format')
  }
  const records = index.records.map(parseRecord)
  const keys = new Set<string>()
  for (const record of records) {
    const key = `${record.scope}\0${record.variantId}`
    if (keys.has(key)) throw new InvalidUploadIndexError('llm-deepseek: upload index contains duplicate mappings')
    keys.add(key)
  }
  return { formatVersion: 3, records }
}

function reusable(record: DeepSeekUploadRecord, now: number, refreshMarginMs: number): boolean {
  return record.expiresAt - now > refreshMarginMs
}

/** 本 DSH 主目录中所有 DeepSeek 会话共享的原子本地索引。 */
export class DeepSeekUploadIndex {
  /** 属主私有的 JSON 索引绝对路径。 */
  readonly path: string

  /**
   * @param path - 显式的测试路径；省略时使用 `DSH_HOME/llm-deepseek/files-v3.json`。
   */
  constructor(path = join(resolveDshHome(), 'llm-deepseek', 'files-v3.json')) {
    this.path = path
  }

  private async load(): Promise<StoredIndex> {
    try {
      return parseIndex(await readFile(this.path, 'utf8'))
    } catch (error: unknown) {
      if (absent(error) || error instanceof InvalidUploadIndexError) {
        return { formatVersion: 3, records: [] }
      }
      throw error
    }
  }

  private async save(index: StoredIndex): Promise<void> {
    await writeFileAtomic(this.path, `${JSON.stringify(index, undefined, 2)}\n`, {
      mode: 0o600,
      dirMode: 0o700,
    })
  }

  /**
   * 读取一条可复用的映射。
   * @param scope - 端点/API 密钥命名空间。
   * @param variantId - 完整的请求图像转换身份。
   * @param now - 当前 Unix 时间，以毫秒计。
   * @param refreshMarginMs - 剩余生命周期低于该值时不再复用。
   * @returns 当剩余生命周期足够时返回该映射。
   */
  async get(
    scope: DeepSeekFileScopeType,
    variantId: ImageVariantIdType,
    now: number,
    refreshMarginMs: number,
  ): Promise<DeepSeekUploadRecord | undefined> {
    const record = (await this.load()).records.find(candidate => (
      candidate.scope === scope && candidate.variantId === variantId
    ))
    return record !== undefined && reusable(record, now, refreshMarginMs) ? record : undefined
  }

  /**
   * 发布一次已完成的上传，除非另一个进程已经发布了一条可复用的映射。
   * @param candidate - 已完成的远端上传。
   * @param now - 当前 Unix 时间，以毫秒计。
   * @param refreshMarginMs - 可复用的最小剩余生命周期。
   * @returns 胜出的记录，以及该候选是否进入了索引。
   */
  async commit(
    candidate: DeepSeekUploadRecord,
    now: number,
    refreshMarginMs: number,
  ): Promise<UploadIndexCommit> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    return withFileLock(this.path, async () => {
      const index = await this.load()
      const existing = index.records.find(record => (
        record.scope === candidate.scope
        && record.variantId === candidate.variantId
        && reusable(record, now, refreshMarginMs)
      ))
      if (existing !== undefined) return { record: existing, accepted: false }
      const records = index.records.filter(record => (
        reusable(record, now, refreshMarginMs)
        && !(record.scope === candidate.scope && record.variantId === candidate.variantId)
      ))
      records.push(candidate)
      await this.save({ formatVersion: 3, records })
      return { record: candidate, accepted: true }
    })
  }

  /**
   * 在一次加锁重写中移除精确的映射，且不删除并发安装的后继映射。
   * @param scope - 端点/API 密钥命名空间。
   * @param generations - 正在失效的精确远端版本；索引中不存在的配对会被忽略。
   */
  async remove(
    scope: DeepSeekFileScopeType,
    generations: readonly Pick<DeepSeekUploadRecord, 'variantId' | 'fileId'>[],
  ): Promise<void> {
    const invalidated = new Set(generations.map(generation => `${generation.variantId}\0${generation.fileId}`))
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    await withFileLock(this.path, async () => {
      const index = await this.load()
      const records = index.records.filter(record => !(
        record.scope === scope && invalidated.has(`${record.variantId}\0${record.fileId}`)
      ))
      if (records.length !== index.records.length) await this.save({ formatVersion: 3, records })
    })
  }

  /**
   * 移除某个远端命名空间的全部本地映射。
   * @param scope - 端点/API 密钥命名空间。
   */
  async clear(scope: DeepSeekFileScopeType): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    await withFileLock(this.path, async () => {
      const index = await this.load()
      const records = index.records.filter(record => record.scope !== scope)
      if (records.length !== index.records.length) await this.save({ formatVersion: 3, records })
    })
  }
}
