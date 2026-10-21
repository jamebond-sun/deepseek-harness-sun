/** 面向共享 Cordis OTel 服务的产品分析策略适配器。 */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { validateHeaderValue } from 'node:http'
import { CompressionAlgorithm } from '@opentelemetry/otlp-exporter-base'
import type { EventLogReporter, OTelEventRecord, OTelEventScalar } from '@deepseek-ai/dsh-otel'

declare module '@deepseek-ai/cordis' {
  interface Context { productTelemetry: ProductTelemetry }
}

/** 调用方选择的普通分析记录。 */
export type ProductTelemetryRecord = OTelEventRecord
/** 产品属性中接受的标量值。 */
export type ProductTelemetryScalar = OTelEventScalar

/** 采集端路由、应用身份与有界内存批设置。 */
export interface Config {
  /** 完整的 HTTP(S) logs URL。 */
  endpoint: string
  /** 采集端路由头。 */
  channel: string
  /** 由应用组合提供的 resource service.name。 */
  serviceName: string
  /** 由应用组合提供的 resource service.version。 */
  serviceVersion: string
  /** 省略时遵循 OTEL_EXPORTER_OTLP_LOGS_COMPRESSION / OTEL_EXPORTER_OTLP_COMPRESSION。 */
  compression?: 'none' | 'gzip'
  /** 每次导出最多记录数；不得超过 maxQueueSize。 */
  maxExportBatchSize: number
  /** 最多排队记录数；队列满时 SDK 丢弃新记录。 */
  maxQueueSize: number
  /** 导出部分批次前的延迟。 */
  scheduledDelayMillis: number
  /** 导出器的 HTTP 时限，含 SDK 的瞬时错误重试。 */
  timeoutMillis: number
  /** 单次批导出的 processor 时限。 */
  exportTimeoutMillis: number
  /** 排空时限；超时会在卸载完成前取消挂起的导出。 */
  shutdownTimeoutMillis: number
}

const positiveInteger = () => z.number().step(1).min(1).max(2_147_483_647)

/** 供应用组合使用的 Loader 校验与默认值。 */
export const Config: z<Partial<Config>, Config> = z.object({
  endpoint: z.string().default('https://dsh-otel-collector.deepseeksvc.com/v1/logs'),
  channel: z.string().min(1).default('dsh_otel_report'),
  serviceName: z.string().required(),
  serviceVersion: z.string().required(),
  compression: z.union(['none', 'gzip']),
  maxExportBatchSize: positiveInteger().default(512),
  maxQueueSize: positiveInteger().default(2048),
  scheduledDelayMillis: positiveInteger().default(30000),
  timeoutMillis: positiveInteger().default(15000),
  exportTimeoutMillis: positiveInteger().default(20000),
  shutdownTimeoutMillis: positiveInteger().default(21000),
})

/** 宿主侧分析发送器。仅挂载不会发送任何东西；所属 fiber 在卸载时将其排空。 */
export default class ProductTelemetry extends Service {
  static inject = ['otel']
  static Config = Config
  private readonly reporter: EventLogReporter

  constructor(ctx: Context, config: Config) {
    let endpoint: URL
    try {
      endpoint = new URL(config.endpoint)
    } catch (cause) {
      throw new Error('product-telemetry-otel: endpoint must be a valid HTTP(S) URL', { cause })
    }
    try {
      validateHeaderValue('x-channel', config.channel)
    } catch (cause) {
      throw new Error('product-telemetry-otel: channel must be a valid HTTP header value', { cause })
    }
    if (!['http:', 'https:'].includes(endpoint.protocol)) {
      throw new Error('product-telemetry-otel: endpoint must use HTTP or HTTPS')
    }
    if (config.maxExportBatchSize > config.maxQueueSize) {
      throw new Error('product-telemetry-otel: maxExportBatchSize must not exceed maxQueueSize')
    }
    super(ctx, 'productTelemetry')
    const reporter = ctx.otel.createEventReporter({
      exporter: {
        url: config.endpoint, headers: { 'x-channel': config.channel }, timeoutMillis: config.timeoutMillis,
        ...(config.compression === undefined ? {} : { compression: config.compression === 'gzip' ? CompressionAlgorithm.GZIP : CompressionAlgorithm.NONE }),
      },
      resourceAttributes: { 'service.name': config.serviceName, 'service.version': config.serviceVersion },
      scope: { name: '@deepseek-ai/dsh-host-product-telemetry-otel' },
      processor: {
        maxExportBatchSize: config.maxExportBatchSize, maxQueueSize: config.maxQueueSize,
        scheduledDelayMillis: config.scheduledDelayMillis, exportTimeoutMillis: config.exportTimeoutMillis,
      },
      onFailure: (message, error) => { ctx.logger.warn(message, error) },
    })
    this.reporter = reporter
    ctx.effect(() => async () => {
      const cancellation = new AbortController()
      const timer = setTimeout(() => {
        ctx.logger.warn('Product telemetry shutdown deadline exceeded; pending events may be lost')
        cancellation.abort(new Error('Product telemetry shutdown deadline exceeded'))
      }, config.shutdownTimeoutMillis)
      try {
        await reporter.shutdown(cancellation.signal)
      } finally {
        clearTimeout(timer)
      }
    })
  }

  /**
   * 入队一条被选中的产品事件，不等待网络投递。入队成功与关闭完成都不是采集端或数仓的
   * 确认。
   * @param record - 调用方自有的事件，仅包含已批准的分析字段。
   */
  emit(record: ProductTelemetryRecord): void {
    this.reporter.emit(record)
  }
}
