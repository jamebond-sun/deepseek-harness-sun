import type { Branded } from '@deepseek-ai/dsh-brand'
import type { PluginLocalizedMeta } from '@deepseek-ai/dsh-package-manifest'

/** 一条已配置插件条目在 Loader 树中的稳定身份。 */
export type PluginEntryId = Branded<'PluginEntryId'>

/** 条目根 Fiber 的生命周期状态；没有存活根 Fiber 时为 null。 */
export type PluginFiberPhase =
  | 'pending'
  | 'loading'
  | 'active'
  | 'failed'
  | 'unloading'
  | null

/** 暴露给受信任客户端的一条非分组 Loader 条目。 */
export interface PluginInventoryEntry {
  readonly entryId: PluginEntryId
  /** Loader 条目所导入的确切模块说明符。 */
  readonly moduleName: string
  /** 本地包的展示元数据，与条目是否启用无关。 */
  readonly meta?: PluginLocalizedMeta
  /** Loader 的实际启用状态，包含被禁用的祖先分组。 */
  readonly enabled: boolean
  readonly fiberPhase: PluginFiberPhase
}

/** 一条 preset 组合行的实际启用状态。 */
export type PresetPluginEnablement = boolean | 'conditional'

/** agent preset 组合中命名的一条插件行。 */
export interface AgentPresetPluginRow {
  /** 组合行 id；该行未声明 id 时为 null。 */
  readonly entryId: string | null
  /** 该行所命名的模块说明符。 */
  readonly moduleName: string
  /** 本地包的展示元数据，与 preset 是否已挂载无关。 */
  readonly meta?: PluginLocalizedMeta
  /**
   * 实际启用状态，包含被禁用的祖先分组。`'conditional'` 表示在一个尚无 session 挂载的
   * 组合上存在 `!!js` disabled 表达式，这只有 Loader context 才能判定。
   */
  readonly enabled: PresetPluginEnablement
  /** 该行自身的 `!!js` disabled 表达式（若存在）。 */
  readonly condition?: string
  /** 组合处于活动状态时的根 fiber 阶段；否则为 null。 */
  readonly fiberPhase: PluginFiberPhase
}

/** 清单中某个 agent preset 的身份及其展开后的组合。 */
export interface AgentPresetPluginGroup {
  /** 稳定的 preset id。 */
  readonly id: string
  /** preset 发布的展示名；读取方在缺失时回退到 id。 */
  readonly name?: string
  /** 未指定 preset 的 session 是否会组合这一个。 */
  readonly isDefault: boolean
  /** 该 preset 的组合为何无法读取；行能给出答案时缺省。 */
  readonly broken?: string
  /** 按组合顺序排列的插件行；preset 损坏时为空。 */
  readonly rows: readonly AgentPresetPluginRow[]
}

/** 插件清单 Remote 返回的时点快照。 */
export interface PluginInventorySnapshot {
  /** 本宿主是否提供持久化的当前 profile 管理能力。 */
  readonly managementAvailable?: boolean
  readonly entries: readonly PluginInventoryEntry[]
  /**
   * 各 preset 的组合，仅当本部署中组合了 agent-preset 名册时才出现。
   */
  readonly agentPresets?: readonly AgentPresetPluginGroup[]
}
