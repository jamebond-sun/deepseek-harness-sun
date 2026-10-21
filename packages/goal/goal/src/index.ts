/**
 * 同会话 goal 领域：事件溯源状态、比较并设置（CAS）式变更，以及进程本地的
 * 续跑激活状态。
 * @module @deepseek-ai/dsh-goal
 */

import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import {
  applyGoalEvent,
  goalChangeRef,
} from './fold.ts'
import type { GoalFoldState } from './fold.ts'
import {
  GOAL_CHANGE_VERSION,
  GoalError,
  GoalId,
} from './runtime.ts'
import type {
  CreateGoalRequest,
  CreateGoalResult,
  EditGoalRequest,
  GoalActivation,
  GoalBlockReason,
  GoalPhase,
  GoalProjection,
  GoalProjectionState,
  GoalRef,
  GoalSnapshot,
  GoalView,
} from './types.ts'
import type {
  GoalChangeMeta,
  GoalChanged,
  GoalClearChangeMeta,
  GoalOperation,
  GoalSnapshotChangeMeta,
} from './domain.ts'

// 把纯载荷出口（./types.ts，`goal` 投影键声明的唯一归属）再导出到包根，
// 使模块边界保留在产出的 index.d.ts 中，这样消费这些声明的聚合程序仍能
// 收到 SessionProjectionStateMap 的合并结果。
export type * from './types.ts'
export type * from './domain.ts'
export { GOAL_CHANGE_VERSION, GoalError, GoalId } from './runtime.ts'
export { decodeGoalChange, foldGoal, goalChangeRef } from './fold.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    goals: GoalService
  }
}

/** `goal` 投影的线上载荷 schema（当前目标，或 create 前/已清除时的 null）。 */
const goalProjectionSchema: ZodType<GoalProjection | null> = zod.union([
  zod.object({
    goal: zod.object({
      id: zod.string().min(1),
      revision: zod.number().int().positive(),
      objective: zod.string().min(1),
      phase: zod.union([zod.literal('active'), zod.literal('paused'), zod.literal('blocked'), zod.literal('complete')]),
      blockedReason: zod.object({ code: zod.string(), message: zod.string() }).optional(),
      maxGoalRounds: zod.number().int().positive(),
    }),
    roundsStarted: zod.number().int().nonnegative(),
    createdAt: zod.number(),
    updatedAt: zod.number(),
  }),
  zod.null(),
]) as ZodType<GoalProjection | null>

const goalProjectionStateSchema: ZodType<GoalProjectionState> = zod.object({
  current: goalProjectionSchema,
  seenGoalIds: zod.array(zod.string().min(1)).refine(
    ids => new Set(ids).size === ids.length,
    { message: 'seen goal ids must be unique' },
  ),
  failure: zod.string().min(1).nullable(),
}).strict().superRefine((state, context) => {
  if (state.current === null) return
  if (!state.seenGoalIds.includes(state.current.goal.id)) {
    context.addIssue({ code: 'custom', message: 'current goal id must be retained among seen goal ids' })
  }
  if (state.current.updatedAt < state.current.createdAt) {
    context.addIssue({ code: 'custom', message: 'current goal update cannot precede its creation' })
  }
  if (state.current.roundsStarted > state.current.goal.maxGoalRounds) {
    context.addIssue({ code: 'custom', message: 'current goal rounds cannot exceed its configured limit' })
  }
}) as unknown as ZodType<GoalProjectionState>

/** 从一个可安全检查点的投影状态构造严格的折叠状态。 */
function goalFoldState(state: GoalProjectionState): GoalFoldState {
  return {
    goal: state.current?.goal,
    roundsStarted: state.current?.roundsStarted ?? 0,
    createdAt: state.current?.createdAt,
    updatedAt: state.current?.updatedAt,
    lastRef: undefined,
    seenGoalIds: new Set(state.seenGoalIds),
  }
}

