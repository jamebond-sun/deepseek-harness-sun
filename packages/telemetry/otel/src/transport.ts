/** 面向经反馈授权的会话日志的显式 OTLP JSON 传输。 */
import { createOtlpHttpExportDelegate, createOtlpHttpExporterMetrics, getSharedConfigurationFromEnvironment, httpAgentFactoryFromOptions } from '@opentelemetry/otlp-exporter-base/node-http'
import { type ExporterMetrics, getSharedConfigurationDefaults, mergeOtlpSharedConfigurationWithDefaults, OTLPExporterBase, type OTLPExporterNodeConfigBase } from '@opentelemetry/otlp-exporter-base'
import { JsonLogsSerializer, LogsExporterMetricsHelper } from '@opentelemetry/otlp-transformer'
import type { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs'

/** 由 OTLP HTTP 日志导出器自观测指标上报的 `otel.component.type`。 */
const OTLP_HTTP_LOG_EXPORTER_COMPONENT_TYPE = 'otlp_http_log_exporter'

/**
 * 本包的日志导出器所接受的收集器与 SDK HTTP 设置。
 *
 * 已排除 `OTLPExporterConfigBase.selfObsMeterProvider`：此处的每个通道
 * 都不向导出器指标记录器传递计量提供方，因而保持 noop。
 */
export type LogExporterOptions = Omit<OTLPExporterNodeConfigBase, 'selfObsMeterProvider'> & {
  /** 完整的 HTTP(S) 日志上报地址。 */
  url: string
}

/**
 * 创建一个 SDK JSON 导出器，且不继承其他收集器的请求头或 TLS 身份。
 * @param options - 显式的端点、请求头、agent 与 SDK 传输设置。
 * @returns 由单一独立日志流水线拥有的导出器。
 */
export function createLogExporter(options: LogExporterOptions): LogRecordExporter {
  return new OTLPExporterBase(createOtlpHttpExportDelegate(
    logTransportOptions(options), JsonLogsSerializer, OTLP_HTTP_LOG_EXPORTER_COMPONENT_TYPE, LogsExporterMetricsHelper, undefined))
}

/**
 * 创建一个日志导出器的自观测指标；若无计量提供方则什么都不记录。
 * @param url - 作为指标服务器地址与端口记录的收集器端点。
 * @returns OTLP HTTP 日志导出委托所需的指标记录器。
 */
export function createLogExporterMetrics(url: string): ExporterMetrics<ReadableLogRecord[]> {
  return createOtlpHttpExporterMetrics(OTLP_HTTP_LOG_EXPORTER_COMPONENT_TYPE, LogsExporterMetricsHelper, url, undefined)
}

/**
 * 解析收集器本地的请求头与 agent，使用共享的 SDK 超时与压缩默认值。
 * @param options - 显式的端点与 SDK HTTP 设置。
 * @returns 不含环境凭据的已解析传输设置。
 */
export function logTransportOptions(
  options: LogExporterOptions,
): Parameters<typeof createOtlpHttpExportDelegate>[0] {
  const shared = mergeOtlpSharedConfigurationWithDefaults(options, getSharedConfigurationFromEnvironment('LOGS'), getSharedConfigurationDefaults())
  return {
    ...shared,
    url: options.url,
    headers: async () => ({
      'Content-Type': 'application/json',
      ...typeof options.headers === 'function' ? await options.headers() : options.headers,
    }),
    // agent 工厂拥有返回的 agent，包括其 keepAlive 设置。
    agentFactory: typeof options.httpAgentOptions === 'function' ? options.httpAgentOptions
      : httpAgentFactoryFromOptions({ keepAlive: options.keepAlive ?? true, ...options.httpAgentOptions }),
    ...(options.userAgent === undefined ? {} : { userAgent: options.userAgent }),
  }
}
