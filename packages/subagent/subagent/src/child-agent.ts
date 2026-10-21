/**
 * 共享的进程内子代理组合：委托深度预算、持久化 session 元数据、
 * 解析出的子代理 `AgentOptions`、被委托的策略种子，以及本地激活所使用的
 * 作用域化装配。
 *
 * @module @deepseek-ai/dsh-subagent/child-agent
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { ToolRestriction } from '@deepseek-ai/dsh-tools'
// 仅类型：使 `ctx.get('sandboxPolicy')`、`ctx.get('approval')` 与
// `ctx.get('permissionPresets')` 在被组合时解析为各自的服务 —— 委托按需消费它们
// （即文档化的 `ctx.get` 模式），而非硬依赖 ——
// 同时合并继承来的权限 session-event 载荷。
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-permission-presets'
// 仅类型：使 `ctx.get('agentPresets')` 在被组合时解析为预设名册 ——
// 子代理按需继承其父代理的组合（即文档化的 `ctx.get` 模式），而非硬依赖。
// 无名册的部署会把其面向模型的行保留在宿主平面上，而子代理已通过工具
// 注册表的全局层看到它们。
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { delegationDepthOf } from './depth.ts'
import { SubagentError } from './error.ts'

/** 当启动子代理会超出所请求的深度上限时抛出。 */
export class SubagentDepthError extends Error {
  constructor(public readonly attemptedDepth: number, public readonly maxDepth: number) {
    super(`subagent depth ${attemptedDepth} exceeds maxDepth ${maxDepth}`)
    this.name = 'SubagentDepthError'
  }
}

/**
 * 根据父代理解析子代理的委托深度并执行可选上限。持久化父 header 是单调
 * 下界，因此恢复后的父代理不能像顶层一样委托。
 * @param parent - 执行委托的父代理。
 * @param maxDepth - 可选的绝对上限，解析出的深度不得超出。
 * @returns 子代理的非负安全整数深度。
 * @throws {SubagentDepthError} 当解析出的深度超出 `maxDepth` 时。
 * @throws {RangeError} 当解析出的深度超出安全整数范围时。
 */
export function resolveChildDepth(parent: Agent, maxDepth: number | undefined): number {
  const childDepth = delegationDepthOf(parent) + 1
  if (!Number.isSafeInteger(childDepth)) {
    throw new RangeError('subagent child depth exceeds the safe-integer range')
  }
  if (maxDepth !== undefined && childDepth > maxDepth) {
    throw new SubagentDepthError(childDepth, maxDepth)
  }
  return childDepth
}

/**
 * 解析子代理所继承的父代取值。在请求期选择之后，最新请求 header 拥有
 * provider、model 与 reasoning effort；创建选项仍是首次请求之前的兜底，
 * 并保留已配置的输出 token 上限。
 * @param parent - 执行委托的父 Agent。
 * @returns 用于子代理选项合并的分离型 Agent 选项。
 */
export function parentAgentOptionsForDelegation(parent: Agent): AgentOptions {
  const requestConfig = parent.session.requestHeader()?.config
  if (requestConfig === undefined) return { ...parent.options }
  const {
    provider: _createdProvider,
    model: _createdModel,
    reasoningEffort: _createdReasoningEffort,
    ...createdOptions
  } = parent.options
  return {
    ...createdOptions,
    provider: requestConfig.provider,
    model: requestConfig.model,
    ...requestConfig.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: requestConfig.reasoningEffort },
  }
}

/**
 * 解析子代理的 `AgentOptions`：继承父代理的 provider/model、
 * reasoning-effort 与 maxTokens，除非请求覆盖了它们，并盖上子代理自身的
 * 委托深度。在没有指定 effort 的情况下更换路由会清除父代理的路由自有
 * effort，让所选模型解析其自身默认值。
 * @param parent - 子代理继承其路由的委托方父代理。
 * @param requested - 针对该子代理的覆盖项（若有）。
 * @param childDepth - 要盖上的、已解析的委托深度。
 * @returns 供 `ctx.agents.create()` 使用的已解析选项。
 */
