/**
 * agent 服务：活跃注册表、工厂委托与进程本地的发起方作用域。
 * 具体的创建与驱动属于循环。
 *
 * @module @deepseek-ai/dsh-agent
 */

import { Context, FiberState, getTraceable, Service, symbols } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import { AsyncLocalStorage } from 'node:async_hooks'
import { isPromise } from 'node:util/types'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import type { SessionEvent, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { installTurnArchiveAdmission } from './archive-admission.ts'
import type { Agent } from './types.ts'
import type { AgentOptions, SessionStartSource } from './runtime-types.ts'

export * from './runtime-types.ts'
export * from './types.ts'
export type * from './projection.ts'
export * from './consumed-work.ts'
export * from './model-selection.ts'
export { agentCarrier, agentEvents, assembleContextFor, emitAgentEvent } from './dispatch.ts'
export type { AgentEventDispatch, AgentSubjectEvent } from './dispatch.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agents: AgentRegistry
  }
}

/**
 * 未发布 Agent 搭建返回的同步终结器，供其贡献需要在发布提交的准确时点
 * 得到验证时使用。
 */
export interface AgentSetupCommit {
  /**
   * 在发布之前立即验证并提交已准备好的搭建。
   * @throws 当发布必须回滚未发布的 Agent 时抛出。
   */
  commit(): void
}

/**
 * 组装一个未发布的 Agent 作用域，并可选地返回其发布提交。
 * @param agentCtx - 未发布的 Agent 作用域。
 * @param agent - 正在组装的未发布 Agent。
 * @returns 可选的同步提交，在 setup 的 await 结算之后、发布之前立即调用。
 */
export type AgentSetup = (
  agentCtx: Context,
  agent: Agent,
) => AgentSetupCommit | Promise<AgentSetupCommit | void> | void

/**
 * 通过注册表工厂（{@link AgentRegistry.create}）以编程方式创建 agent 的选项。
 * 调用方提供 agent 注册表与 session 日志共享的唯一活跃 `sessionId`
 * （例如 ACP 生成的 id），以及可选的 session 元数据（已验证的 `cwd`、fork
 * 世系）；工厂在该身份下创建 session 与 agent。
 */
export interface CreateAgentOptions {
  /** 活跃的 agent/session 身份。 */
  readonly sessionId: SessionId
  /** 运行时所有权的活跃父 Agent；根 Agent 则省略。 */
  readonly parentAgent?: Agent
  /**
   * session 创建元数据：已验证的绝对 `cwd`、`parentSession` fork 世系、
   * `isSeeded` fork 标记、粗粒度的 `origin` 分类，以及 `delegationDepth`
   * 递归预算。镜像 dsh-session 中 {@link CreateSessionOptions.meta} 的
   * `cwd`/`parentSession`/`isSeeded`/`origin`/`delegationDepth` 字段
   * （仅内部使用的 `createdAt` 在重建持久 session 时使用，被有意排除
   * —— 工厂调用方从不设置它）。这是持久 session 数据，因此 session
   * 边界会在异步 setup 开始之前验证并快照它。
   */
  readonly meta?: {
    readonly cwd?: string
    readonly parentSession?: SessionId
    readonly isSeeded?: boolean
    readonly origin?: 'subagent'
    readonly delegationDepth?: number
    readonly agentPreset?: string
  }
  /** session 元数据设置 `isSeeded` 时的确切 fork 继承前缀长度。 */
  readonly inheritedEventCount?: SessionLogOffset
  /**
   * 初始回放/fork 历史，从 seq 0 起连续且为无损 JSON 数据。fork 提供确切的
   * 父前缀、其继承标记，以及为打开尾部准备的收尾事件。先前已关闭的 step
   * 与 turn 保持不变。工厂在发布之前验证并快照种子。
   */
  readonly seed?: readonly SessionEvent[]
  /** 按 agent 的选项（模型等）。 */
  readonly agentOptions?: AgentOptions
  /** 可选的仅创建期取消信号；在返回的句柄可见之前分离。 */
  readonly signal?: AbortSignal
  /**
   * 创建时对 agent 作用域世界的组装。工厂在铸造 `agentCtx` 之后、但在插入
   * 或宣布 session 与 agent 之前等待 setup 完成，因此观察者永远看不到部分
   * 配置的世界。setup 可以返回 {@link AgentSetupCommit}；工厂在每一个 setup
   * await 结算之后、注册表发布之前调用其同步 `commit()`。这使可变的供给
   * 能在准确的发布时点重新验证。所有通过 `agentCtx` 注册的内容（作用域
   * 工具、提示词分节/变量、`restrict()`、监听器、被等待的子插件）都在
   * `session/created`、`agent/created` 与第一次提示词组装之前存在。
   * setup 抛出/拒绝、commit 抛出或所有者释放都会回滚该作用域，
   * 两个 id 均不发布。
   *
   * **Setup 只组装，从不驱动**：回调是受信任的同进程代码并接收完整的作用域
   * 上下文，因此这是契约而非运行时限制。仅在创建 resolve 之后才驱动 agent。
   */
  readonly setup?: AgentSetup
}

