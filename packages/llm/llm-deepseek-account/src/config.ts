/** 账号路由配置：Messages 设置、模型清单端点，以及按模型的覆盖项。 */
import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { isVolatile } from '@deepseek-ai/cosmokit'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { catalogModelFields, deepSeekConfigFields, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import type { Config as ProtocolConfig, DeepSeekCatalogModel, Options as ProtocolOptions, ResolvedDeepSeekOptions } from '@deepseek-ai/dsh-llm-deepseek'

/** 一次模型清单请求、以及首次使用等待的默认截止时间。 */
export const DEFAULT_MODELS_TIMEOUT_MS = 5_000
/** 默认的清单时效；超过该时效后，下一次访问会在后台刷新它。 */
export const DEFAULT_MODELS_MAX_AGE_MS = 600_000

/** 一个模型的字段覆盖项；未设置的字段与空列表都继承底层条目。 */
export type ModelOverride = Omit<DeepSeekCatalogModel, 'id'>

/** 账号路由配置；认证信息仅来自账号服务。 */
export interface Config extends Omit<ProtocolConfig, 'models'> {
  /** 一次清单请求的截止时间，它同时约束首次使用的等待（默认五秒）。 */
  modelsTimeoutMs: Volatile<number>
  /**
   * 清单时效；超过该时效后，下一次访问会在后台刷新它；
   * 加载失败后会在同样的时效之后重试（默认十分钟）。
   */
  modelsMaxAgeMs: Volatile<number>
  /** 按模型 id 组织的字段覆盖项，叠加在账号清单与内置目录之上。 */
  modelOverrides: Volatile<Record<string, ModelOverride>>
}

const { models: _protocolCatalog, ...protocolFields } = deepSeekConfigFields

const modelOverride: z<ModelOverride> = z.object({
  ...catalogModelFields,
  // 与 models 条目不同，这里没有默认值：缺失的列表会物化为 []，其语义为继承。
  inputModalities: z.array(z.union(['text', 'image'] as const)),
})

export const Config = z.object({
  ...protocolFields,
  modelsTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_MODELS_TIMEOUT_MS).volatile(),
  modelsMaxAgeMs: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MODELS_MAX_AGE_MS).volatile(),
  modelOverrides: z.dict(modelOverride).default({}).volatile(),
})

/** {@link resolveAccountOptions} 接受的纯账号选项。 */
export type AccountOptions = Omit<ProtocolOptions, 'models'> & {
  modelsTimeoutMs?: number
  modelsMaxAgeMs?: number
  modelOverrides?: Record<string, ModelOverride>
}

/** 一次配置快照的模型清单端点与缓存时序。 */
export interface CatalogSettings {
  /** 清单端点；它始终与 Messages 同源。 */
  readonly url: string
  /** 一次清单请求的截止时间。 */
  readonly timeoutMs: number
  /** 清单时效；超过该时效后会刷新它。 */
  readonly maxAgeMs: number
}

/** 账号路由的一次已校验配置快照。 */
export interface ResolvedAccountOptions {
  /** Messages 设置；请求解析会把 `models` 替换为已解析的账号目录。 */
  readonly protocol: ResolvedDeepSeekOptions
  /** 清单端点与缓存时序。 */
  readonly catalog: CatalogSettings
  /** 按模型 id 组织的覆盖项，只保存各自声明的字段。 */
  readonly modelOverrides: Readonly<Record<string, ModelOverride>>
}

/**
 * 读取一份已校验 Config 中每个引用背后的当前值。
 * @param config - 已解析的插件 Config。
 * @returns 供 {@link resolveAccountOptions} 使用的纯选项。
 */
export function plainAccountOptions(config: Config): AccountOptions {
  return Object.fromEntries(Object.entries(config).map(([key, value]) => [key, isVolatile(value) ? value.get() : value]))
}

/** 清单端点：Messages 源上的 `/models`，即唯一会收到账号令牌的源。 */
function listingEndpoint(baseURL: string): string {
  return new URL('/models', new URL(baseURL).origin).href
}

/** 只保留覆盖项声明过的字段：解析后的配置把未设置的字段表示为 `undefined`，未设置的数组表示为 `[]`。 */
function resolveOverride(id: string, override: Readonly<Record<string, unknown>>): ModelOverride {
  if (id.length === 0) throw new Error('llm-deepseek-account: modelOverrides keys must be non-empty model ids')
  if (Object.hasOwn(override, 'id')) throw new Error(`llm-deepseek-account: modelOverrides.${id} sets "id", which is its key`)
  const declared: ModelOverride = {}
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined || (Array.isArray(value) && value.length === 0)) continue
    Reflect.set(declared, key, value)
  }
  try {
    // 跨字段规则还涉及覆盖项在清单加载之后所遇到的条目，
    // 因此这里用一个支持图像的替身来校验每个已声明的字段。
    resolveAdapterOptions({ models: [{ inputModalities: ['text', 'image'], ...declared, id }] })
  } catch (error) {
    throw new Error(`llm-deepseek-account: modelOverrides.${id} is invalid: ${String(error)}`, { cause: error })
  }
  return declared
}

/**
 * 从原始账号设置到已校验事实的唯一显式解析步骤。
 * 设置更新可以不经过 schema 校验就到达这里，因此每个边界都在此判定。
 * @param options - 纯账号选项。
 * @param environment - 本次运行的环境层；在产品 CLI 之外为 `undefined`。
 * @returns Messages 设置、清单设置，以及已校验的覆盖项。
 */
export function resolveAccountOptions(options: AccountOptions, environment?: LaunchEnvironmentSnapshot): ResolvedAccountOptions {
  if (Object.hasOwn(options, 'models')) {
    throw new Error('llm-deepseek-account: models is no longer configurable; the account /models listing supplies the catalog. '
      + 'Remove models from this entry and adjust single models with modelOverrides.<model id>')
  }
  const {
    modelsTimeoutMs = DEFAULT_MODELS_TIMEOUT_MS, modelsMaxAgeMs = DEFAULT_MODELS_MAX_AGE_MS,
    modelOverrides = {}, ...protocolOptions
  } = options
  if (!Number.isFinite(modelsTimeoutMs) || modelsTimeoutMs <= 0 || modelsTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`llm-deepseek-account: modelsTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (!Number.isSafeInteger(modelsMaxAgeMs) || modelsMaxAgeMs < 0) {
    throw new Error('llm-deepseek-account: modelsMaxAgeMs must be a non-negative safe integer')
  }
  const protocol = resolveAdapterOptions(protocolOptions, environment)
  return {
    protocol,
    catalog: { url: listingEndpoint(protocol.baseURL), timeoutMs: modelsTimeoutMs, maxAgeMs: modelsMaxAgeMs },
    modelOverrides: Object.fromEntries(Object.entries(modelOverrides).map(([id, override]) => [id, resolveOverride(id, override)])),
  }
}
