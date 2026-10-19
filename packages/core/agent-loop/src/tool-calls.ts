/**
 * 为一个 assistant 步骤的工具调用排期。独占调用形成屏障；
 * 并行调用使用有界的滚动池，并在启动前重新分类。
 * 分派可以重叠，而策略、结果和结果上下文保持模型顺序。
 * 中止或内部调度器故障会停止补充并排空已启动的调用。
 *
 * 中止会为被跳过的调用记录合成的错误结果，以保持重放有效。
 * 终态调度器故障在排空后拒绝；所属步骤在关闭前
 * 记录保守的恢复结果。
 * @module dsh-agent-loop/tool-calls
 */

import type { Context } from '@deepseek-ai/cordis'
import { createToolResultMessage, type ToolCallBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionSeq, UserMessage } from '@deepseek-ai/dsh-session'
import { TOOL_ABORTED_BEFORE_DISPATCH, TOOL_RUNTIME_SCHEDULER, type ToolExecutionInput, type ToolExecutionMode, type ToolExecutionResult, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { assertNever } from '@deepseek-ai/dsh-util-values'

/** 参数解析后的单个工具调用，等待排期。 */
interface PlannedCall {
  block: ToolCallBlock
  exec: ToolExecutionInput
}

/** 已完结的分派，等待按模型顺序最终定稿。 */
interface Slot {
  exec: ToolRunContext
  result: ToolExecutionResult
  needsPost: boolean
}

/** 一个调度器组的结果，包括已排空的中止。 */
interface GroupOutcome {
  consumed: number
  aborted: boolean
  /** 是否有任何已提交结果携带 {@link ToolExecutionResult.concludesTurn}。 */
  concluded: boolean
}

/**
 * 按实时的并发模式为一个 assistant 步骤的工具调用排期。
 * 常规完成与中止都按顺序提交已启动调用的结果。中止会排空它们、
 * 为未启动的调用记录合成结果，并在通过调用方提供的 acceptor
 * 接收已启动调用的上下文之后，返回时信号仍处于中止状态
 * （机器将其暂存在其 next-step 收件箱中，用于步骤边界）。内部调度器故障
 * 会停止新的分派、排空已启动的分派，并以首个故障拒绝。所属步骤
 * 为没有已提交结果的请求提供错误结果。
 * 已提交步骤的 AgentLoop 驱动边界提供发起 Agent，
 * 该 Agent 成为每个显式 {@link ToolExecutionInput.agent}。
 *
 * @param ctx - 拥有工具注册表并携带发起 Agent 的循环上下文。
 * @param turn - 当前 turn 编号。
 * @param step - 当前 step 编号。
 * @param toolCalls - 按模型顺序排列的 assistant 调用。
 * @param signal - 该步骤共享的中止信号。
 * @param acceptContext - 为下一步边界接收已提交的结果上下文。
 */
export async function executeToolCalls(
  ctx: Context,
  turn: number,
  step: number,
  toolCalls: ToolCallBlock[],
  signal: AbortSignal,
  acceptContext: (context: UserMessage) => void,
): Promise<{ concluded: boolean }> {
  const agent = ctx.agents.requireInitiator()
  const { session } = agent

  // 各输入互不相同，因为 tools/execute 包装器可能替换 `exec.signal`。
  const planned: PlannedCall[] = toolCalls.map(block => ({
    block,
    exec: {
      callId: block.id,
      name: block.name,
      arguments: parseArguments(block.arguments),
      agent,
      signal,
    },
  }))

  let next = 0
  let concluded = false
  while (next < planned.length) {
    // 在重新分类之前先提交，使注册表变更影响未启动的调用。
    // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded by the loop condition
    const first = planned[next]!
    const mode = ctx.tools.executionMode(first.exec).kind
    const group = mode === 'parallel' ? planned.slice(next) : [first]
    const outcome = await runGroup(
      ctx, turn, step, group, mode, signal, acceptContext,
    )
    next += outcome.consumed
    concluded ||= outcome.concluded
    if (outcome.aborted) {
      for (const call of planned.slice(next)) appendSkippedToolCall(session, turn, step, call.block)
      return { concluded }
    }
  }
  return { concluded }
}

/** 解析模型参数，将无效 JSON 保留为文本，并将空输入映射为 `{}`。 */
function parseArguments(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) : {}
  } catch {
    return raw
  }
}

/**
 * 运行一个独占屏障或并行池。后续调用在启动前会被重新分类；
 * 重新分类为独占时会等待当前池排空，并保留给调用方的下一个屏障。
 * 结果和上下文按模型顺序提交。中止会停止启动、排空并提交已启动的调用、
 * 将它们的上下文接收到所属批次中、为被跳过的调用记录结果，
 * 并返回已中止的结果。调度器故障会排空分派并拒绝，
 * 由所属步骤记录恢复结果。
 */