/**
 * 在持久 session 上恢复 agent 的选项
 * （{@link AgentRegistry.resume}）。
 */
export interface ResumeAgentOptions {
  /** 要加载并用作活跃 agent/session 身份的持久 session id。 */
  readonly resumeSessionId: SessionId
  /** 运行时所有权的活跃父 Agent；根 Agent 则省略。 */
  readonly parentAgent?: Agent
  /** 按 agent 的选项（模型等）。 */
  readonly agentOptions?: AgentOptions
  /** 可选的仅创建期取消信号，用于持久加载/setup；返回前分离。 */
  readonly signal?: AbortSignal
  /**
   * 恢复时对 agent 全新作用域世界的组装。持久数据先加载；随后工厂铸造
   * `agentCtx` 并在重建的 session 与 agent 保持未发布的状态下等待 setup。
   * 回调拥有与 {@link CreateAgentOptions.setup} 相同的受信任仅组装契约和
   * 可选的同步发布提交：所有注册都在任一创建宣布之前存在，而拒绝、
   * commit 失败或所有者释放都会回滚事务，两个 id 均不发布。
   */
  readonly setup?: AgentSetup
}

/**
 * 一个被拥有的 agent 及其释放器，由 {@link AgentRegistry.create} /
 * {@link AgentRegistry.resume} 返回。释放器是一项能力（CAPABILITY）：在所有
 * 消费方中，只有持有者能拆除此 agent。注册的工厂提供方也是结构性所有者，
 * 因为作用域化的 agent 依赖该提供方的服务 API；提供方卸载会停止并排空
 * 其创建的每个活跃句柄。`dispose()` 停止循环、等待其退出、注销 agent、
 * 从存储中移除其 session，最后回退其作用域世界。
 *
 * `ctx.agents.get(id)` 仍返回裸的 {@link Agent} —— 该句柄只暴露给创建它的
 * 消费方所有者；结构性提供方在内部抵达同样的拆除。由配置创建的 agent
 * （循环自身的启动）由循环 fiber 拥有，从不需要句柄。
 */
export interface AgentHandle {
  agent: Agent
  dispose(): Promise<void>
}

/**
 * 循环实现提供给注册表的 agent 创建工厂，通过 {@link AgentRegistry.setFactory}
 * 注册。保留在 `dsh-agent` 接口上，使消费方（如 ACP 桥接）面向 `ctx.agents`
 * 编程而无需依赖具体的 `dsh-agent-loop` 包。
 */
export interface AgentFactory {
  /**
   * 在调用方提供的 session id 上创建一个新 agent。是异步的，因为创建会
   * 等待未发布的 setup、调用其可选的同步提交、插入 session 与 agent、
   * 宣布 session 创建，并在释放排队工作之前等待串行的 `agent/created`
   * 监听器。该序列有回滚覆盖，但在后续监听器失败之前已送达的通知仍然
   * 可观察；已开始的每一条 agent 或 session 创建宣布在回滚期间都由
   * `agent/disposed` 或 `session/disposed` 配对。所有者释放解析出的句柄
   * 以停止/排空、注销、移除 session 并回退作用域。
   * 注册表把携带 `create()` 调用方 fiber 与 scope 的上下文作为 `ownerCtx`
   * 传入。实现把未发布的事务与产生的生命周期挂接到该所有者；它不得从
   * 工厂对象的注册上下文推断所有权。
   * @param ownerCtx - 拥有事务与活跃句柄的调用方绑定上下文。
   * @param options - agent/session 身份、配置、可选的活跃父 agent 与 setup。
   * @returns 在 setup 与两条创建宣布完成后返回被拥有的句柄。
   */
  createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle>
  /**
   * 在持久 session 上恢复一个 agent。是异步的，因为它要以写方式打开持久
   * session、读取并修复日志、发布它，并等待可选的未发布 setup 事务；
   * 必须在 `ctx.sessionPersistence` 存在之后调用（消费方注入
   * `sessionPersistence`）。发布遵循与 {@link createAgent} 相同的
   * setup 提交与有序边界。
   * @param ownerCtx - 拥有加载、setup 与活跃句柄的调用方绑定上下文。
   * @param options - 持久身份、配置、可选的活跃父 agent 与 setup。
   * @returns 在 setup、两条宣布与循环启动完成后返回被拥有的句柄。
   */
  resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle>
}

