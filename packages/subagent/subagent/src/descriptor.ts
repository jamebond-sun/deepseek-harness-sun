/**
 * 持久化的子代理描述符：带版本、对模型隐藏的 `subagent/descriptor`
 * session 事件，用于标识每一个由 session 支撑的子代理，包括历史的一次性
 * 记录。管理器在其初始轮次内追加每个可续跑子代理的描述符，保留冷恢复
 * 所需的已声明组合。
 *
 * 描述符有意对显式字段做快照，而非对可合并扩展的 `AgentOptions` 对象做
 * 快照：一个无关的扩展值不会因为不是 JSON 就让续跑失败，而后续的组合
 * 输入需要经过一次深思熟虑的 {@link SUBAGENT_DESCRIPTOR_VERSION} 变更。
 * 它省略 `subagentDepth` —— 冷恢复信任持久化 header 的 `delegationDepth`
 * 作为单调下界 —— 也省略 `outputSchema`，后者属于某一次激活的结果契约，
 * 而非持久化的子代理组合。诸如 `maxTokens` 这类按激活生效的旋钮出于与
 * `outputSchema` 相同的理由被省略：它们只对一次激活做预算。冷恢复需要
 * 精确的实时父代理来做授权，但仅从持久化描述符重建子代理选项，因此它
 * 既不恢复先前的预算，也不继承父代理当前的预算；改用恢复后路由的默认值。
 *
 * @module @deepseek-ai/dsh-subagent/descriptor
 */

import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ToolRestriction } from '@deepseek-ai/dsh-tools'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * 由 session 支撑的子代理的持久化身份与生命周期模式，在子代理初始
     * 轮次内、其首次请求之前追加一次。可续跑记录还携带其可恢复的组合。
     * 仅日志：它不携带 `surfaceOp`，从不进入模型历史，且能挺过压缩。
     */
    'subagent/descriptor': SubagentDescriptorData
  }
}

/**
 * 当前描述符格式版本，盖在每个被追加的 `subagent/descriptor` 事件上，
 * 并被 {@link foldSubagentDescriptor} 逐字要求匹配。支持另一种组合输入是
 * 一次深思熟虑的版本变更，绝不是隐式的额外字段。
 */
export const SUBAGENT_DESCRIPTOR_VERSION = 3

/** 每个受支持的 `subagent/descriptor` 载荷所共享的字段。 */
interface SubagentDescriptorBase {
  /** 描述符格式版本（{@link SUBAGENT_DESCRIPTOR_VERSION}）。 */
  readonly version: number
  /** 子代理是终止型一次性运行，还是可恢复的对话。 */
  readonly mode: 'one-shot' | 'continuable'
  /** 建立该子代理的 `ctx.subagents` 提供方名称。 */
  readonly provider: string
}

/** 运行结束后无法被冷恢复的、由 session 支撑的子代理。 */
export interface OneShotSubagentDescriptorData extends SubagentDescriptorBase {
  readonly mode: 'one-shot'
  /**
   * 初始委托的简短 `description`，保留为子代理的持久化创建标签，使枚举
   * 无需重放父工具结果或暴露子代理 prompt 即可识别该对话。
   */
  readonly label?: string
}

/** 其已声明组合支持冷恢复的、由 session 支撑的子代理。 */
export interface ContinuableSubagentDescriptorData extends SubagentDescriptorBase {
  readonly mode: 'continuable'
  /** 初始委托的简短 `description`，用于持久化枚举。 */
  readonly label: string
  /** 已解析的子代理 `agentOptions.provider`，若已声明。 */
  readonly agentProvider?: string
  /** 已解析的子代理 `agentOptions.model`，若已声明。 */
  readonly agentModel?: string
  /** 已解析的子代理 `agentOptions.reasoningEffort`，若已声明。 */
  readonly agentReasoningEffort?: ReasoningEffortId
  /** 在恢复时遮蔽部署 persona 的、按子代理的 persona。 */
  readonly persona?: string
  /** 在恢复时重新应用的子代理工具作用域。 */
  readonly toolFilter?: ToolRestriction
}

/** 受支持的持久化子代理身份与可选的续跑组合。 */
export type SubagentDescriptorData =
  | OneShotSubagentDescriptorData
  | ContinuableSubagentDescriptorData

/** 在快照盖上格式版本之前的可续跑组合字段。 */
export type ContinuableSubagentDescriptorInput = Omit<ContinuableSubagentDescriptorData, 'version'>

const DESCRIPTOR_BASE_KEYS = [
  'version',
  'mode',
  'provider',
  'label',
] as const
const ONE_SHOT_DESCRIPTOR_KEYS = new Set(DESCRIPTOR_BASE_KEYS)
const CONTINUABLE_DESCRIPTOR_KEYS = new Set([
  ...DESCRIPTOR_BASE_KEYS,
  'agentProvider',
  'agentModel',
  'agentReasoningEffort',
  'persona',
  'toolFilter',
])
const TOOL_FILTER_KEYS = new Set(['allow', 'deny'])

/** 一个持久化的 JSON 值是否为对象记录。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 拒收超出某个带版本记录所声明模式的字段。 */
function assertKnownKeys(value: Record<string, unknown>, keys: ReadonlySet<string>, path: string): void {
  const unknown = Object.keys(value).find(key => !keys.has(key))
  if (unknown !== undefined) {
    throw new Error(`persisted subagent descriptor ${path} has unknown field "${unknown}"`)
  }
}

/** 从持久化描述符记录读取一个可选字符串字段。 */
function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  if (!Object.hasOwn(value, key)) return undefined
  const field = value[key]
  if (typeof field !== 'string') {
    throw new Error(`persisted subagent descriptor ${key} must be a string`)
  }
  return field
}