/** 把严格的折叠状态转换为可安全检查点的投影状态。 */
function goalProjectionState(state: GoalFoldState): GoalProjectionState {
  let current: GoalProjection | null = null
  if (state.goal !== undefined) {
    const { createdAt, updatedAt } = state
    if (createdAt === undefined || updatedAt === undefined) {
      throw new Error('current goal fold lacks timestamps')
    }
    current = {
      goal: state.goal,
      roundsStarted: state.roundsStarted,
      createdAt,
      updatedAt,
    }
  }
  return {
    current,
    seenGoalIds: [...state.seenGoalIds],
    failure: null,
  }
}

/**
 * 按严格重放规则折叠持久化目标事件，且不从投影注册表的事件驱动中抛出。
 * 第一个非法的自有事件被保留在 `failure` 中；宿主侧的目标访问会拒绝该状态，
 * 而客户端视图仍停留在最后一个合法目标上。
 * @param state - 覆盖此前所有事件的投影。
 * @param event - 下一个已提交的会话事件。
 * @returns 下一个投影（事件无关时返回同一引用）。
 */
export function applyGoalProjection(state: GoalProjectionState, event: SessionEvent): GoalProjectionState {
  if (state.failure !== null) return state
  if (event.type !== 'goal/change'
    && (event.type !== 'user/message' || event.data.source.kind !== 'goal')) return state
  const folded = goalFoldState(state)
  try {
    applyGoalEvent(folded, event)
    return goalProjectionState(folded)
  } catch (error: unknown) {
    /* v8 ignore next -- 严格的目标折叠抛出的是 Error 实例。 */
    const message = error instanceof Error ? error.message : String(error)
    return { ...state, failure: `goal replay failed at session event ${event.seq}: ${message}` }
  }
}

/** 严格的宿主侧目标状态，附带既有的裁剪后客户端值。 */
export const goalProjectionDefinition = {
  key: 'goal',
  stateSchema: goalProjectionStateSchema,
  init: (): GoalProjectionState => ({ current: null, seenGoalIds: [], failure: null }),
  apply: applyGoalProjection,
  wire: { viewSchema: goalProjectionSchema, view: state => state.current },
  stateVersion: 6,
} satisfies ProjectionDefinition<'goal', GoalProjectionState>

/** 目标创建的部署默认值。 */
export interface Config {
  /** 创建请求省略自身上限时使用的轮次总数。 */
  defaultMaxGoalRounds?: number
}

/** 已解析的默认值。 */
export interface ResolvedConfig {
  /** 已校验的正安全整数默认轮次上限。 */
  defaultMaxGoalRounds: number
}

/** 跨越同步追加边界的进程本地激活状态。 */
interface GoalRuntimeState {
  activation: GoalActivation
  pendingActivation: {
    readonly offset: SessionLogOffset
    readonly activation: GoalActivation
  } | undefined
}

/** 已校验的创建输入，所有部署默认值都已具化。 */
interface ResolvedCreateGoal {
  readonly objective: string
  readonly maxGoalRounds: number
}

/** 校验调用方可见的正安全整数轮次上限。 */
function resolveMaxGoalRounds(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new GoalError('maxGoalRounds must be a positive safe integer', 'GOAL_INVALID_MAX_ROUNDS')
  }
  return value
}

/** 在领域边界校验并规范化目标描述。 */
function resolveObjective(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GoalError('goal objective must be a non-empty string', 'GOAL_INVALID_OBJECTIVE')
  }
  return value.trim()
}

/** 具化部署默认值并校验一个创建请求。 */
function resolveCreateGoal(request: CreateGoalRequest, defaultMaxGoalRounds: number): ResolvedCreateGoal {
  return {
    objective: resolveObjective(request.objective),
    maxGoalRounds: resolveMaxGoalRounds(request.maxGoalRounds ?? defaultMaxGoalRounds),
  }
}