/** 在注册 agent 工厂之前调用 create/resume 时抛出。 */
const NO_FACTORY_MESSAGE = 'no agent factory registered (load an agent-loop plugin)'
const NO_INITIATOR_MESSAGE = 'no initiating agent is active'
const DISPOSED_INITIATOR_MESSAGE = 'agent initiator scope is disposed'

/** 单个确切注册条目的全部可变生命周期状态。 */
interface AgentEntry {
  readonly id: SessionId
  readonly agent: Agent
  /** 运行时创建者-agent 所有权；与持久 session 世系无关。 */
  readonly owner: Agent | undefined
  readonly carrier: Scoped<Agent>
  announced: boolean
  announcing: boolean
  detachRequested: boolean
}

/** 一个被跟踪的边界加上其继承的嵌套链。 */
interface InitiatorRun {
  active: boolean
  readonly parent: InitiatorRun | undefined
}

/** 普通持有器防止 Cordis 在调用方上下文未知之前追踪工厂字段。 */
interface FactorySlot {
  readonly target: AgentFactory
}

/**
 * agent 服务（`ctx.agents`）：跟踪活跃 agent，并沿着一条进程本地的异步
 * 驱动链携带发起方 Agent。agent 的*创建*由实现 {@link AgentFactory} 的插件
 * （`@deepseek-ai/dsh-agent-loop`）提供，经 {@link setFactory} 注册。
 *
 * 发起方方法只提供同进程的因果归因。环境中的存在既不是存活证明也不是
 * 授权；主体与所有者保持显式，worker、进程、持久与线路边界上的身份
 * 也是如此。返回的 Promise 边界在拆除期间排空，但启动了所有者 fiber
 * 卸载的嵌套世系被排除在其自身的排空之外。
 */
export class AgentRegistry extends Service {
  private store = new Map<SessionId, AgentEntry>()
  private factory: FactorySlot | undefined
  private readonly initiators = new AsyncLocalStorage<Agent | undefined>()
  private readonly initiatorRuns = new AsyncLocalStorage<InitiatorRun>()
  private initiatorState: 'active' | 'closing' | 'disposed' = 'active'
  private activeInitiatorRuns = 0
  private initiatorDrain: PromiseWithResolvers<void> | undefined
  private initiatorDisposal: Promise<void> | undefined

  constructor(ctx: Context) {
    super(ctx, 'agents')
    ctx.inject(['typert'], (typeCtx) => {
      typeCtx.typert.lookups.register('agent', {
        parameter: 'agent',
        wire: 'agentId',
        resource: 'session',
        hostTypeSymbol: '@deepseek-ai/dsh-agent#Agent',
        wireTypeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
        resolve: sessionId => this.get(sessionId),
      })
      typeCtx.typert.contexts.registerHost('agent', {
        wire: 'agentId',
        wireTypeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
        resource: 'session',
        resolve: sessionId => this.get(sessionId)?.ctx,
      })
    })
    ctx.on('internal/status', (fiber) => {
      if (fiber.state === FiberState.UNLOADING && this.hasLifecycleAncestor(fiber)) {
        this.closeInitiators()
      }
    })
    ctx.effect(function* (this: AgentRegistry) {
      yield () => this.disposeInitiators()
      yield () => { this.closeInitiators() }
    }.bind(this), 'agents.initiatorLifecycle()')
    // Archive 准入：Workspace 注册表在隐藏一个 Session 之前询问还有什么
    // 在为它运行；这里由每个 Agent 的运行中 turn 作答。
    installTurnArchiveAdmission(ctx, sessionId => this.get(sessionId))
  }

