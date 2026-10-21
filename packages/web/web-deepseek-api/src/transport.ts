/**
 * 本包中搜索与抓取 API 提供方共享的认证与拒绝重定向的传输层。凭据解析、分发调用和
 * 取消辅助逻辑刻意地重复 `dsh-web-search-deepseek`，因此两个插件互不依赖；
 * `jscpd:ignore` 区域标记了这些重复
 * ([理由](../../../../.agents/notes/implemented/feature/2026-10-15-deepseek-search-fetch-api.md))。
 * @module @deepseek-ai/dsh-web-deepseek-api/transport
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { WebError } from '@deepseek-ai/dsh-web'

const ACCOUNT_PROVIDER = 'deepseek-account'
const USER_AGENT = 'deepseek-harness/0.0.1'

/** 为一次操作一次性解析的认证与端点值。 */
export interface DeepSeekWebAuth {
  /** 解析一个允许的账号令牌；undefined 表示选择 API 密钥认证。 */
  resolveAccountToken?: (endpoint: string) => Promise<string | undefined>
  /** 字面 API 密钥；优先于凭据解析器。 */
  apiKey?: string
  /** 解析当前 API 密钥，且不长期保留它。 */
  resolveApiKey?: () => Promise<string | undefined>
  /** 缺失密钥诊断所命名的凭据引用。 */
  apiKeyEnv?: CredentialRef
}

/** 分发失败时所命名的用户拥有的端点设置。 */
export interface DeepSeekWebGuidance {
  /** 端点失败的那个能力。 */
  subject: 'Search' | 'Fetch'
  /** 插件配置命名空间。 */
  plugin: string
  /** 端点配置字段。 */
  field: string
  /** 本地设置标签。 */
  label: string
  /** 内置设置页标题。 */
  page: string
}

/** 一个完全解析后的 web API 请求。 */
interface DeepSeekWebRequest<T> {
  /** 绝对分发 URL。 */
  endpoint: string
  /** JSON 请求体。 */
  body: object
  /** 不带凭据的协议头。 */
  headers?: Readonly<Record<string, string>>
  /** 额外的 API 密钥头；不应用于账号令牌。 */
  apiKeyHeaders?: (key: string) => Readonly<Record<string, string>>
  /** 校验并投影响应。 */
  decode: (payload: unknown) => T
  /** 端点恢复设置。 */
  guidance: DeepSeekWebGuidance
  /** 在分发前记录模型输入；抛出可阻止分发。 */
  recordRequest?: (endpoint: string) => void
}

/* jscpd:ignore-start */
/**
 * 为一次操作解析凭据来源，且不长期保留机密值。
 * @param ctx - 带有请求路由与凭据服务的提供方上下文。
 * @param config - 来自设置快照的字面密钥与凭据引用。
 * @returns 一次操作的认证来源。
 */
export function deepSeekWebAuth(ctx: Context, config: { apiKey: string | undefined; apiKeyEnv: string }): DeepSeekWebAuth {
  const apiKeyEnv = credentialRef(config.apiKeyEnv)
  const literalApiKey = config.apiKey !== undefined && config.apiKey.length > 0
    ? config.apiKey
    : undefined
  return {
    ...literalApiKey === undefined ? {} : { apiKey: literalApiKey },
    resolveAccountToken: async (endpoint) => {
      // 最新的请求上下文命名了服务于调用此搜索的模型请求的路由，
      // 因为账号登出会读取它。
      const provider = ctx.get('agents')?.currentInitiator()?.session.requestContext()?.provider
      if (provider !== ACCOUNT_PROVIDER) return undefined
      return await ctx.get('deepseekAccount')?.resolveToken(endpoint)
    },
    resolveApiKey: async () => {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) return (await credentials.resolve(apiKeyEnv))?.value
      // 没有该 seam 时，环境就是整个凭据平面。
      const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv)
      return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
    },
    apiKeyEnv,
  }
}
/* jscpd:ignore-end */

