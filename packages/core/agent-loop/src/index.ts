/**
 * 具体 agent-loop 插件：创建带作用域的 ReactLoopAgent，通过 agent/session
 * 注册表发布它们，并拥有它们有序的拆除。
 *
 * @module @deepseek-ai/dsh-agent-loop
 */
import type { Volatile } from '@deepseek-ai/cosmokit'

import { Context, FiberState, Service } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  Agent,
  AgentFactory,
  AgentHandle,
  AgentOptions,
  AgentSetup,
  CreateAgentOptions,
  ResumeAgentOptions,
  SessionStartSource,
  TurnBoundaryProjection,
} from '@deepseek-ai/dsh-agent'
import { errorChain, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { interruptedTurnClosers, SessionLogOffset, SessionPreparation, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import type { SessionHandle, SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { ReactLoopAgent } from './agent.ts'
import { inboxProjectionDefinition } from './inbox.ts'
import { DEFAULT_MAX_PARALLEL_TOOL_CALLS } from './constants.ts'
import type {} from './runtime-context.ts'

/** 不能拥有或服务新生命周期的 fiber 状态。 */
const INACTIVE_STATES: ReadonlySet<FiberState> = new Set([
  FiberState.UNLOADING,
  FiberState.DISPOSED,
  FiberState.FAILED,
])

const turnBoundaryProjectionSchema: zod.ZodType<TurnBoundaryProjection> = zod.object({
  openTurnStartSeq: zod.number().int().nonnegative().transform(SessionSeq).nullable(),
  lastStepStartSeq: zod.number().int().nonnegative().transform(SessionSeq).nullable(),
  lastStepBoundary: zod.object({
    kind: zod.union([zod.literal('start'), zod.literal('end')]),
    seq: zod.number().int().nonnegative().transform(SessionSeq),
  }).nullable(),
  lastTurn: zod.number().int().nonnegative(),
})

/** agent turn 和 step 边界的宿主投影。 */
export const turnBoundaryProjectionDefinition = {
  key: 'turnBoundary',
  stateVersion: 2,
  stateSchema: turnBoundaryProjectionSchema,
  init: () => ({
    openTurnStartSeq: null,
    lastStepStartSeq: null,
    lastStepBoundary: null,
    lastTurn: 0,
  }),
  apply: (state, event) => {
    switch (event.type) {
      case 'turn/start':
        return {
          ...state,
          openTurnStartSeq: event.seq,
          lastTurn: event.data.turn,
        }
      case 'turn/end':
        return {
          ...state,
          openTurnStartSeq: null,
        }
      case 'step/start':
        return {
          ...state,
          lastStepStartSeq: event.seq,
          lastStepBoundary: { kind: 'start', seq: event.seq },
        }
      case 'step/end':
        return {
          ...state,
          lastStepBoundary: { kind: 'end', seq: event.seq },
        }
      default:
        return state
    }
  },
} satisfies ProjectionDefinition<'turnBoundary', TurnBoundaryProjection>

/** 将单个收集到的失败原样重抛，或将多个作为单个 `AggregateError` 抛出。 */
function throwCollectedFailures(failures: readonly unknown[], message: string): void {
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, message)
}

/** 工厂级所有权：活跃 agent 的拆除加上配置启动工作。 */
class FactoryOwnership {
  private accepting = true
  private readonly teardown = new AbortController()
  private readonly inactive = Promise.withResolvers<void>()
  private readonly liveAgents = new Set<() => Promise<void>>()
  private startupTasks = new Set<Promise<void>>()

  constructor(private readonly fiber: Context['fiber']) {}

  /** 工厂拆除开始时中止（原因为 `agent loop is not active` 错误）。 */
  get signal(): AbortSignal {
    return this.teardown.signal
  }

  isActive(): boolean {
    return this.accepting && !INACTIVE_STATES.has(this.fiber.state)
  }

  /** 跟踪单个活跃 agent 的共享拆除，直到它已运行。 */
  track(dispose: () => Promise<void>): () => void {
    this.liveAgents.add(dispose)
    return () => { this.liveAgents.delete(dispose) }
  }

  /** 加入在 agent 存在之前开始的配置启动工作。 */
  trackStartup(job: Promise<void>): void {
    this.startupTasks.add(job)
    const forget = () => { this.startupTasks.delete(job) }
    void job.then(forget, forget)
  }

  /** 加入一个公开的 create/resume 延续；工厂 dispose 等待其落定。 */
  trackWrapper(job: Promise<unknown>): void {
    this.trackStartup(job.then(() => undefined, () => undefined))
  }

  /** 解析 `task`，或在工厂拆除开始时停止等待。 */
  async waitWhileActive(job: Promise<void>): Promise<void> {
    await Promise.race([job, this.inactive.promise])
  }

  async dispose(): Promise<void> {
    this.accepting = false
    this.teardown.abort(new Error('agent loop is not active'))
    this.inactive.resolve()
    const settlements = await Promise.allSettled([
      ...[...this.liveAgents].map(dispose => dispose()),
      ...this.startupTasks,
    ])
    const failures: unknown[] = []
    for (const result of settlements) {
      if (result.status === 'rejected') failures.push(result.reason)
    }
    throwCollectedFailures(failures, 'agent loop disposal failed')
  }
}

/** 等待 `operation`，或在信号中止时立即抛出其原因。 */
async function raceAbort<T>(operation: PromiseLike<T> | T, signal: AbortSignal, id: SessionId): Promise<T> {
  const toAbortError = (): Error => signal.reason instanceof Error
    ? signal.reason
    : new Error(`agent "${id}" creation aborted`, { cause: signal.reason })
  if (signal.aborted) throw toAbortError()
  const aborted = Promise.withResolvers<never>()
  const listener = (): void => { aborted.reject(toAbortError()) }
  signal.addEventListener('abort', listener, { once: true })
  try {
    return await Promise.race([Promise.resolve(operation), aborted.promise])
  } finally {
    signal.removeEventListener('abort', listener)
  }
}

/** 启动一个可中止的操作，并释放在取消之后到达的值。 */
async function raceAbortCall<T>(
  operation: () => PromiseLike<T> | T,
  signal: AbortSignal,
  id: SessionId,
  releaseAbandoned?: (value: T) => void,
): Promise<T> {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error(`agent "${id}" creation aborted`, { cause: signal.reason })
  }
  const pending = Promise.resolve().then(operation)
  try {
    return await raceAbort(pending, signal, id)
  } catch (error: unknown) {
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while the operation is awaited.
    if (signal.aborted && releaseAbandoned !== undefined) {
      void pending.then(releaseAbandoned, () => undefined)
    }
    throw error
  }
}

/** 拒绝无法在请求线上精确表示的输出 token 上限。 */
function assertAgentOptions(options: AgentOptions): void {
  if (options.maxTokens !== undefined
    && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0)) {
    throw new TypeError('agent maxTokens must be a positive safe integer')
  }
}

