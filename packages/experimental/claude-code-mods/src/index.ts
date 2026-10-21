/**
 * Claude Code mod 的实验性桥接。一个 mod 是用 {@link defineMod} 围绕 mod 的
 * `register(on, options)` 构建的 DSH 插件；本服务保留已加载的 mod，并从 harness
 * 扩展点触发它们的事件 —— `agent/created` 触发 `session.start`、`agent/pre-step`
 * 触发 `prompt.submit` 和 `turn.start`、`tools/execute` 周围触发 `tool.call`、
 * `turn/end` 触发 `turn.complete`、`agent/disposed` 触发 `session.end`，而
 * mod 注册的命令触发 `command.run`。钩子收到的 `$` 由 {@link createHostOps}
 * 在组合后的 harness 服务之上提供。
 * @module @deepseek-ai/dsh-experimental-claude-code-mods
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-working-directory'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { AssistantMessage, ContentBlock, TokenUsage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { PostToolDecision, ToolExecutionResult, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import type { LoadedMod } from './chain.ts'
import { RewriteRefusedError } from './chain.ts'
import { ModsEngine } from './engine.ts'
import { createHostOps, toolCallResultOf } from './host-ops.ts'
import type { AgentBinding } from './host-ops.ts'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { SurfaceTable } from './surfaces.ts'
import { createToolNameAliases } from './tool-names.ts'
import { messageOf, record, stringify } from './values.ts'
import type {
  ModDefinition, PromptSubmitInput, PromptSubmitResult, SessionEndInput, SessionEndResult, SessionStartInput,
  SessionStartResult, ToolCallInput, ToolCallResult, TurnCompleteInput, TurnCompleteResult, TurnStartInput,
  SurfaceSnapshot, TurnStartResult, TurnUsage, UiRenderInput, UiRenderResult,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    claudeCodeMods: ClaudeCodeMods
  }
}

export type * from './types.ts'
export type { BoxProps, ButtonProps, TextProps, UiElement, UiElements, UiNode } from './elements.ts'
export { defineMod, type ModConfig, type ModPlugin, type ModSpec } from './define-mod.ts'
export { DEFAULT_TOOL_ALIASES } from './tool-names.ts'
export { KNOWN_EVENTS } from './matcher.ts'
export { MODS_API_VERSION } from './host-ops.ts'

/** 插件配置：mod 钩子运行的各项上限。 */
export interface Config {
  /** 钩子自身的运行时间上限，单位毫秒（Claude Code：10 秒）。 */
  hookTimeoutMs?: number
  /** `.catch` 处理器的运行时间上限，单位毫秒（Claude Code：1 秒）。 */
  catchTimeoutMs?: number
  /** `$.process.run` 与 `$.http.fetch` 的默认超时，单位毫秒（Claude Code：30 秒）。 */
  processTimeoutMs?: number
  /** 追加到内置别名表的 Claude Code 工具名 → harness 工具名 条目。 */
  toolAliases?: Record<string, string>
  /** 提示框上方横幅向 `ui.render` 报告的列数，作为 `bodyColumns` 与 `viewport.columns`。 */
  bandColumns?: number
  /** 横幅报告的行数，作为 `maxRows`。 */
  bandRows?: number
}

/** 本宿主触发的引擎事件；钩在其它已知事件上会注册并被报告为未服务。 */
export const SERVED_EVENTS: ReadonlySet<string> = new Set([
  'session.start', 'session.end', 'prompt.submit', 'turn.start', 'turn.complete', 'tool.call', 'command.run', 'ui.render',
])

/** 延迟参数改写机制的定义所在。 */
const REWRITE_NOTE = '.agents/notes/proposed/feature/2026-06-30-pre-tool-input-rewrite.md'

function assertPositive(field: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`claude-code-mods: ${field} must be a positive number of milliseconds`)
}

function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text').map(block => block.text).join('')
}

/** 多条声明中人类自己的消息：即 `prompt.submit` 钩子看到并可改写的提示词。 */
function promptMessages(claimed: readonly UserMessage[]): UserMessage[] {
  return claimed.filter(message => message.source.kind === 'user')
}

/**
 * 把人类消息中的提示词文本整体替换为一段改写后的文本：第一个文本块承载它，
 * 其余文本块丢弃，每个非文本块保持原位。一段没有任何文本块的提示词
 * （例如仅有一张图片）会在其块之后补上这段文本。
 */
