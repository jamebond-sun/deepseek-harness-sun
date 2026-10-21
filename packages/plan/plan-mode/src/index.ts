/**
 * 计划模式是按 agent 记录的协作状态：生效期间，每次模型请求都会包含一段由部署方
 * 提供的指引分区，`exit_plan_mode` 会把已完成的计划呈现给用户审阅，而 `/plan off`
 * 命令让用户直接离开。沙箱模式与审批策略各自独立地施加限制，既不读取也不写入
 * 计划状态。
 *
 * `plan` 投影对会话日志做折叠，因此恢复与 fork 都能还原该状态。用户的选择在下一个
 * 被接受的轮内 pre-step 之前保持待生效。服务把所选状态纳入提议的步骤装配，然后
 * 仅当该步骤被接受时，才从 `agent/pre-step` 追加 `plan/mode`。同一步骤内的请求
 * 重试复用其装配。
 *
 * 退出工具在计划模式未生效时仍保持注册，因此进入或离开计划模式只改变提示词分区，
 * 不改变请求的工具目录。
 *
 * 见 packages/plan/plan-mode/README.md。
 *
 * @module @deepseek-ai/dsh-plan-mode
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { UserQuestionError, type AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import type { CommandDefinitionId, CommandId } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { PlanProjection, PlanUnitState } from './types.ts'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'plan-mode': { kind: 'plan-mode' } & ContextFormed
  }
}
export type * from './types.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * 从这一点起计划模式是否生效：仅记日志、非展示面、整体值替换。最后一次
     * `plan/mode` 胜出；不含该事件的日志经投影单元的折叠得到 inactive。
     */
    'plan/mode': { active: boolean }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    planMode: PlanModeController
  }
}

/**
 * 面向模型的退出工具的名称。它在计划模式未生效时仍保持注册，从而使请求的工具
 * 目录在状态切换之间保持稳定。
 */
export const EXIT_PLAN_MODE = 'exit_plan_mode'

/** 由部署方提供的计划模式指引。 */
export interface PlanModeConfig {
  /** 计划模式生效时渲染为 `plan:policy` 提示词分区的指引。 */
  section: string
}

/** 审阅问题的 id，本工具读取的答案会原样回显它。 */
const REVIEW_ID = 'plan-review'

/** 审阅问题中「批准」选项的标签。 */
const APPROVE_LABEL = 'Approve'

/** 审阅问题中「继续计划」选项的标签。 */
const KEEP_PLANNING_LABEL = 'Keep planning'

const EXIT_DESCRIPTION
  = 'Use only in plan mode. Present your plan for the user\'s review and, on approval, leave plan mode. '
  + 'The user may approve (carry out the plan from your next step) or keep '
  + 'planning — their feedback comes back in the tool result; revise and present again.'

/** 计划的首个 markdown 标题（任意层级）；没有标题时为 `undefined`。 */
function firstHeading(plan: string): string | undefined {
  for (const line of plan.split('\n')) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line)
    if (match) return match[1]
  }
  return undefined
}

/**
 * 校验由部署方提供的计划模式指引。缺失、空白、非字符串或未知字段一律在插件
 * 加载时失败，而不是被忽略。
 *
 * @param config 原始插件配置。
 * @returns 一份脱离引用的已校验配置。
 */
export function resolveConfig(config: PlanModeConfig): PlanModeConfig {
  const section = (config as Partial<PlanModeConfig>).section
  if (typeof section !== 'string') {
    throw new Error('PlanModeConfig needs a string `section`')
  }
  if (section.trim() === '') {
    throw new Error('PlanModeConfig needs a non-empty `section`')
  }
  const unknown = Object.keys(config).filter(key => key !== 'section')
  if (unknown.length > 0) {
    throw new Error(`PlanModeConfig has unknown key(s) ${unknown.join(', ')} — config is { section }`)
  }
  return { section }
}

const planUnitStateSchema: ZodType<PlanUnitState> = zod.object({
  active: zod.boolean(),
  wanted: zod.boolean().nullable(),
  running: zod.object({
    commandId: zod.string() as unknown as ZodType<CommandId>,
    wanted: zod.boolean(),
  }).strict().nullable(),
  activeAtLastHeader: zod.boolean().nullable(),
}).strict()

/** `plan` 投影的协议载荷 schema。 */
const planProjectionSchema: ZodType<PlanProjection> = zod.object({
  active: zod.boolean(),
  pending: zod.boolean(),
})