export function resolveChildAgentOptions(
  parent: Agent,
  requested: AgentOptions | undefined,
  childDepth: number,
): AgentOptions {
  const parentOptions = parentAgentOptionsForDelegation(parent)
  const parentProvider = parentOptions.provider
  const parentModel = parentOptions.model
  const parentReasoningEffort = parentOptions.reasoningEffort
  const parentMaxTokens = parentOptions.maxTokens
  const resolved: AgentOptions = {
    ...parentProvider !== undefined ? { provider: parentProvider } : {},
    ...parentModel !== undefined ? { model: parentModel } : {},
    ...parentReasoningEffort !== undefined ? { reasoningEffort: parentReasoningEffort } : {},
    ...parentMaxTokens !== undefined ? { maxTokens: parentMaxTokens } : {},
    ...requested,
    subagentDepth: childDepth,
  }
  const routeChanged = resolved.provider !== parentProvider || resolved.model !== parentModel
  if (routeChanged && requested?.reasoningEffort === undefined) delete resolved.reasoningEffort
  return resolved
}

/**
 * 构建子 session 的持久化创建元数据：父代理的工作区、其直接血缘、
 * 粗粒度产品来源、必须跨持久化存活的递归预算、分隔继承父历史与子代理
 * 工作的 seed 边界，以及子代理运行所依据的组合。
 *
 * 省略选择时使用父代理的实时组合，包括父代理处于空白期间所做的任何切换。
 * @param parent - 执行委托的父代理。
 * @param childDepth - 要持久化的、已解析的委托深度。
 * @param isSeeded - 该子代理是否继承父日志前缀，包括显式为空的情形。
 * @param selectedPreset - 独立选择，或省略以继承父代理。
 * @returns 供 `ctx.agents.create()` 使用的 `meta`。
 */
export function childSessionMeta(
  parent: Agent,
  childDepth: number,
  isSeeded: boolean,
  selectedPreset?: string,
): NonNullable<CreateAgentOptions['meta']> {
  const parentHeader = parent.session.header
  const agentPreset = selectedPreset ?? parent.ctx.get('agentPresets')?.composedPreset(parent.ctx)
  return {
    ...parentHeader.cwd !== undefined ? { cwd: parentHeader.cwd } : {},
    ...agentPreset === undefined ? {} : { agentPreset },
    parentSession: parentHeader.id,
    isSeeded,
    // 仅作导航分类；描述符仍是模式与续跑能力的权威来源。
    origin: 'subagent',
    // 持久化：递归预算必须跨持久化与恢复存活。
    delegationDepth: childDepth,
  }
}

/** 子代理创建窗口所应用的、作用域化的组合。 */
export interface ChildComposition {
  /** 独立挂载的预设；省略则共享父代理的常驻 generation。 */
  readonly agentPreset?: string | undefined
  /** 仅在冷恢复时重新应用的历史描述符 persona。 */
  readonly persona?: string | undefined
  /** 仅在冷恢复时重新应用的历史描述符工具限制。 */
  readonly toolFilter?: ToolRestriction | undefined
}

/**
 * 面向每个进程内子代理的模型可见委托范围声明。这是运行时上下文贡献，
 * 而非 system-prompt 区段，因此部署的 system prompt 在父代理与子代理之间
 * 保持一致。
 */
export const SUBAGENT_DELEGATION_CONTEXT
  = 'You are a delegated subagent: your permission scope was fixed when you were started and cannot be '
    + 'widened from inside this session — operations that require approval are rejected automatically. '
    + 'When the task needs access beyond that scope, do not retry the denied operation; state the '
    + 'limitation in your reply so the delegating agent can handle it.'

/**
 * 在发布之前组合子代理，并恢复历史描述符覆盖项。显式选择会挂载具名预设；
 * 省略则同步加入父代理的当前 generation。注册项属于子代理作用域。
 * @param childCtx - 子代理的作用域化创建上下文。
 * @param parent - 未选择预设时使用的委托方父代理。
 * @param composition - 独立预设以及从历史描述符读取的任何覆盖项。
 * @returns 挂载独立预设时返回 Promise，否则同步完成。
 */
export function applyChildComposition(
  childCtx: Context,
  parent: Agent,
  composition: ChildComposition,
): void | Promise<void> {
  if (composition.agentPreset !== undefined) {
    const presets = childCtx.get('agentPresets')
    if (presets === undefined) {
      throw new SubagentError('selecting a child agent preset requires the agent-presets service', 'PRESET_UNAVAILABLE')
    }
    return presets.mount(childCtx, composition.agentPreset).then(() => {
      applyChildOverrides(childCtx, composition)
    })
  }
  childCtx.get('agentPresets')?.composeFrom(childCtx, parent.ctx)
  applyChildOverrides(childCtx, composition)
}

