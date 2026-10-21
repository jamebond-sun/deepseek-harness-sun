/** Cordis 第一方巡检提供方的 Host 侧注册。 */
import type { Context } from '@deepseek-ai/cordis'
import { hostInspectProviders } from './providers.ts'

export const name = 'cordis-inspect-providers'
/** 所需服务：Host 巡检注册表，以及 `Tool` 提供方读取的 Tool 注册表。 */
export const inject = ['cordisInspect', 'tools']

/**
 * 每个进程只注册一次 Host 巡检提供方。注册表按 id 索引提供方并拒绝重复者，
 * 因此这一行属于与 `cordis-host-runner` 并列的 host 组合；每个按会话的 `tool-cordis`
 * 行都通过其 tools 读取这一共享集合。
 * @param ctx Host 组合上下文。
 */
export function apply(ctx: Context): void {
  for (const provider of hostInspectProviders(ctx)) {
    ctx.effect(() => ctx.cordisInspect.register(provider), `cordis-inspect-providers: ${provider.manifest.id}`)
  }
}