  /**
   * 读取发起了继承的异步驱动链的 Agent。在同样支持无 agent 调用的日志、
   * 追踪、指标或宿主归因中使用这个可选形式。当父创建子时，setup 会报告
   * 因果父，而 setup 回调的 Agent 参数标识子。
   * @returns 继承的 Agent，或在发起方边界之外、或处于显式清除边界内时为 `undefined`。
   * @throws 当本服务实例已被释放时抛出。
   */
  currentInitiator(): Agent | undefined {
    this.assertInitiatorsReadable()
    return this.initiators.getStore()
  }

  /**
   * 读取发起方 Agent，在没有活动的发起方边界时失败。在契约上位于驱动方
   * 之下的私有助手中使用，或用于契约禁止无 agent 调用的部署自有出站请求。
   * 通用或直接调用路径使用可选查找或显式请求字段。
   * @returns 继承的 Agent。
   * @throws 当没有发起方处于活动状态或本服务实例已被释放时抛出。
   */
  requireInitiator(): Agent {
    const agent = this.currentInitiator()
    if (agent === undefined) throw new Error(NO_INITIATOR_MESSAGE)
    return agent
  }

  /**
   * 以一个确切的 Agent 作为进程本地发起方运行一个操作。操作返回的确切
   * 同步值或 Promise 原样保留。自定义驱动方与测试套件会包裹其完整返回的
   * 前台生命周期。
   * 队列或线路接收方只有在验证显式身份并解析出确切活跃 Agent 之后才能
   * 建立该边界；本方法两者都不做。
   * 分离的工作仍归启动它的子系统所有。
   * @param agent - 要继承的发起方 Agent；存在本身既非存活证明也非授权。
   * @param operation - 要调用的同步或异步操作。
   * @returns `operation` 返回的确切值。
   * @throws 当发起方作用域正在关闭/已释放，或 `operation` 抛出时抛出。
   */
  withInitiator<T>(agent: Agent, operation: () => T): T {
    return this.runWithInitiator(agent, operation)
  }

  /**
   * 在隐藏任何继承发起方 Agent 的边界内运行一个操作。确切的同步值或
   * Promise 原样保留。
   * 在创建惰性共享定时器、队列泵、池维护、监视器或导出器时使用它，
   * 使它们不继承恰好初始化它们的第一个 Agent。它只清除发起方归因，
   * 不清除显式字段，也不拥有或排空分离的资源。
   * @param operation - 要在没有发起方的情况下调用的同步或异步操作。
   * @returns `operation` 返回的确切值。
   * @throws 当发起方作用域正在关闭/已释放，或 `operation` 抛出时抛出。
   */
  withoutInitiator<T>(operation: () => T): T {
    return this.runWithInitiator(undefined, operation)
  }

  /**
   * 注册 agent 创建工厂（循环在构造时调用，作用域为 effect）。被追踪的
   * Cordis 服务会被规范化为其实际目标；此后每次 create/resume 调用都通过
   * 调用方的上下文追踪，使所有权跟随调用者而无需堆叠代理层。若工厂已注册
   * 则抛出。返回释放器；释放时清空工厂槽。
   * @param factory - 循环拥有的工厂，{@link create}/{@link resume} 委托给它。
   * @returns 清空工厂槽的释放器。确切的 Cordis effect 释放器（单次）：
   *   组合（生成器）effect 可以直接 yield 它 —— 确切身份会按顺序嵌套拆除。
   */
  setFactory(factory: AgentFactory): () => void {
    const dispose = this.ctx.effect(() => {
      if (this.factory !== undefined) throw new Error('an agent factory is already registered')
      // 当调用方传入一个已经通过上下文读取过的 Service 时，避免堆叠两个
      // Cordis 影子层。调用会在下方通过其实际所有者上下文重新追踪。
      const target = (factory as AgentFactory & { [symbols.original]?: AgentFactory })[symbols.original] ?? factory
      this.factory = { target }
      return () => { this.factory = undefined }
    }, 'agents.setFactory()')
    // 确切的 cordis effect 释放器（agents.register() 的约定）：调用方的
    // 组合 effect 可以 yield 它以进行按序拆除；循环的构造 effect 直接返回
    // 它，把注册身份嵌套在该 effect 之下。
    // oxlint-disable-next-line typescript/no-misused-promises -- synchronous cleanup; direct return preserves disposer identity
    return dispose
  }