/** 单个会话拥有的写句柄加上通过它已存储的事件计数。 */
interface StoredSession {
  readonly handle: SessionHandle
  storedCount: number
}

/** 已准备但未发布的 agent 资源，共享一个记忆化的拆除。 */
interface PreparedAgent {
  agent: ReactLoopAgent
  /** 在工厂卸载、调用方取消或拆除开始时中止——结束任何 setup 等待。 */
  signal: AbortSignal
  /** 进入两个注册表并等待创建监听器。 */
  publish(source: SessionStartSource): Promise<AgentHandle>
  /** 逆向拆除：停止机器、注销、展开作用域。已记忆化。 */
  dispose(): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentLoop: AgentLoop
    /**
     * 由启动器拥有的已配置 agent 的精确会话身份，以 agent 的配置 `id` 为键，
     * 在任何 Loader 条目挂载前通过 `ctx.provide()` 设置
     * （见 {@link CONFIGURED_AGENT_IDENTITIES_KEY}）。身份由启动器拥有，
     * 因为只有它知道会话是否已存在，而 `cordis.yml` 行将模型路由保留为
     * 普通的可修补配置。没有匹配键的条目保留其配置的身份。
     */
    configuredAgentIdentities?: ConfiguredAgentIdentities
  }
  interface Events {
    /**
     * 一个声明式 agent 条目在发布活跃 agent 之前失败。
     * 为已配置身份缓冲工作的消费方使用这个瞬态信号拒绝该工作，
     * 而不是永远等待。正常的工厂拆除会抑制来自已取消启动尝试的失败。
     * @param payload.sessionId - 启动失败的精确共享 agent/session 身份。
     * @param payload.error - 持久化、setup 或发布失败。
     * @mode emit
     */
    'agent-loop/config-start-failed'(payload: { sessionId: SessionId; error: unknown }): void
  }
}

export { DEFAULT_MAX_PARALLEL_TOOL_CALLS }

/**
 * 为已配置 agent 选择的一个启动器会话身份。`resume` 区分重新水化已有的
 * 持久化历史与在该精确 id 下全新创建会话，两个配置键分别表达为
 * `resumeSessionId` 和 `sessionId`。
 */
export interface LauncherAgentIdentity {
  /** 全新创建或恢复所用的精确会话 id。 */
  id: SessionId
  /** 恢复已有的持久化历史，而不是全新创建会话。 */
  resume: boolean
}

