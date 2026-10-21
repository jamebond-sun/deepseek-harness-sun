/**
 * 面向模型审批与直接面板手势的页面侧运行编排。
 * Host 激活总是先于 Client 加载。同一份按 Plugin 键控的
 * 状态驱动每一个界面，因此重挂载一个面板绝不会丢失一个
 * 打开的审批或进行中的转换。
 */

import type {
  ApprovalRequestId,
  CordisDynamicPackageId,
  CordisDynamicPluginId,
  CordisDynamicPluginRunId,
  CordisDynamicRunMode,
  DynamicCordisClientSource,
  DynamicCordisHostHalfResult,
  DynamicCordisInventoryRow,
  DynamicCordisResolveAck,
  DynamicCordisRunResolution,
  DynamicCordisRunResponse,
  SessionId,
} from '@deepseek-ai/dsh-api-remotes/client'
import { errorDetails } from './runtime.ts'
import type { CordisErrorDetails, CordisObservable, DynamicCordisPackageRunner } from './runtime.ts'

/** 一个 Plugin 的进行中审批或激活。 */
export type CordisRunActivity =
  | {
    phase: 'awaiting-approval'
    requestId: ApprovalRequestId
    agentId: SessionId
    packageId: CordisDynamicPackageId
    mode: CordisDynamicRunMode
    name: string
    purpose: string
  }
  | {
    phase: 'orchestrating'
    agentId: SessionId
    packageId: CordisDynamicPackageId
    mode: CordisDynamicRunMode
  }

/** 本页面最近一次激活尝试失败的原因。 */
export interface CordisRunFailure {
  /** 尝试所针对的包。 */
  packageId: CordisDynamicPackageId
  /** 失败的半区或结算阶段。 */
  reason: 'host-half-failed' | 'client-half-failed'
  /** 可操作的失败文本。 */
  message: string
  /** 可用时的原始失败栈。 */
  stack?: string
}

/** 经传输折叠后、由编排消费的 Host 操作。 */
export interface CordisRunHostSeam {
  /** 启动一次新的 Host 激活，或将本页面挂接到一个已有的激活上。 */
  runHostHalf(
    agentId: SessionId,
    pluginId: CordisDynamicPluginId,
    packageId: CordisDynamicPackageId,
    mode: CordisDynamicRunMode,
    requestId: ApprovalRequestId | null,
    approveFutureVersions: boolean,
  ): Promise<DynamicCordisHostHalfResult>
  /** 为一次精确的进行中运行获取 Client 源码。 */
  getClientCode(
    agentId: SessionId,
    pluginId: CordisDynamicPluginId,
    pluginRunId: CordisDynamicPluginRunId,
  ): Promise<DynamicCordisClientSource>
  /** 结算一次模型驱动的审批。 */
  resolveRequestRun(
    requestId: ApprovalRequestId,
    resolution: DynamicCordisRunResolution,
  ): Promise<DynamicCordisResolveAck>
  /** 在本页面处理其 Client 半区之后，结算一次直接的面板激活。 */
  settleUserRun(
    agentId: SessionId,
    pluginId: CordisDynamicPluginId,
    resolution: DynamicCordisRunResolution,
  ): Promise<DynamicCordisRunResponse>
}

/** 一个页面编排器的依赖。 */
export interface CordisRunOrchestratorEnv {
  /** 页面局部的 Client 加载器。 */
  runner: DynamicCordisPackageRunner
  /** 折叠后的 Host RPC 操作。 */
  host: CordisRunHostSeam
}

/** 本页面使用的、被转发的审批请求字段。 */
export interface CordisRunRequest {
  requestId: ApprovalRequestId
  agentId: SessionId
  pluginId: CordisDynamicPluginId
  packageId: CordisDynamicPackageId
  mode: CordisDynamicRunMode
  name: string
  purpose: string
  requiresApproval: boolean
}

/** 直接的面板激活请求。 */
export interface CordisUserRunRequest {
  agentId: SessionId
  pluginId: CordisDynamicPluginId
  packageId: CordisDynamicPackageId
  mode: CordisDynamicRunMode
  /** 仅 host 的 Package 在没有 Client 加载或结算调用的情况下结束。 */
  hasClientHalf: boolean
}

