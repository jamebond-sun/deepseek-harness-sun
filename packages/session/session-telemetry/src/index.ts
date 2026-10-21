/**
 * 面向 DeepSeek Harness 的 SessionTelemetryBackend 服务定义。
 *
 * 本包负责会话事件上报的捕获侧——即完整的一事件一记录的账本镜像、记录
 * 携带什么、何时被捕获（采纳、每次追加的 firehose、生命周期转发）、
 * 实时捕获与按需捕获的规范日志捕获，以及 HMR 游标。位于
 * {@link SessionTelemetryBackend.emit} 之后的所有环节——批处理、重试、排队
 * 与丢失策略——都是后端的责任，此处刻意不为其建模。捕获与后端的职责
 * 记载于
 * [会话遥测参考](../README.md#understand-the-implementation)。
 *
 * @module @deepseek-ai/dsh-session-telemetry
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionTelemetry: SessionTelemetryBackend
  }

  interface Events {
    /**
     * 在一条出站记录到达后端之前对其进行转换。这个 waterfall 是服务定义的
     * 脱敏扩展点。它本身不带任何规则：最内层的 `next()` 原样透传记录，
     * 而在没有挂载监听器时，记录以被捕获时的样子到达后端，因此导出的数据
     * 干净到何种程度，取决于一次部署所挂载的规则。监听器通过转换 `next()`
     * 的返回值而叠加；不调用 `next()` 就返回会替换其下的一切。在协调器
     * 的容器内、于捕获热路径上同步分发：一个抛出异常的监听器会扣留那一条
     * 记录（失败关闭），且永远不会到达 agent 循环。实时捕获在追加时分发；
     * 按需捕获在读取规范日志时分发。脱敏只作用于导出的副本；规范会话日志
     * 永远不会被重写。
     * @param record - 候选记录，已是协调器自己的深拷贝；监听器返回一个
     *   （可能是新的）记录，且不得修改它。
     * @mode waterfall
     */
    'session-telemetry/record'(record: SessionTelemetryRecord, next: () => SessionTelemetryRecord): SessionTelemetryRecord
  }
}

/**
 * 一条遥测记录的严重级别，在捕获时预先映射，以便接收方可以零配置地告警：
 * `error` 用于那些自身结果标志表明如此的事件（工具消息的 `isError`、
 * `turn/end` 的错误原因），以及 `agent-error` 操作记录。其它被捕获的事件
 * 默认是 `info`；`warn` 仍可供 `session-telemetry/record` 的策略与后端
 * 使用。
 */
export type SessionTelemetrySeverity = 'info' | 'warn' | 'error'

/**
 * 交给后端的一条逻辑记录——即捕获契约完整的出站词汇。账本记录与会话日志
 * 事件一一镜像；操作记录（`channel: 'ops'`）携带两个没有日志归宿的信号
 * （`agent-error`、`shutdown`），并刻意省略 `event.seq` 形式的身份，以便
 * 它们永远不会被误认为账本行。
 */
export interface SessionTelemetryRecord {
  /** 不带 data 的规范信封；body 携带被单独脱敏的负载。操作记录中不存在。 */
  sourceEvent?: { sessionId: SessionId; envelope: Omit<SessionEvent, 'data'> }
  /** 账本（会话日志镜像）或 ops（操作信号）通道；后端把两者保留在各自的埋点作用域下。 */
  channel: 'ledger' | 'ops'
  /** Unix 纪元毫秒——账本记录为源事件的追加时间，ops 记录为发出时间。 */
  time: number
  /** 预先映射好的告警严重级别；见 {@link SessionTelemetrySeverity}。 */
  severity: SessionTelemetrySeverity
  /**
   * 身份属性，刻意保持最小：账本记录携带 `session.id`、`session.format_version`、
   * `event.type`、`event.seq`，加上可选的 `session.cwd` / `session.parent_id`；
   * 一个已播种的会话还会携带来自其精确继承事件数的 `session.seed_length`；
   * ops 记录携带 `telemetry.op`、`session.id`，以及（针对 `agent-error`）
   * `agent.id`、`turn`、`step`、`error.name`。任何可从 body 恢复的内容
   * 都有意不在此处重复。
   */
  attributes: Record<string, string | number>
  /**
   * 完整负载：账本记录为会话事件 `data` 的深拷贝（经 `Session.append`
   * 自身的校验保证可 JSON 序列化），或 ops 记录的操作负载。交接之后
   * 绝不被修改。
   */
  body: unknown
}

