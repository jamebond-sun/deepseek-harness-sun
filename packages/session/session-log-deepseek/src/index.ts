/**
 * 面向官方 DeepSeek LLM API 请求的增量会话日志贡献。被接受的序号水位
 * 保存在规范日志中，因此重启恢复可以在不维护另一份存储的情况下，保守地
 * 重发不确定的尾部。
 * @module @deepseek-ai/dsh-session-log-deepseek
 */

import { Buffer } from 'node:buffer'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import { KNOWN_SESSION_EVENT_TYPES, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type {
  Session,
  SessionEvent,
  SessionId,
  SessionLogOffset as SessionLogOffsetType,
  SessionSeq as SessionSeqType,
  SessionSeqCursor,
  SurfaceOp,
} from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {
  DeepSeekSessionLogExtension,
  DeepSeekSessionLogWireEvent,
  DeepSeekSessionLogWireHeader,
  DeepSeekSessionLogWireSurfaceOp,
} from './types.ts'

export type * from './types.ts'

/** Cordis 插件名称。 */
export const name = 'session-log-deepseek'
/** 解析会话并提供提供方请求字段所需的服务。 */
export const inject = ['deepseekLlmApiExtensions', 'sessions']

/** 会话日志请求贡献配置。 */
export interface Config {
  /** 是否向官方 DeepSeek 请求贡献 `dsh_session_log`。默认为 `true`。 */
  enabled: Volatile<boolean>
  /**
   * 单个请求所携带的、序列化后最大的 `dsh_session_log` 字段（以 UTF-8 字节计）。
   * 一个请求上传能装下的最长待发事件前缀；后续请求在其被接受之后继续上传。
   * 默认为 8 MiB。
   */
  maxBytes: number
}

/** 已校验的会话日志请求贡献配置。 */
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  maxBytes: z.number().step(1).min(1).default(8 * 1024 * 1024),
})

interface AcceptanceFold {
  readonly scannedEvents: SessionLogOffsetType
  readonly throughSeq: SessionSeqCursor
}

const acceptanceFolds = new WeakMap<Session, AcceptanceFold>()
/** 每个会话的上传上次被报告阻塞到的事件；一次阻塞只记录一次日志。 */
const blockedWarnings = new WeakMap<Session, SessionSeqType>()

/** 把逻辑会话元数据转换为原始外部请求字段。 */
function wireHeader(session: Session): DeepSeekSessionLogWireHeader {
  const header = session.header
  return {
    version: header.version,
    id: String(header.id),
    createdAt: header.createdAt,
    ...header.cwd === undefined ? {} : { cwd: header.cwd },
    ...header.parentSession === undefined ? {} : { parentSession: String(header.parentSession) },
    ...header.isSeeded ? { seedLength: Number(session.inheritedEventCount) } : {},
    ...header.origin === undefined ? {} : { origin: header.origin },
    ...header.delegationDepth === undefined ? {} : { delegationDepth: header.delegationDepth },
    ...header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset },
  }
}

/** 把编译期序号品牌转换为原始数值请求字段。 */
function wireEvent(event: SessionEvent): DeepSeekSessionLogWireEvent {
  const common = {
    seq: Number(event.seq),
    time: event.time,
    data: event.data as JsonValue,
    ...event.ignorable === undefined ? {} : { ignorable: event.ignorable },
  }
  switch (event.type) {
    case 'developer/message':
    case 'system/message':
    case 'user/message':
    case 'tool/result':
      return {
        ...common,
        type: event.type,
        surfaceOp: wireSurfaceOp(event.surfaceOp),
        ...event.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: event.sourceEventSeqs.map(Number) },
      }
    case 'assistant/message':
      return { ...common, type: event.type, surfaceOp: wireSurfaceOp(event.surfaceOp) }
    default: {
      // 恢复得到的、无法识别的可忽略记录是不透明的，不是当前的 surface 事件。
      if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable === true) {
        const opaque = event as { surfaceOp?: JsonValue; sourceEventSeqs?: JsonValue }
        return {
          ...common, type: event.type, ignorable: true,
          ...opaque.surfaceOp === undefined ? {} : { surfaceOp: opaque.surfaceOp },
          ...opaque.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: opaque.sourceEventSeqs },
        }
      }
      return { ...common, type: event.type }
    }
  }
}

function wireSurfaceOp(op: SurfaceOp): DeepSeekSessionLogWireSurfaceOp {
  return op === 'append'
    ? op
    : { op: 'replace', startSeq: Number(op.startSeq), endSeq: Number(op.endSeq) }
}

/**
 * 某个值的 JSON 文本按请求体的编码方式计算所得的 UTF-8 长度。
 * @returns 当该值无法序列化时返回 `Infinity`，这会被视为超出任何限制。
 */
function jsonBytes(value: DeepSeekSessionLogExtension | DeepSeekSessionLogWireEvent): number {
  let text: string
  try {
    text = JSON.stringify(value)
  } catch (_unserializable) {
    // 任何请求都不可能携带一个无法序列化的值。
    return Number.POSITIVE_INFINITY
  }
  return Buffer.byteLength(text)
}

