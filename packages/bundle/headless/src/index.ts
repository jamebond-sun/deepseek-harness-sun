/**
 * @deepseek-ai/dsh-headless —— 一次性的直接 Agent 驱动器。该 bundle 补丁叠加在
 * dsh-base 之上，不含 Host、HTTP 或浏览器插件；本 runner 通过核心注册表创建一个
 * Agent（或沿用 `--session-id` 所指名的确切 Session），把任务驱动到静止，把 provider
 * 的思考过程流式输出到 stderr，冲刷其 Session，把最终的 assistant 文本打印到
 * stdout 并退出。使用 `--json` 时，它以换行分隔的事件形式投影本次运行，而不是输出
 * 最终文本。
 *
 * @module @deepseek-ai/dsh-headless
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
// 这些空类型导入带来：loader 的 Context 合并（用于 await 树装配完成）、cmdline 的
// Context 合并（用于 appExit 宿主值），以及 sessionQuery 的 Context 合并（用于精确
// 沿用已有 Session）。
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-subagent'
import { internals } from './runner-internals.ts'
import { projectJsonRun, boundJsonLine } from './json-stream.ts'

/** 稳定的 Cordis 插件名。 */
export const name = 'headless-runner'

/** 一次性轮次开始之前所需的核心服务。 */
export const inject = ['agentDefaultModel', 'agents', 'sessions']

/** 插件配置：任务与运行选项，从本应用注入的提供者服务解析而来。 */
export interface Config {
  /** 本次单次运行的提示词文本；任务来自 stdin 时缺省。 */
  task?: string
  /** 要沿用的确切 Session 身份；缺省时使用新的随机身份。没有已存储 Session 的 id 会失败。 */
  sessionId?: string
  /** stdout 是否输出机器可读的事件流而不是最终文本。 */
  json?: boolean
}

export const Config: z<Config> = z.object({
  task: z.string(),
  sessionId: z.string(),
  json: z.boolean(),
})

/** 一次所持运行区间的结果。 */
interface RunOutcome {
  text: string
  reason: SessionEvent<'turn/end'>['data']['reason'] | undefined
}

/** 一次运行的进程侧副作用：输出流，加上启动器的有界退出请求。 */
interface HeadlessIo {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
  /** 在树 dispose 之后以 `code` 请求进程退出。 */
  exit(code: number): void
}

/** 在一个所持区间内聚合最后的 assistant 文本与轮次结果。 */
function summarize(session: Session, firstSeq: SessionLogOffset): RunOutcome {
  let started = false
  let text = ''
  let reason: SessionEvent<'turn/end'>['data']['reason'] | undefined
  const length = session.seq
  for (let seq = firstSeq; seq < length; seq++) {
    // oxlint-disable-next-line typescript/no-deprecated -- 既有的 Session 历史读取；迁移已推迟。
    const event = session.eventAt(SessionSeq(seq))
    if (event === undefined) {
      throw new Error(`headless summary cannot read seq ${String(seq)} below captured length ${String(length)}`)
    }
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') reason = event.data.reason
  }
  return { text, reason }
}

/**
 * 把一次所持运行中 provider 上报的思考过程边流式接收边输出到 stderr，同时把最终
 * 结果的推导保留在持久化日志上。
 * @param ctx - 承载实时 Assistant 帧推送的插件上下文。
 * @param agent - 其思考过程属于本次调用的确切 Agent。
 * @param stderr - 进度输出目标。
 * @returns 一个 disposer，它同时会结束未以换行符收尾的思考输出行。
 */
function streamReasoning(
  ctx: Context,
  agent: Agent,
  stderr: HeadlessIo['stderr'],
): () => void {
  let open = false
  let endsWithNewline = true
  const close = (): void => {
    if (!open) return
    if (!endsWithNewline) stderr.write('\n')
    open = false
    endsWithNewline = true
  }
  const dispose = ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
    if (subject !== agent) return
    if (frame.type === 'start') {
      close()
      return
    }
    if (frame.type === 'end') {
      close()
      return
    }
    const chunk = frame.chunk
    switch (chunk.type) {
      case 'reasoning-delta':
        if (chunk.text === '') return
        if (!open) {
          stderr.write('dsh: reasoning:\n')
          open = true
        }
        stderr.write(chunk.text)
        endsWithNewline = chunk.text.endsWith('\n')
        return
      case 'block-start':
        if (chunk.blockType !== 'reasoning') close()
        return
      case 'block-end':
        if (chunk.block.type !== 'reasoning') close()
        return
      case 'usage':
        return
      case 'text-delta':
      case 'tool-call-delta':
      case 'finish':
        close()
        return
      /* v8 ignore next -- 封闭联合的穷尽性守卫 */
      default:
        return assertNever(chunk, 'headless reasoning stream')
    }
  })
  return () => {
    dispose()
    close()
  }
}

