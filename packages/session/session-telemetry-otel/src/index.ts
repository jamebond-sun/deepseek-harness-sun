/**
 * 面向 DeepSeek Harness 遥测能力的 OpenTelemetry 服务提供者。
 *
 * 授权有反馈边界的捕获，并把完整的事件字符串交给 Session-log 上报器。
 * 本插件负责资源身份与一个外层关闭截止时间；上报器负责有字节边界的
 * SDK 投递。
 *
 * @module @deepseek-ai/dsh-session-telemetry-otel
 */

import { createRequire } from 'node:module'
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-command-feedback'
import type {} from '@deepseek-ai/dsh-message-feedback'
import { Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  SessionTelemetryBackend,
  SessionTelemetryCoordinator,
  type SessionTelemetrySink,
  type SessionTelemetryRecord,
  type SessionTelemetrySeverity,
  type SessionTelemetrySharingStatus,
} from '@deepseek-ai/dsh-session-telemetry'
import { APP_IDENTITY } from '@deepseek-ai/dsh-llm'
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import type { LogExporterOptions, SessionLogProcessorOptions, SessionLogReporter } from '@deepseek-ai/dsh-otel'
import { SeverityNumber } from '@opentelemetry/api-logs'

/** 由 {@link Config.mode} 选定的会话共享策略。 */
export enum SessionTelemetryMode {
  FEEDBACK_ONLY = 'FEEDBACK_ONLY',
  DISABLED = 'DISABLED',
}

/** 用于 schema 与直接构造的默认会话共享策略。 */
export const DEFAULT_TELEMETRY_MODE = SessionTelemetryMode.FEEDBACK_ONLY

const DISABLED_FEEDBACK_WARNING = 'OpenTelemetry session upload is DISABLED; this feedback is not uploaded through OpenTelemetry'
const NON_CANONICAL_EVENT_WARNING = 'session telemetry ignored an event absent from the canonical session log'

/** 只有本会话显式的反馈才授权重放；fork 种子不行。 */
function isFeedback(session: Session, event: SessionEvent): boolean {
  if (event.seq < session.inheritedEventCount) return false
  switch (event.type) {
    case 'feedback/record': return true
    case 'feedback/message-put':
    case 'feedback/message-delete': return event.data.sessionId === session.id
    default: return false
  }
}

/** 在传输设置之前解析默认值，并拒绝未知的运行时取值。 */
function resolveMode(mode: SessionTelemetryMode | undefined): SessionTelemetryMode {
  const resolved = mode ?? DEFAULT_TELEMETRY_MODE
  switch (resolved) {
    case SessionTelemetryMode.FEEDBACK_ONLY:
    case SessionTelemetryMode.DISABLED:
      return resolved
    default:
      return assertNever(resolved)
  }
}

/** 当直接构造绕过了运行时配置 schema 时，失败关闭。 */
function assertNever(value: never): never {
  throw new Error(`session-telemetry-otel: unsupported mode ${JSON.stringify(value)}`)
}

/** 把序列化后的模式映射到接缝中、与后端无关的共享词汇。 */
function sharingStatusFor(mode: SessionTelemetryMode): SessionTelemetrySharingStatus {
  switch (mode) {
    case SessionTelemetryMode.FEEDBACK_ONLY: return 'feedback-only'
    case SessionTelemetryMode.DISABLED: return 'disabled'
    /* v8 ignore next 2 -- resolveMode 已在本 switch 之前拒绝未知取值；这个封闭枚举无法到达 default。 */
    default: return assertNever(mode)
  }
}

/**
 * 插件配置：共享策略、SDK 传输选项、字节/计数队列设置，以及一个整体的
 * 关闭上界。上传模式会在插件加载时校验其端点与关闭截止时间；`DISABLED`
 * 两者都不读取。
 */
