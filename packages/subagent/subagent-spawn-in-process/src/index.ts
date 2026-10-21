/**
 * 进程内 SPAWN 子代理后端：在 `ctx.subagents` 上注册一个
 * {@link SubagentProvider}，在同一个 cordis 上下文上把每个子代理作为一个
 * 全新的子 {@link Agent} 运行（自己的 session、自己的 system prompt、零父
 * 上下文）。这是最便宜的传输，复用 agent 工厂的静默拆解。
 * @module @deepseek-ai/dsh-subagent-spawn-in-process
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  ContinuableCreateSpec,
  SubagentCapabilities,
  SubagentProvider,
} from '@deepseek-ai/dsh-subagent'

export const name = 'subagent-spawn-in-process'
// 有意不注入 `tools`：子工厂在 setup 期间已提供它，
// 在此处添加会不必要地改变本提供方的 apply 时机。
export const inject = ['subagents']

/** 配置：注册该提供方所用的注册表名称。 */
export interface Config {
  /** `ctx.subagents` 上的提供方名称（默认 `spawn`）。 */
  providerName: string
}

export const Config: z<Config> = z.object({
  providerName: z.string().default('spawn'),
})

/**
 * spawn 提供方。支持每一种启动期能力：`depthLimit`（它构造子代理，因此能
 * 强制递归上限）、`outputSchema`（作用域化的结构化运行时）、`agentOptions`
 * （合并覆盖到父路由之上）。所选预设拥有 persona 与工具组合。
 */
class SpawnInProcessProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = {
    agentOptions: true,
    agentPreset: true,
    outputSchema: true,
    depthLimit: true,
  }
  // 上下文契约：一个 spawn 出的子代理全新启动 —— 它永不会看到父对话。
  readonly inheritsParentContext = false

  constructor(readonly name: string) {}

  prepareContinuable(): Promise<ContinuableCreateSpec> {
    // 一个 spawn 出的子代理全新启动，因此它不贡献任何播种；
    // 续跑管理器拥有对它的每一个后续操作。
    return Promise.resolve({})
  }
}

export function apply(ctx: Context, config: Config): void {
  ctx.subagents.registerProvider(new SpawnInProcessProvider(config.providerName))
}
