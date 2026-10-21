/** 处于独立、受字节上限约束的 OTLP 队列中的会话日志记录。 */
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { Attributes } from '@opentelemetry/api'
import { SeverityNumber } from '@opentelemetry/api-logs'
import { ExportResultCode } from '@opentelemetry/core'
import { JsonLogsSerializer } from '@opentelemetry/otlp-transformer'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { LoggerProvider, type BatchLogRecordProcessorOptions, type LogRecordExporter, type ReadableLogRecord, type LogRecordProcessor } from '@opentelemetry/sdk-logs'
import { createLogExporter, type LogExporterOptions } from './transport.ts'

/** 收集器请求上限（未压缩的 UTF-8 字节数），包含 OTLP 信封。 */
export const SESSION_LOG_MAX_REQUEST_BYTES = 4_000_000

/** 一条规范事件，其会话身份与脱敏后的负载分别独立拥有。 */
export interface SessionLogRecord {
  sessionId: SessionId
  /** 完整的事件信封；data 为捕获策略导出的副本。 */
  event: Omit<SessionEvent, 'data'> & { data: unknown }
  /** 额外的捕获元数据；sessionId 与 content 始终由上报方赋值。 */
  attributes?: Attributes
  /** 省略时使用 INFO。 */
  severityNumber?: SeverityNumber
}

/**
 * 由 {@link SessionLogProcessor} 实现的字节与计数批处理字段。
 *
 * `exporter` 属于所属通道，而 `selfObsMeterProvider` 被排除，
 * 因为该处理器未实现自观测计量。
 */
export type SessionLogProcessorOptions = Omit<BatchLogRecordProcessorOptions, 'exporter' | 'selfObsMeterProvider'>

/** 会话日志的传输与字节/计数队列设置。 */
export interface SessionLogOptions {
  /** 显式目标与 SDK 传输设置；导出器不支持自观测计量。 */
  exporter: LogExporterOptions
  /** 仅会话的队列设置，独立于产品事件聚合。 */
  processor?: SessionLogProcessorOptions
  /** 可以降低，但绝不能超过收集器的 4,000,000 字节上限。 */
  maxRequestBytes?: number
  /** 由业务方提供的埋点作用域。 */
  scope: { name: string; version?: string }
  /** 承载于 OTLP 资源上的应用与匿名身份。 */
  resourceAttributes: Attributes
  /** 上报被拒绝的单条记录与网络失败，但不记录其内容。 */
  onFailure: (message: string, error?: Error) => void
}

/**
 * 在构建 SDK 流水线之前校验字节与队列设置。
 * @param options - 由所属组合提供的会话专属限制。
 * @returns 解析后的收集器请求上限。
 */
export function resolveSessionLogLimits(options: Pick<SessionLogOptions, 'maxRequestBytes' | 'processor'>): number {
  const limit = options.maxRequestBytes ?? SESSION_LOG_MAX_REQUEST_BYTES
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SESSION_LOG_MAX_REQUEST_BYTES) {
    throw new Error(`session log maxRequestBytes must be an integer between 1 and ${SESSION_LOG_MAX_REQUEST_BYTES}`)
  }
  for (const key of ['maxQueueSize', 'maxExportBatchSize', 'scheduledDelayMillis', 'exportTimeoutMillis'] as const) {
    const value = options.processor?.[key]
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)) {
      throw new Error(`session log processor.${key} must be a positive integer no greater than 2147483647`)
    }
  }
  const queue = options.processor?.maxQueueSize ?? 2048
  const batch = options.processor?.maxExportBatchSize ?? 512
  if (batch > queue) throw new Error('session log maxExportBatchSize must not exceed maxQueueSize')
  return limit
}

/** 字节/计数批处理，仅允许一个传输请求在途，包括看门狗告警之后。 */
class SessionLogProcessor implements LogRecordProcessor {
  private readonly queue: { record: ReadableLogRecord; bytes: number }[] = []
  private bytes = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private active: Promise<void> | undefined
  private shutdownPromise: Promise<void> | undefined
  private stopped = false

  constructor(
    private readonly exporter: LogRecordExporter,
    private readonly limit: number,
    private readonly config: Required<Pick<SessionLogProcessorOptions, 'maxQueueSize' | 'maxExportBatchSize' | 'scheduledDelayMillis' | 'exportTimeoutMillis'>>,
    private readonly warn: SessionLogOptions['onFailure'],
  ) {}

