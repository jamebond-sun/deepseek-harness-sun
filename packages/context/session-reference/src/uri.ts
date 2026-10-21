/** 规范的会话 URI 与内联提及编码。 */

import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import { SessionReferenceError } from './config.ts'
import type { SessionReferenceInput } from './types.ts'

/** 为 DeepSeek Harness 会话快照所保留的 URI 方案。 */
export const SESSION_REFERENCE_SCHEME = 'dsh-session:'

/**
 * 将任意 JavaScript 会话 id 字符串编码为规范的、无损的 URI。
 * @param sessionId - 待序列化的不透明会话 id。
 * @returns 规范的 `dsh-session:` URI。
 */
export function encodeSessionReferenceUri(sessionId: SessionIdType): string {
  const payload = Buffer.from(JSON.stringify(sessionId), 'utf8').toString('base64url')
  return `${SESSION_REFERENCE_SCHEME}${payload}`
}

/**
 * 解码并规范化一个会话引用 URI。
 * @param uri - 完整的规范 URI。
 * @returns 解码后的会话 id。
 */
export function decodeSessionReferenceUri(uri: string): SessionIdType {
  if (!uri.startsWith(SESSION_REFERENCE_SCHEME)) {
    throw invalidUri(uri)
  }
  const payload = uri.slice(SESSION_REFERENCE_SCHEME.length)
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) throw invalidUri(uri)
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (typeof parsed !== 'string') throw new TypeError('decoded session id is not a string')
    const sessionId = brandString<SessionIdType>(parsed)
    if (encodeSessionReferenceUri(sessionId) !== uri) throw new TypeError('URI is not canonical')
    return sessionId
  } catch (error: unknown) {
    throw invalidUri(uri, error)
  }
}

/**
 * 渲染一个与宿主无关的、携带规范 URI 的 Markdown 提及。
 * @param reference - 结构化的 id 与可选的展示标签。
 * @returns 经过转义的 `@[label](uri)` 提及。
 */
export function formatSessionReferenceMention(reference: SessionReferenceInput): string {
  const label = escapeLabel(reference.label ?? reference.sessionId)
  return `@[${label}](${encodeSessionReferenceUri(reference.sessionId)})`
}

/** 从纯文本中提取规范提及的结果。 */
export interface ParsedSessionReferenceText {
  /** 不透明标记被可读的 `@label` 片段替换后的文本。 */
  text: string
  /** 按首次出现顺序排列的结构化引用，尚未经过服务去重。 */
  references: SessionReferenceInput[]
}

/**
 * 从一个文本值中提取 Markdown 提及与孤立的规范 URI。
 * 显式的 Markdown 提及在遇到任何畸形 URI 时会失败。孤立文本仅在具有
 * 非空的 base64url 形态载荷时才被视为引用，若该候选并非规范者仍会失败。
 * @param text - 待规范化的宿主文本。
 * @returns 可读的文本与按出现顺序排列的结构化引用。
 */
export function parseSessionReferenceText(text: string): ParsedSessionReferenceText {
  const references: SessionReferenceInput[] = []
  const pattern = /@\[((?:\\.|[^\\\]])*)\]\((dsh-session:[^\s)]*)\)|(dsh-session:[A-Za-z0-9_-]+)/gu
  const rendered = text.replace(pattern, (
    _match,
    rawLabel: string | undefined,
    markdownUri: string | undefined,
    bareUri: string | undefined,
  ) => {
    const uri = markdownUri ?? bareUri
    /* v8 ignore next -- the two-alternative regex always captures exactly one URI group. */
    if (uri === undefined) throw new SessionReferenceError('session reference URI is missing', 'SESSION_REFERENCE_INVALID_REFERENCE')
    const sessionId = decodeSessionReferenceUri(uri)
    const label = rawLabel === undefined ? sessionId : unescapeLabel(rawLabel)
    references.push({ sessionId, label })
    return `@${label}`
  })
  return { text: rendered, references }
}

function escapeLabel(label: string): string {
  return label.replace(/[\\\]]/gu, match => `\\${match}`)
}

function unescapeLabel(label: string): string {
  return label.replace(/\\(.)/gu, '$1')
}

function invalidUri(uri: string, cause?: unknown): SessionReferenceError {
  return new SessionReferenceError(
    `invalid session reference URI ${JSON.stringify(uri)}`,
    'SESSION_REFERENCE_INVALID_REFERENCE',
    cause === undefined ? undefined : { cause },
  )
}
