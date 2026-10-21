/** 显式的局部坐标重映射；被捕获的代际与持有者局部计数器保持不透明。 */

import { SessionFormatError, sessionFormatCount } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent, SessionFormatJsonObject, SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'
import { record } from './payload.ts'

/**
 * 只重映射经过审计的同制品引用，保留 ID 与内嵌的模型输入。
 * @param event - 已校验的源事件。
 * @param seq - 输出事件位置。
 * @param mapping - 从较早源位置到输出位置的映射。
 * @returns 处于目标坐标下的事件。
 */
export function remapEvent(event: SessionFormatEvent, seq: number, mapping: readonly number[]): SessionFormatEvent {
  const one = (value: SessionFormatJsonValue | undefined): number => {
    const source = sessionFormatCount(value, 'source event reference')
    const target = mapping[source]
    if (source >= event.seq || target === undefined) throw new SessionFormatError('reference must name an earlier source event')
    return target
  }
  const list = (value: SessionFormatJsonValue | undefined): number[] => {
    if (!Array.isArray(value)) throw new SessionFormatError('sequence references must be an array')
    return value.map(one)
  }
  const range = (value: SessionFormatJsonValue | undefined): SessionFormatJsonObject => {
    const source = record(value, 'sequence range')
    return { ...source, start: one(source['start']), end: one(source['end']) }
  }
  let data = record(event.data, event.type)
  switch (event.type) {
    case 'command/done':
      if (data['sourceEventSeq'] !== undefined) data = { ...data, sourceEventSeq: one(data['sourceEventSeq']) }
      break
    case 'compaction/summary':
    case 'compaction/prune':
      data = { ...data, shadowedRange: range(data['shadowedRange']), shadowedSeqs: list(data['shadowedSeqs']) }
      break
    case 'session/title':
    case 'session/title-llm-request':
      data = { ...data, messageSeqs: list(data['messageSeqs']) }
      break
    // 投递水位与会话引用捕获标识它们原本的代际。
    // workflow seq、流块索引、turn/step 以及数值型工具 JSON 都不是 Session seq。
  }
  return {
    ...event, seq, data,
    ...(event['sourceEventSeqs'] === undefined ? {} : { sourceEventSeqs: list(event['sourceEventSeqs']) }),
    ...(event['surfaceOp'] === undefined || event['surfaceOp'] === 'append'
      ? {} : { surfaceOp: range(event['surfaceOp']) }),
  }
}
