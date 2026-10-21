/** 面向 `ctx.sessionTitle` 的、首条人类消息模型提供方。 */

/* jscpd:ignore-start -- both shipped providers import the same shared packages. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { LlmResolvedModelInfo, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import {
  normalizeSessionTitle,
  SessionTitleProviderId,
  type SessionTitleUserMessage,
} from '@deepseek-ai/dsh-session-title'
import {
  executeSessionTitleLlm,
  resolveSessionTitleLlmConfig,
  SessionTitleLlmConfigFields,
  type ResolvedSessionTitleLlmConfig,
  type SessionTitleLlmConfig,
  type SessionTitleLlmResponse,
} from '@deepseek-ai/dsh-session-title-llm'
/* jscpd:ignore-end */

export const name = 'session-title-first-prompt-llm'
export const inject = ['sessionTitle', 'llm', 'sessions']

/* jscpd:ignore-start -- each provider owns its title-length targets and reasoning control. */
/** 所需的执行控制，加上本提供方的标题长度目标；无默认值。 */
export interface Config extends SessionTitleLlmConfig {
  /** 非 CJK 标题的目标词数。 */
  readonly targetWords: number
  /** 中文、日文或韩文标题的目标字符数。 */
  readonly targetCjkCharacters: number
}

/** 针对本提供方所需执行控制与标题长度目标的 Loader schema。 */
export const Config: z<Config> = z.object({
  targetWords: z.number().step(1).min(1).required(),
  targetCjkCharacters: z.number().step(1).min(1).required(),
  maxInputBytes: SessionTitleLlmConfigFields.maxInputBytes,
  maxOutputTokens: SessionTitleLlmConfigFields.maxOutputTokens,
  timeoutMs: SessionTitleLlmConfigFields.timeoutMs,
  provider: SessionTitleLlmConfigFields.provider,
  model: SessionTitleLlmConfigFields.model,
})

/** 已校验的不可变提供方策略。 */
interface ResolvedConfig extends ResolvedSessionTitleLlmConfig {
  readonly targetWords: number
  readonly targetCjkCharacters: number
}

/** 校验一个正的标题长度目标。 */
function assertTarget(name: 'targetWords' | 'targetCjkCharacters', value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`session-title-first-prompt-llm: ${name} must be a positive integer`)
  }
  return value
}

/**
 * 校验共享的执行控制，以及本提供方的标题长度目标。
 * @param config - 不受信任的插件配置。
 * @returns 不可变的提供方策略。
 */
function resolveConfig(config: Config): ResolvedConfig {
  const { targetWords, targetCjkCharacters, ...execution } = config
  return {
    ...resolveSessionTitleLlmConfig(execution),
    targetWords: assertTarget('targetWords', targetWords),
    targetCjkCharacters: assertTarget('targetCjkCharacters', targetCjkCharacters),
  }
}

/** 为一次标题调用选择该路由支持度最低的推理力度。 */
const selectReasoningEffort = (model: Readonly<LlmResolvedModelInfo>): ReasoningEffortId | undefined =>
  model.reasoning?.efforts[0]?.id
/* jscpd:ignore-end */

/* jscpd:ignore-start -- independent provider strategies share only the execution module, not prompt or parsing policy. */
/** 针对从一条消息推导出的标题、具备语言感知的系统指令。 */
function systemPrompt(config: ResolvedConfig): string {
  return [
    'Create a concise title for an AI coding-assistant session from the supplied human messages.',
    'Return only the title on one line, **in plain text of natural language**, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed.',
    'Use the language of the messages.',
    `Aim for about ${config.targetWords} words in non-CJK languages or ${config.targetCjkCharacters} CJK characters.`,
    'If the messages give little to name, still return a short best-effort title, such as Greeting, instead of explaining.',
  ].join('\n')
}

/** 把所选消息框定为 JSON，使用户文本无法破坏结构化分隔符。 */
function frameMessages(messages: readonly SessionTitleUserMessage[]): string {
  return `Generate the session title from this JSON array of human messages:\n${JSON.stringify(messages)}`
}

/** 用星号强调包裹整行，例如 `**Title**`。 */
const EMPHASIS_WRAPPER = /^(?<marker>\*{1,3})(?<inner>\S(?:.*\S)?)\k<marker>$/u

/**
 * 从模型输出中取标题：取第一个非空行，去掉包裹整行的星号强调。无视单行
 * 指令的模型会把标题放在最前、注释放在其后。一条完全由 `*` 强调构成的行，
 * 即便模型本意是字面量，也会丢掉这对标记；内部标记检查会保留较长行内的
 * 强调，而系统指令禁止 Markdown。
 */
function titleFromOutput(text: string): string {
  const line = text.split(/\r?\n/u).map(item => item.trim()).find(item => item.length > 0) ?? ''
  const groups = EMPHASIS_WRAPPER.exec(line)?.groups
  const marker = groups?.['marker']
  const inner = groups?.['inner']
  return marker === undefined || inner === undefined || inner.includes(marker) ? line : inner
}

/** 拒绝终结性的工具调用或触达最大令牌的结果，并从文本块中推导出一个非空标题。 */
function titleFromResponse(response: SessionTitleLlmResponse): string {
  switch (response.finish.kind) {
    case 'stop':
      break
    case 'tool-calls':
      throw new Error('session-title-llm: title output must contain text only')
    case 'max-tokens':
      throw new Error('session-title-llm: title output reached maxOutputTokens')
    /* v8 ignore next -- 封闭的 SessionTitleLlmFinish 联合穷尽性守卫 */
    default: return assertNever(response.finish, 'SessionTitleLlmFinish')
  }
  if (response.blocks.some(block => block.type === 'tool-call')) {
    throw new Error('session-title-llm: title output must contain text only')
  }
  const text = response.blocks
    .filter((block): block is Extract<(typeof response.blocks)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join(' ')
  const title = normalizeSessionTitle(titleFromOutput(text), Number.MAX_SAFE_INTEGER)
  if (title.length === 0) throw new Error('session-title-llm: title model produced no text')
  return title
}
/* jscpd:ignore-end */

/**
 * Register the first-prompt model provider.
 * @param ctx - context exposing session-title, LLM, and session services.
 * @param config - required route, target, byte, token, and timeout policy.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const titleProvider = SessionTitleProviderId(name)
  ctx.sessionTitle.register({
    id: titleProvider,
    automatic: 'first-prompt',
    async generate(request) {
      const first = request.messages[0]
      if (first === undefined) throw new Error('first-prompt title provider requires one human message')
      const response = await executeSessionTitleLlm(ctx, resolved, request, titleProvider, {
        system: systemPrompt(resolved),
        input: frameMessages([first]),
        messageSeqs: [first.seq],
        selectReasoningEffort,
      })
      return {
        title: titleFromResponse(response),
        messageSeqs: [first.seq],
        model: response.model,
      }
    },
  })
}
