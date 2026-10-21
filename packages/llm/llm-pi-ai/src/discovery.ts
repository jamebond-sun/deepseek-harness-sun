/**
 * 为配置界面上“获取可用模型”这个动作回答“这条提供方能提供哪些模型？”。
 *
 * 一条已安装的 pi-ai 目录所自带的路由，会**从那个目录**作答，
 * 完全不产生网络调用：pi-ai 的注册表对它自己的提供方而言是权威列表，
 * 并且它携带了一个列表端点所不会披露的那些容量。只有一条目录没有描述过
 * 的路由——一个网关、一台自托管的服务器——才会通过线路被探查。
 *
 * 这两条路径都不是一次目录刷新。这里没有任何东西被存储：该请求携带
 * 的是用户仍在编辑的草稿，而应答是某个界面可以提议采纳的候选元数据。
 * `cordis.patch.yml` 仍然是决定一条路由提供什么的唯一因素。
 *
 * OpenAI 兼容与 Anthropic Messages 协议通过它们原生的模型列表端点被探查。
 * 解析器接受标准的 `data` 数组，以及某些兼容网关所暴露的那种更丰富的
 * `models` 映射。其他每一种协议都会报告它无法被探查，因此界面会回退到
 * 手工录入，而不是去猜测它的响应字段。
 *
 * @module dsh-llm-pi-ai/discovery
 */

import { INVALID_CREDENTIAL_CODE, LlmError, normalizeApiKey } from '@deepseek-ai/dsh-llm'
import type { LlmDiscoveredModel, LlmModelDiscoveryOperation } from '@deepseek-ai/dsh-llm'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import { catalogModels } from './catalog.ts'

/**
 * 本模块能够读取其模型列表的那些协议。OpenAI 各协议在
 * `GET {baseURL}/models` 上使用 bearer 认证；Anthropic Messages 在它原生的
 * `GET /v1/models` 上使用 `x-api-key` 与 `anthropic-version`。尽管 Azure
 * 出身于 OpenAI，它并不在此列——它用一个 `api-key` 请求头认证，并且要求
 * 一个 `api-version` 查询参数——而 Codex 通过 OAuth 认证；对两者中的任一
 * 个凭空猜测，都会把一次认证失败报告成一个没有任何模型的提供方。
 * pi-ai 其余的协议出于同样的原因也不在此列。
 */
const LISTABLE_PROTOCOLS: ReadonlySet<string> = new Set([
  'anthropic-messages',
  'openai-completions',
  'openai-responses',
])

/** Anthropic 的模型列表端点所要求的稳定 API 版本。 */
const ANTHROPIC_VERSION = '2023-06-01'

/** Anthropic 公共端点所接受的最大模型列表页；发现只读取一页，且不跟随 `has_more`。 */
const ANTHROPIC_MODEL_LIMIT = 1000

/**
 * 大于这个尺寸的端点应答会被拒绝。该端点是用户输入的任意 URL，
 * 因此这个上限作用于实际读到的字节，而不是服务器所声称的长度——
 * 这与 `dsh-web-fetch` 对它自己那些由调用方提供的 URL 所使用的
 * 两阶段形状相同，唯一区别是一个被截断的模型列表无法被解析，
 * 因此超限时是拒绝而不是截断。
 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/** 由更丰富的模型目录应答所嵌套的容量字段。 */
interface ListingLimit {
  context?: unknown
  output?: unknown
}

/** OpenRouter 嵌套在每个条目之下的、按路由的容量。 */
interface ListingTopProvider {
  max_completion_tokens?: unknown
}

/** 一个受支持的 `GET /models` 应答中的一个条目。 */
interface ListingEntry {
  id?: unknown
  /** 常见的网关扩展；官方列表中没有。 */
  name?: unknown
  display_name?: unknown
  displayName?: unknown
  contextWindow?: unknown
  context_window?: unknown
  context_length?: unknown
  max_input_tokens?: unknown
  maxOutputTokens?: unknown
  max_tokens?: unknown
  max_output_tokens?: unknown
  maxTokens?: unknown
  limit?: ListingLimit | null
  top_provider?: ListingTopProvider | null
}

/** 一个列表条目中为正整数的字段，或当缺失/不可用时为 `undefined`。 */
function capacity(...candidates: readonly unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) return candidate
  }
  return undefined
}

