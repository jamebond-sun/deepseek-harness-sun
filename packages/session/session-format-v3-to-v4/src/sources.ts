/** 已发布的 V3 plugin 源转换与已声明的消息遍历。 */

import { SessionFormatError, isSessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent, SessionFormatJsonObject, SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'

/**
 * 只访问由一方事件载荷携带的消息。
 * @param event - 源侧或目标侧的逻辑事件。
 * @param transform - 保留未变更身份的消息变换。
 * @returns 共享全部未触及载荷的事件。
 */
export function mapEventMessages(
  event: SessionFormatEvent,
  transform: (message: SessionFormatJsonObject) => SessionFormatJsonObject,
): SessionFormatEvent {
  const data = event.data
  if (!isSessionFormatJsonObject(data)) return event
  if (event.type === 'user/message') {
    const message = transform(data)
    return message === data ? event : { ...event, data: message }
  }
  if (event.type === 'developer/message' || event.type === 'system/message' || event.type === 'assistant/message' || event.type === 'tool/result') {
    if (!isSessionFormatJsonObject(data['message'])) throw new SessionFormatError(event.type + ' requires a message')
    const message = transform(data['message'])
    return message === data['message'] ? event : { ...event, data: { ...data, message } }
  }
  const key = event.type === 'agent/inbox/spliced' ? 'inserted' : event.type === 'session/title-llm-request' ? 'messages' : undefined
  if (key === undefined) return event
  const messages = data[key]
  if (!Array.isArray(messages)) throw new SessionFormatError(event.type + ' requires message array')
  const mapped = (messages as readonly SessionFormatJsonValue[]).map((message) => {
    if (!isSessionFormatJsonObject(message)) throw new SessionFormatError(event.type + ' requires message objects')
    return transform(message)
  })
  return mapped.every((message, index) => message === messages[index]) ? event : { ...event, data: { ...data, [key]: mapped } }
}

/** 其当前生产者 kind 不再是 plugin 字符串的已发布 V3 plugin 名。 */
const RENAMED_PRODUCERS: Readonly<Record<string, string>> = Object.freeze({
  'compact': 'compact-checkpoint',
  'tools-code-mode': 'ptc-mode',
  'tools-ptc': 'ptc-mode',
  'dsh-compaction-basic': 'compact-basic',
  '@deepseek-ai/dsh-system-prompt': 'runtime-context',
})

/** 有意保持其当前 kind 的一方 V3 plugin 身份。 */
const RELEASED_SAME_NAME_PRODUCERS: ReadonlySet<string> = new Set([
  'agent-instructions', 'session-reference', 'team-message', 'goal',
  'skill-invocation', 'skill-catalog', 'coordinator', 'subagent-report',
  'subagent-settled', 'webhook', 'agent-message', 'model-selection',
  'plan-mode', 'time-context', 'tmux-context', 'user-approval',
  'repeat-tool-reminder', 'tool-cordis', 'cordis-host-runner', 'tool-goal',
  'tool-jobs', 'hooks-codex', 'hooks-claude-code', 'schedule',
  'dsh-session-title-llm',
])

/** 解析某个已发布 V3 plugin 字符串对应的当前生产者 kind。 */
function producerKind(plugin: string, role: SessionFormatJsonValue | undefined): string {
  if (plugin === '@deepseek-ai/dsh-system-prompt' && role === 'system') return 'system-prompt'
  const renamed = Object.hasOwn(RENAMED_PRODUCERS, plugin) ? RENAMED_PRODUCERS[plugin] : undefined
  if (renamed !== undefined) return renamed
  if (RELEASED_SAME_NAME_PRODUCERS.has(plugin)) return plugin
  return `plugin:${plugin}`
}

/**
 * 将一个已发布的 V3 plugin 源提升为当前的生产者自有形态。
 * @param source - 其 `kind` 为 `'plugin'` 的源记录。
 * @param seq - 用于诊断的事件 seq。
 * @param role - 所承载的消息 role，用于与 role 相关的重命名。
 * @returns 一份副本，其 kind 为生产者自身的 kind，且 `plugin` 字段被移除。
 */
export function rewritePluginSource(
  source: SessionFormatJsonObject,
  seq: number,
  role: SessionFormatJsonValue | undefined,
): SessionFormatJsonObject {
  const plugin = source['plugin']
  if (typeof plugin !== 'string') {
    throw new SessionFormatError(
      `plugin source at seq ${seq} is not canonical: plugin requires a string`,
    )
  }
  const kind = producerKind(plugin, role)
  if (Object.keys(source).length === 2) return { kind }
  return Object.fromEntries(Object.entries(source)
    .filter(([key]) => key !== 'plugin')
    .map(([key, item]) => [key, key === 'kind' ? kind : item]))
}

/**
 * 转换已发布的 plugin 包装，同时保留每个直接源 kind 及其元数据。
 * @param source - 已解码的 V3 消息源。
 * @param seq - 用于诊断的事件序号。
 * @param role - 外层消息 role，用于与 role 相关的生产者映射。
 * @returns 转换后的源，所有非身份字段均被保留。
 */
export function rewriteV3MessageSource(
  source: SessionFormatJsonObject, seq: number, role: SessionFormatJsonValue | undefined,
): SessionFormatJsonObject {
  const kind = source['kind']
  if (typeof kind !== 'string' || kind.length === 0) throw new SessionFormatError(`message source at seq ${seq} requires a nonempty kind`)
  if (kind === 'plugin') return rewritePluginSource(source, seq, role)
  return source
}
