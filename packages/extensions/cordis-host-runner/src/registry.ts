/**
 * 进程本地的动态 Plugin 注册表及其不透明标识铸造器。
 * @module @deepseek-ai/dsh-cordis-host-runner/registry
 */

import type { Fiber } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  ApprovalRequestId, CordisDynamicPackageId, CordisDynamicPluginId, CordisDynamicPluginRunId,
  CordisDynamicRunMode, DynamicCordisRenderFailure, DynamicCordisRunAttempt,
} from './types.ts'

/** 暴露给本包 Client 半区的一个 Host 方法。 */
export type DynamicCordisHandler = (args: unknown) => Promise<unknown>

/** 一次活跃的激活，以及其拆除所拥有的一切。 */
export interface DynamicCordisRun {
  /** 确切的激活标识。 */
  pluginRunId: CordisDynamicPluginRunId
  /** 正被运行的不可变包版本。 */
  packageId: CordisDynamicPackageId
  /** 宿主半区 Fiber；纯 Client 包缺省。 */
  fiber?: Fiber
  /** 活跃的 Host 方法。 */
  handlers: Map<string, DynamicCordisHandler>
  /** 方法注册的清理。 */
  handlerDisposers: (() => void)[]
  /** 本次激活期间已发送给所属 Agent 的运行时失败。 */
  reportedRuntimeErrors: Set<string>
  /** 本版本的当前运行所观察到的、最近一次渲染失败。 */
  renderFailure?: DynamicCordisRenderFailure
  /** 当由模型驱动时，启动了本运行的那次审批。 */
  startedForRequest?: ApprovalRequestId
}

/** 一个不可变的包版本。 */
export interface DynamicCordisDefinition {
  /** 包标识。 */
  packageId: CordisDynamicPackageId
  /** 包标签。 */
  name: string
  /** 面向用户的用途。 */
  purpose: string
  /** Host 源码。 */
  hostCode?: string
  /** Client 源码。 */
  clientCode?: string
}

/** 容纳不可变包版本的、稳定的插件实例。 */
export interface DynamicCordisPlugin {
  /** 稳定的标识。 */
  pluginId: CordisDynamicPluginId
  /** 所属的会话。 */
  sessionId: SessionId
  /** 按 define 顺序的版本。 */
  packages: Map<CordisDynamicPackageId, DynamicCordisDefinition>
  /** 由用户逐一授权的、带 Client 的包。 */
  approvedClientPackages: Set<CordisDynamicPackageId>
  /** 一次用户决策是否授权了本 Plugin 未来的包版本。 */
  clientVersionUpdatesApproved: boolean
  /** 最近一次成功激活的版本。 */
  currentPackageId?: CordisDynamicPackageId
  /** 失败的或进行中的目标版本。 */
  nextPackageId?: CordisDynamicPackageId
  /** 当前激活。 */
  run?: DynamicCordisRun
  /** 最近一次激活尝试，包含审批与异步失败状态。 */
  latestRun?: DynamicCordisRunAttempt
}

/** 一个被挂起的、由模型驱动的激活。 */
export interface DynamicCordisPendingRequest {
  /** 其模型请求了本次激活的会话。 */
  agentId: SessionId
  pluginId: CordisDynamicPluginId
  packageId: CordisDynamicPackageId
  pluginRunId: CordisDynamicPluginRunId
  mode: CordisDynamicRunMode
  /** 本请求是否必须等待一次显式的用户决策。 */
  requiresApproval: boolean
}

/** 由 `define` 接受的请求；它从不跨越 Remote 传输。 */
export interface DynamicCordisDefineRequest {
  /** 拥有该插件的会话。 */
  sessionId: SessionId
  /** 创建一个插件，或附加到一个已有的插件。 */
  plugin:
    | { kind: 'new'; idPrefix: string }
    | { kind: 'existing'; pluginId: CordisDynamicPluginId }
  /** 包标签。 */
  name: string
  /** 面向用户的用途。 */
  purpose: string
  /** 至少一个源半区。 */
  code: { host?: string; client?: string }
}

/** 成功的 `define` 结果。 */
export interface DynamicCordisDefineReceipt {
  pluginId: CordisDynamicPluginId
  packageId: CordisDynamicPackageId
  name: string
  purpose: string
  hasHostHalf: boolean
  hasClientHalf: boolean
}

/** 用于显式 `@pluginId` 引用的、无源修改上下文。 */
export interface DynamicCordisReference {
  pluginId: CordisDynamicPluginId
  packageId: CordisDynamicPackageId
  name: string
  purpose: string
  currentPackageId?: CordisDynamicPackageId
  nextPackageId?: CordisDynamicPackageId
  activeRun?: { pluginRunId: CordisDynamicPluginRunId; packageId: CordisDynamicPackageId }
  latestRun?: DynamicCordisRunAttempt
}

