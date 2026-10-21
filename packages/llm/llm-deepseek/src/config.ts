/** DeepSeek 的插件配置与完整的请求级解析。 */
import type { Volatile } from '@deepseek-ai/cordis'

import z from '@deepseek-ai/schemastery'
import { isVolatile } from '@deepseek-ai/cosmokit'
import { resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { ModelModality, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import type { LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { DeepSeekCatalogModel, DeepSeekConnectionOptions } from './types.ts'
import { DEFAULT_MODELS } from './models.ts'
import { DEFAULT_STREAM_IDLE_TIMEOUT_MS, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, DEFAULT_MAX_INLINE_REQUEST_IMAGE_BYTES, DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM, DEFAULT_INLINE_IMAGE_OFFLOAD_BYTE_QUANTUM, DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM, DEFAULT_FILE_EXPIRY_SECONDS, DEFAULT_FILE_REFRESH_MARGIN_SECONDS, DEFAULT_FILE_QUOTA_CLEANUP_BATCH, DEFAULT_FILES_API_TIMEOUT_MS } from './defaults.ts'
import { DEFAULT_MAX_IMAGES_PER_REQUEST, DEFAULT_MAX_REQUEST_FILES_BYTES, DEFAULT_REQUEST_IMAGE_MAX_BYTES } from './request-pricing.ts'

const MODEL_MODALITIES = ['text', 'image'] as const satisfies readonly ModelModality[]

/** 共享的 Messages 请求配置，不含提供方凭据选择。 */
export interface Config {
  /** 端点基址；依次回退到可信环境层中的 $DEEPSEEK_BASE_URL，然后是公共 API。 */
  baseURL: Volatile<string | undefined>
  /** 部署级的 thinking 策略；`disabled` 会把每次对话请求都限制为 `off`。 */
  thinking: Volatile<'enabled' | 'disabled' | undefined>
  /** 默认的 thinking 强度（默认 `high`）；`off` 会按请求禁用 thinking。 */
  reasoningEffort: Volatile<'off' | 'low' | 'high' | 'max' | undefined>
  /** 默认的按请求输出上限（默认 256,000）；模型自身的上限与显式请求值优先。 */
  maxTokens: Volatile<number>
  /** 当选中的模型没有精确值时使用的正上下文容量（默认 1,000,000）。 */
  defaultContextWindow: Volatile<number>
  /** 发现消费者展示的参考模型；默认为 V4.1 Flash 与 V4 Pro。 */
  models: Volatile<DeepSeekCatalogModel[]>
  /** 一次流式读取处于未完成状态时提供方的最大空闲时间（默认五分钟）。 */
  streamIdleTimeoutMs: Volatile<number>
  /** 每次对话请求中文件引用的图像字节累计上限（默认 128 MiB）。 */
  maxRequestFilesBytes: Volatile<number>
  /** Files API 回退之后 base64 图像载荷的累计上限（默认 20 MiB）。 */
  maxInlineRequestImageBytes: Volatile<number>
  /** 每次对话请求中被表示出来的图像的最大数量（默认 600）。 */
  maxImagesPerRequest: Volatile<number>
  /** 请求超出其文件上限之后的原始字节移除步长（默认 64 MiB）。 */
  imageOffloadByteQuantum: Volatile<number>
  /** 内联回退超出其上限之后的 base64 字节移除步长（默认 10 MiB）。 */
  inlineImageOffloadByteQuantum: Volatile<number>
  /** 请求超出其数量上限之后的图像数量移除步长（默认 20）。 */
  imageOffloadCountQuantum: Volatile<number>
  /** 一张请求图像通过 Files API 解析的最长时间（默认一分钟）。 */
  filesApiTimeoutMs: Volatile<number>
  /** 为每张上传图像指派的显式生命周期（默认七天）。 */
  fileExpiresAfterSeconds: Volatile<number>
  /** 已索引文件的剩余生命周期低于该值时会被替换（默认一小时）。 */
  fileRefreshMarginSeconds: Volatile<number>
  /** 一次配额恢复上传重试之前删除的最早的 harness 自有文件数量（默认 100）。 */
  fileQuotaCleanupBatch: Volatile<number>
  /** 由提供方持有的模型请求重试策略；省略时使用普通模式并重试五次。 */
  retryPolicy: Volatile<RetryPolicyConfig | undefined>
}

/** 提供方解析器接受的纯选项。 */
export type Options = { [K in keyof Config]?: Config[K] extends Volatile<infer T> ? Exclude<T, undefined> : never }

/** 读取一份已校验 Config 中每个引用背后的当前值。
 * @param config 已解析的插件 Config。
 * @returns 供解析器使用的纯选项。
 */
export function plainOptions(config: Config): Options {
  return Object.fromEntries(Object.entries(config).map(([key, value]) => [key, isVolatile(value) ? value.get() : value]))
}

/**
 * 除 `id` 与 `inputModalities` 之外的目录条目字段的 schema；
 * 在 `models` 条目与提供方的按模型覆盖项之间，它们的必填性与默认值不同。
 */
export const catalogModelFields = {
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  imagePixelBudget: z.union([z.number().step(1).min(1), 'low']),
  imageMaxBytes: z.number().step(1).min(1),
  systemPromptUpdate: z.const('in-history'),
  toolUpdate: z.union(['in-history', 'addition-only'] as const),
}

const catalogModel: z<DeepSeekCatalogModel> = z.object({
  id: z.string().required(),
  ...catalogModelFields,
  inputModalities: z.array(z.union(MODEL_MODALITIES)).min(1).default(['text']),
})

/** Messages 协议选项的共享 schema 字段。 */
export const deepSeekConfigFields = {
  baseURL: z.string().volatile(),
  thinking: z.union(['enabled', 'disabled']).volatile(),
  reasoningEffort: z.union(['off', 'low', 'high', 'max']).volatile(),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS).volatile(),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW).volatile(),
  models: z.array(catalogModel).default(DEFAULT_MODELS).volatile(),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS).volatile(),
  maxRequestFilesBytes: z.number().step(1).min(1).default(DEFAULT_MAX_REQUEST_FILES_BYTES).volatile(),
  maxInlineRequestImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_INLINE_REQUEST_IMAGE_BYTES).volatile(),
  maxImagesPerRequest: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGES_PER_REQUEST).volatile(),
  imageOffloadByteQuantum: z.number().step(1).min(1).default(DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM).volatile(),
  inlineImageOffloadByteQuantum: z.number().step(1).min(1).default(DEFAULT_INLINE_IMAGE_OFFLOAD_BYTE_QUANTUM).volatile(),
  imageOffloadCountQuantum: z.number().step(1).min(1).default(DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM).volatile(),
  filesApiTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_FILES_API_TIMEOUT_MS).volatile(),
  fileExpiresAfterSeconds: z.number().step(1).min(3_600).max(2_592_000).default(DEFAULT_FILE_EXPIRY_SECONDS).volatile(),
  fileRefreshMarginSeconds: z.number().step(1).min(0).default(DEFAULT_FILE_REFRESH_MARGIN_SECONDS).volatile(),
  fileQuotaCleanupBatch: z.number().step(1).min(1).max(1_000).default(DEFAULT_FILE_QUOTA_CLEANUP_BATCH).volatile(),
  retryPolicy: RetryPolicySchema.volatile(),
}

