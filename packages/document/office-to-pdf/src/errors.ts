/** 转换及其消费者共享的分类失败。 */
import type { OfficeToPdfErrorCode } from './types.ts'

/** 分类后的转换失败；引擎细节保留在 cause 中。 */
export class OfficeToPdfError extends Error {
  /**
   * @param code - 适用于转换消费者的类别。
   * @param message - 解释转换失败的诊断信息。
   * @param options - 底层的引擎或文件系统失败。
   */
  constructor(readonly code: OfficeToPdfErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'OfficeToPdfError'
  }
}