export interface Config {
  /** 默认为 `FEEDBACK_ONLY`：仅当反馈被显式提交时才捕获会话历史。 */
  mode?: SessionTelemetryMode
  /**
   * 显式的 SDK HTTP 传输设置，包括可选的路由头。不继承环境凭证。上传时
   * URL 为必需。不支持导出器自观测计量。
   */
  exporter?: Omit<LogExporterOptions, 'url'> & {
    /** 完整的日志端点（如 `https://collector.example.com/v1/logs`）。在 `DISABLED`
     * 之外为必需；在加载时校验。 */
    url?: string
  }
  /**
   * 用于有字节边界的处理器的计数、队列、节奏与每请求看门狗设置。看门狗
   * 告警永远不会释放一个未结算的传输槽。不支持 SDK 处理器自观测计量。
   */
  processor?: SessionLogProcessorOptions
  /** 等待 SDK 提供者完整关闭路径所花费的最长时间。 */
  shutdownTimeoutMillis?: number
  /** 未压缩的 OTLP 请求字节上限，至多 4,000,000。 */
  maxRequestBytes?: number
}

/**
 * 针对 {@link Config} 的 Schemastery 校验器；cordis 在插件启动前运行它。
 * 构造函数校验端点与关闭要求；上报器校验会话字节与队列限制。SDK 传输与
 * 处理器设置使用上报器所接受的选项类型，其中排除了自观测计量。
 */
export const Config: z<Config> = z.object({
  mode: z.union(Object.values(SessionTelemetryMode)).default(DEFAULT_TELEMETRY_MODE),
  exporter: z.any(),
  processor: z.any(),
  shutdownTimeoutMillis: z.number(),
  maxRequestBytes: z.number().step(1).min(1).max(4_000_000),
})

/** 供 SDK 完整关闭序列使用的默认外层宽限时间。 */
export const DEFAULT_SHUTDOWN_TIMEOUT_MILLIS = 3_000

// Node 会把更大的定时器延迟钳制为一毫秒。这是一个运行时协议上限，而非
// 部署默认值。
const MAX_TIMER_DELAY_MILLIS = 2_147_483_647

/** 从服务定义的三级词汇到 OTel 严重级别数字的严重级别映射。 */
const SEVERITY: Record<SessionTelemetrySeverity, SeverityNumber> = {
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
}

/**
 * 后端插件——即一次部署加载的唯一入口。它总是注册 `sessionTelemetry` 服务
 * （重复加载会抛出）。`FEEDBACK_ONLY` 接好 SDK 管线与按需的
 * {@link SessionTelemetryCoordinator}；`DISABLED` 不构造任何 SDK 状态，且
 * 只在被记录的反馈仍停留在本地时发出警告。
 */
export class OpenTelemetrySessionBackend extends SessionTelemetryBackend {
  static inject = ['sessions', 'otel']
  static Config = Config

  private readonly provider: SessionLogReporter | undefined
  private readonly shutdownTimeoutMillis: number
  override readonly sharing: SessionTelemetrySharingStatus

