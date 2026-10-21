/** 可取消的普通事件 HTTP 导出，包含重试等待与响应读取。 */
import type { Agent as HttpsAgent } from 'node:https'
import { gzipSync } from 'node:zlib'
import got from 'got'
import { createOtlpNetworkExportDelegate, OTLPExporterBase } from '@opentelemetry/otlp-exporter-base'
import { JsonLogsSerializer } from '@opentelemetry/otlp-transformer'
import type { LogRecordExporter } from '@opentelemetry/sdk-logs'
import { createLogExporterMetrics, type LogExporterOptions, logTransportOptions } from './transport.ts'

/**
 * 创建一个由通道拥有的导出器，其取消会释放请求与重试计时器。
 * @param options - 显式的收集器与 SDK HTTP 设置。
 * @param signal - 通道取消信号，由当前及未来的批量导出共享。
 * @returns SDK 导出器；关闭时也会销毁其所拥有的 HTTP agent。
 */
export function createEventLogExporter(options: LogExporterOptions, signal: AbortSignal): LogRecordExporter {
  const config = logTransportOptions(options)
  let agent: ReturnType<typeof config.agentFactory> | undefined
  const exporter = new OTLPExporterBase(createOtlpNetworkExportDelegate(config, JsonLogsSerializer, createLogExporterMetrics(config.url), {
    async send(data, timeoutMillis) {
      signal.throwIfAborted()
      agent ??= config.agentFactory(new URL(config.url).protocol)
      const selectedAgent = await agent
      const headers = await config.headers()
      signal.throwIfAborted()
      const compressed = config.compression === 'gzip'
      const request = got.post(config.url, {
        body: compressed ? gzipSync(data) : Buffer.from(data),
        headers: { ...headers, ...(compressed ? { 'content-encoding': 'gzip' } : {}),
          ...(config.userAgent === undefined ? {} : { 'user-agent': config.userAgent }) },
        agent: new URL(config.url).protocol === 'https:' ? { https: selectedAgent as HttpsAgent } : { http: selectedAgent },
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMillis)]),
        followRedirect: false,
        retry: { limit: 5, methods: ['POST'], statusCodes: [429, 502, 503, 504], errorCodes: [], backoffLimit: 5000 },
        responseType: 'buffer',
      })
      // 匹配 SDK 的 OTLP 响应体大小限制，包含分块响应。
      void request.on('downloadProgress', ({ transferred }) => { if (transferred > 4 * 1024 * 1024) request.cancel() })
      const response = await request
      if (response.statusCode >= 300) throw new Error(`OTLP collector returned HTTP ${response.statusCode}`)
      return { status: 'success', data: response.body }
    },
    shutdown() { /* The exporter awaits agent cleanup below. */ },
  }))
  let shutdown: Promise<void> | undefined
  return {
    export: (records, callback) => { exporter.export(records, callback) },
    forceFlush: () => exporter.forceFlush(),
    shutdown() {
      shutdown ??= (async () => {
        try { await exporter.shutdown() }
        finally { (await agent)?.destroy() }
      })()
      return shutdown
    },
  }
}