/**
 * 检查是否存在一个认证来源；不解析凭据。
 * @param auth - 该操作的来源。
 * @returns 是否存在字面密钥或解析器。
 */
export function hasDeepSeekWebCredential(auth: DeepSeekWebAuth): boolean {
  return (auth.apiKey?.length ?? 0) > 0 || auth.resolveApiKey !== undefined || auth.resolveAccountToken !== undefined
}

/** 收窄一个远端 JSON 对象。
 * @param value - 不可信 JSON。
 * @returns 是否存在可读的对象字段。
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 报告畸形的上游 JSON，且不内嵌响应内容。
 * @returns 稳定的提供方错误。
 */
export function invalidResponse(): WebError {
  return new WebError('DeepSeek returned an invalid response body', 'WEB_PROVIDER_ERROR')
}

/** 一次操作的认证头，由产生它的凭据打上标记。 */
interface SearchAuth {
  /** `account` 表示 DeepSeek 账号令牌，`api-key` 表示 API 密钥。 */
  readonly kind: 'account' | 'api-key'
  /** 携带凭据的头。 */
  readonly headers: Readonly<Record<string, string>>
}

/** 使用一份设置与凭据快照分发一次操作。
 * @param options - 本次操作的认证来源。
 * @param request - 已解析的端点、JSON 负载和响应解码器。
 * @param signal - 调用方的取消信号。
 * @returns 校验通过的提供方结果。
 */
export async function dispatchDeepSeekWeb<T>(
  options: DeepSeekWebAuth, request: DeepSeekWebRequest<T>, signal?: AbortSignal,
): Promise<T> {
  const { endpoint, body, decode, recordRequest, guidance } = request
  const auth = await authHeaders(options, request, signal)
  throwIfSearchAborted(signal)
  recordRequest?.(endpoint)
  throwIfSearchAborted(signal)
  let response: Response
  /* jscpd:ignore-start */
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        ...auth.headers,
        ...request.headers,
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
      guidance,
      endpoint,
      `DeepSeek web request failed: ${String(error)}`,
      error,
    )
  }
  /* jscpd:ignore-end */

  if (!response.ok) {
    const status = response.status
    let message = `DeepSeek API error (HTTP ${status})`
    try {
      const parsed: unknown = await response.json()
      if (isRecord(parsed)) {
        const detail = typeof parsed.error === 'string' ? parsed.error
          : isRecord(parsed.error) ? parsed.error.message : parsed.message
        if (typeof detail === 'string' && detail.length > 0) message += `: ${detail}`
      }
    } catch (error: unknown) {
      // 在正文读取中途触发的取消必须以 WEB_ABORTED 呈现，而不能被吞入一个
      // 泛化的 HTTP 错误消息 —— 取消不是提供方错误（该 seam 的取消契约）。
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
      // 否则：HTTP 状态已在上方的 `message` 中捕获；一个畸形/非 JSON 的错误体
      //（网关 5xx/429 的常见情况）最多损失一个更丰富的提供方消息，绝不会丢失真实错误。
    }
    // 账号服务仅为它的推理来源释放此令牌，因此端点不是用户需要修改的对象。
    if (status === 401 && auth.kind === 'account') throw accountRejectedError(message)
    throw searchEndpointError(guidance, endpoint, message)
  }

  try {
    const payload: unknown = await response.json()
    throwIfSearchAborted(signal)
    return decode(payload)
  } catch (error: unknown) {
    if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
    const message = error instanceof WebError
      ? error.message
      : `DeepSeek returned an unprocessable response body: ${String(error)}`
    throw searchEndpointError(guidance, endpoint, message, error)
  }
}

/** 当 DeepSeek 拒绝账号令牌时，将端点指导替换为登录指导。 */
function accountRejectedError(message: string): WebError {
  return new WebError(
    `${message}\n\nDeepSeek rejected the account sign-in used for this web request. `
    + 'Guide the user to sign in to DeepSeek again; the endpoint does not need changing.',
    'WEB_PROVIDER_ERROR',
  )
}