/** 从持久化工具限制读取一个可选字符串数组字段。 */
function optionalStringArray(value: Record<string, unknown>, key: string): string[] | undefined {
  if (!Object.hasOwn(value, key)) return undefined
  const field = value[key]
  if (!Array.isArray(field)) {
    throw new Error(`persisted subagent descriptor toolFilter.${key} must be an array of strings`)
  }
  const items: unknown[] = field
  if (items.some(item => typeof item !== 'string')) {
    throw new Error(`persisted subagent descriptor toolFilter.${key} must be an array of strings`)
  }
  return items as string[]
}

/** 校验并重建一个持久化的工具限制。 */
function parseToolFilter(value: unknown): ToolRestriction {
  if (!isRecord(value)) {
    throw new Error('persisted subagent descriptor toolFilter must be an object')
  }
  assertKnownKeys(value, TOOL_FILTER_KEYS, 'toolFilter')
  const allow = optionalStringArray(value, 'allow')
  const deny = optionalStringArray(value, 'deny')
  if (allow === undefined && deny === undefined) {
    throw new Error('persisted subagent descriptor toolFilter must declare allow and/or deny')
  }
  return {
    ...allow !== undefined ? { allow } : {},
    ...deny !== undefined ? { deny } : {},
  }
}

/** 为当前运行时校验一个持久化描述符载荷。 */
function parseSubagentDescriptor(value: unknown): SubagentDescriptorData | undefined {
  if (!isRecord(value)) {
    throw new Error('persisted subagent descriptor payload must be an object')
  }
  const version = value['version']
  if (typeof version !== 'number') {
    throw new Error('persisted subagent descriptor version must be a number')
  }
  if (version !== SUBAGENT_DESCRIPTOR_VERSION) return undefined

  const mode = value['mode']
  if (mode !== 'one-shot' && mode !== 'continuable') {
    throw new Error('persisted subagent descriptor mode must be "one-shot" or "continuable"')
  }
  assertKnownKeys(
    value,
    mode === 'one-shot' ? ONE_SHOT_DESCRIPTOR_KEYS : CONTINUABLE_DESCRIPTOR_KEYS,
    'payload',
  )
  const provider = value['provider']
  if (typeof provider !== 'string') {
    throw new Error('persisted subagent descriptor provider must be a string')
  }
  if (mode === 'one-shot') {
    const label = optionalString(value, 'label')
    return {
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode,
      provider,
      ...label !== undefined ? { label } : {},
    }
  }
  const label = value['label']
  if (typeof label !== 'string') {
    throw new Error('persisted subagent descriptor label must be a string')
  }
  const agentProvider = optionalString(value, 'agentProvider')
  const agentModel = optionalString(value, 'agentModel')
  const agentReasoningEffort = optionalString(value, 'agentReasoningEffort') as ReasoningEffortId | undefined
  const persona = optionalString(value, 'persona')
  const toolFilter = Object.hasOwn(value, 'toolFilter')
    ? parseToolFilter(value['toolFilter'])
    : undefined
  return {
    version: SUBAGENT_DESCRIPTOR_VERSION,
    mode,
    provider,
    label,
    ...agentProvider !== undefined ? { agentProvider } : {},
    ...agentModel !== undefined ? { agentModel } : {},
    ...agentReasoningEffort !== undefined ? { agentReasoningEffort } : {},
    ...persona !== undefined ? { persona } : {},
    ...toolFilter !== undefined ? { toolFilter } : {},
  }
}

/**
 * 校验并分离一个可续跑描述符输入。
 * @param input - 调用方收集的可续跑组合字段。
 * @returns 带版本、已分离的可续跑描述符载荷。
 * @throws 当某个字段不能无损地 JSON 序列化时。
 */
export function snapshotSubagentDescriptor(
  input: ContinuableSubagentDescriptorInput,
): ContinuableSubagentDescriptorData {
  const candidate: ContinuableSubagentDescriptorData = {
    version: SUBAGENT_DESCRIPTOR_VERSION,
    mode: input.mode,
    provider: input.provider,
    label: input.label,
    ...input.agentProvider !== undefined ? { agentProvider: input.agentProvider } : {},
    ...input.agentModel !== undefined ? { agentModel: input.agentModel } : {},
    ...input.agentReasoningEffort !== undefined ? { agentReasoningEffort: input.agentReasoningEffort } : {},
    ...input.persona !== undefined ? { persona: input.persona } : {},
    ...input.toolFilter !== undefined ? { toolFilter: input.toolFilter } : {},
  }
  const snapshot = snapshotJsonValue(candidate)
  if (snapshot === undefined) {
    throw new Error('subagent descriptor is not losslessly JSON-serializable')
  }
  return snapshot
}

/**
 * 把一个持久化的子日志折叠为其受支持的描述符。第一个
 * `subagent/descriptor` 事件是权威的 —— 建立它的提供方恰好只追加一个，
 * 因此之后同类型事件无法重写已声明的组合。
 * @param events - 已加载的子 session 事件。
 * @returns 该描述符；当日志中没有描述符，或其版本不是
 *   {@link SUBAGENT_DESCRIPTOR_VERSION} 时返回 `undefined`（该子代理无法被
 *   本运行时分类）。
 * @throws 当一个当前版本的持久化载荷不符合其完整声明模式时。
 */
export function foldSubagentDescriptor(events: readonly SessionEvent[]): SubagentDescriptorData | undefined {
  const event = events.find(
    (candidate): candidate is SessionEvent<'subagent/descriptor'> => candidate.type === 'subagent/descriptor',
  )
  if (event === undefined) return undefined
  return parseSubagentDescriptor(event.data)
}