interface RunPlan extends CordisUserRunRequest {
  requestId?: ApprovalRequestId
  approveFutureVersions?: boolean
}

/** 驱动 Host → Client 激活，并发布按 Plugin 键控的活动。 */
export class CordisRunOrchestrator {
  private readonly requests = new Map<ApprovalRequestId, CordisRunRequest>()
  private readonly activity = new Map<CordisDynamicPluginId, CordisRunActivity>()
  private readonly failures = new Map<CordisDynamicPluginId, CordisRunFailure>()
  private readonly inFlight = new Map<CordisDynamicPluginId, Promise<void>>()
  private readonly listeners = new Set<() => void>()
  private activityCache: ReadonlyMap<CordisDynamicPluginId, CordisRunActivity> | undefined
  private failureCache: ReadonlyMap<CordisDynamicPluginId, CordisRunFailure> | undefined

  /** @param env - Client 加载器与折叠后的 Host 操作。 */
  constructor(private readonly env: CordisRunOrchestratorEnv) {}

  /** 打开的审批与当前激活尝试，按稳定的 Plugin ID 键控。 */
  readonly activeRuns: CordisObservable<ReadonlyMap<CordisDynamicPluginId, CordisRunActivity>> = {
    getSnapshot: () => this.activityCache ??= new Map(this.activity),
    subscribe: fn => this.observe(fn),
  }

  /** 每个 Plugin 最近的页面侧激活失败。 */
  readonly lastRunError: CordisObservable<ReadonlyMap<CordisDynamicPluginId, CordisRunFailure>> = {
    getSnapshot: () => this.failureCache ??= new Map(this.failures),
    subscribe: fn => this.observe(fn),
  }

  /**
   * 注册一次 Client 激活请求，当 Plugin 已被授权时立即启动它。
   * @param request - 被转发的审批与激活元数据。
   */
  open(request: CordisRunRequest): void {
    this.requests.set(request.requestId, request)
    if (!request.requiresApproval) {
      void this.orchestrate({
        agentId: request.agentId,
        pluginId: request.pluginId,
        packageId: request.packageId,
        mode: request.mode,
        requestId: request.requestId,
        hasClientHalf: true,
      }).catch((error: unknown) => {
        console.error(`[cordis-client-runner] automatic activation ${request.requestId} failed:`, error)
      })
      return
    }
    if (this.activity.get(request.pluginId)?.phase !== 'orchestrating') {
      this.activity.set(request.pluginId, {
        phase: 'awaiting-approval',
        requestId: request.requestId,
        agentId: request.agentId,
        packageId: request.packageId,
        mode: request.mode,
        name: request.name,
        purpose: request.purpose,
      })
    }
    this.commit()
  }

  /**
   * 从权威的 Host 清单读取重建待定审批与自动 Client 激活。
   * @param rows - 完整的进程级 Plugin 清单。
   */
  reconcileApprovals(rows: readonly DynamicCordisInventoryRow[]): void {
    const expected = new Map<ApprovalRequestId, CordisRunRequest>()
    for (const row of rows) {
      const attempt = row.latestRun
      if (attempt?.approvalRequestId === undefined
        || (attempt.status !== 'awaiting-approval'
          && attempt.status !== 'starting-host'
          && attempt.status !== 'client-pending')) continue
      const pkg = row.packages.find(candidate => candidate.packageId === attempt.packageId)
      if (pkg === undefined) continue
      expected.set(attempt.approvalRequestId, {
        requestId: attempt.approvalRequestId,
        agentId: row.agentId,
        pluginId: row.pluginId,
        packageId: attempt.packageId,
        mode: attempt.mode,
        name: pkg.name,
        purpose: pkg.purpose,
        requiresApproval: attempt.requiresApproval ?? attempt.status === 'awaiting-approval',
      })
    }

    let changed = false
    for (const [requestId, request] of [...this.requests]) {
      if (expected.has(requestId)) continue
      this.requests.delete(requestId)
      const current = this.activity.get(request.pluginId)
      if (current?.phase === 'awaiting-approval' && current.requestId === requestId) {
        this.activity.delete(request.pluginId)
      }
      changed = true
    }
    for (const [requestId, request] of expected) {
      const previous = this.requests.get(requestId)
      const current = this.activity.get(request.pluginId)
      if (!request.requiresApproval && current?.phase === 'orchestrating') continue
      if (request.requiresApproval
        && sameRequest(previous, request)
        && current?.phase === 'awaiting-approval'
        && current.requestId === requestId) continue
      if (!request.requiresApproval) {
        this.open(request)
        changed = true
        continue
      }
      this.requests.set(requestId, request)
      if (current?.phase !== 'orchestrating') {
        this.activity.set(request.pluginId, {
          phase: 'awaiting-approval',
          requestId,
          agentId: request.agentId,
          packageId: request.packageId,
          mode: request.mode,
          name: request.name,
          purpose: request.purpose,
        })
      }
      changed = true
    }
    if (changed) this.commit()
  }

