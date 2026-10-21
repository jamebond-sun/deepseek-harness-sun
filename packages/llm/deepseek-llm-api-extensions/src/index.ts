/**
 * DeepSeek LLM API 扩展注册表：各插件独立持有顶层请求字段，官方适配器执行一次
 * 准备与接受事务。
 * @module @deepseek-ai/dsh-deepseek-llm-api-extensions
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  DeepSeekLlmApiExtensionMap,
  DeepSeekLlmApiExtensionProvider,
  DeepSeekLlmApiExtensionRequest,
  DeepSeekLlmApiJson,
  PreparedDeepSeekLlmApiExtensions,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    deepseekLlmApiExtensions: DeepSeekLlmApiExtensionRegistry
  }
}

interface ErasedProvider {
  prepare(request: DeepSeekLlmApiExtensionRequest):
    | { readonly value: DeepSeekLlmApiJson; accept?(): void | Promise<void> }
    | undefined
    | Promise<{ readonly value: DeepSeekLlmApiJson; accept?(): void | Promise<void> } | undefined>
}

/** 递归冻结一份全新的结构化克隆。 */
function freezeJson<T extends DeepSeekLlmApiJson>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Array.isArray(value) ? value : Object.values(value)) freezeJson(child)
    Object.freeze(value)
  }
  return value
}

/** 在报告失败之前先让所有接受回调落定。 */
async function acceptAll(callbacks: readonly (() => void | Promise<void>)[]): Promise<void> {
  const outcomes = await Promise.allSettled(callbacks.map(callback => Promise.resolve().then(callback)))
  const failures: unknown[] = outcomes
    .filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
    .map(outcome => outcome.reason as unknown)
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'DeepSeek LLM API extension acceptance failed')
}

/** 当所在的模型请求被取消时，停止等待提供方的工作。 */
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  const aborted = Promise.withResolvers<never>()
  const onAbort = (): void => { aborted.reject(signal.reason) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    const result = await Promise.race([work, aborted.promise])
    signal.throwIfAborted()
    return result
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** 官方 DeepSeek 请求中各自独立持有的顶层字段的注册表。 */
export class DeepSeekLlmApiExtensionRegistry extends Service {
  private readonly providers = new Map<string, ErasedProvider>()
  /** 准备阶段已经告警过的字段；之后的失败保持静默。 */
  private readonly warnedFields = new Set<string>()

  constructor(ctx: Context) {
    super(ctx, 'deepseekLlmApiExtensions')
  }

  /**
   * 注册某个顶层请求字段的唯一提供方。注册受 effect 作用域约束。
   * @param field - 由提供方声明合并持有的字段。
   * @param provider - 请求时的字段准备行为，以及可选的接受行为。
   * @returns 释放该字段的 disposer。
   */
  register<K extends keyof DeepSeekLlmApiExtensionMap>(
    field: K,
    provider: DeepSeekLlmApiExtensionProvider<DeepSeekLlmApiExtensionMap[K]>,
  ): () => Promise<void> {
    const fieldName = field as string
    if (fieldName.length === 0 || fieldName.trim() !== fieldName) {
      throw new Error('deepseek-llm-api-extensions: field must be a non-blank trimmed string')
    }
    const providers = this.providers
    const erased = provider as ErasedProvider
    const dispose = this.ctx.effect(() => {
      if (providers.has(fieldName)) {
        throw new Error(`deepseek-llm-api-extensions: field ${JSON.stringify(fieldName)} is already registered`)
      }
      providers.set(fieldName, erased)
      return () => {
        providers.delete(fieldName)
      }
    }, `deepseekLlmApiExtensions.register(${JSON.stringify(fieldName)})`)
    return dispose
  }

  /**
   * 基于同一个不可变的基础请求，准备当前已注册的全部字段。
   * 准备过程抛错、或其值无法克隆的提供方，会从本次请求中省略；每个字段的首次
   * 此类失败会被记录日志。只有取消会导致 reject。字段值会被克隆并冻结；
   * 提供方不会持有指向外发请求的可变别名。
   * @param request - 附加扩展字段之前的、精确的序列化请求事实。
   * @returns 已分离的字段，以及它们幂等的联合接受事务。
   */
  async prepare(request: DeepSeekLlmApiExtensionRequest): Promise<PreparedDeepSeekLlmApiExtensions> {
    request.signal.throwIfAborted()
    const entries = [...this.providers.entries()]
    const prepared = await abortable(Promise.all(entries.map(async ([field, provider]) => {
      try {
        const result = await provider.prepare(request)
        return result === undefined ? undefined : { field, value: freezeJson(structuredClone(result.value)), result }
      } catch (error) {
        if (!request.signal.aborted && !this.warnedFields.has(field)) {
          this.warnedFields.add(field)
          this.ctx.logger.warn(`deepseek-llm-api-extensions: omitting field ${JSON.stringify(field)} from this request because its preparation failed: %o`, error)
        }
        return undefined
      }
    })), request.signal)
    const fields: Record<string, DeepSeekLlmApiJson> = Object.create(null) as Record<string, DeepSeekLlmApiJson>
    const callbacks: Array<() => void | Promise<void>> = []
    for (const item of prepared) {
      if (item === undefined) continue
      const { field, value, result } = item
      fields[field] = value
      const accept = result.accept
      if (accept !== undefined) callbacks.push(accept.bind(result))
    }
    Object.freeze(fields)
    let acceptance: Promise<void> | undefined
    return {
      fields,
      accept: () => acceptance ??= acceptAll(callbacks),
    }
  }
}

export default DeepSeekLlmApiExtensionRegistry
