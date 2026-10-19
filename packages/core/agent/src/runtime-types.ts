/**
 * 公开的 agent 类型与活跃运行时事件。持久的转录事实与 turn/step 边界
 * 仍是 `@deepseek-ai/dsh-session` 的事件。
 *
 * @module @deepseek-ai/dsh-agent
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import type {
  LlmAttemptId, LlmCallConfig, LlmFailure, MessageId, ReasoningEffortId, ResolvedRetryPolicy, StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AgentCancelCause, Session, SessionSeq, UserMessage } from '@deepseek-ai/dsh-session'
export type { AgentCancelCause } from '@deepseek-ai/dsh-session'
import type { Agent, InboxTarget } from './types.ts'
export type { Agent } from './types.ts'
import type {} from '@deepseek-ai/dsh-system-prompt'
declare module '@deepseek-ai/dsh-system-prompt' {
  interface AssembleContext {
    /** 本次组装对应的 agent；诊断时不存在。存在时，`scope` 必须指向同一个 agent。 */
    agent?: Agent
  }
}

/** 可合并扩展的 agent 创建选项。Persona 属于 system-prompt 分节。 */
export interface AgentOptions {
  /** 提供方路由（调用时必须已注册对应适配器）。 */
  provider?: string
  /** 由所选提供方适配器解释的模型 id。 */
  model?: string
  /** 所选提供方/模型路由上由适配器拥有的推理投入度。 */
  reasoningEffort?: ReasoningEffortId
  /** 每次对话模型请求的最大输出 token 数。 */
  maxTokens?: number
}

/** {@link Agent.cancel} 的选项。 */
export interface CancelOptions {
  /**
   * 保留排队与转向（steering）inbox 条目而不是丢弃它们。活动 turn 仍会
   * 中止，但未开始与待处理的工作会留待之后的 turn，且不会记录已取消的
   * inbox splice。
   */
  keepInbox?: boolean | undefined
}

/** agent 拥有的待处理工作访问；具体存储属于驱动方。 */
export interface Inbox {
  /** 等待各自 turn 的提示词。 */
  readonly nextTurn: readonly UserMessage[]
  /** 等待下一个 step 边界的输入。 */
  readonly nextStep: readonly UserMessage[]

  /** 持久取消全部待处理输入，先清空 next-step 再清空 next-turn。 */
  clear(): void

  /**
   * 向某个待处理列表追加一条消息。
   * @param target - 要扩展的待处理列表。
   * @param message - 要追加的消息。
   */
  append(target: InboxTarget, message: UserMessage): void

  /**
   * 向某个待处理列表前插一条消息。
   * @param target - 要扩展的待处理列表。
   * @param message - 要前插的消息。
   */
  prepend(target: InboxTarget, message: UserMessage): void

  /**
   * 原位替换一条待处理消息。
   * @param messageId - 要替换的待处理消息的身份。
   * @param newMessage - 替换后的消息。
   * @returns 该消息是否仍处于待处理状态。
   */
  replace(messageId: MessageId, newMessage: UserMessage): boolean

  /**
   * 移除一条待处理消息。
   * @param messageId - 要移除的待处理消息的身份。
   * @returns 该消息是否仍处于待处理状态。
   */
  remove(messageId: MessageId): boolean

  /**
   * 应用标准 splice 语义并持久记录归一化结果。
   * @param target - 要变更的待处理列表。
   * @param start - splice 位置。
   * @param deleteCount - 要移除的最大消息数。
   * @param inserted - 在解析出的位置插入的消息。
   * @returns splice 移除的消息。
   */
  splice(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
  ): UserMessage[]
}

/**
 * agent 的生命周期状态，每次转换都以 `agent/status` 发出：
 * `idle` 表示没有驱动方处于活动状态；`running` 从唤醒输入启动可取消的
 * pre-step 处理开始，持续到驱动方耗尽、关闭或对 turn 做检查点为止。
 * 释放会把 agent 从其注册表中移除；它不是第三个可观察状态。
 */
export type AgentStatus = 'idle' | 'running'

/** 循环是否以及携带哪些消息进入一个提议的 step。 */
export type PreStepDecision =
  | { kind: 'reject' }
  | {
    kind: 'enter'
    messages: UserMessage[]
    /** 在本 step 的准入消息之前开启一个独立的模型消息序列。 */
    startsRequestSeries?: true
  }

/** 由拥有模型请求恢复权的监听器返回的动作。 */
export type RequestErrorAction = { kind: 'retry' } | undefined

/** session 生命周期为何开始；种子创建是 `startup`，持久加载是 `resume`。 */
export type SessionStartSource = 'startup' | 'resume' | 'clear' | 'compact'

