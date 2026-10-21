/**
 * 由 pi-ai 支撑的通用 LLM 适配器插件。一个插件实例持有一份提供方路由字典；
 * 一条指名了某个已安装 pi-ai 提供方的路由，会继承该提供方的端点、协议与
 * 模型目录作为默认值，而一条 pi-ai 并未自带的路由则是被直接声明出来的。
 * 各个 profile 事实在每次请求时通过可选的 `llm-pi-ai` 用户设置小节与
 * 可选的凭据接缝解析，因此一次变更的密钥、端点、模型或开关无需重启
 * 就能到达下一次请求；一次变更的*路由集合*（或某条路由随注册一起捕获的
 * 重试策略）会让同一个适配器实例就地重新注册。
 *
 * ```yaml
 * - id: llm
 *   name: '@deepseek-ai/dsh-llm-pi-ai'
 *   config:
 *     providers:
 *       # 目录路由：除凭据之外的一切都来自 pi-ai。
 *       openai:
 *         apiKeyEnv: OPENAI_API_KEY
 *         retryPolicy:
 *           mode: normal
 *           maxRetries: 2
 *       # 目录路由，但目录被收窄，且一个容量被改正。
 *       anthropic:
 *         apiKeyEnv: ANTHROPIC_API_KEY
 *         models:
 *           - id: claude-sonnet-4-5
 *             contextWindow: 200000
 *       # 手工声明的路由：pi-ai 在这个键之下不自带任何东西。
 *       acme-gateway:
 *         displayName: Acme Gateway
 *         apiKeyEnv: ACME_GATEWAY_API_KEY
 *         api: openai-completions
 *         baseURL: https://gateway.acme.example/v1
 *         # 一个 pi-ai 无法识别的 URL 所使用的推理方言。
 *         compat:
 *           thinkingFormat: deepseek
 *         models:
 *           - id: acme-large
 *             name: Acme Large
 *             contextWindow: 65536
 *             maxTokens: 4096
 *           - id: acme-think
 *             name: Acme Think
 *             contextWindow: 262144
 *             maxTokens: 32768
 *             # key = 可选强度，value = 线路拼写；只有 off 可以让该值为空
 *             #（受支持，但不发送任何东西）。
 *             reasoningEfforts:
 *               off:
 *               high: high
 *               max: ultra
 * ```
 *
 * @module @deepseek-ai/dsh-llm-pi-ai
 */
import type {} from '@deepseek-ai/dsh-settings'

import type {} from '@deepseek-ai/cordis-plugin-loader'

