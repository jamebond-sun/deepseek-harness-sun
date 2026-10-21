import { isAbsolute } from 'node:path'
import {
  SessionFormatError,
  SessionFormatUnsupportedMigrationError,
  sessionFormatCount,
  sessionFormatSafeInteger,
} from '@deepseek-ai/dsh-session-format'
import { isJsonValue } from '@deepseek-ai/dsh-util-values'
import type {
  SessionFormatArtifact,
  SessionFormatEvent,
  SessionFormatHeader,
  SessionFormatJsonValue,
} from '@deepseek-ai/dsh-session-format'
import { RELEASED_V0_EVENT_DISPOSITIONS } from './dispositions.ts'
import { assertReleasedPayloadSemantics } from './payload-validation.ts'
import { assertReleasedV0Keys, releasedV0Record } from './validation-helpers.ts'

const HEADER_REQUIRED = ['version', 'id', 'createdAt', 'isSeeded', 'delegationDepth'] as const
const HEADER_OPTIONAL = ['cwd', 'parentSession', 'origin', 'agentPreset'] as const
const EVENT_REQUIRED = ['type', 'seq', 'time', 'data'] as const
const SURFACE_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'tool/result'])
const SURFACE_OPTIONAL = ['ignorable', 'sourceEventSeqs', 'surfaceOp'] as const
const LOG_OPTIONAL = ['ignorable'] as const
const LEGACY_SOURCE_TYPES = new Set([
  'steering/message',
  'request/header-delta',
  'mode/set',
  'compact/start',
  'compact/summary',
  'compact/end',
  'compact/prune',
])

/**
 * 校验已发布 v0 与 v1 共用的逻辑头部。
 * @param header - 已分离的逻辑头部。
 * @param version - 精确预期的代际。
 */
export function assertReleasedSessionFormatHeader(header: SessionFormatHeader, version: 0 | 1): void {
  const record = releasedV0Record(header, `format v${version} header`)
  assertReleasedV0Keys(record, HEADER_REQUIRED, HEADER_OPTIONAL, `format v${version} header`)
  if (record['version'] !== version) throw new SessionFormatError(`expected format v${version} header`)
  if (typeof record['id'] !== 'string') throw new SessionFormatError(`format v${version} header id must be a string`)
  sessionFormatCount(record['createdAt'], `format v${version} header createdAt`)
  if (typeof record['isSeeded'] !== 'boolean') {
    throw new SessionFormatError(`format v${version} header isSeeded must be a boolean`)
  }
  sessionFormatCount(record['delegationDepth'], `format v${version} header delegationDepth`)
  for (const key of ['cwd', 'parentSession', 'agentPreset'] as const) {
    if (record[key] !== undefined && typeof record[key] !== 'string') {
      throw new SessionFormatError(`format v${version} header ${key} must be a string`)
    }
  }
  if (typeof record['cwd'] === 'string' && !isAbsolute(record['cwd'])) {
    throw new SessionFormatError(`format v${version} header cwd must be absolute`)
  }
  if (record['origin'] !== undefined && record['origin'] !== 'subagent') {
    throw new SessionFormatError(`format v${version} header origin must be "subagent"`)
  }
}

/**
 * 校验一个已发布的 v1 逻辑头部。
 * @param header - 已分离的逻辑头部。
 */
export function assertReleasedV1Header(header: SessionFormatHeader): void {
  assertReleasedSessionFormatHeader(header, 1)
}

/**
 * 对照已安装构建的普通事件词表恢复 v1，但不冻结载荷新增项。
 * @param artifact - 与词表无关的已发布 v1 物理解码结果。
 * @param knownEventTypes - 已安装的当前 Session 包可理解的事件类型。
 * @returns 同一个已校验的、已分离的制品。
 */
export function restoreReleasedV1Artifact(
  artifact: SessionFormatArtifact,
  knownEventTypes: ReadonlySet<string>,
): SessionFormatArtifact {
  assertReleasedV1Header(artifact.header)
  assertReleasedArtifactCoordinates(artifact, false, knownEventTypes)
  return artifact
}

/**
 * 在显式词表策略下校验已发布 v0/v1 的制品坐标。
 * @param artifact - 待校验的逻辑制品。
 * @param allowLegacySteering - 是否接受已退役的 steering 事件名。
 * @param knownEventTypes - 已安装的事件词表（在感知词表时使用）。
 * @param vocabularyNeutral - 未知事件类型是否保持不透明。
 * @param frozenEnvelope - 事件信封是否必须已冻结。
 */
