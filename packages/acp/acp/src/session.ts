/** 一个标准 ACP 会话的 Agent、配置、提示词、更新与销毁生命周期。 */

import type { Context } from '@deepseek-ai/cordis'
import {
  RequestError,
  type McpServer,
  type PromptRequest,
  type PromptResponse,
  type SessionConfigOption,
  type SessionNotification,
  type StopReason,
} from '@agentclientprotocol/sdk'
import type { Agent, AgentHandle, AgentOptions, AgentStatus, ModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage, errorChain, type UserMessage } from '@deepseek-ai/dsh-llm'
import { type Session, type SessionEvent, type SessionId, type TurnEndReason } from '@deepseek-ai/dsh-session'
import { AcpContentError, admitAcpPrompt } from './content.ts'
import { turnEndToStopReason } from './codec.ts'
import { mountAcpMcpServers } from './mcp.ts'
import { AcpModelControl } from './model-control.ts'
import { assistantUpdates, toolCallUpdate, toolResultUpdate } from './updates.ts'

/** 子 agent 的完成与销毁，且不依赖 subagent 包。 */
interface SubagentLifecycle {
  /** 按子优先顺序销毁精确的宿主父级之下的 subagent 后代。 */
  drainDescendants(parents: readonly Agent[]): Promise<void>
  /** 观察当前受管理的后代，但不关闭未来的准入。 */
  waitForChildren(parent: Agent): Promise<boolean>
}

/** 新建与恢复 ACP 会话时共用的输入。 */
interface AcpSessionBuildOptions {
  cwd: string
  mcpServers: readonly McpServer[]
  agentOptions: AgentOptions
  fallbackSelection: ModelSelection | undefined
  signal: AbortSignal
  notify: (notification: SessionNotification) => Promise<void>
}

/** 新建 ACP 会话的构造输入。 */
export interface CreateAcpSessionOptions extends AcpSessionBuildOptions {
  sessionId: SessionId
}

/** 恢复已持久化 ACP 会话的构造输入。 */
export interface ResumeAcpSessionOptions extends AcpSessionBuildOptions {
  sessionId: SessionId
}

interface InflightPrompt {
  resolve: (reason: StopReason) => void
  reject: (error: Error) => void
  messageId: string | undefined
  messageQueued: boolean
  turn: number | undefined
  endReason: TurnEndReason | undefined
  admissionDone: Promise<void>
  finishAdmission: () => void
  admissionController: AbortController
  cancellationDone: PromiseWithResolvers<void>
  cancelStartedIdle: boolean
  settlementStarted: boolean
  outputError: Error | undefined
  agentError: Error | undefined
}

/** 带协议安全详情的标准无效参数失败。 */
function invalidParams(detail: string): RequestError {
  return RequestError.invalidParams(undefined, detail)
}

/** 带协议安全详情的标准内部失败。 */
function internalError(detail: string): RequestError {
  return RequestError.internalError(undefined, detail)
}

/** 在回退到部署配置之前，恢复最近记录的路由。 */
function selectionFor(
  logged: {
    config: { provider: string; model: string; reasoningEffort?: ModelSelection['reasoningEffort'] }
    adapterDefaults?: { reasoningEffort?: boolean }
  } | undefined,
  fallback: ModelSelection | undefined,
): ModelSelection | undefined {
  return logged === undefined
    ? fallback
    : {
      provider: logged.config.provider,
      model: logged.config.model,
      ...logged.config.reasoningEffort === undefined || logged.adapterDefaults?.reasoningEffort === true
        ? {}
        : { reasoningEffort: logged.config.reasoningEffort },
    }
}

/**
 * 单个会话的 ACP 模块。它拥有未发布的 Agent 组合、所选路由、
 * 单个提示词的准入槽位、有序的标准更新以及记忆化的停稳式销毁。
 */
export class AcpSession {
  /** 此 ACP 会话拥有的精确顶层 Agent。 */
  readonly agent: Agent
  private readonly modelControl: AcpModelControl
  private outputTail = Promise.resolve()
  private inflight: InflightPrompt | undefined
  private closing: Promise<void> | undefined
  private readonly pendingSelections = new Map<string, ModelSelection>()

  private constructor(
    private readonly ctx: Context,
    handle: AgentHandle,
    modelControl: AcpModelControl,
    private readonly notify: (notification: SessionNotification) => Promise<void>,
  ) {
    this.agent = handle.agent
    this.modelControl = modelControl
    this.disposeAgent = () => handle.dispose()
  }