/**
 * 为请求分发开始之后发生的失败附加端点恢复指引。
 * @param options - 指导所命名的插件、设置字段和设置页。
 * @param endpoint - 被分发的端点。
 * @param message - 失败描述。
 * @param cause - 底层失败，当存在时。
 * @returns 带有恢复指引的提供方失败。
 */
function searchEndpointError(
  options: DeepSeekWebGuidance, endpoint: string, message: string, cause?: unknown,
): WebError {
  return new WebError(
    `${message}\n\nThe web request used endpoint ${JSON.stringify(endpoint)}. `
    + `${options.subject} endpoint configuration is separate from chat. If that endpoint is not intended, `
    + `guide the user to Plugins > Built-in plugin settings > ${options.page}, where they can `
    + `change and save ${options.label}. If that settings page is unavailable, the user can set `
    + `${options.plugin}.${options.field} to a trusted DeepSeek endpoint. Only the user should choose or change the endpoint.`,
    'WEB_PROVIDER_ERROR',
    cause === undefined ? undefined : { cause },
  )
}

/**
 * 解析一次操作的认证头，且不长期在提供方上保留凭据。
 * @param options - 调用方的快照，因此凭据与其发往的端点来自同一节。
 * @param request - 已解析的请求；其端点限定账号令牌的作用域。
 * @param signal - 周边操作的取消信号。
 * @returns 当某个令牌解析成功时为账号令牌头，否则为 API 密钥头，并按凭据种类打上标记。
 */
async function authHeaders(
  options: DeepSeekWebAuth, request: DeepSeekWebRequest<unknown>, signal?: AbortSignal,
): Promise<SearchAuth> {
  const { resolveAccountToken } = options
  const token = resolveAccountToken === undefined
    ? undefined
    : await resolveCredential(() => resolveAccountToken(request.endpoint), signal)
  if (token !== undefined && token.length > 0) return { kind: 'account', headers: { 'x-dsh-auth-token': token } }
  const apiKey = await resolveApiKey(options, request.guidance.plugin, signal)
  return { kind: 'api-key', headers: {
    ...request.apiKeyHeaders?.(apiKey),
    'authorization': `Bearer ${apiKey}`,
  } }
}

/* jscpd:ignore-start */
/**
 * 解析一次操作的 API 密钥，且不长期在提供方上保留它。
 * @param options - 调用方的快照，因此密钥与其发往的端点来自同一节。
 * @param plugin - 缺失密钥诊断所命名的配置命名空间。
 * @param signal - 周边操作的取消信号。
 * @returns 解析得到的密钥。
 */
async function resolveApiKey(options: DeepSeekWebAuth, plugin: string, signal?: AbortSignal): Promise<string> {
  throwIfSearchAborted(signal)
  if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey
  const { resolveApiKey } = options
  const resolved = resolveApiKey === undefined ? undefined : await resolveCredential(resolveApiKey, signal)
  if (resolved !== undefined && resolved.length > 0) return resolved
  const ref = options.apiKeyEnv ?? 'DEEPSEEK_API_KEY'
  throw new WebError(
    `DeepSeek web access has no API key for "${ref}"; store it through the credentials service`
      + ' (the web Models page writes it), export it in the launching environment, or set a literal'
      + ` "apiKey" in the ${plugin} config; a conversation using a DeepSeek Account model`
      + ' searches with the account sign-in instead',
    'WEB_PROVIDER_CREDENTIAL_MISSING',
  )
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
      `DeepSeek web credential resolution failed: ${String(error)}`,
      'WEB_PROVIDER_ERROR',
      { cause: error },
    )
  }
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
  return new WebError('DeepSeek web request aborted', 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

/** 对于 fetch/`AbortSignal` 的取消返回 true，以 `WEB_ABORTED` 呈现。 */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
/* jscpd:ignore-end */
