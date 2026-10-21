/** DeepSeek 协议适配器的共享宿主装配。 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-fs'
import { resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import { getOrCreateAnonymousUserId, type AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import { DeepSeekAdapter } from './adapter.ts'
import type { DeepSeekAdapterOptions, DeepSeekConnectionOptions } from './types.ts'

/**
 * 注册一个带有请求级传输服务与实时重试策略的提供方。
 * @param ctx - 已注入 LLM 注册表的提供方插件生命周期。
 * @param provider - 本插件持有的精确路由。
 * @param dependencies - 由提供方持有的发现、凭据与配置回调。
 */
export function registerDeepSeekProvider<C extends DeepSeekConnectionOptions>(
  ctx: Context, provider: string, dependencies: Pick<DeepSeekAdapterOptions<C>,
  'options' | 'resolveAuth' | 'providerName' | 'discoverModels' | 'connect' | 'admit'>): void {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  let userId: AnonymousUserId | undefined
  // 这些状况会在某条路由的每次请求上重复出现；只记录各自首次出现的情况。
  const degradedReplays = new Set<string>()
  const omittedRoutes = new Set<string>()
  const unacceptedRoutes = new Set<string>()
  const adapter = new DeepSeekAdapter({
    ...dependencies,
    resolveUserId: () => userId ??= getOrCreateAnonymousUserId(),
    onReplayDegrade: ({ provider, model, reason }) => {
      const key = `${provider}/${model}\u0000${reason}`
      if (degradedReplays.has(key)) return
      degradedReplays.add(key)
      ctx.logger.warn(`llm-deepseek: unusable Messages replay state on assistant history for route "${provider}/${model}"; sending provider-neutral content (${reason})`)
    },
    onExtensionsOmitted: ({ provider, model, fields, error }) => {
      const route = `${provider}/${model}`
      if (omittedRoutes.has(route)) return
      omittedRoutes.add(route)
      ctx.logger.warn(`llm-deepseek: sending route "${route}" without request extension fields ${fields.join(', ')} because they failed to serialize: %o`, error)
    },
    onExtensionsUnaccepted: ({ provider, model, error }) => {
      const route = `${provider}/${model}`
      if (unacceptedRoutes.has(route)) return
      unacceptedRoutes.add(route)
      ctx.logger.warn(`llm-deepseek: route "${route}" request extension acceptance failed; contributors resend on a later request: %o`, error)
    },
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments, hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath), ref,
    ),
    prepareExtensions: request => ctx.get('deepseekLlmApiExtensions')?.prepare(request)
      ?? Promise.resolve({ fields: {}, accept: () => Promise.resolve() }),
  })
  const registration = ctx.llm.registerAdapter([provider], adapter)
  let registeredPolicy = dependencies.options().retryPolicy
  ctx.on('loader/volatile-update', () => {
    let policy: typeof registeredPolicy
    try { policy = dependencies.options().retryPolicy }
    catch (error) { ctx.logger.warn(error); return }
    if (deepEqualJson(policy, registeredPolicy)) return
    registration.replace([provider])
    registeredPolicy = policy
  })
}