  private readonly disposeAgent: () => Promise<void>

  /**
   * 在发布之前组合全新的 Agent 以及所有请求的 MCP 客户端。
   * @param ctx - 带 Agent、LLM 与持久化服务的 ACP 插件上下文。
   * @param options - 新会话的标识、工作区、路由、MCP 与通知器。
   * @returns 完全组合好的按会话模块。
   */
  static async create(ctx: Context, options: CreateAcpSessionOptions): Promise<AcpSession> {
    const modelControl = new AcpModelControl(ctx.llm, options.fallbackSelection)
    const handle = await ctx.agents.create({
      sessionId: options.sessionId,
      meta: { cwd: options.cwd },
      agentOptions: options.agentOptions,
      signal: options.signal,
      setup: async (agentCtx) => {
        modelControl.install(agentCtx)
        await mountAcpMcpServers(agentCtx, options.mcpServers, options.cwd)
      },
    })
    return new AcpSession(ctx, handle, modelControl, options.notify)
  }

  /**
   * 恢复已持久化的 Agent，并组合本次请求的新 MCP 连接。
   * @param ctx - 带 Agent、LLM 与持久化服务的 ACP 插件上下文。
   * @param options - 已持久化的标识、工作区、回退路由、MCP 与通知器。
   * @returns 恢复后的按会话模块。
   */
  static async resume(ctx: Context, options: ResumeAcpSessionOptions): Promise<AcpSession> {
    let modelControl: AcpModelControl | undefined
    const handle = await ctx.agents.resume({
      resumeSessionId: options.sessionId,
      agentOptions: options.agentOptions,
      signal: options.signal,
      setup: async (agentCtx, agent) => {
        modelControl = new AcpModelControl(
          ctx.llm,
          selectionFor(agent.session.requestHeader(), options.fallbackSelection),
        )
        modelControl.install(agentCtx)
        await mountAcpMcpServers(agentCtx, options.mcpServers, options.cwd)
      },
    })
    /* v8 ignore start -- 成功完成的 Agent 恢复必然已把 setup 运行到结束。 */
    if (modelControl === undefined) {
      await handle.dispose()
      throw internalError('session/resume did not compose model selection')
    }
    /* v8 ignore stop */
    return new AcpSession(ctx, handle, modelControl, options.notify)
  }

  /**
   * 此模块是否拥有精确的 Agent 引用。
   * @param agent - 在作用域运行时事件中观察到的 Agent。
   * @returns 仅当它是本会话拥有的 Agent 时为 true。
   */
  owns(agent: Agent): boolean {
    return this.agent === agent
  }

  /**
   * 此模块是否拥有精确的 Session 引用。
   * @param session - 在持久化事件中观察到的 Session。
   * @returns 仅当它是本会话拥有的 Session 时为 true。
   */
  ownsSession(session: Session): boolean {
    return this.agent.session === session
  }

  /**
   * 返回完整的标准模型配置状态。
   * @param signal - 可选的请求取消信号。
   * @returns 按提供方分组的模型选项，以及精确模型的推理选项。
   */
  configOptions(signal?: AbortSignal): Promise<SessionConfigOption[]> {
    this.assertActive()
    return this.modelControl.options(signal)
  }

  /**
   * 将一个标准配置选项应用到后续 ACP 轮次。
   * @param configId - 已声明的标准选项 id。
   * @param value - 选中的标准选项值。
   * @param signal - 可选的请求取消信号。
   * @returns 完整的最终选项状态。
   */
  setConfig(configId: string, value: unknown, signal?: AbortSignal): Promise<SessionConfigOption[]> {
    this.assertActive()
    return this.modelControl.set(configId, value, signal)
  }

  /** 在更新链之外解析拓扑状态，然后串行发送其通知，且不阻塞执行更新。 */
  topologyChanged(): void {
    if (this.closing !== undefined) return
    void this.modelControl.options()
      .then((configOptions) => {
        if (this.closing !== undefined) return
        const previous = this.outputTail
        this.outputTail = previous
          .then(() => this.notify({
            sessionId: this.agent.session.id,
            update: { sessionUpdate: 'config_option_update', configOptions },
          }))
          /* v8 ignore start -- bridge 通知器会收敛传输失败。 */
          .catch((error: unknown) => {
            this.ctx.logger.warn(`acp: config-option update failed: ${errorChain(error)}`)
          })
        /* v8 ignore stop */
      })
      /* v8 ignore start -- 选项发现会收敛每个提供方的失败。 */
      .catch((error: unknown) => {
        this.ctx.logger.warn(`acp: config-option update failed: ${errorChain(error)}`)
      })
    /* v8 ignore stop */
  }

