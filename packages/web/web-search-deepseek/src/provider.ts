/**
 * 通过兼容 Anthropic 的 Messages 模型调用、使用原生的 `web_search_20250305` 服务端工具进行
 * DeepSeek 搜索。每次搜索消耗一次模型轮次，但返回结构化的结果块；缺少这些块是一个错误，而非
 * 退回散文抓取的兜底。线格式与原生 `fetch` 客户端都是提供方私有的，不使用 `ctx.llm`。
 * @module @deepseek-ai/dsh-web-search-deepseek/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-session'
import type {
  AnthropicError,
  AnthropicResponse,
  ContentBlock,
  TextBlock,
  WebSearchToolResultBlock,
} from './types.ts'

/** 本提供方注册的固定 id。 */
export const DEEPSEEK_PROVIDER_ID = 'deepseek-official'

/**
 * 默认的辅助搜索端点，含 `/v1`；会追加 `/messages`。
 * `$DEEPSEEK_SEARCH_BASE_URL` 独立于对话适配器的端点覆盖它。两个提供方共享 API 密钥。
 */
export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic/v1'

/** 默认的 Anthropic 格式模型名（与仓库的 DeepSeek 模型词表对齐）。 */
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-flash'

/** 默认的 `anthropic-version` 头值。 */
export const DEEPSEEK_DEFAULT_API_VERSION = '2023-06-01'

/** Messages 请求生成令牌的默认上限。 */
export const DEEPSEEK_DEFAULT_MAX_TOKENS = 4096

/** 每次请求 `web_search` 服务端工具的默认最大使用次数。 */
export const DEEPSEEK_DEFAULT_MAX_USES = 5

/** 每次请求发送的归因头。随包版本递增。 */
const USER_AGENT = 'deepseek-harness/0.0.1'

/**
 * 恰好在辅助搜索分发之前记录的、无密钥的 DeepSeek Messages 请求。
 */
export interface DeepSeekSearchLlmRequest {
  /** 完全解析后的 Messages 端点。 */
  readonly endpoint: string
  /** `anthropic-version` 头值。 */
  readonly apiVersion: string
  /** 发送给提供方的精确 JSON 体。 */
  readonly body: {
    readonly model: string
    readonly max_tokens: number
    readonly messages: readonly [{
      readonly role: 'user'
      readonly content: readonly [{
        readonly type: 'text'
        readonly text: string
      }]
    }]
    readonly tools: readonly [{
      readonly type: 'web_search_20250305'
      readonly name: 'web_search'
      readonly max_uses: number
    }]
    /**
     * 辅助轮次的思考模式。提供方总是发送 `disabled`：它丢弃生成的文本，
     * 因此推理令牌没有消费者。缺省表示该请求省略了字段，提供方应用其默认值。
     */
    readonly thinking?: { readonly type: 'disabled' }
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** 在分发之前记录的、无密钥的辅助 DeepSeek 搜索请求。 */
    'web/deepseek-search-llm-request': DeepSeekSearchLlmRequest
  }
}

/** 已解析的提供方选项（插件的 `apply` 提供凭据与常量默认值）。 */
export interface DeepSeekSearchProviderOptions {
  /**
   * 为一次搜索端点解析 DeepSeek 账号令牌。令牌优先于任何 API 密钥，且仅作为
   * `x-dsh-auth-token` 发送；`undefined` 表示选择 API 密钥认证。
   */
  resolveAccountToken?: (endpoint: string) => Promise<string | undefined>
  /** 字面 DeepSeek API 密钥；存在时胜过 {@link resolveApiKey}。 */
  apiKey?: string
  /** 为一次搜索操作解析当前的 DeepSeek API 密钥。 */
  resolveApiKey?: () => Promise<string | undefined>
  /** 缺失凭据诊断所命名的凭据引用。 */
  apiKeyEnv?: CredentialRef
  /** 端点基址；会追加 `/messages`。 */
  baseURL: string
  /** Anthropic 格式的模型名。 */
  model: string
  /** `anthropic-version` 头值。 */
  apiVersion: string
  /** Messages 请求生成令牌的上限。 */
  maxTokens: number
  /** 每次请求 `web_search` 服务端工具的最大使用次数。 */
  maxUses: number
  /**
   * 在分发之前记录精确的无密钥请求。抛出可阻止分发，从而面向模型的辅助输入
   * 不会逃逸出日志。
   */
  recordRequest?: (request: DeepSeekSearchLlmRequest) => void
}

