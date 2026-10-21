/** 经授权的 Office 输入与完整的 PDF 输出，供共享的 Host 转换器使用。 */
import type { WorkspaceFileBytes } from '@deepseek-ai/dsh-api-workspace-files/types'
import type {} from '@deepseek-ai/dsh-typert-protocol'
import type { OfficeSourceKey, OfficeToPdfGeneration, OfficeToPdfKey } from './identity.ts'
export type { OfficeSourceKey, OfficeToPdfGeneration, OfficeToPdfKey } from './identity.ts'

/** Office-to-PDF 转换所支持的二进制 Office 与 Office Open XML 格式。 */
export type OfficeExtension = 'doc' | 'docx' | 'xls' | 'xlsx' | 'ppt' | 'pptx'

/** 前台预览与显式质量校验先于推测性的后台转换。 */
export type OfficeToPdfPriority = 'foreground' | 'background'

/** 源授权与元数据查询必须在提交请求之前完成。 */
export interface OfficeToPdfRequest {
  readonly extension: OfficeExtension
  readonly priority: OfficeToPdfPriority
  readonly source: {
    readonly key: OfficeSourceKey
    readonly version: string
    /** 经授权的 stat 大小；省略则预留提供方的整个输入上限。 */
    readonly bytes?: number
    /**
     * 仅在提供方接纳之后读取；不要在已排队的转换请求中捕获已缓冲的输入。
     * @param signal - 共享的转换生命周期，独立于单个读取器。
     * @param maxBytes - 预留的源容量；最多读取此值外加一个溢出哨兵字节。
     * @returns 自有字节与实际读取的版本；版本变化会拒绝转换。
     */
    read(signal: AbortSignal, maxBytes: number): Promise<{ readonly bytes: Uint8Array; readonly version: string }>
  }
}

/** 转换成功；失败与中断的转换则改为拒绝。 */
export interface OfficeToPdfResult {
  /** 调用方拥有的完整 PDF，在提供方释放之后仍有效。 */
  readonly pdf: Uint8Array
  /** 本次转换不可用的、所请求的 OOXML 字体系列；二进制 Office 格式返回空列表。 */
  readonly missingFonts: string[]
  readonly cacheKey: OfficeToPdfKey
  readonly generation: OfficeToPdfGeneration
}

/** 转换的消费者可在不暴露引擎诊断信息的情况下呈现的失败。 */
export type OfficeToPdfErrorCode =
  | 'input-too-large' | 'output-too-large' | 'invalid-document' | 'unsupported-format'
  | 'invalid-output' | 'timeout' | 'unavailable' | 'failed' | 'busy' | 'source-changed'

/** PDF 内容携带原始 Office 文件的标识，以及经多段传输的字节。 */
export interface RenderedDocumentBytes extends WorkspaceFileBytes {
  readonly missingFonts: string[]
  readonly generation: OfficeToPdfGeneration
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** 源已授权，但其转换失败。 */
    'document-render/failed': { readonly reason: OfficeToPdfErrorCode }
  }
}
