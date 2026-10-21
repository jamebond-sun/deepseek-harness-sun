import type { SessionFormatArtifact } from '@deepseek-ai/dsh-session-format'
import { RELEASED_V0_EVENT_DISPOSITIONS } from '../dispositions.ts'
import { assertReleasedArtifactRelationships } from '../relationships.ts'
import {
  assertReleasedArtifactCoordinates,
  assertReleasedEventPayload,
  assertReleasedSessionFormatHeader,
} from '../validation.ts'

const RELEASED_V0_EVENT_TYPE_SET: ReadonlySet<string> = new Set(Object.keys(RELEASED_V0_EVENT_DISPOSITIONS))

/**
 * 在测试中校验一个已解码的 released-v0 源制品。
 * @param artifact - released-v0 源制品。
 */
export function assertReleasedV0SourceArtifact(artifact: SessionFormatArtifact): void {
  assertReleasedSessionFormatHeader(artifact.header, 0)
  assertReleasedArtifactCoordinates(artifact, true, RELEASED_V0_EVENT_TYPE_SET, false, true)
}

/**
 * 在测试中校验恒等头部提升之前的规范化 v0 输出。
 * @param artifact - 规范化后的 v0 制品。
 */
export function assertNormalizedReleasedV0Artifact(artifact: SessionFormatArtifact): void {
  assertReleasedSessionFormatHeader(artifact.header, 0)
  assertReleasedArtifactCoordinates(artifact, false, RELEASED_V0_EVENT_TYPE_SET, false, true)
  for (const event of artifact.events) assertReleasedEventPayload(event, 0)
  assertReleasedArtifactRelationships(artifact, { legacyInterruptedTurnRestart: true })
}

/**
 * 在测试中校验 v1→v2 迁移所接受的 v1 输入。
 * @param artifact - v1 迁移源制品。
 */
export function assertReleasedV1MigrationSource(artifact: SessionFormatArtifact): void {
  assertReleasedSessionFormatHeader(artifact.header, 1)
  assertReleasedArtifactCoordinates(artifact, false, RELEASED_V0_EVENT_TYPE_SET, false, true)
  for (const event of artifact.events) {
    if (RELEASED_V0_EVENT_DISPOSITIONS[event.type] !== undefined) assertReleasedEventPayload(event, 1)
  }
  assertReleasedArtifactRelationships(artifact, { legacyInterruptedTurnRestart: true })
}

/**
 * 在测试中校验精确的 released-v1 逻辑制品。
 * @param artifact - released-v1 逻辑制品。
 */
export function assertReleasedV1Artifact(artifact: SessionFormatArtifact): void {
  assertReleasedSessionFormatHeader(artifact.header, 1)
  assertReleasedArtifactCoordinates(artifact, false, RELEASED_V0_EVENT_TYPE_SET, false, true)
  for (const event of artifact.events) {
    if (RELEASED_V0_EVENT_DISPOSITIONS[event.type] !== undefined) assertReleasedEventPayload(event, 1)
  }
  assertReleasedArtifactRelationships(artifact)
}

/**
 * 在测试中校验 released-v1 物理解码，不解释事件词表。
 * @param artifact - released-v1 物理制品。
 */
export function assertReleasedV1PhysicalArtifact(artifact: SessionFormatArtifact): void {
  assertReleasedSessionFormatHeader(artifact.header, 1)
  assertReleasedArtifactCoordinates(artifact, false, undefined, true)
}
