/** DeepSeek `GET /models` 清单：一次带认证的请求，以及逐条解码。 */
import { APP_IDENTITY, attributionHeaders, LlmError } from '@deepseek-ai/dsh-llm'
import type { ModelModality } from '@deepseek-ai/dsh-llm'
import { timeoutOf } from '@deepseek-ai/dsh-timeout'

const LISTED_MODALITIES = ['text', 'image'] as const satisfies readonly ModelModality[]

/** 清单截止时间的超时原因码；{@link requestModelListing} 将其报告为 `TIMEOUT`。 */
export const LISTING_TIMEOUT = 'MODEL_LISTING_TIMEOUT'

/** 在本客户端的产品令牌下，一条清单条目所声明的要求。 */
export type ClientRequirement =
  | { readonly kind: 'none' }
  | { readonly kind: 'min-version'; readonly version: string }
  | { readonly kind: 'invalid' }

/** 一条可用清单条目以目录词汇声明的能力。 */
export interface ListedFacts {
  /** 本构建会发送的、被接受的请求模态。 */
  readonly inputModalities: readonly ModelModality[]
  /** 请求与响应的合计上下文，若已声明。 */
  readonly contextWindow?: number
  /** 输出能力，若已声明。 */
  readonly maxOutputTokens?: number
  /** Messages 系统提示模式，若已声明；除 `in-history` 之外的任何值都读作 `leading-only`。 */
  readonly systemPromptUpdate?: 'in-history' | 'leading-only'
}

/** 已声明的能力，或 Messages 传输无法驱动该模型的原因。 */
export type ListedCapabilities =
  | { readonly usable: true; readonly facts: ListedFacts }
  | { readonly usable: false; readonly reason: string }

/** 一条已解码的清单条目；能力不可用也不会隐藏它的 id、名称或要求。 */
export interface ListingEntry {
  /** 线格式模型 id。 */
  readonly id: string
  /** 展示名称，若该条目声明了非空名称。 */
  readonly name?: string
  /** 在 `client_requirements[APP_IDENTITY.product]` 之下声明的要求。 */
  readonly requirement: ClientRequirement
  /** 已声明的能力。 */
  readonly capabilities: ListedCapabilities
}

/** 至少含有一条条目的已解码清单。 */
export interface ModelListing {
  /** 按清单顺序排列的条目。 */
  readonly entries: readonly ListingEntry[]
  /** 没有可用 id 的行，以及重复的 id。 */
  readonly skipped: number
}

type Fields = Readonly<Record<string, unknown>>

function fieldsOf(value: unknown): Fields | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Fields : undefined
}

/** 本构建会发送的、按清单顺序去重后的已列出模态；当值不是数组时为 `undefined`。 */
function knownModalities(value: unknown): ModelModality[] | undefined {
  if (!Array.isArray(value)) return undefined
  const listed: readonly unknown[] = value
  return LISTED_MODALITIES.filter(modality => listed.includes(modality))
    .toSorted((left, right) => listed.indexOf(left) - listed.indexOf(right))
}

/** 一个已声明的容量：缺失时为 `undefined`，不是正整数安全整数时为 `false`。 */
function capacity(value: unknown): number | undefined | false {
  if (value === undefined) return undefined
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : false
}

function requirementOf(entry: Fields): ClientRequirement {
  if (entry.client_requirements === undefined) return { kind: 'none' }
  const requirements = fieldsOf(entry.client_requirements)
  if (requirements === undefined) return { kind: 'invalid' }
  const declared = requirements[APP_IDENTITY.product]
  if (declared === undefined) return { kind: 'none' }
  const own = fieldsOf(declared)
  if (own === undefined) return { kind: 'invalid' }
  if (own.min_version === undefined) return { kind: 'none' }
  return typeof own.min_version === 'string' && own.min_version.length > 0
    ? { kind: 'min-version', version: own.min_version }
    : { kind: 'invalid' }
}

