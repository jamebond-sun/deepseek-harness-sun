/**
 * 面向人的 `/goal` 命令，构建在已持久化的同会话 goal 领域之上。
 * @module @deepseek-ai/dsh-command-goal
 */

import type { Context } from '@deepseek-ai/cordis'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { GoalError } from '@deepseek-ai/dsh-goal'
import type { GoalPhase, GoalRef, GoalView } from '@deepseek-ai/dsh-goal'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'command-goal'
export const inject = ['commands', 'goals']

const USAGE = 'Usage: /goal [<objective>|clear|edit <objective>|pause|resume]'

type GoalCommand =
  | { readonly kind: 'show' }
  | { readonly kind: 'create'; readonly objective: string }
  | { readonly kind: 'edit'; readonly objective: string }
  | { readonly kind: 'invalid-edit' }
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'clear' }

/** 局部封闭联合出现未处理成员时大声失败。 */
/* v8 ignore start -- 若不违反 TypeScript 约定，封闭联合的兜底分支不可达 */
function assertNever(value: never, label: string): never {
  throw new TypeError(`unknown ${label}: ${String(value)}`)
}
/* v8 ignore stop */

/** 只解析 `/goal` 自身拥有的语法；其它任意输入都视为目标描述。 */
function parseGoalCommand(rawInput: string): GoalCommand {
  const input = rawInput.trim()
  if (input.length === 0) return { kind: 'show' }
  const control = input.toLowerCase()
  if (control === 'clear') return { kind: 'clear' }
  if (control === 'pause') return { kind: 'pause' }
  if (control === 'resume') return { kind: 'resume' }
  if (control === 'edit') return { kind: 'invalid-edit' }
  if (/^edit(?=\s)/iu.test(input)) return { kind: 'edit', objective: input.slice(4).trim() }
  return { kind: 'create', objective: input }
}

/** 一个持久化目标阶段的人类可读标签。 */
function phaseLabel(phase: GoalPhase): string {
  switch (phase) {
    case 'active': return 'active'
    case 'paused': return 'paused'
    case 'blocked': return 'blocked'
    case 'complete': return 'complete'
    /* v8 ignore next 2 -- GoalPhase 是封闭联合，且上面已处理每个成员 */
    default: return assertNever(phase, 'goal phase')
  }
}

/** 在某个精确的实时状态下有意义的命令。 */
function commandHint(goal: GoalView): string {
  if (goal.phase === 'active') {
    return goal.activation === 'armed'
      ? '/goal edit <objective>, /goal pause, /goal clear'
      : '/goal edit <objective>, /goal resume, /goal clear'
  }
  switch (goal.phase) {
    case 'paused':
    case 'blocked':
      return '/goal edit <objective>, /goal resume, /goal clear'
    case 'complete':
      return '/goal <objective>, /goal clear'
    /* v8 ignore next 2 -- active 分支与每个非 active 阶段都已在上面处理 */
    default: return assertNever(goal.phase, 'goal phase')
  }
}

/** 渲染直接的 UI 输出，不暴露比较并设置（CAS）的内部细节。 */
function renderGoal(title: string, goal: GoalView): CommandResult {
  const reason = goal.phase === 'blocked' ? goal.blockedReason : undefined
  /* v8 ignore next -- 持久化重放保证每个被阻塞的目标都带有已校验的原因 */
  if (goal.phase === 'blocked' && reason === undefined) throw new TypeError('blocked goal is missing its reason')
  const blocker = reason === undefined ? [] : [`Blocker: ${reason.code}: ${reason.message}`]
  return {
    kind: 'success',
    text: [
      title,
      `Status: ${phaseLabel(goal.phase)}`,
      ...blocker,
      `Objective: ${goal.objective}`,
      `Rounds: ${goal.roundsStarted}/${goal.maxGoalRounds}`,
      `Activation: ${goal.activation}`,
      '',
      `Commands: ${commandHint(goal)}`,
    ].join('\n'),
  }
}

/** 精确的当前比较并设置（CAS）ref。 */
function goalRef(goal: GoalView): GoalRef {
  return { id: goal.id, revision: goal.revision }
}

