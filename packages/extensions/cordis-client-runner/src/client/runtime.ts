/**
 * 按包的浏览器生命周期：求值闭包、用守卫门面包裹 `apply`、
 * 在模块表中落座一个现成工厂、并创建一个 loader 条目 —— 从而动态包
 * 乘坐与静态插件完全相同的机制（基于 inject 的激活把关、fiber-effect
 * 清理、状态投影）。卸载 = 移除 loader 条目（fiber 释放级联槽位条目与
 * 门面 effect）+ 工厂失效 + 样式移除。
 *
 * 该引擎应答其调用方：`load` 以本页面最终得到的结果解析，而这正是
 * 运行编排回传给 host 的内容。加载按 Plugin Run ID 针对活动状态
 * 收敛，而非历史：加载本页面已在运行的精确激活是无操作且仍会应答，
 * 另一次运行会替换它，而收回之后同一 Package 会全新加载。按 Plugin
 * 的串行化避免第二个请求与进行中的请求交错。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Loader } from '@deepseek-ai/cordis-plugin-loader'
import type {
  CordisDynamicPackageId, CordisDynamicPluginId, CordisDynamicPluginRunId, DynamicCordisPackage,
  SessionId,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { ClientModuleSystem } from '@deepseek-ai/dsh-client-modules/client'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { DynamicCordisStyles, evaluateClientHalf, DYNAMIC_CLIENT_REDIRECTS } from './evaluator.ts'
import type { DynamicCordisEvaluatedPlugin } from './evaluator.ts'
import { dynamicCordisContext } from './guard.ts'
import type { DynamicCordisSlotLedgerRow } from './guard.ts'

/**
 * 一个界面可订阅的快照来源（渲染接缝的可观察形态）。
 * 它位于此处，是因为引擎本身与运行编排都通过它发布，
 * 且编排已经依赖本模块。
 */
export interface CordisObservable<T> {
  /** 当前值；在两次变更之间引用稳定。 */
  getSnapshot(): T
  /**
   * 观察变更。
   * @param fn - 每次已提交的变更之后被通知。
   * @returns 取消订阅函数。
   */
  subscribe(fn: () => void): () => void
}

/** 一次加载失败的、由页面所归类的阶段。 */
export type DynamicCordisLoadErrorCause = 'evaluate' | 'module-import' | 'activate'

/** 由页面运行器与 Host 传输保留的错误字段。 */
export interface CordisErrorDetails {
  /** 原始错误消息。 */
  message: string
  /** 被抛值提供了栈时的原始栈。 */
  stack?: string
}

/** Host 交来的某个包的浏览器半区。 */
export interface DynamicCordisClientHalf {
  /** 稳定的 Plugin 实例。 */
  pluginId: CordisDynamicPluginId
  /** 不可变的 Package 源码版本。 */
  packageId: CordisDynamicPackageId
  /** 精确激活。 */
  pluginRunId: CordisDynamicPluginRunId
  /** 运行所服务的会话；后续的渲染失败在其名下报告。 */
  agentId: SessionId
  /** 来自 define 调用的标签；同时也是插件名。 */
  name: string
  /** 浏览器半区源码：一个返回插件的 async 函数体。 */
  code: string
}

/**
 * 一个动态包槽位条目在渲染时的崩溃，按本页面的报告口径。
 * 仅限结算后诊断：它所属的运行的应答远早于此
 * （一个在渲染时崩溃的包是加载成功的），因此它
 * 永远到不了运行结算。
 */
export interface DynamicCordisRenderFailure {
  /** 崩溃条目所渲染于其下的槽位键。 */
  slot: string
  /** 作者需阅读以修复它的内容：崩溃文本，加上当点名被扣留全局时的重定向。 */
  message: string
  /** 可用时的原始渲染失败栈。 */
  stack?: string
  /** 崩溃是否将条目从其格位中撤下 —— 包的 UI 已消失，而非仅仅损坏。 */
  abdicated: boolean
}

/**
 * 本页面最终得到的结果。一个被挂起的包也是成功 —— 浏览器半区
 * 已落定，并在等待本页面尚未获得的、已声明的服务。
 */
export type DynamicCordisLoadResult =
  | { ok: true; pluginRunId: CordisDynamicPluginRunId; waitingFor?: string[] }
  | ({ ok: false; cause: DynamicCordisLoadErrorCause; error?: unknown } & CordisErrorDetails)