function rewritePromptText(prompt: readonly UserMessage[], text: string): UserMessage[] {
  // 写在 map 回调内部，因此该标志保存在后续读取能看到当前值的对象上。
  const placement = { placed: false }
  const rewritten = prompt.map((message) => {
    if (!message.content.some(block => block.type === 'text')) return message
    const content: ContentBlock[] = []
    for (const block of message.content) {
      if (block.type !== 'text') {
        content.push(block)
      } else if (!placement.placed) {
        placement.placed = true
        content.push({ type: 'text', text })
      }
    }
    return { ...message, content }
  })
  const first = rewritten[0]
  if (placement.placed || text.length === 0 || first === undefined) return rewritten
  return [{ ...first, content: [...first.content, { type: 'text', text }] }, ...rewritten.slice(1)]
}

/** 把钩子以块形式附加的上下文，追加到人类最后一条消息中已输入提示词之后。 */
function appendContext(prompt: readonly UserMessage[], context: readonly string[]): UserMessage[] {
  const last = prompt.at(-1)
  /* v8 ignore next -- 调用方只把上下文追加到它自己引发的提示词上，后者至少包含一条人类消息 */
  if (last === undefined) return [...prompt]
  const blocks: ContentBlock[] = context.map(line => ({ type: 'text', text: line }))
  return [...prompt.slice(0, -1), { ...last, content: [...last.content, ...blocks] }]
}

/** 只保留 mod 可设置的 `prompt.submit` 结果字段，各字段按声明类型处理。 */
function acceptPromptSubmit(result: PromptSubmitResult, original: string): PromptSubmitResult {
  if (typeof result.drop === 'string') return { drop: result.drop }
  const context = Array.isArray(result.context) ? result.context.filter((line): line is string => typeof line === 'string') : []
  return { text: typeof result.text === 'string' ? result.text : original, ...context.length === 0 ? {} : { context } }
}

/** 桥接从一次会话的事件流中，关于其进行中轮次所折叠出的内容。 */
interface TurnRecord {
  turn: number
  startedAt: number
  /** 该轮次最后一次提交的助手文本。 */
  answer: string
  usage: TurnUsage | undefined
}

/** 把一条已提交的助手消息折叠进该轮次的答案与用量中。 */
function foldAssistantMessage(turnRecord: TurnRecord, data: { message: AssistantMessage; usage?: TokenUsage }): void {
  turnRecord.answer = textOf(data.message.content)
  if (data.usage === undefined) return
  const { model } = data.message.source
  const usage = turnRecord.usage ?? { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model }
  usage.input_tokens += data.usage.inputTokens
  usage.output_tokens += data.usage.outputTokens
  usage.cache_read_input_tokens += data.usage.cacheReadTokens ?? 0
  usage.cache_creation_input_tokens += data.usage.cacheWriteTokens ?? 0
  usage.model = model
  turnRecord.usage = usage
}

/** 桥接追踪的已脱离 mod 运行，以便卸载时可等待它们完成；拒绝会被上报，绝不会成为未处理异常。 */
class DetachedRuns {
  private readonly pending = new Set<Promise<unknown>>()
  readonly controller = new AbortController()

  constructor(private readonly report: (line: string) => void) {}

  track(label: string, run: Promise<unknown>): void {
    /* v8 ignore next -- 这些运行之下的引擎行为是完备的；report 防范了未来可能出现的拒绝 */
    const settled = run.then(() => undefined, (error: unknown) => { this.report(`${label} failed: ${messageOf(error)}`) })
    this.pending.add(settled)
    void settled.finally(() => { this.pending.delete(settled) })
  }

  /** 中止每次运行的信号；随后 `drain` 会等待它们全部完成。 */
  cancel(): void {
    this.controller.abort(new Error('claude-code-mods disposed'))
  }

  async drain(): Promise<void> {
    this.cancel()
    await Promise.allSettled([...this.pending])
  }
}

/** 一个 mod 答案的无损 JSON 副本；当它没有答案时为 undefined。 */
function jsonValueOf(value: unknown): JsonValue | undefined {
  const text = stringify(value)
  return text === undefined ? undefined : JSON.parse(text) as JsonValue
}

/** 一个错误形态的工具结果，承载 mod 的文本以取代工具自身的文本。 */
function modAnswered(text: string, code: 'MOD_DENIED' | 'MOD_ANSWERED', rendered = text): ToolExecutionResult {
  return {
    isError: true,
    error: { message: text, info: { name: code === 'MOD_DENIED' ? 'ModDenied' : 'ModAnswered', code } },
    content: [{ type: 'text', text: rendered }],
  }
}

