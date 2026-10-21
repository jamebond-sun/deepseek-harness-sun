/** 来自声明配置或已激活版本的插件清单。 */
import { FiberState } from '@deepseek-ai/cordis'
import { isJsExpr, type EntryTree } from '@deepseek-ai/cordis-plugin-loader'
import { entryListProblem } from './definition.ts'

/**
 * 一条组合行的有效启用状态：字面量或求值得到的布尔值；
 * 当某个 `!!js` 的 disabled 表达式无法在挂载之外求值时，取 `'conditional'`。
 */
export type CompositionRowEnablement = boolean | 'conditional'

/**
 * 按 Loader 在挂载决策时的方式求值一个 `!!js` disabled 表达式。
 * 抛错表示拒绝回答：该行被报为 `'conditional'`，而不是凭猜测给出结果。
 */
export type DisabledExpressionEvaluator = (expression: string) => unknown

/** 预设组合所命名的一条插件行。 */
export interface AgentPresetCompositionRow {
  /**
   * 相对于预设 Loader 树的条目 id，激活前则为声明的 id；
   * 未挂载的行若未声明任何 id，则为 null。
   */
  readonly entryId: string | null
  /** 该行命名的模块说明符。 */
  readonly moduleName: string
  /** 有效启用状态，包含被禁用的祖先组。 */
  readonly enabled: CompositionRowEnablement
  /** 该行自带的 `!!js` disabled 表达式（若有）。 */
  readonly condition?: string
  /** 根 fiber 状态，仅在从活动挂载读取时存在。 */
  readonly fiberState?: FiberState
}

/** 一个预设的名册身份及其组合行。 */
export interface AgentPresetComposition {
  /** 稳定的预设 id。 */
  readonly id: string
  /** 预设发布的显示名。 */
  readonly name?: string
  /** 未指定预设的会话是否使用本预设进行组合。 */
  readonly isDefault: boolean
  /** 为何无法读取该预设的行；当 {@link rows} 有结果时不存在。 */
  readonly broken?: string
  /** 按组合顺序排列的行；预设损坏时为空。 */
  readonly rows: readonly AgentPresetCompositionRow[]
}

/** 某个保留预设版本的活动模块引用与隔离诊断信息。 */
export interface AgentPresetInspection {
  /** 预设身份；不同的保留版本可以共享同一个 id。 */
  readonly id: string
  /** 活动模块，附带解析其包身份所需的基址。 */
  readonly modules: readonly {
    /** 配置中的模块说明符。 */
    readonly moduleName: string
    /** 声明该配置的 URL（若可得）。 */
    readonly baseUrl?: string
    /** 裸说明符是否使用应用自身的模块基址。 */
    readonly useHostBase: boolean
  }[]
  /** 该版本在其隔离 realm 之外发布的服务。 */
  readonly leakedServices: readonly string[]
}

/** 读取活动模块引用，不暴露 Loader 条目。
 * @param tree - 该保留版本的条目树。
 * @returns 按 Loader 顺序排列的、与条目解耦的模块引用。
 */
export function activeCompositionModules(tree: EntryTree): AgentPresetInspection['modules'] {
  const modules: Array<AgentPresetInspection['modules'][number]> = []
  for (const entry of tree.entries()) {
    if (entry.options.group || entry.disabled || entry.fiber?.state !== FiberState.ACTIVE) continue
    const ownerTree = entry.parent.tree
    const baseUrl = ownerTree.ctx.baseUrl
    modules.push({
      moduleName: entry.options.name,
      ...baseUrl === undefined ? {} : { baseUrl },
      useHostBase: ownerTree === tree,
    })
  }
  return modules
}

/**
 * 单个 `disabled` 节点对有效启用状态的贡献，与 Loader 自身的解读一致：
 * `!!js` 表达式交由求值器处理——求值器拒绝（抛错）时交由一次真实挂载来决策——
 * 其他情况则完全按 `Boolean(value)` 的结果判定是否禁用。
 * @param value - 某条组合行原始的 `disabled` 节点。
 * @param evaluateExpression - Loader 上下文中的 `!!js` 节点求值器。
 * @returns true（已禁用）、false（已启用）或 `'conditional'`。
 */
