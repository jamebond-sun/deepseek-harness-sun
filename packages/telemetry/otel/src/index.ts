/** 独立普通事件与会话日志 OTLP 通道的 Cordis 入口。 */
import { Context, Service } from '@deepseek-ai/cordis'
import { EventLogReporter, type EventLogOptions } from './event-log.ts'
import { SessionLogReporter, type SessionLogOptions } from './session-log.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    otel: OTel
  }
}

/** 共享传输提供方。挂载时不创建队列、身份或网络连接。 */
export default class OTel extends Service {
  constructor(ctx: Context) { super(ctx, 'otel') }

  /**
   * 创建一个基于计数的批处理的独立普通事件通道。
   * 注入的消费方必须在其纤程处置期间将其排空。
   * @param options - 由消费方选择的传输、作用域、资源、队列与诊断设置。
   * @returns 由调用方拥有的通道；不与其他通道共享任何状态。
   */
  createEventReporter(options: EventLogOptions): EventLogReporter { return new EventLogReporter(options) }

  /**
   * 创建一个独立的、受字节上限约束的会话日志通道。
   * 上报前需先完成授权与脱敏；消费方拥有关闭行为及其外部截止时间。
   * @param options - 由消费方选择的传输、作用域、资源、队列与诊断设置。
   * @returns 由调用方拥有的通道，在请求字节上限内保留完整的已接受事件。
   */
  createSessionLogReporter(options: SessionLogOptions): SessionLogReporter { return new SessionLogReporter(options) }
}

export type { EventLogOptions, OTelEventRecord, OTelEventScalar, EventLogReporter } from './event-log.ts'
export type { SessionLogProcessorOptions, SessionLogRecord, SessionLogOptions, SessionLogReporter } from './session-log.ts'
export type { LogExporterOptions } from './transport.ts'
