/** 把 `ask_user_question` 工具事件折叠为可作答问题集合，以及它的 Session 投影。 */
import { z } from 'zod'
import { SessionLogOffset, TOOL_OUTCOME_UNKNOWN } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionLogOffset as SessionLogOffsetType } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-agent/types'
import type {} from '@deepseek-ai/dsh-tools/types'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { AskUserQuestionAnswerItem, AskUserQuestionItem, AskUserQuestionOption, PendingUserQuestion, SettledUserQuestion, UserQuestionProjectionView } from './types.ts'

/**
 * 纯折叠状态：当前生效的请求头是否声明了定时 `ask_user_question` schema，
 * 以及由该 schema 的各次调用构造出的问题视图。在阻塞式 legacy schema 下发出的
 * 调用永远不会进入其中。
 */
export interface UserQuestionFold {
  readonly timed: boolean
  readonly questions: UserQuestionProjectionView
}

/** Host 投影 state；`questions` 就是 wire 值，某个事件未改变任何内容时被复用。 */
export interface UserQuestionProjectionState extends UserQuestionFold {
  readonly inheritedEventCount: SessionLogOffsetType
}

/** 本投影跟踪其调用的那个工具。 */
export const ASK_USER_QUESTION_TOOL = 'ask_user_question'

/**
 * 只有定时 `ask_user_question` schema 才声明的、面向模型的参数。
 * 折叠逻辑正是通过它在已记录请求头里是否存在，来判断其后的那些
 * `ask_user_question` 调用能否在超时之后继续作答；阻塞式 legacy schema
 * 从不声明它。
 */
export const TIMED_WAIT_PARAMETER = 'timeout'

const toolOptionSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
}).loose()

const toolQuestionSchema = z.object({
  id: z.string(),
  question: z.string(),
  header: z.string().optional(),
  options: z.array(toolOptionSchema).optional(),
  multi_select: z.boolean().optional(),
}).loose()

const toolArgumentsSchema = z.object({
  questions: z.array(toolQuestionSchema).min(1),
}).loose()

const optionSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
}).strict().transform((option): AskUserQuestionOption => ({
  label: option.label,
  ...(option.description === undefined ? {} : { description: option.description }),
}))

const questionSchema = z.object({
  id: z.string(),
  question: z.string(),
  detail: z.string().optional(),
  header: z.string().optional(),
  options: z.array(optionSchema).optional(),
  multiSelect: z.boolean().optional(),
}).strict().transform((question): AskUserQuestionItem => ({
  id: question.id,
  question: question.question,
  ...(question.detail === undefined ? {} : { detail: question.detail }),
  ...(question.header === undefined ? {} : { header: question.header }),
  ...(question.options === undefined ? {} : { options: question.options }),
  ...(question.multiSelect === undefined ? {} : { multiSelect: question.multiSelect }),
}))

const pendingQuestionsSchema: z.ZodType<readonly PendingUserQuestion[]> = z.array(z.object({
  callId: z.string().min(1).transform(ToolCallId),
  questions: z.array(questionSchema).min(1),
  state: z.enum(['open', 'continued']),
}).strict()).superRefine((active, context) => {
  if (new Set(active.map(question => question.callId)).size !== active.length) {
    context.addIssue({ code: 'custom', message: 'callIds must be unique' })
  }
})

const answerSchema = z.object({
  id: z.string(),
  selected: z.array(z.string()),
  custom: z.string().optional(),
}).strict().transform((answer): AskUserQuestionAnswerItem => ({
  id: answer.id,
  selected: answer.selected,
  ...(answer.custom === undefined ? {} : { custom: answer.custom }),
}))

const settledQuestionsSchema: z.ZodType<readonly SettledUserQuestion[]> = z.array(z.object({
  callId: z.string().min(1).transform(ToolCallId),
  answers: z.array(answerSchema),
}).strict())

const projectionViewSchema: z.ZodType<UserQuestionProjectionView> = z.object({
  active: pendingQuestionsSchema,
  settled: settledQuestionsSchema,
}).strict()

/** 及时的工具结果与被引流过来的迟到回复共用的同一种 `answers` 批次。 */
const answerBatchSchema = z.object({ answers: z.array(answerSchema) }).loose()

/** 尚无定时 `ask_user_question` 调用的 Session 共用此视图，以保证 wire 值在引用上保持稳定。 */
const emptyView: UserQuestionProjectionView = { active: [], settled: [] }

