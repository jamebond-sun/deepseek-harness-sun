/** Client 安全的问题、答案与事件类型。@module @deepseek-ai/dsh-user-questions/types */

import type { Scoped } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent/types'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type {} from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-session-projection/types'

/** 提供给用户的一个可选答案。 */
export interface AskUserQuestionOption {
  /** 面向用户的选项文案。 */
  label: string
  /** 可选的补充信息，由支持该能力的 UI 渲染。 */
  description?: string
}

/**
 * 调用方声明的呈现意图：这个问题本身就是这一类决策，因此认得该标签的 UI 可以按
 * 这一类决策来呈现它，而不是把它渲染成一个通用选项列表。以标签形式声明，便于日后
 * 继续扩充意图；不认识某个标签的 UI 退化为渲染通用流程，两种情况下答案编码完全
 * 一致 —— 意图只改变呈现，绝不改变协议。
 */
export type AskUserQuestionIntent = {
  /** 一份被提交评审的计划：`detail` 就是 `ask()` 要求的计划 markdown，而这次决策是对它的批准或否决。 */
  kind: 'plan-review'
  /**
   * 批准该计划的选项文案；其他所有选项都表示否决。采用具名而非按位置约定，
   * 因此任何 UI 都不会从选项顺序去推断结论。若 `approve` 没有指到自己问题里
   * 的任何一个选项，`ask()` 会直接拒绝。
   */
  approve: string
  /** 已记录的、参数中包含被评审计划的工具调用。 */
  callId?: ToolCallId
}

/** user-questions 请求中的一个问题。 */
export interface AskUserQuestionItem {
  /** 调用方提供的稳定问题 id，会在答案中原样带回。 */
  id: string
  /** 要展示的问题。 */
  question: string
  /** 可选的补充说明，随问题一并渲染，但不进入选项文案。 */
  detail?: string
  /** 可选的短标题／分组标签。 */
  header?: string
  /** 可选的候选项，UI 可以渲染成菜单。 */
  options?: AskUserQuestionOption[]
  /** 是否允许多选。默认为单选。 */
  multiSelect?: boolean
  /** 面向支持该能力的 UI 的可选呈现意图；缺省表示使用通用选项列表。 */
  intent?: AskUserQuestionIntent
}

/** 一个问题的答案。 */
export interface AskUserQuestionAnswerItem {
  /** 被回答的问题 id。 */
  id: string
  /** 被选中的选项文案。多选题可以同时附带自定义文本。 */
  selected: string[]
  /** 可选的自由文本答案（“其他”）。 */
  custom?: string
}

/** 人类的答复。 */
export interface AskUserQuestionAnswer {
  /** 按问题 id 索引的结构化答案。 */
  answers: AskUserQuestionAnswerItem[]
}

/** 工具调用仍可能返回答案时为 `open`；一旦答案只能以新一轮的形式抵达则为 `continued`。 */
export type UserQuestionState = 'open' | 'continued'

/** 从 Session 日志重建出来的、一个尚无答案的定时 `ask_user_question` 调用。 */
export interface PendingUserQuestion {
  readonly callId: ToolCallId
  readonly questions: readonly AskUserQuestionItem[]
  readonly state: UserQuestionState
}

/**
 * 一次定时 `ask_user_question` 调用，以及它最终的答案：若用户在窗口期内作答，
 * 就是它自身结果携带的那一批；否则就是它那次迟到回复携带的那一批，因为该调用
 * 自己的结果记录的是超时。transcript 行从这里读出用户最终回答了什么，而只有出现
 * 在列表里的调用才是定时调用。
 */
export interface SettledUserQuestion {
  /** 已终结的那次调用。 */
  readonly callId: ToolCallId
  /** 记录下来的答案批次，每个问题一项；迟到回复没有携带答案时为空。 */
  readonly answers: readonly AskUserQuestionAnswerItem[]
}

/**
 * 一个 Session 定时 `ask_user_question` 状态的两个半边，正如每个 Client 读到的那样。
 * 在阻塞式 legacy 工具生效期间发出的调用，两半边里都不会出现。
 */
export interface UserQuestionProjectionView {
  /** 仍可接受答案的调用，按提问顺序排列。 */
  readonly active: readonly PendingUserQuestion[]
  /** 已有答案使之终结的调用，按终结顺序排列。 */
  readonly settled: readonly SettledUserQuestion[]
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * 对一个已 `continued` 的 `ask_user_question` 调用的迟到回复，由
     * `dsh-user-questions` 作为一批答案引导进 agent。关闭一个提问面板不会持久化
     * 任何回复。读取方在没有生产者的情况下也会保留这条消息；只有 `userQuestions`
     * 投影读取这个 kind，用以关闭该问题并记录它的答案。
     * @persistenceAttribution
     */
    'user-question-reply': { kind: 'user-question-reply'; callId: ToolCallId; outcome: 'answered' }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** 本 Session 中仍可作答的定时问题，以及被迟到回复终结的那些。 */
    userQuestions: UserQuestionProjectionView
  }
}

/** 为 user-question 回答方 waterfall 声明的、Client 安全的载荷。 */
export interface AskUserQuestionRequestEvent {
  /** 要展示的问题。 */
  questions: AskUserQuestionItem[]
  /** 在传输过程中被投影到对应 Client Context 的 agent 身份。 */
  agent?: Agent
  /** 该待处理请求的取消生命周期。 */
  signal?: AbortSignal
  /**
   * Client 卡片据以键入的工具调用。定时回答方在开始本地倒计时之前，
   * 先挂到业务等待流上。
   */
  wait?: {
    /** Client 卡片据以键入的工具调用。 */
    callId: ToolCallId
    /** 需要 Client 认领的前台等待为 true；无限等待缺省该字段。 */
    timed?: boolean
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * 请各已组合的回答方索取结构化用户输入。返回一个答案即认领该请求，
     * 调用 `next()` 即向下委派。作用域过滤分派
     * （`@deepseek-ai/dsh-scope`）：agent 作用域的监听器只收到该 agent 的请求。
     * @param request - 待处理的 user-question 请求。
     * @mode waterfall
     */
    'user-questions/request'(
      this: Scoped<Agent>,
      request: AskUserQuestionRequestEvent,
      next: () => Promise<AskUserQuestionAnswer>,
    ): Promise<AskUserQuestionAnswer>
  }
}
