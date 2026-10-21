/**
 * 动态包运行器，浏览器半区：将某个浏览器半区的源码转化为
 * 一个活动 cordis 插件的加载引擎（闭包 → 守卫 → 模块表 →
 * loader 条目，见 ./runtime.ts），外加将其卸载的收回广播。
 *
 * 激活时不会加载任何东西：在分派到达之前，本页面不持有任何
 * 动态包，而分派只跟随模型的 `cordis_run` 或用户按下卡片的
 * 启动控件而来。因此刷新会按设计从干净状态开始 —— host
 * 进程内存仍持有该定义，页面只是不运行它，直到再次被请求。
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  ApprovalRequestId, CordisDynamicPluginId, DynamicCordisInvokeResult,
  DynamicCordisInventoryRow,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { ClientModuleSystem } from '@deepseek-ai/dsh-client-modules/client'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
// Client Remote 装配是两平面相遇的唯一之处：它挂载
// `dynamicCordisRunner` 命名空间并再导出其负载词表，因此本包
// 能够命名它所发送的内容，而无需导入某个 Host 包。
import type { DynamicCordisLivePackage } from './runtime.ts'
import { DynamicCordisPackageRunner } from './runtime.ts'
import { CordisRunOrchestrator } from './orchestrator.ts'
import { ClientCordisInspectRegistry, provideClientCordisInspect } from './inspect-registry.ts'
import { clientInspectProviders } from './providers.ts'
import { provideClientTimer } from './timer.ts'
import type { CordisRunActivity, CordisRunFailure, CordisUserRunRequest } from './orchestrator.ts'
import type { CordisObservable, DynamicCordisRenderFailure } from './runtime.ts'

export { CordisRunOrchestrator } from './orchestrator.ts'
export { ClientCordisInspectRegistry } from './inspect-registry.ts'
export type {
  ClientCordisInspectHost, ClientCordisInspectProviderRegistration, ClientCordisInspectQueryContext,
} from './inspect-registry.ts'
export type {
  CordisRunActivity, CordisRunFailure, CordisRunHostSeam,
  CordisRunOrchestratorEnv, CordisRunRequest, CordisUserRunRequest,
} from './orchestrator.ts'
export { DynamicCordisPackageRunner } from './runtime.ts'
export type {
  CordisObservable, DynamicCordisClientHalf, DynamicCordisLivePackage, DynamicCordisLoadErrorCause,
  DynamicCordisLoadResult, DynamicCordisRenderFailure, DynamicCordisRunnerEnv,
} from './runtime.ts'

export { DynamicCordisStyles, evaluateClientHalf, isDynamicCordisPlugin } from './evaluator.ts'
export type { DynamicCordisClosureEnv, DynamicCordisEvaluatedPlugin } from './evaluator.ts'
export { dynamicCordisContext } from './guard.ts'
export type { DynamicCordisGuardEnv, DynamicCordisSlotLedgerRow } from './guard.ts'
export { ClientTimerService } from './timer.ts'
// 再导出，以便服务面与两个事件的消费者能够命名
// 各自的主体，而无需亲自触及连线契约。
export type {
  ApprovalRequestId, CordisDynamicPackageId, CordisDynamicPluginId, CordisDynamicPluginRunId,
  DynamicCordisPackage,
} from '@deepseek-ai/dsh-api-remotes/client'


/**
 * 运行界面所读取与调用的内容。活动映射是
 * "一次运行正在进行中"的唯一出处，因此某个操作点从不
 * 保留自己的副本 —— 这正是它能挺过一次重挂载的原因。
 */