const initialFold: UserQuestionFold = { timed: false, questions: emptyView }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 判断一条已记录的工具 schema 是否是定时 `ask_user_question` 工具的。
 * @param tool - 请求头里已组装的工具 schema 中的一项。
 * @returns 仅当其名为 `ask_user_question` 且参数声明了 {@link TIMED_WAIT_PARAMETER} 时为真。
 */
export function isTimedAskUserQuestionSchema(tool: Pick<ToolSchema, 'name' | 'parameters'>): boolean {
  if (tool.name !== ASK_USER_QUESTION_TOOL) return false
  const properties: unknown = tool.parameters['properties']
  return isRecord(properties) && TIMED_WAIT_PARAMETER in properties
}

/**
 * 从已记录的 `ask_user_question` 参数里读出问题批次。
 * @param argumentsText - `tool/call` 事件上记录的原始 JSON 参数。
 * @returns 以服务词汇表表达的问题；参数无法解析时为 null。
 */
export function questionsOf(argumentsText: string): readonly AskUserQuestionItem[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(argumentsText)
  } catch (error) {
    // 格式非法的模型参数从未抵达工具，因此没有卡片可展示。
    void error
    return null
  }
  const result = toolArgumentsSchema.safeParse(parsed)
  if (!result.success) return null
  return result.data.questions.map(question => ({
    id: question.id,
    question: question.question,
    ...(question.header === undefined ? {} : { header: question.header }),
    ...(question.options === undefined
      ? {}
      : {
        options: question.options.map(option => ({
          label: option.label,
          ...(option.description === undefined ? {} : { description: option.description }),
        })),
      }),
    ...(question.multi_select === undefined ? {} : { multiSelect: question.multi_select }),
  }))
}

function isPendingResult(content: readonly ContentBlock[]): boolean {
  const text = content.find(block => block.type === 'text')
  if (text === undefined) return false
  try {
    const parsed: unknown = JSON.parse(text.text)
    return typeof parsed === 'object' && parsed !== null && (parsed as { pending?: unknown }).pending === true
  } catch (error) {
    // 非 JSON 的结果文本是一条失败信息，绝不是 pending 载荷。
    void error
    return false
  }
}

/**
 * 从一段已记录的文本（工具结果或迟到回复）里读出答案批次。
 * @param content - 该消息的 ContentBlock 列表。
 * @returns 答案批次；当这段文本没有携带本读取方可用的批次时为 null。
 */
function answerBatchOf(content: readonly ContentBlock[]): readonly AskUserQuestionAnswerItem[] | null {
  const text = content.find(block => block.type === 'text')
  if (text === undefined) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text.text)
  } catch (error) {
    // 失败结果、被关闭的面板，以及任何非答案 JSON 的文本都不携带批次。
    void error
    return null
  }
  const result = answerBatchSchema.safeParse(parsed)
  return result.success ? result.data.answers : null
}

/**
 * 关闭一个可作答的问题，并保留它最终的答案。
 * 一条指向已不可作答调用的回复不会改变任何东西。
 * @param view - 当前的问题状态。
 * @param callId - 该结果或回复所指的那次调用。
 * @param answers - 它携带的批次；迟到回复没有携带答案时为空。
 * @returns 若该调用已不可作答则返回同一个视图，否则返回更新后的视图。
 */
function settleQuestion(
  view: UserQuestionProjectionView,
  callId: string,
  answers: readonly AskUserQuestionAnswerItem[],
): UserQuestionProjectionView {
  const question = view.active.find(item => item.callId === callId)
  if (question === undefined) return view
  return {
    active: view.active.filter(item => item.callId !== callId),
    settled: [...view.settled, { callId: question.callId, answers }],
  }
}

/**
 * 把一条 Session 事件应用到本 Session 的问题折叠上。
 * 一条 `request/header` 依据自身记录下来的已组装工具 schema，判定其后的那些
 * `ask_user_question` 调用是否为定时调用；在阻塞式 legacy schema 下发出的调用永不
 * 被跟踪，因此一个只用过那个工具的 Session 会折叠成空视图。一个被跟踪的问题在
 * 恰好两种情况下保持 `continued` 状态可作答：工具返回了 pending 载荷，或者 Session
 * 恢复修复为某个进程从未执行完的调用追加了合成的 `TOOL_OUTCOME_UNKNOWN` 结果。
 * 答案批次会以该批次使之终结；任何失败都会直接丢弃它。PTC 子调用在其记录结果为
 * pending 时进入折叠。迟到回复只有在 agent 接纳了它的用户消息之后才使调用终结；
 * 在此之前，排在收件箱里的消息仍可能被丢弃。
 * @param fold - 当前的折叠状态。
 * @param event - 按追加顺序排列的下一条 Session 事件。
 * @returns 事件无关时返回同一个折叠，否则返回更新后的折叠。
 */