/** 一次进程本地的活跃助手流式发布。 */
export type AssistantStreamFrame =
  | {
    readonly type: 'start'
    readonly attemptId: LlmAttemptId
    /** 在单个已挂接的 Agent 生命周期内单调递增；替换后从 1 重新开始。 */
    readonly revision: number
    readonly turn: number
    readonly step: number
  }
  | {
    readonly type: 'chunk'
    readonly attemptId: LlmAttemptId
    readonly revision: number
    /** attempt 内稠密的从零开始的位置。 */
    readonly index: number
    /** 由持久内嵌流复用的安全整数时间戳。 */
    readonly time: number
    readonly chunk: StreamChunk
  }
  | {
    readonly type: 'end'
    readonly attemptId: LlmAttemptId
    readonly revision: number
    /** 该 attempt 发出的 chunk 帧数量。 */
    readonly index: number
    /** 在本通知之前提交的持久结算，或没有结算的活跃放弃。 */
    readonly outcome:
      | {
        readonly kind: 'committed'
        readonly eventType: 'assistant/message' | 'assistant/attempt'
        readonly seq: SessionSeq
      }
      | { readonly kind: 'abandoned' }
  }

declare module './types.ts' {
  interface Agent {
    /** 该 agent 的请求所使用的提供方路由与模型。 */
    readonly options: AgentOptions
    /** 该 agent 驱动的活跃 session；其日志是持久的唯一事实来源。 */
    readonly session: Session
    /** agent 拥有的持久待处理工作访问。 */
    readonly inbox: Inbox
    /** 当前生命周期状态，每次 `agent/status` 转换都会同步。 */
    readonly status: AgentStatus
    /** agent 作用域的上下文；其贡献仅对 agent 本地，释放时回退，之后拒绝注册。 */
    readonly ctx: Context

    /**
   * 清除排队与转向工作 —— 除非设置了 `keepInbox` —— 并中止活动的 turn 或
   * turn 间任务。对该活动而言第一个原因生效。没有活动活动时，取消是无操作，
   * 也不会为之后的工作布防。
   * @param cause - 由活动操作信号携带的稳定调用方意图。
   * @param options - 取消选项；`keepInbox` 保留待处理工作。
   */
    cancel(cause: AgentCancelCause, options?: CancelOptions): void

    /**
   * 在当前整个 agent 的活动达到静止后 resolve。它会跟随在观察到的驱动方
   * 退役之前启动的替换工作，但不标识任何特定消息的结算。
   * @returns 在没有活动驱动方或维护任务残留后兑现。
   */
    whenIdle(): Promise<void>

    /**
   * 从真正的 idle 阶段运行一个非 turn 的维护任务。任务在认领该阶段后同步
   * 启动；随后的唤醒输入会留在 inbox 中直到任务结算，同时公开状态保持
   * `idle`。`whenIdle()` 既跟随任务，也跟随排在其后释放的任何唤醒工作。
   * @param task - 其兑现或拒绝被保留的操作，携带一个由 {@link cancel} 中止的信号。
   * @throws 当 turn 驱动或另一个维护任务已拥有该 agent 时同步抛出。
   * @returns 任务 promise。
   */
    runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>

    /**
   * 把已识别的输入路由到 inbox 边界，并可选地唤醒驱动方。在活动取消之后
   * 提交的唤醒输入会为下一个 turn 排队，并在被中止的活动收敛到 idle 时
   * 运行；`disposed` 取消会让它停驻。已经 idle 时提交的唤醒总是打开其
   * turn 边界，即使其消息在驱动方认领之前被清除
   * （[driver wake convergence](../../agent-loop/src/agent.ts)）。
   * @param message - 已识别的内容及其来源。
   * @param target - 首选的 next-turn 或 next-step inbox 边界。
   * @param wakeup - 送达是否可以唤醒驱动方。
   */
    send(message: UserMessage, target: InboxTarget, wakeup: boolean): void

    /**
   * 排队一个普通的后继 turn 并唤醒驱动方。该条目会成为其自身 turn 的
   * 唯一普通消息。
   * @param message - 已识别的提示词内容及其来源。
   */
    followup(message: UserMessage): void

    /**
   * 为最近的 step 提交转向。idle 的驱动方会开启一个 turn；
   * running 的驱动方在下一个 step 边界消费它。
   * 被拒绝的 step 会让转向停驻在 inbox 中直到下一次唤醒；
   * 取消或释放可能丢弃待处理的转向。
   * @param message - 已识别的转向内容及其来源。
   */
    steer(message: UserMessage): void