/** `window.__ModuleLoader__` 的注册汇点（client-modules 契约 C6）。 */
interface ModuleLoaderSink {
  __ModuleLoader__?: {
    load(handoff: { id: string; factory: (require: (spec: string) => unknown) => unknown }): void
  }
}

/** 一个活动包的记账。 */
interface LivePackage {
  pkg: DynamicCordisPackage
  entryId: string
  styles: DynamicCordisStyles
  ledger: DynamicCordisSlotLedgerRow[]
  /** 浏览器半区已声明、而本页面尚未获得的（被挂起，仍属成功）服务。 */
  waitingFor: string[]
}

/** 运行器依赖，由插件条目在激活时解析。 */
export interface DynamicCordisRunnerEnv {
  /** Client 根上下文（服务读取与守卫的 fiber 所有者）。 */
  ctx: Context
  /** Client cordis Loader：动态包成为其下的条目。 */
  loader: Loader
  /** 模块表，用于每次（重新）注册前的工厂失效。 */
  modules: ClientModuleSystem
  /** 槽位注册表，用于条目崩溃监督接缝。 */
  slots: SlotRegistry
  /** 通过 Remote 命名空间，将一次 `host.call` 路由到包的 host 半区。 */
  invoke(
    pluginId: CordisDynamicPluginId,
    pluginRunId: CordisDynamicPluginRunId,
    method: string,
    args: unknown,
  ): Promise<unknown>
  /**
   * 将一次渲染时崩溃回传给编写该包的会话。
   * 按契约为发后不理：崩溃已经发生，而一次失败的报告
   * 绝不能变成第二次失败。
   * @param agentId - 崩溃包所运行的会话。
   * @param id - 崩溃的包。
   * @param failure - 槽位、教学性文本，以及条目是否被撤下。
   */
  reportRenderFailure(
    agentId: SessionId,
    pluginId: CordisDynamicPluginId,
    pluginRunId: CordisDynamicPluginRunId,
    failure: DynamicCordisRenderFailure,
  ): void
  /** 将一次激活后的 Client 守卫拒绝发送给所属 Agent。 */
  reportGuardFailure(
    agentId: SessionId,
    pluginId: CordisDynamicPluginId,
    pluginRunId: CordisDynamicPluginRunId,
    failure: CordisErrorDetails,
  ): void
}

/** 一个包的模块表 id（亦为其 loader 条目名与 fiber 名）。 */
function moduleIdOf(id: CordisDynamicPluginId): string {
  return `dyn/${id}`
}

/** 本页面中一个活动包的贡献摘要。 */
export interface DynamicCordisLivePackage {
  /** 稳定的 Plugin 实例。 */
  pluginId: CordisDynamicPluginId
  /** 不可变的 Package 源码版本。 */
  packageId: CordisDynamicPackageId
  /** 本页面中加载的精确激活。 */
  pluginRunId: CordisDynamicPluginRunId
  /** 来自 define 调用的标签。 */
  name: string
  /** 本包在此注册的槽位名与 `factory:<name>` 定义。 */
  slots: string[]
  /** 活动注入样式标签数量。 */
  styleCount: number
}

/** 动态包的浏览器侧加载引擎。 */
export class DynamicCordisPackageRunner {
  private readonly live = new Map<CordisDynamicPluginId, LivePackage>()
  /** 按包 id 串行化加载/卸载（第二个请求可能跑赢一个慢速加载）。 */
  private readonly queues = new Map<CordisDynamicPluginId, Promise<unknown>>()
  private readonly changeListeners = new Set<() => void>()
  /** 页面局部的重影等级。后注册的收到更低的优先级。 */
  private nextPriority = 0
  /**
   * 哪个包坐落了哪个组件，以及为谁。组件身份是
   * 唯一站得住脚的归因键：
   * - 注册表逐字存储组件，因此一个崩溃的条目自带
   *   回归之路 —— 无需并行的条目台账来保持同步；
   * - `entry.registrant` 是 `options.registrant ?? fiber.name`，而门面
   *   不会剥离包提供的那个，因此一个包可能把自己命名为别的东西
   *   —— 按它归因会让一个包冒充另一个；
   * - 被分配的重影优先级是唯一的，但在链条目上缺失（其
   *   选举被刻意保留不动），因此它会漏掉链崩溃；
   * - 在崩溃与报告之间被拆除的包仍可被归因，
   *   因为该索引不依赖活动记录。
   *
   * 两个包无法在此相撞：每个浏览器半区在自己的
   * 闭包中求值，因此没有组件对象能抵达其中两个。碰撞只
   * 可能发生在同一个包内部（同一组件被坐落两次），此时两个
   * 条目都映射到同一 id，且值相同。
   */
  private readonly owners = new WeakMap<object, {
    pluginId: CordisDynamicPluginId
    pluginRunId: CordisDynamicPluginRunId
    agentId: SessionId
  }>()
  /** 本页面按包计的上次渲染崩溃：运行界面在行上展示的内容。 */
  private readonly failures = new Map<CordisDynamicPluginId, DynamicCordisRenderFailure>()
  private readonly unwatch: () => void
  private snapshotCache: readonly DynamicCordisLivePackage[] | undefined
  private failureCache: ReadonlyMap<CordisDynamicPluginId, DynamicCordisRenderFailure> | undefined