/**
 * 从每个 `text` 块的 `citations[]` 构建 `url → cited_text` 映射。这是摘要来源：Anthropic 的
 * `web_search_result` 项携带 `url`/`title`/`page_age`，但通常没有内联摘要 —— 摘录存在于一个独立的
 * `text` 块的引用中，以 `url` 为键（首次出现胜出）。
 *
 * @param blocks - 响应的内容块；非 `text` 块被跳过。
 * @returns `url → cited_text` 映射（无引用时为空）。
 */
export function citationSnippets(blocks: readonly ContentBlock[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const block of blocks) {
    if (block.type !== 'text') continue
    for (const cite of (block as TextBlock).citations ?? []) {
      if (cite.url != null && cite.url.length > 0 && cite.cited_text != null && cite.cited_text.length > 0 && !map.has(cite.url)) {
        map.set(cite.url, cite.cited_text)
      }
    }
  }
  return map
}

/**
 * 将 DeepSeek 的 Anthropic Messages 响应映射为归一化的搜索结果。遍历 `web_search_tool_result`
 * 块以寻找可引用的 `web_search_result` 项，将每一项与它的引用摘录连接为 `snippet`，并按 `url`
 * 去重（一个 `max_uses > 1` 的请求可能在多次搜索间暴露同一 URL）。web 服务拥有最终的
 * `maxResults` 截断，因此此处的 `truncated` 始终为 `false`。
 *
 * @param response - 解析后的 Messages 响应体。
 * @returns 带去重、已连接摘要的来源的归一化结果。
 * @throws 当原生搜索未产生任何结果块时抛出 {@link WebError}。
 */
export function mapAnthropicResponse(response: AnthropicResponse): WebSearchResult {
  const blocks = response.content ?? []
  const resultBlocks = blocks.filter(
    (block): block is WebSearchToolResultBlock => block.type === 'web_search_tool_result',
  )
  if (resultBlocks.length === 0) {
    throw new WebError(
      'DeepSeek returned no web_search_tool_result blocks; the request may not have triggered native web search',
      'WEB_PROVIDER_ERROR',
    )
  }

  const snippets = citationSnippets(blocks)
  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  for (const block of resultBlocks) {
    for (const item of block.content ?? []) {
      if (item.type !== 'web_search_result' || item.url.length === 0 || seen.has(item.url)) continue
      seen.add(item.url)
      const snippet = snippets.get(item.url)
      sources.push({
        url: item.url,
        ...item.title != null && item.title.length > 0 ? { title: item.title } : {},
        ...snippet != null && snippet.length > 0 ? { snippet } : {},
        ...item.page_age != null && item.page_age.length > 0 ? { publishedAt: item.page_age } : {},
      })
    }
  }
  return { sources, truncated: false }
}

/** 一次搜索的认证头，由产生它的凭据打上标记。 */
interface SearchAuth {
  /** `account` 表示 DeepSeek 账号令牌，`api-key` 表示 API 密钥。 */
  readonly kind: 'account' | 'api-key'
  /** 携带凭据的头。 */
  readonly headers: Readonly<Record<string, string>>
}

/**
 * DeepSeek 支持的搜索提供方。HTTP 重定向作为 `WEB_PROVIDER_ERROR` 失败；
 * 分发之后的失败会指出端点，并告诉模型用户如何配置它。
 */
export class DeepSeekSearchProvider implements WebSearchProvider {
  readonly id = DEEPSEEK_PROVIDER_ID

  /**
   * @param resolveOptions - 供下一次操作使用的选项，在每次操作入口处一次性快照，
   *   因此一次搜索绝不会混用两个节。选择 thunk 而非值，是因为插件的设置节可能在
   *   两次搜索之间变化，而为携带新端点而重新注册提供方会让该 seam 的选择作为闪烁
   *   对用户可见。
   */
  constructor(private readonly resolveOptions: () => DeepSeekSearchProviderOptions) {}

