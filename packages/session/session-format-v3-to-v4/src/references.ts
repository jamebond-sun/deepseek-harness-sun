/** 在中断轮次插入之后重映射已发布的 V3 局部事件引用。 */

import { SessionFormatError, isSessionFormatJsonObject, sessionFormatCount } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent, SessionFormatJsonObject, SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'

function object(value: SessionFormatJsonValue | undefined): SessionFormatJsonObject {
  if (!isSessionFormatJsonObject(value)) throw new SessionFormatError('V3 event reference container must be an object')
  return value
}

/**
 * 重映射一方局部引用，保留带代际限定的捕获与数值型载荷。
 * @param event - 信封重编号之前的一方源事件。
 * @param seq - 目标事件位置。
 * @param mapping - 所有更早源事件的目标位置。
 * @returns 处于目标坐标下的事件；未变更的事件保留其身份。
 */
export function remapV3References(event: SessionFormatEvent, seq: number, mapping: readonly number[]): SessionFormatEvent {
  if (seq === event.seq) return event
  const reference = (value: SessionFormatJsonValue | undefined): number => {
    const source = sessionFormatCount(value, 'V3 source event reference')
    const target = mapping[source]
    if (source >= event.seq || target === undefined) throw new SessionFormatError('V3 reference must name an earlier source event')
    return target
  }
  const references = (value: SessionFormatJsonValue | undefined): number[] => {
    if (!Array.isArray(value)) throw new SessionFormatError('V3 event references must be an array')
    return value.map(reference)
  }
  let data = event.data
  switch (event.type) {
    case 'command/done': {
      const source = object(data)
      if (source['sourceEventSeq'] !== undefined) data = { ...source, sourceEventSeq: reference(source['sourceEventSeq']) }
      break
    }
    case 'compaction/summary':
    case 'compaction/prune': {
      const source = object(data)
      const range = object(source['shadowedRange'])
      data = { ...source, shadowedRange: { ...range, start: reference(range['start']), end: reference(range['end']) }, shadowedSeqs: references(source['shadowedSeqs']) }
      break
    }
    case 'session/title':
    case 'session/title-llm-request': {
      const source = object(data)
      data = { ...source, messageSeqs: references(source['messageSeqs']) }
      break
    }
    case 'image/offload': {
      const source = object(data)
      const targets = source['targets']
      if (!Array.isArray(targets)) throw new SessionFormatError('V3 image offload targets must be an array')
      data = { ...source, targets: targets.map((value: SessionFormatJsonValue) => {
        const target = object(value)
        return { ...target, seq: reference(target['seq']) }
      }) }
      break
    }
  }
  const surface = event['surfaceOp']
  const range = surface === undefined || surface === 'append' ? undefined : object(surface)
  return {
    ...event, seq, data,
    ...(event['sourceEventSeqs'] === undefined ? {} : { sourceEventSeqs: references(event['sourceEventSeqs']) }),
    ...(range === undefined ? {} : { surfaceOp: { ...range, startSeq: reference(range['startSeq']), endSeq: reference(range['endSeq']) } }),
  }
}