/** 以已配置 agent 的 `id` 为键的启动器所选身份。 */
export interface ConfiguredAgentIdentities extends Readonly<Record<string, LauncherAgentIdentity>> {}

/**
 * 启动器在任何 Loader 条目挂载前设置的上下文键
 * （`ctx.provide(CONFIGURED_AGENT_IDENTITIES_KEY, identities)`），
 * 用于在没有配置键的情况下固定已配置 agent 的会话身份，
 * 使重新指向该行模型路由的 overlay 不会丢失它们。
 */
export const CONFIGURED_AGENT_IDENTITIES_KEY = 'configuredAgentIdentities'

/**
 * 将启动器拥有的身份应用到已配置 agent 上，为启动器点名的每个条目替换两个
 * 身份键，使配置提供的身份永远不会与启动器提供的身份并存。
 * @param agents - 已配置的 agent 条目。
 * @param identities - 以已配置 agent `id` 为键的启动器身份，或 `undefined`。
 * @returns 应用了启动器拥有身份的条目。
 */
function applyLauncherIdentities(
  agents: Config['agents'],
  identities: ConfiguredAgentIdentities | undefined,
): Config['agents'] {
  if (identities === undefined) return agents
  return agents.map((agent) => {
    const identity = identities[agent.id]
    if (identity === undefined) return agent
    const { sessionId: _sessionId, resumeSessionId: _resumeSessionId, ...rest } = agent
    return identity.resume
      ? { ...rest, resumeSessionId: identity.id }
      : { ...rest, sessionId: identity.id }
  })
}

/** agent-loop 插件配置。 */
export interface Config {
  /**
   * 每个 agent 步骤中在途的最大并行安全调用数。`1` 表示串行；
   * 省略时默认为 {@link DEFAULT_MAX_PARALLEL_TOOL_CALLS}。
   */
  maxParallelToolCalls: Volatile<number>
  /** 插件启动时创建或恢复的 agent。 */
  agents: (AgentOptions & {
    /** 用于日志的稳定配置标签，也是全新组合 id 的前缀。 */
    id: string
    /** 可选的稳定身份；重新挂载会恢复其已物化的历史，而首次使用则全新创建。 */
    sessionId?: SessionId
    /** 全新会话的可选工作区。 */
    cwd?: string
    /** 要恢复的持久化会话，而不是创建全新会话。 */
    resumeSessionId?: SessionId
  })[]
}

/** 在任何已配置 agent 启动之前拒绝自包含的身份冲突。 */
function validateConfiguredAgents(agents: Config['agents']): void {
  const exactIdentities = new Map<SessionId, string>()
  for (const { id, sessionId, resumeSessionId } of agents) {
    const hasResumeId = resumeSessionId !== undefined && resumeSessionId !== ''
    if (sessionId !== undefined && hasResumeId) {
      throw new Error(`agent "${id}": sessionId and resumeSessionId are mutually exclusive`)
    }
    const exactIdentity = hasResumeId ? resumeSessionId : sessionId
    if (exactIdentity === undefined) continue
    const firstId = exactIdentities.get(exactIdentity)
    if (firstId !== undefined) {
      throw new Error(`agents "${firstId}" and "${id}" use duplicate exact session identity "${exactIdentity}"`)
    }
    exactIdentities.set(exactIdentity, id)
  }
}

/** 具体 agent 工厂和驱动服务。 */
export class AgentLoop extends Service implements AgentFactory {
  static inject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt', 'sessionProjections']

  /** 声明式 agent 的运行时 schema。 */
  static Config: z<{ agents?: Config['agents']; maxParallelToolCalls?: number }, Config> = z.object({
    maxParallelToolCalls: z.number().step(1).min(1).default(DEFAULT_MAX_PARALLEL_TOOL_CALLS).volatile(),
    agents: z.array(z.object({
      id: z.string().required(),
      sessionId: z.string().min(1),
      provider: z.string(),
      model: z.string(),
      reasoningEffort: z.string().min(1) as z<ReturnType<typeof ReasoningEffortId>>,
      maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
      cwd: z.string(),
      resumeSessionId: z.string(),
    })).default([]),
  }) as z<{ agents?: Config['agents']; maxParallelToolCalls?: number }, Config>

  /** 由 agent-loop 服务拥有的已验证配置。 */
  readonly config: Config
  private readonly ownership: FactoryOwnership
  /** 普通持有器防止 Cordis 通过调用方影子重新追踪工厂的依赖上下文。 */
  private readonly runtime: { ctx: Context }

