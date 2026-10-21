/**
 * 会话反馈：`feedback/record` 事件、不依赖命令的生产者、产品界面借以记录的
 * `sessionFeedback` Host Remote，以及面向用户的 `/feedback` 命令。
 * 记录会追加一条权威的仅记日志事件，且不会启动模型工作。该追加是即时的
 * 但未落盘，因此回执只表明条目已记入日志，而非已写入磁盘。
 * @module @deepseek-ai/dsh-command-feedback
 */

import type { Context } from '@deepseek-ai/cordis'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { Session } from '@deepseek-ai/dsh-session'
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type {
  FeedbackCategory,
  FeedbackRecord,
  SessionFeedbackRecordRequest,
  SessionFeedbackRecordResult,
} from './types.ts'

export type * from './types.ts'

/**
 * 全部反馈分类，顺序与产品界面展示的一致；每个界面各自持有其本地化文案。
 */
export const FEEDBACK_CATEGORIES = [
  'task-result',
  'instruction-following',
  'product-interaction',
  'service-stability',
  'resource-cost',
  'security-privacy-permission',
  'other',
] as const satisfies readonly FeedbackCategory[]

export const name = 'command-feedback'
export const inject = ['commands']

const USAGE = 'Usage: /feedback <text>'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionFeedback: SessionFeedbackService
  }
}

/**
 * 记录反馈，不依赖任何 UI 触发。首尾空白会被丢弃，空白文本按缺省记录；
 * 文本与分类皆缺省的条目同样会被记录。
 * @param session - 反馈所描述的会话。
 * @param entry - 用户书写的意见及其分类。
 */
export function recordFeedback(session: Session, entry: FeedbackRecord): void {
  const text = entry.text?.trim() ?? ''
  session.append('feedback/record', {
    ...(text.length === 0 ? {} : { text }),
    ...(entry.category === undefined ? {} : { category: entry.category }),
  })
}

/**
 * 校验、记录并回执一条反馈条目。返回错误时不会留下任何 `feedback/record` 事件。
 * @param invocation - 接收方 agent、原始命令输入与 UI 取消信号。
 * @returns 含接收会话与匿名用户 id 的回执；未提供反馈文本时返回用法错误。
 */
function executeFeedbackCommand(invocation: CommandInvocation): CommandResult {
  if (invocation.rawInput.trim().length === 0) {
    return { kind: 'error', text: `Feedback text is required. ${USAGE}` }
  }
  recordFeedback(invocation.agent.session, { text: invocation.rawInput })
  return {
    kind: 'success',
    text: `Feedback recorded for session ${invocation.agent.session.id}\nAnonymous user: ${getOrCreateAnonymousUserId()}.`,
  }
}

/** 产品界面借以记录会话级意见的 Host Remote。 */
export class SessionFeedbackService extends TypertRemoteService {
  static inject = ['sessions']

  /**
   * @param ctx - 持有实时会话存储的 Host 上下文。
   */
  constructor(ctx: Context) {
    super(ctx, 'sessionFeedback')
  }

  /**
   * 在一个实时会话上记录一条意见。
   * @param request - 目标会话以及可选的文本与分类。
   * @returns 记录后的后置条件；没有实时会话持有该 id 时返回 `session-not-found`。
   */
  @Remote('record')
  record(request: SessionFeedbackRecordRequest): Promise<SessionFeedbackRecordResult> {
    const session = this.ctx.sessions.get(request.sessionId)
    if (session === undefined) {
      return Promise.resolve({ ok: false, error: { code: 'session-not-found', sessionId: request.sessionId } })
    }
    recordFeedback(session, request)
    return Promise.resolve({ ok: true, value: { recorded: true } })
  }
}

/**
 * 为每个已组合的命令适配器注册全局 `/feedback` 命令，并挂载 `sessionFeedback` Remote。
 * @param ctx - Host 上下文。
 */
export function apply(ctx: Context): void {
  ctx.plugin(SessionFeedbackService)
  ctx.commands.register({
    definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-feedback'),
    name: 'feedback',
    description: 'Record feedback about this session',
    input: { hint: '<text>' },
    recordInput: false,
    handler: executeFeedbackCommand,
  })
}