  /**
   * 准入一个提示词，并在根 Agent、后代与更新全部完成后结算。
   * @param params - 本会话的标准 ACP 提示词请求。
   * @param imageEnabled - 初始化时声明的连接能力。
   * @param requestSignal - JSON-RPC 请求取消信号。
   * @returns 有序更新 drain 之后，与本次请求关联的标准停止原因。
   */
  async prompt(
    params: PromptRequest,
    imageEnabled: boolean,
    requestSignal?: AbortSignal,
  ): Promise<PromptResponse> {
    this.assertActive()
    if (this.inflight !== undefined) throw invalidParams('a prompt is already in flight for this session')
    const completion = Promise.withResolvers<StopReason>()
    const admission = Promise.withResolvers<void>()
    const admissionController = new AbortController()
    const inflight: InflightPrompt = {
      resolve: completion.resolve,
      reject: completion.reject,
      messageId: undefined,
      messageQueued: false,
      turn: undefined,
      endReason: undefined,
      admissionDone: admission.promise,
      finishAdmission: admission.resolve,
      admissionController,
      cancellationDone: Promise.withResolvers<void>(),
      cancelStartedIdle: false,
      settlementStarted: false,
      outputError: undefined,
      agentError: undefined,
    }
    this.inflight = inflight
    const onRequestAbort = (): void => { this.cancelPrompt('ACP prompt request cancelled') }
    requestSignal?.addEventListener('abort', onRequestAbort, { once: true })
    /* v8 ignore next -- SDK 分发的是活跃信号，随后通过其监听器通知 abort。 */
    if (requestSignal?.aborted === true) onRequestAbort()
    try {
      let admissionFailure: unknown
      const promptSelection = this.modelControl.snapshot()
      try {
        if (this.ctx.agents.get(this.agent.id) !== this.agent) {
          throw internalError('prompt was not queued: the agent was disposed outside the bridge')
        }
        const content = await admitAcpPrompt(
          this.ctx,
          promptSelection,
          params.prompt,
          imageEnabled,
          admissionController.signal,
        )
        admissionController.signal.throwIfAborted()
        if (this.ctx.agents.get(this.agent.id) !== this.agent) {
          throw internalError('prompt was not queued: the agent was disposed outside the bridge')
        }
        const message = createUserMessage({
          content,
          source: { kind: 'user' },
        })
        inflight.messageId = message.id
        inflight.messageQueued = true
        if (promptSelection !== undefined) this.pendingSelections.set(message.id, promptSelection)
        try {
          this.agent.followup(message)
        } catch (error: unknown) {
          inflight.messageQueued = false
          this.pendingSelections.delete(message.id)
          throw error
        }
      } catch (error: unknown) {
        admissionFailure = error
      } finally {
        inflight.finishAdmission()
      }

      if (inflight.admissionController.signal.aborted) {
        this.settleAfterQuiescence(inflight)
        return { stopReason: await completion.promise }
      }
      if (admissionFailure !== undefined) {
        this.inflight = undefined
        if (admissionFailure instanceof AcpContentError) {
          throw admissionFailure.kind === 'invalid'
            ? invalidParams(admissionFailure.message)
            : internalError(admissionFailure.message)
        }
        if (admissionFailure instanceof RequestError) throw admissionFailure
        throw internalError(`prompt was not queued: ${(admissionFailure as Error).message}`)
      }

      this.settleAfterQuiescence(inflight)
      return { stopReason: await completion.promise }
    } finally {
      requestSignal?.removeEventListener('abort', onRequestAbort)
    }
  }

  /** 取消当前活跃的提示词；没有 ACP 提示词时取消自主工作。 */
  cancel(): void {
    const inflight = this.inflight
    this.cancelPrompt('ACP prompt cancelled')
    if (inflight === undefined) this.agent.cancel({ kind: 'user' })
  }