  constructor(ctx: Context, config: Config) {
    super(ctx, 'agentLoop')

    this.config = {
      agents: applyLauncherIdentities(config.agents, ctx.get(CONFIGURED_AGENT_IDENTITIES_KEY)),
      maxParallelToolCalls: config.maxParallelToolCalls,
    }
    validateConfiguredAgents(this.config.agents)
    // 仅在上方所有配置验证都通过后注册，使被拒绝的构造函数
    // 不会留下任何投影单元。
    const ownership = this.ownership = new FactoryOwnership(ctx.fiber)
    this.runtime = { ctx }
    ctx.effect(function* () {
      const unregisterTurnBoundary = ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
      yield unregisterTurnBoundary
      const unregisterInbox = ctx.sessionProjections.register(inboxProjectionDefinition)
      yield unregisterInbox
      // Cordis 在拒绝之后会跳过后续的 disposer；finally 仍会释放投影。
      yield () => ownership.dispose().finally(() => {
        unregisterInbox()
        unregisterTurnBoundary()
      })
    }, 'agentLoop.transactions()')
    ctx.effect(() => ctx.agents.setFactory(this), 'agentLoop.setFactory()')
    ctx.systemPrompt.variable('provider', context => context.agent?.options.provider)
    ctx.systemPrompt.variable('model', context => context.agent?.options.model)

    for (const { id, sessionId, cwd, resumeSessionId, ...options } of this.config.agents) {
      const meta = cwd === undefined ? {} : { cwd }
      if (resumeSessionId === undefined || resumeSessionId === '') {
        const configuredId = sessionId ?? brandString<SessionId>(`${id}-session-${randomUUID()}`)
        const persistence = sessionId === undefined ? undefined : ctx.get('sessionPersistence')
        if (persistence === undefined) {
          const startup = this.create(configuredId, options, meta).then(() => undefined, (error: unknown) => {
            this.reportConfiguredStartupFailure(id, 'restore', configuredId, error)
          })
          this.ownership.trackStartup(startup)
        } else {
          const startup = this.restoreOrCreateConfigured(ctx, persistence, configuredId, options, meta).catch((error: unknown) => {
            this.reportConfiguredStartupFailure(id, 'restore', configuredId, error)
          })
          this.ownership.trackStartup(startup)
        }
        continue
      }
      ctx.effect(() => {
        const fiber = ctx.inject(['sessionPersistence'], (childCtx: Context) => {
          void this.resumeWith(ctx, childCtx.sessionPersistence, {
            resumeSessionId,
            agentOptions: options,
          }).catch((error: unknown) => {
            this.reportConfiguredStartupFailure(id, 'resume', resumeSessionId, error)
          })
        })
        return fiber.dispose
      }, `agentLoop.resume(${id})`)
    }
  }

  /** 向绑定身份的消费方报告一个已受控的声明式启动失败。 */
  private reportConfiguredStartupFailure(
    configId: string,
    action: 'restore' | 'resume',
    sessionId: SessionId,
    error: unknown,
  ): void {
    if (!this.ownership.isActive()) return
    this.ctx.logger.warn(`agent "${configId}": config-driven ${action} of "${sessionId}" failed: ${errorChain(error)}`)
    const args: unknown[] = ['agent-loop/config-start-failed', { sessionId, error }]
    for (const callback of this.ctx.events.dispatch('emit', args)) {
      try {
        const returned: unknown = callback(...args)
        void Promise.resolve(returned).catch((listenerError: unknown) => {
          this.ctx.logger.warn(`agent "${configId}": config-start-failed listener rejected: ${errorChain(listenerError)}`)
        })
      } catch (listenerError: unknown) {
        this.ctx.logger.warn(`agent "${configId}": config-start-failed listener threw: ${errorChain(listenerError)}`)
      }
    }
  }

  /** 在重新挂载时恢复已物化的精确配置身份，或在首次使用时创建它。 */
  private async restoreOrCreateConfigured(
    ownerCtx: Context,
    persistence: SessionPersistence,
    sessionId: SessionId,
    agentOptions: AgentOptions,
    meta: Pick<SessionHeader, 'cwd'>,
  ): Promise<void> {
    await this.waitForDrainingConfiguredIdentity(ownerCtx, sessionId)
    if (!this.ownership.isActive()) return
    try {
      await this.resumeWith(ownerCtx, persistence, { resumeSessionId: sessionId, agentOptions })
      return
    } catch (error: unknown) {
      if (!this.ownership.isActive()) return
      // 只有真正不存在的已存储会话才回退到首次创建；
      // 损坏、所有权冲突和后端失败保持响亮报错。
      if (!(error instanceof SessionPersistenceNotFoundError)) throw error
    }
    await this.create(sessionId, agentOptions, meta)
  }

