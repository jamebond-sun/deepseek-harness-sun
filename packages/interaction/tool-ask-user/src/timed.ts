/**
 * 可选的定时 `ask_user_question` 工具定义。
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import { TIMED_WAIT_PARAMETER } from '@deepseek-ai/dsh-user-questions'
import type {
  AskUserQuestionAnswer, AskUserQuestionRequestEvent,
} from '@deepseek-ai/dsh-user-questions/types'

function validateTimeout(timeout: number): number {
  if (timeout !== -1 && (!Number.isInteger(timeout) || timeout < 1 || timeout > 2_147_483)) {
    throw new Error('timeout must be -1 or a positive integer up to 2147483 seconds')
  }
  return timeout
}

function validateQuestionIds(questions: readonly { readonly id: string }[]): void {
  const ids = new Set<string>()
  for (const question of questions) {
    if (ids.has(question.id)) throw new Error(`question id ${JSON.stringify(question.id)} must be unique within this call`)
    ids.add(question.id)
  }
}

const description = 'Ask brief, direct, self-contained questions about missing information, preferences, or decisions. '
  + 'Use user-facing terms; assume no knowledge of background work or internal names. '
  + 'Use distinct stable question IDs. A submitted skipped question is an answer item with empty selected and no custom; '
  + 'pending instead means no answer batch arrived before the timeout and the user can still answer.'

/**
 * pending 结果在其 `message` 字段里携带的说明。它是结果值的一个字段，而不是写
 * 在结果旁边的说明文字，因为被记录的结果文本是作为一个 JSON 对象被读回的：
 * `userQuestions` 投影据此判定该调用仍可作答，Client 的提问行据此判定记录到的
 * 结果是超时，而不是一批答案。
 */
const pendingNotice = 'No answer batch arrived before the timeout. This is pending, not a skipped answer. '
  + 'Continue useful independent work. The user can still answer; their reply will be a user message '
  + 'identified as answer_to_pending_question with this callId and the original questions. '
  + 'Do not treat this as permission.'

interface ToolQuestion {
  readonly id: string
  readonly question: string
  readonly header?: string
  readonly options?: { readonly label: string; readonly description?: string }[]
  readonly multi_select?: boolean
}

interface ToolAnswerResult {
  readonly answers: {
    readonly id: string
    readonly selected: string[]
    readonly custom?: string
  }[]
}

/**
 * 把模型侧的 schema 翻译成服务请求，且不改变归属关系。
 * @param questions - 以工具 schema 形态给出的、模型提供的问题。
 * @param exec - 持有 agent 与取消信号的执行上下文。
 * @returns 对应的 user-question 服务请求。
 */
function questionRequest(
  questions: readonly ToolQuestion[],
  exec: Pick<ToolExecution, 'agent' | 'signal'>,
): AskUserQuestionRequestEvent {
  return {
    questions: questions.map(question => ({
      id: question.id,
      question: question.question,
      ...question.header !== undefined ? { header: question.header } : {},
      ...question.options !== undefined ? { options: question.options.map(option => ({ ...option })) } : {},
      ...question.multi_select !== undefined ? { multiSelect: question.multi_select } : {},
    })),
    ...exec.agent !== undefined ? { agent: exec.agent } : {},
    signal: exec.signal,
  }
}

/**
 * 把服务持有的答案数组拷贝到面向模型的结果里。
 * @param result - user-question 服务返回的答案。
 * @returns 一份脱离服务掌控的、面向模型的答案载荷。
 */
function answerResult(result: AskUserQuestionAnswer): ToolAnswerResult {
  return {
    answers: result.answers.map(answer => ({
      id: answer.id,
      selected: [...answer.selected],
      ...answer.custom !== undefined ? { custom: answer.custom } : {},
    })),
  }
}

/**
 * 注册可选的定时工具定义。
 * @param ctx - 接收该工具的、agent 作用域的 context。
 * @param timeout - 默认前台等待秒数。
 */
export function registerTimedAskUser(ctx: Context, timeout = 120): void {
  const defaultTimeout = validateTimeout(timeout)
  /* jscpd:ignore-start -- 定时 schema 有意与 legacy 工具共用问题字段。 */
  ctx.tools.register(defineTool({
    name: 'ask_user_question',
    description,
    parameters: {
      questions: {
        type: 'array',
        required: true,
        description: 'Questions to ask the user.',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            id: { type: 'string', required: true, description: 'Stable id for this question; echoed in the answer.' },
            question: { type: 'string', required: true, description: 'The specific question to ask the user.' },
            header: {
              type: 'string',
              description: 'Optional short heading for the question, such as "Confirm" or "Choose Mode".',
            },
            options: {
              type: 'array',
              description: 'Optional choices to show the user. If you recommend one, put it first and append "(Recommended)" to that label.',
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  label: { type: 'string', required: true, description: 'Short user-facing option label.' },
                  description: { type: 'string', description: 'One sentence explaining the tradeoff or impact.' },
                },
              },
            },
            multi_select: {
              type: 'boolean',
              description: 'Whether the user may select more than one option. Defaults to false.',
            },
          },
        },
      },
      // `userQuestions` 投影从已记录的请求头里读取该参数是否存在，以此区分
      // 定时调用与 legacy 调用。
      [TIMED_WAIT_PARAMETER]: {
        type: 'integer',
        description: `Wait seconds for the entire batch (default ${defaultTimeout}); omit unless the user specifies a duration. Use -1 only when an answer is required before proceeding.`,
      },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object', additionalProperties: false,
            properties: {
              pending: {
                type: 'boolean', enum: [true], required: true,
                description: 'True when the foreground wait expired before the user submitted an answer batch. The questions remain answerable; this is not a skipped answer.',
              },
              callId: { type: 'string', required: true, description: 'Tool call whose unanswered questions remain pending.' },
              message: {
                type: 'string', required: true,
                description: 'How to continue while the questions stay answerable.',
              },
            },
          },
          {
            type: 'object', additionalProperties: false,
            properties: {
              answers: {
                type: 'array', required: true,
                description: 'Submitted answer batch with one item per question. A skipped question has empty selected and no custom; unlike pending, the user has completed the batch.',
                items: {
                  type: 'object', additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true, description: 'Stable question id echoed from the request.' },
                    selected: {
                      type: 'array', required: true, items: { type: 'string' },
                      description: 'Selected option labels. Empty with no custom means the user explicitly skipped this question.',
                    },
                    custom: { type: 'string', description: 'Optional free-form answer; omitted for a skipped question.' },
                  },
                },
              },
            },
          },
        ],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const timeout = validateTimeout(args.timeout ?? defaultTimeout)
      validateQuestionIds(args.questions)
      const request = questionRequest(args.questions, exec)
      if (timeout !== -1) {
        if (exec.agent === undefined) throw new Error('timed questions require a live agent')
        const result = await ctx.userQuestions.askTimed({ ...request, agent: exec.agent }, exec.callId, timeout * 1000)
        return 'pending' in result ? { ...result, message: pendingNotice } : answerResult(result)
      }
      // 不带 `timed` 的 `wait`：本工具的无限等待形态同样以 call id 作为 Client
      // 卡片的键，因此 UI 可以从工具调用处重开一个已关闭的面板。legacy 工具
      // 保持其不带键的请求形态。
      const result = await ctx.userQuestions.ask({ ...request, wait: { callId: exec.callId } })
      return answerResult(result)
    },
  }))
  /* jscpd:ignore-end */
}
