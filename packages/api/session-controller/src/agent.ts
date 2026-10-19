/** 由 API Session 拥有的 Agent 激活、组合与模型选择策略。 */

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type {
  Agent, AgentOptions, AgentSetup, ModelSelection as AgentModelSelection, ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import { SessionQueryError, type SessionObservation } from '@deepseek-ai/dsh-session-query'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-typert-registry'
import type { ModelSelection } from './types.ts'

/** 持久化中不存在的冷 Session 标识。 */
export class ApiSessionNotFound extends Error {}

/** 其生命周期属于 subagent 路由的 Session 标识。 */
export class ApiSessionSubagentOwnership extends Error {
  /** @param sessionId - 保留给 subagent 路由的标识。 */
  constructor(readonly sessionId: SessionId) {
    super(`session "${sessionId}" is a subagent session; use subagent delivery`)
  }
}

/** 显式 id 创建试图将一个 Session 收养到另一个 cwd 下。 */
export class ApiSessionCwdConflict extends Error {
  constructor(
    readonly sessionId: SessionId,
    readonly requestedCwd: string,
    readonly existingCwd: string | undefined,
  ) {
    super(
      existingCwd === undefined
        ? `session "${sessionId}" records no cwd and cannot be adopted for "${requestedCwd}"`
        : `session "${sessionId}" belongs to "${existingCwd}", not "${requestedCwd}"`,
    )
  }
}

/** 在部署未组合预设名册时，复用一个命名了 Agent 预设的 Session。 */
export class ApiSessionPresetConflict extends Error {
  constructor(
    readonly sessionId: SessionId,
    readonly requestedPreset: string,
  ) {
    super(`the deployment composes no agent preset roster, so session "${sessionId}" cannot run preset "${requestedPreset}"`)
  }
}

/** 被选中复用的空白 Session 在本 Host 获得其写入者之前开始了一个回合。 */
class ApiSessionStartedSinceObserved extends Error {}

/** 为新对话创建的一个 Session 的位置与 Agent 预设。 */
export interface ApiSessionCreateRequest {
  /** 待复用的空白 Session；当该标识下未存储任何 Session 时作为新 Session 的标识。 */
  readonly sessionId?: SessionId
  /** Session 拥有的目录。 */
  readonly cwd: string
  /** Session 运行的预设；省略时使用配置的默认值。 */
  readonly agentPreset?: string
  /**
   * 调用方拥有的位置规则，例如 Workspace 成员关系与归档状态。
   * @param sessionId - 请求所命名的既有 Session。
   * @returns 该 Session 是否可以被复用。
   */
  readonly reusable: (sessionId: SessionId) => boolean
}

/** 一次创建请求创建或复用的 Session。 */
export interface ApiSessionCreated {
  /** 该 Session 的活跃 Agent。 */
  readonly agent: Agent
  /** 请求结束时该 Session 运行的预设，先于对同一标识的后续请求；无名册时缺失。 */
  readonly agentPreset: string | undefined
}

/** 一次创建或恢复的已解析预设与发布前 Agent 安装。 */
interface ApiSessionComposition {
  readonly agentPreset?: string
  readonly setup: AgentSetup
}

/** 将一个普通 Session 标识解析到其活跃 Agent 时产生的失败。 */
export type ApiSessionAgentError = RemoteError<'session/not-found' | 'session/agent-busy' | 'session/writer-held' | 'gateway/internal'>

/** 将一个普通 Session 标识解析到其活跃 Agent 的结果。 */
export type ApiSessionAgentResult =
  | { readonly agent: Agent }
  | { readonly error: ApiSessionAgentError }

type InstalledSelection = ModelSelectionRef & {
  current: AgentModelSelection
  consume(provider: string, model: string, reasoningEffort: string | undefined): boolean
}

/**
 * 测试通用 Session 路由是否必须把一个标识留给 subagent 路由。
 * @param ctx - 携带 Agent 所有权注册表的 Host 上下文。
 * @param session - 被测试所有权的已附加或活跃 Session。
 * @param agent - 该 Session 存在时的活跃 Agent。
 * @returns subagent 路由是否拥有该 Session 标识。
 */
export function hasApiSessionSubagentOwner(
  ctx: Context,
  session: Pick<Session, 'header'>,
  agent: Agent | undefined,
): boolean {
  if (session.header.origin === 'subagent') return true
  const parentId = session.header.parentSession
  if (parentId === undefined || agent === undefined) return false
  const parent = ctx.agents.get(parentId)
  return parent !== undefined && ctx.agents.isOwnedBy(agent.id, parent)
}

/**
 * 构建稳定的面向调用方的 subagent 所有权拒绝。
 * @param sessionId - 由 subagent 路由拥有的 Session 标识。
 * @returns 一个稳定的 Session 域失败。
 */
export function apiSessionSubagentOwnershipError(sessionId: SessionId): ApiSessionAgentError {
  return new RemoteError(
    'session/agent-busy',
    `session "${sessionId}" is owned by subagent routing`,
    { reason: 'use subagent delivery for this child session' },
  )
}

/**
 * 检查一个冷 Session，不修复、恢复或发布它。
 * @param ctx - 携带 Session 持久化的 Host 上下文。
 * @param sessionId - 持久化 Session 标识。
 * @param signal - 持久化读取的可选取消。
 * @returns 持久化 header 与完整事件前缀。
 */
export async function inspectApiSession(
  ctx: Context,
  sessionId: SessionId,
  signal?: AbortSignal,
): Promise<SessionInspection> {
  try {
    using observation = await ctx.sessionQuery.observeSession(sessionId, {
      ...(signal === undefined ? {} : { signal }),
      projectionMode: 'none',
    })
    if (observation.header.cwd === undefined) {
      throw new ApiSessionNotFound(`session "${sessionId}" not found`)
    }
    return {
      meta: observation.header,
      inheritedEventCount: observation.inheritedEventCount,
      events: [...observation.events],
    }
  } catch (error: unknown) {
    if (error instanceof SessionQueryError
      && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
      throw new ApiSessionNotFound(`session "${sessionId}" not found`)
    }
    throw error
  }
}

/** 拥有可能创建、恢复或配置 Web Agent 的每个操作。 */
export class ApiSessionAgentController {
  private readonly resumes = new Map<SessionId, Promise<Agent>>()
  private readonly claims = new Map<SessionId, Promise<void>>()
  private readonly selections = new WeakMap<Agent, InstalledSelection>()
  private readonly imageAdmissionChains = new WeakMap<Agent, Promise<void>>()

  /** @param ctx - 携带 Agent、模型、持久化与 Typert 服务的 Host 上下文。 */
  constructor(private readonly ctx: Context) {
    ctx.typert.lookups.configure('agent', async (sessionId: SessionId) => {
      const found = await this.resolveAgent(sessionId)
      if ('error' in found) throw found.error
      return found.agent
    })
    ctx.typert.lookups.configure('session', async (sessionId: SessionId) => {
      const found = await this.resolveAgent(sessionId)
      if ('error' in found) throw found.error
      return found.agent.session
    })
    ctx.typert.contexts.configureHost('agent', async (sessionId: SessionId) => {
      const found = await this.resolveAgent(sessionId)
      if ('error' in found) throw found.error
      return found.agent.ctx
    })
  }

  /**
   * 解析或恢复一个普通 Session，对并发恢复去重。
   * @param sessionId - 普通 Session 标识。
   * @returns 活跃 Agent 或稳定的 Session 域失败。
   */
  async resolveAgent(sessionId: SessionId): Promise<ApiSessionAgentResult> {
    return this.resolve(sessionId)
  }

  /**
   * 从一个已保留的精确观察解析一个普通 Session。
   * @param observation - Host 拥有的观察，其准备工作在安装完成前保持固定。
   * @returns 活跃 Agent 或稳定的 Session 域失败。
   */
  async resolveObservedAgent(observation: SessionObservation): Promise<ApiSessionAgentResult> {
    return this.resolve(observation.header.id, observation)
  }

  private async resolve(
    sessionId: SessionId,
    observation?: SessionObservation,
  ): Promise<ApiSessionAgentResult> {
    const live = this.liveAgent(sessionId)
    if (live !== undefined) return live
    const attached = this.ctx.sessions.get(sessionId)
    if (attached !== undefined && hasApiSessionSubagentOwner(this.ctx, attached, undefined)) {
      return { error: apiSessionSubagentOwnershipError(sessionId) }
    }

    let resume = this.resumes.get(sessionId)
    if (resume === undefined) {
      resume = this.resume(sessionId, observation).finally(() => { this.resumes.delete(sessionId) })
      this.resumes.set(sessionId, resume)
    }
    try {
      const agent = await resume
      // 共享的恢复可能会发布一个标识，而 subagent 路由可能在每个
      // 等待者观察到它之前就已采用；再次应用活跃所有权策略。
      const published = this.liveAgent(sessionId)
      return published ?? { agent }
    } catch (error: unknown) {
      if (error instanceof ApiSessionNotFound) {
        return { error: new RemoteError('session/not-found', error.message, { sessionId }) }
      }
      if (error instanceof ApiSessionSubagentOwnership) {
        return { error: apiSessionSubagentOwnershipError(error.sessionId) }
      }
      const raced = this.liveAgent(sessionId)
      if (raced !== undefined) return raced
      const racedSession = this.ctx.sessions.get(sessionId)
      if (racedSession !== undefined && hasApiSessionSubagentOwner(this.ctx, racedSession, undefined)) {
        return { error: apiSessionSubagentOwnershipError(sessionId) }
      }
      if (error instanceof Error && error.name === 'SessionAlreadyOwnedError') {
        return { error: new RemoteError('session/writer-held', error.message, { sessionId }) }
      }
      return {
        error: new RemoteError(
          'gateway/internal',
          `resume failed for session "${sessionId}": ${String(error)}`,
          {},
        ),
      }
    }
  }

  /**
   * 为新对话创建 Session，在命名的空白 Session 仍可复用时复用它。
   * 被复用的 Session 运行请求的预设，或当请求未命名时使用配置的
   * 默认值；其已记录的预设不会被重新解析，变更会在 Agent 发布
   * 之前记录为 `agent-preset/selected`。已开始回合、未通过调用方
   * 位置规则或正被其他拥有者写入的命名 Session 保持不变，
   * 而是创建一个新 Session。命名同一标识的请求按到达顺序运行，
   * 包括其预设解析，并在解析预设之前检查命名 Session 的目录与所有权。
   * @param request - 可选的待复用 Session、目录、预设与位置规则。
   * @returns 被复用或创建的 Session，以及本请求结束时它运行的预设。
   * @throws ApiSessionCwdConflict 当命名的 Session 属于另一个目录时。
   * @throws ApiSessionSubagentOwnership 当 subagent 路由拥有该命名 Session 时。
   * @throws RemoteError 对请求的或默认的预设返回 `agent-preset/not-found` 或 `agent-preset/invalid`。
   * @throws ApiSessionPresetConflict 当未组合名册而请求为一个被复用的 Session 命名预设时。
   */
  async createSession(request: ApiSessionCreateRequest): Promise<ApiSessionCreated> {
    const named = request.sessionId
    if (named === undefined) return this.created(await this.createMinted(request.cwd, await this.composeAgent(request.agentPreset)))
    return this.inOrder(named, async () => this.created(await this.claim(named, request)))
  }

  /**
   * 安装或返回提示词组装所使用的 Session 本地模型选择。
   * @param agent - 拥有该选择的活跃 Agent。
   * @returns 已安装的可变选择引用。
   */
  selectionFor(agent: Agent): InstalledSelection {
    const installed = this.selections.get(agent)
    if (installed !== undefined) return installed
    const projectionState = this.ctx.sessionProjections.stateOf(agent.session, 'modelSelection')
    if (projectionState === undefined) {
      throw new Error('api-session: required modelSelection projection is not registered')
    }
    let picked = projectionState.pending === null
      ? undefined
      : agentModelSelection(projectionState.pending)
    const defaultModel = this.ctx.agentDefaultModel
    const selection: InstalledSelection = {
      get current(): AgentModelSelection {
        if (picked !== undefined) return picked
        const loggedHeader = agent.session.requestHeader()
        if (loggedHeader === undefined) return defaultModel.currentSelection()
        const logged = loggedHeader.config
        return {
          provider: logged.provider,
          model: logged.model,
          // 由适配器默认的力度不是对话选择：将其作为选择恢复
          // 会让未变化的默认值被读作请求变更。
          ...(logged.reasoningEffort === undefined
            || loggedHeader.adapterDefaults?.reasoningEffort === true
            ? {}
            : { reasoningEffort: logged.reasoningEffort }),
        }
      },
      set current(next: AgentModelSelection) {
        picked = next
      },
      consume(provider: string, model: string, reasoningEffort: string | undefined): boolean {
        if (picked?.provider !== provider
          || picked.model !== model
          || picked.reasoningEffort !== reasoningEffort) return false
        picked = undefined
        return true
      },
      assembled: undefined,
    }
    installModelSelection(agent.ctx, selection)
    this.selections.set(agent, selection)
    return selection
  }

  /**
   * 提交并缓存一个已验证的选择，供下一次提示词组装使用。
   * @param agent - 拥有该选择的活跃 Agent。
   * @param selection - 要记录并应用的已验证选择。
   */
  selectForNextRequest(agent: Agent, selection: AgentModelSelection): void {
    agent.session.append('model/selection', selection)
    this.selectionFor(agent).current = selection
  }

  /**
   * 让匹配的持久化请求 header 使执行缓存失效。
   * @param agent - 其请求被记录的活跃 Agent。
   * @param provider - 请求使用的提供方路由。
   * @param model - 请求使用的提供方拥有的模型。
   * @param reasoningEffort - 请求使用的适配器拥有的力度。
   * @returns 待处理选择是否被消费。
   */
  consumeSelection(
    agent: Agent,
    provider: string,
    model: string,
    reasoningEffort: string | undefined,
  ): boolean {
    return this.selections.get(agent)?.consume(provider, model, reasoningEffort) ?? false
  }

  /**
   * 从 Session 投影读取当前 Agent 预设。
   * @param session - 其投影状态可用的活跃 Session。
   * @returns 当前预设，或该能力缺失时为 undefined。
   */
  presetForSession(session: Session): string | undefined {
    return this.ctx.sessionProjections.stateOf(session, 'agentPreset') ?? undefined
  }

  /**
   * 为一个 Agent 串行化图片接纳与模型选择。
   * @param agent - 拥有该串行化链的活跃 Agent。
   * @param operation - 在先前工作落定之后被接纳的异步操作。
   * @returns 操作结果或拒绝。
   */
  serializeImageAdmission<Value>(agent: Agent, operation: () => Promise<Value>): Promise<Value> {
    const result = (this.imageAdmissionChains.get(agent) ?? Promise.resolve()).then(operation)
    this.imageAdmissionChains.set(agent, result.then(() => undefined, () => undefined))
    return result
  }

  /**
   * 为一次创建或恢复解析预设 id 与发布前 Agent 安装。
   * @param presetId - 请求的预设，或省略时使用配置的默认值。
   * @returns 已解析的预设标识与 Agent 安装回调。
   */
  async composeAgent(presetId: string | undefined): Promise<ApiSessionComposition> {
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) {
      return { setup: (_agentCtx, agent) => { this.installSelection(agent) } }
    }
    const resolvedId = (await presets.resolve(presetId)).id
    return {
      agentPreset: resolvedId,
      setup: async (agentCtx, agent) => {
        this.installSelection(agent)
        await presets.mount(agentCtx, resolvedId)
      },
    }
  }

  private liveAgent(sessionId: SessionId): ApiSessionAgentResult | undefined {
    const agent = this.ctx.agents.get(sessionId)
    if (agent === undefined) return undefined
    return hasApiSessionSubagentOwner(this.ctx, agent.session, agent)
      ? { error: apiSessionSubagentOwnershipError(sessionId) }
      : { agent }
  }

  private async resume(sessionId: SessionId, supplied?: SessionObservation): Promise<Agent> {
    if (supplied !== undefined) return this.resumeObserved(sessionId, supplied)
    try {
      using observation = await this.ctx.sessionQuery.observeSession(sessionId)
      return await this.resumeObserved(sessionId, observation)
    } catch (error: unknown) {
      if (error instanceof SessionQueryError
        && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
        throw new ApiSessionNotFound(`session "${sessionId}" not found`)
      }
      throw error
    }
  }

  private async resumeObserved(
    sessionId: SessionId,
    observation: SessionObservation,
  ): Promise<Agent> {
    if (observation.header.id !== sessionId || observation.header.cwd === undefined) {
      throw new ApiSessionNotFound(`session "${sessionId}" not found`)
    }
    if (hasApiSessionSubagentOwner(this.ctx, { header: observation.header }, undefined)) {
      throw new ApiSessionSubagentOwnership(sessionId)
    }
    const composition = await this.composeAgent(this.presetForObservation(observation))
    const published = this.ctx.sessions.get(sessionId)
    const live = this.ctx.agents.get(sessionId)
    if (published !== undefined && hasApiSessionSubagentOwner(this.ctx, published, live)) {
      throw new ApiSessionSubagentOwnership(sessionId)
    }
    return (await this.ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: this.agentOptions(),
      setup: composition.setup,
    })).agent
  }

  private async inOrder<Value>(sessionId: SessionId, operation: () => Promise<Value>): Promise<Value> {
    const result = (this.claims.get(sessionId) ?? Promise.resolve()).then(operation)
    const settled = result.then(() => undefined, () => undefined)
    this.claims.set(sessionId, settled)
    try {
      return await result
    } finally {
      if (this.claims.get(sessionId) === settled) this.claims.delete(sessionId)
    }
  }

  /** @returns 被复用的 Session；当该标识下没有存储时为 `sessionId` 下的新 Session，否则为新生成标识下的新 Session。 */
  private async claim(sessionId: SessionId, request: ApiSessionCreateRequest): Promise<Agent> {
    const attached = this.ctx.sessions.get(sessionId)
    const live = this.ctx.agents.get(sessionId)
    if (attached !== undefined && hasApiSessionSubagentOwner(this.ctx, attached, live)) {
      throw new ApiSessionSubagentOwnership(sessionId)
    }
    if (live !== undefined) {
      if (live.session.header.cwd !== request.cwd) {
        throw new ApiSessionCwdConflict(live.id, request.cwd, live.session.header.cwd)
      }
      const composition = await this.composeAgent(request.agentPreset)
      return await this.reuseLive(live, request, composition) ?? this.createMinted(request.cwd, composition)
    }
    let observation: SessionObservation
    try {
      observation = await this.ctx.sessionQuery.observeSession(sessionId)
    } catch (error: unknown) {
      if (!(error instanceof SessionQueryError) || error.code !== 'SESSION_QUERY_SESSION_NOT_FOUND') throw error
      return this.createAgent(sessionId, request.cwd, await this.composeAgent(request.agentPreset))
    }
    let reusable: boolean
    {
      using observed = observation
      if (hasApiSessionSubagentOwner(this.ctx, { header: observed.header }, undefined)) {
        throw new ApiSessionSubagentOwnership(sessionId)
      }
      if (observed.header.cwd !== request.cwd) {
        throw new ApiSessionCwdConflict(sessionId, request.cwd, observed.header.cwd)
      }
      reusable = request.reusable(sessionId) && !observed.events.some(event => event.type === 'turn/start')
    }
    const composition = await this.composeAgent(request.agentPreset)
    if (!reusable) return this.createMinted(request.cwd, composition)
    this.assertPresetApplicable(sessionId, request.agentPreset)
    try {
      return (await this.ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: this.agentOptions(),
        setup: this.reuseSetup(composition),
      })).agent
    } catch (error: unknown) {
      if (error instanceof ApiSessionStartedSinceObserved) return this.createMinted(request.cwd, composition)
      if (!(error instanceof Error) || error.name !== 'SessionAlreadyOwnedError') throw error
      // 本进程中的另一次恢复可能持有它所发布 Agent 的写入者。
      return this.ctx.agents.get(sessionId) === undefined
        ? this.createMinted(request.cwd, composition)
        : this.claim(sessionId, request)
    }
  }

  /** @returns 所请求预设下的活跃空白 Session，或在其不能被复用时为 undefined。 */
  private async reuseLive(
    live: Agent,
    request: ApiSessionCreateRequest,
    composition: ApiSessionComposition,
  ): Promise<Agent | undefined> {
    if (!request.reusable(live.id) || !this.isBlank(live.session)) return undefined
    this.assertPresetApplicable(live.id, request.agentPreset)
    const current = this.presetForSession(live.session)
    const presets = this.ctx.get('agentPresets')
    const target = composition.agentPreset
    if (presets === undefined || target === undefined || target === current) return live
    try {
      await presets.select(live, target)
    } catch (error: unknown) {
      if (remoteErrorOf(error)?.code !== 'agent-preset/locked') throw error
      return undefined
    }
    return live
  }

  /** 在获取写入者后重新检查空白状态、并在发布前记录预设变更的安装。 */
  private reuseSetup(composition: ApiSessionComposition): AgentSetup {
    return async (agentCtx, agent) => {
      if (!this.isBlank(agent.session)) throw new ApiSessionStartedSinceObserved()
      const commit = await composition.setup(agentCtx, agent)
      const target = composition.agentPreset
      if (target !== undefined && this.presetForSession(agent.session) !== target) {
        agent.session.append('agent-preset/selected', { agentPreset: target })
      }
      return commit
    }
  }

  /** 是否尚未开始任何回合，采用预设注册表 `select` 强制执行的判定。 */
  private isBlank(session: Session): boolean {
    const boundary = this.ctx.sessionProjections.stateOf(session, 'turnBoundary')
    return boundary === undefined || (boundary.openTurnStartSeq === null && boundary.lastTurn === 0)
  }

  /** 没有名册时，复用无法应用命名预设。 */
  private assertPresetApplicable(sessionId: SessionId, requested: string | undefined): void {
    if (requested === undefined || this.ctx.get('agentPresets') !== undefined) return
    throw new ApiSessionPresetConflict(sessionId, requested)
  }

  private created(agent: Agent): ApiSessionCreated {
    return { agent, agentPreset: this.presetForSession(agent.session) }
  }

  private createMinted(cwd: string, composition: ApiSessionComposition): Promise<Agent> {
    return this.createAgent(brandString<SessionId>(`session-${randomUUID()}`), cwd, composition)
  }

  private async createAgent(sessionId: SessionId, cwd: string, composition: ApiSessionComposition): Promise<Agent> {
    try {
      await mkdir(cwd, { recursive: true })
    } catch (error: unknown) {
      throw new Error(`failed to ensure project directory "${cwd}": ${String(error)}`, { cause: error })
    }
    return (await this.ctx.agents.create({
      sessionId,
      agentOptions: this.agentOptions(),
      meta: {
        cwd,
        ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }),
      },
      setup: composition.setup,
    })).agent
  }

  private agentOptions(): AgentOptions {
    const { provider, model } = this.ctx.agentDefaultModel.currentSelection()
    return { provider, model }
  }

  private installSelection(agent: Agent): void {
    this.selectionFor(agent)
  }

  /**
   * 从全投影观察读取当前 Agent 预设。
   * @param observation - 携带其投影快照的精确 Session 观察。
   * @returns 当前预设，或该能力缺失时为 undefined。
   */
  presetForObservation(observation: SessionObservation): string | undefined {
    if (observation.projections === undefined) {
      throw new Error('api-session: Agent activation requires a projected Session observation')
    }
    return observation.projections.values.agentPreset ?? undefined
  }
}

function agentModelSelection(selection: ModelSelection): AgentModelSelection {
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) }),
  }
}