  /**
   * 关闭一个由另一页面或取消结算的审批。
   * @param requestId - 此处不再可应答的审批请求。
   */
  close(requestId: ApprovalRequestId): void {
    const request = this.requests.get(requestId)
    if (request === undefined) return
    this.requests.delete(requestId)
    const current = this.activity.get(request.pluginId)
    if (current?.phase === 'awaiting-approval' && current.requestId === requestId) {
      this.activity.delete(request.pluginId)
    }
    this.commit()
  }

  /**
   * 审批并执行一个仍打开的模型请求。
   * @param requestId - 待执行的审批请求。
   * @param approveFutureVersions - 本审批是否覆盖同一 Plugin 后续的 Package。
   */
  approve(requestId: ApprovalRequestId, approveFutureVersions: boolean): Promise<void> {
    const request = this.requests.get(requestId)
    if (request === undefined || !request.requiresApproval) return Promise.resolve()
    return this.orchestrate({
      agentId: request.agentId,
      pluginId: request.pluginId,
      packageId: request.packageId,
      mode: request.mode,
      requestId,
      approveFutureVersions,
      hasClientHalf: true,
    })
  }

  /**
   * 在不执行任一半区的情况下，拒绝一个仍打开的模型请求。
   * @param requestId - 待拒绝的审批请求。
   */
  async decline(requestId: ApprovalRequestId): Promise<void> {
    const request = this.requests.get(requestId)
    if (request === undefined || !request.requiresApproval) return
    const current = this.activity.get(request.pluginId)
    if (current?.phase !== 'awaiting-approval' || current.requestId !== requestId) return
    this.requests.delete(requestId)
    this.activity.delete(request.pluginId)
    this.commit()
    await this.answer(requestId, { ok: false, reason: 'rejected' })
  }

  /**
   * 执行一次直接的面板运行；用户手势本身即授权它。
   * @param request - 用户选定的精确 Package 激活。
   */
  startUserRun(request: CordisUserRunRequest): Promise<void> {
    return this.orchestrate(request)
  }

  private observe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  private commit(): void {
    this.activityCache = undefined
    this.failureCache = undefined
    for (const fn of [...this.listeners]) fn()
  }

  private orchestrate(plan: RunPlan): Promise<void> {
    const running = this.inFlight.get(plan.pluginId)
    if (running !== undefined) return running
    this.activity.set(plan.pluginId, {
      phase: 'orchestrating',
      agentId: plan.agentId,
      packageId: plan.packageId,
      mode: plan.mode,
    })
    this.failures.delete(plan.pluginId)
    if (plan.requestId !== undefined) this.requests.delete(plan.requestId)
    this.commit()
    const attempt = this.drive(plan).finally(() => {
      this.inFlight.delete(plan.pluginId)
      this.activity.delete(plan.pluginId)
      this.commit()
    })
    this.inFlight.set(plan.pluginId, attempt)
    return attempt
  }

