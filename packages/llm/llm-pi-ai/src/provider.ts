/**
 * 构造某条已配置路由注册进适配器 `Models` 集合的那个 pi-ai `Provider`。
 *
 * 两种构造，一次判定：一条已安装目录自带的路由，当它的 profile 没有覆盖
 * 那个线协议时，会**复用那个目录提供方**，只是把它的各个模型替换掉——
 * 该目录提供方持有本包无法重建的 API 实现（Bedrock 通过一个单独的入口点
 * 加载它的 Smithy 模块），因此从零件重建它会静默地收窄哪些提供方可用。
 * 其他每条路由——一个 pi-ai 从未听说过的，或一条被指向了不同协议的目录
 * 路由——都由 `createProvider` 基于下面的协议表构造出来。
 *
 * 凭据从不到达本模块的存储：harness 在该请求进入 pi-ai 之前通过
 * `ctx.credentials` 解析某条路由的密钥，并把它作为一个流选项交出去，
 * 而 `Models` 把它作为那个凭据键呈现给 `resolve()`。
 *
 * @module dsh-llm-pi-ai/provider
 */

import type { Api, ApiKeyAuth, Model, Provider, ProviderStreams } from '@earendil-works/pi-ai'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { catalogProvider, PiAiCatalogError } from './catalog.ts'
import { createProvider } from './models.ts'

/**
 * 一条已配置路由可以指名的各个线协议，映射到 pi-ai 那些被惰性加载的实现。
 * 每个条目都是 pi-ai 那个匹配的提供方工厂所使用的工厂，
 * 因此一条手工声明的路由到达的正是某条目录路由会到达的那个实现。
 *
 * 这张表刻意是窄的：这里是一个手工声明的路由真正会读取的那些协议，
 * 每一个都能用一个键、一个端点与若干请求头完全描述。Bedrock 用 AWS 凭据
 * 与一个 region 做 SigV4 签名，Vertex 需要一个项目、一个 location 与
 * 应用默认凭据，Azure 需要提供方环境外加一个 api-version，而 Codex 通过
 * OAuth 认证——这些没有一样是这种配置形状所能表达的，因此提供它们等于
 * 交回一个无法认证的提供方。其余各项之所以缺席，是因为缺少一个消费者，
 * 而不是因为有某个阻塞：一旦某个部署需要它，这里就只是多一行。
 * 各条目录路由仍然通过它们自己的提供方到达每一个协议；
 * 只有一次显式的覆盖会被拒绝。
 */
const PROTOCOLS: Readonly<Record<string, () => ProviderStreams>> = {
  'openai-completions': openAICompletionsApi,
  'openai-responses': openAIResponsesApi,
  'anthropic-messages': anthropicMessagesApi,
}

/**
 * 一条已配置路由可以指名的每一个线协议，被最常到达的排在最前。
 * 这个顺序就是该表的顺序，因此是稳定的；一个提供选择的配置界面会把
 * 第一个作为它的默认值，而正因如此，一个手工声明的网关最常说的、
 * 并且端点探查所能读取的那个协议排在首位。
 * @returns 各个受支持的协议标识。
 */
export function supportedProtocols(): readonly string[] {
  return Object.keys(PROTOCOLS)
}

/**
 * 为一条由 harness 自己认证的路由所提供的 api-key 认证。`Models` 会在该
 * 适配器已经解析完该路由的凭据之后调用它，因此这里一个缺失的密钥并不是
 * 本层的失败：一个已指名却无法解析的引用已经让该请求以
 * `MISSING_CREDENTIAL` 失败，而一条完全没有指名凭据的路由是刻意不认证的。
 * 把它报告为已配置，是把这个判定交给那个协议——而这正是该要求真正所在的
 * 地方：例如 pi-ai 那个 OpenAI 兼容的实现，仍然坚持要一个密钥或一个它自己的
 * `Authorization` 请求头。
 * @param name - 被用作该解析状态标签的展示名称。
 * @returns 一条由 harness 认证的路由所使用的 api-key 认证。
 */
function harnessApiKeyAuth(name: string): ApiKeyAuth {
  return {
    name,
    resolve: ({ credential }) => Promise.resolve({
      auth: credential?.key === undefined ? {} : { apiKey: credential.key },
      source: name,
    }),
  }
}

/** 提供方构造所读取的那些已解析路由事实。 */
export interface ProviderSpec {
  /** 提供方路由键；同时也是那个 `Models` 集合键，以及每个模型的 `provider`。 */
  provider: string
  /** 供选择器与状态标签使用的展示名称。 */
  displayName: string
  /** 线协议覆盖；缺失意味着每个模型保留它的目录协议。 */
  api?: string
  /** 已应用到 {@link models} 之上的端点覆盖；保留下来供提供方级别的展示使用。 */
  baseURL?: string
  /** 本路由已物化的各个模型，按配置顺序排列。 */
  models: readonly Model<Api>[]
  /**
   * 该 profile 是否指名了一个凭据，而它只能通过 `apiKeyEnv` 来做到：
   * 配置携带那个引用，绝不携带机密。只有这一点决定 {@link routeAuth}
   * 是否把 harness 自己的 api-key 方式加到一个未提供任何方式的目录
   * 提供方上；而那个密钥本身仍然按每次请求到达，绝不在构造时到达。
   */
  namesCredential: boolean
}

