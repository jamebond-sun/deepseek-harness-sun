import { isAbsolute } from 'node:path'
import {
  SessionFormatError,
  SessionFormatUnsupportedMigrationError,
  sessionFormatCount,
  sessionFormatSafeInteger,
} from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatArtifact,
  SessionFormatHeader,
  SessionFormatJsonObject,
  SessionFormatJsonValue,
} from '@deepseek-ai/dsh-session-format'
import { assertReleasedArtifactRelationships } from '@deepseek-ai/dsh-session-format-v0-to-v1'
import { RELEASED_V2_EVENT_DISPOSITIONS } from './dispositions.ts'

const HEADER_REQUIRED = ['version', 'id', 'createdAt', 'isSeeded', 'delegationDepth'] as const
const HEADER_OPTIONAL = ['cwd', 'parentSession', 'origin', 'agentPreset'] as const
const EVENT_REQUIRED = ['type', 'seq', 'time', 'data'] as const
const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result'])
const SURFACE_OPTIONAL = ['ignorable', 'sourceEventSeqs', 'surfaceOp'] as const
const LOG_OPTIONAL = ['ignorable'] as const
const RELEASED_V2_RELATIONSHIP_EXTENSIONS = {
  stepEvents: new Set(['assistant/attempt']),
  preservedSourceTitleRequestText: true,
} as const

/**
 * 校验已发布 v2 写入的精确逻辑头部。
 * @param header - 已解码的 released-v2 Session 头部。
 * @throws {SessionFormatError} 当该头部不是精确的 released-v2 值时抛出。
 */
export function assertReleasedV2Header(header: SessionFormatHeader): void {
  const record = releasedV2Record(header, 'format v2 header')
  assertReleasedV2Keys(record, HEADER_REQUIRED, HEADER_OPTIONAL, 'format v2 header')
  if (record['version'] !== 2) throw new SessionFormatError('expected format v2 header')
  if (typeof record['id'] !== 'string') throw new SessionFormatError('format v2 header id must be a string')
  sessionFormatCount(record['createdAt'], 'format v2 header createdAt')
  sessionFormatCount(record['delegationDepth'], 'format v2 header delegationDepth')
  if (typeof record['isSeeded'] !== 'boolean') throw new SessionFormatError('format v2 header isSeeded must be boolean')
  if (record['cwd'] !== undefined && (typeof record['cwd'] !== 'string' || !isAbsolute(record['cwd']))) {
    throw new SessionFormatError('format v2 header cwd must be absolute')
  }
  for (const key of ['parentSession', 'agentPreset'] as const) {
    if (record[key] !== undefined && typeof record[key] !== 'string') {
      throw new SessionFormatError(`format v2 header ${key} must be a string`)
    }
  }
  if (record['origin'] !== undefined && record['origin'] !== 'subagent') {
    throw new SessionFormatError('format v2 header origin must be "subagent"')
  }
}

