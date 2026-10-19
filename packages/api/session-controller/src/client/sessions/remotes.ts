/**
 * Session 集群调用的 Remote 命名空间。一个参数对应一个概念：
 * Session 及其 manager 到达 Host 所经由的生成接口面。
 *
 * @module @deepseek-ai/dsh-api-session-controller/client/sessions/remotes
 */

import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type { CommandSubmitAttachment } from '@deepseek-ai/dsh-commands/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  SubagentInterruptReceipt, SubagentPromptReceipt, SubagentPromptRequest,
} from '@deepseek-ai/dsh-subagent/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionRemote } from '../transport.ts'

/** Client Session 消费的窄化 Commands 命名空间。 */
export interface SessionCommandsRemote {
  execute(
    agentId: SessionId,
    line: string,
    attachments: readonly CommandSubmitAttachment[],
    signal?: AbortSignal,
  ): Promise<RemoteResult<object | undefined>>
}

/** Client Session 及其 manager 消费的窄化 subagent 命名空间。 */
export interface SessionSubagentsRemote {
  prompt(
    request: SubagentPromptRequest,
    signal?: AbortSignal,
  ): Promise<RemoteResult<SubagentPromptReceipt>>
  interruptByParent(
    childSessionId: SessionId,
    parentSessionId: SessionId,
    mode: 'continuable',
  ): Promise<RemoteResult<SubagentInterruptReceipt>>
}

/** Client Session 对象层消费的生成 Remote 命名空间。 */
export interface SessionRemotes {
  readonly $stream: ClientRemote['$stream']
  readonly commands: SessionCommandsRemote
  readonly session: SessionRemote
  readonly subagents: SessionSubagentsRemote
}