/**
 * 协调器所要求的最小后端契约。{@link SessionTelemetryBackend} 是其以服务
 * 形式注册的样子；测试用一个对这个接口的裸实现来组合协调器。
 */
export interface SessionTelemetrySink {
  /**
   * 把一条记录交给后端的管线。必须是非阻塞的入队——协调器从 `session/event`
   * 热路径或一次显式的规范日志捕获同步调用它，因此任何比队列推送更慢的
   * 操作都会拖累 agent 循环或反馈处理。这里抛出的错误由协调器容纳并记录；
   * 它们永远不会到达循环。
   * @param record - 要上报的逻辑记录；调用之后由后端拥有。
   */
  emit(record: SessionTelemetryRecord): void
  /**
   * 一个回合已结束的可选提示。后端可以把它转发给其 SDK 的 flush，以便
   * 每个回合之后导出记录。以即发即忘方式调用；实现不得阻塞，也不得
   * 有意义地抛出（协调器会容纳异常）。多数后端应让此保持未实现，而让其
   * SDK 自身的批处理节奏来决定导出时机：一个确实实现了它的后端，需要
   * 自行负责其并发 flush 与 {@link shutdown} 排空之间的交互（OTel 后端
   * 正是出于这一风险而让它保持未实现——见 revival Agent Note）。
   */
  flush?(): void
  /**
   * 把纤程的处置转发给 SDK：按照 SDK 自身的关闭契约，刷新排队中的一切
   * 并达到静默。本次调用之前发出的所有内容都必须仍被投递——包括在一条
   * {@link flush} 提示在途时入队的记录，因此一个 SDK 会防范并发 flush 的
   * 后端，会把顺序排在未完成的那次之后（协调器在调用本方法之前、于处置
   * 时刻立即发出其 `shutdown` 标记）。由协调器的 dispose 等待；拒绝会被
   * 记为警告，而绝不会让应用拆卸失败。对于实时捕获，协调器会在本调用之前
   * 捕获处置时刻的 shutdown 标记；按需捕获不创建任何 ops 记录。
   * @returns 当后端管线达到静默时 resolve。
   */
  shutdown(): Promise<void>
}

/**
 * 由部署选择的会话共享模式，而非 SDK 投递成功的确认。
 */
export type SessionTelemetrySharingStatus = 'full' | 'feedback-only' | 'disabled'

/**
 * 后端契约可加载的形式：每个上下文一个实现——在 `telemetry` 键下的 cordis
 * `Service` 注册在遇到重复时会抛出，这是 cordis 的标准行为。一个后端在
 * 其构造函数中组合一个 {@link SessionTelemetryCoordinator} 来安装捕获侧。
 */
export abstract class SessionTelemetryBackend extends Service implements SessionTelemetrySink {
  constructor(ctx: Context) {
    super(ctx, 'sessionTelemetry')
  }

  /**
   * 由部署选择的共享模式，与 SDK 投递无关。
   */
  abstract readonly sharing: SessionTelemetrySharingStatus

  /**
   * 见 {@link SessionTelemetrySink.emit}——那处声明才是契约的唯一出处。
   * @param record - 要上报的逻辑记录；调用之后由后端拥有。
   */
  abstract emit(record: SessionTelemetryRecord): void

  /** 见 {@link SessionTelemetrySink.flush}。 */
  flush?(): void

  /**
   * 见 {@link SessionTelemetrySink.shutdown}。
   * @returns 当后端管线达到静默时 resolve。
   */
  abstract shutdown(): Promise<void>
}

export { SessionTelemetryCoordinator, type SessionTelemetryCapture, type SessionTelemetryCaptureOptions } from './coordinator.ts'
