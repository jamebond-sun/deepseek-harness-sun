/** 会话引用的配置与稳定诊断信息。 */

/** 一条消息可接受的最大引用数硬性上限。 */
export const MAX_REFERENCES = 3
/** 返回给宿主的、默认的发现候选数量。 */
export const DEFAULT_CANDIDATE_LIMIT = 50
/** 渲染单个引用 JSON 对象的、自动 UTF-8 预算下限。 */
export const DEFAULT_MAX_REFERENCE_BYTES = 65_536

/** 会话引用服务配置。 */
export interface Config {
  /** 一条消息所引用的最大不同源会话数，取值一到三。 */
  maxReferences?: number
  /** 宿主候选列表的默认上限。 */
  candidateLimit?: number
  /** 每个源的、显式的最大渲染 UTF-8 字节数；省略则使用模型相对预算，并带有 64 KiB 下限。 */
  maxReferenceBytes?: number
  /** 每个源占模型上下文窗口的比例，按每 token 四字节估算；介于零与一之间。 */
  referenceContextFraction?: number
}

/** 暴露给宿主适配器的稳定失败码。 */
export type SessionReferenceErrorCode =
  | 'SESSION_REFERENCE_INVALID_CONFIG'
  | 'SESSION_REFERENCE_INVALID_REFERENCE'
  | 'SESSION_REFERENCE_SELF_REFERENCE'
  | 'SESSION_REFERENCE_TOO_MANY'
  | 'SESSION_REFERENCE_READ_FAILED'
  | 'SESSION_REFERENCE_BUDGET_EXCEEDED'
  | 'SESSION_REFERENCE_CANCELLED'

/** 适合用于宿主协议错误映射的类型化会话引用失败。 */
export class SessionReferenceError extends Error {
  /** @param message 人类可读的诊断信息。 @param code 稳定的路由码。 @param options 可选的原因。 */
  constructor(
    message: string,
    readonly code: SessionReferenceErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'SessionReferenceError'
  }
}