/** 已记录的计划选择与已提交模式的投影。 */
export const planProjectionDefinition = {
  key: 'plan',
  stateVersion: 3,
  stateSchema: planUnitStateSchema,
  init: () => ({ active: false, wanted: null, running: null, activeAtLastHeader: null }),
  apply: (state, event) => {
    if (event.type === 'command/run' && event.data.name === 'plan') {
      if (event.data.args === undefined) return state
      const wanted = event.data.args.trim() !== 'off'
      return { ...state, running: { commandId: event.data.commandId, wanted } }
    }
    if (event.type === 'command/done' && event.data.commandId === state.running?.commandId) {
      const wanted = event.data.kind === 'success' && state.running.wanted !== state.active
        ? state.running.wanted
        : null
      return { ...state, wanted, running: null }
    }
    if (event.type === 'plan/mode') {
      return { ...state, active: event.data.active, wanted: null }
    }
    if (event.type === 'request/header') {
      return { ...state, activeAtLastHeader: state.active }
    }
    return state
  },
  wire: {
    viewSchema: planProjectionSchema,
    view: (state) => {
      const wanted = state.running?.wanted ?? state.wanted
      return { active: state.active, pending: wanted !== null && wanted !== state.active }
    },
  },
} satisfies ProjectionDefinition<'plan', PlanUnitState>

/**
 * `ctx.planMode`：拥有已记录的计划状态，在步骤开始时应用并叙述所选状态，并拥有
 * `plan:policy` 分区、`/plan` 命令与稳定的退出工具。客户端载体暴露该投影裁剪后的
 * `{ active, pending }` 视图。
 */
export class PlanModeController extends Service {
  static inject = ['tools', 'systemPrompt', 'sessionProjections']

  /** 已校验的、由部署方提供的指引。 */
  private readonly section: string

  /**
   * 每个会话中等待下一个被接受的轮内 pre-step 的最新选择。`narrate` 对用户选择
   * 为 true，对退出工具为 false —— 后者的结果已经叙述了这次切换。
   */
  private readonly pendingIntents = new WeakMap<Session, { active: boolean; narrate: boolean }>()