function validateReleasedV2Artifact(
  artifact: SessionFormatArtifact,
  mode: 'current' | 'physical',
  knownEventTypes?: ReadonlySet<string>,
  relationshipHeaderVersion: number = artifact.header.version,
): void {
  assertReleasedV2Header(artifact.header)
  const cut = sessionFormatCount(artifact.inheritedEventCount, 'format v2 inherited event count')
  if (cut > artifact.events.length) throw new SessionFormatError('format v2 inherited event count exceeds its events')
  if (!artifact.header.isSeeded && cut !== 0) throw new SessionFormatError('unseeded format v2 Session has inherited events')
  let lastInheritedMarker: number | undefined
  for (const [index, event] of artifact.events.entries()) {
    const record = releasedV2Record(event, `format v2 event ${index}`)
    const type = record['type']
    if (typeof type !== 'string') throw new SessionFormatError(`format v2 event ${index} type must be a string`)
    const disposition = RELEASED_V2_EVENT_DISPOSITIONS[type]
    const installed = knownEventTypes?.has(type) === true
    const ignorableUnknown = disposition === undefined && record['ignorable'] === true
    if (mode === 'current' && disposition === undefined && !installed && !ignorableUnknown) {
      throw new SessionFormatUnsupportedMigrationError(
        `format v2 contains unknown event type ${JSON.stringify(type)} at seq ${index}`,
      )
    }
    const surface = disposition !== undefined && SURFACE_TYPES.has(type)
    const optional = mode === 'physical' || disposition === undefined
      ? SURFACE_OPTIONAL
      : surface ? SURFACE_OPTIONAL : LOG_OPTIONAL
    assertReleasedV2Keys(record, EVENT_REQUIRED, optional, `format v2 event ${index}`)
    if (record['seq'] !== index) throw new SessionFormatError(`format v2 event ${index} is not dense`)
    sessionFormatSafeInteger(record['time'], `format v2 event ${index} time`)
    if (record['ignorable'] !== undefined && record['ignorable'] !== true) {
      throw new SessionFormatError(`format v2 event ${index} ignorable must be true when present`)
    }
    if (type === 'session/end-seed') {
      const data = releasedV2Record(event.data, `session/end-seed ${index} data`)
      if (data['inherited'] === true) lastInheritedMarker = index
    }
  }
  if (artifact.header.isSeeded && lastInheritedMarker !== cut) {
    throw new SessionFormatError('format v2 seeded header disagrees with its last inherited end-seed marker')
  }
  if (!artifact.header.isSeeded && lastInheritedMarker !== undefined) {
    throw new SessionFormatError('format v2 unseeded Session contains an inherited end-seed marker')
  }
  if (mode === 'current') {
    assertReleasedArtifactRelationships({
      ...artifact, header: { ...artifact.header, version: relationshipHeaderVersion },
    }, RELEASED_V2_RELATIONSHIP_EXTENSIONS)
  }
}

/**
 * 要求一个 released-v2 值是 JSON 对象。
 * @param value - 待收窄的值。
 * @param label - 诊断主体。
 * @returns 收窄后的对象。
 */
export function releasedV2Record(
  value: SessionFormatJsonValue | undefined,
  label: string,
): SessionFormatJsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SessionFormatError(`${label} must be an object`)
  }
  return value as SessionFormatJsonObject
}

/**
 * 要求一个 released-v2 对象恰好只包含被接纳的键。
 * @param value - 待检查的对象。
 * @param required - 必须存在的键。
 * @param optional - 额外允许存在的键。
 * @param label - 诊断主体。
 */
export function assertReleasedV2Keys(
  value: SessionFormatJsonObject,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional])
  const missing = required.find(key => !Object.hasOwn(value, key))
  if (missing !== undefined) throw new SessionFormatError(`${label} lacks required field ${missing}`)
  const unexpected = Object.keys(value).find(key => !allowed.has(key))
  if (unexpected !== undefined) throw new SessionFormatError(`${label} has unexpected field ${unexpected}`)
}

/**
 * 恢复并校验一个已解码的 released-v2 制品。
 * @param artifact - 已分离的、已完成词表恢复的制品。
 * @param knownEventTypes - 已安装的当前 Session 包可理解的事件类型。
 * @param relationshipHeaderVersion - 要检查其版本敏感关系的逻辑代际。
 * @returns 同一个已校验的制品。
 */
export function restoreReleasedV2Artifact(
  artifact: SessionFormatArtifact,
  knownEventTypes: ReadonlySet<string>,
  relationshipHeaderVersion: number = artifact.header.version,
): SessionFormatArtifact {
  validateReleasedV2Artifact(artifact, 'current', knownEventTypes, relationshipHeaderVersion)
  return artifact
}

/**
 * 校验 released-v2 的物理信封，不解释事件词表。
 * @param artifact - released-v2 物理制品。
 */
export function assertReleasedV2PhysicalArtifact(artifact: SessionFormatArtifact): void {
  validateReleasedV2Artifact(artifact, 'physical')
}
