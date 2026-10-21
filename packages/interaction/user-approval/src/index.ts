/**
 * 审批能力接缝的服务定义，覆盖提问、取消、审计以及按 Session 的策略。缺少回答方时
 * 按失败关闭处理；放行只适用于被请求的那个操作。
 * @module @deepseek-ai/dsh-user-approval
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'user-approval': { kind: 'user-approval' } & ContextFormed
  }
}

import { scopeTarget } from '@deepseek-ai/dsh-scope'
import type { Session } from '@deepseek-ai/dsh-session'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'

declare module '@deepseek-ai/cordis' {
  interface Context {
    approval: ApprovalService
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * 该 Session 的审批策略被切换 —— 仅落日志、已持久、可重放，永不进入模型
     * transcript（模型通过运行期上下文快照与实时切换通知得知策略）。最后一条
     * 此类事件就是该 Session 的覆盖值。`source: 'delegation'` 标记一条被播种进
     * 子 agent 的覆盖；缺省 source 表示一次运行期切换。
     */
    'approval/policy': {
      policy: ApprovalPolicy
      /** 标记一条在委派时被播种进子 agent 的覆盖。 */
      source?: 'delegation'
    }
  }
}

import { ApprovalRequestId } from './types.ts'
import type { ApprovalOutcome, ApprovalRequestEvent } from './types.ts'

export { ApprovalRequestId } from './types.ts'
export type { ApprovalOutcome } from './types.ts'

/** 全部 {@link ApprovalOutcome}，用于在运行期归一化回答方的返回值。 */
const OUTCOMES: readonly ApprovalOutcome[] = ['allowed-once', 'rejected', 'cancelled', 'unavailable']

/**
 * 一个 Session 的审批策略 —— 在任何交互式回答方看到它之前，
 * 一次 {@link ApprovalService} 提问会发生什么：
 *
 * - `'ask'`（默认值）—— 委派给各已组合的回答方；一个都没有时，该链条落到失败关闭的
 *   `'unavailable'`。
 * - `'never'` —— 不向任何人提问：每次提问都确定性地解析为 `'rejected'`。这是严格的
 *   无头立场（CI、无人值守的运行），也是那种无需发问即可预知结果的策略。
 */
export type ApprovalPolicy = 'ask' | 'never'

/** 全部 {@link ApprovalPolicy}，用于选项宣告，以及在运行期校验不可信的策略字符串。 */
export const APPROVAL_POLICIES: readonly ApprovalPolicy[] = ['ask', 'never']

/** 面向模型的、描述确定性 `'never'` 策略的陈述。 */
const NEVER_SENTENCE = 'Approval prompts are disabled in this session: actions that require approval are rejected automatically — do not request sandbox escalation (do not set `sandbox_permissions`).'
/** 面向模型的、描述仍可能失败关闭的交互式策略的陈述。 */
const ASK_SENTENCE = 'Approval policy: ask. Operations that require approval may ask through the configured answerers; without an available answerer, the request fails closed.'

/**
 * 日志当前是否处于一个打开的 turn 之中（某条 `turn/start` 尚未被 `turn/end` 关闭）——
 * 这是 {@link ApprovalService.request} 的前置条件。审计事件对必须被 turn 包住：
 * turn 是持久化日志的提交/重放边界，因此追加在两个 turn 之间的一条裸事件在重载时
 * 与崩溃尾巴无法区分，会被静默丢弃。
 */
function hasOpenTurn(session: Session): boolean {
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    // oxlint-disable-next-line typescript/no-deprecated -- 既有的 Session 历史读取方式；迁移延后。
    const type = session.eventAt(SessionSeq(seq))?.type
    if (type === 'turn/start') return true
    if (type === 'turn/end') return false
  }
  return false
}

/**
 * 追加一条 Session 策略覆盖的唯一持久表示。非法取值在日志发生变更之前抛出；
 * 消费方在每次读取时折叠新值。
 * @param session - 该覆盖所属的 Session。
 * @param policy - 在下一次切换之前生效的策略。
 */
export function setApprovalPolicy(session: Session, policy: ApprovalPolicy): void {
  if (!APPROVAL_POLICIES.includes(policy)) {
    throw new TypeError('approval policy must be one of "ask" or "never"')
  }
  session.append('approval/policy', { policy })
}

/**
 * 只读的同进程权限提问。`callId` 指向一个已经呈现出来的工具调用，
 * 因此这里不再重复参数。
 */
