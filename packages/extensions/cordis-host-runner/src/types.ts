/**
 * 动态 Cordis 插件运行器的、对 Client 安全的连线词汇。
 * @module @deepseek-ai/dsh-cordis-host-runner/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** 一个动态插件实例的、稳定的标识。 */
export type CordisDynamicPluginId = Branded<'CordisDynamicPluginId'>

/** 属于一个动态插件的、某个不可变包版本的标识。 */
export type CordisDynamicPackageId = Branded<'CordisDynamicPackageId'>

/** 一次成功激活尝试的标识。 */
export type CordisDynamicPluginRunId = Branded<'CordisDynamicPluginRunId'>

/** 一次人工审批请求的标识。 */
export type ApprovalRequestId = Branded<'ApprovalRequestId'>

/** 一次跨页面 inspect 查询的标识。 */
export type CordisInspectRequestId = Branded<'CordisInspectRequestId'>

/** 拥有一个 inspect 提供方的运行时面。 */
export type CordisInspectPlatform = 'host' | 'client'

/** 一个由 inspect 提供方暴露的、可供模型调用的只读查询。 */
export interface CordisInspectMethodManifest {
  /** 方法名，在其提供方内唯一。 */
  name: string
  /** 该查询返回什么，以及何时使用它。 */
  description: string
  /** 该查询所接受的 JSON Schema。 */
  inputSchema: JsonValue
  /** 该查询所产生的 JSON Schema。 */
  outputSchema: JsonValue
}

/** 一个 inspect 提供方的、可序列化的目录条目。 */
export interface CordisInspectProviderManifest {
  /** 提供方标识，在一个平台内唯一。 */
  id: string
  /** 此提供方所描述的能力。 */
  description: string
  /** 显式的只读查询。 */
  methods: readonly CordisInspectMethodManifest[]
}

/** 由 `cordis_inspect_list` 返回的提供方目录行。 */
export interface CordisInspectProviderView extends CordisInspectProviderManifest {
  /** 执行这些方法的运行时面。 */
  platform: CordisInspectPlatform
}

/** 请求一个活跃 Client inspect 结果的 Host 广播。 */
export interface CordisInspectQueryRequest {
  /** 关联标识。 */
  requestId: CordisInspectRequestId
  /** 其模型发起了该查询的 Session。 */
  agentId: SessionId
  /** 从 Client 清单中选出的提供方。 */
  provider: string
  /** 从提供方清单中选出的方法。 */
  method: string
  /** JSON 查询输入，方法无字段时省略。 */
  input?: JsonValue
}

/** 从一个 Client 提供方发送至正在等待的 Host 查询的结果。 */
export type CordisInspectQueryResolution =
  | { ok: true; data: JsonValue }
  | {
    ok: false
    reason: 'provider-missing' | 'method-missing' | 'invalid-input' | 'provider-error' | 'cancelled'
    message: string
  }

/** 通知某个 Client inspect 请求已无法再被回答。 */
export interface CordisInspectQueryResolved {
  /** 离开待定状态的查询。 */
  requestId: CordisInspectRequestId
}

/** 某个 Client 应答是否认领了仍处于待定状态的查询。 */
export interface CordisInspectResolveAck {
  /**
   * 仅对一次有效、且能了结该查询的成功为真；
   * 对保留的失败，以及未知、超时、取消或迟到的应答为假。
   */
  accepted: boolean
}

/** 一个包是启动当前版本还是替换它。 */
export type CordisDynamicRunMode = 'run' | 'update'

/** 一个由模型驱动的 Client 激活请求如何离开待定状态。 */
export type RequestRunOutcome = 'approved' | 'completed' | 'rejected' | 'cancelled' | 'failed'

/** 跨越 Host/Client 传输而保留的错误字段。 */
export interface CordisErrorDetails {
  /** 原始错误消息。 */
  message: string
  /** 抛出异常的值提供了栈时，其原始栈。 */
  stack?: string
}

/** 最近一次激活尝试的持久化状态。 */
export type CordisRunStatus =
  | 'awaiting-approval'
  | 'starting-host'
  | 'client-pending'
  | 'running'
  | 'waiting'
  | 'rejected'
  | 'failed'
  | 'cancelled'
  | 'stopped'

/** 一次激活尝试中的一个平台半区。 */
export interface CordisHalfState {
  /** 此半区的生命周期状态。 */
  status: 'absent' | 'pending' | 'stopped' | 'running' | 'waiting' | 'failed'
  /** 一个已成功创建的 Fiber 仍需要的服务。 */
  waitingFor: readonly string[]
  /** 此半区的失败文本。 */
  error?: string
}

/** 与某一次确切激活尝试相关联的结构化失败。 */
export interface CordisRunDiagnostic {
  /** 失败所处的阶段。 */
  phase: 'approval' | 'host-load' | 'host-apply' | 'client-load' | 'client-apply' | 'client-render'
  /** 原始失败文本。 */
  message: string
  /** 有可用失败时，其原始失败栈。 */
  stack?: string
  /** 稳定的 Plugin 标识。 */
  pluginId: CordisDynamicPluginId
  /** 不可变的 Package 标识。 */
  packageId: CordisDynamicPackageId
  /** 确切的尝试标识。 */
  pluginRunId: CordisDynamicPluginRunId
}

