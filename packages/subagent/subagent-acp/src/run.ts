/**
 * 全新进程 ACP 子代理客户端。驱动一个子 session，并拥有取消与静默处置。
 *
 * @module @deepseek-ai/dsh-subagent-acp/run
 */

import { randomUUID } from 'node:crypto'
import { Readable as NodeReadable, Writable as NodeWritable } from 'node:stream'
import {
  client as createAcpClientApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ContentBlock as AcpContentBlock,
  type StopReason,
  type ToolKind,
} from '@agentclientprotocol/sdk'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { AssistantOutputFold, settleRunResult, subprocessRunHandle } from '@deepseek-ai/dsh-subagent'
import type { SubagentResult, SubagentRun, SubagentStartRequest, SubagentStopReason } from '@deepseek-ai/dsh-subagent'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

/** 对子权限请求的固定响应：默认拒绝，或选择第一个 allow 选项。 */
export type PermissionPolicy = 'allow' | 'reject'

/** 一个 ACP 子进程的已解析 spawn 规格（无默认值 —— 见 Config）。 */
export interface AcpRunSpec {
  /** 要 spawn 的可执行文件（子 ACP agent）。 */
  command: string
  /** 传给 {@link command} 的实参。 */
  args: string[]
  /**
   * 子进程及其 ACP session 的 `cwd` 的绝对工作目录，
   * 在提供方启动之前选定。
   */
  cwd: string
  /** 如何自动应答子代理的权限提示。 */
  permission: PermissionPolicy
  /**
   * 要为子代理添加（ADD）的额外环境变量（例如子 harness 的
   * `DEEPSEEK_API_KEY`）。它们合并到 subprocess 接缝已清洗的父 env 之上。
   * 此处的值即使其名称匹配凭据清洗模式也会被转发（这是对子代理自身凭据的
   * 显式选择加入）。显式的 `DSH_*` 条目是供子 harness 使用的、由部署拥有的
   * 事实（例如 `DSH_PERMISSION_MODE`）；它们只是在丢弃了陈旧同名的环境
   * 变量的清洗之后合并。
   */
  env: Record<string, string>
  /**
   * {@link SubagentRun.dispose} 中子代理由 EOF 驱动的静默宽限期（ms）——
   * 在父方升级为信号之前，它刷写持久化并拆解自身嵌套子进程的时间窗。
   * 插件从其 `disposeEofGraceMs` 配置填充此项。
   */
  disposeEofGraceMs: number
  /**
   * 进程观测与终止升级的宽限（ms）。失败分类最多等待这么久以获取结构化
   * 退出事实；POSIX 处置在 `SIGTERM` 之后也等待这么久再 `SIGKILL`，而
   * Windows 则直接强制终止。插件从 `disposeGraceMs` 填充此项。
   */
  disposeGraceMs: number
  /**
   * 来自 subprocess 接缝的 spawn 函数（`ctx.subprocess.spawn`），使子代理
   * 搭上共享的清洗、受管范围拆解与 service 拥有的生命周期，而非一条
   * 包内局部的 child_process 路径。
   */
  spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /**
   * 启动、已发布运行或拆解失败的宿主机汇。模型可见文本使用固定的安全事实，
   * 而本回调在存在原始 Error 时保留它。汇自身的抛出被隔离。
   */
  onError?: (error: Error, stopReason: SubagentStopReason) => void
}

/** 子刷写与嵌套进程拆解的 EOF 宽限；比下面的信号宽限更宽。 */
export const DEFAULT_DISPOSE_EOF_GRACE_MS = 6_000

/** 处置时 POSIX 上 SIGTERM 与 SIGKILL 之间的默认宽限（`disposeGraceMs` 配置）。 */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

type AcpFailureStage = 'initialize' | 'new-session' | 'prompt' | 'process' | 'teardown'

type AcpFailureCategory =
  | 'protocol'
  | 'configuration'
  | 'transport'
  | 'process-start'
  | 'process-exit'
  | 'remote-limit'
  | 'unknown'

interface AcpFailureFacts {
  readonly stage: AcpFailureStage
  readonly category: AcpFailureCategory
  readonly stopReason?: StopReason | 'unknown'
  readonly outcome?: SubprocessOutcome | undefined
}