/** 需要当前目标的操作所对应的直接错误。 */
function missingGoal(action: string): CommandResult {
  return {
    kind: 'error',
    text: `No goal is currently set; /goal ${action} requires one. ${USAGE}`,
  }
}

/**
 * 在该目标的下一轮次之前，把调用中已准入的 composer 附件作为一条模型可见的
 * 用户消息提交。附件位于一个说明其作用的固定文本块之前，这样后续 goal 轮次
 * 能从普通的会话历史中读取它们，而 goal 领域无需存储附件状态。
 */
function submitObjectiveAttachments(invocation: CommandInvocation): void {
  if (invocation.attachments.length === 0) return
  invocation.agent.followup(createUserMessage({
    content: [...invocation.attachments, { type: 'text', text: 'Reference attachments for the goal objective.' }],
    source: { kind: 'user' },
  }))
}

/** 通过拥有持久化能力的领域执行一条已解析的人类命令。 */
function executeGoalCommand(ctx: Context, invocation: CommandInvocation): CommandResult {
  const command = parseGoalCommand(invocation.rawInput)
  if (invocation.attachments.length > 0 && command.kind !== 'create' && command.kind !== 'edit') {
    return {
      kind: 'error',
      text: 'Attachments only accompany a goal objective: /goal <objective> or /goal edit <objective>.',
    }
  }
  try {
    const current = ctx.goals.get(invocation.agent)
    switch (command.kind) {
      case 'show':
        return current === undefined
          ? { kind: 'success', text: `No goal is currently set.\n${USAGE}` }
          : renderGoal('Goal', current)
      case 'invalid-edit':
        return { kind: 'error', text: `Goal editing requires a replacement objective.\n${USAGE}` }
      case 'create': {
        if (current !== undefined && current.phase !== 'complete') {
          return {
            kind: 'error',
            text: `A goal is already ${phaseLabel(current.phase)}. Use /goal edit <objective> to change it or /goal clear before replacing it.`,
          }
        }
        const created = ctx.goals.create(invocation.agent, { objective: command.objective })
        submitObjectiveAttachments(invocation)
        return renderGoal('Goal created', created)
      }
      case 'edit': {
        if (current === undefined) return missingGoal('edit')
        if (current.phase === 'complete') {
          const replaced = ctx.goals.create(invocation.agent, { objective: command.objective })
          submitObjectiveAttachments(invocation)
          return renderGoal('Goal created', replaced)
        }
        const edited = ctx.goals.edit(invocation.agent, goalRef(current), { objective: command.objective })
        submitObjectiveAttachments(invocation)
        return renderGoal('Goal updated', edited)
      }
      case 'pause':
        if (current === undefined) return missingGoal('pause')
        return renderGoal('Goal paused', ctx.goals.pause(invocation.agent, goalRef(current)))
      case 'resume':
        if (current === undefined) return missingGoal('resume')
        return renderGoal('Goal resumed', ctx.goals.resume(invocation.agent, goalRef(current)))
      case 'clear':
        if (current === undefined) return { kind: 'success', text: 'No goal to clear.' }
        ctx.goals.clear(invocation.agent, goalRef(current))
        return { kind: 'success', text: 'Goal cleared.' }
      /* v8 ignore next 2 -- GoalCommand 是封闭联合，且上面已处理每个成员 */
      default: return assertNever(command, 'goal command')
    }
  } catch (error: unknown) {
    if (error instanceof GoalError) {
      return {
        kind: 'error',
        text: 'The goal command is not valid for the current state. Run /goal to view available commands.',
      }
    }
    throw error
  }
}

/** 为每个组合进来的命令适配器注册 Codex 风格的 `/goal` 命令。 */
export function apply(ctx: Context): void {
  ctx.commands.register({
    definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-goal'),
    name: 'goal',
    description: 'Set or view the goal for a long-running task',
    input: { hint: '[<objective>|clear|edit <objective>|pause|resume]', attachments: true },
    handler: invocation => executeGoalCommand(ctx, invocation),
  })
}