  constructor(ctx: Context, config: PlanModeConfig = { section: '' }) {
    super(ctx, 'planMode')
    this.section = resolveConfig(config).section
    let disposed = false
    // pre-step 位于 Session.append 的发布之外，因此它可以在一个打开的轮次内
    // 追加仅记日志的模式事件，而不会重入会话。追加失败会让选择继续待生效，
    // 等待之后某个被接受的轮内 pre-step；策略无法阻断该步骤。
    ctx.on('agent/pre-step', async (
      { agent, signal },
      next,
    ): Promise<PreStepDecision> => {
      const decision = await next()
      const pending = this.pendingIntents.get(agent.session)
      if (decision.kind === 'reject' || signal.aborted || pending === undefined) return decision
      const narration = this.narration(agent.session, pending.active)
      try {
        this.onBoundary(agent.session)
      } catch (error) {
        ctx.logger.warn('dsh-plan-mode: failed to append selected plan mode at step start: %o', error)
        return decision
      }
      return !pending.narrate || narration === undefined
        ? decision
        : { ...decision, messages: [...decision.messages, narration] }
    })
    ctx.effect(() => () => { disposed = true }, 'dsh-plan-mode: close service lifetime')

    ctx.systemPrompt.section({
      name: 'plan:policy',
      order: ctx.systemPrompt.getSectionOrder('PLAN_POLICY'),
      text: (context) => {
        if (context.agent === undefined) return ''
        const pending = this.pendingIntents.get(context.agent.session)
        return (pending?.active ?? this.loggedActive(context.agent.session)) ? this.section : ''
      },
    })

    ctx.sessionProjections.register(planProjectionDefinition)

    // 命令子进程仅在组合了命令注册表时才激活。
    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.commands.register({
        definitionId: brandString<CommandDefinitionId>('@deepseek-ai/dsh-plan-mode'),
        name: 'plan',
        description: 'Enter or leave plan mode',
        input: { hint: '[off|message]', attachments: true },
        handler: ({ agent, rawInput, attachments }) => {
          const message = rawInput.trim()
          if (message === 'off' && attachments.length > 0) {
            return { kind: 'error', text: 'Attachments cannot accompany /plan off.' }
          }
          if (message === 'off') {
            switch (this.set(agent, false)) {
              case 'committed':
                return { kind: 'success', text: 'Plan mode off.' }
              case 'queued':
                return { kind: 'success', text: 'Leaving plan mode (applies from the next step).' }
              case 'cancelled':
                return { kind: 'success', text: 'Plan mode entry cancelled.' }
              case 'noop':
                // 当一次退出仍在等待下一个被接受的 pre-step 时，重复排队态的
                // 措辞；只有真正处于未生效状态的会话才读作幂等。
                return this.loggedActive(agent.session)
                  ? { kind: 'success', text: 'Leaving plan mode (applies from the next step).' }
                  : { kind: 'success', text: 'Plan mode is already inactive.' }
            }
          }
          const outcome = this.set(agent, true)
          if (message !== '' || attachments.length > 0) {
            agent.steer(createUserMessage({
              content: [
                ...attachments,
                ...(message === '' ? [] : [{ type: 'text' as const, text: message }]),
              ],
              source: { kind: 'user' },
            }))
          }
          return {
            kind: 'success',
            text: outcome === 'committed'
              ? 'Plan mode on. Use /plan off to leave.'
              : 'Entering plan mode (applies from the next step). Use /plan off to leave.',
          }
        },
      })
    })

    ctx.tools.register(defineTool({
      name: EXIT_PLAN_MODE,
      description: EXIT_DESCRIPTION,
      parameters: {
        plan: { type: 'string', required: true, description: 'The complete plan, as markdown, starting with a # heading that names it.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            approved: { type: 'boolean', required: true },
          },
        },
        render: (_args, { approved }) => [{
          type: 'text',
          text: approved
            ? 'Plan approved — plan mode exited; carry out the plan starting with your next step.'
            : 'The user dismissed the plan review to reply in their own words; plan mode remains active.',
        }],
      },
      execute: async (args, exec) => {
        const agent = exec.agent
        if (agent === undefined) throw new Error(`${EXIT_PLAN_MODE} requires a calling agent (no session to switch)`)
        if (!this.loggedActive(agent.session)) {
          throw new Error(`${EXIT_PLAN_MODE} is only available in plan mode`)
        }
        if (!/^#\s+\S/.test(args.plan.trim())) {
          throw new Error(`${EXIT_PLAN_MODE} requires a non-empty markdown plan starting with a # heading`)
        }
        const interaction = ctx.get('userQuestions')
        if (interaction === undefined) {
          throw new Error('no user-questions channel is available to review the plan; ask the user to switch the session mode instead')
        }
        let answer: AskUserQuestionAnswer
        try {
          answer = await interaction.ask({
            questions: [{
              id: REVIEW_ID,
              header: 'Plan review',
              question: 'Approve this plan and leave plan mode?',
              detail: args.plan,
              options: [
                { label: APPROVE_LABEL, description: 'Leave plan mode; the plan is carried out from the next step.' },
                { label: KEEP_PLANNING_LABEL, description: 'Stay in plan mode; feedback goes back to the model.' },
              ],
              // 仅用于展示：有能力的界面会把计划渲染为一次审阅决策，而不是
              // 一个通用问题；无论哪种方式都以标签之一作答。
              intent: { kind: 'plan-review', approve: APPROVE_LABEL, callId: exec.callId },
            }],
            agent,
            signal: exec.signal,
          })
        } catch (cause: unknown) {
          // 被关闭的审阅不等于失败的审阅：用户把这一轮收回去说了两个选项都
          // 没有覆盖的内容，于是该轮到此结束，而不是把一次模型请求花在等待上。
          // abort（轮次取消、提供方 teardown）保留它自身的失败。
          if (cause instanceof UserQuestionError && cause.code === 'ASK_CANCELLED') {
            exec.concludeTurn()
            return { approved: false }
          }
          throw cause
        }
        // 一次审阅可能活得比本插件 fiber 更久。没有它的 pre-step 监听器，一个
        // 被批准的选择将永远无法被追加，因此失败并保持计划模式。
        if (disposed) {
          throw new Error('the plan-mode service was reloaded while the plan was under review; present the plan again')
        }
        const reviewItems = answer.answers.filter(entry => entry.id === REVIEW_ID)
        const item = reviewItems.length === 1 ? reviewItems[0] : undefined
        if (item?.selected.length !== 1 || item.selected[0] !== APPROVE_LABEL || item.custom !== undefined) {
          const feedback = item?.custom ?? ''
          throw new Error(feedback === ''
            ? 'The user chose to keep planning; revise the plan and present it again.'
            : `The user chose to keep planning; their feedback: ${feedback}`)
        }
        // 为本轮助手工具批次的剩余部分保留计划指引。这个静默的选择会在下一个
        // 被接受的轮内 pre-step 中、于其请求装配之前被追加。
        this.pendingIntents.set(agent.session, { active: false, narrate: false })
        return { approved: true }
      },
      presentCall: args => ({
        card: 'generic',
        title: firstHeading(args.plan) ?? 'Plan',
        kind: 'other',
        content: [{ type: 'text', text: args.plan }],
      }),
      presentResult: (_args, result) => ({
        card: 'generic',
        title: 'Plan review',
        content: result.content,
      }),
    }))
  }

  private loggedActive(session: Session): boolean {
    return this.planState(session).active
  }

  private hasOpenTurn(session: Session): boolean {
    const state = this.ctx.sessionProjections.stateOf(session, 'turnBoundary')
    if (state === undefined) throw new Error('plan-mode requires the turnBoundary session projection')
    return state.openTurnStartSeq !== null
  }

  private loggedActiveAtLastHeader(session: Session): boolean | undefined {
    return this.planState(session).activeAtLastHeader ?? undefined
  }

  /** 读取必需的 plan 投影状态，或在首次服务访问时失败。 */
  private planState(session: Session): PlanUnitState {
    const state = this.ctx.sessionProjections.stateOf(session, 'plan')
    if (state === undefined) throw new Error('plan-mode requires the plan session projection')
    return state
  }

  /**
   * 读取已记录的计划状态，以及任何等待下一个被接受的轮内 pre-step 的所选状态。
   *
   * @param agent 要读取的 agent。
   * @returns 当前的已记录状态，以及存在时的待生效选择。
   */
  get(agent: Agent): { active: boolean; pending?: boolean } {
    const active = this.loggedActive(agent.session)
    const pending = this.pendingIntents.get(agent.session)
    return pending === undefined ? { active } : { active, pending: pending.active }
  }

  /**
   * 选择计划模式是否应当生效。在轮次之间该方法会立即追加变更，因为在下一个
   * 提示词开启轮次之前不会有任何轮内 pre-step 运行。打开轮次的折叠是空闲信号：
   * agent 状态在轮次后的检查点期间保持 `running`，而此时不会再运行任何轮内
   * pre-step。在一个打开的轮次内，选择保持待生效，直到下一个被接受的轮内
   * pre-step。重复选择当前状态或已在待生效中的状态是一次空操作。
   *
   * @param agent 要切换的 agent。
   * @param active 计划模式是否应当生效。
   * @returns 发生了什么：`committed`（现已记入日志）、`queued`（等待下一个被
   * 接受的轮内 pre-step）、`cancelled`（一个相反的待生效选择被清除；已记录状态
   * 已经相符）或 `noop`（已处于该状态）。
   */
  set(agent: Agent, active: boolean): 'committed' | 'queued' | 'cancelled' | 'noop' {
    const session = agent.session
    const pending = this.pendingIntents.get(session)
    const target = pending?.active ?? this.loggedActive(session)
    if (active === target) return 'noop'
    if (this.hasOpenTurn(session)) {
      this.pendingIntents.set(session, { active, narrate: true })
      return this.loggedActive(session) === active ? 'cancelled' : 'queued'
    }
    // 没有打开的轮次：立即提交。只在追加成功之后才删除，这样失败的持久化
    // 写入会让选择可重试，而不是被丢弃。
    if (active === this.loggedActive(session)) {
      this.pendingIntents.delete(session)
      return 'cancelled'
    }
    session.append('plan/mode', { active })
    this.pendingIntents.delete(session)
    const narration = this.narration(session, active)
    if (narration !== undefined) agent.inject(narration)
    return 'committed'
  }

  /** 在下一次请求装配之前追加一个待生效的选择。 */
  private onBoundary(session: Session): void {
    const pending = this.pendingIntents.get(session)
    if (pending === undefined) return
    const target = pending.active
    if (target === this.loggedActive(session)) {
      this.pendingIntents.delete(session)
      return
    }
    session.append('plan/mode', { active: target })
    // 只在追加成功之后才删除，以便之后某个被接受的轮内 pre-step 能重试一次
    // 失败的持久化写入。
    this.pendingIntents.delete(session)
  }

  /** 当最后一次已记录的 header 描述的是另一种模式时，构造一条用户切换通知。 */
  private narration(session: Session, target: boolean): UserMessage | undefined {
    const told = this.loggedActiveAtLastHeader(session)
    if (told === undefined || told === target) return
    const text = target
      ? 'The user switched this session to plan mode.'
      : 'The user switched this session back to the default mode.'
    return createUserMessage({
      content: [{ type: 'text', text }],
      // 该通知本身就是一句话，因此它是自己的摘要。
      source: { kind: 'plan-mode', form: 'notice', summary: text },
    })
  }
}

export default PlanModeController