  /** 等待正在排空的同 id 生命周期完成注册表拆除。 */
  private async waitForDrainingConfiguredIdentity(ownerCtx: Context, sessionId: SessionId): Promise<void> {
    // 只有仍占据注册表的 id 才需要等待；活跃健康的占据者是一个冲突，
    // 下面的 create/resume 会自行暴露它。
    if (ownerCtx.agents.get(sessionId) === undefined && ownerCtx.sessions.get(sessionId) === undefined) return

    const released = Promise.withResolvers<void>()
    const checkReleased = (): void => {
      if (ownerCtx.agents.get(sessionId) === undefined && ownerCtx.sessions.get(sessionId) === undefined) {
        released.resolve()
      }
    }
    const disposeAgentListener = ownerCtx.on('agent/disposed', () => { checkReleased() })
    const disposeSessionListener = ownerCtx.on('session/disposed', checkReleased)
    try {
      checkReleased()
      await this.ownership.waitWhileActive(released.promise)
    } finally {
      disposeAgentListener()
      disposeSessionListener()
    }
  }

  /**
   * 为新 agent 构造驱动器、作用域和一个记忆化的逆向拆除。
   * 拆除在发布之前注册到工厂和所有者 fiber，
   * 因此 setup 中途的卸载会回滚一切；`signal` 将调用方取消
   * 与生命周期拆除融合，用于 setup 等待。
   */
  private prepare(
    ownerCtx: Context,
    id: SessionId,
    options: AgentOptions,
    session: Session,
    callerSignal?: AbortSignal,
    handle?: SessionHandle,
    parentAgent?: Agent,
  ): PreparedAgent {
    assertAgentOptions(options)
    ownerCtx.fiber.assertActive()
    // 每个调用方都从服务方法同步到达 prepare()，该方法的 Cordis 分发
    // 已要求活跃的工厂 fiber，或者在其等待之后自行重新检查所有权
    // （resume 的加载屏障）。
    /* v8 ignore next -- unreachable backstop, see above */
    if (!this.ownership.isActive()) throw new Error('agent loop is not active')
    if (callerSignal?.aborted) {
      throw callerSignal.reason instanceof Error
        ? callerSignal.reason
        : new Error(`agent "${id}" creation aborted`, { cause: callerSignal.reason })
    }
    const loopCtx = this.runtime.ctx

    // 停用融合三个所有者，各有其原因：调用方的取消信号、所有者 fiber 的
    // 卸载，以及工厂拆除。它注册于任何资源存在之前，基于可变槽位，
    // 因此在作用域仍在铸造时到达的卸载会找到一个可用的
    // disposer，而不是泄漏。
    const abort = new AbortController()
    const onCallerAbort = (): void => {
      abort.abort(callerSignal?.reason instanceof Error
        ? callerSignal.reason
        : new Error(`agent "${id}" creation aborted`, { cause: callerSignal?.reason }))
    }
    const onFactoryTeardown = (): void => { abort.abort(this.ownership.signal.reason) }
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
    this.ownership.signal.addEventListener('abort', onFactoryTeardown, { once: true })

    let machine: ReactLoopAgent | undefined
    let detachSession: (() => void) | undefined
    let detachAgent: (() => void) | undefined
    let disposing: Promise<void> | undefined
    let publication: ReturnType<typeof Promise.withResolvers<void>> | undefined
    const machineReady = Promise.withResolvers<void>()
    // 逆向拆除，已记忆化，使每个竞争的所有者等待同一次静默：
    // 停止机器、展开作用域、排空并关闭会话的写路径、
    // 离开注册表、释放记账。
    const teardown = (): Promise<void> => (disposing ??= (async () => {
      abort.abort(new Error(this.ownership.isActive()
        ? `agent "${id}" lifecycle disposed`
        : 'agent loop is not active'))
      callerSignal?.removeEventListener('abort', onCallerAbort)
      this.ownership.signal.removeEventListener('abort', onFactoryTeardown)
      // 拆除失败会被收集，绝不被吞掉：注册表、作用域和所有权的清理
      // 总是运行到静默，然后记忆化的释放以失败内容拒绝，
      // 使每个竞争的所有者都能观察到它。
      const failures: unknown[] = []
      try {
        // 创建监听器在其等待期间保留会话和作用域。
        if (publication !== undefined) await publication.promise
        // 释放就是一次 disposed 原因的取消加静默。在此之后发送的新工作
        // 是发送方的 bug——注册表即将丢弃该 agent，
        // 因此不应再有东西持有它。
        /* v8 ignore next -- Cordis effect teardown waits for synchronous setup before observing the machine slot. */
        if (machine === undefined) await machineReady.promise
        /* v8 ignore next -- setup failure untracks this disposer before resolving without a machine. */
        if (machine !== undefined) {
          machine.cancel({ kind: 'disposed' })
          await machine.whenIdle()
        }
      } catch (error: unknown) {
        failures.push(error)
      }
      try {
        await machine?.scope.dispose()
      } catch (error: unknown) {
        failures.push(error)
      }
      // 关闭会排空已路由进句柄的事件。后端的活跃事件监听器必须在驱动器
      // 关闭期间保持挂载，以接收所有关闭中的事件。失败的最终排空在此保留，
      // 而不是被日志吞掉。
      try {
        await handle?.close()
      } catch (error: unknown) {
        failures.push(error)
      }
      try {
        detachAgent?.()
        detachSession?.()
      } finally {
        untrack()
      }
      throwCollectedFailures(failures, `agent "${id}" disposal failed`)
    })())
    let unfollowScope: (() => Promise<void> | void) | undefined
    let unfollowOwner: () => Promise<void> | void
    const dispose = async (): Promise<void> => {
      try {
        await teardown()
      } finally {
        await Promise.all([unfollowOwner(), unfollowScope?.()])
      }
    }
    const untrack = this.ownership.track(dispose)
    try {
      unfollowOwner = ownerCtx.effect(function* () {
        const created = machine = new ReactLoopAgent(loopCtx, id, options, session)
        machineReady.resolve()
        // 在其原始 fiber 上收养作用域，使它无法在拆除之前卸载。
        // 在铸造期间已经在卸载的循环自行拥有临时作用域。
        if (!INACTIVE_STATES.has(loopCtx.fiber.state)) {
          unfollowScope = loopCtx.effect(function* () {
            yield created.scope.rawDispose
            yield () => teardown()
          }, `agentLoop.scope(${id})`)
        }
        yield async () => {
          abort.abort(new Error(`agent "${id}" setup aborted: owner disposed during setup`))
          try {
            await teardown()
          } finally {
            await unfollowScope?.()
          }
        }
      }, `agentLoop.lifecycle(${id})`)
      /* v8 ignore start -- ctx.effect throws only on an inactive fiber, which assertActive() above already rejected */
    } catch (error: unknown) {
      machineReady.resolve()
      untrack()
      callerSignal?.removeEventListener('abort', onCallerAbort)
      this.ownership.signal.removeEventListener('abort', onFactoryTeardown)
      throw error
    }
    /* v8 ignore stop */

    const assertLive = (): void => {
      if (!abort.signal.aborted) return
      // 每个融合的中止来源都携带 Error 原因：onCallerAbort 和
      // raceAbort 会包装非 Error 的调用方原因，而工厂/生命周期
      // 所有者以构造的 Error 中止。
      /* v8 ignore next -- unreachable String() arm, see above */
      throw abort.signal.reason instanceof Error ? abort.signal.reason : new Error(String(abort.signal.reason))
    }
    try {
      /* v8 ignore next -- a synchronous effect exhausts the generator before returning */
      if (machine === undefined) throw new Error(`agent "${id}" lifecycle did not construct its driver`)
      const agent = machine
      assertLive()

      return {
        agent,
        signal: abort.signal,
        publish: async (source) => {
          publication = Promise.withResolvers<void>()
          try {
            assertLive()
            detachSession = agent.ctx.sessions.enter(session)
            // The mounted backend routes announced live events into the active
            // write handle by session id; the loop only owns the handle itself.
            detachAgent = loopCtx.agents.enter(agent, parentAgent)
            agent.ctx.sessions.announce(session)
            assertLive()
            await loopCtx.agents.announce(agent, source, abort.signal)
            assertLive()
            return { agent, dispose }
          } finally {
            publication.resolve()
            publication = undefined
          }
        },
        dispose,
      }
    } catch (error: unknown) {
      machineReady.resolve()
      // 回滚吞掉释放拒绝：setup 失败才是主要的。
      void dispose().catch(() => {})
      throw error
    }
  }

