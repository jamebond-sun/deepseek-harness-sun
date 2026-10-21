/** 面向模型的、对子 Agents 可用 LLM 路由的发现。 */

import type { Context } from '@deepseek-ai/cordis'
import type LlmRuntime from '@deepseek-ai/dsh-llm'
import type { LlmProviderInfo } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ModelSelectionPolicy } from './model-selection.ts'

interface ListSubagentModelsRequest {
  readonly provider?: string
  readonly model?: string
}

/** 解析一个已注册的提供方，并带有一条可纠正模型的诊断。 */
function registeredProvider(
  llm: LlmRuntime,
  policy: ModelSelectionPolicy,
  providerId: string,
): LlmProviderInfo {
  const providers = llm.listProviders()
  const provider = providers.find(candidate => candidate.id === providerId)
  if (provider !== undefined) return provider
  const available = providers
    .filter(candidate => policy.routes.some(route => route.provider === candidate.id))
    .map(candidate => candidate.id)
    .join(', ') || '(none)'
  throw new Error(`LLM provider "${providerId}" is not registered; available providers: ${available}`)
}

/** 渲染一个已声明或已解析的模型。 */
function modelLine(provider: string, model: { id: string; name: string; description?: string }): string {
  return `${provider}/${model.id} — ${model.name}${model.description === undefined ? '' : `: ${model.description}`}`
}

/** 读取所请求的提供方、已声明的模型，或精确模型的 efforts。 */
async function listSubagentModels(
  ctx: Context,
  policy: ModelSelectionPolicy,
  request: ListSubagentModelsRequest,
  signal: AbortSignal,
): Promise<string> {
  const llm = ctx.get('llm')
  if (llm === undefined) {
    throw new Error('cannot discover child LLM routes because the `llm` service is unavailable')
  }
  if (request.model !== undefined && request.provider === undefined) {
    throw new Error('`model` requires `provider`')
  }
  if (request.provider === undefined) {
    const providers = llm.listProviders()
      .filter(provider => policy.routes.some(route => route.provider === provider.id))
    return providers.length === 0
      ? '(no LLM providers)'
      : providers.map(provider => `${provider.id} — ${provider.name}`).join('\n')
  }
  if (request.provider.length === 0) throw new Error('`provider` must be non-empty')
  const allowedRoutes = policy.routes.filter(route => route.provider === request.provider)
  if (allowedRoutes.length === 0) {
    throw new Error(`LLM provider "${request.provider}" is not allowed for this Session`)
  }
  const provider = registeredProvider(llm, policy, request.provider)
  if (request.model === undefined) {
    const models = (await llm.listModels(provider.id))
      .filter(model => allowedRoutes.some(route => route.model === model.id))
    return models.length === 0
      ? `(no advertised models for ${provider.id})`
      : models.map(model => modelLine(provider.id, model)).join('\n')
  }
  if (request.model.length === 0) throw new Error('`model` must be non-empty')
  if (!allowedRoutes.some(route => route.model === request.model)) {
    throw new Error(`child LLM route "${provider.id}/${request.model}" is not allowed for this Session`)
  }
  const model = await llm.resolveModelInfo(provider.id, request.model, signal)
  const efforts = model.reasoning?.efforts.map(effort => (
    `${effort.id}${model.reasoning?.defaultEffort === effort.id ? ' (default)' : ''} — ${effort.name}`
    + (effort.description === undefined ? '' : `: ${effort.description}`)
  )).join('\n') || '(no advertised reasoning efforts)'
  return `${modelLine(provider.id, model)}\nReasoning efforts:\n${efforts}`
}

/**
 * 为一个所属的委托工具实例注册 `list_subagent_models`。
 * @param ctx - 其工具注册表拥有该固定发现定义的 Context。
 * @param policy - 为本次 Session 捕获的路由策略。
 */
export function registerListSubagentModels(ctx: Context, policy: ModelSelectionPolicy): void {
  ctx.tools.register(defineTool({
    name: 'list_subagent_models',
    description:
      'Discover LLM routes for subagents without changing the current Agent. Call with no arguments to list '
      + 'registered providers, with `provider` to list its advertised models, or with `provider` and `model` '
      + 'to inspect that exact model and its reasoning efforts. Catalog membership is advisory: an adapter may '
      + 'accept an unlisted model id. Use the returned ids with a delegation tool\'s `provider`, `model`, and '
      + '`reasoning_effort` fields.',
    parameters: {
      provider: {
        type: 'string',
        description: 'Registered LLM provider id. Omit to list providers.',
      },
      model: {
        type: 'string',
        description: 'Exact model id to inspect. Requires provider; omit to list that provider\'s advertised models.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, result) => [{ type: 'text', text: result }],
    },
    execute(args, exec) {
      return listSubagentModels(ctx, policy, args, exec.signal)
    },
  }))
}