export const Config = z.object(deepSeekConfigFields)

/** 公共 API 默认值；内部端点来自 $DEEPSEEK_BASE_URL。 */
export const PUBLIC_BASE_URL = 'https://api.deepseek.com/anthropic'

/** 命名本提供方端点的环境变量，仅对可信层生效。 */
const BASE_URL_ENV = 'DEEPSEEK_BASE_URL'

/** 为一次请求操作捕获的完整协议设置。 */
export type ResolvedDeepSeekOptions = DeepSeekConnectionOptions

/** 解析、校验并分离参考模型目录。 */
function resolveModels(models: readonly DeepSeekCatalogModel[] | undefined): DeepSeekCatalogModel[] {
  const seen = new Set<string>()
  return (models ?? DEFAULT_MODELS).map((model) => {
    if (Object.hasOwn(model, 'imageDetail')) {
      throw new Error('llm-deepseek: catalog model imageDetail is no longer supported; use imagePixelBudget')
    }
    if (model.id.length === 0) throw new Error('llm-deepseek: catalog model ids must be non-empty')
    if (model.name !== undefined && model.name.length === 0) {
      throw new Error(`llm-deepseek: catalog model "${model.id}" has an empty name`)
    }
    if (model.contextWindow !== undefined
      && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
      throw new Error(
        `llm-deepseek: catalog model "${model.id}" contextWindow must be a positive integer`,
      )
    }
    if (model.maxTokens !== undefined
      && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) {
      throw new Error(
        `llm-deepseek: catalog model "${model.id}" maxTokens must be a positive integer`,
      )
    }
    const inputModalities = model.inputModalities ?? ['text']
    if (inputModalities.length === 0) {
      throw new Error(`llm-deepseek: catalog model "${model.id}" inputModalities must not be empty`)
    }
    if (inputModalities.some(modality => !MODEL_MODALITIES.includes(modality))) {
      throw new Error(
        `llm-deepseek: catalog model "${model.id}" inputModalities must contain only "text" and "image"`,
      )
    }
    if (new Set(inputModalities).size !== inputModalities.length) {
      throw new Error(`llm-deepseek: catalog model "${model.id}" inputModalities must not contain duplicates`)
    }
    const hasImage = inputModalities.includes('image')
    if (!hasImage && (model.imagePixelBudget !== undefined || model.imageMaxBytes !== undefined)) {
      throw new Error(`llm-deepseek: text-only catalog model "${model.id}" cannot declare image request limits`)
    }
    if (model.imagePixelBudget !== undefined
      && model.imagePixelBudget !== 'low'
      && (!Number.isSafeInteger(model.imagePixelBudget) || model.imagePixelBudget <= 0)) {
      throw new Error(`llm-deepseek: catalog model "${model.id}" imagePixelBudget must be "low" or a positive safe integer`)
    }
    if (model.imageMaxBytes !== undefined
      && (!Number.isSafeInteger(model.imageMaxBytes) || model.imageMaxBytes <= 0)) {
      throw new Error(`llm-deepseek: catalog model "${model.id}" imageMaxBytes must be a positive safe integer`)
    }
    // 放宽：一次动态配置更新会在没有 schema 校验的情况下到达这项检查。
    const systemPromptUpdate: string | undefined = model.systemPromptUpdate
    if (systemPromptUpdate !== undefined && systemPromptUpdate !== 'in-history') {
      throw new Error(`llm-deepseek: catalog model "${model.id}" systemPromptUpdate must be "in-history" when present`)
    }
    const toolUpdate: string | undefined = model.toolUpdate
    if (toolUpdate !== undefined && toolUpdate !== 'in-history' && toolUpdate !== 'addition-only') {
      throw new Error(`llm-deepseek: catalog model "${model.id}" toolUpdate must be "in-history" or "addition-only" when present`)
    }
    if (seen.has(model.id)) throw new Error(`llm-deepseek: duplicate catalog model "${model.id}"`)
    seen.add(model.id)
    return {
      id: model.id,
      ...model.name === undefined ? {} : { name: model.name },
      ...model.description === undefined ? {} : { description: model.description },
      ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
      ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
      ...model.systemPromptUpdate === undefined ? {} : { systemPromptUpdate: model.systemPromptUpdate },
      ...model.toolUpdate === undefined ? {} : { toolUpdate: model.toolUpdate },
      inputModalities: [...inputModalities],
      ...hasImage
        ? {
          ...model.imagePixelBudget === undefined ? {} : { imagePixelBudget: model.imagePixelBudget },
          imageMaxBytes: model.imageMaxBytes ?? DEFAULT_REQUEST_IMAGE_MAX_BYTES,
        }
        : {},
    }
  })
}