/**
 * 桥接服务：已加载的 mod、它们的钩子，以及触发其事件的 harness 监听器。
 * mod 通过 {@link ClaudeCodeMods.add} 加入，这是 mod 插件挂载时 {@link defineMod}
 * 所调用的函数。Remote 方法让 Client 绘制每个会话在提示词上方的横幅，并按下其按钮。
 */
export class ClaudeCodeMods extends TypertRemoteService {
  static Config: z<Config> = z.object({
    hookTimeoutMs: z.number().default(10_000),
    catchTimeoutMs: z.number().default(1_000),
    processTimeoutMs: z.number().default(30_000),
    toolAliases: z.dict(z.string()),
    bandColumns: z.number().default(120),
    bandRows: z.number().default(10),
  })

  // 会话初始化需要其目录所有者；其它服务按需读取。
  static inject = ['workingDirectory']

  private readonly engine: ModsEngine<AgentBinding>
  private readonly registrations = new Map<string, Set<() => void>>()
  private readonly surfaces: SurfaceTable

  constructor(ctx: Context, config: Config) {
    super(ctx, 'claudeCodeMods', { namespace: 'claudeCodeMods' })
    // 模式提供全部默认值；直接构造时只传入它需要的字段。
    const { hookTimeoutMs = 10_000, catchTimeoutMs = 1_000, processTimeoutMs = 30_000, bandColumns = 120, bandRows = 10 } = config
    assertPositive('hookTimeoutMs', hookTimeoutMs)
    assertPositive('catchTimeoutMs', catchTimeoutMs)
    assertPositive('processTimeoutMs', processTimeoutMs)
    assertPositive('bandColumns', bandColumns)
    assertPositive('bandRows', bandRows)
    const aliases = createToolNameAliases(config.toolAliases)
    const callOrigins = new Map<string, LoadedMod>()
    const modCommands = new Set<string>()
    const modTools = new Set<string>()
    const report = (line: string): void => { ctx.logger.warn(`claude-code-mods: ${line}`) }
    const agentOf = (sessionId: string): Agent | undefined => ctx.get('agents')?.get(SessionId(sessionId))
    const detached = new DetachedRuns(report)
    const surfaces = new SurfaceTable({
      columns: bandColumns,
      rows: bandRows,
      render: (sessionId, input) => {
        const agent = agentOf(sessionId)
        /* v8 ignore next -- agent/disposed 在注册表丢弃代理之前就忘记了横幅；与之竞速的一次重绘不会绘制任何内容 */
        if (agent === undefined) return Promise.resolve(null)
        return engine.raise<UiRenderInput, UiRenderResult>('ui.render', input, () => null, {
          binding: { agent }, signal: detached.controller.signal,
        })
      },
      runAction: async (_sessionId, callback) => {
        try {
          await callback()
        } catch (error: unknown) {
          report(`a button's onPress failed: ${messageOf(error)}`)
        }
      },
      report,
    })
    this.surfaces = surfaces
    // 推迟一个宏任务：mod 在触发重绘的 `$` 调用解析之后立即设置自己的状态。
    const redraw = (sessionId: string): void => {
      setTimeout(() => {
        if (agentOf(sessionId) !== undefined) void surfaces.refresh(sessionId)
      }, 0).unref()
    }
    const modSubmissions = new Map<string, string>()
    const ops = createHostOps({
      ctx, aliases, processTimeoutMs, registrations: this.registrations, callOrigins, modCommands, modTools, redraw,
      submitted: (messageId, mod) => { modSubmissions.set(messageId, mod) },
    })
    const engine: ModsEngine<AgentBinding> = new ModsEngine<AgentBinding>({
      ops: op => ops[op],
      stateKey: binding => binding.agent?.session.id ?? '',
      budgetMs: hookTimeoutMs,
      catchBudgetMs: catchTimeoutMs,
      report,
      onStateRead: (key, slot) => { surfaces.stateRead(key, slot) },
      onStateWritten: (key, slot) => { surfaces.stateWritten(key, slot) },
    })
    this.engine = engine
    const registrations = this.registrations
    ctx.effect(() => async () => {
      // 先取消：在 `$` 调用内部等待的定时器回调会在此信号上结束，而 engine.dispose 会等待它。
      detached.cancel()
      surfaces.dispose()
      for (const owned of registrations.values()) for (const dispose of owned) dispose()
      registrations.clear()
      await engine.dispose()
      await detached.drain()
    }, 'claude-code-mods: unload mods')

    // 每次使用时读取：在组合中，注册表可能在本插件之后挂载。
    const isRoot = (agent: Agent): boolean => {
      const agents = ctx.get('agents')
      return agents === undefined || agents.roots().includes(agent)
    }
    /** 收到过 `session.start` 的根代理；代理一旦被释放，注册表便不再列出它。 */
    const startedRoots = new Set<string>()
    const agentIdOf = (agent: Agent | undefined): { agentId: string } | Record<never, never> =>
      agent !== undefined && !isRoot(agent) ? { agentId: agent.id } : {}

    /** 按会话 id 索引、针对进行中轮次的逐会话折叠。 */
    const turns = new Map<string, TurnRecord>()
    /** 已由其首次 pre-step 触发过 `turn.start` 的轮次，按会话 id 索引。 */
    const startedTurns = new Map<string, Set<number>>()
    /** 由 post-execute 监听器作为内容安装的、被改写的工具结果。 */
    const replacements = new Map<ToolExecutionToken, string>()

    ctx.on('agent/created', async ({ agent, signal }) => {
      if (!isRoot(agent)) return
      startedRoots.add(agent.session.id)
      // 取消创建同时会取消目录校验与等待中的钩子。
      /* v8 ignore next -- 循环总是提供初始化信号；载荷类型只是把它保留为可选 */
      const abandon = signal === undefined ? detached.controller.signal : AbortSignal.any([signal, detached.controller.signal])
      const input: SessionStartInput = {
        cwd: await ctx.workingDirectory.ensure(agent, abandon),
        surface: null,
        isInteractive: ctx.get('userQuestions') !== undefined,
      }
      await engine.raise<SessionStartInput, SessionStartResult>(
        'session.start', input, e => ({ cwd: e.cwd }), { binding: { agent }, signal: abandon },
      )
      redraw(agent.session.id)
    })

    ctx.on('agent/disposed', ({ agent }) => {
      const sessionId = agent.session.id
      turns.delete(sessionId)
      startedTurns.delete(sessionId)
      // 代理的作用域注册已随其上下文一起解除；仅剩簿记信息。
      registrations.delete(sessionId)
      surfaces.forget(sessionId)
      const forget = (): Promise<void> => engine.forgetSession(sessionId)
      if (!startedRoots.delete(sessionId)) {
        detached.track('session cleanup', forget())
        return
      }
      const input: SessionEndInput = { reason: 'other', sessionId }
      // `$.state` 仍可读，且会话的定时器持续运行，直到 mod 的 `session.end` 钩子全部完成。
      detached.track('session.end', engine.raise<SessionEndInput, SessionEndResult>(
        'session.end', input, e => ({ sessionId: e.sessionId }), { binding: { agent }, signal: detached.controller.signal },
      ).then(forget, forget))
    })

    ctx.on('agent/pre-step', async ({ agent, messages, turn, signal }, next): Promise<PreStepDecision> => {
      const binding: AgentBinding = { agent }
      const started = startedTurns.get(agent.session.id) ?? new Set<number>()
      startedTurns.set(agent.session.id, started)
      const first = !started.has(turn)
      started.add(turn)
      const prompt = promptMessages(messages)
      const text = textOf(prompt.flatMap(message => message.content))
      let submitted: PromptSubmitResult = { text }
      // 仅一批注入的上下文本身不算提示词：Claude Code 只为键入的提示词触发 prompt.submit。
      if (prompt.length > 0) {
        const submitter = prompt.map(message => modSubmissions.get(message.id)).find(name => name !== undefined)
        for (const message of prompt) modSubmissions.delete(message.id)
        const input: PromptSubmitInput = {
          text,
          wait: false,
          origin: submitter === undefined ? { kind: 'composer' } : { kind: 'plugin', name: submitter },
        }
        submitted = acceptPromptSubmit(await engine.raise<PromptSubmitInput, PromptSubmitResult>(
          'prompt.submit', input, e => ({ text: e.text, ...e.context === undefined ? {} : { context: e.context } }), { binding, signal },
        ), text)
        if (submitted.drop !== undefined) {
          ctx.logger.info(`claude-code-mods: prompt dropped: ${submitted.drop}`)
          return { kind: 'reject' }
        }
      }
      if (first) {
        const input: TurnStartInput = { text: submitted.text, turnId: String(turn), ...agentIdOf(agent) }
        await engine.raise<TurnStartInput, TurnStartResult>('turn.start', input, e => ({ turnId: e.turnId }), { binding, signal })
      }
      const downstream = await next()
      if (downstream.kind !== 'enter' || messages.length === 0) return downstream
      const context = submitted.context ?? []
      if (submitted.text === text && context.length === 0) return downstream
      // 改写后的文本与附加的上下文就地替换人类的消息；其余消息保持不变。
      let edited = submitted.text === text ? [...prompt] : rewritePromptText(prompt, submitted.text)
      if (context.length > 0) edited = appendContext(edited, context)
      const rewritten = new Map<UserMessage, UserMessage>()
      edited.forEach((message, index) => { rewritten.set(prompt[index] as UserMessage, message) })
      return { ...downstream, messages: downstream.messages.map(message => rewritten.get(message) ?? message) }
    })

    ctx.on('tools/execute', async (exec, next): Promise<ToolExecutionResult> => {
      // 一个 mod 通过 `$.tool.call` 引发的调用，只到达它之前加载的 mod，绝不会到达它自身。
      const raisedBy = callOrigins.get(exec.callId)
      const hooks = engine.registry.select('tool.call', raisedBy)
      if (hooks.length === 0) return next()
      const agent = exec.agent
      const callArguments = record(exec.arguments)
      const modName = aliases.toMod(exec.name)
      const input: ToolCallInput = { ...callArguments, tool: modName, tool_use_id: exec.callId, ...agentIdOf(agent) }
      const logged = JSON.stringify(callArguments)
      let beneath: ToolExecutionResult | undefined
      const answer = await engine.raiseWith<ToolCallInput, ToolCallResult>('tool.call', hooks, raisedBy, input, async () => {
        beneath = await next()
        return toolCallResultOf(beneath)
      }, {
        binding: { agent },
        signal: exec.signal,
        // 调用在策略运行前已被记录，因此钩子向下传递的参数必须是已记录的那些。
        validateNext: (e) => {
          const { tool, tool_use_id: _id, agentId: _agentId, ...rest } = e
          if (tool !== modName) {
            throw new RewriteRefusedError(`rerouted the call from ${modName} to ${tool}; the logged call runs the tool it named`)
          }
          if (JSON.stringify(rest) !== logged) {
            throw new RewriteRefusedError(`rewrote the arguments of ${modName}; argument rewrites need the pre-tool input rewrite mechanism (${REWRITE_NOTE})`)
          }
        },
      })
      if (agent !== undefined) redraw(agent.session.id)
      if (answer.deny !== undefined) return modAnswered(answer.deny, 'MOD_DENIED', `Error: ${answer.deny}`)
      const text = typeof answer.result === 'string' ? answer.result : stringify(answer.result) ?? ''
      if (beneath !== undefined) {
        const mapped = toolCallResultOf(beneath)
        if (mapped.result === answer.result && mapped.isError === answer.isError) return beneath
        // 钩子标记为失败的成功会变成失败；失败仍是失败，且携带钩子的文本。
        if (answer.isError === true && !beneath.isError) return modAnswered(text, 'MOD_ANSWERED')
        replacements.set(exec.token, text)
        return beneath
      }
      if (answer.isError === true) return modAnswered(text, 'MOD_ANSWERED')
      if (modTools.has(exec.name)) return { isError: false, value: text, content: [{ type: 'text', text }] }
      // 内置工具的成功值必须满足其自身的输出模式：符合模式的就是工具结果，
      // 其余一律视为错误形态。
      const definition = ctx.get('tools')?.get(exec.name, agent === undefined ? undefined : scopeOf(agent.ctx))
      const value = jsonValueOf(answer.result)
      if (definition !== undefined && value !== undefined && validateJsonSchemaValue(definition.output.schema, value).length === 0) {
        return { isError: false, value, content: definition.output.render(exec.arguments, value) }
      }
      return modAnswered(text, 'MOD_ANSWERED')
    })

    // 一次从未到达 post-execute 的调用（更早的监听器已应答，或管道失败）仍会清除其条目。
    ctx.on('tools/result', (exec) => { replacements.delete(exec.token) })

    ctx.on('tools/post-execute', async (exec, _result, next): Promise<PostToolDecision> => {
      const replacement = replacements.get(exec.token)
      if (replacement === undefined) return next()
      replacements.delete(exec.token)
      const downstream = await next()
      if (downstream.kind === 'block') return downstream
      return {
        kind: 'accept',
        content: [{ type: 'text', text: replacement }],
        ...downstream.additionalContexts === undefined ? {} : { additionalContexts: downstream.additionalContexts },
      }
    })

    ctx.on('session/event', (session, event) => {
      if (event.type === 'turn/start') {
        turns.set(session.id, { turn: event.data.turn, startedAt: Date.now(), answer: '', usage: undefined })
        return
      }
      if (event.type === 'assistant/message') {
        const turnRecord = turns.get(session.id)
        if (turnRecord !== undefined) foldAssistantMessage(turnRecord, event.data)
        return
      }
      if (event.type !== 'turn/end') return
      const { turn, reason } = event.data
      startedTurns.get(session.id)?.delete(turn)
      const agent = ctx.get('agents')?.get(session.id)
      if (agent === undefined) return
      const turnRecord = turns.get(session.id)
      const folded = turnRecord?.turn === turn ? turnRecord : undefined
      const input: TurnCompleteInput = {
        turnId: String(turn),
        answer: folded?.answer ?? '',
        durationMs: folded === undefined ? 0 : Date.now() - folded.startedAt,
        isAborted: reason.kind === 'aborted',
        reason: reason.kind === 'aborted' ? 'aborted' : reason.kind === 'error' ? 'error' : 'answer',
        ...agentIdOf(agent),
        ...folded?.usage === undefined ? {} : { usage: { ...folded.usage } },
      }
      if (folded !== undefined) turns.delete(session.id)
      detached.track('turn.complete', engine.raise<TurnCompleteInput, TurnCompleteResult>(
        'turn.complete', input, () => ({ text: '' }), { binding: { agent }, signal: detached.controller.signal },
      ).then((result) => {
        if (typeof result.text === 'string' && result.text.length > 0) ctx.logger.info(`claude-code-mods: ${result.text}`)
        redraw(session.id)
      }))
    })
  }