  /** @param env - loader/模块/槽位接线，外加本引擎使用的两个 host 动词。 */
  constructor(private readonly env: DynamicCordisRunnerEnv) {
    // 监督接缝为页面上每一次条目崩溃触发，工厂 UI
    // 也包括在内；只有本运行器坐落的那些才归我们报告。
    this.unwatch = env.slots.onEntryError((slot, entry, error, info) => {
      const component: unknown = (entry as { component?: unknown }).component
      const owner = indexable(component) ? this.owners.get(component) : undefined
      if (owner === undefined) return
      const details = errorDetails(error)
      const failure: DynamicCordisRenderFailure = {
        slot,
        message: renderFailureMessage(slot, details.message),
        ...details.stack === undefined ? {} : { stack: details.stack },
        abdicated: info.abdicated,
      }
      // 一次观察，两个归属与生命周期不同的出口：host
      // 为模型保留跨页面的上次崩溃，而此映射是本页面
      // 当前展示的内容。两者互不派生。
      env.reportRenderFailure(owner.agentId, owner.pluginId, owner.pluginRunId, failure)
      this.failures.set(owner.pluginId, failure)
      this.notify()
    })
  }

  /**
   * 观察活动集变更（运行状态界面的重渲染接缝）。
   * @param fn - 每次收敛的变更之后被通知。
   * @returns 取消订阅函数。
   */
  subscribe(fn: () => void): () => void {
    this.changeListeners.add(fn)
    return () => { this.changeListeners.delete(fn) }
  }

  /**
   * 本页面按包计的上次渲染崩溃，与活动集处于
   * 同一通知通道 —— 一个已经订阅的界面无需第二种
   * 机制就能获知一次崩溃。
   */
  readonly renderFailures: CordisObservable<ReadonlyMap<CordisDynamicPluginId, DynamicCordisRenderFailure>> = {
    getSnapshot: () => this.failureCache ??= new Map(this.failures),
    subscribe: fn => this.subscribe(fn),
  }

  /**
   * 本页面当前已加载的内容（在变更之间引用稳定，因此
   * 可支撑一个快照选择器）。
   * @returns 每个活动包一行。
   */
  getSnapshot(): readonly DynamicCordisLivePackage[] {
    return this.snapshotCache ??= [...this.live.values()].map(({ pkg, ledger, styles }) => ({
      pluginId: pkg.pluginId,
      packageId: pkg.packageId,
      pluginRunId: pkg.pluginRunId,
      name: pkg.name,
      slots: [...new Set(ledger.map(row => row.slot))],
      styleCount: styles.count,
    }))
  }

  /**
   * 本页面是否已加载该浏览器半区 —— 页面局部的真相，而非
   * host 的"它正在运行"。
   * @param pluginId - 稳定的 Plugin 身份。
   * @returns 该 Plugin 的一次激活在此活动期间为 true。
   */
  isLoaded(pluginId: CordisDynamicPluginId): boolean {
    return this.live.has(pluginId)
  }

  /**
   * 将一个浏览器半区加载到本页面，并应答所发生的结果。
   * @param half - 某一次精确 Host 激活的源码。
   * @returns 运行编排回传给 host 的结果。
   */
  load(half: DynamicCordisClientHalf): Promise<DynamicCordisLoadResult> {
    return this.enqueue(half.pluginId, async () => {
      const current = this.live.get(half.pluginId)
      if (current !== undefined) {
        // 此处已在运行这一激活：无需加载，但调用方
        // 仍需要一个应答（一次重放的 run 绝不能显得未被确认）。
        if (current.pkg.pluginRunId === half.pluginRunId) return settled(current)
        await this.teardown(current.pkg.pluginId, current.entryId, current.styles)
      }
      const result = await this.mount(half)
      this.notify()
      return result
    })
  }

