/** 在 V4 解释之前被接纳的 V3 内容标签与请求工具字段。 */

import { SessionFormatError, SessionFormatUnsupportedMigrationError, isSessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent, SessionFormatJsonObject, SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'
import { mapEventMessages } from './sources.ts'

const V3_BLOCK_TYPES = new Set(['text', 'reasoning', 'image', 'file', 'tool-call', 'tool-result'])

function migrateBlock(value: SessionFormatJsonValue, subject: string): SessionFormatJsonValue {
  if (!isSessionFormatJsonObject(value) || typeof value['type'] !== 'string') {
    throw new SessionFormatError(`${subject} requires content blocks with string type tags`)
  }
  const type = value['type']
  if (V3_BLOCK_TYPES.has(type)) return value
  return { ...value, type: `plugin:${type}` }
}

/**
 * 转换已声明的内容标签，同时保持参数与扩展数据不透明。
 * @param value - 已发布的内容数组。
 * @param subject - 用于诊断的所属事件与内容位置。
 * @returns 顺序相同的内容，共享未变更的块与图片引用。
 */
export function migrateV3Content(value: SessionFormatJsonValue | undefined, subject: string): SessionFormatJsonValue[] {
  if (!Array.isArray(value)) throw new SessionFormatError(`${subject} content must be an array`)
  const blocks = value as readonly SessionFormatJsonValue[]
  const mapped = blocks.map((block, index) => migrateBlock(block, `${subject}[${index}]`))
  return mapped.every((block, index) => block === value[index]) ? value as SessionFormatJsonValue[] : mapped
}

function migrateMessage(message: SessionFormatJsonObject, subject: string): SessionFormatJsonObject {
  const content = migrateV3Content(message['content'], subject)
  return content === message['content'] ? message : { ...message, content }
}

function migrateChunk(value: SessionFormatJsonValue | undefined, subject: string): SessionFormatJsonValue | undefined {
  if (!isSessionFormatJsonObject(value)) return value
  if (value['type'] === 'block-end') {
    const block = migrateBlock(value['block'] as SessionFormatJsonValue, `${subject}.block`)
    return block === value['block'] ? value : { ...value, block }
  }
  if (value['type'] !== 'block-start') return value
  const original = value['blockType']
  if (typeof original !== 'string') throw new SessionFormatError(`${subject} blockType must be a string`)
  const blockType = V3_BLOCK_TYPES.has(original) ? original : `plugin:${original}`
  return blockType === original ? value : { ...value, blockType }
}

/**
 * 在规范化结果提升之后转换已声明的 V3 扩展内容与流标签。
 * @param event - 完成生产者归属转换后的源事件。
 * @returns 带有命名空间化内容标签的事件，保留全部坐标与其它字段。
 * @throws {SessionFormatUnsupportedMigrationError} 某个 V3 工具定义包含仅 V4 才有的 deferLoading 字段。
 */
export function migrateV3EventContent(event: SessionFormatEvent): SessionFormatEvent {
  const subject = `format v3 ${event.type} at seq ${event.seq}`
  let mapped = mapEventMessages(event, message => migrateMessage(message, subject))
  if (!isSessionFormatJsonObject(mapped.data)) return mapped
  let data = mapped.data
  const contentField = (key: string): void => {
    const content = migrateV3Content(data[key], `${subject}.${key}`)
    if (content !== data[key]) data = { ...data, [key]: content }
  }
  if (event.type === 'compaction/summary') {
    contentField('summary')
    if (data['rawOutput'] !== undefined) contentField('rawOutput')
  } else if (event.type === 'tool/ptc-dispatch') contentField('content')
  else if (event.type === 'team/message/queued' && isSessionFormatJsonObject(data['message'])) {
    const message = migrateMessage(data['message'], subject)
    if (message !== data['message']) data = { ...data, message }
  }
  if (event.type === 'request/header' && isSessionFormatJsonObject(data['header'])) {
    const tools = data['header']['tools']
    if (Array.isArray(tools)) {
      for (const [index, tool] of (tools as readonly SessionFormatJsonValue[]).entries()) {
        if (isSessionFormatJsonObject(tool) && Object.hasOwn(tool, 'deferLoading')) {
          throw new SessionFormatUnsupportedMigrationError(
            `${subject}.header.tools[${index}] contains deferLoading, which is only defined in V4`,
          )
        }
      }
    }
  }
  if ((event.type === 'assistant/message' || event.type === 'assistant/attempt') && Array.isArray(data['stream'])) {
    const stream = data['stream'] as readonly SessionFormatJsonValue[]
    const converted = stream.map((entry, index) => {
      if (!isSessionFormatJsonObject(entry) || entry['type'] !== 'chunk') return entry
      const chunk = migrateChunk(entry['chunk'], `${subject}.stream[${index}]`)
      return chunk === entry['chunk'] ? entry : { ...entry, chunk: chunk as SessionFormatJsonValue }
    })
    if (converted.some((entry, index) => entry !== stream[index])) data = { ...data, stream: converted }
  }
  if (data !== mapped.data) mapped = { ...mapped, data }
  return mapped
}
