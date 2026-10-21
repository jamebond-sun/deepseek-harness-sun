/** 原生 V4 元数据与代际自有关系的校验。 */

import { isAbsolute } from 'node:path'
import { SessionFormatError, SessionFormatUnsupportedMigrationError, isSessionFormatJsonObject, sessionFormatCount } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatArtifact, SessionFormatEvent } from '@deepseek-ai/dsh-session-format'
import { assertV4DeveloperData } from './developer.ts'
import { assertV4LifecycleRelationships } from './relationships.ts'
import { assertV4MessageSources } from './message-sources.ts'
import { catalogFact } from './facts.ts'
import { assertV4RetiredSyntax } from './retired-syntax.ts'
import { assertV4SystemMessageFields } from './system-message.ts'
import { assertV4ForkResult } from './fork-result.ts'
import { assertV4ToolResultMessage } from './tool-role.ts'

/**
 * 校验精确的原生 V4 逻辑头部。
 * @param header - 已解码或来自其它不受信任来源的 V4 Session 头部候选值。
 */
export function assertReleasedV4Header(header: unknown): void {
  if (!isSessionFormatJsonObject(header) || header['version'] !== 4) throw new SessionFormatError('expected format v4 header')
  const required = ['version', 'id', 'createdAt', 'isSeeded', 'delegationDepth']
  const allowed = new Set([...required, 'cwd', 'parentSession', 'origin', 'agentPreset'])
  const missing = required.find(key => !Object.hasOwn(header, key))
  const unexpected = Object.keys(header).find(key => !allowed.has(key))
  if (missing !== undefined) throw new SessionFormatError(`format v4 header lacks required field ${missing}`)
  if (unexpected !== undefined) throw new SessionFormatError(`format v4 header has unexpected field ${unexpected}`)
  if (typeof header.id !== 'string') throw new SessionFormatError('format v4 header id must be a string')
  sessionFormatCount(header.createdAt, 'format v4 header createdAt')
  sessionFormatCount(header.delegationDepth, 'format v4 header delegationDepth')
  if (typeof header.isSeeded !== 'boolean') throw new SessionFormatError('format v4 header isSeeded must be boolean')
  if (header.cwd !== undefined && (typeof header.cwd !== 'string' || !isAbsolute(header.cwd))) {
    throw new SessionFormatError('format v4 header cwd must be absolute')
  }
  for (const key of ['parentSession', 'agentPreset']) {
    if (header[key] !== undefined && typeof header[key] !== 'string') {
      throw new SessionFormatError(`format v4 header ${key} must be a string`)
    }
  }
  if (header.origin !== undefined && header.origin !== 'subagent') {
    throw new SessionFormatError('format v4 header origin must be "subagent"')
  }
}

/**
 * 校验 V4 的继承、词表、原生消息接纳，以及生命周期、压缩、工具、重试、
 * 标题、命令、目录与投递归属。
 * 已安装的 Session 恢复机制负责通用事件信封与消息接纳。
 * @param artifact - 完整的、已分离的 V4 制品。
 * @param knownEventTypes - 已安装的 Session 包可理解的事件类型。
 * @returns 同一个已校验的制品与事件对象。
 */
export function restoreReleasedV4Artifact(artifact: SessionFormatArtifact, knownEventTypes: ReadonlySet<string>): SessionFormatArtifact {
  assertReleasedV4Header(artifact.header)
  const cut = sessionFormatCount(artifact.inheritedEventCount, 'format v4 inherited event count')
  if (cut > artifact.events.length) throw new SessionFormatError('format v4 inherited event count exceeds its events')
  if (!artifact.header.isSeeded && cut !== 0) throw new SessionFormatError('unseeded format v4 Session has inherited events')
  let lastInheritedMarker: number | undefined
  for (const [index, event] of artifact.events.entries()) {
    if (!knownEventTypes.has(event.type) && event['ignorable'] !== true) {
      throw new SessionFormatUnsupportedMigrationError(
        `format v4 contains unknown event type ${JSON.stringify(event.type)} at seq ${index}`,
      )
    }
    if (event.seq !== index) throw new SessionFormatError(`format v4 event ${index} is not dense`)
    if (!knownEventTypes.has(event.type)) continue
    assertV4RetiredSyntax(event)
    assertV4SystemMessageFields(event)
    assertV4ToolResultMessage(event)
    assertV4ForkResult(event)
    if (event.type === 'session/end-seed' && isSessionFormatJsonObject(event.data)
      && event.data['inherited'] === true) lastInheritedMarker = index
  }
  if (artifact.header.isSeeded && lastInheritedMarker !== cut) {
    throw new SessionFormatError('format v4 seeded header disagrees with its last inherited end-seed marker')
  }
  if (!artifact.header.isSeeded && lastInheritedMarker !== undefined) {
    throw new SessionFormatError('format v4 unseeded Session contains an inherited end-seed marker')
  }
  assertReleasedV4Relationships(artifact, knownEventTypes)
  return artifact
}

/**
 * 在评估归属之前校验投递代际与当前代际坐标。
 * @param event - 已解码的事件，其投递载荷可能被检查。
 * @param currentVersion - 其水位坐标处于激活状态的代际。
 * @returns 当前投递的非空 Session id；对其它事件与代际为 undefined。
 */
export function validateDeliveryAccepted(event: SessionFormatEvent, currentVersion: 3 | 4): string | undefined {
  if (event.type !== 'session-log-deepseek/delivery-accepted') return undefined
  const data = event.data
  if (!isSessionFormatJsonObject(data)) throw new SessionFormatError('delivery-accepted data must be an object')
  const version = sessionFormatCount(data['sessionFormatVersion'] === undefined ? 0 : data['sessionFormatVersion'], 'delivery sessionFormatVersion')
  if (version !== currentVersion) return undefined
  const throughSeq = sessionFormatCount(data['throughSeq'], 'delivery throughSeq')
  if (throughSeq >= event.seq) throw new SessionFormatError('delivery throughSeq must precede its marker')
  const id = data['sessionId']
  if (typeof id !== 'string' || id.length === 0) throw new SessionFormatError('delivery requires a nonempty Session id')
  return id
}

/**
 * 校验原生 developer 字段、消息源、生命周期、目录与投递关系，
 * 不改变事件词表与尾部恢复行为。
 * 所属的接纳阶段会拒绝未知的必需事件；
 * 未知的可忽略记录保留其未被解释的载荷。
 * @param artifact - 已解码的制品，带有其最终继承切点。
 * @param knownEventTypes - 本读取器会解释其载荷的已安装事件类型。
 */
export function assertReleasedV4Relationships(artifact: SessionFormatArtifact, knownEventTypes: ReadonlySet<string>): void {
  const ids = new Set<string>()
  for (const event of artifact.events) {
    if (!knownEventTypes.has(event.type)) continue
    assertV4DeveloperData(event)
    assertV4MessageSources(event)
    const deliveryId = validateDeliveryAccepted(event, 4)
    if (deliveryId !== undefined
      && !(artifact.header.parentSession !== undefined && event.seq < artifact.inheritedEventCount)
      && deliveryId !== artifact.header.id) {
      throw new SessionFormatError('current-generation delivery marker names the wrong Session')
    }
    if (event.type === 'subagent/catalog' && event.seq >= artifact.inheritedEventCount) {
      const fact = catalogFact(event.data)
      const id = fact['childId'] as string
      if (ids.has(id)) throw new SessionFormatError(`duplicate catalog child ${id}`)
      ids.add(id)
    }
  }
  assertV4LifecycleRelationships(artifact, knownEventTypes)
}