  available(): boolean {
    const options = this.resolveOptions()
    return ((options.apiKey?.length ?? 0) > 0 || options.resolveApiKey !== undefined || options.resolveAccountToken !== undefined)
      && URL.canParse(options.baseURL)
      && isPositiveInteger(options.maxTokens)
      && isPositiveInteger(options.maxUses)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    // 整个操作使用一份快照：凭据解析会 await，而落在该 await 内的设置写入绝不能把从旧节
    // 解析出的密钥发往新节命名的端点。
    const options = this.resolveOptions()
    const endpoint = `${options.baseURL}/messages`
    const auth = await this.authHeaders(options, endpoint, signal)
    throwIfSearchAborted(signal)
    const body: DeepSeekSearchLlmRequest['body'] = {
      model: options.model,
      max_tokens: options.maxTokens,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: `Perform a web search for the query: ${request.query}` }],
      }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: options.maxUses }],
      thinking: { type: 'disabled' },
    }
    options.recordRequest?.({
      endpoint,
      apiVersion: options.apiVersion,
      body,
    })
    throwIfSearchAborted(signal)
    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          ...auth.headers,
          'anthropic-version': options.apiVersion,
          'content-type': 'application/json',
          'accept': 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify(body),
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
      throw searchEndpointError(
        endpoint,
        `DeepSeek search request failed: ${String(error)}`,
        error,
      )
    }

    if (!response.ok) {
      const status = response.status
      let message = `DeepSeek API error (HTTP ${status})`
      try {
        const parsed = await response.json() as AnthropicError
        const detail = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? parsed.message
        if (detail !== undefined && detail.length > 0) message += `: ${detail}`
      } catch (error: unknown) {
        // 在正文读取中途触发的取消必须以 WEB_ABORTED 呈现，而不能被吞入一个
        // 泛化的 HTTP 错误消息 —— 取消不是提供方错误（该 seam 的取消契约）。
        if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
        // 否则：HTTP 状态已在上方的 `message` 中捕获；一个畸形/非 JSON 的错误体
        //（网关 5xx/429 的常见情况）最多损失一个更丰富的提供方消息，绝不会丢失真实错误。
      }
      // 账号服务仅为它的推理来源释放此令牌，因此端点不是用户需要修改的对象。
      if (status === 401 && auth.kind === 'account') throw accountRejectedError(message)
      throw searchEndpointError(endpoint, message)
    }

    try {
      const payload = await response.json() as AnthropicResponse
      return mapAnthropicResponse(payload)
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
      const message = error instanceof WebError
        ? error.message
        : `DeepSeek returned an unprocessable response body: ${String(error)}`
      throw searchEndpointError(endpoint, message, error)
    }
  }

  /**
   * 解析一次操作的认证头，且不长期在提供方上保留凭据。
   * @param options - 调用方的快照，因此凭据与其发往的端点来自同一节。
   * @param endpoint - 本次操作分发到的 Messages 端点。
   * @param signal - 周边搜索的取消信号。
   * @returns 当某个令牌解析成功时为账号令牌头，否则为 API 密钥头，并按凭据种类打上标记。
   */
  private async authHeaders(
    options: DeepSeekSearchProviderOptions, endpoint: string, signal?: AbortSignal,
  ): Promise<SearchAuth> {
    const { resolveAccountToken } = options
    const token = resolveAccountToken === undefined
      ? undefined
      : await resolveCredential(() => resolveAccountToken(endpoint), signal)
    if (token !== undefined && token.length > 0) return { kind: 'account', headers: { 'x-dsh-auth-token': token } }
    const apiKey = await this.apiKey(options, signal)
    // 官方 DeepSeek 期望 `x-api-key`；兼容 Anthropic 的代理可能期望
    // `Authorization: Bearer` —— 两者都发送，以便任一方都能解析。
    return { kind: 'api-key', headers: { 'x-api-key': apiKey, 'authorization': `Bearer ${apiKey}` } }
  }

  /**
   * 解析一次操作的 API 密钥，且不长期在提供方上保留它。
   * @param options - 调用方的快照，因此密钥与其发往的端点来自同一节。
   * @param signal - 周边搜索的取消信号。
   * @returns 解析得到的密钥。
   */
  private async apiKey(options: DeepSeekSearchProviderOptions, signal?: AbortSignal): Promise<string> {
    throwIfSearchAborted(signal)
    if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey
    const { resolveApiKey } = options
    const resolved = resolveApiKey === undefined ? undefined : await resolveCredential(resolveApiKey, signal)
    if (resolved !== undefined && resolved.length > 0) return resolved
    const ref = options.apiKeyEnv ?? 'DEEPSEEK_API_KEY'
    throw new WebError(
      `DeepSeek search has no API key for "${ref}"; store it through the credentials service`
      + ' (the web Models page writes it), export it in the launching environment, or set a literal'
      + ' "apiKey" in the web-search-deepseek config; a conversation using a DeepSeek Account model'
      + ' searches with the account sign-in instead',
      'WEB_PROVIDER_CREDENTIAL_MISSING',
    )
  }
}