  /** 返回活动的创建工厂。 */
  private requireFactory(): FactorySlot {
    if (this.factory === undefined) throw new Error(NO_FACTORY_MESSAGE)
    return this.factory
  }

  /**
   * 通过已注册的工厂创建并发布一个新 agent。与 {@link register}（记录一个
   * 已构造好的 agent）不同：这里构造 agent 及其 session。在没有注册工厂或
   * 创建/setup 失败时拒绝。解析出的 {@link AgentHandle} 让所有者精确拆除
   * 这个 agent。
   * @param options - 共享身份、可选的活跃父 agent、session 种子/元数据与 agent 选项。
   * @returns 在 setup、有回滚覆盖的发布与循环启动完成后返回句柄。
   */
  async create(options: CreateAgentOptions): Promise<AgentHandle> {
    const ownerCtx = this.ctx
    // 显式地通过访问上下文重新追踪基于 Service 的工厂。这保留了 AgentLoop
    // 的依赖来源，同时把它的 effect 绑定到 ownerCtx；普通工厂把 ownerCtx
    // 作为显式能力接收，不需要 Cordis 追踪器的魔法。
    const { target } = this.requireFactory()
    const receiver = getTraceable(ownerCtx, target)
    // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply intentionally supplies the caller-traced receiver
    return Reflect.apply(target.createAgent, receiver, [ownerCtx, options])
  }

  /**
   * 加载一个持久 session，并通过已注册的工厂在其上恢复一个 agent。在没有
   * 注册工厂时拒绝；在 session 持久化未配置或持久化/setup 失败时由工厂拒绝。
   * @param options - 持久身份、可选的活跃父 agent、配置与 setup。
   * @returns 在 setup、有回滚覆盖的发布与循环启动完成后返回句柄。
   */
  async resume(options: ResumeAgentOptions): Promise<AgentHandle> {
    const ownerCtx = this.ctx
    const { target } = this.requireFactory()
    const receiver = getTraceable(ownerCtx, target)
    // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply intentionally supplies the caller-traced receiver
    return Reflect.apply(target.resume, receiver, [ownerCtx, options])
  }

  /**
   * 以来源 `startup` 注册一个活跃 agent。若 id 已注册或某个串行的
   * `agent/created` 监听器失败则拒绝。当调用方 fiber 被释放时发出
   * `agent/disposed` —— 两者都以 agent 的作用域载体
   * （`scopeTarget(agent, agent)`）为准：主体就是手头的 agent，因此无论
   * 哪个上下文调用 `register`，发出都是作用域过滤的
   * （通过 `agent.ctx` 调用会把 EFFECTS 作用域化；分发作用域化总是需要
   * 传入载体）。该条目是运行时根；工厂支持的创建使用 `options.parentAgent`
   * 建立子所有权。使用 agent 之前先等待注册完成。
   * @param agent - 要记录到存储中的已构造好的 agent。
   * @returns 可等待的 Cordis effect 释放器（单次；重复调用返回 undefined，
   *   不会等待进行中的拆除）。确切身份是承载性的：拥有拆除顺序的组合
   *   （生成器）effect —— agent 工厂的生命周期链 —— 必须 yield 本函数，
   *   Cordis 才能在该 yield 位置嵌套注销；yield 一个包装器会让它作为并发
   *   兄弟在所有者卸载时释放，从而在 agent 的最后一个 turn 仍在排空时
   *   注销该 agent（并发出 `agent/disposed`）。
   */
  register(agent: Agent): ReturnType<Context['effect']> {
    return this.ctx.effect(async function* (this: AgentRegistry) {
      yield this.enter(agent, undefined)
      await this.announce(agent, 'startup')
    }.bind(this), 'agents.register()')
  }

