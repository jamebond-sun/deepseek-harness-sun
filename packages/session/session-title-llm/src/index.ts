/**
 * 由模型支撑的会话标题提供方所共用的执行策略：路由准备、输入/令牌/时间
 * 边界、取消、精确的辅助请求记录，以及流装配。标题措辞、长度目标、推理
 * 选择以及产出解读则归各个提供方所有。
 * @module @deepseek-ai/dsh-session-title-llm
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage, BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-session-title-llm': { kind: 'dsh-session-title-llm' } & ContextFormed
  }
}

import type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  LlmResolvedModelInfo,
  Message,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { assertNever, deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import { SessionTitleProviderId } from '@deepseek-ai/dsh-session-title'
import type {
  SessionTitleModelIdentity,
  SessionTitleProviderRequest,
} from '@deepseek-ai/dsh-session-title'

/** 在一次辅助标题派发之前记录的、确切的、模型可见请求。 */
export interface SessionTitleLlmRequestEventData {
  /** 对该请求负责的、已注册的标题提供方身份。 */
  readonly titleProvider: SessionTitleProviderId
  /** 在 `messages` 中表示的、确切的人类 `user/message` seq。 */
  readonly messageSeqs: SessionSeq[]
  /** 确切的辅助 LLM 路由。 */
  readonly route: SessionTitleModelIdentity
  /** 确切的辅助系统提示。 */
  readonly system: string
  /** 确切的辅助消息列表。 */
  readonly messages: Message[]
  /** 确切的辅助输出令牌上限。 */
  readonly maxTokens: number
  /** 被记录时解析得到的推理力度；较早的请求可以省略。 */
  readonly reasoningEffort?: ReasoningEffortId
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** 仅日志的、对某次会话标题模型请求的、派发前记录。 */
    'session/title-llm-request': SessionTitleLlmRequestEventData
  }
}

/** 能力自有、用于辅助标题请求的超时原因码。 */
export const SESSION_TITLE_TIMEOUT_CODE = 'SESSION_TITLE_TIMEOUT'

/** 一次由模型支撑的标题请求所需的执行控制。 */
export interface SessionTitleLlmConfig {
  /** 提供方准备的用户输入的最大 UTF-8 字节数。 */
  readonly maxInputBytes: number
  /** 标题请求的输出令牌上限，独立于对话请求。 */
  readonly maxOutputTokens: number
  /** 辅助请求的端到端截止时间，单位毫秒。 */
  readonly timeoutMs: number
  /** 可选的显式提供方路由；必须与 `model` 成对出现。 */
  readonly provider?: string
  /** 可选的显式模型 id；必须与 `provider` 成对出现。 */
  readonly model?: string
}

/** 已校验的不可变执行控制。 */
export interface ResolvedSessionTitleLlmConfig extends SessionTitleLlmConfig {}

/** 没有库默认值的、共享的 Loader 字段 schema。 */
export const SessionTitleLlmConfigFields = {
  maxInputBytes: z.number().step(1).min(1).required(),
  maxOutputTokens: z.number().step(1).min(1).required(),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).required(),
  provider: z.string(),
  model: z.string(),
}

/** 没有库默认值的、共享的 Loader schema。 */
export const SessionTitleLlmConfigSchema: z<SessionTitleLlmConfig> = z.object(SessionTitleLlmConfigFields)

/** 用于直接构造校验的完整执行控制键集合。 */
const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'maxInputBytes',
  'maxOutputTokens',
  'timeoutMs',
  'provider',
  'model',
])

/** 校验一个正整数上限。 */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`session-title-llm: ${name} must be a positive integer`)
  }
}

/**
 * 校验并分离出所需的执行控制。
 * @param config - 不受信任的执行配置。
 * @returns 不可变的控制，并保留可选的路由缺失状态。
 */
export function resolveSessionTitleLlmConfig(
  config: SessionTitleLlmConfig,
): ResolvedSessionTitleLlmConfig {
  const candidate: unknown = config
  if (candidate === null || typeof candidate !== 'object') {
    throw new Error('session-title-llm: configuration is required')
  }
  const value = candidate as SessionTitleLlmConfig
  for (const key of Object.keys(value)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`session-title-llm: unknown config key "${key}"`)
  }
  assertPositiveInteger('maxInputBytes', value.maxInputBytes)
  assertPositiveInteger('maxOutputTokens', value.maxOutputTokens)
  assertPositiveInteger('timeoutMs', value.timeoutMs)
  if (value.timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`session-title-llm: timeoutMs must not exceed ${MAX_TIMER_DELAY_MS}`)
  }
  const hasProvider = value.provider !== undefined
  const hasModel = value.model !== undefined
  if (hasProvider !== hasModel) {
    throw new Error('session-title-llm: provider and model must be supplied together')
  }
  if (hasProvider
    && (typeof value.provider !== 'string' || value.provider.length === 0
      || typeof value.model !== 'string' || value.model.length === 0)) {
    throw new Error('session-title-llm: provider and model overrides must be non-empty strings')
  }
  return deepFreeze({ ...value })
}

/**
 * 由提供方准备的模型输入、源消息归属，以及转发给 `ctx.llm.prepareCall` 的、
 * 提供方自有的推理选择器。
 */