  /**
   * 观察一次会话在提示词上方的横幅：先是当前画面，然后每次重绘，直到 Client 停止观察。
   * @param agent - 该会话的代理，由 Gateway 解析。
   * @param signal - 承载的取消信号。
   * @returns 横幅的快照。
   */
  @Remote({ mode: 'stream' })
  watchBand(agent: Agent, signal: AbortSignal): AsyncIterable<SurfaceSnapshot> {
    return this.surfaces.watch(agent.session.id, signal)
  }

  /**
   * 按下横幅当前画面中的一个按钮：运行 mod 的 `onPress` 并重绘。
   * @param agent - 该会话的代理，由 Gateway 解析。
   * @param generation - Client 看到的画面。
   * @param actionId - 该画面中按钮的 action id。
   * @returns 按下后的快照。
   */
  @Remote
  pressBand(agent: Agent, generation: number, actionId: string): Promise<SurfaceSnapshot> {
    return this.surfaces.press(agent.session.id, generation, actionId)
  }


  /**
   * 在所有已加载 mod 之下加载一个 mod：运行它的 `register`，保留它的钩子，
   * 并报告本宿主从未触发的那些事件。
   * @param definition - 其插件所定义的 mod。
   * @returns 处置器，移除该 mod 的钩子、关闭其定时器并释放其注册。
   * @throws 当名称无效或已被占用，或 `register` 抛出异常时（对应 Claude Code 的 `hooks module did not load` 措辞）。
   */
  async add(definition: ModDefinition): Promise<() => Promise<void>> {
    const mod = await this.engine.add(definition)
    const unserved = this.engine.registry.unserved(mod, SERVED_EVENTS)
    this.ctx.logger.info(`claude-code-mods: hooks module ${mod.name}@inline loaded (tier user); events: ${this.engine.describe(mod) || '(none)'}`)
    if (unserved.length > 0) {
      this.ctx.logger.warn(`claude-code-mods: ${mod.name}: on(${unserved.map(event => JSON.stringify(event)).join(', ')}) registered, but this host never raises ${unserved.length === 1 ? 'that event' : 'those events'}`)
    }
    return async () => {
      await this.engine.unload(mod.name)
    }
  }

  /** 按链接顺序的已加载 mod。 */
  get mods(): readonly LoadedMod[] {
    return this.engine.registry.list()
  }
}

export default ClaudeCodeMods