  constructor(ctx: Context, config: Config) {
    const mode = resolveMode(config.mode)
    super(ctx)
    this.sharing = sharingStatusFor(mode)
    if (mode === SessionTelemetryMode.DISABLED) {
      this.provider = undefined
      this.shutdownTimeoutMillis = DEFAULT_SHUTDOWN_TIMEOUT_MILLIS
      ctx.on('session/event', (session, event) => {
        if (isFeedback(session, event)) ctx.logger.warn(DISABLED_FEEDBACK_WARNING)
      })
      return
    }

    const url = config.exporter?.url
    if (url === undefined || url.length === 0) {
      throw new Error('session-telemetry-otel: exporter.url is required (the full OTLP logs endpoint)')
    }
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      // 作为配置错误重新抛出：能到达这里的唯一原因是 url 字符串畸形。
      throw new Error(`session-telemetry-otel: exporter.url is not a valid URL: ${JSON.stringify(url)}`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`session-telemetry-otel: exporter.url must be http(s), got ${parsed.protocol}`)
    }
    // 在分配上报器之前拒绝空批次。
    const batchSize = config.processor?.maxExportBatchSize
    if (batchSize !== undefined && (!Number.isInteger(batchSize) || batchSize < 1)) {
      throw new Error(`session-telemetry-otel: processor.maxExportBatchSize must be a positive integer, got ${String(batchSize)}`)
    }
    const shutdownTimeoutMillis = config.shutdownTimeoutMillis ?? DEFAULT_SHUTDOWN_TIMEOUT_MILLIS
    if (!Number.isFinite(shutdownTimeoutMillis) || shutdownTimeoutMillis <= 0 || shutdownTimeoutMillis > MAX_TIMER_DELAY_MILLIS) {
      throw new Error(`session-telemetry-otel: shutdownTimeoutMillis must be a positive finite number no greater than ${MAX_TIMER_DELAY_MILLIS}, got ${String(shutdownTimeoutMillis)}`)
    }
    this.shutdownTimeoutMillis = shutdownTimeoutMillis
    const { version } = createRequire(import.meta.url)('../package.json') as { version: string }
    const reporter = ctx.otel.createSessionLogReporter({
      scope: { name: '@deepseek-ai/dsh-session-telemetry-otel', version },
      exporter: { ...config.exporter, url },
      ...(config.processor === undefined ? {} : { processor: config.processor }),
      ...(config.maxRequestBytes === undefined ? {} : { maxRequestBytes: config.maxRequestBytes }),
      resourceAttributes: {
        'service.name': APP_IDENTITY.product,
        'service.version': APP_IDENTITY.version,
        'user.id': getOrCreateAnonymousUserId(),
      },
      onFailure: (message, error) => { ctx.logger.warn(message, error) },
    })
    this.provider = reporter
    const enqueue: SessionTelemetrySink['emit'] = (record) => {
      if (record.sourceEvent === undefined) {
        ctx.logger.warn('Session log record withheld: redaction removed sourceEvent')
        return
      }
      reporter.reportSessionLog({
        sessionId: record.sourceEvent.sessionId,
        event: { ...record.sourceEvent.envelope, data: record.body },
        severityNumber: SEVERITY[record.severity],
        attributes: record.attributes,
      })
    }
    const backend: SessionTelemetrySink = {
      emit: enqueue,
      shutdown: () => this.shutdown(),
    }
    const coordinator = new SessionTelemetryCoordinator(ctx, backend, {
      capture: 'on-demand',
      includeHistory: true,
    })
    ctx.on('session/event', (session, event) => {
      if (!isFeedback(session, event)) return
      // 只有规范的已追加事件才授权这个精确前缀。
      // oxlint-disable-next-line typescript/no-deprecated -- 读取已有会话历史；迁移已推迟。
      if (session.eventAt(event.seq) !== event) {
        ctx.logger.warn(NON_CANONICAL_EVENT_WARNING)
        return
      }
      coordinator.captureSession(session, event.seq)
    })
    ctx.on('feedback/committed', (inspection) => {
      const snapshot = structuredClone(inspection)
      const committed = snapshot.events.at(-1)
      if (committed === undefined) return
      const session = Session.fromRestore(
        snapshot.meta.id, snapshot.events, snapshot.meta, snapshot.inheritedEventCount,
        'detached', ctx.sessions.messageProjections,
      )
      // fromRestore 会追加一个本次提交并未提交的、生命周期的标记。
      if (isFeedback(session, committed)) coordinator.captureSession(session, committed.seq)
    })
  }

  /**
   * 丢弃直接记录。对任意提供者，只有一次新的规范反馈提交才能通过私有
   * 协调器 sink 授权捕获。
   * @param _record - 直接记录，永不上传。
   */
  emit(_record: SessionTelemetryRecord): void {}

  /**
   * 在部署截止时间之前排空已排队的 HTTP 请求。看门狗永远不会释放一个
   * 未结算的传输槽。到达外层截止时间时，已排队的记录被放弃，且不再有新的
   * 请求可以启动。
   * @returns 在传输关闭之后的完成，或在所配置截止时间处的拒绝。
   */
  async shutdown(): Promise<void> {
    if (this.provider === undefined) return
    const providerShutdown = this.provider.shutdown()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        this.provider?.stopPending()
        reject(new Error(`session-telemetry-otel: provider shutdown exceeded ${this.shutdownTimeoutMillis}ms`))
      }, this.shutdownTimeoutMillis)
    })
    try {
      await Promise.race([providerShutdown, deadline])
    } finally {
      /* v8 ignore else -- Promise 执行器在本 race 开始前同步地分配了 timer。 */
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}

export default OpenTelemetrySessionBackend