  /**
   * 在一个调用方提供的身份下创建 agent 和会话，由访问的 fiber 拥有。
   * 构造函数驱动的配置调用在进入此边界之前铸造全新的组合 id。
   * 当挂载了持久化后端时，会话的持久身份和任何种子在发布之前存储。
   * @param id - 共享的 agent/session 身份。
   * @param options - 具体的循环选项。
   * @param meta - 可选的全新会话工作区元数据。
   * @returns 已发布的运行中 agent。
   */
  async create(id: SessionId, options: AgentOptions = {}, meta: Pick<SessionHeader, 'cwd'> = {}): Promise<Agent> {
    using preparation = SessionPreparation.create(this.runtime.ctx.sessions.prepare(id, { meta }))
    const stored = await this.createStoredSession(preparation.session)
    let prepared: PreparedAgent
    try {
      prepared = this.prepare(this.ctx, id, options, preparation.session, undefined, stored?.handle)
    } catch (error: unknown) {
      await stored?.handle.close().catch(() => {})
      throw error
    }
    return (await this.initializeAgent(prepared, async () => {
      await this.appendUnstoredSuffix(stored, preparation.session)
      return await prepared.publish('startup')
    })).agent
  }

  /**
   * 在挂载持久化时接管全新会话的写所有权。
   * 这里不追加任何内容：构造函数种子（它从不通过 `session/event`
   * 重新发出）由 `appendUnstoredSuffix` 在发布提交点存储，因此失败或
   * 取消的验证或 setup 会关闭一个未物化的句柄，不留下任何已存储的残留——
   * 同一个 id 可以再次创建。
   * @param session - 要存储的未发布会话。
   * @param signal - 转发给后端 create 的可选取消。
   * @returns 拥有的句柄和已存储游标，无后端时为 `undefined`。
   */
  private async createStoredSession(session: Session, signal?: AbortSignal): Promise<StoredSession | undefined> {
    const persistence = this.runtime.ctx.get('sessionPersistence')
    if (persistence === undefined) return undefined
    const handle = await persistence.create(session.header, {
      inheritedEventCount: session.inheritedEventCount,
      ...signal === undefined ? {} : { signal },
    })
    return { handle, storedCount: 0 }
  }

