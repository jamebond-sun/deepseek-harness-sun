/** 面向 Agent 范围文件引用发现的 Session Controller 适配器。 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-file-reference'
import type { FileReferenceCandidate } from '@deepseek-ai/dsh-file-reference/types'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** `fileReferences` Remote 命名空间的 Host 拥有者。 */
    sessionFileReferences: SessionFileReferences
  }
}

/** 组合文件引用提供方之上的 Host Remote 适配器。 */
export class SessionFileReferences extends TypertRemoteService {
  static inject = ['fileReferences', 'typert']

  /** @param ctx - 携带所选文件引用提供方的 Host 上下文。 */
  constructor(ctx: Context) {
    super(ctx, 'sessionFileReferences', { namespace: 'fileReferences' })
  }

  /**
   * 列出一个 Agent 工作目录的文件与目录候选。
   * @param agent - 从 wire 上的 Session 标识解析出的目标 Agent。
   * @param query - 跟在 `@` 或 `@"` 之后的路径文本。
   * @param signal - 调用方取消。
   * @returns 来自组合提供方的确定性仅路径候选。
   */
  @Remote
  list(
    agent: Agent,
    query: string,
    signal: AbortSignal,
  ): Promise<FileReferenceCandidate[]> {
    return this.ctx.fileReferences.list(agent, query, signal)
  }
}

export default SessionFileReferences