export interface SessionTitleLlmPreparedRequest {
  /** 由提供方提供的确切系统提示。 */
  readonly system: string
  /** 由提供方提供的确切用户消息文本，包括任何框架化内容。 */
  readonly input: string
  /** 由 `input` 表示的、确切的人类 `user/message` seq，按日志顺序。 */
  readonly messageSeqs: readonly SessionSeq[]
  /**
   * 针对所捕获路由、由提供方自有的推理选择。执行模块只把返回的力度与
   * 其固定的输出令牌上限结合起来。
   * @param model - 从所捕获的适配器代际中得到的、已分离、深度冻结的元数据。
   * @returns 一个受支持的力度 id，或 `undefined` 以使用该路由的常规默认。
   */
  readonly selectReasoningEffort: (model: Readonly<LlmResolvedModelInfo>) => ReasoningEffortId | undefined
}

/** 转发给提供方、由其自行解读的、终结性的结束类型。 */
export type SessionTitleLlmFinish = Extract<FinishReason, { kind: 'stop' | 'tool-calls' | 'max-tokens' }>

/** 供某个提供方解读的、已装配的辅助模型响应。 */
export interface SessionTitleLlmResponse {
  /** 按流顺序装配的内容块；提供方会拒绝不想要的内容块类型。 */
  readonly blocks: readonly ContentBlock[]
  /** 转发过来的、终结性的结束原因，不做标题产出解读。 */
  readonly finish: SessionTitleLlmFinish
  /** 产生该响应的、确切的辅助模型路由。 */
  readonly model: SessionTitleModelIdentity
}

/** 解析显式成对路由，或从容器的 `request/header` 捕获的精确路由。 */
function resolveRoute(
  config: ResolvedSessionTitleLlmConfig,
  request: SessionTitleProviderRequest,
): SessionTitleModelIdentity {
  if (config.provider !== undefined && config.model !== undefined) {
    return { provider: config.provider, model: config.model }
  }
  if (request.route === undefined) {
    throw new Error('session-title-llm: no logged request route is available; configure provider and model together')
  }
  return request.route
}

/**
 * 对一种终结性的结束原因分类。操作失败会抛出；其它每个终结类型都被返回，
 * 由提供方接受或拒绝。
 * @param finish - 来自已装配流的、终结性的结束原因。
 * @returns 面向提供方的结束原因。
 * @throws {Error} 当提供方或调用方中止，或出现不可能的结束变体时。
 */
function terminalFinish(finish: FinishReason): SessionTitleLlmFinish {
  switch (finish.kind) {
    case 'stop':
    case 'tool-calls':
    case 'max-tokens':
      return finish
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      throw error
    }
    /* v8 ignore next -- 封闭的 FinishReason 联合穷尽性守卫 */
    default: return assertNever(finish, 'FinishReason')
  }
}

/**
 * 执行一次已准备好的辅助标题请求。
 *
 * 提供方拥有系统提示、用户输入、推理选择与产出解读。本函数拥有路由准备、
 * 最终的输入字节上限、输出令牌上限、端到端截止时间、取消、精确的
 * `session/title-llm-request` 记录，以及流装配。
 * @param ctx - 暴露了已注册 LLM 服务的上下文。
 * @param config - 已校验的执行控制。
 * @param request - 服务自有的会话、路由、消息快照、当前标题与取消信号。
 * @param titleProvider - 随请求一并记录的、已注册的标题提供方身份。
 * @param prepared - 提供方的系统提示、输入、源消息 seq 与推理选择器。
 * @returns 装配好的响应块、终结性的结束原因，以及所使用过的精确路由。
 * @throws {Error} 当输入边界、路由准备、截止时间、取消或一次操作性的
 *   结束失败发生时。
 */
export async function executeSessionTitleLlm(
  ctx: Context,
  config: ResolvedSessionTitleLlmConfig,
  request: SessionTitleProviderRequest,
  titleProvider: SessionTitleProviderId,
  prepared: SessionTitleLlmPreparedRequest,
): Promise<SessionTitleLlmResponse> {
  request.signal.throwIfAborted()
  if (prepared.messageSeqs.length === 0) {
    throw new Error('session-title-llm: at least one source message is required')
  }
  const inputBytes = Buffer.byteLength(prepared.input, 'utf8')
  if (inputBytes > config.maxInputBytes) {
    throw new Error(`session-title-llm: input is ${inputBytes} bytes, exceeding maxInputBytes ${config.maxInputBytes}`)
  }
  const route = resolveRoute(config, request)
  const messages: Message[] = [createUserMessage({
    content: [{ type: 'text', text: prepared.input }],
    source: { kind: 'dsh-session-title-llm' },
  })]
  using callDeadline = deadline(request.signal, config.timeoutMs, SESSION_TITLE_TIMEOUT_CODE)
  const maxTokens = config.maxOutputTokens
  const call = await ctx.llm.prepareCall({
    ...route,
    maxTokens,
  }, callDeadline.signal, (controls, model) => {
    const effort = prepared.selectReasoningEffort(model)
    return { ...controls, ...effort === undefined ? {} : { reasoningEffort: effort } }
  })
  const options: GenerateOptions = deepFreeze({
    ...call.config,
    messages,
    system: prepared.system,
    sessionId: request.session.id,
    purpose: 'session-title',
    signal: callDeadline.signal,
  })
  request.session.append('session/title-llm-request', {
    titleProvider,
    messageSeqs: [...prepared.messageSeqs],
    route,
    system: prepared.system,
    messages,
    maxTokens,
    ...call.config.reasoningEffort === undefined ? {} : { reasoningEffort: call.config.reasoningEffort },
  })
  callDeadline.signal.throwIfAborted()
  const assembler = new BlockAssembler()
  for await (const chunk of call.stream(options)) {
    callDeadline.signal.throwIfAborted()
    assembler.push(chunk)
  }
  callDeadline.signal.throwIfAborted()
  const finish = terminalFinish(assembler.finish)
  return { blocks: assembler.blocks(), finish, model: route }
}
