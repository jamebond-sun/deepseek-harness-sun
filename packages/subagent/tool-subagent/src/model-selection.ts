/** 子代理工具的子 LLM 路由选择。 */

import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'

/** 由一项用户设置授权的一个精确子 LLM 路由。 */
export interface AllowedModelRoute {
  /** 已注册的 LLM 提供方 id。 */
  readonly provider: string
  /** 由提供方拥有的精确模型 id。 */
  readonly model: string
}

/** 由宿主设置与其部署基线共享的模式。 */
export const AllowedModelRouteSchema: z<AllowedModelRoute> = z.object({
  provider: z.string().min(1).required(),
  model: z.string().min(1).required(),
})

/** 由一个委托定义所捕获的路由选择权威。 */
export interface ModelSelectionPolicy {
  /** 被授权用于显式选择的精确 provider/model 路由。 */
  readonly routes: readonly AllowedModelRoute[]
}

/**
 * 一个 provider/model 对的稳定身份。
 * @param route - 精确的 provider/model 路由。
 * @returns 用于相等性检查的不透明键。
 */
export function modelRouteKey(route: AllowedModelRoute): string {
  return `${route.provider}\0${route.model}`
}

/**
 * 在持久化或配置边界处拒收畸形或重复的路由策略条目。
 * @param routes - 待校验的候选精确路由。
 * @returns 一个断言：候选者是一个已校验的精确路由数组。
 */
export function assertAllowedModelRoutes(routes: unknown): asserts routes is readonly AllowedModelRoute[] {
  if (!Array.isArray(routes)) {
    throw new Error('subagent model selection requires an array of routes')
  }
  const seen = new Set<string>()
  const candidates: readonly unknown[] = routes
  for (const candidate of candidates) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)
      || !('provider' in candidate) || typeof candidate.provider !== 'string'
      || !('model' in candidate) || typeof candidate.model !== 'string'
      || candidate.provider.length === 0 || candidate.model.length === 0) {
      throw new Error('subagent model selection requires non-empty provider and model ids')
    }
    const route = { provider: candidate.provider, model: candidate.model }
    const key = modelRouteKey(route)
    if (seen.has(key)) {
      throw new Error(`subagent model selection repeats route "${route.provider}/${route.model}"`)
    }
    seen.add(key)
  }
}

/** 面向模型的子 LLM 路由字段。 */
export interface DelegationModelRequest {
  readonly provider?: string
  readonly model?: string
  readonly reasoning_effort?: string
}

/**
 * 一次调用是否显式选择了任何子 LLM 值。
 * @param request - 来自工具调用的、面向模型的路由字段。
 * @returns 是否至少存在一个路由或 effort 字段。
 */
export function hasDelegationModelRequest(request: DelegationModelRequest): boolean {
  return request.provider !== undefined
    || request.model !== undefined
    || request.reasoning_effort !== undefined
}

/** 在工具 JSON 边界处拒收一个空的、面向模型的路由值。 */
function assertNonEmpty(value: string | undefined, field: keyof DelegationModelRequest): void {
  if (value !== undefined && value.length === 0) {
    throw new Error(`child LLM \`${field}\` must be non-empty`)
  }
}

/**
 * 把模型提供的选择字段合并覆盖到已配置的子默认值之上。
 * Provider 与 model 构成一个路由，必须一起提供。在没有 effort 的情况下
 * 更改该路由会清除已配置的、由路由拥有的 effort。
 * @param parentOptions - 提供缺失子值的当前父值。
 * @param configured - 工具实例的子默认值。
 * @param request - 面向模型的路由覆盖项。
 * @param enabled - 本工具实例是否允许面向模型的选择。
 * @returns 子 Agent 选项；当没有层贡献某个值时保留省略。
 */