import type { Context } from '@deepseek-ai/cordis'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { assertUsableApiKey, LlmError, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type { AdapterRegistrationHandle, DirectoryRegistrationHandle, LlmConfigurableProvider } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-fs'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import { PiAiAdapter } from './adapter.ts'
import { authContextFrom, credentialStoreFrom } from './auth.ts'
import { catalogProvider, catalogProviderIds } from './catalog.ts'
import { assertServiceable, Config, resolveProfiles } from './config.ts'
import type { ResolvedPiAiProviderProfile } from './config.ts'
import { discoverModels } from './discovery.ts'
import type { StoredModelDiscoveryProfile } from './discovery.ts'
import { registerPiAiFlows } from './login.ts'
import { providerDefaultsOf } from './provider-data.ts'

export { PiAiAdapter } from './adapter.ts'
export type { PiAiAdapterOptions } from './adapter.ts'
export { Config } from './config.ts'
export type {
  Options,
  PiAiCompatProfile,
  PiAiModality,
  PiAiModelOverride,
  PiAiModelProfile,
  PiAiProviderProfile,
  PiAiReasoningEfforts,
  PiAiThinkingFormat,
  ResolvedPiAiProviderProfile,
} from './config.ts'
export { recordKeyFor } from './auth.ts'
export { supportedProtocols } from './provider.ts'

export const name = 'llm-pi-ai'
export const inject = ['llm']

const NS = 'llm-pi-ai'

/**
 * 注册表按路由捕获这些事实；这里发生变化就必须重新注册。
 * 按提供方排序，因此一份仅仅重新排列了键的设置文档不会被误认为一次路由变更。
 */
function registrationFacts(profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>): unknown {
  return [...profiles.entries()]
    // `displayName` 被一并带上，是因为注册表会通过 `providerInfo()`
    // 把它交给每一个选择器：一次没有重新注册的重命名会让旧标签继续显示，
    // 直到某个无关的事实碰巧发生变化。
    .map(([provider, profile]) => ({
      provider,
      displayName: profile.displayName,
      retryPolicy: profile.retryPolicy,
    }))
    .sort((left, right) => left.provider.localeCompare(right.provider))
}

/**
 * 可配置提供方目录：每条已安装的目录路由，外加当前各个 profile 所声明的
 * 每条路由。一条手工声明的路由没有目录条目，因此没有这个并集它就没有
 * 设置地址，配置界面既无法显示也无法编辑它。一条目录路由还携带它的
 * 目录端点与原生认证，而设置编辑器会在该 profile 未设置端点或凭据引用时
 * 展示它们。
 * @param profiles - 当前已解析的各个提供方 profile。
 * @returns 按目录顺序排列的各个目录条目，已声明的路由在最后。
 */
function directoryEntries(
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>,
  settingsNs: string,
): LlmConfigurableProvider[] {
  const entries = new Map<string, LlmConfigurableProvider>()
  const addEntry = (provider: string, displayName: string, error?: string): void => {
    const installed = catalogProvider(provider)
    entries.set(provider, {
      provider,
      displayName,
      settingsNs,
      settingsPath: ['providers', provider],
      // 属于已安装目录的成员身份，而不是属于设置文档的：
      // 收窄一个自带提供方的模型同样会存储一份 profile，
      // 而那条路由仍然是 pi-ai 所知道的一条。
      declared: installed === undefined,
      ...installed === undefined ? {} : providerDefaultsOf(installed),
      ...error === undefined ? {} : { error },
    })
  }
  for (const provider of catalogProviderIds()) addEntry(provider, provider)
  for (const [provider, profile] of profiles) addEntry(provider, profile.displayName, profile.catalogError)
  return [...entries.values()]
}

/** 为所有已配置的提供方路由注册一个通用 pi-ai 适配器。 */
export function apply(ctx: Context, config: Config): void {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  const settingsNs = ctx.fiber.entry?.options.id ?? NS
  let lastRaw: ReturnType<Config['providers']['get']> | undefined
  let memoized: ReadonlyMap<string, ResolvedPiAiProviderProfile> | undefined
  /**
   * 当前配置的各个已解析 profile，按原始快照的身份记忆化——
   * 而这也正是让适配器自己的快照在那些未观察到变化的操作之间保持稳定的原因。
   *
   * 目录诊断信息留在快照中、与可服务的模型并列，因此在一份已安装的目录
   * 发生变化之后，已存储的配置仍然可见。标量配置错误仍然会让解析 reject。
   */
  const profiles = (): ReadonlyMap<string, ResolvedPiAiProviderProfile> => {
    const raw = config.providers.get()
    if (raw === lastRaw && memoized !== undefined) return memoized
    const next = resolveProfiles(structuredClone(raw) as import('./config.ts').Options['providers'], 'deferred')
    lastRaw = raw
    memoized = next
    return next
  }
  profiles()
  ctx.on('internal/config', function (this: import('@deepseek-ai/cordis').Fiber, _raw, next) {
    const raw: unknown = next()
    if (this !== ctx.fiber) return raw
    const candidate = Config(raw as import('./config.ts').Options)
    assertServiceable(
      { providers: structuredClone(candidate.providers.get()) } as import('./config.ts').Options,
      { providers: structuredClone(config.providers.get()) } as import('./config.ts').Options,
    )
    return raw
  })

  const resolveApiKey = async (
    provider: string,
    profile: ResolvedPiAiProviderProfile,
  ): Promise<string | undefined> => {
    const ref = profile.apiKeyEnv
    // 只有完全没有指名任何凭据的 profile 才会委派给 pi-ai 的提供方原生发现。
    // 一旦指名了一个，未命中就必须响亮地失败：把 `undefined` 交给 pi-ai
    // 会让它捡起一个无关的环境密钥（OPENAI_API_KEY 之类），
    // 从而为一个本打算以不同方式认证的请求向另一个租户计费。
    if (ref === undefined) return undefined
    const credentials = ctx.get('credentials')
    const hit = credentials !== undefined
      ? (await credentials.resolve(ref))?.value
      // 没有该接缝时，环境就是整个凭据平面。
      : launchEnvironmentOf(ctx).get(ref)?.value
    if (hit !== undefined && hit.length > 0) return assertUsableApiKey(hit, 'llm-pi-ai', ref)
    throw new LlmError(
      `llm-pi-ai: no credential for provider route "${provider}"; its profile resolves ${ref}, which is not`
      + ` set — store ${ref} through the credentials service (the web Models page writes it) or export it,`
      + ' and remove apiKeyEnv only if this provider should authenticate from pi-ai\'s own environment discovery',
      'MISSING_CREDENTIAL',
    )
  }

  // 整个插件实例共用一个存储与一个环境上下文：两者都按每次调用通过 `ctx`
  // 读取，因此它们在一次配置变更所引起的集合重建之间保持正确，
  // 而一次登录也能在其中存活下来。
  const auth = { credentials: credentialStoreFrom(ctx), authContext: authContextFrom(ctx) }
  const adapter = new PiAiAdapter({
    profiles,
    resolveApiKey,
    auth,
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments,
      hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath),
      ref,
    ),
    onReplayDegrade: ({ provider, model, reason }) => {
      ctx.logger.warn(
        `llm-pi-ai: unusable replay state on assistant history for route "${provider}/${model}";`
        + ` sending that message as provider-neutral content (${reason})`,
      )
    },
  })
  // 独立于路由集合：登录正是让一条路由值得被添加的原因，
  // 因此这些流程在任何 profile 指名它们的提供方之前就已经被提供。
  // 它被限定在授权接缝之内，而不是被直接注入，因为一个没有它的组合
  // （headless、ACP）根本就没有可以从中登录的界面，
  // 而本插件所做的其他一切仍然照常工作。
  ctx.inject(['authorization'], (authorized) => { registerPiAiFlows(authorized, auth) })
  // 完整的已安装目录从插件挂载的那一刻起就是可配置的——无论是否处于休眠——
  // 因此配置界面可以在任何路由存在之前就提供每一个 pi-ai 提供方。
  // 手工声明的路由随各个 profile 出现而加入它，并随它们一起离开。
  let directory: DirectoryRegistrationHandle | undefined
  let directoryFacts: unknown
  const ensureDirectory = (): void => {
    const entries = directoryEntries(profiles(), settingsNs)
    if (deepEqualJson(entries, directoryFacts)) return
    // 原子替换，绝不是先释放再注册：否则一条已被另一个适配器家族声明的
    // 路由（一个键为 `deepseek-official` 的 profile）会让本插件的整个目录
    // 被撤下，而 Models 页面变空。候选集合会先被校验，因此一次冲突会让
    // 先前的条目继续服务，而只付出一条诊断信息。
    if (directory === undefined) {
      directory = ctx.llm.registerConfigurableProviders(entries)
    } else {
      directory.replace(entries)
    }
    directoryFacts = entries
  }
  ensureDirectory()
  /** 为发现某条已配置路由所提供的、由宿主持有的请求输入。 */
  const storedDiscoveryProfile = (
    provider: string | undefined,
  ): StoredModelDiscoveryProfile | undefined => {
    if (provider === undefined) return undefined
    const profile = profiles().get(provider)
    if (profile === undefined) return undefined
    return {
      headers: profile.headers,
      resolveApiKey: () => resolveApiKey(provider, profile),
    }
  }
  // 探查一个端点是一个配置时刻的、针对一份草稿的动作，因此它是为整个
  // 命名空间而非按路由提供的：某个界面正在添加的那个提供方还不存在。
  // 该草稿就是除已存储凭据与由部署持有的请求头之外的整个请求：
  // 那个受管的 UI 两者都不接受，因此一条已配置的路由会在宿主机内部
  // 提供这两者，而不是去扩大那个发现请求。
  ctx.llm.registerModelDiscovery(settingsNs, (request, signal) => discoverModels(
    { ...request, ...signal === undefined ? {} : { signal } },
    () => storedDiscoveryProfile(request.provider),
  ))
  // 各个路由 effect 通过那个稳定的 `ctx` 引用绑定到本 apply fiber，
  // 即使某次交换运行在下面那个带作用域的设置回调内部。一次空挂载
  // （零条路由）就是休眠姿态：在某个设置小节提供各个 profile 之前
  // 不会注册任何东西，而当它清空时各条路由随之消失。
  let registration: AdapterRegistrationHandle | undefined
  let registeredFacts: unknown
  const ensureRegistrationFacts = (): void => {
    const facts = registrationFacts(profiles())
    if (deepEqualJson(facts, registeredFacts)) return
    // 注册表在注册时捕获路由集合与每条路由的重试策略，因此其中任一项
    // 发生变化都必须重新注册。这次交换是原子的（同一个适配器实例，
    // 且在任何东西移动之前就已校验）：一条冲突的路由会让先前的路由
    // 继续服务请求，而 `registeredFacts` 只在注册表真正持有新集合之后
    // 才前进——因此回到一份可工作的配置总会重新应用。
    const routes = [...profiles().keys()]
    if (registration === undefined) {
      // 休眠的空挂载：在某个小节提供各个 profile 之前不会注册任何东西，
      // 而一个空的小节会让它保持这样。
      if (routes.length === 0) {
        registeredFacts = facts
        return
      }
      registration = ctx.llm.registerAdapter(routes, adapter)
    } else {
      registration.replace(routes)
    }
    registeredFacts = facts
  }
  ensureRegistrationFacts()

  ctx.on('loader/volatile-update', () => {
    try { ensureRegistrationFacts(); ensureDirectory() }
    catch (error) {
      ctx.logger.error('llm-pi-ai: configuration conflicts with an existing provider route')
      ctx.logger.error(error)
    }
  })
}