  /**
   * 卸载一个包（`cordis/dynamic-retract`：一次停止，或一次先停后定义的
   * 解除）。
   * @param pluginId - 稳定的 Plugin 身份。
   * @param pluginRunId - 被收回的精确激活；更新的运行得以存活。
   */
  retract(pluginId: CordisDynamicPluginId, pluginRunId: CordisDynamicPluginRunId): void {
    void this.enqueue(pluginId, async () => {
      const current = this.live.get(pluginId)
      if (current === undefined || current.pkg.pluginRunId !== pluginRunId) return
      await this.teardown(pluginId, current.entryId, current.styles)
      this.notify()
    })
  }

  /** 卸载一切（插件处置路径）。 */
  async dispose(): Promise<void> {
    this.unwatch()
    for (const current of [...this.live.values()]) {
      await this.teardown(current.pkg.pluginId, current.entryId, current.styles)
    }
    this.notify()
  }

  private notify(): void {
    this.snapshotCache = undefined
    this.failureCache = undefined
    for (const fn of [...this.changeListeners]) fn()
  }

  /** 将一个包的操作排到该包之前的操作之后。 */
  private enqueue<T>(id: CordisDynamicPluginId, op: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve()
    const next = previous.then(op)
    // 队列尾部必须在本操作失败时存活，否则一次拒绝
    // 会卡住同一包上随后所有操作。
    this.queues.set(id, next.then(() => {}, () => {}))
    return next
  }

  private async mount(half: DynamicCordisClientHalf): Promise<DynamicCordisLoadResult> {
    const styles = new DynamicCordisStyles(half.pluginId)
    const ledger: DynamicCordisSlotLedgerRow[] = []
    let plugin: DynamicCordisEvaluatedPlugin | ((ctx: unknown) => unknown)
    try {
      plugin = await evaluateClientHalf(half.pluginId, half.code, {
        invoke: (method, args) => this.env.invoke(half.pluginId, half.pluginRunId, method, args),
        noteError: (message) => {
          // 一个已加载包自身的 console.error：一个页面局部的
          // 诊断，没有连线载体（运行往返早已结算）。
          console.error(`[cordis-client-runner] ${half.pluginId} logged an error:`, message)
        },
      }, styles)
    } catch (error) {
      styles.dispose()
      return { ok: false, cause: 'evaluate', ...errorDetails(error), error }
    }

    const pkg: DynamicCordisPackage = {
      pluginId: half.pluginId,
      packageId: half.packageId,
      pluginRunId: half.pluginRunId,
      name: half.name,
    }
    const surface = this.guardedSurface(pkg, half.agentId, plugin, ledger)
    const moduleId = moduleIdOf(half.pluginId)
    // 先失效再注册使重新加载合法：模块表会在重复
    // 工厂注册时大声抛出。
    this.env.modules.invalidate(moduleId)
    const sink = (globalThis as ModuleLoaderSink).__ModuleLoader__
    if (sink === undefined) {
      throw new Error('cordis-client-runner: window.__ModuleLoader__ is missing (booted outside the web shell?)')
    }
    sink.load({ id: moduleId, factory: () => surface })

    const entryId = await this.env.loader.create({ name: moduleId })
    const fiber = this.env.loader.resolve(entryId).fiber
    if (fiber === undefined) {
      await this.teardown(half.pluginId, entryId, styles)
      return { ok: false, cause: 'module-import', message: 'module import failed (see the browser console)' }
    }
    try {
      await fiber.await()
    } catch (error) {
      await this.teardown(half.pluginId, entryId, styles)
      return { ok: false, cause: 'activate', ...errorDetails(error), error }
    }
    // 已落定但未激活 = 合法地等待一个未满足的声明。记录
    // 此刻才坐落，因此在 `apply` 期间镜像的错误无法
    // 声称包已经活动。
    const waitingFor = Object.keys(fiber.inject).filter(name => this.env.ctx.get(name) === undefined)
    const record: LivePackage = { pkg, entryId, styles, ledger, waitingFor }
    this.live.set(half.pluginId, record)
    // 一次全新加载为自己应答：本页面上次显示为崩溃的内容
    // 对于现在挂载的东西不再为真。
    this.failures.delete(half.pluginId)
    return settled(record)
  }

