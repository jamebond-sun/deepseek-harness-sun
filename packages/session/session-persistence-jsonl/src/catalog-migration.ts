/** 收集历史发现事实，无需递归地准备相关的当前代际。 */

import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { historicalSessionFormatCatalog, sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { historicalChildCatalogSource } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { SessionFormatUnsupportedMigrationError } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { parseGenerationLogFilename } from './format.ts'
import type { JsonlCompression } from './format.ts'
import { JsonlGenerationSourceChangedError, readDecodedJsonlSource } from './generation.ts'
import type { JsonlPhysicalIdentity } from './generation.ts'

/** 每个父会话的补充事实，以及在提供或发布它们之前所需的源检查。 */
interface PreparedCatalogFacts {
  readonly facts: readonly SessionFormatJsonObject[]
  readonly failures: readonly { readonly path: string; readonly error: unknown }[]
  /** @returns 当每个被检查的子会话仍具有所捕获的物理修订时 resolve。 */
  validate(): Promise<void>
}

/**
 * 通过现有的历史编解码器收集每个相关子会话自身的描述符。
 * @param parentId - 其入站迁移会消费这些事实的父会话。
 * @param sources - 所选源语料中的、已按头部索引的直接子会话。
 * @param compression - 已配置的源编码方式。
 * @param signal - 贯穿每次源读取转发的取消信号。
 * @returns 紧凑的事实与子会话局部的失败；完整的子会话事件数组在提取后即被释放。
 */
export async function prepareCatalogFacts(
  parentId: SessionId,
  sources: readonly { readonly header: SessionHeader; readonly path: string }[],
  compression: JsonlCompression,
  signal: AbortSignal,
): Promise<PreparedCatalogFacts> {
  const facts: SessionFormatJsonObject[] = []
  const failures: { path: string; error: unknown }[] = []
  const witnesses: { path: string; identity: JsonlPhysicalIdentity }[] = []
  for (const source of sources) {
    signal.throwIfAborted()
    const version = parseGenerationLogFilename(basename(source.path), compression)
    if (version === undefined) throw new SessionFormatUnsupportedMigrationError(`unrecognized historical child generation ${source.path}`)
    const witness: { path: string; identity: JsonlPhysicalIdentity } = {
      path: source.path, identity: await stat(source.path, { bigint: true }),
    }
    witnesses.push(witness)
    const unavailable = { childId: source.header.id, childCreatedAt: source.header.createdAt,
      descriptorCount: 0, descriptor: null, sourcePath: source.path }
    let restored: Awaited<ReturnType<typeof readDecodedJsonlSource>>
    try {
      restored = await readDecodedJsonlSource(source.path, version, compression, {
        createRestore: header => (version <= 3 ? historicalSessionFormatCatalog : sessionFormatCatalog).createRestore(header, {
          recovery: 'recoverable', validation: 'current',
        }),
      }, signal)
    } catch (error: unknown) {
      signal.throwIfAborted()
      failures.push({ path: source.path, error })
      facts.push(unavailable)
      continue
    }
    witness.identity = restored.identity
    const header = restored.artifact.header
    if (header.id !== source.header.id || header.createdAt !== source.header.createdAt
      || header.parentSession !== parentId || header.origin !== 'subagent'
      || ['cwd', 'isSeeded', 'delegationDepth', 'agentPreset'].some(key => header[key] !== source.header[key as keyof SessionHeader])) {
      throw new JsonlGenerationSourceChangedError(source.path)
    }
    let fact: SessionFormatJsonObject
    try {
      fact = historicalChildCatalogSource(restored.artifact)
    } catch (error: unknown) {
      failures.push({ path: source.path, error })
      facts.push(unavailable)
      continue
    }
    facts.push({ ...fact, sourcePath: source.path })
  }
  return {
    facts,
    failures,
    async validate() {
      for (const witness of witnesses) {
        const current = await stat(witness.path, { bigint: true })
        if (current.dev !== witness.identity.dev || current.ino !== witness.identity.ino
          || current.size !== witness.identity.size || current.mtimeNs !== witness.identity.mtimeNs
          || current.ctimeNs !== witness.identity.ctimeNs) throw new JsonlGenerationSourceChangedError(witness.path)
      }
    },
  }
}