/** 由分层自检返回的、无源的 Plugin 摘要。 */
export interface DynamicCordisPluginInspection extends DynamicCordisReference {
  /** 按 define 顺序的不可变包摘要。 */
  packages: Array<{
    packageId: CordisDynamicPackageId
    name: string
    purpose: string
    hasHostHalf: boolean
    hasClientHalf: boolean
  }>
}

/** 由显式检视返回的、确切的不可变包元数据与源码。 */
export interface DynamicCordisPackageInspection extends DynamicCordisReference {
  /** 为本包存储的 Host 与 Client 函数体。 */
  code: { host?: string; client?: string }
}

/** 注册表、标识铸造器，以及待定审批索引。 */
export class DynamicCordisRegistry {
  private readonly plugins = new Map<CordisDynamicPluginId, DynamicCordisPlugin>()
  private readonly pendingRequests = new Map<ApprovalRequestId, DynamicCordisPendingRequest>()
  private nextPlugin = 1
  private nextPackage = 1
  private nextRun = 1
  private nextApproval = 1

  /**
   * 铸造一个语义化的插件 ID，而不复用先前的后缀。
   * @param prefix - 模型提出的、已校验的小写语义前缀。
   * @returns 进程唯一的 Plugin ID。
   */
  mintPluginId(prefix: string): string {
    let id: CordisDynamicPluginId
    do id = `${prefix}-${this.nextPlugin++}` as CordisDynamicPluginId
    while (this.plugins.has(id))
    return id
  }

  /**
   * 铸造一个不可变的包 ID。
   * @returns 进程唯一的 Package ID。
   */
  mintPackageId(): string {
    return `pkg-${this.nextPackage++}`
  }

  /**
   * 铸造一个激活 ID。
   * @returns 进程唯一的 Plugin Run ID。
   */
  mintPluginRunId(): string {
    return `run-${this.nextRun++}`
  }

  /**
   * 铸造一个审批 ID。
   * @returns 进程唯一的审批请求 ID。 */
  mintApprovalRequestId(): string {
    return `approval-${this.nextApproval++}`
  }

  /**
   * 添加一个稳定的插件。
   * @param plugin - 在其稳定 ID 之下保留的 Plugin 记录。
   */
  add(plugin: DynamicCordisPlugin): void {
    this.plugins.set(plugin.pluginId, plugin)
  }

  /**
   * 读取一个插件。
   * @param id - 稳定的 Plugin ID。
   * @returns 该 Plugin 记录；缺省时为 `undefined`。
   */
  get(id: CordisDynamicPluginId): DynamicCordisPlugin | undefined {
    return this.plugins.get(id)
  }

  /**
   * 删除一个插件及其全部包版本。
   * @param id - 要移除的稳定 Plugin ID。
   * @returns 是否移除了一个 Plugin 记录。
   */
  delete(id: CordisDynamicPluginId): boolean {
    return this.plugins.delete(id)
  }

  /**
   * 按创建顺序读取全部插件。
   * @returns 每个 Plugin 记录的快照。
   */
  all(): DynamicCordisPlugin[] {
    return [...this.plugins.values()]
  }

  /**
   * 读取某个会话的插件，按创建顺序。
   * @param sessionId - 据以过滤的所属会话。
   * @returns 匹配的 Plugin 记录的快照。
   */
  ofSession(sessionId: SessionId): DynamicCordisPlugin[] {
    return this.all().filter(plugin => plugin.sessionId === sessionId)
  }

  /**
   * 发布一个待定的审批。
   * @param id - 审批请求 ID。
   * @param pending - 解析器与 Plugin 元数据，保留至结算。
   */
  armRequest(id: ApprovalRequestId, pending: DynamicCordisPendingRequest): void {
    this.pendingRequests.set(id, pending)
  }

  /**
   * 读取一个待定审批而不认领它。
   * @param id - 审批请求 ID。
   * @returns 该待定请求；缺省时为 `undefined`。
   */
  peekRequest(id: ApprovalRequestId): DynamicCordisPendingRequest | undefined {
    return this.pendingRequests.get(id)
  }

  /**
   * 认领一个待定审批；先到先得。
   * @param id - 审批请求 ID。
   * @returns 被认领的请求；已在结算时为 `undefined`。
   */
  claimRequest(id: ApprovalRequestId): DynamicCordisPendingRequest | undefined {
    const pending = this.pendingRequests.get(id)
    if (pending !== undefined) this.pendingRequests.delete(id)
    return pending
  }

  /**
   * 取消一个待定审批。
   * @param id - 要移除的审批请求 ID。
   */
  disarmRequest(id: ApprovalRequestId): void {
    this.pendingRequests.delete(id)
  }

  /**
   * 查找某个 Plugin 的待定审批。
   * @param pluginId - 稳定的 Plugin ID。
   * @returns 其审批请求 ID；无待定时为 `undefined`。
   */
  pendingRequestFor(pluginId: CordisDynamicPluginId): ApprovalRequestId | undefined {
    for (const [requestId, request] of this.pendingRequests) {
      if (request.pluginId === pluginId) return requestId
    }
    return undefined
  }
}