export interface CordisRunnerFace {
  /** 每个定义的进行中运行活动。 */
  readonly activeRuns: CordisObservable<ReadonlyMap<CordisDynamicPluginId, CordisRunActivity>>
  /** 本页面自身运行尝试的、按定义计的上次失败。 */
  readonly lastRunError: CordisObservable<ReadonlyMap<CordisDynamicPluginId, CordisRunFailure>>
  /**
   * 本页面按定义计的上次渲染崩溃：一个干净加载、随后在 React
   * 渲染它时崩溃的浏览器半区。按构造它是页面局部且最新的 ——
   * 在包停止、被收回或再次加载时清空 —— 正因如此，
   * 让一行直接渲染才是安全的。Host 为模型保留其自身的
   * 跨页面上次副本；两者拥有不同的归属与生命周期，
   * 且互不派生。
   */
  readonly renderFailures: CordisObservable<ReadonlyMap<CordisDynamicPluginId, DynamicCordisRenderFailure>>
  /**
   * 在页面重连或漏掉事件之后，恢复待定的审批。
   * @param rows - 当前的动态 Plugin 清单。
   */
  reconcileApprovals(rows: readonly DynamicCordisInventoryRow[]): void
  /**
   * 以"运行它"应答一次运行请求，并驱动两个半区。
   * @param requestId - 正在被应答的请求；未知或已结算的 id 为无操作。
   * @param approveFutureVersions - 本决定是否覆盖同一 Plugin 后续的 Package。
   * @returns 在编排结算之后。
   */
  approve(requestId: ApprovalRequestId, approveFutureVersions: boolean): Promise<void>
  /**
   * 以"不要运行它"应答一次运行请求。
   * @param requestId - 正在被应答的请求；未知或已结算的 id 为无操作。
   * @returns 在拒绝抵达 host 之后。
   */
  decline(requestId: ApprovalRequestId): Promise<void>
  /**
   * 在用户自身请求下于此运行一个定义（该手势即授权）。
   * 带浏览器半区的定义也会加载到本页面；仅 host 的
   * 定义只在 host 进程中启动。
   * @param request - 待运行的定义、其会话，以及它是否带有浏览器半区。
   * @returns 在编排结算之后。
   */
  startUserRun(request: CordisUserRunRequest): Promise<void>
  /**
   * 观察本页面已加载的内容。
   * @param fn - 每次收敛的加载或卸载之后被通知。
   * @returns 取消订阅函数。
   */
  subscribe(fn: () => void): () => void
  /**
   * 读取本页面当前已加载的内容。
   * @returns 活动 Client 半区的不可变行。
   */
  getSnapshot(): readonly DynamicCordisLivePackage[]
  /**
   * 本页面是否加载了某个定义的浏览器半区 —— 页面局部的真相，
   * 而非 host 的"它正在运行"。
   * @param pluginId - 稳定的 Plugin 身份。
   * @returns 此处加载活动期间为 true。
   */
  isLoaded(pluginId: CordisDynamicPluginId): boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 运行编排与页面局部加载状态：运行界面所读取与调用的内容。 */
    dynamicCordisRunner: CordisRunnerFace
  }
}

/** 针对基础设施自身报告的路由失败的、教学性文本。 */
function invokeFailure(pluginId: CordisDynamicPluginId, method: string, result: Extract<DynamicCordisInvokeResult, { ok: false }>): string {
  const where = `host.call("${method}") on ${pluginId}`
  if (result.code === 'plugin-not-running') {
    return `${where} found no active Host half — the Plugin is stopped or was removed.`
  }
  if (result.code === 'stale-run') {
    return `${where} belongs to an activation that has already been replaced.`
  }
  if (result.code === 'method-not-found') {
    return `${where} is not registered: the host half must declare it with harness.handle("${method}", fn).`
  }
  return `${where} failed inside the host handler: ${result.message}`
}

/** 在追加 Client 调用点诊断的同时，保留 Host 处理器的栈。 */
function invokeError(
  pluginId: CordisDynamicPluginId,
  method: string,
  result: Extract<DynamicCordisInvokeResult, { ok: false }>,
): Error {
  const error = new Error(invokeFailure(pluginId, method, result))
  if (result.stack !== undefined) error.stack = `${error.stack ?? error.message}\nHost stack:\n${result.stack}`
  return error
}

