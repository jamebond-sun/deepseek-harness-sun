/** 所有者、Gateway 与消费者共享的唯一 Remote 失败类。 */

import type { RemoteErrorCode, RemoteErrorDetailsMap, RemoteFailure } from './types.ts'

/**
 * 一次 Remote 调用失败：一个携带稳定 code 与类型化 details 的真实 Error。
 * 所有者在失败点抛出它；Host Gateway 原样编码到传输线上；Client 端为
 * `RemoteResult` 的错误分支重建一个实例，因此 `throw result.error` 保持抛出语义。
 * 一律按 `code` 区分，绝不按 instanceof。
 */
export class RemoteError<Code extends RemoteErrorCode = RemoteErrorCode> extends Error {
  /** 结构标记：跨 realm/打包的识别绝不依赖 instanceof。 */
  readonly isDSHRemoteError: true = true

  /**
   * @param code - 在 {@link RemoteErrorDetailsMap} 中声明的稳定失败码。
   * @param message - 跨传输线携带的人工诊断信息。
   * @param details - 由 code 确定类型的结构化负载。
   * @param options - 标准 Error 选项（`cause` 仅在进程内保留）。
   */
  constructor(
    readonly code: Code,
    message: string,
    readonly details: RemoteErrorDetailsMap[Code],
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'RemoteError'
  }
}

/**
 * 结构性地识别由此类的模块副本或 realm 副本抛出的 RemoteError。
 * 机制内部使用：Gateway 与测试断言会使用它；业务代码收到的是类型化失败，无需使用它。
 * @param value - 被捕获的值。
 * @returns 当标记匹配时的失败对象，否则为 undefined。
 */
export function remoteErrorOf(value: unknown): RemoteFailure | undefined {
  // 结构性而非 instanceof：在另一个 realm（iframe、VM）中抛出的 Error
  // 在此处无法通过 instanceof Error 判定，因此以标记加 code 字段作为判定依据。
  if (typeof value === 'object' && value !== null
    && (value as { isDSHRemoteError?: unknown }).isDSHRemoteError === true
    && typeof (value as { code?: unknown }).code === 'string') {
    return value as RemoteFailure
  }
  return undefined
}