/**
 * 在搜索的取消信号之下运行一个凭据解析器。一个已经取消的搜索绝不会启动解析器。
 * @param resolve - 解析器；同步抛出会被像拒绝一样映射。
 * @param signal - 周边搜索的取消信号。
 * @returns 解析得到的凭据，或解析器未提供时为 undefined。
 * @throws 取消时抛出 {@link WebError} `WEB_ABORTED`，解析器失败时抛出 `WEB_PROVIDER_ERROR`。
 */
async function resolveCredential(
  resolve: () => Promise<string | undefined>, signal?: AbortSignal,
): Promise<string | undefined> {
  throwIfSearchAborted(signal)
  try {
    return await abortable(resolve(), signal)
  } catch (error: unknown) {
    if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
    throw new WebError(
      `DeepSeek search credential resolution failed: ${String(error)}`,
      'WEB_PROVIDER_ERROR',
      { cause: error },
    )
  }
}

/** 当 DeepSeek 拒绝账号令牌时，将端点指导替换为登录指导。 */
function accountRejectedError(message: string): WebError {
  return new WebError(
    `${message}\n\nDeepSeek rejected the account sign-in used for this web search. `
    + 'Guide the user to sign in to DeepSeek again; the search endpoint does not need changing.',
    'WEB_PROVIDER_ERROR',
  )
}

/** 为请求分发开始之后发生的失败附加端点恢复指引。 */
function searchEndpointError(endpoint: string, message: string, cause?: unknown): WebError {
  return new WebError(
    `${message}\n\nThe web request used endpoint ${JSON.stringify(endpoint)}. `
    + 'Search endpoint configuration is separate from chat. If that endpoint is not intended, '
    + 'guide the user to Plugins > Built-in plugin settings > Web search, where they can '
    + 'change and save Messages API base URL. If that settings page is unavailable, the user can set '
    + 'web-search-deepseek.baseURL to a trusted DeepSeek endpoint. Only the user should choose or change the endpoint.',
    'WEB_PROVIDER_ERROR',
    cause === undefined ? undefined : { cause },
  )
}

/**
 * 让同进程的异步预检与调用方取消竞争。附加的 settle 处理器在 abort 之后继续观察一个
 * 不合作的操作，使得后续的拒绝不会变成未处理。
 */
function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation
  if (signal.aborted) return Promise.reject(searchAborted(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(searchAborted(signal)) }
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(new Error(String(error).replace(/^Error: /u, ''), { cause: error }))
      },
    )
  })
}

/** 当调用方已经取消时，抛出提供方稳定的取消错误。 */
function throwIfSearchAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw searchAborted(signal)
}

/** 在保留调用方原因的同时，构建提供方稳定的取消错误。 */
function searchAborted(signal?: AbortSignal, fallback?: unknown): WebError {
  return new WebError('DeepSeek search aborted', 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

/** 对于 fetch/`AbortSignal` 的取消返回 true，以 `WEB_ABORTED` 呈现。 */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** 对于可以发往 Messages API 的 DeepSeek 请求上限返回 true。 */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}