/**
 * 针对连线本身拒绝的 `host.call` 的教学性文本：生成的编解码器
 * 在发送前拒绝了参数，或在回程中拒绝了结果，或传输中断。基础设施的
 * 消息只点名它拒绝的字段，而非它所属的调用，而两个半区都由
 * 模型编写 —— 因此这里补上调用及其必须满足的契约。
 */
function wireFailure(id: CordisDynamicPluginId, method: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return `host.call("${method}") on ${id} did not complete: ${message}\n`
    + 'Both directions carry JSON only: pass plain JSON data as the argument — or omit it, and the handler receives '
    + `null — and answer from harness.handle("${method}", fn) with JSON (\`return null\` when there is nothing to report).`
}

/** 稳定的 Cordis 插件名。 */
export const name = 'cordis-client-runner'

/**
 * 所需服务：用于条目的 loader/模块链、用于贡献的槽位注册表，
 * 以及 `dynamicCordisRunner` Remote 命名空间。声明该
 * 命名空间会将本插件挂起，直到 host 侧存在，从而一个页面
 * 永远不会加载其 host 半区无法触达的浏览器半区。
 */
export const inject = ['loader', 'modules', 'slots', 'remote', 'remote.dynamicCordisRunner']

/**
 * Client 插件主体：构建运行器并订阅分派族。
 * @param ctx - client 根上下文。
 */