  private async drive(plan: RunPlan): Promise<void> {
    const started = await this.startHost(plan)
    if (!started.ok) {
      this.fail(plan, 'host-half-failed', started)
      if (plan.requestId !== undefined) {
        await this.answer(plan.requestId, { ...started, reason: 'host-half-failed' })
      }
      return
    }
    if (!plan.hasClientHalf) return

    let source: DynamicCordisClientSource
    try {
      source = await this.env.host.getClientCode(plan.agentId, plan.pluginId, started.pluginRunId)
    } catch (error) {
      await this.finishClientFailure(plan, started.pluginRunId, started.startedHere, errorDetails(error), error)
      return
    }
    const loaded = await this.env.runner.load({
      pluginId: source.pluginId,
      packageId: source.packageId,
      pluginRunId: source.pluginRunId,
      agentId: plan.agentId,
      name: source.name,
      code: source.code,
    }).catch((error: unknown) => ({ ok: false, cause: 'evaluate', ...errorDetails(error), error }) as const)
    if (!loaded.ok) {
      await this.finishClientFailure(
        plan,
        started.pluginRunId,
        started.startedHere,
        {
          message: `${loaded.cause}: ${loaded.message}`,
          ...loaded.stack === undefined ? {} : { stack: loaded.stack },
        },
        loaded.error,
      )
      return
    }
    const resolution: DynamicCordisRunResolution = {
      ok: true,
      pluginRunId: loaded.pluginRunId,
      ...loaded.waitingFor === undefined ? {} : { waitingFor: loaded.waitingFor },
    }
    if (plan.requestId !== undefined) {
      await this.answer(plan.requestId, resolution)
      return
    }
    await this.settleDirect(plan, resolution)
  }

  private async startHost(plan: RunPlan): Promise<DynamicCordisHostHalfResult> {
    try {
      return await this.env.host.runHostHalf(
        plan.agentId,
        plan.pluginId,
        plan.packageId,
        plan.mode,
        plan.requestId ?? null,
        plan.approveFutureVersions ?? false,
      )
    } catch (error) {
      return { ok: false, ...errorDetails(error) }
    }
  }

  private async finishClientFailure(
    plan: RunPlan,
    pluginRunId: CordisDynamicPluginRunId,
    startedHere: boolean,
    failure: CordisErrorDetails,
    originalError?: unknown,
  ): Promise<void> {
    console.error(
      `[cordis-client-runner] Client activation ${plan.pluginId}/${plan.packageId} (${pluginRunId}) failed:`,
      originalError ?? failure,
    )
    this.fail(plan, 'client-half-failed', failure)
    const resolution: DynamicCordisRunResolution = {
      ok: false,
      reason: 'client-half-failed',
      pluginRunId,
      startedHere,
      ...failure,
    }
    if (plan.requestId !== undefined) await this.answer(plan.requestId, resolution)
    else await this.settleDirect(plan, resolution)
  }

  private async settleDirect(plan: RunPlan, resolution: DynamicCordisRunResolution): Promise<void> {
    try {
      const response = await this.env.host.settleUserRun(plan.agentId, plan.pluginId, resolution)
      if (!response.ok) this.fail(plan, 'client-half-failed', response)
    } catch (error) {
      this.fail(plan, 'client-half-failed', errorDetails(error))
    }
  }

  private async answer(requestId: ApprovalRequestId, resolution: DynamicCordisRunResolution): Promise<void> {
    try {
      await this.env.host.resolveRequestRun(requestId, resolution)
    } catch (error) {
      console.error(`[cordis-client-runner] answering run request ${requestId} failed:`, error)
    }
  }

  private fail(
    plan: Pick<RunPlan, 'pluginId' | 'packageId'>,
    reason: CordisRunFailure['reason'],
    failure: CordisErrorDetails,
  ): void {
    this.failures.set(plan.pluginId, { packageId: plan.packageId, reason, ...failure })
    this.commit()
  }
}

function sameRequest(left: CordisRunRequest | undefined, right: CordisRunRequest): boolean {
  return left?.requestId === right.requestId
    && left.agentId === right.agentId
    && left.pluginId === right.pluginId
    && left.packageId === right.packageId
    && left.mode === right.mode
    && left.name === right.name
    && left.purpose === right.purpose
    && left.requiresApproval === right.requiresApproval
}