    /**
   * 为下一个 pre-step 排队面向模型的上下文，而不唤醒驱动方。running 的
   * 驱动方会在最近的后续 step 边界认领它；idle 的驱动方让它保持待处理，
   * 直到 follow-up 或 steering 唤醒它们。它可能错过一个其 pre-step 已
   * 认领批次的请求。取消或释放可能丢弃待处理的上下文。
   * @param message - 已识别的注入上下文及其来源。
   */
    inject(message: UserMessage): void
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    // ---- 生命周期 ----
    /**
     * 已进入的 agent 在工厂搭建完成后即准备好进行按 agent 的初始化。
     * 监听器按顺序运行并在创建 resolve 之前被等待。AgentLoop 会持有排队
     * 输入直到所有监听器结束。抛出或拒绝会使创建失败并跳过后续监听器。
     * 释放会保留 scope 与 session 直到分发结算；监听器不得等待
     * agent.whenIdle() 或其自身所有者的释放。
     * @param payload.agent - 新注册的 agent，连同其活跃 session 与已完成的搭建。
     * @param payload.source - 新建、resume、clear 或 compaction 来源。
     * @param payload.signal - 工厂初始化取消信号（如提供）。
     * Scope 过滤的分发（`@deepseek-ai/dsh-scope`）：agent 作用域的监听器只接收该 agent。
     * @mode serial
     */
    'agent/created'(this: Scoped<Agent>, payload: { agent: Agent; source: SessionStartSource; signal?: AbortSignal }): undefined | Promise<undefined>
    /**
     * 一个 agent 离开了注册表；AgentLoop 在驱动方静止与作用域注册回退之后、
     * session 分离之前发出本事件。自定义注册表的使用者自担其驱动方排序契约。
     * @param payload.agent - 从注册表移除的确切 agent。
     * Scope 过滤的分发（`@deepseek-ai/dsh-scope`）：agent 作用域的监听器只接收该 agent。
     * @mode emit
     */
    'agent/disposed'(this: Scoped<Agent>, payload: { agent: Agent }): void
    /**
     * agent 状态已改变（`idle` ⇄ `running`）。唤醒送达在保留取消之后同步进入
     * `running`；`idle` 表示没有驱动方处于调度或活动状态。
     * @param payload.agent - 状态翻转的 agent。
     * @param payload.status - 刚进入的状态（该转换的目的状态）。
     * Scope 过滤的分发（`@deepseek-ai/dsh-scope`）：agent 作用域的监听器只接收该 agent。
     * @mode emit
     */
    'agent/status'(this: Scoped<Agent>, payload: { agent: Agent; status: AgentStatus }): void
    /**
     * 一条消息进入了活跃 inbox。
     * @param payload.agent - inbox 发生变化的 agent。
     * @param payload.message - 插入的消息。
     * Scope 过滤的分发（`@deepseek-ai/dsh-scope`）：agent 作用域的监听器只接收该 agent。
     * @mode emit
     */
    'agent/inbox/inserted'(this: Scoped<Agent>, payload: { agent: Agent; message: UserMessage }): void
    /**
     * 一条消息在其打开的 turn 内离开了 inbox。如果提议的 step 被拒绝，
     * 被认领的消息就止步于此：它既不被丢弃，也不会重新作为 user/message
     * 发出，turn 在没有 step 的情况下关闭。
     * @param payload.agent - inbox 发生变化的 agent。
     * @param payload.message - 被认领的消息。
     * @param payload.turn - 所属的 turn。
     * Scope 过滤的分发（`@deepseek-ai/dsh-scope`）：agent 作用域的监听器只接收该 agent。
     * @mode emit
     */
    'agent/inbox/claimed'(this: Scoped<Agent>, payload: { agent: Agent; message: UserMessage; turn: number }): void
    /**
     * 一条消息被从活跃 inbox 丢弃。
     * @param payload.agent - inbox 发生变化的 agent。
     * @param payload.message - 被丢弃的消息。
     * Scope 过滤的分发（`@deepseek-ai/dsh-scope`）：agent 作用域的监听器只接收该 agent。
     * @mode emit
     */
    'agent/inbox/discarded'(this: Scoped<Agent>, payload: { agent: Agent; message: UserMessage }): void
    // ---- 机器的扩展点 ----
    /**
     * 拒绝一个提议的 step，或替换进入该 step 的消息。调用 `next()` 表示
     * 保留当前消息。
     * @param payload.agent - 提议该 step 的 agent。
     * @param payload.messages - 为本 step 从 inbox 移除的消息。
     * @param payload.turn - 将拥有该 step 的 turn。
     * @param payload.step - 循环提议的 step。
     * @param payload.signal - 当前 turn 的取消信号。
     * Scope 过滤的分发（`@deepseek-ai/dsh-scope`）：agent 作用域的监听器只接收该 agent。
     * @mode waterfall
     */
    'agent/pre-step'(this: Scoped<Agent>, payload: { agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal }, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>
    /**
     * 替换冻结的调用配置。`await next()` 会得到机器本要使用的配置
     * （首个请求使用 agent 选项，其后使用已记录的请求头）；返回替换值即可
     * 切换。在 step 准入时，本事件在组装与 `step/start` 之后、系统提示词与
     * 已接受的用户批次提交之前运行。此处或后续 `prepareCall()` 解析期间的
     * 取消不会提交二者。prepared call 能力决定提示词准入。模型可见内容必须
     * 走已记录的通道；本 waterfall 不能变更消息。
     * @param payload.agent - 发起模型调用的 agent。
     * @param payload.turn - 打开的 turn 编号。
     * @param payload.step - 本请求所属的 step。
     * @param payload.signal - 当前 turn 的显式中止信号。
     * Scope 过滤的分发（`@deepseek-ai/dsh-scope`）：agent 作用域的监听器只接收该 agent。
     * @mode waterfall
    */
    'agent/request'(this: Scoped<Agent>, payload: { agent: Agent; turn: number; step: number; signal: AbortSignal }, next: () => Promise<LlmCallConfig>): Promise<LlmCallConfig>
    /**
     * 在循环重试或关闭其 step 之前处理一次失败的模型请求尝试。拥有恢复权的
     * 监听器在不调用 `next()` 的情况下返回 `{ kind: 'retry' }`，或调用
     * `next()` 进行委托。默认的 `undefined` 使该失败成为终态。
     * @param payload.agent - 请求失败的 agent。
     * @param payload.turn - 包含失败请求的 turn。
     * @param payload.step - 包含失败请求尝试的 step。
     * @param payload.provider - 为失败请求选定的提供方。
     * @param payload.failure - 在最终适配器边界归一化的可序列化事实。
     * @param payload.retryPolicy - 服务过该失败请求的适配器注册的策略。
     * @param payload.signal - turn 中止信号。
     * Scope 过滤的分发（`@deepseek-ai/dsh-scope`）：agent 作用域的监听器只接收该 agent。
     * @mode waterfall
     */
    'agent/request-error'(this: Scoped<Agent>, payload: { agent: Agent; turn: number; step: number; provider: string; failure: LlmFailure; retryPolicy: ResolvedRetryPolicy | undefined; signal: AbortSignal }, next: () => Promise<RequestErrorAction>): Promise<RequestErrorAction>
    /**
     * 进程本地的助手流发布。chunk 帧是瞬态的；循环会在已提交的 end 帧之前
     * 以同一个流追加一条最终的 v2 `assistant/message` 或 `assistant/attempt`。
     * @param payload.agent - 产生该帧的 attempt 所属的 agent。
     * @param payload.frame - 一次有序的 start、chunk 或 end 发布。
     * Scope 过滤的分发（`@deepseek-ai/dsh-scope`）：agent 作用域的监听器只接收该 agent。
     * @mode emit
     */
    'agent/assistant-stream'(this: Scoped<Agent>, payload: { agent: Agent; frame: AssistantStreamFrame }): void
    /**
     * turn 即将关闭：模型不再欠下响应（没有活跃工具调用，没有新的转向）。
     * 在边界提交之前被等待 —— 提出异议的监听器会转向
     * （`agent.steer(...)`），机器会重读其 inbox：新的转向会再跑一个 step，
     * 没有则关闭 turn。由数据决定，因此监听器顺序无法改变结果。
     * 反向控制（提前停止工具循环）同样是数据：携带 `concludesTurn` 的工具
     * 结果在其 step 处结束 turn。该结论从不短路已提交的 next-step 工作：
     * 同 step 的 `additionalContexts` 或竞争的转向仍会运行，turn 只在 inbox
     * 耗尽时才关闭。
     * @param payload.agent - turn 处于停止边界的 agent。
     * @param payload.turn - 即将关闭的 turn。
     * @param payload.signal - 当前 turn 的显式中止信号。
     * Scope 过滤的分发（`@deepseek-ai/dsh-scope`）：agent 作用域的监听器只接收该 agent。
     * @mode serial
     */
    'agent/turn-stopping'(this: Scoped<Agent>, payload: { agent: Agent; turn: number; signal: AbortSignal }): Promise<void> | void
    // ---- 错误通知（emit）----
    /**
     * 一个 step 或 turn 出错了。即使错误在 turn 内没有可用于持久记录的
     * 位置，机器也会在此报告失败。
     * @param payload.agent - turn 出错的 agent。
     * @param payload.turn - 失败浮现的 turn。
     * @param payload.step - 失败浮现的 step。
     * @param payload.error - 原样的失败。
     * Scope 过滤的分发（`@deepseek-ai/dsh-scope`）：agent 作用域的监听器只接收该 agent。
     * @mode emit
     */
    'agent/error'(this: Scoped<Agent>, payload: { agent: Agent; turn: number; step: number; error: unknown }): void
  }
}