function disabledContribution(
  value: unknown,
  evaluateExpression: DisabledExpressionEvaluator,
): boolean | 'conditional' {
  if (isJsExpr(value)) {
    try {
      return Boolean(evaluateExpression(value.__jsExpr))
    } catch {
      // 求值器拒绝求值（表达式格式错误或依赖上下文）；
      // 只有真实的挂载决策才能给出答案，因此该行保持 conditional。
      return 'conditional'
    }
  }
  return Boolean(value)
}

/**
 * 按 Loader 遍历所属组的方式，把祖先组的禁用状态与行自身的禁用状态合并：
 * 任一为字面量 true 即禁用，否则存在表达式时交由挂载决策。
 * @param outer - 合并后的祖先贡献。
 * @param own - 本行自身的贡献。
 * @returns 该行最终的禁用状态。
 */
function combineDisabled(
  outer: boolean | 'conditional',
  own: boolean | 'conditional',
): boolean | 'conditional' {
  if (outer === true || own === true) return true
  if (outer === 'conditional' || own === 'conditional') return 'conditional'
  return false
}

/** {@link entryListProblem} 接受该列表后解析出的组合行。 */
interface RawRow {
  readonly id?: unknown
  readonly name: string
  readonly group?: unknown
  readonly config?: unknown
  readonly disabled?: unknown
}

/**
 * 把一个已解析的行列表展平为插件行。组行只是结构性的——
 * Loader 把组条目报告为始终启用，并让其子行继承 `disabled`——
 * 因此只输出它们的子行。
 * @param rows - 已解析的行，结构由调用方校验。
 * @param outerDisabled - 合并后的祖先组禁用状态。
 * @param evaluateExpression - Loader 上下文中的 `!!js` 节点求值器。
 * @param found - 接收展平结果的累加器。
 */
function flattenRows(
  rows: readonly unknown[],
  outerDisabled: boolean | 'conditional',
  evaluateExpression: DisabledExpressionEvaluator,
  found: AgentPresetCompositionRow[],
): void {
  for (const value of rows) {
    const row = value as RawRow
    const disabled = combineDisabled(outerDisabled, disabledContribution(row.disabled, evaluateExpression))
    if (row.group === true) {
      flattenRows(row.config as readonly unknown[], disabled, evaluateExpression, found)
      continue
    }
    found.push({
      entryId: typeof row.id === 'string' && row.id !== '' ? row.id : null,
      moduleName: row.name,
      enabled: disabled === true ? false : disabled === 'conditional' ? 'conditional' : true,
      ...isJsExpr(row.disabled) ? { condition: row.disabled.__jsExpr } : {},
    })
  }
}

/** 在成功激活之前展平已声明的子插件，用于诊断。
 * @param rows 已解析的子条目。
 * @param evaluateExpression Loader 上下文中的 disabled 表达式求值器。
 * @returns 展平后的条目，或一条配置诊断信息。
 */
export function definitionComposition(
  rows: unknown,
  evaluateExpression: DisabledExpressionEvaluator,
): { rows: AgentPresetCompositionRow[] } | { broken: string } {
  const problem = entryListProblem(rows)
  if (problem !== undefined) return { broken: problem }
  const found: AgentPresetCompositionRow[] = []
  flattenRows(rows as readonly unknown[], false, evaluateExpression, found)
  return { rows: found }
}

/**
 * 某个活动常驻组合的插件行，按 Loader 条目顺序排列。
 * @param tree - 该常驻挂载的条目树。
 * @returns 带有 Loader 求值后的启用状态与根 fiber 状态的行。
 */
export function mountedCompositionRows(tree: EntryTree): AgentPresetCompositionRow[] {
  const found: AgentPresetCompositionRow[] = []
  const owner = tree.ctx.fiber.entry
  const prefix = owner === undefined ? '' : `${owner.id}:`
  for (const entry of tree.entries()) {
    if (entry.options.group) continue
    found.push({
      entryId: entry.id.slice(prefix.length),
      moduleName: entry.options.name,
      enabled: !entry.disabled,
      ...isJsExpr(entry.options.disabled) ? { condition: entry.options.disabled.__jsExpr } : {},
      ...entry.fiber === undefined ? {} : { fiberState: entry.fiber.state },
    })
  }
  return found
}