export function assertReleasedArtifactCoordinates(
  artifact: SessionFormatArtifact,
  allowLegacySteering: boolean,
  knownEventTypes?: ReadonlySet<string>,
  vocabularyNeutral = false,
  frozenEnvelope = false,
): void {
  const inheritedEventCount = sessionFormatCount(artifact.inheritedEventCount, 'Session inheritedEventCount')
  if (inheritedEventCount > artifact.events.length) {
    throw new SessionFormatError('Session inheritedEventCount exceeds its event count')
  }
  if (!artifact.header.isSeeded && inheritedEventCount !== 0) {
    throw new SessionFormatError('unseeded Session inheritedEventCount must be 0')
  }
  for (let index = 0; index < artifact.events.length; index += 1) {
    const event = artifact.events[index] as SessionFormatEvent
    const record = releasedV0Record(event, `Session event ${index}`)
    const type = record['type']
    if (typeof type !== 'string') throw new SessionFormatError(`Session event ${index} type must be a string`)
    const disposition = RELEASED_V0_EVENT_DISPOSITIONS[type]
    const legacy = allowLegacySteering && LEGACY_SOURCE_TYPES.has(type)
    const currentKnown = knownEventTypes?.has(type) === true
    const ignorableCurrent = !allowLegacySteering && !currentKnown && record['ignorable'] === true
    if (!currentKnown && !legacy && !ignorableCurrent && !vocabularyNeutral) {
      if (allowLegacySteering) {
        throw new SessionFormatUnsupportedMigrationError(
          `format v0 contains unknown historical event type ${JSON.stringify(type)} at seq ${index}; migration refuses unknown historical events even when ignorable`,
        )
      }
      throw new SessionFormatUnsupportedMigrationError(
        `format v1 contains unknown required event type ${JSON.stringify(type)} at seq ${index}`,
      )
    }
    const surface = disposition !== undefined ? SURFACE_EVENT_TYPES.has(type) : type === 'steering/message'
    const optional = frozenEnvelope
      ? surface ? SURFACE_OPTIONAL : LOG_OPTIONAL
      : SURFACE_OPTIONAL
    assertReleasedV0Keys(record, EVENT_REQUIRED, optional, `Session event ${index}`)
    if (record['seq'] !== index) {
      throw new SessionFormatError(`Session event ${index} has non-dense seq ${JSON.stringify(record['seq'])}`)
    }
    sessionFormatSafeInteger(record['time'], `Session event ${index} time`)
    if (record['ignorable'] !== undefined && record['ignorable'] !== true) {
      throw new SessionFormatError(`Session event ${index} ignorable must be true when present`)
    }
    if (frozenEnvelope && surface) assertReleasedSurfaceMetadata(record, index, type, 'allow-empty-assistant')
  }
}

/**
 * 校验某个已发布代际的共享布局表层引用。
 * @param record - 精确的事件信封。
 * @param seq - 用于前向引用检查的事件位置。
 * @param type - 用于诊断的表层事件类型。
 * @param assistantSources - 该代际是否接纳空的 Assistant 分块引用。
 */
export function assertReleasedSurfaceMetadata(
  record: Record<string, SessionFormatJsonValue>,
  seq: number,
  type: string,
  assistantSources: 'allow-empty-assistant' | 'forbid-assistant',
): void {
  const sources = record['sourceEventSeqs']
  if (type === 'assistant/message' && sources !== undefined && assistantSources === 'forbid-assistant') {
    throw new SessionFormatError(`assistant/message ${seq} retains obsolete chunk references`)
  }
  if (sources !== undefined) {
    if (!Array.isArray(sources)) throw new SessionFormatError(`${type} ${seq} sourceEventSeqs must be an array`)
    const seen = new Set<number>()
    for (const source of sources) {
      const current = sessionFormatCount(source, `${type} ${seq} sourceEventSeqs member`)
      if (current >= seq || seen.has(current)) {
        throw new SessionFormatError(`${type} ${seq} sourceEventSeqs must be unique earlier seqs`)
      }
      seen.add(current)
    }
    if (sources.length === 0 && type !== 'assistant/message') {
      throw new SessionFormatError(`${type} ${seq} sourceEventSeqs must be non-empty`)
    }
  }
  const operation = record['surfaceOp']
  if (operation === undefined || operation === 'append') return
  const replacement = releasedV0Record(operation, `${type} ${seq} surfaceOp`)
  assertReleasedV0Keys(replacement, ['op', 'start', 'end'], [], `${type} ${seq} surfaceOp`)
  if (replacement['op'] !== 'replace') throw new SessionFormatError(`${type} ${seq} surfaceOp must replace`)
  const start = sessionFormatCount(replacement['start'], `${type} ${seq} surface start`)
  const end = sessionFormatCount(replacement['end'], `${type} ${seq} surface end`)
  if (start >= seq || end >= seq) throw new SessionFormatError(`${type} ${seq} has an invalid surface replacement`)
}

/**
 * 在遗留规范化之后校验一个精确的已知载荷。
 * @param event - 待校验的已知事件。
 * @param version - 控制版本化成员的载荷代际。
 */
export function assertReleasedEventPayload(event: SessionFormatEvent, version: 0 | 1): void {
  const disposition = RELEASED_V0_EVENT_DISPOSITIONS[event.type]
  /* v8 ignore next -- 制品坐标校验在载荷校验之前只接纳这份冻结清单。 */
  if (disposition === undefined) {
    throw new SessionFormatUnsupportedMigrationError(
      `format v0 contains unknown historical event type ${JSON.stringify(event.type)} at seq ${event.seq}; migration refuses unknown historical events even when ignorable`,
    )
  }
  const data = releasedV0Record(event.data, `${event.type} ${event.seq} data`)
  if (event.type === 'subagent/descriptor' && data['version'] !== 3) {
    const descriptorVersion = sessionFormatCount(data['version'], `${event.type} ${event.seq} version`)
    if (version === 0) {
      throw new SessionFormatUnsupportedMigrationError(
        `${event.type} ${event.seq} uses unsupported descriptor version ${descriptorVersion}`,
      )
    }
    return
  }
  const versionOptional = version === 1 && event.type === 'session-log-deepseek/delivery-accepted'
    ? [...disposition.optional, 'sessionFormatVersion']
    : disposition.optional
  assertReleasedV0Keys(data, disposition.required, versionOptional, `${event.type} ${event.seq} data`)
  for (const key of disposition.opaque) {
    if (Object.hasOwn(data, key) && !isJsonValue(data[key])) {
      throw new SessionFormatError(`${event.type} ${event.seq} opaque ${key} is not lossless JSON`)
    }
  }
  assertReleasedPayloadSemantics(event, version)
}