  /**
   * 插入一个已构造好的 agent 而不宣布它。这是异步 agent 工厂使用的高级
   * 有序生命周期原语：它先在 agent 未发布时完成 setup，然后把返回的
   * detach 闭包指派进其预装的组合拆除中，再调用 {@link announce}。
   * 普通调用方使用 {@link register}。
   * @param agent - 已准备好的、未发布的 agent。
   * @param owner - 显式提供的活跃运行时所有者；顶层运行时根为
   *   undefined。这是运行时所有权，不是被恢复 session 的持久父世系。
   * @returns 一个幂等闭包，移除这个确切条目并在监听器失败被包容的情况下
   *   发出 `agent/disposed`。当从 `agent/created` 监听器中调用时，移除与
   *   释放会等到串行创建分发结算之后。
   */
  enter(agent: Agent, owner: Agent | undefined): () => void {
    const id = agent.id
    if (id !== agent.session.id) {
      throw new Error(`agent id "${id}" does not match session id "${agent.session.id}"`)
    }
    const carrier = scopeTarget(agent, agent)
    // 这是权威的冲突边界。并发的 create/resume 操作可以都在准备，但只有
    // 一个确切条目能发布。
    if (this.store.has(id)) throw new Error(`agent "${id}" is already registered`)
    const entry: AgentEntry = {
      id,
      agent,
      owner,
      carrier,
      announced: false,
      announcing: false,
      detachRequested: false,
    }
    this.store.set(id, entry)
    let entered = true
    const detach = (): void => {
      if (!entered) return
      entered = false
      // 本次创建分发可达的每个回调都必须观察到同一个活跃条目，且释放必须
      // 发生在创建之后。监听器可能拥有高级 detach 能力，因此让该顺序成为
      // 结构性的：可见性与配对的释放被推迟到 announce() 的串行分发结算
      // 之后。
      if (entry.announcing) {
        entry.detachRequested = true
        return
      }
      this.detachEntered(entry)
    }
    return detach
  }

  /** 移除一个确切已进入的 agent，并在已宣布时发出其配对的释放。 */
  private detachEntered(entry: AgentEntry): void {
    entry.detachRequested = false
    // 过期的能力永远不能删除后来的同 id 生命周期。被捕获的条目身份就是
    // 最终边界。
    /* v8 ignore next -- enter() rejects replacement while this single-shot detach capability is live. */
    if (this.store.get(entry.id) !== entry) return
    this.store.delete(entry.id)
    // 在 announce 之前回滚的插入从未在外部被创建过，因此发出 disposed 会
    // 凭空造出一条不可能的生命周期边。标记发生在 created 发出之前：如果
    // 后面的 created 监听器抛出，更早的监听器可能已经观察到它，必须看到
    // 释放。
    if (!entry.announced) return
    this.emitDisposed(entry)
  }

  /** 通过条目的稳定载体发出配对的释放边。 */
  private emitDisposed(entry: AgentEntry): void {
    const args: unknown[] = [entry.carrier, 'agent/disposed', { agent: entry.agent }]
    for (const callback of this.ctx.events.dispatch('emit', args)) {
      try {
        const returned: unknown = callback(...args)
        void Promise.resolve(returned).catch((error: unknown) => {
          this.ctx.logger.warn(`agent "${entry.id}": agent/disposed listener rejected: ${String(error)}`)
        })
      } catch (error: unknown) {
        this.ctx.logger.warn(`agent "${entry.id}": agent/disposed listener threw: ${String(error)}`)
      }
    }
  }

  /**
   * 宣布一个此前用 {@link enter} 插入的 agent。
   * @param agent - 要宣布的已插入活跃 agent。
   * @param source - 新建、resume、clear 或 compaction 来源。
   * @param signal - 传给监听器的可选工厂初始化取消信号。
   * @returns 串行创建监听器的完成；监听器失败则拒绝。
   * @throws 当 `agent` 不是其 id 的确切活跃注册表条目，或其创建宣布已经
   *   开始（包括来自创建监听器的重入调用）时抛出。
   */
  async announce(agent: Agent, source: SessionStartSource, signal?: AbortSignal): Promise<void> {
    const entry = this.store.get(agent.id)
    if (entry === undefined || entry.agent !== agent) {
      throw new Error(`agent "${agent.id}" is not live in this registry`)
    }
    if (entry.announced || entry.announcing) {
      throw new Error(`agent "${entry.id}" was already announced`)
    }
    // 在分发之前标记，使监听器无法递归地创建第二条生命周期边；detach 仍会
    // 为部分送达的第一条边配对。
    entry.announcing = true
    entry.announced = true
    try {
      await this.ctx.serial(entry.carrier, 'agent/created', {
        agent: entry.agent,
        source,
        ...signal === undefined ? {} : { signal },
      })
    } finally {
      entry.announcing = false
      if (entry.detachRequested) this.detachEntered(entry)
    }
  }

  /**
   * 查找一个活跃 agent。
   * @param id - 要查找的共享 agent/session id。
   * @returns 该 agent，或没有活跃 agent 具有该 id 时为 undefined。
   */
  get(id: SessionId): Agent | undefined {
    return this.store.get(id)?.agent
  }