  onEmit(record: ReadableLogRecord): void {
    if (this.stopped) return
    if (this.queue.length >= this.config.maxQueueSize) {
      this.warn('Session log queue is full; record rejected')
      return
    }
    let bytes: number
    try {
      const serialized = JsonLogsSerializer.serializeRequest([record])
      if (serialized === undefined) throw new Error('Session log serialization produced no request')
      bytes = serialized.byteLength
    } catch (error) {
      this.warn('Session log serialization failed; record rejected', error instanceof Error ? error : new Error(String(error)))
      return
    }
    if (bytes > this.limit) {
      this.warn('Session log record rejected; content was not truncated', new Error(`Session log record exceeds maxRequestBytes: ${bytes} > ${this.limit}`))
      return
    }
    this.queue.push({ record, bytes })
    this.bytes += bytes
    if (this.active !== undefined) return
    if (this.queue.length >= this.config.maxExportBatchSize || this.bytes >= this.limit) {
      void this.forceFlush()
    } else if (this.timer === undefined) {
      this.timer = setTimeout(() => { void this.forceFlush() }, this.config.scheduledDelayMillis)
      this.timer.unref()
    }
  }

  forceFlush(): Promise<void> {
    clearTimeout(this.timer)
    this.timer = undefined
    if (this.active !== undefined) return this.active
    if (this.queue.length === 0) return Promise.resolve()
    this.active = this.drain()
    return this.active
  }

  private async drain(): Promise<void> {
    try {
      while (!this.stopped && this.queue.length > 0) {
        let bytes = 0
        let count = 0
        for (const entry of this.queue) {
          if (count === this.config.maxExportBatchSize || bytes + entry.bytes > this.limit) break
          bytes += entry.bytes
          count++
        }
        // 每个被计量的记录都包含其资源/作用域信封。该 provider 多记录请求中
        // 共享的信封不会超过它们之和。
        const records = this.queue.splice(0, count).map(entry => entry.record)
        this.bytes -= bytes
        await this.send(records)
        // 导出回调先于从 SDK 并发队列中移除。
        await this.exporter.forceFlush()
      }
    } finally { this.active = undefined }
  }

  private send(records: ReadableLogRecord[]): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.warn('Session log request exceeded exportTimeoutMillis; waiting for transport settlement')
      }, this.config.exportTimeoutMillis)
      timer.unref()
      const finish = (error?: Error): void => {
        clearTimeout(timer)
        if (error !== undefined) this.warn('Session log export failed', error)
        resolve()
      }
      try {
        this.exporter.export(records, (result) => {
          finish(result.code === ExportResultCode.SUCCESS
            ? undefined : result.error ?? new Error('Session log HTTP export failed'))
        })
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  stopPending(): void {
    this.stopped = true
    this.queue.length = 0
    this.bytes = 0
    clearTimeout(this.timer)
    this.timer = undefined
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.forceFlush().then(() => this.exporter.shutdown())
    return this.shutdownPromise
  }
}

/** 拥有经反馈授权的会话日志；不挂载任何产品事件提供方或队列。 */
export class SessionLogReporter {
  private readonly provider: LoggerProvider
  private readonly processor: SessionLogProcessor
  private readonly logger: ReturnType<LoggerProvider['getLogger']>

  /** @param options - 显式的传输、资源身份、队列上限与诊断设置。 */
  constructor(options: SessionLogOptions) {
    const limit = resolveSessionLogLimits(options)
    this.processor = new SessionLogProcessor(createLogExporter(options.exporter), limit, {
      maxQueueSize: options.processor?.maxQueueSize ?? 2048,
      maxExportBatchSize: options.processor?.maxExportBatchSize ?? 512,
      scheduledDelayMillis: options.processor?.scheduledDelayMillis ?? 1000,
      exportTimeoutMillis: options.processor?.exportTimeoutMillis ?? 30000,
    }, options.onFailure)
    this.provider = new LoggerProvider({
      logRecordLimits: { attributeValueLengthLimit: Infinity, attributeCountLimit: Infinity },
      resource: resourceFromAttributes(options.resourceAttributes),
      processors: [this.processor],
    })
    this.logger = this.provider.getLogger(options.scope.name, options.scope.version)
  }

  /**
   * 入队一条完整事件，但不确认网络投递。
   * @param record - 已脱敏数据及其原始会话 id 的事件。
   */
  reportSessionLog(record: SessionLogRecord): void {
    const severityNumber = record.severityNumber ?? SeverityNumber.INFO
    this.logger.emit({
      eventName: 'session-log', body: 'session-log',
      timestamp: record.event.time, observedTimestamp: record.event.time,
      severityNumber, severityText: SeverityNumber[severityNumber],
      attributes: { ...record.attributes, sessionId: record.sessionId, content: JSON.stringify(record.event) },
    })
  }

  /** 在所属后端的关闭截止时间后停止排队的请求；在途传输仍可能完成结算。 */
  stopPending(): void { this.processor.stopPending() }

  /**
   * 排空排队的请求并释放 SDK 传输。
   * @returns 排队请求结算完成且 SDK 传输关闭后的结果。
   */
  shutdown(): Promise<void> { return this.provider.shutdown() }
}