/** 独立于物理运行而保留的最近激活尝试。 */
export interface DynamicCordisRunAttempt {
  /** 确切的尝试标识。 */
  pluginRunId: CordisDynamicPluginRunId
  /** 目标 Package。 */
  packageId: CordisDynamicPackageId
  /** 显式的 run/update 意图。 */
  mode: CordisDynamicRunMode
  /** 当前尝试状态。 */
  status: CordisRunStatus
  /** 待定的 Client 激活请求；仅当 `requiresApproval` 为真时它才代表审批。 */
  approvalRequestId?: ApprovalRequestId
  /** 待定的 Client 激活是否需要用户决策。 */
  requiresApproval?: boolean
  /** Host 半区状态。 */
  host: CordisHalfState
  /** Client 半区状态。 */
  client: CordisHalfState
  /** 最近的失败。 */
  error?: CordisRunDiagnostic
}

/** 向浏览器页面宣告的一个运行中包。 */
export interface DynamicCordisPackage {
  /** 稳定的插件实例。 */
  pluginId: CordisDynamicPluginId
  /** 当前活跃的不可变包版本。 */
  packageId: CordisDynamicPackageId
  /** 本次激活的标识。 */
  pluginRunId: CordisDynamicPluginRunId
  /** 包标签。 */
  name: string
}

/** 转发给浏览器页面的、待定的由模型驱动的 Client 激活。 */
export interface DynamicCordisRunRequest {
  /** 激活请求的关联标识。 */
  requestId: ApprovalRequestId
  /** 其插件与工具调用拥有该请求的 Session。 */
  agentId: SessionId
  /** 正被操作的稳定插件实例。 */
  pluginId: CordisDynamicPluginId
  /** 该请求将要激活的包版本。 */
  packageId: CordisDynamicPackageId
  /** 显式的生命周期意图。 */
  mode: CordisDynamicRunMode
  /** 包标签。 */
  name: string
  /** 在 define 时提供的、面向用户的理由。 */
  purpose: string
  /** 页面是否必须在激活前等待一次显式的用户决策。 */
  requiresApproval: boolean
}

/** 向所有页面广播的、一次已了结的由模型驱动的 Client 激活请求。 */
export interface DynamicCordisRequestResolved {
  /** 离开待定状态的请求。 */
  requestId: ApprovalRequestId
  /** 该请求如何了结。 */
  outcome: RequestRunOutcome
}

/** 从每个页面撤回的一次激活。 */
export interface DynamicCordisRetracted {
  /** 稳定的插件实例。 */
  pluginId: CordisDynamicPluginId
  /** 曾处于活跃状态的包版本。 */
  packageId: CordisDynamicPackageId
  /** 正被撤回的确切激活。 */
  pluginRunId: CordisDynamicPluginRunId
}

/** 由清单在不暴露源码的前提下所暴露的包元数据。 */
export interface DynamicCordisInventoryPackage {
  /** 不可变的包版本。 */
  packageId: CordisDynamicPackageId
  /** 包标签。 */
  name: string
  /** 面向用户的用途。 */
  purpose: string
  /** 此版本是否包含 Host 代码。 */
  hasHostHalf: boolean
  /** 此版本是否包含 Client 代码。 */
  hasClientHalf: boolean
}

/** 框级清单中的一行稳定插件。 */
export interface DynamicCordisInventoryRow {
  /** 稳定的插件实例。 */
  pluginId: CordisDynamicPluginId
  /** 拥有此插件的 Session。 */
  agentId: SessionId
  /** 按 define 顺序的不可变版本。 */
  packages: readonly DynamicCordisInventoryPackage[]
  /** 最近一次成功完成激活的包。 */
  currentPackageId?: CordisDynamicPackageId
  /** 为一个失败中或进行中的转换所选的包。 */
  nextPackageId?: CordisDynamicPackageId
  /** 当前激活，停止期间缺省。 */
  activeRun?: {
    pluginRunId: CordisDynamicPluginRunId
    packageId: CordisDynamicPackageId
  }
  /** 最近一次激活尝试，包含待定审批与诊断。 */
  latestRun?: DynamicCordisRunAttempt
}

/** 移除一个插件及其全部包版本的应答。 */
export type DynamicCordisUndefineReceipt =
  | { ok: true; wasRunning: boolean }
  | { ok: false; reason: 'plugin-missing'; message: string }

/** 在一个 Client 半区加载之后观察到的一次渲染失败。 */
export interface DynamicCordisRenderFailure {
  /** 组件失败的槽位。 */
  slot: string
  /** 渲染失败文本。 */
  message: string
  /** 有可用渲染失败时，其原始渲染失败栈。 */
  stack?: string
  /** 失败的贡献是否放弃了它的槽位。 */
  abdicated: boolean
}