export function apply(ctx: Context): void {
  provideClientTimer(ctx)
  const inspect = new ClientCordisInspectRegistry({
    sync: async (providers) => {
      const answered = await ctx.remote.dynamicCordisRunner.syncInspectManifest(providers)
      if (!answered.ok) throw new Error(`${answered.error.code}: ${answered.error.message}`)
    },
    resolve: async (agentId, requestId, resolution) => {
      const answered = await ctx.remote.dynamicCordisRunner.resolveInspectQuery(agentId, requestId, resolution)
      if (!answered.ok) throw new Error(`${answered.error.code}: ${answered.error.message}`)
    },
  })
  provideClientCordisInspect(ctx, inspect)
  for (const provider of clientInspectProviders(ctx)) {
    ctx.effect(() => inspect.register(provider), `cordis-client-runner: inspect ${provider.manifest.id}`)
  }
  ctx.on('connection/reset', () => { inspect.publish() })

  const runner = new DynamicCordisPackageRunner({
    ctx,
    loader: ctx.loader,
    modules: ctx.get('modules') as ClientModuleSystem,
    slots: ctx.get('slots') as SlotRegistry,
    invoke: async (pluginId, pluginRunId, method, args) => {
      // 模型编写的参数以无类型形式抵达此边界；命名空间
      // 生成的编解码器负责将它们校验为 JSON，其拒绝只给出
      // 一个裸字段名 —— 这是唯一仍知道它属于哪次调用的地方，
      // 因此教学性内容必须加在这里。
      const answered = await ctx.remote.dynamicCordisRunner.invoke(pluginId, pluginRunId, method, args as JsonValue)
        .catch((error: unknown) => { throw new Error(wireFailure(pluginId, method, error)) })
      // 两层失败，教学的内容各不相同：载体错误分支意味着
      // 调用从未抵达 host 半区，而命名空间自身的 `ok: false`
      // 是那个半区以拒绝作答。
      if (!answered.ok) throw new Error(wireFailure(pluginId, method, `${answered.error.code}: ${answered.error.message}`))
      const result = answered.value
      if (result.ok) return result.value
      throw invokeError(pluginId, method, result)
    },
    // 结算后诊断，故意采取发后不理：本包所属的运行在
    // 它渲染之前就已得到应答，因此没有任何东西等待它，
    // 而一次失败的报告绝不能把一次崩溃变成两次。
    reportRenderFailure: (agentId, pluginId, pluginRunId, failure) => {
      void ctx.remote.dynamicCordisRunner.reportRenderFailure(agentId, pluginId, pluginRunId, failure).then((result) => {
        if (!result.ok) {
          console.error(`[cordis-client-runner] reporting a render failure of ${pluginId} failed:`, result.error)
        }
      }, (error: unknown) => {
        console.error(`[cordis-client-runner] reporting a render failure of ${pluginId} failed:`, error)
      })
    },
    reportGuardFailure: (agentId, pluginId, pluginRunId, failure) => {
      void ctx.remote.dynamicCordisRunner.reportClientGuardFailure(agentId, pluginId, pluginRunId, failure).then((result) => {
        if (!result.ok) {
          console.error(`[cordis-client-runner] reporting a guard failure of ${pluginId} failed:`, result.error)
        }
      }, (error: unknown) => {
        console.error(`[cordis-client-runner] reporting a guard failure of ${pluginId} failed:`, error)
      })
    },
  })
  const orchestrator = new CordisRunOrchestrator({
    runner,
    host: {
      // 该接缝只命名业务负载，因此载体失败在此被折叠进
      // 每个动词已有的处理之中：对 start 是短路消息，
      // 在调用方自有 catch 之处则是抛出。
      runHostHalf: async (agentId, pluginId, packageId, mode, requestId, approveFutureVersions) => {
        const answered = await ctx.remote.dynamicCordisRunner.runHostHalf(
          agentId, pluginId, packageId, mode, requestId, approveFutureVersions,
        )
        return answered.ok ? answered.value : { ok: false, message: `${answered.error.code}: ${answered.error.message}` }
      },
      getClientCode: async (agentId, pluginId, pluginRunId) => {
        const answered = await ctx.remote.dynamicCordisRunner.getClientCode(agentId, pluginId, pluginRunId)
        if (!answered.ok) throw new Error(`${answered.error.code}: ${answered.error.message}`)
        return answered.value
      },
      resolveRequestRun: async (requestId, resolution) => {
        const answered = await ctx.remote.dynamicCordisRunner.resolveRequestRun(requestId, resolution)
        // 抛出而非返回：`answer` 会记录并丢弃一次失败的应答，
        // 而 host 无论如何都会自行结算该请求。
        if (!answered.ok) throw new Error(`${answered.error.code}: ${answered.error.message}`)
        return answered.value
      },
      settleUserRun: async (agentId, pluginId, resolution) => {
        const answered = await ctx.remote.dynamicCordisRunner.settleUserRun(agentId, pluginId, resolution)
        if (!answered.ok) throw new Error(`${answered.error.code}: ${answered.error.message}`)
        return answered.value
      },
    },
  })
  const face: CordisRunnerFace = {
    activeRuns: orchestrator.activeRuns,
    lastRunError: orchestrator.lastRunError,
    renderFailures: runner.renderFailures,
    reconcileApprovals: (rows) => { orchestrator.reconcileApprovals(rows) },
    approve: (requestId, approveFutureVersions) => orchestrator.approve(requestId, approveFutureVersions),
    decline: requestId => orchestrator.decline(requestId),
    startUserRun: request => orchestrator.startUserRun(request),
    subscribe: fn => runner.subscribe(fn),
    getSnapshot: () => runner.getSnapshot(),
    isLoaded: id => runner.isLoaded(id),
  }
  ctx.provide('dynamicCordisRunner', face)
  ctx.effect(() => () => { void runner.dispose() }, 'cordis-client-runner: dynamic package runner')

  // 转发的 Host 事件：`$on` 把 Host 自身的参数列表交给监听器，
  // 因此这些读取的是请求本身，而非传输信封。
  ctx.remote.$on('cordis/request-run', (request) => {
    orchestrator.open(request)
  })
  ctx.remote.$on('cordis/request-run-resolved', (resolved) => { orchestrator.close(resolved.requestId) })
  ctx.remote.$on('cordis/dynamic-retract', (retracted) => {
    runner.retract(retracted.pluginId, retracted.pluginRunId)
  })
  ctx.remote.$on('cordis/inspect-query', (request) => {
    void inspect.query(request).catch((error: unknown) => {
      console.error(`[cordis-client-runner] inspect query ${request.provider}.${request.method} failed:`, error)
    })
  })
  ctx.remote.$on('cordis/inspect-query-resolved', (resolved) => { inspect.close(resolved.requestId) })
}