  /**
   * 测试某个活跃 agent 是否是通过一个确切父 agent 的作用域上下文创建的。
   * 运行时所有权独立于持久 session 世系，在无关提供方复用同一 id 时仍然
   * 无歧义。
   * @param id - 候选子 agent 的共享 agent/session id。
   * @param owner - 预期的运行时创建者 agent。
   * @returns 仅当确切的子条目在该所有者之下活跃时为 true。
   */
  isOwnedBy(id: SessionId, owner: Agent): boolean {
    return this.store.get(id)?.owner === owner
  }

  /**
   * 全部活跃 agent，按注册顺序。
   * @returns 一个新数组；修改它不影响注册表。
   */
  list(): Agent[] {
    return [...this.store.values()].map(entry => entry.agent)
  }

  /**
   * 全部活跃的顶层 agent，按注册顺序。顶层 agent 在创建时没有拥有它的
   * agent 上下文；持久 session 世系不影响这种运行时关系，因此被恢复的
   * fork 仍可能是根。
   * @returns 一个新数组；修改它不影响注册表。
   */
  roots(): Agent[] {
    return [...this.store.values()]
      .filter(entry => entry.owner === undefined)
      .map(entry => entry.agent)
  }

  /** 在继承的延续排空期间拒绝新的发起方边界。 */
  private closeInitiators(): void {
    if (this.initiatorState === 'active') this.initiatorState = 'closing'
  }

  /** 等待返回 Promise 的边界，然后使保留的引用失效。 */
  private disposeInitiators(): Promise<void> {
    return (this.initiatorDisposal ??= (async () => {
      this.closeInitiators()
      this.releaseReentrantInitiatorRuns()
      if (this.activeInitiatorRuns !== 0) {
        this.initiatorDrain ??= Promise.withResolvers<void>()
        await this.initiatorDrain.promise
      }
      this.initiatorState = 'disposed'
      this.initiators.disable()
      this.initiatorRuns.disable()
    })())
  }

  /** 建立一个被跟踪的发起方或清除边界。 */
  private runWithInitiator<T>(agent: Agent | undefined, operation: () => T): T {
    if (this.initiatorState !== 'active') throw new Error(DISPOSED_INITIATOR_MESSAGE)
    const run: InitiatorRun = {
      active: true,
      parent: this.initiatorRuns.getStore(),
    }
    this.activeInitiatorRuns += 1
    let result: T
    try {
      result = this.initiatorRuns.run(run, () => this.initiators.run(agent, operation))
    } catch (error: unknown) {
      this.releaseInitiatorRun(run)
      throw error
    }
    if (isPromise(result)) {
      try {
        void Promise.prototype.then.call(
          result,
          () => { this.releaseInitiatorRun(run) },
          () => { this.releaseInitiatorRun(run) },
        )
      } catch {
        // 一个带品牌的 Promise 可能暴露会失败的 @@species。观察者设置没有
        // 挂接上，因此保留确切的返回值而不泄漏本次运行。
        this.releaseInitiatorRun(run)
      }
    } else {
      this.releaseInitiatorRun(run)
    }
    return result
  }

  /** 是否有某个正在卸载的 fiber 拥有本服务的生命周期。 */
  private hasLifecycleAncestor(candidate: Fiber): boolean {
    let fiber = this.ctx.fiber
    while (true) {
      if (fiber === candidate) return true
      const parent = fiber.parent.fiber
      if (parent === fiber) return false
      fiber = parent
    }
  }

  private assertInitiatorsReadable(): void {
    if (this.initiatorState === 'disposed') throw new Error(DISPOSED_INITIATOR_MESSAGE)
  }

  /** 把发起了本次拆除的边界链从其自身的排空中排除。 */
  private releaseReentrantInitiatorRuns(): void {
    let run = this.initiatorRuns.getStore()
    while (run !== undefined) {
      this.releaseInitiatorRun(run)
      run = run.parent
    }
  }

  private releaseInitiatorRun(run: InitiatorRun): void {
    if (!run.active) return
    run.active = false
    this.activeInitiatorRuns -= 1
    if (this.activeInitiatorRuns !== 0) return
    this.initiatorDrain?.resolve()
    this.initiatorDrain = undefined
  }
}

export default AgentRegistry