function applyChildOverrides(childCtx: Context, composition: ChildComposition): void {
  childCtx.systemPrompt.context({
    name: 'subagent:delegation',
    order: childCtx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION'),
    text: SUBAGENT_DELEGATION_CONTEXT,
  })
  if (composition.persona !== undefined) {
    childCtx.systemPrompt.section({
      name: 'deployment:persona-prefix',
      order: childCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
      text: composition.persona,
    })
  }
  if (composition.toolFilter !== undefined) childCtx.tools.restrict(composition.toolFilter)
}

/** 在委托边界处播种到子 session 日志上的策略。 */
export interface DelegatedPolicyOverrides {
  /**
   * 父代理在 Auto 或 Full access 下运行时的当前预设身份；子代理在钉住的
   * `never` 审批策略下保留它。
   */
  readonly permissionPreset: 'auto' | 'danger-full-access' | undefined
  /** 父 session 的显式 sandbox 模式覆盖，无则为 `undefined`。 */
  readonly sandboxMode: SandboxMode | undefined
  /**
   * 只要组合了审批能力就为 `'never'`，否则为 `undefined`：被委托的子代理
   * 只能在委托时固定的 sandbox 范围内行动，因此其请求会被确定性地拒绝。
   */
  readonly approvalPolicy: 'never' | undefined
}

/**
 * 捕获要播种到一次委托中的权限状态。需在子代理启动的首次 await 之前同步
 * 调用：父代理之后的切换属于父代理的未来，不属于该子代理。Auto 与 Full
 * access 身份仅通过进程内 DSH 路径继承，以便二者都能替换陈旧的
 * 同 bundle fork 值。只捕获父 session 的显式 sandbox 覆盖 —— 从不捕获部署
 * 默认值或一次性授予 —— 且无论父代理自身策略如何，审批策略都钉为 `'never'`。
 * @param parent - 执行委托的父代理。
 * @returns sandbox 覆盖（无则为 `undefined`）与审批钉值。
 */
export function captureDelegatedPolicyOverrides(parent: Agent): DelegatedPolicyOverrides {
  const preset = parent.ctx.get('permissionPresets')?.current(parent.session)
  return {
    permissionPreset: preset === 'auto' || preset === 'danger-full-access' ? preset : undefined,
    sandboxMode: parent.ctx.get('sandboxPolicy')?.overrideOf(parent.session),
    approvalPolicy: parent.ctx.get('approval') === undefined ? undefined : 'never',
  }
}

/**
 * 在未发布创建窗口内，以 `source: 'delegation'` 事件的形式把捕获到的委托
 * 策略追加到子代理自身日志上，使子代理的生效策略可仅从其日志重建。追加
 * 位于任何 fork seed 之后，因此新鲜策略胜过陈旧 seed 状态；子代理之后的
 * 切换仍然胜过这些事件。
 * @param childSession - 未发布子代理的 session。
 * @param overrides - 委托时捕获的策略。
 */
export function appendDelegatedPolicyOverrides(
  childSession: Session,
  overrides: DelegatedPolicyOverrides,
): void {
  if (overrides.sandboxMode !== undefined) {
    childSession.append('sandbox/mode', { mode: overrides.sandboxMode, source: 'delegation' })
  }
  if (overrides.approvalPolicy !== undefined) {
    childSession.append('approval/policy', { policy: overrides.approvalPolicy, source: 'delegation' })
  }
  if (overrides.permissionPreset !== undefined) {
    childSession.append('permission/preset', { preset: overrides.permissionPreset })
  }
}

/** 每个进程内子代理创建所共享的身份与血缘输入。 */
export interface ChildCreateInputs {
  /** 子代理已预留的 session id。 */
  readonly sessionId: SessionId
  /** 执行委托的父代理。 */
  readonly parent: Agent
  /** 已解析的委托深度。 */
  readonly childDepth: number
  /** 来自父日志的前导 seed 事件数量。 */
  readonly lineageSeedLength: number
}