async function runGroup(
  ctx: Context,
  turn: number,
  step: number,
  group: PlannedCall[],
  mode: ToolExecutionMode['kind'],
  signal: AbortSignal,
  acceptContext: (context: UserMessage) => void,
): Promise<GroupOutcome> {
  const { session } = ctx.agents.requireInitiator()
  const maxParallelToolCalls = ctx.agentLoop.config.maxParallelToolCalls.get()
  const slots: (Slot | undefined)[] = group.map(() => undefined)
  // 已启动的槽位保留其 `tool/call` seq，以便结果可以引用它。
  const callSeqs: Array<SessionSeq | undefined> = group.map(() => undefined)
  let nextToStart = 0
  let committed = 0
  let started = 0
  let aborted: boolean = signal.aborted
  let concluded = false
  let schedulerFailure: { error: unknown } | undefined
  const throwSchedulerFailure = (): void => {
    if (schedulerFailure !== undefined) throw schedulerFailure.error
  }

  // `committed` 仅跨连续的模型顺序槽位推进。
  const commitReady = async (): Promise<void> => {
    while (committed < group.length) {
      const slot = slots[committed]
      if (slot === undefined) break
      const call = group[committed]
      const result = slot.needsPost
        ? await ctx.tools[TOOL_RUNTIME_SCHEDULER].finalize(slot.exec, slot.result)
        : ctx.tools[TOOL_RUNTIME_SCHEDULER].finish(slot.exec, slot.result)
      // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded index
      appendToolResult(session, turn, step, call!.block, result, callSeqs[committed]!)
      for (const context of result.additionalContexts ?? []) acceptContext(context)
      concluded ||= result.concludesTurn === true
      committed++
    }
  }

  const inFlight = new Map<number, Promise<number>>()

  const startCall = async (index: number): Promise<void> => {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded index
    const call = group[index]!
    callSeqs[index] = appendToolCall(session, turn, step, call.block)
    started++
    const prepared = await ctx.tools[TOOL_RUNTIME_SCHEDULER].prepare(call.exec)
    throwSchedulerFailure()
    switch (prepared.kind) {
      case 'dispatch': {
        const promise = ctx.tools[TOOL_RUNTIME_SCHEDULER].dispatch(prepared.exec).then(
          (outcome) => {
            slots[index] = { exec: prepared.exec, result: outcome.result, needsPost: outcome.kind === 'post-result' }
            return index
          },
          (error: unknown) => {
            schedulerFailure ??= { error }
            return index
          },
        )
        inFlight.set(index, promise)
        break
      }
      case 'post-result':
        slots[index] = { exec: prepared.exec, result: prepared.result, needsPost: true }
        break
      case 'final-result':
        slots[index] = { exec: prepared.exec, result: prepared.result, needsPost: false }
        break
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        assertNever(prepared, 'tool-call scheduler prepare result')
    }
  }

  const fillPool = async (): Promise<void> => {
    while (!aborted && nextToStart < group.length && inFlight.size < maxParallelToolCalls) {
      // 在按顺序提交之后重新读取后续模式，使注册表变更可以形成屏障。
      // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded by the loop condition
      const nextCall = group[nextToStart]!
      if (nextToStart > 0 && mode === 'parallel'
        && ctx.tools.executionMode(nextCall.exec).kind !== 'parallel') break
      await startCall(nextToStart)
      nextToStart++
      throwSchedulerFailure()
      await commitReady()
      throwSchedulerFailure()
      // 预执行等待期间可能发生中止。
      if (signal.aborted) aborted = true
    }
  }

  // 按顺序的预执行可能等待；只有 dispatch/body 会重叠。调度器故障
  // 会停止新的分派，并在每个已启动的分派落定后到达 turn 边界。
  try {
    await fillPool()
    while (inFlight.size > 0) {
      const settledIndex = await Promise.race(inFlight.values())
      inFlight.delete(settledIndex)
      throwSchedulerFailure()
      await commitReady()
      throwSchedulerFailure()
      // 工具或按顺序提交等待期间可能发生中止。

      if (signal.aborted) aborted = true
      await fillPool()
    }
  } catch (error: unknown) {
    schedulerFailure ??= { error }
    await Promise.allSettled(inFlight.values())
    throw schedulerFailure.error
  }

  if (aborted) {
    // 已启动的调用和已接收的上下文先落定；随后每个剩余的模型
    // 调用都在 turn 中止前收到一个按顺序的合成结果。
    for (const call of group.slice(started)) appendSkippedToolCall(session, turn, step, call.block)
    return { consumed: group.length, aborted: true, concluded }
  }
  /* v8 ignore next -- unreachable: a non-aborted group commits every started call */
  if (committed !== started) throw new Error('tool-call scheduler: uncommitted settled calls')
  return { consumed: started, aborted: false, concluded }
}

/** 为取消后被跳过的模型调用追加持久的调用/结果对。 */
function appendSkippedToolCall(session: Session, turn: number, step: number, block: ToolCallBlock): void {
  const callSeq = appendToolCall(session, turn, step, block)
  appendToolResult(session, turn, step, block, {
    content: [{ type: 'text', text: 'Error: tool call aborted before dispatch' }],
    isError: true,
    error: {
      message: 'tool call aborted before dispatch',
      info: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH },
    },
  }, callSeq)
}

/** 追加一个已启动的调用，并返回其结果必须引用的事件 seq。 */
function appendToolCall(session: Session, turn: number, step: number, block: ToolCallBlock): SessionSeq {
  const event = session.append('tool/call', { turn, step, callId: block.id, name: block.name, arguments: block.arguments })
  return event.seq
}

/** 追加一个链接到其调用事件的按模型顺序排列的结果。 */
function appendToolResult(
  session: Session,
  turn: number,
  step: number,
  block: ToolCallBlock,
  result: ToolExecutionResult,
  callSeq: SessionSeq,
): void {
  const message = createToolResultMessage({
    callId: block.id,
    content: result.content,
    isError: result.isError,
  })
  session.append('tool/result', {
    turn, step,
    message,
    ...result.error?.info ? { error: result.error.info } : {},
    // 工具的私有呈现负载（例如结果时的 diff），
    // 持久化保存，使 UI 桥接能在重放时重现卡片。
    ...result.meta !== undefined ? { meta: result.meta } : {},
  }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
}