  /**
   * 包裹被求值的插件，使 `apply` 看到守卫门面；该表面
   * 同时充当模块表的模块。插件自身的 `inject` 得以保留
   * （对象形式的声明即门面的服务把关，镜像 host 沙箱读取
   * `ctx.fiber.inject`）；函数形式没有声明处，因此触达不到任何服务。
   */
  private guardedSurface(
    pkg: DynamicCordisPackage,
    agentId: SessionId,
    plugin: DynamicCordisEvaluatedPlugin | ((ctx: unknown) => unknown),
    ledger: DynamicCordisSlotLedgerRow[],
  ): DynamicCordisEvaluatedPlugin {
    const claim = (component: unknown): void => {
      if (indexable(component)) {
        this.owners.set(component, { pluginId: pkg.pluginId, pluginRunId: pkg.pluginRunId, agentId })
      }
    }
    const guarded = (ctx: unknown): Context => dynamicCordisContext(ctx as Context, {
      pkg,
      ledger,
      claim,
      allocatePriority: () => --this.nextPriority,
      reportFailure: (error) => {
        this.env.reportGuardFailure(agentId, pkg.pluginId, pkg.pluginRunId, errorDetails(error))
      },
    })
    if (typeof plugin === 'function') {
      return { name: moduleIdOf(pkg.pluginId), apply: (ctx: unknown) => plugin(guarded(ctx)) }
    }
    return {
      ...plugin,
      name: moduleIdOf(pkg.pluginId),
      apply: (ctx: unknown, config?: unknown) => plugin.apply(guarded(ctx), config),
    }
  }

  /**
   * 卸载一个包的贡献。取零件而非记录，
   * 是因为一次加载可能在任何记录落座前就失败。
   */
  private async teardown(
    id: CordisDynamicPluginId,
    entryId: string,
    styles: DynamicCordisStyles,
  ): Promise<void> {
    this.live.delete(id)
    // 本包的任何东西都不再渲染于此，因此崩溃行会比
    // 它所描述之物活得更久。
    this.failures.delete(id)
    // 条目移除会释放 fiber（槽位条目与门面 effect
    // 级联）；工厂失效使随后的重新加载合法。
    const disposal = this.env.loader.resolve(entryId).fiber?.dispose()
    this.env.loader.remove(entryId)
    await disposal
    this.env.modules.invalidate(moduleIdOf(id))
    styles.dispose()
  }
}

/** 一个在此活动（已挂起或已激活）的包的成功应答。 */
function settled(record: { pkg: DynamicCordisPackage; waitingFor: string[] }): DynamicCordisLoadResult {
  return {
    ok: true,
    pluginRunId: record.pkg.pluginRunId,
    ...record.waitingFor.length > 0 ? { waitingFor: record.waitingFor } : {},
  }
}

/**
 * 一个组件能否作为归属索引的键。身份即键，因此只有
 * 对象与函数合格 —— 一个包可以注册任何东西，而它注册了什么，
 * 崩溃报告就带回什么。
 * @param component - 一个包作为组件传入的任何值。
 * @returns 当该值可按身份索引时为 true。
 */
function indexable(component: unknown): component is object {
  return typeof component === 'object' && component !== null || typeof component === 'function'
}

/**
 * 为加载结果保留错误字段，而不臆造一个栈。
 * @param error - 原始被抛值。
 * @returns 其消息与原始字符串栈（若存在）。
 */
/* jscpd:ignore-start */
export function errorDetails(error: unknown): CordisErrorDetails {
  if (typeof error !== 'object' || error === null) return { message: String(error) }
  const message = 'message' in error && typeof error.message === 'string'
    ? error.message
    : Object.prototype.toString.call(error)
  const stack = 'stack' in error && typeof error.stack === 'string' ? error.stack : undefined
  return { message, ...stack === undefined ? {} : { stack } }
}
/* jscpd:ignore-end */

/**
 * 编写会话针对一次渲染崩溃所读取的内容。槽位说明发生在哪里，
 * 崩溃消息说明哪里坏了，而该文本中点名的被扣留全局会引入其重定向
 * —— 一个绕过闭包陷阱触达 `window.setInterval` 的包会以引擎的裸消息
 * 崩溃，那什么都教不到。
 */
function renderFailureMessage(slot: string, message: string): string {
  const redirect = Object.entries(DYNAMIC_CLIENT_REDIRECTS)
    .find(([name, text]) => message.includes(name) && !message.includes(text))?.[1]
  const subject = slot.startsWith('factory:')
    ? `your component in Factory "${slot.slice('factory:'.length)}"`
    : `your entry in slot "${slot}"`
  return `${subject} crashed while React rendered it: ${message}`
    + (redirect === undefined ? '' : `\n${redirect}`)
}