/**
 * 某条路由解析其凭据所经过的那个认证。
 *
 * 一条目录路由保留已安装提供方自己的认证，而正是这一点为一个未指名任何
 * 凭据的 profile 保留了提供方原生的环境发现。即使该 profile 重定向了那个
 * 协议，这一点仍然成立：某个提供方读取哪个环境是该提供方的属性，
 * 而不是它的各个模型所说线格式的属性。
 *
 * 那唯一的补充是为了一个完全没有提供任何 api-key 方式的目录提供方。
 * pi-ai 只在该提供方声明了一个的情况下才会解析某次请求的 `apiKey`
 * 覆盖（`resolveProviderAuth` 在认可该覆盖之前会检查
 * `provider.auth.apiKey`），因此一个纯 OAuth 的提供方——已安装目录自带的
 * 就是 `openai-codex`——会在任何请求发出之前以 `Provider is not configured`
 * 拒绝某个 profile 的显式密钥。把 harness 的方式加在该提供方自己的方式
 * 旁边，就能恢复那条路由。一个无密钥的 profile 什么都不加，
 * 并且仍然报告那个诚实的拒绝，因为本适配器通过它自己的接缝解析凭据，
 * 并且不持有任何可以回退的 OAuth 存储。
 * @param spec - 已解析的路由事实。
 * @param catalog - 当 pi-ai 自带一个时的那个已安装目录提供方。
 * @returns 构造本路由那个提供方所使用的认证。
 */
function routeAuth(spec: ProviderSpec, catalog: Provider | undefined): Provider['auth'] {
  if (catalog === undefined) return { apiKey: harnessApiKeyAuth(spec.displayName) }
  if (catalog.auth.apiKey !== undefined || !spec.namesCredential) return catalog.auth
  return { ...catalog.auth, apiKey: harnessApiKeyAuth(spec.displayName) }
}

/**
 * 用本路由的各个模型与身份复用一个已安装的目录提供方。模型分发继续由该
 * 目录提供方负责，因此它的各个 API 实现、兼容性怪癖与环境凭据发现
 * 都被原样保留。由目录持有的动态刷新被丢弃：本路由的目录就是那份设置
 * 文档，而一次后台刷新会与它相矛盾。
 */
function reuseCatalogProvider(base: Provider, spec: ProviderSpec): Provider {
  // 提供方级别的 `baseUrl` 只是展示元数据：pi-ai 会把每次请求都经由
  // `Model.baseUrl` 路由，而模型解析已经覆盖过它了。
  const baseUrl = spec.baseURL ?? base.baseUrl
  return {
    id: spec.provider,
    name: spec.displayName,
    ...baseUrl === undefined ? {} : { baseUrl },
    auth: routeAuth(spec, base),
    getModels: () => spec.models,
    // 委派而不是复制：那个目录提供方仍然是接收者，
    // 于是一个在自身之上持有状态的实现继续工作。
    stream: (model, context, options) => base.stream(model, context, options),
    streamSimple: (model, context, options) => base.streamSimple(model, context, options),
  }
}

/**
 * 为一条已解析的路由构造那个 pi-ai 提供方。
 * @param spec - 已解析的路由事实。
 * @returns 要注册进适配器 `Models` 集合的那个提供方。
 * @throws Error 当该路由指名了一个本构建无法服务的线协议时。
 */
export function buildProvider(spec: ProviderSpec): Provider {
  const catalog = catalogProvider(spec.provider)
  // 一条保留其目录协议的目录路由会复用那个目录提供方；
  // 一个显式的协议意味着该部署正在把这条路由重新指向另一种线格式，
  // 而只有那张协议表能够服务它。
  if (catalog !== undefined && spec.api === undefined) return reuseCatalogProvider(catalog, spec)

  // 这条路径上的每个模型都携带本路由的协议：对于一条目录无法给出默认值的
  // 路由，模型解析要求有一个；而一个显式的协议会替换掉每个目录模型自己的。
  // 因此该路由只有一个 API。
  const factory = spec.api === undefined ? undefined : PROTOCOLS[spec.api]
  if (factory === undefined) {
    throw new PiAiCatalogError(
      `llm-pi-ai: provider "${spec.provider}" names api "${spec.api}", which this build cannot serve;`
      + ` supported protocols are ${supportedProtocols().join(', ')}`,
    )
  }
  return createProvider({
    id: spec.provider,
    name: spec.displayName,
    ...spec.baseURL === undefined ? {} : { baseUrl: spec.baseURL },
    auth: routeAuth(spec, catalog),
    models: spec.models,
    api: factory(),
  })
}