export function applyUserQuestionEvent(fold: UserQuestionFold, event: SessionEvent): UserQuestionFold {
  const view = fold.questions
  switch (event.type) {
    case 'request/header': {
      // 日志记录的是模型看到的精确 schema 列表；被播种的或不含工具的头不携带
      // 任何工具，读起来就像 legacy 工具。
      const tools: unknown = event.data.header.tools
      const timed = Array.isArray(tools) && tools.some((tool: unknown) =>
        isRecord(tool) && typeof tool.name === 'string' && isRecord(tool.parameters)
        && isTimedAskUserQuestionSchema({ name: tool.name, parameters: tool.parameters }))
      return timed === fold.timed ? fold : { ...fold, timed }
    }
    case 'tool/call': {
      if (!fold.timed || event.data.name !== ASK_USER_QUESTION_TOOL) return fold
      const questions = questionsOf(event.data.arguments)
      if (questions === null) return fold
      const callId = event.data.callId
      return {
        ...fold,
        questions: {
          ...view,
          active: [...view.active.filter(question => question.callId !== callId), { callId, questions, state: 'open' }],
        },
      }
    }
    case 'tool/result': {
      const callId = event.data.message.toolCallId
      if (!view.active.some(question => question.callId === callId)) return fold
      if (isPendingResult(event.data.message.content) || event.data.error?.code === TOOL_OUTCOME_UNKNOWN) {
        return {
          ...fold,
          questions: {
            ...view,
            active: view.active.map(question => question.callId === callId ? { ...question, state: 'continued' } : question),
          },
        }
      }
      const answers = event.data.error === undefined && event.data.message.isError !== true
        ? answerBatchOf(event.data.message.content)
        : null
      return {
        ...fold,
        questions: answers === null
          ? { ...view, active: view.active.filter(question => question.callId !== callId) }
          : settleQuestion(view, callId, answers),
      }
    }
    case 'tool/ptc-dispatch': {
      if (event.data.name !== ASK_USER_QUESTION_TOOL || event.data.isError || !isPendingResult(event.data.content)) return fold
      const questions = questionsOf(JSON.stringify(event.data.arguments))
      if (questions === null) return fold
      const callId = event.data.subCallId
      return {
        ...fold,
        questions: {
          ...view,
          active: [...view.active.filter(question => question.callId !== callId), { callId, questions, state: 'continued' }],
        },
      }
    }
    case 'user/message': {
      const source = event.data.source
      if (source.kind !== 'user-question-reply') return fold
      const questions = settleQuestion(view, source.callId, answerBatchOf(event.data.content) ?? [])
      return questions === view ? fold : { ...fold, questions }
    }
    default:
      return fold
  }
}

/**
 * 把整份 Session 日志折叠为它的问题状态。
 * @param events - 按追加顺序排列的 Session 事件。
 * @returns 以提问顺序排列的 open 与 continued 定时调用，以及按终结顺序排列的已终结调用。
 */
export function foldUserQuestions(events: readonly SessionEvent[]): UserQuestionProjectionView {
  return events.reduce(applyUserQuestionEvent, initialFold).questions
}

/** 向所有 Client 暴露 open、continued 与已终结定时问题的 Session 投影。 */
export const userQuestionProjectionDefinition = {
  key: 'userQuestions',
  stateSchema: z.object({
    inheritedEventCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(SessionLogOffset),
    timed: z.boolean(),
    questions: projectionViewSchema,
  }).strict(),
  init: (_header, inheritedEventCount) => ({ inheritedEventCount, ...initialFold }),
  apply: (state, event) => {
    if (event.seq < state.inheritedEventCount) return state
    const fold = applyUserQuestionEvent(state, event)
    return fold === state ? state : { ...state, ...fold }
  },
  wire: { viewSchema: projectionViewSchema, view: state => state.questions },
  stateVersion: 2,
} satisfies ProjectionDefinition<'userQuestions', UserQuestionProjectionState>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    userQuestions: UserQuestionProjectionState
  }
}
