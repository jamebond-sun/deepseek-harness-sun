/**
 * 遥测能力的捕获协调器。实时捕获订阅会话 firehose 加上那一个实时总线
 * 中继（`agent/error`）。两条捕获路径都为每个规范会话事件构建一条逻辑
 * 记录，并让它们各自经过 `session-telemetry/record` 这个 waterfall
 * （由部署挂载的脱敏规则；没有时则透传），然后把结果交给后端。实时捕获
 * 跟随会话 firehose；按需捕获只在被请求时才重放规范日志。每个同步处理函数
 * 都是自包含的，因此一个失败的后端绝不可能饿死其它订阅方（cordis 的
 * `emit` 在遇到抛出时停止），也绝不可能触及 agent 循环。由后端在其
 * 构造函数中组合。
 *
 * @module @deepseek-ai/dsh-session-telemetry/coordinator
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  SessionSeq,
  SessionLogOffset,
  type Session,
  type SessionEvent,
  type SessionSeq as SessionSeqType,
  type SessionSeqCursor,
} from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionTelemetrySink, SessionTelemetryRecord, SessionTelemetrySeverity } from './index.ts'

/** 捕获是跟随实时事件，还是仅在被请求时才读取规范日志。 */
export type SessionTelemetryCapture = 'live' | 'on-demand'

/** 由后端选择的捕获模式与历史策略。 */
export interface SessionTelemetryCaptureOptions {
  /** 跟随实时事件，还是等待显式捕获；默认为实时。 */
  capture?: SessionTelemetryCapture
  /** 包含继承得到的 fork 历史，以及来自更早生命周期的已存储历史；默认为 false。 */
  includeHistory?: boolean
}

/** 一条已准备好交给后端的记录。 */
interface PendingRecord {
  readonly record: SessionTelemetryRecord
  /** 仅在后端接受这条记录之后才推进的账本游标。 */
  readonly seq?: SessionSeqType
}

/**
 * 交接游标：按会话记录交给后端的、最高的 `seq`。刻意做成模块级的环境状态——
 * 这是对“注册即 effect”纪律的一处狭窄且有文档记载的例外：cordis 没有
 * HMR 状态交接 API，而用 `Session` 对象（它属于会话存储，且比任何遥测
 * 纤程都活得久）作为键，是唯一一种能让重新采纳的纤程续上、而非重新交接
 * 历史的内存内生命周期。条目随其会话一起消亡；缺失的条目安全地意味着
 * “重新交接一切”。只在 emit 时刻推进——该游标标记的是已交接，而非已投递。
 */
const handoffCursor = new WeakMap<Session, SessionSeqCursor>()

/**
 * 为某个后端把遥测捕获侧安装到一个上下文上。
 *
 * 实时捕获注册它自己的一套 `session/created` / `session/event` /
 * `session/disposed` 监听器，加上 `agent/error` 中继，全部通过组合纤程上的
 * `ctx.effect()`/`ctx.on()`，并清扫已经活跃的会话（热重载不会重放
 * `session/created`）。一个 `session/disposed` 会在会话自身的终止边缘捕获
 * 其 `shutdown` 操作记录，并把它从已采纳集合中退役。按需捕获不注册那些
 * 连续监听器中的任何一个；{@link captureSession} 显式读取规范日志，且
 * 从不创建操作记录。处置会为实时采纳的会话捕获 shutdown 标记，然后等待
 * 后端的 `shutdown()`；那里若失败则发出警告而非抛出——尽力上报绝不能让
 * 应用拆卸失败。
 */
