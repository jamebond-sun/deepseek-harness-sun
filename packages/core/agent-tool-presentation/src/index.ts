/**
 * Agent 平面展示选择器：agent preset 携带的一行配置，用于声明
 * 模型看到的工具形式。
 *
 * 工具注册表本身留在宿主平面——agent 循环的调度器、API 代理的
 * 展示器以及每个工具插件都是它的消费方，因此它无法移入 preset。
 * preset 能拥有的是展示方式：`ctx.tools.presentAs()` 为挂载中的
 * SCOPE 声明展示，该 SCOPE 即 preset 的常驻挂载点，因此声明覆盖
 * 加入该 preset 的每个 agent，且 PTC 模式 preset 与原生 preset 在
 * 同一进程中并存。每个组合一行配置，而非每个 session 一行。
 *
 * PTC 模式需要 TypeScript PTC 运行时，它是宿主平面服务
 * ([`dsh-ptc-runtime-node`](../../../ptc-runtime/ptc-runtime-node/README.md))。
 * 因此这一行选择等待它而非假定它存在：在未组合运行时的部署中
 * 选择 PTC 模式的 preset 会在挂载时失败，并在 preset 自身的激活
 * 审计中具名报告，而不是等到第一次提示词时才失败。
 * @module @deepseek-ai/dsh-agent-tool-presentation
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ToolPresentationMode } from '@deepseek-ai/dsh-tools'
// 仅类型导入：将 `ctx.tools` 的 Context 合并引入本程序。
import type {} from '@deepseek-ai/dsh-tools'

/** Cordis 插件名。*/
export const name = 'tool-presentation'

/**
 * 必需服务。`ptcRuntime` 未列入：`native` 行必须在未组合运行时的部署中
 * 挂载，依赖模式的等待改在 {@link apply} 内部声明。
 */
export const inject = ['tools']

/** 插件配置。*/
export interface Config {
  /**
   * 该 agent 的模型看到的形式。`native` 发送全部可见 schema，
   * `ptc` 只发送 `run_code` 加上生成的 SDK。
   * 必填而非默认值：部署默认值正是没有这一行的 preset 已经得到的
   * 结果，因此省略该值意味着这一行组合得毫无意义。
   */
  mode: ToolPresentationMode
}

/** 运行时 schema。*/
export const Config: z<Config> = z.object({
  mode: z.union(['native', 'ptc'] as const).required(),
})

/**
 * 为该组合覆盖的每个 agent 声明工具展示。
 * @param ctx - 挂载中组合的 scope 上下文（preset 的常驻 scope）。
 * @param config - 选定的展示方式。
 */
export function apply(ctx: Context, config: Config): void {
  // `presentAs` 本身就是 effect——它通过调用方上下文注册并交还
  // 完全相同的释放器——因此该声明随这一行一起释放，无需第二个
  // 包装层来持有它。
  if (config.mode === 'native') {
    ctx.tools.presentAs('native')
    return
  }
  // 等待即显式失败：仍等待 `ptcRuntime` 的条目会被
  // `dsh-agent-preset-registry` 报告为不可用行，并指名该 id。
  ctx.inject(['ptcRuntime'], (runtimeCtx: Context) => {
    runtimeCtx.tools.presentAs(config.mode)
  })
}