/** 决定 runner 是否可以直接驱动该 Session 的 Session 事实。 */
interface AdoptableHeader {
  cwd?: string | undefined
  origin?: 'subagent' | undefined
  parentSession?: SessionId | undefined
  agentPreset?: string | undefined
}

/** 按顺序迭代一个实时 Session 的持久化事件。 */
function* liveEvents(session: Session): Generator<SessionEvent> {
  const length = session.seq
  for (let seq = 0; seq < length; seq++) {
    // oxlint-disable-next-line typescript/no-deprecated -- 既有的 Session 历史读取；迁移已推迟。
    const event = session.eventAt(SessionSeq(seq))
    if (event === undefined) {
      throw new Error(`headless adoption cannot read seq ${String(seq)} below captured length ${String(length)}`)
    }
    yield event
  }
}

/**
 * Session 当前所运行的 preset：它的创建 header，并由最后一个 `agent-preset/selected`
 * 事件推进。header 只是创建时的事实；presets 插件从投影重建一个 session 的组成。
 */
function currentPreset(header: AdoptableHeader, events: Iterable<SessionEvent>, sessionId: SessionId): string | undefined {
  let preset = header.agentPreset
  for (const event of events) {
    // 该事件归属于 dsh-agent-preset-registry，而本 bundle 并未编排它，因此这里以
    // 结构化方式读取事件，而不经过其模块扩展。
    const candidate = event as unknown as { type: string; data?: { agentPreset?: unknown } }
    if (candidate.type !== 'agent-preset/selected') continue
    const selected = candidate.data?.agentPreset
    // 损坏的记录不能被读作“没有 preset”：那样会让本次运行在本 bundle 的组成下继续，
    // 而不是在其日志记录的那套组成下运行。
    if (typeof selected !== 'string' || selected === '') {
      throw new Error(`session "${sessionId}" records a malformed agent-preset/selected event and cannot be adopted`)
    }
    preset = selected
  }
  return preset
}

/** 拒绝一次性 runner 不得沿用的 Session。 */
function assertAdoptable(header: AdoptableHeader, events: Iterable<SessionEvent>, sessionId: SessionId, cwd: string): void {
  const preset = currentPreset(header, events, sessionId)
  if (preset !== undefined) {
    // 本 bundle 未编排任何 preset 名单，因此在这里恢复该 session 会让它静默地
    // 在 headless 的工具与提示词下运行，而不是在其日志记录的那套组成下运行。
    throw new Error(
      `session "${sessionId}" runs under agent preset "${preset}", which the one-shot runner does not compose`,
    )
  }
  if (header.origin === 'subagent' || header.parentSession !== undefined) {
    throw new Error(`session "${sessionId}" is a subagent or forked session and cannot be driven directly`)
  }
  if (header.cwd === undefined) {
    throw new Error(`session "${sessionId}" recorded no working directory, so it cannot be adopted`)
  }
  if (header.cwd !== cwd) {
    throw new Error(`session "${sessionId}" was recorded in "${header.cwd}", not "${cwd}"`)
  }
}

/**
 * 为一次运行解析 Agent：沿用带有所请求 id 的持久化 Session。该身份必须已存在，
 * 且其下不得有存活的 Agent；否则首轮直接省略该选项，因此拼写错误无法伪装成一次
 * 全新对话。
 * @param ctx - 承载 Session 查询服务的插件上下文。
 * @param agents - 核心 Agent 注册表。
 * @param sessionId - 要沿用的确切 Session 身份。
 * @param agentOptions - 本次运行的 provider/model 组合。
 * @param setup - 安装模型选择的每 Agent 作用域设置。
 * @param cwd - 在已挂载文件系统中解析出的工作目录。
 * @returns 恢复后的 Agent。
 */