export function requestedAgentOptions(
  parentOptions: AgentOptions,
  configured: AgentOptions | undefined,
  request: DelegationModelRequest,
  enabled: boolean,
): AgentOptions | undefined {
  if (!hasDelegationModelRequest(request)) return configured
  if (!enabled) {
    throw new Error('child model selection is disabled for this tool instance')
  }
  assertNonEmpty(request.provider, 'provider')
  assertNonEmpty(request.model, 'model')
  assertNonEmpty(request.reasoning_effort, 'reasoning_effort')
  if ((request.provider === undefined) !== (request.model === undefined)) {
    throw new Error('child LLM `provider` and `model` must be supplied together')
  }

  const baselineProvider = configured?.provider ?? parentOptions.provider
  const baselineModel = configured?.model ?? parentOptions.model
  const routeChanged = request.provider !== undefined
    && (request.provider !== baselineProvider || request.model !== baselineModel)
  const { reasoningEffort: _configuredReasoningEffort, ...configuredWithoutReasoning } = configured ?? {}
  return {
    ...routeChanged && request.reasoning_effort === undefined ? configuredWithoutReasoning : configured,
    ...request.provider === undefined ? {} : { provider: request.provider, model: request.model },
    ...request.reasoning_effort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(request.reasoning_effort) },
  }
}

/**
 * 在创建子代理的那个操作上强制一份由设置拥有的路由列表。
 * 纯继承不在本策略之内，因为没有发生任何面向模型的选择；任何显式的路由
 * 或 effort 字段都必须解析为一个被允许的路由。
 * @param policy - 为本次 Session 捕获的选择权威。
 * @param parentOptions - 提供缺失子值的当前父值。
 * @param requested - 请求/配置合并之后生效的子选项。
 * @param request - 来自工具调用的、面向模型的选择字段。
 */
export function assertAllowedModelSelection(
  policy: ModelSelectionPolicy | undefined,
  parentOptions: AgentOptions,
  requested: AgentOptions | undefined,
  request: DelegationModelRequest,
): void {
  if (policy === undefined || !hasDelegationModelRequest(request)) return
  const provider = requested?.provider ?? parentOptions.provider
  const model = requested?.model ?? parentOptions.model
  if (provider === undefined || model === undefined) {
    throw new Error('cannot select child LLM values without an effective provider and model')
  }
  if (policy.routes.some(route => route.provider === provider && route.model === model)) return
  throw new Error(`child LLM route "${provider}/${model}" is not allowed for this Session`)
}

/**
 * 已配置的 Agent 选项在委托之前是否需要路由校验。
 * @param options - 工具实例的子默认值。
 * @returns 是否必须解析已配置的 provider、model 或 effort 值。
 */
export function hasConfiguredLlmSelection(options: AgentOptions | undefined): boolean {
  return options?.provider !== undefined
    || options?.model !== undefined
    || options?.reasoningEffort !== undefined
}

/**
 * 在创建子代理之前通过其实时适配器解析一个生效的子路由。LLM 运行时拥有
 * 提供方查找、精确模型元数据、effort 校验与适配器默认值。
 * @param llm - 实时的 LLM 运行时。
 * @param parentOptions - 子代理继承其兼容字段的当前父值。
 * @param requested - 请求/配置合并之后的按子选项。
 * @param signal - 工具调用的取消信号。
 * @param inheritParentReasoningEffort - 被省略的 effort 是否可以从父路由继承。
 */
export async function preflightChildLlmRoute(
  llm: LlmRuntime,
  parentOptions: AgentOptions,
  requested: AgentOptions | undefined,
  signal: AbortSignal,
  inheritParentReasoningEffort = true,
): Promise<void> {
  const provider = requested?.provider ?? parentOptions.provider
  const model = requested?.model ?? parentOptions.model
  if (provider === undefined || model === undefined) {
    throw new Error('cannot select child LLM values without an effective provider and model')
  }
  const routeChanged = provider !== parentOptions.provider || model !== parentOptions.model
  const reasoningEffort = requested?.reasoningEffort
    ?? (inheritParentReasoningEffort && !routeChanged ? parentOptions.reasoningEffort : undefined)
  await llm.resolveCallConfig({
    provider,
    model,
    ...reasoningEffort === undefined ? {} : { reasoningEffort },
  }, signal)
}