/** 由模型驱动与面板驱动激活所共享的结果。 */
export type DynamicCordisRunResponse =
  | {
    ok: true
    /** 激活是已同步完成、正在某 Client 中启动，还是等待用户审批。 */
    status: 'awaiting-approval' | 'starting' | 'running'
    pluginId: CordisDynamicPluginId
    packageId: CordisDynamicPackageId
    pluginRunId: CordisDynamicPluginRunId
    /** 缺失的 Host 服务；一个停驻的 Fiber 是一次成功的激活。 */
    waitingFor: readonly string[]
    /** 由审批页面报告的、缺失的 Client 服务。 */
    clientWaitingFor?: readonly string[]
    /** 最近一次完全成功的 Package。 */
    currentPackageId?: CordisDynamicPackageId
    /** 被选定的转换目标。 */
    nextPackageId?: CordisDynamicPackageId
    /** 显式的生命周期意图。 */
    mode: CordisDynamicRunMode
  }
  | {
    ok: false
    reason:
      | 'plugin-missing'
      | 'package-missing'
      | 'invalid-mode'
      | 'transition-in-flight'
      | 'host-half-failed'
      | 'client-half-failed'
      | 'rejected'
      | 'cancelled'
      | 'not-running'
    message: string
    /** 有可用失败时，其原始失败栈。 */
    stack?: string
  }

/** 在不删除其包的前提下停止一个 Plugin 的结果。 */
export type DynamicCordisStopResponse =
  | { ok: true }
  | { ok: false; reason: 'plugin-missing' | 'not-running'; message: string }

/** 在加载 Client 半区之前拉起 Host 半区的结果。 */
export type DynamicCordisHostHalfResult =
  | {
    ok: true
    pluginId: CordisDynamicPluginId
    packageId: CordisDynamicPackageId
    pluginRunId: CordisDynamicPluginRunId
    waitingFor: readonly string[]
    /** 当面板只是把本页面附加到一次已活跃的运行上时为假。 */
    startedHere: boolean
  }
  | ({ ok: false } & CordisErrorDetails)

/** 某一次确切激活的 Client 半区源码。 */
export interface DynamicCordisClientSource {
  /** 浏览器 JavaScript 主体。 */
  code: string
  /** 包标签。 */
  name: string
  /** 稳定的插件实例。 */
  pluginId: CordisDynamicPluginId
  /** 不可变的源码版本。 */
  packageId: CordisDynamicPackageId
  /** 该源码所属的确切激活。 */
  pluginRunId: CordisDynamicPluginRunId
}

/** 用于已审批工具运行与面板运行的浏览器裁定。 */
export type DynamicCordisRunResolution =
  | { ok: true; pluginRunId: CordisDynamicPluginRunId; waitingFor?: readonly string[] }
  | {
    ok: false
    reason: 'rejected' | 'host-half-failed' | 'client-half-failed'
    /** 失败的激活；激活前被拒绝时缺省。 */
    pluginRunId?: CordisDynamicPluginRunId
    /** 本页面是创建了该失败激活、还是仅是附加到它之上。 */
    startedHere?: boolean
    message?: string
    stack?: string
  }

/** 一次 Client 激活裁定是否抵达了仍处于待定状态的请求。 */
export interface DynamicCordisResolveAck {
  /** 对迟到、未知或过期的应答为假。 */
  accepted: boolean
}

/** 将一次 Client 调用路由到活跃的 Host 半区的结果。 */
export type DynamicCordisInvokeResult =
  | { ok: true; value: JsonValue }
  | ({ ok: false; code: 'plugin-not-running' | 'stale-run' | 'method-not-found' | 'handler-error' } & CordisErrorDetails)

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * 一个带 Client 的激活需要一个浏览器页面，并可能需要一次用户决策。
     * @param request - 关联标识、所有者、目标版本、模式与审批要求。
     * @mode emit
     */
    'cordis/request-run'(request: DynamicCordisRunRequest): void
    /**
     * 一个待定的 Client 激活请求离开了可回答状态。
     * @param resolved - 请求标识与结果。
     * @mode emit
     */
    'cordis/request-run-resolved'(resolved: DynamicCordisRequestResolved): void
    /**
     * 某一次确切的 Plugin/Package 激活现已在 Host 中活跃。
     * @param pkg - 稳定的插件、不可变的包、运行标识与标签。
     * @mode emit
     */
    'cordis/dynamic-package'(pkg: DynamicCordisPackage): void
    /**
     * 某一次确切的激活已被撤回。
     * @param retracted - 插件、包与运行标识。
     * @mode emit
     */
    'cordis/dynamic-retract'(retracted: DynamicCordisRetracted): void
    /**
     * 从 Client inspect 注册表请求一次活跃的只读查询。
     * @param request - 关联、Session、提供方、方法，以及 JSON 输入。
     * @mode emit
     */
    'cordis/inspect-query'(request: CordisInspectQueryRequest): void
    /**
     * 通知每个 Client 某个 inspect 查询已了结或已被取消。
     * @param resolved - 不再可回答的确切查询标识。
     * @mode emit
     */
    'cordis/inspect-query-resolved'(resolved: CordisInspectQueryResolved): void
  }
}