  /**
   * 处理一个持久化事件，并将其标准 ACP 投影加入队列。
   * @param session - 精确的事件所属 Session。
   * @param event - 已提交的持久化事件。
   */
  onSessionEvent(session: Session, event: SessionEvent): void {
    if (event.type === 'turn/start' && this.inflight?.turn !== undefined) {
      this.inflight.turn = event.data.turn
      this.inflight.endReason = undefined
    }
    try {
      if (event.type === 'assistant/message') {
        const inflight = this.inflight?.turn === event.data.turn ? this.inflight : undefined
        const previous = this.outputTail
        const delivery = previous.then(async () => {
          for (const update of await assistantUpdates(this.ctx, session, event)) {
            await this.notify({ sessionId: this.agent.session.id, update })
          }
        })
        this.outputTail = delivery.catch((error: unknown) => {
          const failure = error as Error
          if (inflight !== undefined) inflight.outputError ??= failure
          this.ctx.logger.warn(`acp: assistant output conversion failed: ${errorChain(error)}`)
        })
      } else if (event.type === 'tool/call') {
        const previous = this.outputTail
        this.outputTail = previous
          .then(() => this.notify({ sessionId: this.agent.session.id, update: toolCallUpdate(event) }))
          /* v8 ignore start -- bridge 通知器会收敛传输拒绝。 */
          .catch((error: unknown) => {
            this.ctx.logger.warn(`acp: tool-call update delivery failed: ${errorChain(error)}`)
          })
        /* v8 ignore stop */
      } else if (event.type === 'tool/result') {
        const previous = this.outputTail
        this.outputTail = previous
          .then(async () => this.notify({
            sessionId: this.agent.session.id,
            update: await toolResultUpdate(this.ctx, event),
          }))
          /* v8 ignore start -- 补充内容转换失败已被收敛，不会让 Agent 工作失败。 */
          .catch((error: unknown) => {
            this.ctx.logger.warn(`acp: tool-result update delivery failed: ${errorChain(error)}`)
          })
        /* v8 ignore stop */
      }
    } finally {
      const inflight = this.inflight
      if (inflight !== undefined && event.type === 'turn/end' && inflight.turn === event.data.turn) {
        inflight.endReason = event.data.reason
        inflight.agentError = undefined
      }
      if (event.type === 'turn/end') this.modelControl.releaseTurn(event.data.turn)
    }
  }

  /**
   * 将已接受的用户消息与其 Agent 轮次及固定路由关联起来。
   * @param message - 已认领的持久化 inbox 消息。
   * @param turn - 已分配的 Agent 轮次。
   */
  onInboxClaimed(message: UserMessage, turn: number): void {
    if (this.inflight !== undefined && this.inflight.messageId === message.id) this.inflight.turn = turn
    const selection = this.pendingSelections.get(message.id)
    this.pendingSelections.delete(message.id)
    if (selection !== undefined) this.modelControl.pinTurn(turn, selection)
  }

  /**
   * 将 Agent 活动区间内的失败与当前活跃的 ACP 提示词关联起来。
   * @param error - 原始的进程内失败。
   */
  onAgentError(error: unknown): void {
    const inflight = this.inflight
    if (inflight === undefined || !inflight.messageQueued) return
    // 之后提交的 turn/end 会取代这个仍在活动中的失败。轮次 start/end 追加失败时
    // 没有终态记录，失败因此保持可见。
    inflight.agentError = new Error(errorChain(error))
    this.settleAfterQuiescence(inflight)
  }

  /**
   * 完成已取消的活动，但不跟随之后启动的根驱动。
   * @param status - 已发出的状态转换，它可能先于一次重入唤醒。
   */
  onAgentStatus(status: AgentStatus): void {
    const inflight = this.inflight
    if (inflight === undefined || !inflight.messageQueued || !inflight.admissionController.signal.aborted) return
    // 维护操作对外仍处于空闲；它接下来的 running 转换属于维护任务结束后
    // 才放行的工作。
    if (status === 'idle' || inflight.cancelStartedIdle) inflight.cancellationDone.resolve(this.outputTail)
  }

  /** 等待本次调用之前排队的每个更新。 */
  drainUpdates(): Promise<void> {
    return this.outputTail
  }

