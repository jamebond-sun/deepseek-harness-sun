/** 原生 V3 system-head 校验，并为冻结的非 system 关系提供私有视图。 */

import { SessionFormatError, SessionFormatUnsupportedMigrationError } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatArtifact, SessionFormatEvent, SessionFormatHeader } from '@deepseek-ai/dsh-session-format'
import { assertReleasedV2Header, restoreReleasedV2Artifact } from '@deepseek-ai/dsh-session-format-v1-to-v2'
import { assertV3Event, isRepairIdentity, record, SURFACE_TYPES } from './payload.ts'

/**
 * 使用 released-v2 字段校验 v3 逻辑元数据。
 * @param header - 已解码的 v3 Session 头部。
 */
export function assertReleasedV3Header(header: SessionFormatHeader): void {
  if (header.version !== 3) throw new SessionFormatError('expected format v3 header')
  assertReleasedV2Header({ ...header, version: 2 })
}

/**
 * 校验系统归属、受保护 head 操作、普通关系与继承切点。
 * 私有关系视图永不外泄；返回的制品及其消息保持不变。
 * @param artifact - 已分离的 v3 制品。
 * @param knownEventTypes - 已安装的 Session 包可理解的事件类型。
 * @returns 同一个已校验的制品。
 */
export function restoreReleasedV3Artifact(artifact: SessionFormatArtifact, knownEventTypes: ReadonlySet<string>): SessionFormatArtifact {
  assertReleasedV3Header(artifact.header)
  let step: { turn: unknown; step: unknown } | undefined
  let head: number | undefined
  let hasSurface = false
  const events = artifact.events.map((event): SessionFormatEvent => {
    assertV3EventAdmission(event)
    assertV3Event(event, knownEventTypes)
    const system = event.type === 'system/message'
    if (event.type === 'step/start') {
      const data = record(event.data, event.type)
      step = { turn: data['turn'], step: data['step'] }
    } else if (event.type === 'step/end' || event.type === 'turn/end') step = undefined
    if (system) {
      const data = record(event.data, 'system/message')
      if (step === undefined || step.turn !== data['turn'] || step.step !== data['step']) {
        throw new SessionFormatError('system/message does not match an open step')
      }
      const operation = event['surfaceOp']
      if (hasSurface && head === undefined) throw new SessionFormatError('system/message requires a protected first surface head')
      if (operation === 'append') {
        if (!hasSurface) head = event.seq
      } else {
        const replace = record(operation, 'system replacement')
        if (replace['startSeq'] === head || replace['endSeq'] === head) {
          if (replace['startSeq'] !== head || replace['endSeq'] !== head) {
            throw new SessionFormatError('system/message must replace exactly the current system head')
          }
          head = event.seq
        }
      }
    } else if (SURFACE_TYPES.has(event.type) && event['surfaceOp'] !== 'append') {
      const replace = record(event['surfaceOp'], 'surface replacement')
      if (replace['startSeq'] === head || replace['endSeq'] === head) throw new SessionFormatError('surface replacement cannot shadow the protected system head')
    }
    if (event.type === 'compaction/prune' || event.type === 'compaction/summary') {
      const data = record(event.data, event.type)
      const seqs = data['shadowedSeqs']
      if (Array.isArray(seqs) && seqs.some(seq => seq === head)) {
        throw new SessionFormatError('compaction cannot shadow the protected system head')
      }
    }
    if (SURFACE_TYPES.has(event.type)) hasSurface = true
    const projected = relationshipEvent(event)
    if (!SURFACE_TYPES.has(event.type) || event['surfaceOp'] === 'append') return projected
    const replacement = event['surfaceOp'] as { readonly startSeq: number; readonly endSeq: number }
    // 只有冻结的关系视图使用已发布的端点名。
    return { ...projected, surfaceOp: { op: 'replace', start: replacement.startSeq, end: replacement.endSeq } }
  })
  restoreReleasedV2Artifact({ ...artifact, header: { ...artifact.header, version: 2 }, events }, knownEventTypes, 3)
  return artifact
}

/**
 * 拒绝必需的前驱 PTC 标签，但不解释原生扩展载荷。
 * @param event - 其类型与可忽略接纳标记均已可用的事件信封。
 */
export function assertV3EventAdmission(event: SessionFormatEvent): void {
  if ((event.type === 'tool/code-dispatch-start' || event.type === 'tool/code-dispatch')
    && event['ignorable'] !== true) {
    throw new SessionFormatUnsupportedMigrationError(
      'format v3 contains unknown event type ' + JSON.stringify(event.type) + ' at seq ' + String(event.seq),
    )
  }
}

function relationshipEvent(event: SessionFormatEvent): SessionFormatEvent {
  switch (event.type) {
    case 'tool/ptc-dispatch-start':
      return { ...event, type: 'tool/code-dispatch-start' }
    case 'tool/ptc-dispatch':
      return { ...event, type: 'tool/code-dispatch' }
    case 'tool/code-dispatch-start':
    case 'tool/code-dispatch':
      assertV3EventAdmission(event)
      // 已过时的可忽略事件不参与已发布的 PTC 生命周期校验。
      return { ...event, type: 'v3/opaque-released-event' }
  }
  if (event.type === 'system/message') {
    const message = record(record(event.data, 'system data')['message'], 'system message')
    // 冻结的校验器需要一个符合表层条件的事件，而非模型可见的替代品。
    return { ...event, type: 'user/message', data: { ...message, role: 'user' } }
  }
  if (event.type !== 'tool/result') return event
  const data = record(event.data, 'tool result')
  if (data['error'] === undefined) return event
  const error = record(data['error'], 'tool error')
  if (error['code'] !== 'TOOL_NOT_STARTED') return event
  const message = record(data['message'], 'tool message')
  const source = record(message['source'], 'tool source')
  const callId = source['callId']
  const id = message['id']
  if (!isRepairIdentity(id, callId)) return event
  const prefix = 'interrupted-tool-result-' + callId + '-'
  // 消息身份在提升中保留；只有这个私有的冻结修复检查会用到目标 seq。
  return { ...event, data: { ...data, message: { ...message, id: `${prefix}${event.seq}` } } }
}