/** 校验并脱敏（复制）一个由策略拥有的阻塞说明。 */
function resolveBlockReason(reason: unknown): GoalBlockReason {
  const record = typeof reason === 'object' && reason !== null && !Array.isArray(reason)
    ? reason as Record<string, unknown>
    : undefined
  const code = record?.['code']
  const message = record?.['message']
  if (typeof code !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(code)
    || typeof message !== 'string' || message.trim().length === 0) {
    throw new GoalError(
      'goal block reason requires a lower-kebab-case code and a non-empty message',
      'GOAL_INVALID_BLOCK_REASON',
    )
  }
  return { code, message: message.trim() }
}

/** 目标服务（`ctx.goals`），仅由持有它的会话日志支撑。 */
export class GoalService extends TypertRemoteService {
  static inject = ['agents', 'sessionProjections']

  static Config: z<Config> = z.object({
    defaultMaxGoalRounds: z.number().default(256),
  })

  private readonly resolved: ResolvedConfig
  private readonly runtimeStates = new WeakMap<Session, GoalRuntimeState>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'goals')
    this.resolved = {
      defaultMaxGoalRounds: resolveMaxGoalRounds(config.defaultMaxGoalRounds ?? 256),
    }
    ctx.on('agent/created', ({ agent }) => {
      this.setActivation(agent.session, 'disarmed')
    })
    ctx.sessionProjections.register(goalProjectionDefinition)
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'goal/change') return
      const runtime = this.runtimeState(session)
      const activation = runtime.pendingActivation !== undefined
        && SessionSeq(runtime.pendingActivation.offset) === event.seq
        ? runtime.pendingActivation.activation
        : 'disarmed'
      this.setActivation(session, activation)
    })
  }

  /**
   * 读取某个精确存活 agent 的当前目标。
   * @param agent - 持有目标的存活 agent。
   * @returns 一个新的视图；没有当前目标时为 `undefined`。
   * @throws {@link GoalError} 当该 agent 不是注册表中的存活实例时。
   */
  @Remote('get')
  get(agent: Agent): GoalView | undefined {
    this.assertLive(agent)
    return this.view(this.state(agent.session), this.runtimeState(agent.session))
  }

  /**
   * 移除进程本地的续跑权限，而不改变持久化的目标阶段或修订号。生命周期
   * 所有者在卸载驱动器之前使用它；之后一次经人工授权的 {@link resume}
   * 会记录新的激活边界。
   * @param agent - 持有目标的存活 agent。
   * @returns 一个新的已解除续跑（disarmed）视图；没有当前目标时为 `undefined`。
   */
  disarm(agent: Agent): GoalView | undefined {
    this.assertLive(agent)
    this.setActivation(agent.session, 'disarmed')
    const runtime = this.runtimeState(agent.session)
    return this.view(this.state(agent.session), runtime)
  }

  /**
   * 创建并激活（arm）一个目标。已完成的目标可以被替换；其它任何当前阶段
   * 都必须先 clear 或 resume。
   * @param agent - 持有目标的存活 agent。
   * @param request - 目标描述与可选的轮次上限。
   * @returns 创建后的实时视图。
   */
  create(agent: Agent, request: CreateGoalRequest): GoalView {
    const spec = resolveCreateGoal(request, this.resolved.defaultMaxGoalRounds)
    const [state, runtime] = this.prepareMutation(agent)
    const current = state?.goal
    if (current !== undefined && current.phase !== 'complete') {
      throw new GoalError(`goal "${current.id}" already exists with phase "${current.phase}"`, 'GOAL_ALREADY_EXISTS')
    }
    const now = Date.now()
    const goal: GoalSnapshot = {
      id: GoalId(`goal-${randomUUID()}`),
      revision: 1,
      objective: spec.objective,
      phase: 'active',
      maxGoalRounds: spec.maxGoalRounds,
    }
    return this.commitSnapshot(agent, runtime, 'create', goal, 0, now, now, 'armed')
  }

  /**
   * 编辑目标描述和/或轮次上限，不改变阶段。
   * @param agent - 持有目标的存活 agent。
   * @param ref - 期望的当前修订号。
   * @param request - 至少一个待替换字段。
   * @returns 编辑后的视图。
   */
  @Remote('edit')
  edit(agent: Agent, ref: GoalRef, request: EditGoalRequest): GoalView {
    const [state, runtime] = this.prepareMutation(agent)
    const currentState = this.expectCurrent(state, ref)
    const current = currentState.goal
    if (request.objective === undefined && request.maxGoalRounds === undefined) {
      throw new GoalError('goal edit requires objective and/or maxGoalRounds', 'GOAL_INVALID_EDIT')
    }
    const goal: GoalSnapshot = {
      ...current,
      revision: current.revision + 1,
      ...request.objective === undefined ? {} : { objective: resolveObjective(request.objective) },
      ...request.maxGoalRounds === undefined ? {} : { maxGoalRounds: resolveMaxGoalRounds(request.maxGoalRounds) },
    }
    return this.commitCurrent(agent, currentState, runtime, 'edit', goal, runtime.activation)
  }

  /**
   * 暂停一个 active 目标，并解除自动续跑。
   * @param agent - 持有目标的存活 agent。
   * @param ref - 期望的当前修订号。
   * @returns 暂停后的视图。
   */
  @Remote('pause')
  pause(agent: Agent, ref: GoalRef): GoalView {
    return this.transition(agent, ref, 'pause', ['active'], 'paused', 'disarmed')
  }

  /**
   * 在轮次预算仍有余量时，恢复并激活一个已停止的目标，或在会话启动边界
   * 之后重新激活一个 active 目标。
   * @param agent - 持有目标的存活 agent。
   * @param ref - 期望的当前修订号。
   * @returns active 状态的视图。
   */
  @Remote('resume')
  resume(agent: Agent, ref: GoalRef): GoalView {
    const [state, runtime] = this.prepareMutation(agent)
    const currentState = this.expectCurrent(state, ref)
    const current = currentState.goal
    const resumable: readonly GoalPhase[] = ['active', 'paused', 'blocked']
    if (!resumable.includes(current.phase)) {
      throw this.transitionError(current, 'resume', resumable)
    }
    if (current.phase === 'active' && runtime.activation === 'armed') {
      throw new GoalError(`goal "${current.id}" is already active and armed`, 'GOAL_INVALID_TRANSITION')
    }
    if (currentState.roundsStarted >= current.maxGoalRounds) {
      throw new GoalError(
        `goal "${current.id}" exhausted ${current.maxGoalRounds} goal rounds; increase maxGoalRounds before resuming`,
        'GOAL_INVALID_TRANSITION',
      )
    }
    return this.commitCurrent(agent, currentState, runtime, 'resume', this.withPhase(current, 'active'), 'armed')
  }

  /**
   * 把当前未完成的目标标记为完成，并解除其续跑状态。
   * @param agent - 持有目标的存活 agent。
   * @param ref - 期望的当前修订号。
   * @returns 完成后的视图。
   */
  @Remote('complete')
  complete(agent: Agent, ref: GoalRef): GoalView {
    return this.transition(
      agent,
      ref,
      'complete',
      ['active', 'paused', 'blocked'],
      'complete',
      'disarmed',
    )
  }

  /**
   * 把一个 active 目标标记为阻塞，并解除其续跑状态。
   * @param agent - 持有目标的存活 agent。
   * @param ref - 期望的当前修订号。
   * @param reason - 由策略拥有的稳定代码与人类可读的说明。
   * @returns 附带持久化原因的阻塞视图。
   */
  block(agent: Agent, ref: GoalRef, reason: GoalBlockReason): GoalView {
    const [state, runtime] = this.prepareMutation(agent)
    const currentState = this.expectCurrent(state, ref)
    const current = currentState.goal
    if (current.phase !== 'active') {
      throw this.transitionError(current, 'block', ['active'])
    }
    return this.commitCurrent(
      agent,
      currentState,
      runtime,
      'block',
      { ...this.withPhase(current, 'blocked'), blockedReason: resolveBlockReason(reason) },
      'disarmed',
    )
  }

  /**
   * 清除当前目标，同时保留持久化墓碑与历史。
   * @param agent - 持有目标的存活 agent。
   * @param ref - 期望的当前修订号。
   * @returns 墓碑 ref，其修订号为被清除快照的下一个修订号。
   */
  @Remote('clear')
  clear(agent: Agent, ref: GoalRef): GoalRef {
    const [state, runtime] = this.prepareMutation(agent)
    const currentState = this.expectCurrent(state, ref)
    const current = currentState.goal
    const tombstone: GoalRef = { id: current.id, revision: current.revision + 1 }
    const change: GoalClearChangeMeta = {
      kind: 'goal/change',
      version: GOAL_CHANGE_VERSION,
      operation: 'clear',
      cleared: tombstone,
      clearedAt: this.nextMutationTime(currentState),
    }
    this.commit(agent, runtime, change, 'disarmed')
    return { ...tombstone }
  }

  /** 解析一次变更所需的持久化状态与进程本地状态。 */
  private prepareMutation(agent: Agent): readonly [GoalProjection | null, GoalRuntimeState] {
    this.assertLive(agent)
    return [this.state(agent.session), this.runtimeState(agent.session)]
  }

  /** 拒绝对当前状态的过期或缺失 ref。 */
  private expectCurrent(state: GoalProjection | null, ref: GoalRef): GoalProjection {
    if (state === null) throw new GoalError('no current goal', 'GOAL_NOT_FOUND')
    const current = state.goal
    if (ref.id !== current.id || ref.revision !== current.revision) {
      throw new GoalError(
        `stale goal ref "${ref.id}" revision ${ref.revision}; current is "${current.id}" revision ${current.revision}`,
        'GOAL_STALE_REVISION',
      )
    }
    return state
  }

  /** 强制校验精确的存活 agent 身份，而不是信任一个匹配的 id。 */
  private assertLive(agent: Agent): void {
    if (this.ctx.agents.get(agent.id) !== agent) {
      throw new GoalError(`agent "${agent.id}" is not live in this registry`, 'GOAL_AGENT_NOT_LIVE')
    }
  }

  /** 读取注册表维护的当前持久化投影。 */
  private state(session: Session): GoalProjection | null {
    const state = this.ctx.sessionProjections.stateOf(session, 'goal')
    if (state === undefined) throw new Error('goal projection is not registered')
    if (state.failure !== null) throw new Error(state.failure)
    return state.current
  }

  /** 返回进程本地的激活状态，初始为已解除（disarmed）。 */
  private runtimeState(session: Session): GoalRuntimeState {
    let runtime = this.runtimeStates.get(session)
    if (runtime !== undefined) return runtime
    runtime = {
      activation: 'disarmed',
      pendingActivation: undefined,
    }
    this.runtimeStates.set(session, runtime)
    return runtime
  }

  /** 仅当进程本地激活状态真正变化时，发布一次激活边界事件。 */
  private setActivation(session: Session, activation: GoalActivation): void {
    const runtime = this.runtimeState(session)
    if (runtime.activation === activation) return
    runtime.activation = activation
    const state = this.ctx.sessionProjections.stateOf(session, 'goal')
    /* v8 ignore next -- 静态 inject 保证本服务激活前投影注册表已存在。 */
    if (state === undefined) return
    if (state.failure !== null) return
    const goal = this.view(state.current, runtime)
    this.ctx.emit('goal/activation-changed', {
      sessionId: session.id,
      ...goal === undefined ? {} : {
        goal: {
          id: goal.id,
          revision: goal.revision,
          activation: goal.activation,
        },
      },
    })
  }

  /** 构造一个替换了阶段的新修订。 */
  private withPhase(current: GoalSnapshot, phase: GoalPhase): GoalSnapshot {
    return {
      id: current.id,
      revision: current.revision + 1,
      objective: current.objective,
      phase,
      maxGoalRounds: current.maxGoalRounds,
    }
  }

  /** 共享的、经过校验的阶段转换。 */
  private transition(
    agent: Agent,
    ref: GoalRef,
    operation: Exclude<GoalOperation, 'create' | 'edit' | 'clear'>,
    allowed: readonly GoalPhase[],
    phase: GoalPhase,
    activation: GoalActivation,
  ): GoalView {
    const [state, runtime] = this.prepareMutation(agent)
    const currentState = this.expectCurrent(state, ref)
    const current = currentState.goal
    if (!allowed.includes(current.phase)) throw this.transitionError(current, operation, allowed)
    return this.commitCurrent(agent, currentState, runtime, operation, this.withPhase(current, phase), activation)
  }

  /** 生成一个稳定的非法转换错误。 */
  private transitionError(current: GoalSnapshot, operation: GoalOperation, allowed: readonly GoalPhase[]): GoalError {
    return new GoalError(
      `cannot ${operation} goal "${current.id}" from phase "${current.phase}"; expected ${allowed.join(' or ')}`,
      'GOAL_INVALID_TRANSITION',
    )
  }

  /** 提交一次保留当前目标派生计数器与时间戳的变更。 */
  private commitCurrent(
    agent: Agent,
    state: GoalProjection,
    runtime: GoalRuntimeState,
    operation: Exclude<GoalOperation, 'create' | 'clear'>,
    goal: GoalSnapshot,
    activation: GoalActivation,
  ): GoalView {
    return this.commitSnapshot(
      agent,
      runtime,
      operation,
      goal,
      state.roundsStarted,
      state.createdAt,
      this.nextMutationTime(state),
      activation,
    )
  }

  /** 在时钟回拨时钳制当前目标的下一个时间戳。 */
  private nextMutationTime(state: GoalProjection): number {
    return Math.max(Date.now(), state.updatedAt)
  }

  /** 构造并提交一次全量快照式变更。 */
  private commitSnapshot(
    agent: Agent,
    runtime: GoalRuntimeState,
    operation: Exclude<GoalOperation, 'clear'>,
    goal: GoalSnapshot,
    roundsStarted: number,
    createdAt: number,
    updatedAt: number,
    activation: GoalActivation,
  ): GoalView {
    const change: GoalSnapshotChangeMeta = {
      kind: 'goal/change',
      version: GOAL_CHANGE_VERSION,
      operation,
      goal,
      roundsStarted,
      createdAt,
      updatedAt,
    }
    this.commit(agent, runtime, change, activation)
    return {
      ...goal,
      roundsStarted,
      createdAt,
      updatedAt,
      activation: runtime.activation,
    }
  }

  /** 把一次变更提交进目标日志与实时事件流。 */
  private commit(agent: Agent, runtime: GoalRuntimeState, change: GoalChangeMeta, activation: GoalActivation): void {
    const ref = goalChangeRef(change)
    runtime.pendingActivation = { offset: agent.session.seq, activation }
    try {
      const event = agent.session.append('goal/change', change)
      /* v8 ignore next -- Session.append 返回的事件其 seq 等于追加前的 seq。 */
      if (SessionSeq(runtime.pendingActivation.offset) === event.seq) runtime.activation = activation
    } finally {
      runtime.pendingActivation = undefined
    }
    const goal = this.view(this.state(agent.session), runtime)
    const notification: GoalChanged = {
      operation: change.operation,
      ref: { ...ref },
      ...goal === undefined ? {} : { goal },
    }
    agentEvents(this.ctx, agent).emit('goal/changed', { change: notification })
  }

  /** 构造一个脱离内部状态的当前视图。 */
  private view(state: GoalProjection | null, runtime: GoalRuntimeState): GoalView | undefined {
    if (state === null) return undefined
    return {
      ...state.goal,
      roundsStarted: state.roundsStarted,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      activation: runtime.activation,
    }
  }

  /**
   * 通过远程边界创建一个目标。
   * @param agent - 由线上身份解析出的精确存活 Agent。
   * @param request - 目标描述与可选的轮次上限。
   * @returns 所创建目标的标识。
   */
  @Remote('create')
  remoteExportCreate(agent: Agent, request: CreateGoalRequest): CreateGoalResult {
    const view = this.create(agent, request)
    return { ref: { id: view.id, revision: view.revision } }
  }
}

export default GoalService