async function resolveAgent(
  ctx: Context,
  agents: Context['agents'],
  sessionId: SessionId,
  agentOptions: { provider: string; model: string },
  setup: (agentCtx: Context) => void,
  cwd: string,
): Promise<Agent> {
  // 恢复（resume）向调用方承诺一份后续进程可继续的日志。没有持久化日志时，运行仍会
  // 成功并打印 id，却在退出时丢失全部历史，因此组成有误的 profile 必须在恢复之前
  // 就显式失败。
  if (ctx.get('sessionPersistence') === undefined) {
    throw new Error('headless --session-id requires the sessionPersistence service; the Session would not survive this process')
  }
  // 后续进程不持有存活的 Agent，必须通过查询服务找到该 id，因此每次 --session-id
  // 运行都依赖它。
  const query = ctx.get('sessionQuery')
  if (query === undefined) {
    throw new Error('headless --session-id requires the sessionQuery service; dsh-base provides it')
  }
  const live = agents.get(sessionId)
  if (live !== undefined) {
    // 存活的 Agent 已有持有者，该持有者仍可能驱动它，而 `whenIdle` 并非单条消息的
    // 信号：把它的下一段区间并入本次运行，会把该持有者的事件——甚至它的最终答复——
    // 混进本流。runner 无法对它未创建的 Agent 主张独占运行区间，因此拒绝该身份；
    // 沿用性规则先执行，以便指出真实的不匹配，而不是抛出笼统的拒绝。
    assertAdoptable(live.session.header, liveEvents(live.session), sessionId, cwd)
    throw new Error(`session "${sessionId}" is live in this process, so the one-shot runner cannot own an exclusive run interval`)
  }
  try {
    using observation = await query.observeSession(sessionId)
    assertAdoptable(observation.header, observation.events, sessionId, cwd)
    const { agent } = await agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
    // observe 结果是一份快照：在本进程取得写租约之前，另一个写入者可能已追加了
    // preset 选择。此时已无其他进程可以追加，因此重新检查 resume 实际挂接的那份日志。
    assertAdoptable(agent.session.header, liveEvents(agent.session), sessionId, cwd)
    return agent
  } catch (error: unknown) {
    if (!(error instanceof SessionQueryError) || error.code !== 'SESSION_QUERY_SESSION_NOT_FOUND') throw error
    // --session-id 用于恢复一条已存在的对话；发起新对话走的是不带 id 的路径，它会
    // 自行生成身份并在 `session` 事件中报告。这里若创建所请求的 id，会把一次拼写
    // 错误变成一段全新的空历史，而调用方还以为自己在继续原有对话。
    throw new Error(`session "${sessionId}" does not exist; omit --session-id to start a new Session`)
  }
}

/** 报告一次意外的直接驱动失败，并请求以失败码退出。 */
function fail(io: HeadlessIo, error: unknown, json: boolean): void {
  const message = error instanceof Error ? error.message : String(error)
  if (json) io.stdout.write(`${boundJsonLine({ type: 'error', message })}\n`)
  io.stderr.write(`dsh: ${message}\n`)
  io.exit(1)
}

/**
 * 通过一个 Agent 运行一个任务，并请求进程退出。
 * 存活 Agent 的失败需要在此之后出现持久化的终态事件，一次恢复出的运行才可能成功。
 * @param ctx - 承载 Agent、默认模型、Session 与启动器 IO 服务的插件上下文。
 * @param config - 任务、可选的精确 Session 身份与输出模式。
 * @param io - 进程侧的副作用。
 */
