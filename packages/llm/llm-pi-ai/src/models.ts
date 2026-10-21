/** 由公开且窄的入口点组装出来的 pi-ai 模型辅助函数。 */

import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import type {
  Api,
  CreateModelsOptions,
  Model,
  ModelThinkingLevel,
  MutableModels,
  Provider,
  ProviderAuth,
  ProviderStreams,
} from '@earendil-works/pi-ai'
import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { THINKING_LEVELS } from './catalog.ts'

/** 本包所构建的那类静态、单协议提供方所接受的输入。 */
interface StaticProviderOptions {
  id: string
  name: string
  baseUrl?: string
  auth: ProviderAuth
  models: readonly Model<Api>[]
  api: ProviderStreams
}

/**
 * 创建一个空的 pi-ai 集合，而不导入它的聚合入口点。
 * @param options - 凭据存储与环境认证的集成。
 * @returns 一个没有注册任何提供方的可变集合。
 */
export function createModels(options?: CreateModelsOptions): MutableModels {
  const models = builtinModels(options)
  models.clearProviders()
  return models
}

/**
 * 创建被已配置的自定义路由所使用的那个静态、单协议提供方。
 * @param input - 提供方身份、各个模型、认证方式，以及协议实现。
 * @returns 一个把每个操作委派给所提供协议的提供方。
 */
export function createProvider(input: StaticProviderOptions): Provider {
  return {
    id: input.id,
    name: input.name,
    ...input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl },
    auth: input.auth,
    getModels: () => input.models,
    stream: (model, context, options) => input.api.stream(model, context, options),
    streamSimple: (model, context, options) => input.api.streamSimple(model, context, options),
  }
}

/**
 * 从 pi-ai 公开的模型元数据解析可选的推理强度。
 * @param model - 携带推理支持与线路映射的模型描述符。
 * @returns 按 pi-ai 的递增顺序排列的、受支持的强度。
 */
export function getSupportedThinkingLevels(model: Model<Api>): ModelThinkingLevel[] {
  if (!model.reasoning) return ['off']
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level]
    if (mapped === null) return false
    if (level === 'xhigh' || level === 'max') return mapped !== undefined
    return true
  })
}

/**
 * 从该精确模型的协议能力解析对话更新模式。
 * @param model - 已物化的 pi-ai 模型，包含目录兼容性标记。
 * @returns 由提示准入与工具历史投影所消费的那些更新模式。
 */
export function conversationUpdates(model: Model<Api>): Pick<LlmResolvedModelInfo, 'systemPromptUpdate' | 'toolUpdate'> {
  const compat = model.compat
  if (compat === undefined || !('supportsMidConvoSystemMessages' in compat)
    || !compat.supportsMidConvoSystemMessages) return {}
  const updates: Pick<LlmResolvedModelInfo, 'systemPromptUpdate' | 'toolUpdate'> = { systemPromptUpdate: 'in-history' }
  if (model.api === 'anthropic-messages'
    && 'supportsMidConvoToolChanges' in compat && compat.supportsMidConvoToolChanges) {
    updates.toolUpdate = 'in-history'
  } else if (model.api === 'openai-completions'
    && 'supportsMidConvoToolAdditions' in compat && compat.supportsMidConvoToolAdditions) {
    updates.toolUpdate = 'addition-only'
  } else if ((model.api === 'openai-responses' || model.api === 'azure-openai-responses' || model.api === 'openai-codex-responses')
    && (('supportsAdditionalTools' in compat && compat.supportsAdditionalTools)
      || ('supportsToolSearch' in compat && compat.supportsToolSearch))) {
    updates.toolUpdate = 'addition-only'
  }
  return updates
}