function capabilitiesOf(entry: Fields): ListedCapabilities {
  const messages = fieldsOf(fieldsOf(entry.api_capabilities)?.anthropic_messages)
  if (messages === undefined) return { usable: false, reason: 'declares no api_capabilities.anthropic_messages' }
  const outputs = entry.output_modalities === undefined ? ['text'] : knownModalities(entry.output_modalities)
  if (outputs?.includes('text') !== true) return { usable: false, reason: 'declares no text output' }
  const inputs = entry.input_modalities === undefined ? ['text' as const] : knownModalities(entry.input_modalities)
  if (inputs === undefined || inputs.length === 0) return { usable: false, reason: 'declares no input modality DeepSeek Harness supports' }
  const contextWindow = capacity(entry.context_window)
  const maxOutputTokens = capacity(entry.max_output_tokens)
  if (contextWindow === false || maxOutputTokens === false) {
    return { usable: false, reason: 'declares an invalid context_window or max_output_tokens' }
  }
  const update = messages.system_prompt_update
  return {
    usable: true,
    facts: {
      inputModalities: inputs,
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxOutputTokens === undefined ? {} : { maxOutputTokens },
      ...update === undefined ? {} : { systemPromptUpdate: update === 'in-history' ? 'in-history' : 'leading-only' },
    },
  }
}

/**
 * 逐条解码一个 `/models` 响应体。
 * @param body - 已解析的 JSON 响应。
 * @returns 具备可用 id 的条目，按清单顺序排列。
 * @throws LlmError `INVALID_RESPONSE` 当响应体没有 `data` 数组或没有可用条目时。
 */
export function parseModelListing(body: unknown): ModelListing {
  const data = fieldsOf(body)?.data
  if (!Array.isArray(data)) throw new LlmError('DeepSeek model listing has no "data" array', 'INVALID_RESPONSE')
  const rows: readonly unknown[] = data
  const entries: ListingEntry[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const entry = fieldsOf(row)
    const id = entry?.id
    if (entry === undefined || typeof id !== 'string' || id.length === 0 || seen.has(id)) continue
    seen.add(id)
    entries.push({
      id,
      ...typeof entry.name === 'string' && entry.name.length > 0 ? { name: entry.name } : {},
      requirement: requirementOf(entry),
      capabilities: capabilitiesOf(entry),
    })
  }
  if (entries.length === 0) throw new LlmError('DeepSeek model listing contains no model entry', 'INVALID_RESPONSE')
  return { entries, skipped: rows.length - entries.length }
}

/**
 * 请求并解码一份模型清单。重定向会失败，因此凭据只停留在被请求的源上。
 * @param url - 清单端点。
 * @param headers - 该端点使用的认证头。
 * @param signal - 整次交换的取消信号与截止时间。
 * @returns 已解码的清单。
 * @throws LlmError `TIMEOUT` 当 {@link LISTING_TIMEOUT} 截止时间在完整响应体到达之前耗尽时，`ABORTED` 表示
 *   其他中止，`TRANSPORT` 表示网络故障，`HTTP_<status>` 表示非 2xx 应答，
 *   `INVALID_RESPONSE` 表示响应体不是 JSON 清单。
 */
export async function requestModelListing(
  url: string, headers: Readonly<Record<string, string>>, signal: AbortSignal,
): Promise<ModelListing> {
  let response: Response
  let text: string
  try {
    response = await fetch(url, {
      method: 'GET', redirect: 'error', signal,
      headers: { ...attributionHeaders(), accept: 'application/json', ...headers },
    })
    text = await response.text()
  } catch (error) {
    const expired = timeoutOf(signal, LISTING_TIMEOUT)
    if (expired !== undefined) {
      throw new LlmError(`DeepSeek model listing request to ${url} timed out after ${expired.timeoutMs} ms`, 'TIMEOUT', { cause: error })
    }
    throw signal.aborted
      ? new LlmError(`DeepSeek model listing request to ${url} was aborted`, 'ABORTED', { cause: error })
      : new LlmError(`could not reach ${url}`, 'TRANSPORT', { cause: error })
  }
  if (!response.ok) throw new LlmError(`${url} answered HTTP ${response.status}`, `HTTP_${response.status}`, { status: response.status })
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch (error) {
    throw new LlmError(`${url} did not answer with JSON`, 'INVALID_RESPONSE', { cause: error })
  }
  return parseModelListing(body)
}