export class SessionTelemetryCoordinator {
  /**
   * 被本纤程采纳且仍然活跃的会话，用于防二次采纳，以及清扫未标记的会话；
   * `session/disposed` 会标记并退役条目。
   */
  private readonly adopted = new Set<Session>()
  /**
   * @param ctx - 组合后端的上下文；监听器绑定到其纤程。
   * @param backend - 接收记录的后端；所有权在别处，此处除转发 `shutdown()`
   *   外从不处置它。
   * @param options - 捕获模式与历史策略。
   */
  constructor(
    private readonly ctx: Context,
    private readonly backend: SessionTelemetrySink,
    private readonly options: SessionTelemetryCaptureOptions = {},
  ) {
    if ((options.capture ?? 'live') === 'live') {
      ctx.on('session/created', (session) => {
        this.adopt(session)
      })
      // 在会话自身的终止边缘捕获 shutdown 标记，然后退役本协调器拥有的
      // 唯一强引用。
      ctx.on('session/disposed', (session) => {
        this.contain(() => {
          if (!this.adopted.delete(session)) return
          this.deliver(session, { record: this.redact(shutdownRecord(session)) })
        })
      })
      ctx.on('session/event', (session, event) => {
        this.contain(() => {
          this.captureEvent(session, event)
        })
      })
      // 并行监听器会在回合结束时被循环等待；返回 void（而非 SDK 的 flush
      // promise）是回合延迟契约。
      ctx.on('session/flush', (session) => {
        this.contain(() => {
          this.hintFlush(session)
        })
      })
      ctx.on('agent/error', ({ agent, turn, step, error }) => {
        this.contain(() => {
          this.relayAgentError(agent, turn, step, error)
        })
      })
      for (const session of ctx.sessions.list()) {
        this.adopt(session)
      }
    }
    ctx.effect(() => async () => {
      // 仍被此处采纳的会话会存活到整个应用拆卸，因此在后端静默之前
      // 先捕获该标记。
      for (const session of this.adopted) {
        this.contain(() => {
          this.deliver(session, { record: this.redact(shutdownRecord(session)) })
        })
      }
      try {
        await this.backend.shutdown()
      } catch (error) {
        this.ctx.logger.warn(`telemetry: backend shutdown failed: ${String(error)}`)
      }
    }, 'telemetry capture')
  }

  /**
   * 复制、脱敏并交接位于交接游标之后的规范会话日志后缀，可选择性地停在
   * 一个含尾序号边界处。脱敏在本次调用期间运行，因此一个按需调用方在
   * 请求捕获之前不会保留任何已复制的记录，也使用彼时已挂载的策略。后端与
   * 策略的失败按事件各自被容纳，不会饿死同一轮重放中后续的事件。
   * @param session - 其当前规范日志前缀可能被交接的会话。
   * @param throughSeq - 本次捕获所包含的可选最后一个序号。
   */
  captureSession(session: Session, throughSeq?: SessionSeqType): void {
    const start = session.firstLifecycleSeq
    const cursor = handoffCursor.get(session)
      ?? (this.options.includeHistory === true || start === 0 ? -1 : SessionSeq(start - 1))
    // 容纳是按事件的：一条被拒绝的记录会被失败关闭地扣留，而历史重放的
    // 其余部分继续进行。
    // oxlint-disable-next-line typescript/no-deprecated -- 读取已有会话历史；迁移已推迟。
    for (const event of session.snapshotEvents(SessionLogOffset(cursor + 1))) {
      if (throughSeq !== undefined && event.seq > throughSeq) break
      this.contain(() => {
        this.captureEvent(session, event)
      })
    }
  }

  /**
   * 采纳一个会话，并在其交接游标之后重放，随后跟随实时事件。新的 fork
   * 对象包含子会话拥有的种子标记与收尾标记。被恢复的对象从已存储前缀
   * 之后开始，包括被恢复的 fork。includeHistory 会让任一对象都从 seq 0
   * 开始；重新采纳同一个对象会在其游标之后续上。
   * @param session - 要采纳的活跃会话；第二次采纳是无操作。
   */
  private adopt(session: Session): void {
    if (this.adopted.has(session)) return
    this.adopted.add(session)
    this.captureSession(session)
  }

  /** Copy, redact, and hand one canonical event to the backend. */
  private captureEvent(session: Session, event: SessionEvent): void {
    const { data, ...envelope } = event
    this.deliver(session, {
      record: this.redact({
        sourceEvent: { sessionId: session.id, envelope: structuredClone(envelope) },
        channel: 'ledger',
        time: event.time,
        severity: severityOf(event),
        attributes: identityOf(session, event),
        // 规范事件对象是可变的，且后端稍后才会序列化；追加时的校验保证了
        // 这个克隆不会抛出。
        body: structuredClone(data),
      }),
      seq: event.seq,
    })
  }