  /**
   * 一次性完成本会话的取消、drain、flush 与释放。
   * @param detail - 仍处于准入阶段的提示词所使用的取消详情。
   * @returns 共享的停稳式销毁 Promise。
   */
  close(detail: string): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.closing = (async () => {
      const failures: unknown[] = []
      const inflight = this.inflight
      this.cancelPrompt(detail)
      if (inflight === undefined || !inflight.messageQueued) this.agent.cancel({ kind: 'user' })
      try {
        await inflight?.admissionDone
        await this.agent.whenIdle()
        await this.outputTail
      } catch (error: unknown) {
        failures.push(new Error('ACP session activity drain failed', { cause: error }))
      }
      const subagents = this.ctx.get('subagents') as SubagentLifecycle | undefined
      try {
        await subagents?.drainDescendants([this.agent])
      } catch (error: unknown) {
        this.ctx.logger.warn(`acp: subagent teardown failed: ${errorChain(error)}`)
        failures.push(new Error('subagent teardown failed', { cause: error }))
      }
      try {
        await this.ctx.sessions.flush(this.agent.session)
      } catch (error: unknown) {
        failures.push(new Error('ACP session persistence flush failed', { cause: error }))
      }
      try {
        await this.disposeAgent()
      } catch (error: unknown) {
        failures.push(error)
      }
      this.pendingSelections.clear()
      if (failures.length === 1) throw failures[0]
      /* v8 ignore start -- 只有多个提供方同时故障时，独立的销毁失败才可能聚合。 */
      if (failures.length > 1) {
        throw new AggregateError(failures, `ACP session teardown failed: ${failures.map(errorChain).join('; ')}`)
      }
      /* v8 ignore stop */
    })()
    return this.closing
  }

  private assertActive(): void {
    if (this.closing !== undefined) throw invalidParams(`session is closing: ${this.agent.session.id}`)
  }

  private cancelPrompt(detail: string): void {
    const inflight = this.inflight
    if (inflight === undefined) return
    const firstCancellation = !inflight.admissionController.signal.aborted
    if (firstCancellation) inflight.cancelStartedIdle = this.agent.status === 'idle'
    inflight.admissionController.abort(new Error(detail))
    this.settleAfterQuiescence(inflight)
    if (!inflight.messageQueued) {
      inflight.cancellationDone.resolve()
      return
    }
    this.agent.cancel({ kind: 'user' })
    if (firstCancellation) {
      const done = inflight.cancellationDone
      // 插件释放可能在此活动结束之前就移除状态观察者。
      void this.agent.whenIdle().then(() => { done.resolve(this.outputTail) }, done.reject)
    }
  }

  private settleAfterQuiescence(inflight: InflightPrompt): void {
    if (inflight.settlementStarted) return
    inflight.settlementStarted = true
    void (async () => {
      await inflight.admissionDone
      if (inflight.messageQueued) {
        const subagents = this.ctx.get('subagents') as SubagentLifecycle | undefined
        const cancelled = inflight.cancellationDone.promise
        const isCancelled = (): boolean => inflight.admissionController.signal.aborted
        const idleAt = (seq: Session['seq']): boolean => this.agent.status === 'idle' && this.agent.session.seq === seq
        while (true) {
          await Promise.race([this.agent.whenIdle(), cancelled])
          if (isCancelled()) break
          const idleSeq = this.agent.session.seq
          const children = await Promise.race([subagents?.waitForChildren(this.agent), cancelled])
          if (isCancelled()) break
          if (children || !idleAt(idleSeq)) continue
          await this.outputTail
          if (isCancelled() || idleAt(idleSeq)) break
        }
        if (isCancelled()) await cancelled
      }
      /* v8 ignore next -- 此提示词在自身的精确结算清除槽位之前一直拥有该槽位。 */
      if (this.inflight !== inflight) return
      this.inflight = undefined
      if (inflight.admissionController.signal.aborted) {
        inflight.resolve('cancelled')
        return
      }
      if (inflight.outputError !== undefined) {
        inflight.reject(internalError(`assistant output delivery failed: ${inflight.outputError.message}`))
        return
      }
      if (inflight.agentError !== undefined) {
        inflight.reject(internalError(`turn failed: ${inflight.agentError.message}`))
        return
      }
      const end = inflight.endReason
      if (end === undefined) {
        inflight.resolve('cancelled')
      } else if (end.kind === 'error') {
        inflight.reject(internalError(`turn failed: ${end.error.message}`))
      } else {
        inflight.resolve(turnEndToStopReason(end))
      }
    })()
      /* v8 ignore start -- admissionDone 只会 resolve；idle/output 门各自收敛自身失败。 */
      .catch((error: unknown) => {
        if (this.inflight !== inflight) return
        this.inflight = undefined
        inflight.reject(internalError(`prompt settlement failed: ${errorChain(error)}`))
      })
    /* v8 ignore stop */
  }
}