interface AcpPermissionDecision {
  readonly policy: PermissionPolicy
  readonly request: ToolKind | 'unknown'
  readonly decision: 'allowed' | 'denied'
}

const ACP_TOOL_KINDS: ReadonlySet<string> = new Set([
  'read', 'edit', 'delete', 'move', 'search',
  'execute', 'think', 'fetch', 'switch_mode', 'other',
])

/** 仅由提供方拥有的结构化事实推导出的固定安全失败文本。 */
function failureDiagnostic(facts: AcpFailureFacts): string {
  const fields = [
    'provider: ACP',
    `stage: ${facts.stage}`,
    `category: ${facts.category}`,
  ]
  if (facts.stopReason !== undefined) fields.push(`stop reason: ${facts.stopReason}`)
  if (facts.outcome?.exitCode !== null && facts.outcome?.exitCode !== undefined) {
    fields.push(`exit code: ${facts.outcome.exitCode}`)
  }
  /* v8 ignore next -- Windows 不在 SubprocessOutcome 中报告 POSIX 子进程信号。 */
  if (facts.outcome?.signal !== null && facts.outcome?.signal !== undefined) {
    fields.push(`signal: ${facts.outcome.signal}`)
  }
  return `Subagent failure (${fields.join('; ')})`
}

/** 固定的权限事实；ACP 工具标题与选项文本从不进入其中。 */
function permissionDiagnostic(permission: AcpPermissionDecision): string {
  return `ACP unattended decision (policy: ${permission.policy}; request: ${permission.request}; decision: ${permission.decision})`
}

/** 把操作失败放在首位，其后跟随最新的权限决策。 */
function diagnosticText(facts: AcpFailureFacts, permission?: AcpPermissionDecision): string {
  const failure = failureDiagnostic(facts)
  return permission === undefined ? failure : `${failure}\n${permissionDiagnostic(permission)}`
}

class AcpRunFailure extends Error {
  constructor(facts: AcpFailureFacts, cause: unknown) {
    super(
      `subagent-acp: ${failureDiagnostic(facts)}`,
      { cause },
    )
    this.name = 'AcpRunFailure'
  }
}

/**
 * 把一个 spawn 前的工作区/配置失败隐藏在固定的安全事实之后。
 * @param cause - 保留在 Error cause 链上的原始宿主机失败。
 * @returns 一个其消息只包含固定 ACP 失败行的 Error。
 */
export function acpConfigurationFailure(cause: unknown): Error {
  return new AcpRunFailure({ stage: 'initialize', category: 'configuration' }, cause)
}

/** 只保留封闭的 ACP tool-kind 词汇；未来的值使用固定兜底。 */
function permissionRequestKind(kind: ToolKind | null | undefined): ToolKind | 'unknown' {
  const candidate = kind ?? 'unknown'
  return ACP_TOOL_KINDS.has(candidate)
    ? candidate
    : 'unknown'
}