/** 一个列表条目中为非空字符串的字段，或 `undefined`。 */
function label(...candidates: readonly unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

/**
 * 把端点基址与该协议的列表路径拼接起来。基址被当作一个前缀，
 * 而不是一个要据以解析的 URL，因此像 `https://gateway.example/openai/v1`
 * 这样的部署路径会保留它的各个段，而不是被 `URL` 解析丢掉。OpenAI 各协议
 * 在 `{baseURL}/models` 上列表。Anthropic 在 `{root}/v1/models` 上列表，
 * 其中那个根是去掉尾部斜杠、并去掉一个尾部 `/v1` 段之后的基址：
 * 网关文档会把同一个根写成这两种形式。只有这个列表 URL 会规范化那个段；
 * 模型请求收到的 `baseURL` 保持不变。
 */
function listingUrl(baseURL: string, api: string): string {
  const base = baseURL.replace(/\/+$/, '')
  if (api !== 'anthropic-messages') return `${base}/models`
  const root = base.endsWith('/v1') ? base.slice(0, -3) : base
  return `${root}/v1/models?limit=${String(ANTHROPIC_MODEL_LIMIT)}`
}

/**
 * 读取一个应答体，并拒绝一个超出上限的应答。先检查所声明的长度，
 * 因此一个诚实的服务器会在不传输任何东西的情况下被挡回；真正执行这个
 * 上界的是累计总量，因为一个少报（或流式输出）的服务器在事前告诉不了
 * 我们任何信息。
 */
async function readBounded(response: Response, url: string): Promise<string> {
  const oversized = (): LlmError =>
    new LlmError(`${url} answered with more than ${MAX_RESPONSE_BYTES} bytes`, 'DISCOVERY_FAILED')
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw oversized()
  }
  /* v8 ignore next -- fetch 在一个 2xx Response 上总是暴露 body 流；这个 null 守卫只是防御性的。 */
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) throw oversized()
      chunks.push(value)
    }
  } finally {
    /* v8 ignore next 4 -- 在一次已完成的或被放弃的读取之后 cancel() 会毫无 reject 地落定；这是不被观察的尽力清理。 */
    await reader.cancel().catch(() => {
      // 在一次已被抽干的读取之后、或在本函数已从一个超限的读取走开之后
      // 的取消，只是清理；无论哪种情况，应答都已经判定完毕。
    })
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

/**
 * 读取一个受支持的模型列表应答。当两种受支持的格式同时出现时，
 * 标准的 `data` 数组优先。一个更丰富的 `models` 映射把每个属性键当作
 * 面向端点的 id；它嵌套的 `id` 只是在键为空时的兜底，因为网关可能把
 * 一个规范的模型身份放在那里，而不是它们在请求上所接受的那个别名。
 * 只有对象值的映射条目才是模型；原始值属性会被忽略，因为它们可能是
 * 目录元数据而不是模型记录。
 *
 * 没有可用 id 的条目会被跳过，而不是让整个探查失败：一行格式错误的
 * 记录不应剥夺用户使用一个工作端点的其余目录。缺失的名称回退为被采纳的
 * id，因此 Web 表单收到的是一行完整的人类可读记录。
 */
function readListing(body: unknown): LlmDiscoveredModel[] {
  const listing = body as { data?: unknown; models?: unknown } | null
  const data = listing?.data
  let listed: { readonly key?: string; readonly raw: unknown }[]
  if (Array.isArray(data)) {
    const rows = data as readonly unknown[]
    listed = rows.map(raw => ({ raw }))
  } else {
    const models = listing?.models
    if (models === null || typeof models !== 'object' || Array.isArray(models)) {
      throw new LlmError(
        'the endpoint\'s model listing has neither a "data" array nor a "models" object; '
        + 'enter this provider\'s models by hand',
        'DISCOVERY_FAILED',
      )
    }
    listed = Object.entries(models as Record<string, unknown>)
      .filter(([, raw]) => raw !== null && typeof raw === 'object' && !Array.isArray(raw))
      .map(([key, raw]) => ({ key, raw }))
  }
  const models: LlmDiscoveredModel[] = []
  for (const { key, raw } of listed) {
    const entry = raw as ListingEntry | null
    const id = label(key, entry?.id)
    if (id === undefined) continue
    const name = label(entry?.name, entry?.display_name, entry?.displayName) ?? id
    const contextWindow = capacity(
      entry?.contextWindow,
      entry?.context_window,
      entry?.context_length,
      entry?.max_input_tokens,
      entry?.limit?.context,
    )
    const maxTokens = capacity(
      entry?.maxOutputTokens,
      entry?.max_output_tokens,
      entry?.maxTokens,
      entry?.max_tokens,
      entry?.limit?.output,
      entry?.top_provider?.max_completion_tokens,
    )
    models.push({
      id,
      name,
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxTokens === undefined ? {} : { maxTokens },
    })
  }
  return models
}

/**
 * 接受一个探查用密钥，或在请求头被构建之前就拒绝它。没有这一步，
 * 下面的 `fetch` 会抛出一个 ByteString `TypeError`，而本函数的 catch
 * 会把它报告为 `could not reach <url>` —— 把一个本地的、确定性的
 * 故障归咎于网络。
 * @param raw - 被键入表单或从存储中读出的密钥。
 * @returns 已裁剪、可用的密钥。
 */
function usableProbeKey(raw: string): string {
  const checked = normalizeApiKey(raw)
  if (checked.ok) return checked.value
  throw new LlmError(
    checked.reason === 'empty'
      ? 'this provider\'s API key is blank; enter it on the Models page, or clear it to probe unauthenticated'
      : 'this provider\'s API key contains characters no HTTP header can carry; paste the raw key only',
    INVALID_CREDENTIAL_CODE,
  )
}

/** 一份配置草稿刻意省略掉的、由宿主持有的 profile 输入。 */
export interface StoredModelDiscoveryProfile {
  /** 在被指名的路由上配置的、由部署提供的请求头。 */
  readonly headers: Readonly<Record<string, string>> | undefined
  /** 仅当该草稿没有携带任何凭据时，才解析被指名路由的凭据。 */
  readonly resolveApiKey: () => Promise<string | undefined>
}

/**
 * 探查一个草稿提供方端点，看它宣传了哪些模型。
 * @param request - 要使用的端点、协议与一次性凭据。
 * @param storedProfile - 由宿主持有的请求头，以及对被指名路由的惰性凭据解析。
 *   只有在会到达网络的那条路径上才读取它；且仅当该草稿没有携带凭据时
 *   才解析凭据。
 * @returns 按端点顺序排列的、被宣传的模型。
 * @throws 当该协议没有可读的列表、端点拒绝或使该请求失败，
 *   或应答不是一个模型列表时，抛出 LlmError。
 */
export async function discoverModels(
  request: LlmModelDiscoveryOperation,
  storedProfile?: () => StoredModelDiscoveryProfile | undefined,
): Promise<readonly LlmDiscoveredModel[]> {
  // 一条目录路由已经有它的答案，而且是更好的答案：那些已安装的条目
  // 携带了任何列表端点都不会报告的上下文窗口与输出上限。
  if (request.provider !== undefined) {
    const installed = catalogModels(request.provider)
    if (installed.size > 0) {
      return [...installed.values()].map(model => ({
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        inputModalities: [...model.input],
      }))
    }
  }
  if (request.baseURL === undefined || request.baseURL.length === 0) {
    throw new LlmError(
      `pi-ai ships no catalog for provider "${request.provider ?? ''}", so its models can only come from its`
      + " endpoint; set a baseURL, or enter this provider's models by hand",
      'DISCOVERY_FAILED',
    )
  }
  // 一份尚未选择协议的草稿会按 OpenAI Chat Completions 去询问：
  // 它是一个网关压倒性可能所说的形状，而另一种做法——在字段被填好之前
  // 拒绝——会把这个动作从它为之存在的那个场景上撤走。代价是当该端点
  // 说的是别的协议时会有一条误导性的消息（一个 Anthropic 网关会应答 401，
  // 读起来像一个凭据问题），而手工录入仍然是出路。
  const api = request.api ?? 'openai-completions'
  if (!LISTABLE_PROTOCOLS.has(api)) {
    throw new LlmError(
      `pi-ai protocol "${api}" has no model listing this build can read; enter this provider's models by hand`,
      'DISCOVERY_UNSUPPORTED',
    )
  }
  const url = listingUrl(request.baseURL, api)
  // 一个被键入表单的密钥优先：它可能要替换掉那个正在失败的已存储密钥。
  // 已存储的 profile 是在目录与协议检查之后才被询问的，而它的凭据解析
  // 保持惰性，因此一个键入的密钥不会因为一个被它取代的已存储凭据而失败。
  // 当两者都不存在时，一条路由仍然可以通过某个由部署持有的
  // Authorization 请求头来认证。
  const stored = storedProfile?.()
  const supplied = request.apiKey ?? await stored?.resolveApiKey()
  const apiKey = supplied === undefined ? undefined : usableProbeKey(supplied)
  let response: Response
  try {
    const headers = new Headers(stored?.headers === undefined ? undefined : Object.entries(stored.headers))
    headers.set('accept', 'application/json')
    if (api === 'anthropic-messages') {
      headers.set('anthropic-version', ANTHROPIC_VERSION)
      if (apiKey !== undefined) headers.set('x-api-key', apiKey)
    } else if (apiKey !== undefined) {
      headers.set('authorization', `Bearer ${apiKey}`)
    }
    for (const [name, value] of Object.entries(attributionHeaders())) headers.set(name, value)
    response = await fetch(url, {
      method: 'GET',
      headers,
      ...request.signal === undefined ? {} : { signal: request.signal },
    })
  } catch (error: unknown) {
    if (request.signal?.aborted) {
      throw new LlmError('model discovery aborted by caller', 'ABORTED', { cause: error })
    }
    throw new LlmError(`could not reach ${url}`, 'DISCOVERY_FAILED', { cause: error })
  }
  if (!response.ok) {
    throw new LlmError(
      `${url} answered ${response.status}${response.status === 401 || response.status === 403 ? '; check the API key' : ''}`,
      'DISCOVERY_FAILED',
    )
  }
  let text: string
  try {
    text = await readBounded(response, url)
  } catch (error: unknown) {
    // 读取响应体期间的取消会以 abort reason 来 reject，它可能是任意值；
    // 调用方得到的是与请求发出之前的取消相同的、带错误码的失败。
    if (request.signal?.aborted) {
      throw new LlmError('model discovery aborted by caller', 'ABORTED', { cause: error })
    }
    throw error
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch (error: unknown) {
    throw new LlmError(`${url} did not answer with JSON`, 'DISCOVERY_FAILED', { cause: error })
  }
  return readListing(body)
}
