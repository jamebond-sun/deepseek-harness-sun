/** 当前 Cordis Loader 插件条目的只读投影。 */

import type { Context, FiberState } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
// 仅类型：通过 `ctx.get` 解析的可选 agent-preset 名册。
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-app-boot'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
// Typert 生成的 ./typert 与 ./remote 产物在运行时导入 Zod。
import type {} from 'zod'
import type {
  AgentPresetPluginGroup,
  PluginEntryId,
  PluginFiberPhase,
  PluginInventoryEntry,
  PluginInventorySnapshot,
} from './types.ts'

export type * from './types.ts'

/**
 * 在归属边界处为既有的 Loader 树条目 id 打上品牌类型。
 * @param value - Loader 树所书写的条目 id。
 * @returns 同一个 id，作为清单的品牌化条目 id。
 */
export function pluginEntryId(value: string): PluginEntryId {
  return value as PluginEntryId
}

/** 运行时镜像：FiberState 是跨包的 const enum。 */
const FIBER_STATE = {
  PENDING: 0 as FiberState.PENDING,
  LOADING: 1 as FiberState.LOADING,
  ACTIVE: 2 as FiberState.ACTIVE,
  FAILED: 3 as FiberState.FAILED,
  DISPOSED: 4 as FiberState.DISPOSED,
  UNLOADING: 5 as FiberState.UNLOADING,
} as const

/** Cordis Fiber 状态的完整公开投影。 */
const FIBER_PHASE = {
  [FIBER_STATE.PENDING]: 'pending',
  [FIBER_STATE.LOADING]: 'loading',
  [FIBER_STATE.ACTIVE]: 'active',
  [FIBER_STATE.FAILED]: 'failed',
  [FIBER_STATE.DISPOSED]: null,
  [FIBER_STATE.UNLOADING]: 'unloading',
} as const satisfies Record<FiberState, PluginFiberPhase>

/** 仅远程服务：暴露 Loader 当前非分组条目的状态。 */
export class PluginInventoryGateway extends TypertRemoteService {
  static inject = ['loader']

  constructor(ctx: Context) {
    super(ctx, 'pluginInventory')
  }

  /**
   * 每次调用都直接读取 Loader。Cordis 内部的 plugin/status 事件已经在维护 Entry.fiber
   * 与 Fiber.state，因此再来一份缓存只会多出一个需要同步的生命周期真相。
   *
   * 当组合了 agent-preset 名册时，快照还会带上每个 preset 的组合行，因为挂载了名册的
   * 部署是在这些行上——而不是 Loader 自己的条目上——运行面向模型的插件的。
   * @returns 按 Loader 顺序排列的当前非分组 Loader 条目，附带可选的展示元数据，以及在
   * 组合了名册时每个 preset 的组合。
   */
  @Remote('list')
  async list(): Promise<PluginInventorySnapshot> {
    return readPluginInventory(this.ctx)
  }
}

export default PluginInventoryGateway

/** 读取当前 Loader 条目与可选的 preset 组合。
 * @param ctx 带有 Loader 服务的 context。
 * @returns 当前清单，含可选展示元数据，没有独立的运行时缓存。
 */
export async function readPluginInventory(ctx: Context): Promise<PluginInventorySnapshot> {
  const entries: PluginInventoryEntry[] = []
  const packages = ctx.get('pluginPackages')
  for (const entry of ctx.loader.entries()) {
    if (entry.options.group) continue
    const base = entry.parent.tree.ctx.baseUrl
    const meta = base === undefined ? undefined : packages?.metaOf(entry.options.name, base)
    entries.push({
      entryId: pluginEntryId(entry.id),
      moduleName: entry.options.name,
      enabled: !entry.disabled,
      fiberPhase: entry.fiber === undefined ? null : FIBER_PHASE[entry.fiber.state],
      ...meta === undefined ? {} : { meta },
    })
  }
  const presets = ctx.get('agentPresets')
  const management = ctx.get('pluginManager') === undefined ? {} : { managementAvailable: true }
  if (presets === undefined) return { entries, ...management }
  const agentPresets: AgentPresetPluginGroup[] = (await presets.compositionInventory()).map(
    composition => ({
      ...composition,
      rows: composition.rows.map(({ fiberState, ...row }) => {
        const meta = ctx.baseUrl === undefined ? undefined : packages?.metaOf(row.moduleName, ctx.baseUrl)
        return {
          ...row,
          fiberPhase: fiberState === undefined ? null : FIBER_PHASE[fiberState],
          ...meta === undefined ? {} : { meta },
        }
      }),
    }),
  )
  return { entries, agentPresets, ...management }
}
