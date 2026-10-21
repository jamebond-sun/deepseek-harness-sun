/** 由 present 工具产生的持久化文件交付物。 */
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'

/** 一个被声明的文件系统文件，其当前内容仍保留在源路径处。 */
export interface PresentedFile {
  /** 原始绝对路径，或相对于 Session 工作目录的路径。 */
  path: string
  /** 由模型提供的可选描述。 */
  description?: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** 来自一次成功的最终 present 结果的、已声明的文件系统文件，包含嵌套调用。 */
    'deliverables/presented': { turn: number; callId: ToolCallId; files: PresentedFile[] }
  }
}
