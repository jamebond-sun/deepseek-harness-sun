import { createSessionFormatCatalog } from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatArtifact,
  SessionFormatCurrentEncoder,
  SessionFormatRecovery,
} from '@deepseek-ai/dsh-session-format'
import { releasedV0SessionFormatCodec, releasedV1SessionFormatCodec } from '../codec.ts'
import { sessionFormatV0ToV1 } from '../migration.ts'
import { assertReleasedV1Header } from '../validation.ts'
import {
  assertReleasedV1Artifact,
  assertReleasedV1MigrationSource,
} from './validation.ts'

const unusedEncoder: SessionFormatCurrentEncoder = {
  /* v8 ignore next -- 这个仅用于恢复的测试门面从不编码头部。 */
  encodeHeader: header => header,
  /* v8 ignore next -- 这个仅用于恢复的测试门面从不编码事件。 */
  encodeEvent: event => event,
}

const catalog = createSessionFormatCatalog({
  currentVersion: 1,
  codecs: [releasedV0SessionFormatCodec, releasedV1SessionFormatCodec],
  currentEncoder: unusedEncoder,
  migrations: [sessionFormatV0ToV1],
  restoreCurrent(artifact) {
    assertReleasedV1Artifact(artifact)
    return artifact
  },
  restoreTransformedCurrent(artifact) {
    assertReleasedV1MigrationSource(artifact)
    return artifact
  },
  /* v8 ignore next 3 -- 这个仅用于恢复的测试门面从不执行仅头部的读取。 */
  restoreCurrentHeader(header) {
    assertReleasedV1Header(header)
    return header
  },
})

function restore(
  header: unknown,
  rows: readonly unknown[],
  recovery: SessionFormatRecovery,
  validation: 'transformed' | 'current',
): SessionFormatArtifact {
  const current = catalog.createRestore(header, { recovery, validation })
  for (const row of rows) current.decodeRow(row)
  return current.finish()
}

/**
 * 通过生产解码器与 v0→v1 阶段恢复 released v0 行。
 * @param header - released v0 物理头部。
 * @param rows - released v0 物理行。
 * @param recovery - 严格或可恢复的行策略。
 * @returns 转换后的 released v1 制品。
 */
export function restoreV0ToV1(
  header: unknown,
  rows: readonly unknown[],
  recovery: SessionFormatRecovery = 'strict',
): SessionFormatArtifact {
  return restore(header, rows, recovery, 'transformed')
}

/**
 * 通过生产解码器与当前收集器恢复 released v1 行。
 * @param header - released v1 物理头部。
 * @param rows - released v1 物理行。
 * @param recovery - 严格或可恢复的行策略。
 * @returns 恢复得到的 released v1 制品。
 */
export function restoreV1(
  header: unknown,
  rows: readonly unknown[],
  recovery: SessionFormatRecovery = 'strict',
): SessionFormatArtifact {
  return restore(header, rows, recovery, 'current')
}