/**
 * 本会话格式代际所对应的最高已确认序号。
 * @param session - 其匹配接受事件被折叠进来的规范日志。
 * @returns 最大的已接受序号；在任一接受请求之前为 `-1`。
 */
export function acceptedThrough(session: Session): SessionSeqCursor {
  const previous = acceptanceFolds.get(session)
  let throughSeq = previous?.throughSeq ?? -1
  const length = session.seq
  const start = previous?.scannedEvents ?? SessionLogOffset(0)
  for (let index = start; index < length; index++) {
    // oxlint-disable-next-line typescript/no-deprecated -- 读取已有会话历史；迁移已推迟。
    const event = session.eventAt(SessionSeq(index))
    if (event === undefined) {
      throw new Error(`session-log-deepseek: missing event ${String(index)} below captured length ${String(length)}`)
    }
    if (event.type !== 'session-log-deepseek/delivery-accepted') continue
    const acceptedFormatVersion = event.data.sessionFormatVersion ?? 0
    if (!Number.isSafeInteger(acceptedFormatVersion)
      || acceptedFormatVersion < 0
      || Object.is(acceptedFormatVersion, -0)) {
      throw new Error(`session-log-deepseek: malformed acceptance format version at seq ${event.seq}`)
    }
    if (acceptedFormatVersion !== session.header.version) continue
    let acceptedSeq: SessionSeqType
    try {
      acceptedSeq = SessionSeq(event.data.throughSeq)
    } catch {
      throw new Error(`session-log-deepseek: malformed acceptance watermark at seq ${event.seq}`)
    }
    if (typeof event.data.sessionId !== 'string' || event.data.sessionId.length === 0
      || acceptedSeq >= event.seq) {
      throw new Error(`session-log-deepseek: malformed acceptance watermark at seq ${event.seq}`)
    }
    if (event.data.sessionId !== session.id) continue
    if (acceptedSeq > throughSeq) throughSeq = acceptedSeq
  }
  acceptanceFolds.set(session, { scannedEvents: length, throughSeq })
  return throughSeq
}

/**
 * Register the incremental request contribution; enablement is read for each request.
 * @param ctx - plugin context carrying Sessions and the DeepSeek request-extension registry.
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  // Schemastery 在 `apply` 运行之前校验并填充默认值。
  const { maxBytes } = config
  ctx.deepseekLlmApiExtensions.register('dsh_session_log', {
    prepare: (request) => {
      if (!config.enabled.get()) return undefined
      // TODO: 若直接调用或过期会话调用成为受支持的产品路径，为其定义显式的线上结果。
      if (request.sessionId === undefined) return undefined
      const session = ctx.sessions.get(brandString<SessionId>(request.sessionId))
      if (session === undefined) return undefined

      const afterSeq = acceptedThrough(session)
      // oxlint-disable-next-line typescript/no-deprecated -- 读取已有会话历史；迁移已推迟。
      const pending = session.snapshotEvents(SessionLogOffset(afterSeq + 1))
      const envelope = {
        version: 1,
        sessionFormatVersion: session.header.version,
        session: wireHeader(session),
        afterSeq: Number(afterSeq),
      } as const
      // 不含事件或 throughSeq 数字的字段字节；每个候选前缀会加上自己的部分。
      let bytes = jsonBytes({ ...envelope, throughSeq: 0, events: [] }) - 1
      const events: DeepSeekSessionLogWireEvent[] = []
      // 含最后一个被检查事件的字段字节；当都不合适时，取第一个事件自身的字段大小。
      let candidateBytes = 0
      for (const event of pending) {
        const wire = wireEvent(event)
        const next = bytes + (events.length === 0 ? 0 : 1) + jsonBytes(wire)
        candidateBytes = next + String(event.seq).length
        if (candidateBytes > maxBytes) break
        bytes = next
        events.push(wire)
      }
      const last = events.length === 0 ? undefined : pending[events.length - 1]
      if (last === undefined) {
        const first = pending[0]
        if (first !== undefined && blockedWarnings.get(session) !== first.seq) {
          blockedWarnings.set(session, first.seq)
          const seq = String(first.seq)
          ctx.logger.warn(Number.isFinite(candidateBytes)
            ? `session-log-deepseek: event ${seq} of session "${session.id}" needs a ${String(candidateBytes)}-byte`
              + ` dsh_session_log field, above maxBytes ${String(maxBytes)}; this session's upload stays at event ${seq}`
              + ' until maxBytes admits it'
            : `session-log-deepseek: event ${seq} of session "${session.id}" is too large to serialize into a dsh_session_log field;`
              + ` this session's upload stays at event ${seq}`)
        }
        return undefined
      }
      const throughSeq = last.seq
      const value: DeepSeekSessionLogExtension = { ...envelope, throughSeq: Number(throughSeq), events }
      return {
        value,
        accept: () => {
          session.append('session-log-deepseek/delivery-accepted', {
            sessionId: session.id,
            sessionFormatVersion: session.header.version,
            throughSeq,
          })
          // TODO: 若 2xx 崩溃窗口之后重复重放变得不可接受，则添加一个即时轻量检查点。
        },
      }
    },
  })
}
