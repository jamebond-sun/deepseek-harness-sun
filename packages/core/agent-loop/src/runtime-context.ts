/**
 * 系统提示词插件形成的两个循环拥有的表面消息的持久投影状态：
 * 系统提示词（表面节点 0 及任何历史内替换）和动态运行时上下文快照。
 * @module @deepseek-ai/dsh-agent-loop/runtime-context
 */

import { createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, ContextSnapshotSection, Message } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionSeq, SurfaceIntent, SystemMessage, UserMessage } from '@deepseek-ai/dsh-session'
import { isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'runtime-context': { kind: 'runtime-context' } & ContextFormed
  }
}

const SOURCE = 'runtime-context'
const CLEARED = 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.'

function isOwned(message: UserMessage): boolean {
  return message.source.kind === SOURCE
}

function textOf(message: Message): string | undefined {
  const [block] = message.content
  return message.content.length === 1 && block?.type === 'text' ? block.text : undefined
}

/** 一个未提交的系统提示词表面操作，用于请求接纳或对账。 */
export interface SystemPromptCommit {
  /** 已渲染的提示词或空内容：空头不记录提示词；空尾部处于休眠。 */
  message: SystemMessage
  /** 新系统节点用 `append`，否则替换一个仍存活的系统节点。 */
  intent: SurfaceIntent<'system/message'>
}

/** 单个提示词决策所依据的请求序列事实。 */
export interface SystemPromptDecisionInput {
  /** 本次尝试的准备路由是否读取后续的 `system` 消息作为有效提示词。 */
  inHistory: boolean
  /**
   * 提示词接纳是否必须合并：pre-step 监听器声明了新序列、
   * 表面自上次请求以来发生了变化，或在不支持工具更新的路由上
   * 组装的工具发生了变化。
   */
  startsSeries: boolean
}

/** 从最新向后的已提交事件；恢复扫描在首个匹配处停止。 */
function eventsNewestFirst(session: Session): readonly SessionEvent[] {
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  return session.snapshotEvents().toReversed()
}

/**
 * 决定已渲染的系统提示词如何到达表面，而不拥有提交。
 * 第一个提示词即使为空也会保留表面节点 0。
 * 具备能力的延续序列会在缓存的历史之后追加已变化的非空文本。
 * 无能力的路由、断裂的序列或已清空的提示词则改为将第一个系统节点规范化
 * 并清空后续活跃节点。休眠的空尾部不提供有效文本，也不需要重复替换。
 */
export class SystemPromptProjection {
  constructor(private readonly session: Session) {}

  /** 按表面顺序排列的仍存活的 `system/message` 节点。 */
  private systemNodes(): { seq: SessionSeq; text: string | undefined }[] {
    const nodes: { seq: SessionSeq; text: string | undefined }[] = []
    for (const seq of this.session.surface.nodes) {
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      const event = this.session.eventAt(seq)
      if (event?.type !== 'system/message') continue
      const content = event.data.message.content
      const text = content.length === 0 ? '' : textOf(event.data.message)
      nodes.push({ seq, text })
    }
    return nodes
  }

  /**
   * 将有效文本和保留节点与准备好的路由和序列对账。
   * @param rendered - 完整渲染的系统提示词；未激活任何提示词时为 `''`。
   * @param input - 本步骤的路由能力和序列事实。
   * @returns 按顺序排列的逐节点更新；空列表表示无需更新。
   */
  project(rendered: string, input: SystemPromptDecisionInput): SystemPromptCommit[] {
    const nodes = this.systemNodes()
    const head = nodes[0]
    if (head === undefined) {
      return [{ message: createSystemMessage(rendered), intent: { surfaceOp: 'append' } }]
    }
    const latest = nodes.findLast(node => node.text !== '') ?? head
    if (!input.inHistory || input.startsSeries || rendered.length === 0) {
      const updates = nodes.slice(1).filter(node => node.text !== '')
        .map(node => this.replace(node.seq, ''))
      if (head.text !== rendered) updates.push(this.replace(head.seq, rendered))
      return updates
    }
    if (latest.text === rendered) return []
    return [{ message: createSystemMessage(rendered), intent: { surfaceOp: 'append' } }]
  }

  private replace(seq: SessionSeq, text: string): SystemPromptCommit {
    return {
      message: createSystemMessage(text),
      intent: { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] },
    }
  }
}

/** 跟踪最近保留的运行时上下文快照，而不拥有其提交。 */
export class RuntimeContextProjection {
  /** `undefined` 表示从未存在过快照；`null` 表示没有保留任何快照。 */
  private retained: { seq: SessionSeq; text: string | undefined } | null | undefined

  /**
   * 恢复一次投影状态，然后跟随权威的会话事件。
   * @param ctx - agent 范围的事件上下文。
   * @param session - 接收投影消息的会话。
   */
  constructor(ctx: Context, session: Session) {
    const surface = new Set(session.surface.nodes)
    for (const event of eventsNewestFirst(session)) {
      if (event.type !== 'user/message' || !isOwned(event.data)) continue
      this.retained ??= null
      if (surface.has(event.seq)) {
        this.retained = { seq: event.seq, text: textOf(event.data) }
        break
      }
    }

    ctx.on('session/event', (subject, event) => {
      if (subject !== session) return
      if (event.type === 'user/message' && isOwned(event.data)) {
        this.retained = { seq: event.seq, text: textOf(event.data) }
      } else if (this.retained
        && isReplacementSurfaceEvent(event)
        && event.sourceEventSeqs?.includes(this.retained.seq) === true) {
        this.retained = null
      }
    })
  }

  /**
   * 仅当保留值不同时创建未提交的快照。
   * @param current - 完整渲染的动态上下文。
   * @param sections - 构成当前快照的具名贡献。
   * @returns 候选的用户消息，无需更新时为 `undefined`。
   */
  project(current: string, sections: readonly ContextSnapshotSection[]): UserMessage | undefined {
    if (this.retained === undefined && current.length === 0) return
    const snapshot = current.length === 0 ? CLEARED : current
    if (this.retained?.text === snapshot) return
    return createUserMessage({
      content: [{ type: 'text', text: snapshot }],
      // 已清空标记没有剩余需要归属的贡献。
      source: sections.length === 0
        ? { kind: SOURCE }
        : { kind: SOURCE, form: 'snapshot', sections },
    })
  }
}