/** 有界的受管范围退出等待：观测句柄的范围，直到其为空或经过 `ms`。 */
async function rangeExitsWithin(child: SubprocessHandle, ms: number): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, ms)
  try {
    return await child.waitForExit(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 面向进程外 agent 的协作式拆解阶梯，基于接缝的公开动词；只在整体范围
 * 静默时才解析：stdin EOF（子代理刷写持久化并回收其自身后代的时间窗），
 * 然后是 terminate() 升级（SIGTERM → 规格宽限 → SIGKILL）及其整体范围
 * 退出证明。
 * @param child - 已 spawn 的 ACP 子代理句柄。
 * @param eofGraceMs - stdin EOF 之后的第一层时间窗。
 */
export async function disposeAcpChild(child: SubprocessHandle, eofGraceMs: number): Promise<void> {
  const failures: Error[] = []
  child.stdin?.end()
  let exited = false
  try {
    exited = await rangeExitsWithin(child, eofGraceMs)
  } catch (error: unknown) {
    failures.push(toError(error))
  }
  if (exited) return
  // terminate() 拥有有界的 SIGTERM→SIGKILL 定时器。它的无界等待是
  // 进程属主的退出证明，而非第二个可能溢出的派生宽限。
  child.terminate()
  try {
    await child.waitForExit()
  } catch (error: unknown) {
    failures.push(toError(error))
  }
  if (failures.length === 1) throw failures[0] as Error
  if (failures.length > 1) throw new AggregateError(failures, 'ACP subprocess teardown failed')
}

/**
 * 把一个 ACP {@link StopReason} 映射为 harness 的 {@link SubagentStopReason}。
 * @param reason - 来自子 `session/prompt` 响应的终止原因。
 * @returns 对应的 harness 原因；`max_turn_requests` 与任何未知的未来变体
 * 都映射为 `error`，因此不干净的停止从不被报告为 `completed`。
 */
export function acpStopReason(reason: StopReason): SubagentStopReason {
  switch (reason) {
    case 'end_turn':
      return 'completed'
    case 'max_tokens':
      return 'max-tokens'
    case 'refusal':
      return 'refusal'
    case 'cancelled':
      return 'aborted'
    // `max_turn_requests`（子代理撞上了轮次请求预算）没有直接的 harness
    // 对应物，且意味着任务没有干净地完成 —— 把它呈现为一般性失败，
    // 使消费者把它映射为 isError 结果，而非把部分答案报告为成功。
    case 'max_turn_requests':
      return 'error'
    // ACP StopReason 是封闭的wire 联合，但未来的 SDK 可能添加变体；
    // 把未知的终止原因视为失败（绝不静默地当作 'completed'）。
    default:
      return 'error'
  }
}

/**
 * 收集一个 ACP 内容块的文本（非文本块不产生贡献）。
 * @param content - 来自流式 `agent_message_chunk` 的内容块。
 * @returns 该块的文本，非文本块则为 `''`。
 */
export function acpContentText(content: AcpContentBlock): string {
  return content.type === 'text' ? content.text : ''
}

/**
 * 把 harness 的 prompt 块翻译为 ACP prompt 块（仅文本）。
 * @param prompt - harness 的 prompt；非文本块被丢弃。
 * @returns 按顺序排列的 ACP 文本块。
 */
export function toAcpPrompt(prompt: ContentBlock[]): AcpContentBlock[] {
  const blocks: AcpContentBlock[] = []
  for (const block of prompt) {
    if (block.type === 'text') blocks.push({ type: 'text', text: block.text })
  }
  return blocks
}

/** 把未知抛出值规范化为 Error（catch 绑定是 `unknown`）。 */
function toError(value: unknown): Error {
  // 该 catch 只会看到来自 ACP SDK RPC 与 spawn `error` 事件的拒绝，
  // 它们总是 `Error`；`String(value)` 分支是针对类型化 API 无法产生的
  // 非 Error 抛出的防御性兜底。
  /* v8 ignore next */
  return value instanceof Error ? value : new Error(String(value))
}

/** 报告一个原始宿主机失败，而不让观测汇替换它。 */
function reportFailure(spec: AcpRunSpec, error: unknown): void {
  try {
    spec.onError?.(toError(error), 'error')
  } catch {
    // 宿主机诊断日志不能替换子代理的失败。
  }
}

/** 根据活跃的协议操作与观测到的进程事实对一个未发布的失败分类。 */
function startupFailure(
  error: unknown,
  stage: Extract<AcpFailureStage, 'initialize' | 'new-session'>,
  outcome: SubprocessOutcome | undefined,
): AcpRunFailure {
  return new AcpRunFailure(
    /* v8 ignore next -- Windows 匿名管道无法在启动期间暴露一个活跃子代理的协议关闭。 */
    outcome === undefined
      ? { stage, category: 'transport' }
      : { stage, category: 'process-exit', outcome },
    error,
  )
}

/** 把一个远程终止原因映射到它所需的、可选的安全失败行。 */
function terminalFailure(
  reason: StopReason,
  permission: AcpPermissionDecision | undefined,
): string | undefined {
  switch (reason) {
    case 'end_turn':
      return undefined
    case 'max_turn_requests':
      return diagnosticText({
        stage: 'prompt',
        category: 'remote-limit',
        stopReason: 'max_turn_requests',
      }, permission)
    case 'max_tokens':
    case 'refusal':
    case 'cancelled':
      return permission === undefined
        ? undefined
        : permissionDiagnostic(permission)
    default:
      return diagnosticText({ stage: 'prompt', category: 'unknown', stopReason: 'unknown' }, permission)
  }
}

/**
 * 在初始化与 session 创建之后启动并发布一个 ACP 子代理。
 * 子代理的失败通过运行结果解析。启动在以提供方自有的清理之后、以固定的
 * 安全事实拒绝；成功的清理证明受管范围已静默。清理失败会为一次普通失败
 * 保留启动加拆解的事实，或在取消之后只保留拆解事实，而不声称已静默。
 * 处置会取消、终止并结算子代理的受管范围。
 * @param request - 启动请求；其 signal 是取消通道。
 * @param spec - 已解析的 spawn 规格：command/args/cwd、env、权限策略、
 * 处置宽限与可选的错误汇。
 * @returns 子进程的就绪运行句柄。
 */
export async function startAcpRun(request: SubagentStartRequest, spec: AcpRunSpec): Promise<SubagentRun> {
  if (request.signal.aborted) throw new Error('subagent request was aborted before the ACP child started')
  // ACP session id 只在子服务器内唯一。生命周期 id 在父命名空间中铸造，
  // 因此全新进程之间不会彼此冲突，也不会与恰好使用同一 session id 的
  // 本地 agent 冲突。
  const id = brandString<SessionId>(randomUUID())

  // 把诊断保留在父 stderr（'inherit'）上；只有 ACP 输出才贡献给结果。
  // 接缝的清洗丢弃环境凭据与 DSH_* 名称，而 spec.env（子代理自己的 key、
  // 其部署事实）在其之后合并。
  let child: SubprocessHandle
  try {
    child = spec.spawn({
      argv: [spec.command, ...spec.args],
      cwd: spec.cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
      graceMs: spec.disposeGraceMs,
      env: spec.env,
    })
  } catch (error: unknown) {
    reportFailure(spec, error)
    throw new AcpRunFailure({ stage: 'process', category: 'process-start' }, error)
  }
  /* v8 ignore start -- 'pipe' disposition 按接缝契约暴露两个流；防御性。 */
  if (child.stdin === undefined || child.stdout === undefined) {
    throw new Error('subagent-acp: subprocess implementation dropped a piped protocol stream')
  }
  /* v8 ignore stop */
  let processOutcome: SubprocessOutcome | undefined
  let processFailure: Error | undefined
  const processDone = child.done.then(
    (outcome) => {
      processOutcome = outcome
      return outcome
    },
    (error: unknown) => {
      processFailure = toError(error)
      throw processFailure
    },
  )

  // 一个被拒绝的直接结果会浮现到启动竞速中；一个干净的退出绝不能赢得
  // 它，因此成功分支永久停放。（观测其流关闭的 ACP 连接会约束一个
  // 未说协议就退出的子代理。）
  const processRejected: Promise<never> = processDone.then(
    /* v8 ignore next -- 成功分支永不结算的 executor 有意为空。 */
    () => new Promise<never>(() => {}),
    (err: unknown) => Promise.reject(toError(err)),
  )
  processRejected.catch(() => { /* 由启动竞速观测；永不未处理 */ })

  const observeProcessOutcome = async (signal?: AbortSignal): Promise<SubprocessOutcome | undefined> => {
    if (processOutcome !== undefined) return processOutcome
    const timeout = AbortSignal.timeout(Math.ceil(spec.disposeGraceMs))
    const bound = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    const aborted = Promise.withResolvers<undefined>()
    /* v8 ignore next -- Windows 无法暴露等待此 abort 所需的活跃子代理协议关闭。 */
    const onObservationAbort = (): void => { aborted.resolve(undefined) }
    bound.addEventListener('abort', onObservationAbort, { once: true })
    /* v8 ignore next -- 关闭监听器注册与前一个派生信号检查之间的事件循环竞速。 */
    if (bound.aborted) onObservationAbort()
    try {
      return await Promise.race([processDone, aborted.promise])
    } catch {
      // 句柄发布之后的提供方拒绝不留下直接结果；
      // 活跃的协议失败保持权威。
      return processOutcome
    } finally {
      bound.removeEventListener('abort', onObservationAbort)
    }
  }

  // 启动回滚与已发布句柄共享一次进程拆解。
  let processDisposal: Promise<void> | undefined
  const disposeProcess = (): Promise<void> => (processDisposal ??= disposeAcpChild(child, spec.disposeEofGraceMs))

  // ACP 不暴露完整的助手消息，因此共享折叠选取其累积的助手文本。
  const fold = new AssistantOutputFold()
  // 共享的可变状态让取消在异步闭包之间可见。
  const flags = { cancelled: false }
  let latestPermission: AcpPermissionDecision | undefined

  const clientApp = createAcpClientApp({ name: 'deepseek-harness-subagent-acp' })
    .onNotification(methods.client.session.update, ({ params }) => {
      const update = params.update
      if (update.sessionUpdate === 'agent_message_chunk') {
        fold.pushText(acpContentText(update.content))
      }
      // 其他更新（思考、工具调用、计划）被消费但不呈现 ——
      // 子代理只返回其最终答案。
      return Promise.resolve()
    })
    .onRequest(methods.client.session.requestPermission, ({ params }) => {
      // 按已配置策略自动应答。`allow` 选择第一个 kind 为 `allow_once`
      // 或 `allow_always` 的选项；若子代理未提供任何选项（或我们拒绝），
      // 则应答 `cancelled`，使子代理不再继续。
      if (spec.permission === 'allow') {
        const allow = params.options.find(o => o.kind === 'allow_once' || o.kind === 'allow_always')
        if (allow !== undefined) {
          latestPermission = {
            policy: 'allow',
            request: permissionRequestKind(params.toolCall.kind),
            decision: 'allowed',
          }
          return Promise.resolve({ outcome: { outcome: 'selected', optionId: allow.optionId } })
        }
      }
      latestPermission = {
        policy: spec.permission,
        request: permissionRequestKind(params.toolCall.kind),
        decision: 'denied',
      }
      return Promise.resolve({ outcome: { outcome: 'cancelled' } })
    })

  const connection = clientApp.connect(ndJsonStream(
    NodeWritable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    NodeReadable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  ))
  const agent = connection.agent

  let sessionId: string | undefined
  let startupStage: Extract<AcpFailureStage, 'initialize' | 'new-session'> = 'initialize'
  // 取消无需等待协作的子代理即可结算结果。
  let signalCancelSettled!: () => void
  const cancelSettled = new Promise<void>((resolve) => { signalCancelSettled = resolve })
  const requestCancel = (): void => {
    if (flags.cancelled) return
    flags.cancelled = true
    signalCancelSettled()
    // 尽力而为的 ACP 取消；进程拆解保持权威。
    /* v8 ignore next */
    if (sessionId !== undefined) {
      void agent.notify(methods.agent.session.cancel, { sessionId }).catch(() => { /* 子代理已消失 / 没有 session */ })
    }
  }
  const onAbort = (): void => { requestCancel() }
  request.signal.addEventListener('abort', onAbort, { once: true })

  // 在每次返回时读取，使部分答案能挺过之后的取消/错误。
  const collectOutput = (): readonly ContentBlock[] => fold.collect() ?? []

  // 在发布句柄之前建立远程 session。任何失败都拥有仍是私有的进程，
  // 因此在拒绝之前回收它。
  try {
    await Promise.race([
      (async (): Promise<void> => {
        await agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          // 不声明任何可选的客户端能力（无 fs、无 terminal）：
          // 子代理在自己的进程中自我服务。
          clientCapabilities: {},
        })
        startupStage = 'new-session'
        const session = await agent.request(methods.agent.session.new, { cwd: spec.cwd, mcpServers: [] })
        const returnedSessionId: unknown = Reflect.get(session, 'sessionId')
        if (typeof returnedSessionId !== 'string') {
          throw new AcpRunFailure(
            { stage: 'new-session', category: 'protocol' },
            new Error('ACP child published without a session id'),
          )
        }
        sessionId = returnedSessionId
        /* v8 ignore next -- cancelSettled 在这个响应后守卫结算它之前就赢得了启动竞速。 */
        if (flags.cancelled) throw new Error('subagent cancelled before the ACP session started')
      })(),
      processRejected,
      cancelSettled.then((): never => { throw new Error('subagent cancelled before the ACP session started') }),
    ])
  } catch (error: unknown) {
    request.signal.removeEventListener('abort', onAbort)
    const cancelledBeforeCleanup = flags.cancelled
    // 子代理关闭其协议流可能先于整体范围退出观测。本地取消不需要被丢弃的
    // 启动分类；其他失败使用已配置的进程宽限。
    const observedOutcome = !cancelledBeforeCleanup && !(error instanceof AcpRunFailure)
      ? await observeProcessOutcome()
      : undefined
    const startup = cancelledBeforeCleanup
      ? { kind: 'cancelled' } as const
      : {
        kind: 'failed',
        failure: error instanceof AcpRunFailure
          ? error
          : startupFailure(error, startupStage, observedOutcome),
      } as const
    if (startup.kind === 'cancelled') {
      // 本地取消拥有启动结果；只有清理失败才在拆解本身被拒绝时于下方报告。
    } else {
      reportFailure(spec, error instanceof AcpRunFailure
        ? error.cause
        : processFailure ?? error)
    }
    try {
      await disposeProcess()
    } catch (cleanupError: unknown) {
      reportFailure(spec, cleanupError)
      const cleanupFailure = new AcpRunFailure({
        stage: 'teardown',
        category: processOutcome === undefined ? 'unknown' : 'process-exit',
        ...(processOutcome === undefined ? {} : { outcome: processOutcome }),
      }, cleanupError)
      if (startup.kind === 'cancelled') {
        throw new AggregateError([cleanupFailure], cleanupFailure.message)
      }
      throw new AggregateError(
        [startup.failure, cleanupFailure],
        `${startup.failure.message}; ${cleanupFailure.message}`,
      )
    }
    if (startup.kind === 'cancelled') {
      throw new Error('subagent request was aborted before the ACP child started')
    }
    throw startup.failure
  }
  // 启动事务在兑现之前校验返回的 id。
  // 本断言把该跨闭包不变式带进 TypeScript。
  /* v8 ignore next */
  if (sessionId === undefined) throw new Error('unreachable: ACP startup fulfilled without a session id')
  const remoteSessionId = sessionId

  let diagnostic: string | undefined
  const result: Promise<SubagentResult> = settleRunResult({
    attempt: async (): Promise<SubagentResult> => {
      try {
        const promptResult = await Promise.race([
          agent.request(methods.agent.session.prompt, {
            sessionId: remoteSessionId,
            prompt: toAcpPrompt(request.prompt),
          }),
          cancelSettled.then((): never => { throw new Error('subagent cancelled while the ACP prompt was running') }),
        ])
        const stopReason = acpStopReason(promptResult.stopReason)
        diagnostic = terminalFailure(promptResult.stopReason, latestPermission)
        return {
          output: collectOutput(),
          ...(diagnostic === undefined ? {} : { diagnostic }),
          stopReason,
        }
      } catch (error: unknown) {
        if (!flags.cancelled) {
          const outcome = await observeProcessOutcome(request.signal)
          const facts = outcome === undefined
            ? { stage: 'prompt', category: 'transport' } as const
            : { stage: 'process', category: 'process-exit', outcome } as const
          diagnostic = diagnosticText(facts, latestPermission)
        }
        throw processFailure ?? error
      }
    },
    collectOutput,
    collectDiagnostic: () => diagnostic,
    cancelled: () => flags.cancelled,
    onError: spec.onError,
    signal: request.signal,
    onAbort,
  })

  return subprocessRunHandle({
    id,
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown: async () => {
      try {
        // ACP 通常由 stdin EOF 静默，包括最终的刷写，因此本后端在进程
        // 终止之前使用更宽的 EOF 宽限。
        await disposeProcess()
      } catch (error: unknown) {
        reportFailure(spec, error)
        throw new AcpRunFailure({
          stage: 'teardown',
          category: processOutcome === undefined ? 'unknown' : 'process-exit',
          ...(processOutcome === undefined ? {} : { outcome: processOutcome }),
        }, error)
      }
    },
  })
}