/**
 * 从原始配置到已校验协议设置的唯一显式解析步骤。
 * 程序化构造可能绕过 Schemastery 的规范化，因此每个默认值与边界都在此重新判定——
 * 既针对加载时的组合条目（立即失败），也针对每次设置快照的首次使用。
 * @param config - 原始插件配置或已解析的设置快照。
 * @param environment - 本次运行的环境层；在产品 CLI 之外为
 * `undefined`。每一层都可以提供端点：产品信任它启动时所在的项目，
 * 因此一次检出可以把自己的 agent 指向该检出应当使用的网关。
 * @returns 已校验的协议设置；`models` 按输入顺序为每个输入模型保存一个已解析条目，
 * 当 `models` 缺失时则为内置目录。
 */
export function resolveAdapterOptions(config: Options, environment?: LaunchEnvironmentSnapshot): ResolvedDeepSeekOptions {
  // 设置更新可以在没有 schema 校验的情况下到达本解析器。
  if (Object.hasOwn(config, 'protocol')) {
    throw new Error('llm-deepseek: protocol is not configurable; remove it and use a Messages-compatible baseURL')
  }
  if (config.thinking === 'disabled'
    && config.reasoningEffort !== undefined
    && config.reasoningEffort !== 'off') {
    throw new Error('llm-deepseek: only reasoningEffort "off" can be configured when thinking is disabled')
  }
  if (config.defaultContextWindow !== undefined
    && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) {
    throw new Error('llm-deepseek: defaultContextWindow must be a positive integer')
  }
  if (config.maxTokens !== undefined
    && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0)) {
    throw new Error('llm-deepseek: maxTokens must be a positive safe integer')
  }
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs)
    || streamIdleTimeoutMs <= 0
    || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `llm-deepseek: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  const maxRequestFilesBytes = config.maxRequestFilesBytes ?? DEFAULT_MAX_REQUEST_FILES_BYTES
  if (!Number.isSafeInteger(maxRequestFilesBytes) || maxRequestFilesBytes <= 0) {
    throw new Error('llm-deepseek: maxRequestFilesBytes must be a positive safe integer')
  }
  const maxInlineRequestImageBytes = config.maxInlineRequestImageBytes ?? DEFAULT_MAX_INLINE_REQUEST_IMAGE_BYTES
  if (!Number.isSafeInteger(maxInlineRequestImageBytes) || maxInlineRequestImageBytes <= 0) {
    throw new Error('llm-deepseek: maxInlineRequestImageBytes must be a positive safe integer')
  }
  const maxImagesPerRequest = config.maxImagesPerRequest ?? DEFAULT_MAX_IMAGES_PER_REQUEST
  if (!Number.isSafeInteger(maxImagesPerRequest) || maxImagesPerRequest <= 0) {
    throw new Error('llm-deepseek: maxImagesPerRequest must be a positive safe integer')
  }
  const imageOffloadByteQuantum = config.imageOffloadByteQuantum ?? DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM
  if (!Number.isSafeInteger(imageOffloadByteQuantum) || imageOffloadByteQuantum <= 0) {
    throw new Error('llm-deepseek: imageOffloadByteQuantum must be a positive safe integer')
  }
  if (imageOffloadByteQuantum > maxRequestFilesBytes) {
    throw new Error('llm-deepseek: imageOffloadByteQuantum must not exceed maxRequestFilesBytes')
  }
  const inlineImageOffloadByteQuantum = config.inlineImageOffloadByteQuantum
    ?? DEFAULT_INLINE_IMAGE_OFFLOAD_BYTE_QUANTUM
  if (!Number.isSafeInteger(inlineImageOffloadByteQuantum) || inlineImageOffloadByteQuantum <= 0) {
    throw new Error('llm-deepseek: inlineImageOffloadByteQuantum must be a positive safe integer')
  }
  if (inlineImageOffloadByteQuantum > maxInlineRequestImageBytes) {
    throw new Error('llm-deepseek: inlineImageOffloadByteQuantum must not exceed maxInlineRequestImageBytes')
  }
  const imageOffloadCountQuantum = config.imageOffloadCountQuantum ?? DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM
  if (!Number.isSafeInteger(imageOffloadCountQuantum) || imageOffloadCountQuantum <= 0) {
    throw new Error('llm-deepseek: imageOffloadCountQuantum must be a positive safe integer')
  }
  if (imageOffloadCountQuantum > maxImagesPerRequest) {
    throw new Error('llm-deepseek: imageOffloadCountQuantum must not exceed maxImagesPerRequest')
  }
  const filesApiTimeoutMs = config.filesApiTimeoutMs ?? DEFAULT_FILES_API_TIMEOUT_MS
  if (!Number.isFinite(filesApiTimeoutMs)
    || filesApiTimeoutMs <= 0
    || filesApiTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `llm-deepseek: filesApiTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  const fileExpiresAfterSeconds = config.fileExpiresAfterSeconds ?? DEFAULT_FILE_EXPIRY_SECONDS
  if (!Number.isSafeInteger(fileExpiresAfterSeconds)
    || fileExpiresAfterSeconds < 3_600
    || fileExpiresAfterSeconds > 2_592_000) {
    throw new Error('llm-deepseek: fileExpiresAfterSeconds must be an integer from 3600 through 2592000')
  }
  const fileRefreshMarginSeconds = config.fileRefreshMarginSeconds ?? DEFAULT_FILE_REFRESH_MARGIN_SECONDS
  if (!Number.isSafeInteger(fileRefreshMarginSeconds)
    || fileRefreshMarginSeconds < 0
    || fileRefreshMarginSeconds >= fileExpiresAfterSeconds) {
    throw new Error('llm-deepseek: fileRefreshMarginSeconds must be a non-negative integer below fileExpiresAfterSeconds')
  }
  const fileQuotaCleanupBatch = config.fileQuotaCleanupBatch ?? DEFAULT_FILE_QUOTA_CLEANUP_BATCH
  if (!Number.isSafeInteger(fileQuotaCleanupBatch)
    || fileQuotaCleanupBatch < 1
    || fileQuotaCleanupBatch > 1_000) {
    throw new Error('llm-deepseek: fileQuotaCleanupBatch must be an integer from 1 through 1000')
  }
  const baseURL = config.baseURL ?? environment?.get(BASE_URL_ENV)?.value ?? PUBLIC_BASE_URL
  const parsed = new URL(baseURL)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('llm-deepseek: Messages baseURL must be an HTTP(S) root without credentials, query, or fragment')
  }
  return {
    baseURL,
    defaults: {
      thinking: config.thinking,
      reasoningEffort: config.reasoningEffort,
    },
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    models: resolveModels(config.models),
    streamIdleTimeoutMs,
    maxRequestFilesBytes,
    maxInlineRequestImageBytes,
    maxImagesPerRequest,
    imageOffloadByteQuantum,
    inlineImageOffloadByteQuantum,
    imageOffloadCountQuantum,
    filesApiTimeoutMs,
    filePolicy: {
      expiresAfterSeconds: fileExpiresAfterSeconds,
      refreshMarginSeconds: fileRefreshMarginSeconds,
      quotaCleanupBatch: fileQuotaCleanupBatch,
    },
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-deepseek: retryPolicy'),
  }
}