async function run(ctx: Context, config: Config, io: HeadlessIo): Promise<void> {
  // Loader 的兄弟行并发挂载。在创建 Agent 之前等待整个应用完成，以免它的作用域内
  // 工具与适配器只装配了一半。
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  // 进程提前关闭时，树可能在装配尚未完成的情况下就被 dispose。
  if (agents === undefined || defaultModel === undefined || sessions === undefined) return

  // Cordis overlay 直接设置该行并绕过 CLI 的空白检查，因此同一个公开设置必须在这里
  // 失败，而不是变成空身份。
  if (config.sessionId !== undefined && config.sessionId.trim() === '') {
    throw new Error('headless-runner: sessionId must not be blank')
  }

  const task = config.task === undefined || config.task === '-'
    ? await internals.readStdin()
    : config.task
  if (task.trim() === '') {
    throw new Error('a task is required, for example: dsh --profile headless "run the tests"')
  }

  const selection = defaultModel.currentSelection()
  const agentOptions = { provider: selection.provider, model: selection.model }
  // 本 bundle 未编排任何 preset 名单，因此面向模型的那些行位于宿主层，agent 从
  // 全局层读取它们。确实配置了 preset 的部署必须先在这里接入
  // （参见 @deepseek-ai/dsh-agent-preset-registry README 的 "Composing a child agent"）。
  const setup = (agentCtx: Context): void => {
    const selected: ModelSelectionRef = { current: selection, assembled: undefined }
    installModelSelection(agentCtx, selected)
  }
  const sessionId = brandString<SessionId>(config.sessionId ?? `session-${randomUUID()}`)
  const fs = ctx.get('fs')
  const cwd = fs === undefined ? process.cwd() : fs.processPath(await fs.resolve('.'))
  const agent = config.sessionId === undefined
    ? (await agents.create({
      sessionId,
      meta: { cwd },
      agentOptions,
      setup,
    })).agent
    : await resolveAgent(ctx, agents, sessionId, agentOptions, setup, cwd)
  await agent.whenIdle()
  if (config.sessionId !== undefined) {
    // 恢复时的检查读取的是快照；在该时刻与本次运行所持区间之间，overlay 仍可能
    // 追加一次 preset 选择，因此在提交任务之前重新读取 runner 所持有的日志。
    assertAdoptable(agent.session.header, liveEvents(agent.session), sessionId, cwd)
  }
  const firstSeq = agent.session.seq
  const projection = config.json === true ? projectJsonRun(ctx, agent, io.stdout, { cwd }) : undefined
  const stopReasoning = projection === undefined ? streamReasoning(ctx, agent, io.stderr) : undefined
  let failure: { error: unknown; atOffset: SessionLogOffset } | undefined
  const stopErrors = ctx.on('agent/error', ({ agent: subject, error }) => {
    if (subject === agent) failure = { error, atOffset: agent.session.seq }
  })
  const stopTerminals = ctx.on('session/event', (session, event) => {
    if (session === agent.session && event.type === 'turn/end'
      && failure !== undefined && event.seq >= failure.atOffset) failure = undefined
  })
  try {
    try {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: task }],
        source: { kind: 'user' },
      }))
      const subagents = ctx.get('subagents')
      while (true) {
        await agent.whenIdle()
        const idleSeq = agent.session.seq
        // 子任务的完成可能先唤醒父 Agent，而子等待尚未观察到它。
        if (!await subagents?.waitForChildren(agent)
          && agent.status === 'idle' && agent.session.seq === idleSeq) break
      }
    } finally {
      stopReasoning?.()
    }
    await sessions.flush(agent.session)
    if (failure !== undefined) throw failure.error
    const outcome = summarize(agent.session, firstSeq)
    if (projection === undefined) io.stdout.write(outcome.text + '\n')
    else projection.finish(outcome.text)
    if (outcome.reason?.kind === 'error') {
      io.stderr.write(`dsh: ${outcome.reason.error.code}: ${outcome.reason.error.message}\n`)
    }
    io.exit(outcome.reason?.kind === 'completed' ? 0 : 1)
  } finally {
    stopErrors()
    stopTerminals()
    projection?.dispose()
  }
}

/**
 * 挂载一次性直接驱动器。
 * @param ctx - 承载核心服务与启动器提供的退出请求的插件上下文。
 * @param config - 已校验的任务与运行选项。
 */
export function apply(ctx: Context, config: Config): void {
  // 通过全局服务存储读取，而不是属性代理：appExit 是一个可选的宿主值，从不是被
  // 注入的依赖。
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('headless-runner: the launcher must provide ctx.appExit before the tree mounts')
  }
  const io: HeadlessIo = { stdout: internals.stdout, stderr: internals.stderr, exit }
  void run(ctx, config, io).catch((error: unknown) => { fail(io, error, config.json === true) })
}