  /**
   * 在捕获时刻运行 `session-telemetry/record` 这个 waterfall。最内层的 `next`
   * 原样透传记录——本包不带任何规则；导出的数据干净到何种程度，取决于一次
   * 部署所挂载的监听器。调用方运行在 {@link contain} 内部，因此一条抛出的
   * 规则会扣留该记录，而不会到达循环（失败关闭）。按需捕获是在读取规范
   * 会话日志时调用这个 waterfall，而非在事件被追加时。
   */
  private redact(record: SessionTelemetryRecord): SessionTelemetryRecord {
    return this.ctx.waterfall('session-telemetry/record', record, () => record)
  }

  /** 把一条已脱敏的记录交给后端，随后推进其账本游标。 */
  private deliver(session: Session, pending: PendingRecord): void {
    this.backend.emit(pending.record)
    if (pending.seq !== undefined) handoffCursor.set(session, pending.seq)
  }

  /** 把回合结束边界转发给后端的可选 flush 提示。 */
  private hintFlush(session: Session): void {
    if (this.adopted.has(session)) this.backend.flush?.()
  }

  /** 把一次 `agent/error` 总线发射作为一条 `agent-error` 操作记录来中继。 */
  private relayAgentError(agent: Agent, turn: number, step: number, error: unknown): void {
    const detail = errorDetail(error)
    this.deliver(agent.session, {
      record: this.redact({
        channel: 'ops',
        time: Date.now(),
        severity: 'error',
        attributes: {
          'telemetry.op': 'agent-error',
          'session.id': String(agent.session.id),
          'agent.id': agent.id,
          'error.name': detail.name,
          turn,
          step,
        },
        body: detail,
      }),
    })
  }

  /**
   * 运行一个捕获侧步骤，并容纳其异常：cordis 的 `emit` 在遇到抛出时停止，
   * 因此一个抛出的监听器会饿死本插件之后注册的所有订阅方——来自后端的东西
   * 绝不能逃逸出去。
   */
  private contain(step: () => void): void {
    try {
      step()
    } catch (error) {
      this.ctx.logger.warn(`telemetry: capture step failed: ${String(error)}`)
    }
  }
}

/**
 * 构建按会话的干净退出标记：在会话自身的处置边缘发出，或在协调器 dispose
 * 时为那时仍然存活的会话发出。
 */
function shutdownRecord(session: Session): SessionTelemetryRecord {
  return {
    channel: 'ops',
    time: Date.now(),
    severity: 'info',
    attributes: { 'telemetry.op': 'shutdown', 'session.id': String(session.id) },
    body: { op: 'shutdown' },
  }
}

/** 把一个事件自身的结局标志映射到预先设定好的告警严重级别。 */
function severityOf(event: SessionEvent): SessionTelemetrySeverity {
  switch (event.type) {
    case 'tool/result':
      return event.data.message.isError === true ? 'error' : 'info'
    case 'turn/end':
      return event.data.reason.kind === 'error' ? 'error' : 'info'
    default:
      // 可合并扩展的穿透（无 assertNever）：本协调器不依赖的事件类型——
      // 包括它从未听说过的、由插件合并进来的那些——按 info 透传；它们
      // 所有者的结局语义仍归其所有者所有。
      return 'info'
  }
}

/** 把实时总线任意的抛出值规范化为稳定的操作记录形状。 */
function errorDetail(error: unknown): { name: string; message: string } {
  const normalized = error instanceof Error ? error : new Error(String(error))
  return { name: normalized.name, message: normalized.message }
}

/** 构建最小的身份属性：信封，加上自包含的头部事实。 */
function identityOf(session: Session, event: SessionEvent): Record<string, string | number> {
  const attributes: Record<string, string | number> = {
    'session.id': String(session.id),
    'session.format_version': session.header.version,
    'event.type': event.type,
    'event.seq': event.seq,
  }
  const { cwd, parentSession, isSeeded } = session.header
  if (cwd !== undefined) attributes['session.cwd'] = cwd
  if (parentSession !== undefined) attributes['session.parent_id'] = String(parentSession)
  // 持久的 fork 边界与谱系：子账本是完整的；parent_id 与 seed_length
  // 标识哪些领头事件是被继承来的。
  if (isSeeded) attributes['session.seed_length'] = session.inheritedEventCount
  return attributes
}
