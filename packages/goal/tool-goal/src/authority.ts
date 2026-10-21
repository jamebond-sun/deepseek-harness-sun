/** 面向模型的 goal 工具在执行期进行的权限校验。 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session-projection'

/** 调用方 agent，加上权限校验所用的不可变事件切面与开放轮次起始 seq。 */
export interface GoalToolExecution {
  readonly agent: Agent
  readonly events: readonly SessionEvent[]
  readonly openTurnStartSeq: SessionSeq
}

/** 授予一次状态变更调用的硬性权限。 */
export type GoalToolAuthority =
  | { readonly kind: 'direct-human' }
  | { readonly kind: 'goal-round'; readonly goal: GoalView }

/** 抛出一个结构化的工具策略失败。 */
function reject(message: string, code = 'GOAL_TOOL_AUTHORITY_REQUIRED'): never {
  throw new HarnessError(message, code)
}

/** 解析不可变的事件切面与开放轮次边界，不复制轮次尾部事件。 */
function openTurnEvents(
  ctx: Context,
  agent: Agent,
): Pick<GoalToolExecution, 'events' | 'openTurnStartSeq'> {
  // oxlint-disable-next-line typescript/no-deprecated -- 既有的 Session 历史读取；迁移延后。
  const events = agent.session.snapshotEvents()
  const boundary = ctx.sessionProjections.stateOf(agent.session, 'turnBoundary')
  if (boundary === undefined || boundary.openTurnStartSeq === null) {
    reject('goal tools require an open model turn', 'GOAL_TOOL_DRIVER_REQUIRED')
  }
  return { events, openTurnStartSeq: boundary.openTurnStartSeq }
}

/**
 * 解析并鉴权调用方 agent 及其驱动器边界。
 * @param ctx - 携带存活 agent 注册表的 Context。
 * @param exec - 注册表提供的工具执行元数据。
 * @returns 已鉴权的 agent、不可变事件切面与开放轮次边界。
 */
export function goalToolExecution(ctx: Context, exec: ToolRunContext): GoalToolExecution {
  const agent = exec.agent
  if (agent === undefined) {
    return reject('goal tools require a calling agent', 'GOAL_TOOL_AGENT_REQUIRED')
  }
  if (ctx.agents.get(agent.id) !== agent || agent.status !== 'running'
    || ctx.agents.currentInitiator() !== agent) {
    return reject(
      'goal tools require the exact live calling agent inside its active driver',
      'GOAL_TOOL_DRIVER_REQUIRED',
    )
  }
  return { agent, ...openTurnEvents(ctx, agent) }
}

/** 已捕获的开放轮次中是否存在被 `predicate` 接受的事件。 */
function someOpenTurnEvent(
  execution: GoalToolExecution,
  predicate: (event: SessionEvent) => boolean,
): boolean {
  for (let seq = execution.openTurnStartSeq + 1; seq < execution.events.length; seq += 1) {
    const event = execution.events[seq]
    if (event !== undefined && predicate(event)) return true
  }
  return false
}

/**
 * 当前根 agent 轮次中是否出现经宿主确认的人类输入。省略 `Agent.followup()`
 * / `steer()` 的来源时会解析为 `user`，因此非人类的生产者必须提供自己的
 * 来源，而不能继承该权限。
 */
function hasDirectHumanInput(ctx: Context, execution: GoalToolExecution): boolean {
  if (!ctx.agents.roots().includes(execution.agent)) return false
  return someOpenTurnEvent(execution, event =>
    event.type === 'user/message' && event.data.source.kind === 'user')
}

/** 本轮次是否为当前目标精确的已准入轮次。 */
function isMatchingGoalRound(execution: GoalToolExecution, goal: GoalView): boolean {
  return someOpenTurnEvent(execution, event => event.type === 'user/message'
    && event.data.source.kind === 'goal'
    && event.data.source.goalId === goal.id
    && event.data.source.revision === goal.revision
    && event.data.source.round === goal.roundsStarted)
}

/**
 * 要求权限来自一条被运行时根 agent 接受的人类消息。
 * @param ctx - 携带存活 agent 图的 Context。
 * @param execution - 已鉴权的当前工具执行。
 */
export function requireDirectHuman(ctx: Context, execution: GoalToolExecution): void {
  if (hasDirectHumanInput(ctx, execution)) return
  reject('this goal operation requires a direct human turn on a top-level agent')
}

/**
 * 从直接人类输入或精确的 goal 轮次解析出完成权限。
 * @param ctx - 携带存活 agent 与目标状态的 Context。
 * @param execution - 已鉴权的当前工具执行。
 * @returns 直接人类或精确 goal 轮次的权限授予。
 */
export function completionAuthority(ctx: Context, execution: GoalToolExecution): GoalToolAuthority {
  if (hasDirectHumanInput(ctx, execution)) return { kind: 'direct-human' }
  const goal = ctx.goals.get(execution.agent)
  if (goal !== undefined && isMatchingGoalRound(execution, goal)) {
    return { kind: 'goal-round', goal }
  }
  return reject('complete and blocked require a direct human turn or the current goal round')
}
