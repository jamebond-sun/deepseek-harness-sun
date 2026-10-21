/** 基于可取消 HTTP 传输的普通事件 SDK 批处理。 */
import type { Attributes } from '@opentelemetry/api'
import { addAbortListener } from 'node:events'
import { SeverityNumber, type Logger } from '@opentelemetry/api-logs'
import { ExportResultCode } from '@opentelemetry/core'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs'
import type { BatchLogRecordProcessorOptions, LogRecordExporter } from '@opentelemetry/sdk-logs'
import type { SessionLogOptions } from './session-log.ts'
import { createEventLogExporter } from './event-transport.ts'
import type { LogExporterOptions } from './transport.ts'

/** 收集器 Arrow 属性映射所接受的标量值。 */
export type OTelEventScalar = string | number | boolean

/** 显式选择的统计字段；对象值仅可包含标量。 */
export interface OTelEventRecord {
  /** 产品或数据分析（DA）所属的事件名称。 */
  eventName: string
  /** 人类可读的摘要；绝不可以是提示词、回复、凭据或文件内容。 */
  body: string
  /** 事件发生的 Unix 毫秒时间戳。观测时间在入队时赋值。 */
  timestamp: number
  /** OTel 严重级别；省略时使用 INFO。 */
  severityNumber?: SeverityNumber
  /** 由调用方选择的业务字段；不自动附加设备或账户身份信息。 */
  attributes?: Record<string, OTelEventScalar | Record<string, OTelEventScalar>>
}

/** 普通事件的传输、资源、作用域与计数批处理选项。 */
export interface EventLogOptions {
  exporter: LogExporterOptions
  resourceAttributes: Attributes
  scope: { name: string; version?: string }
  processor: Omit<BatchLogRecordProcessorOptions, 'exporter'>
  onFailure: SessionLogOptions['onFailure']
}

/** 由调用方拥有的一条普通事件队列，独立于所有会话日志队列。 */
export class EventLogReporter {
  private readonly exporter: LogRecordExporter
  private readonly provider: LoggerProvider
  private readonly logger: Logger
  private readonly cancellation = new AbortController()

  /** @param options - 显式的传输、资源、作用域、队列与诊断设置。 */
  constructor(options: EventLogOptions) {
    const exporter = createEventLogExporter(options.exporter, this.cancellation.signal)
    this.exporter = exporter
    this.provider = new LoggerProvider({
      resource: resourceFromAttributes(options.resourceAttributes),
      processors: [new BatchLogRecordProcessor({
        ...options.processor,
        exporter: {
          export: (records, callback) => {
            exporter.export(records, (result) => {
              if (result.code !== ExportResultCode.SUCCESS) options.onFailure('Product telemetry export failed', result.error)
              callback(result)
            })
          },
          forceFlush: () => exporter.forceFlush(),
          shutdown: () => exporter.shutdown(),
        },
      })],
    })
    this.logger = this.provider.getLogger(options.scope.name, options.scope.version)
  }

  /**
   * 入队由调用方选择的统计字段，但不确认投递结果。
   * @param record - 要上报的普通事件。
   */
  emit(record: OTelEventRecord): void {
    const severityNumber = record.severityNumber ?? SeverityNumber.INFO
    this.logger.emit({ ...record, observedTimestamp: Date.now(), severityNumber, severityText: SeverityNumber[severityNumber] })
  }

  /**
   * 排空队列并释放其传输；调用方中止时取消剩余的导出。
   * @param signal - 可选的关闭截止信号；中止会丢弃待导出的内容并取消重试等待。
   * @returns SDK 关闭与传输清理的完成结果。
   */
  async shutdown(signal?: AbortSignal): Promise<void> {
    const abort = (): void => { this.cancellation.abort(signal?.reason) }
    const listener = signal === undefined ? undefined : addAbortListener(signal, abort)
    if (signal?.aborted) abort()
    try { await this.provider.shutdown() }
    finally {
      // SDK 批处理关闭可能在释放导出器之前就 reject。
      try { await this.exporter.shutdown() }
      finally { listener?.[Symbol.dispose]() }
    }
  }
}
