/**
 * 进程内 FORK 子代理后端：在 `ctx.subagents` 上注册一个
 * {@link SubagentProvider}，把每个子代理作为一个子 {@link Agent} 运行，并用
 * 父 session 日志的一段前缀为其播种 —— 因此子代理继承父代理的对话上下文，
 * 而非全新启动。播种在最后一个 `turn/end` 处结束：当前工具调用轮次是不
 * 平衡的，无法作为有效的子 session 重放。
 * @module @deepseek-ai/dsh-subagent-fork-in-process
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  ContinuableCreateRequest,
  ContinuableCreateSpec,
  SubagentCapabilities,
  SubagentProvider,
} from '@deepseek-ai/dsh-subagent'

export const name = 'subagent-fork-in-process'
// 有意不注入 `tools` —— 与 subagent-spawn-in-process 相同的理由：
// 按运行的结构化运行时以 `tools` 自身为其捕获工具注册的门槛，
// 因此本后端的 apply 时机（以及委托工具在模型可见工具列表中的位置）
// 不因结构化输出而改变。
export const inject = ['subagents']

/** 配置：注册该提供方所用的注册表名称。 */
export interface Config {
  /** `ctx.subagents` 上的提供方名称（默认 `fork`）。 */
  providerName: string
}

export const Config: z<Config> = z.object({
  providerName: z.string().default('fork'),
})

/**
 * `parent` 日志中平衡的已完成轮次前缀：直到并包括最后一个 `turn/end` 的
 * 每个事件。正在进行中的轮次被排除；在任何已完成轮次之前，子代理全新启动。
 * 由于实时序号等于数组下标，结果仍是自序号零开始的有效播种。
 * @param parent - 要切片其 session 日志的 agent。
 * @returns 自 seq 0 连续的播种事件；当没有轮次完成时为空。
 */
function completedTurnPrefix(parent: Agent): SessionEvent[] {
  // oxlint-disable-next-line typescript/no-deprecated -- 沿用既有 Session 历史读取；迁移暂缓。
  const events = parent.session.snapshotEvents()
  const lastEnd = events.findLast(e => e.type === 'turn/end')
  if (lastEnd === undefined) return []
  // seq === 数组下标（append 契约），因此切片到它并包含它。
  return events.slice(0, lastEnd.seq + 1)
}

/**
 * fork 提供方。支持 `depthLimit` 与 `outputSchema`（经由共享的进程内结构化
 * 运行时）、`agentOptions`（合并覆盖到父路由之上）。子代理继承其父代理的
 * 预设组合。
 */
class ForkInProcessProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = {
    agentOptions: true,
    agentPreset: false,
    outputSchema: true,
    depthLimit: true,
  }
  // 上下文契约：一个 fork 出的子代理确实被父代理的已完成轮次前缀播种。
  readonly inheritsParentContext = true

  constructor(readonly name: string) {}

  prepareContinuable(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec> {
    // fork 前缀在创建时只捕获一次：它成为子代理自身持久化 transcript 的
    // 一部分，因此之后的冷恢复重放该前缀，而不是重新 fork 父代理更新的历史。
    const seed = completedTurnPrefix(request.parent)
    return Promise.resolve(seed.length > 0 ? { seed } : {})
  }
}

export function apply(ctx: Context, config: Config): void {
  ctx.subagents.registerProvider(new ForkInProcessProvider(config.providerName))
}