export interface ApprovalRequest extends ApprovalRequestEvent {
  /**
   * 代表其发起该提问的 agent。它决定这次提问的路由（面向 UI 的回答方只为自己持有的
   * agent 作答），并在其 Session 日志上接收审计事件。
   */
  readonly agent: Agent
  /** 该问题所针对的工具（呈现与审计都用到）。 */
  readonly toolName: string
  /**
   * 正在被裁决的那个精确工具调用，当提问方持有一个时 —— 这让 UI 能够把提示
   * 挂到它已经流式输出出来的那个工具调用上。
   */
  readonly callId?: ToolCallId
  /** 提问方给出的、人类可读的“为什么提问”的解释。 */
  readonly reason?: string
  /**
   * 中止即撤回该提问：请求立即以 `'cancelled'` 终结，而来自某个仍在等待的回答方的
   * 迟到答案会被丢弃。
   */
  readonly signal?: AbortSignal
}

/** 插件配置。全部可选 —— `static Config` 提供默认值。 */
export interface Config {
  /**
   * 部署为没有 `approval/policy` 覆盖的 Session 设定的默认 {@link ApprovalPolicy} ——
   * `'ask'` 委派给各已组合的回答方（一个都没有时失败关闭）；`'never'` 在不提问的
   * 前提下自动拒绝每一次提问（确定性的 CI/无人值守立场）。
   */
  readonly policy?: ApprovalPolicy
}

/**
 * 审批服务：先对 Session 策略求值，再交给回答方，并把每一对提问/结果都记录到发起该
 * 请求的 Session 上。它通过运行期上下文快照与切换通知，把确定性的策略变化暴露给模型。
 */