  /**
   * 持久存储自上次已存储游标以来追加的会话事件。
   * 发布前的追加（构造函数种子标记、setup 窗口内的事件如委派策略记录）
   * 从不通过 `session/event` 重新发出，因此发布必须在活跃事件开始
   * 路由进入之前通过句柄刷新它们。
   * @param stored - 会话拥有的句柄和已存储游标（如有）。
   * @param session - 其后缀要被存储的未发布会话。
   */
  private async appendUnstoredSuffix(stored: StoredSession | undefined, session: Session): Promise<void> {
    if (stored === undefined) return
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const suffix = session.snapshotEvents(SessionLogOffset(stored.storedCount))
    if (suffix.length > 0) await stored.handle.append(suffix)
    // 按已存储的数量推进，而不是推进到 `session.seq`：在等待期间追加的
    // 事件必须保持未存储状态，留给下一次刷新。
    stored.storedCount += suffix.length
  }

  /**
   * 在调用方提供的会话 id 上创建拥有的 agent。
   * @param ownerCtx - 在结构上拥有该生命周期的调用方上下文。
   * @param options - 身份、可选的活跃父级、会话种子/元数据、循环选项、setup 和取消。
   * @returns 已发布的句柄。
   */
  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    const preparation = SessionPreparation.create(this.runtime.ctx.sessions.prepare(options.sessionId, {
      ...options.seed === undefined ? {} : { seed: options.seed },
      ...options.meta === undefined ? {} : { meta: options.meta },
      ...options.inheritedEventCount === undefined ? {} : { inheritedEventCount: options.inheritedEventCount },
    }))
    const published = (async () => {
      let stored: StoredSession | undefined
      try {
        // raceAbortCall 将预先中止或创建中途的中止规范化，
        // 并关闭在被放弃之后才完成创建的句柄。
        stored = options.signal === undefined
          ? await this.createStoredSession(preparation.session)
          : await raceAbortCall(
            () => this.createStoredSession(preparation.session, options.signal),
            options.signal,
            options.sessionId,
            (abandoned) => { void abandoned?.handle.close().catch(() => {}) },
          )
      } catch (error: unknown) {
        preparation[Symbol.dispose]()
        throw error
      }
      return this.setupAndPublish(
        ownerCtx,
        options.sessionId,
        preparation,
        options.agentOptions ?? {},
        options.setup,
        options.signal,
        'startup',
        stored,
        options.parentAgent,
      )
    })()
    this.ownership.trackWrapper(published)
    return published
  }

  /** 围绕已获取的 Session 准备一个 Agent，运行 setup，并发布它。 */
  private async setupAndPublish(
    ownerCtx: Context,
    id: SessionId,
    preparation: SessionPreparation,
    agentOptions: AgentOptions,
    setup: AgentSetup | undefined,
    signal: AbortSignal | undefined,
    source: SessionStartSource,
    stored?: StoredSession,
    parentAgent?: Agent,
  ): Promise<AgentHandle> {
    using ownedPreparation = preparation
    const session = ownedPreparation.session
    let prepared: PreparedAgent
    try {
      prepared = this.prepare(ownerCtx, id, agentOptions, session, signal, stored?.handle, parentAgent)
    } catch (error: unknown) {
      await stored?.handle.close().catch(() => {})
      throw error
    }
    return await this.initializeAgent(prepared, async () => {
      const setupCommit = await raceAbort(setup?.(prepared.agent.ctx, prepared.agent), prepared.signal, id)
      setupCommit?.commit()
      await this.appendUnstoredSuffix(stored, session)
      return await prepared.publish(source)
    })
  }

  private async initializeAgent(prepared: PreparedAgent, initialize: () => Promise<AgentHandle>): Promise<AgentHandle> {
    try {
      return await prepared.agent.runMaintenance(async () => {
        try {
          return await initialize()
        } catch (error: unknown) {
          // 拆除拥有收件箱清理，并且可能已移除其投影。
          prepared.agent.cancel({ kind: 'disposed' }, { keepInbox: true })
          throw error
        }
      })
    } catch (error: unknown) {
      // 回滚吞掉释放拒绝（失败的最终句柄关闭）：
      // setup 失败是调用方必须看到的主要错误。
      await prepared.dispose().catch(() => {})
      throw error
    }
  }

  /**
   * 从配置的持久化服务恢复拥有的 agent。
   * @param ownerCtx - 拥有加载、setup 和活跃生命周期的调用方上下文。
   * @param options - 持久化身份、可选的活跃父级、循环选项、setup 和取消。
   * @returns 已发布的句柄。
   */
  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    const persistence = this.runtime.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new Error('cannot resume: session persistence is not configured (load a dsh-session-persistence backend)')
    }
    return this.resumeWith(ownerCtx, persistence, options)
  }

  /** 通过延迟配置路径使用的显式持久化句柄进行恢复。 */
  private resumeWith(
    ownerCtx: Context,
    persistence: SessionPersistence,
    options: ResumeAgentOptions,
  ): Promise<AgentHandle> {
    const id = options.resumeSessionId
    const published = (async () => {
      // 打开和读取可能比其所有者更长寿：将它们与调用方取消、所有者 fiber
      // 卸载和工厂拆除竞争，使永不落定的后端无法钉住该身份。
      const ownerAbort = new AbortController()
      const unfollowOwner = ownerCtx.effect(() => () => {
        ownerAbort.abort(new Error(`agent "${id}" setup aborted: owner disposed during setup`))
      }, `agentLoop.resume-load(${id})`)
      const fused = AbortSignal.any([
        ...options.signal === undefined ? [] : [options.signal],
        ownerAbort.signal,
        this.ownership.signal,
      ])
      let handle: SessionHandle | undefined
      let stored: StoredSession | undefined
      let preparation: SessionPreparation | undefined
      try {
        try {
          // 先取得写所有权可以排除同一 id 的并发恢复
          // （在此进程中，活跃 agent 的句柄持有该声明）。
          handle = await raceAbortCall(
            () => persistence.open(id, 'write', { signal: fused }),
            fused,
            id,
            (abandoned) => { void abandoned.close() },
          )
          // 语义崩溃修复是 agent 层的职责：持久化交还物理有效的日志；
          // 被中断的最终 turn 会收到合成闭合器（缺失的工具错误、step/end、
          // turn/end），它们像普通批次一样通过同一句柄追加。
          const coldRead = await handle.read(0, undefined, { signal: fused })
          fused.throwIfAborted()
          const persisted = coldRead.events
          const closers = interruptedTurnClosers(persisted)
          if (closers.length > 0) await handle.append(closers)
          preparation = SessionPreparation.create(this.runtime.ctx.sessions.prepare(id, {
            seed: [...persisted, ...closers],
            meta: structuredClone(handle.header),
            inheritedEventCount: handle.inheritedEventCount,
            eventState: coldRead.eventState,
          }))
          stored = { handle, storedCount: persisted.length + closers.length }
          await this.appendUnstoredSuffix(stored, preparation.session)
        } finally {
          await unfollowOwner()
        }
        ownerCtx.fiber.assertActive()
        if (!this.ownership.isActive()) throw new Error('agent loop is not active')
        const owned = stored
        handle = undefined // ownership passes to setupAndPublish/prepare
        return await this.setupAndPublish(
          ownerCtx,
          id,
          preparation,
          options.agentOptions ?? {},
          options.setup,
          options.signal,
          'resume',
          owned,
          options.parentAgent,
        )
      } finally {
        preparation?.[Symbol.dispose]()
        await handle?.close().catch(() => {})
      }
    })()
    this.ownership.trackWrapper(published)
    return published
  }
}

export default AgentLoop