export class ApprovalService extends Service {
  static Config: z<Config> = z.object({
    policy: z.union(['ask', 'never'] as const).default('ask'),
  })

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'approval')

    const effective = (agent: Agent): ApprovalPolicy => this.effectivePolicy(agent.session)

    // 完整的当前值排在保留历史之后，因此切换策略不会重写稳定的系统提示缓存前缀。
    ctx.inject(['systemPrompt'], (scope: Context) => {
      scope.systemPrompt.context({
        name: 'approval:policy',
        order: scope.systemPrompt.getContextOrder('APPROVAL_POLICY'),
        text: (context) => {
          const agent = context.agent
          // 一次裸的 assemble()（测试、诊断）没有可陈述其状态的 session。
          if (agent === undefined) return ''
          const policy = effective(agent)
          return policy === 'never' ? NEVER_SENTENCE : ASK_SENTENCE
        },
      })
    })
  }

  /**
   * 切换某个运行期 agent 的策略，并把这次变迁排队到它的下一个模型步。
   * Session 初始化直接使用 {@link setApprovalPolicy}，因为那里没有先前可见的
   * 策略可供比较。
   * @param agent - 策略正在变化的那个运行期 agent。
   * @param policy - 新的生效策略。
   */
  setPolicy(agent: Agent, policy: ApprovalPolicy): void {
    const previous = this.effectivePolicy(agent.session)
    if (previous === policy) return
    setApprovalPolicy(agent.session, policy)
    agent.inject(createUserMessage({
      content: [{
        type: 'text',
        text: `The approval policy changed from "${previous}" to "${policy}" (changed by the user).`,
      }],
      source: { kind: 'user-approval' },
    }))
  }

  /**
   * 请各已组合的回答方裁决一个只读的同进程请求。该服务直接借用请求、agent、session
   * 与生效中的信号本身。请求必须处于一个打开的 turn 中，因为审计事件对必须被持久化
   * 日志的提交/重放边界包住；一次空闲的提问在追加任何事件之前就被拒绝。回答方阶段
   * 总会产出一个结果：被中止的信号得到 `'cancelled'`，缺失或抛出的回答方得到
   * `'unavailable'`（失败关闭），而一个越界的、不在词汇表内的返回值会被归一化为
   * `'unavailable'`。任何阻止两条审计事件之一提交的失败仍然会让请求拒绝，因为返回
   * 一个没有被记录下来的裁决将破坏事件对。Session 会隔离提交之后的观察者失败，
   * 因此一次权威追加既不能让请求失败，也不会抑制与之配对的审计事件。
   * @param req - 待处理的裁决（agent、工具身份、理由、信号）。
   * @returns 已关闭的结果；`'allowed-once'` 是唯一的放行。
   * @throws 当没有打开的 turn，或某条审计事件在 session 追加的提交点之前失败时抛出。
   */
  async request(req: ApprovalRequest): Promise<ApprovalOutcome> {
    const session = req.agent.session
    if (!hasOpenTurn(session)) {
      throw new Error(
        'approval.request() outside an open turn: the approval/asked + approval/decided audit pair '
        + 'must be turn-enclosed (a bare event between turns is crash-tail garbage on reload). '
        + 'Ask from inside the turn that needs the decision.',
      )
    }
    const id = ApprovalRequestId(randomUUID())
    session.append('approval/asked', {
      id,
      toolName: req.toolName,
      ...req.callId !== undefined ? { callId: req.callId } : {},
      ...req.reason !== undefined ? { reason: req.reason } : {},
    })
    const outcome = await this.decide(req, session)
    session.append('approval/decided', { id, outcome })
    return outcome
  }

  /**
   * 该 Session 的生效策略：它自己的 `approval/policy` 折叠结果，否则为配置默认值
   * （schema 已经把缺省策略填成 `'ask'`；这里的 `??` 只是收窄可选输入的类型）。
   * @param session - 应用其策略的那个精确 Session。
   * @returns 此刻该 Session 的每次提问所遵循的策略。
   */
  private effectivePolicy(session: Session): ApprovalPolicy {
    return this.overrideOf(session) ?? this.config.policy ?? 'ask'
  }

  /**
   * 读取 Session 覆盖值，但不套用配置默认值。
   * @param session - 提供覆盖值的 Session。
   * @returns 最后一条被记录的策略；没有时为 `undefined`。
   */
  overrideOf(session: Session): ApprovalPolicy | undefined {
    for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
      // oxlint-disable-next-line typescript/no-deprecated -- 既有的 Session 历史读取方式；迁移延后。
      const event = session.eventAt(SessionSeq(seq))
      if (event?.type === 'approval/policy') return event.data.policy
    }
    return undefined
  }

  /**
   * 分派 waterfall，就地隔离，并与请求信号竞速。
   * @param req - 被借用的公开请求。
   * @param session - 请求方 agent 的 session，用于策略查找。
   * @returns 归一化后的已关闭结果。
   */
  private async decide(req: ApprovalRequest, session: Session): Promise<ApprovalOutcome> {
    const signal = req.signal
    if (signal?.aborted) return 'cancelled'
    // 'never' 策略在这里就地裁决，先于任何分派：在本服务挂载之后以
    // `prepend: true` 注册的监听器会排在任何闸门型监听器之前，因此一个做成监听器
    // 形状的闸门无法守住“无论注册顺序如何，'never' 都确定性地拒绝”这一书面承诺 ——
    // 只有服务自己的请求路径能做到。
    if (this.effectivePolicy(session) === 'never') return 'rejected'
    // 在分派之前就进入 promise 链：一个同步抛出（在它第一次 await 之前）的监听器
    // 必须落到与异步抛出相同的拒绝路径上 —— 用 `Promise.resolve(call())` 会让它
    // 越过隔离措施，逃逸到调用方。
    const answer: Promise<ApprovalOutcome> = Promise.resolve().then(
      () => this.ctx.waterfall(
        scopeTarget(req.agent, req.agent), 'approval/request', req,
        () => Promise.resolve<ApprovalOutcome>('unavailable'),
      ),
    ).then(
      // 把一个越界的（不在词汇表内的）回答方返回值归一化为失败关闭的结果，
      // 而不是让它泄漏进调用方的封闭联合 switch。
      outcome => OUTCOMES.includes(outcome) ? outcome : 'unavailable',
      // 一个抛出的回答方必须让这个提问失败关闭，而不是让调用方的工具调用失败公开 ——
      // 这条接缝隔离自己的回调。
      () => 'unavailable',
    )
    if (signal === undefined) return answer
    return await new Promise<ApprovalOutcome>((resolve) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort)
        resolve('cancelled')
      }
      signal.addEventListener('abort', onAbort, { once: true })
      void answer.then((outcome) => {
        signal.removeEventListener('abort', onAbort)
        // 当中止赢得竞速之后，这次 resolve 是对一个已 settle 的 promise 的空操作：
        // 迟到的答案在构造上就被丢弃了。
        resolve(outcome)
      })
    })
  }
}

export default ApprovalService
