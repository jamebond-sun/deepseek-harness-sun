/**
 * 全新进程 SDK 子代理客户端。通过 `@deepseek-ai/dsh-sdk-client` 以 stdio
 * JSON-RPC 驱动一个子 DeepSeek Harness 运行时，并拥有取消与静默处置。它在
 * 子握手之后发布，把子失败映射为停止原因，并拆解到静默。SDK 客户端自己
 * spawn 子进程，而不使用 `ctx.subprocess` —— 这是 subprocess 接缝为
 * SDK 托管传输所记录的例外 —— 因此本驱动应用该接缝的共享 env 清洗。
 *
 * @module @deepseek-ai/dsh-subagent-dsh-sdk/run
 */

import { randomUUID } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  DeepSeekHarness,
  type DeepSeekHarnessOptions,
  JsonRpcResponseError,
  SdkProtocolError,
  TransportClosedError,
  validatedSessionEvent,
} from '@deepseek-ai/dsh-sdk-client'
import type { ContentBlock, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SessionId, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { SubagentResult, SubagentRun, SubagentStartRequest, SubagentStopReason } from '@deepseek-ai/dsh-subagent'
import { AssistantOutputFold, settleRunResult, subprocessRunHandle } from '@deepseek-ai/dsh-subagent'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'

/** 一个 SDK 运行时子进程的已解析 spawn 规格（无默认值 —— 见 Config）。 */
export interface SdkRunSpec {
  /** 显式 dsh CLI 模块；省略则解析 SDK 客户端的同版本依赖。 */
  dshBin?: string
  /** 具名子 profile。 */
  profile: string
  /** 按启动顺序排列的 profile patch 文件。 */
  patches: string[]
  /** 嵌套运行时的绝对隔离 Harness home。 */
  dshHome: string
  /** 由委托方运行时选定的绝对初始工作目录。 */
  cwd: string
  /** 独立于子代理生效目录所记录的父 origin 目录。 */
  originCwd?: string | undefined
  /** 子运行时初始化所用的提供方路由。 */
  provider: string
  /** 子运行时初始化所用的模型。 */
  model: string
  /** 在子运行时 initialize 握手中发送的、可选的适配器自有 reasoning effort。 */
  reasoningEffort?: ReasoningEffortId
  /** 在子运行时 initialize 握手中发送的、可选的按请求输出 token 上限。 */
  maxTokens?: number
  /**
   * 要为子代理添加（ADD）的额外环境变量（例如子运行时的
   * `DEEPSEEK_API_KEY`）。它们合并到接缝的 `scrubbedParentEnv()` 基之后，
   * 因此显式的凭据或当前 `DSH_*` 事实会存活，而环境中的同名者永不泄漏。
   */
  env: Record<string, string>
  /** 处置期间对协议 `shutdown` 交换的界限（ms）。 */
  shutdownTimeoutMs: number
  /** 处置时子代理由 EOF 驱动的静默宽限期（ms）。 */
  disposeEofGraceMs: number
  /** 终止确认窗口（ms），包括每个平台上的强制退出。 */
  disposeGraceMs: number
  /**
   * 启动、已发布运行或关停失败的宿主机汇。模型可见文本使用固定的安全事实，
   * 而本回调保留原始 Error。汇自身的抛出被隔离。
   */
  onError?: (error: Error, stopReason: SubagentStopReason) => void
}

/** 子刷写与嵌套进程拆解的 EOF 宽限；比下面的信号宽限更宽。 */
export const DEFAULT_DISPOSE_EOF_GRACE_MS = 6_000

/** 处置时 POSIX 上 SIGTERM 与 SIGKILL 之间的默认宽限（`disposeGraceMs` 配置）。 */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

/** 处置期间对协议 `shutdown` 交换的默认界限。 */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 1_000

type SdkFailureStage = 'initialize' | 'session-run' | 'shutdown'

type SdkFailureCategory =
  | 'configuration'
  | 'protocol'
  | 'transport'
  | 'child-error'
  | 'child-disposed'
  | 'child-unknown'
  | 'missing-terminal'
  | 'unknown'

interface SdkFailureFacts {
  readonly stage: SdkFailureStage
  readonly category: SdkFailureCategory
}

/** 仅由提供方拥有的结构化事实推导出的固定安全失败文本。 */
function failureDiagnostic(facts: SdkFailureFacts): string {
  const fields = [
    'provider: DSH SDK',
    `stage: ${facts.stage}`,
    `category: ${facts.category}`,
  ]
  return `Subagent failure (${fields.join('; ')})`
}

class SdkRunFailure extends Error {
  constructor(readonly facts: SdkFailureFacts, cause: unknown) {
    super(`subagent-dsh-sdk: ${failureDiagnostic(facts)}`, { cause })
    this.name = 'SdkRunFailure'
  }
}

/** 运行时构造器接缝，只被包内局部的 fake-runtime 测试替换。 */
export const internals: { createHarness(options: DeepSeekHarnessOptions): DeepSeekHarness } = {
  createHarness: options => new DeepSeekHarness(options),
}

/**
 * 把一个 spawn 前的工作区/配置失败隐藏在固定的安全事实之后。
 * @param cause - 保留在 Error cause 链上的原始宿主机失败。
 * @returns 一个其消息只包含固定 DSH SDK 失败行的 Error。
 */
export function sdkConfigurationFailure(cause: unknown): Error {
  return new SdkRunFailure({ stage: 'initialize', category: 'configuration' }, cause)
}

/** 在不读取其消息或 stderr 尾部的前提下对一个 SDK 拒绝分类。 */
function sdkFailure(error: unknown, stage: SdkFailureStage): SdkRunFailure {
  const facts: SdkFailureFacts = error instanceof TransportClosedError
    ? { stage, category: 'transport' }
    : error instanceof SdkProtocolError || error instanceof JsonRpcResponseError
      ? { stage, category: 'protocol' }
      : { stage, category: 'unknown' }
  return new SdkRunFailure(facts, error)
}

/**
 * 把一个子终止原因映射到其完整的共享结果结局。
 * @param reason - 被拥有的子运行最终的持久化轮次原因，或当它在没有运行
 * 轮次的情况下结算时为 `undefined`。
 * @returns 共享的停止原因与任何额外的安全诊断。
 */
export function sdkChildOutcome(
  reason: TurnEndReason | undefined,
): Pick<SubagentResult, 'stopReason' | 'diagnostic'> {
  switch (reason?.kind) {
    case 'completed':
      return { stopReason: 'completed' }
    case 'max-tokens':
      return { stopReason: 'max-tokens' }
    case 'aborted':
      return reason.reason.kind === 'disposed'
        ? {
          stopReason: 'aborted',
          diagnostic: failureDiagnostic({ stage: 'session-run', category: 'child-disposed' }),
        }
        : { stopReason: 'aborted' }
    case 'blocked':
      return { stopReason: 'refusal' }
    case 'error':
      return {
        stopReason: 'error',
        diagnostic: failureDiagnostic({ stage: 'session-run', category: 'child-error' }),
      }
    case 'interrupted':
      return { stopReason: 'error' }
    case undefined:
      return {
        stopReason: 'error',
        diagnostic: failureDiagnostic({ stage: 'session-run', category: 'missing-terminal' }),
      }
    default:
      return {
        stopReason: 'error',
        diagnostic: failureDiagnostic({ stage: 'session-run', category: 'child-unknown' }),
      }
  }
}

/** 把未知抛出值规范化为 Error（catch 绑定是 `unknown`）。 */
function toError(value: unknown): Error {
  // 该 catch 只会看到来自 SDK 客户端的拒绝，它们总是 `Error`；
  // `String(value)` 分支是针对类型化表面无法产生的非 Error 抛出的
  // 防御性兜底。
  /* v8 ignore next */
  return value instanceof Error ? value : new Error(String(value))
}

/** 报告一个原始宿主机失败，而不让观测汇替换它。 */
function reportFailure(spec: SdkRunSpec, error: unknown): void {
  try {
    spec.onError?.(toError(error), 'error')
  } catch {
    // 宿主机诊断日志不能替换子代理的失败。
  }
}

/** 把一个 SDK 自有的启动失败聚合映射为安全的 initialize/shutdown 行。 */
function sdkStartupFailure(spec: SdkRunSpec, error: unknown): Error {
  if (!(error instanceof AggregateError) || error.errors.length < 2) {
    reportFailure(spec, error)
    return sdkFailure(error, 'initialize')
  }
  const initializeError: unknown = error.errors[0]
  const cleanupError: unknown = error.errors[1]
  reportFailure(spec, initializeError)
  reportFailure(spec, cleanupError)
  const initializeFailure = sdkFailure(initializeError, 'initialize')
  const cleanupFailure = new SdkRunFailure({ stage: 'shutdown', category: 'unknown' }, cleanupError)
  return new AggregateError(
    [initializeFailure, cleanupFailure],
    `${initializeFailure.message}; ${cleanupFailure.message}`,
  )
}

/**
 * 在其 `initialize` 握手之后启动并发布一个 SDK 运行时子代理。
 * 子代理的失败通过运行结果解析。启动在 SDK 自有的清理之后、以固定的
 * 安全事实拒绝；成功的清理证明进程已被回收。清理失败会为一次普通失败
 * 保留 initialize 加 shutdown，或在取消之后只保留 shutdown，而不声称已静默。
 * 处置会关停运行时并回收它。
 * @param request - 启动请求；其 signal 是取消通道。
 * @param spec - 已解析的 spawn 规格：profile/patches/home/cwd、子代理的
 * provider/model/reasoning 路由、输出上限、env、超时与可选的错误汇。
 * @returns 子进程的就绪运行句柄。
 */
export async function startSdkRun(request: SubagentStartRequest, spec: SdkRunSpec): Promise<SubagentRun> {
  if (request.signal.aborted) throw new Error('subagent request was aborted before the SDK child started')
  // 运行 id 位于父命名空间；子运行时的 session id（在下方铸造，对wire 私有）
  // 只存在于子进程内部。
  const id = brandString<SessionId>(randomUUID())

  const harness = internals.createHarness({
    ...spec.dshBin === undefined ? {} : { dshBin: spec.dshBin },
    profile: spec.profile,
    patches: spec.patches,
    dshHome: spec.dshHome,
    processCwd: spec.cwd,
    env: { ...scrubbedParentEnv(), ...spec.env },
    shutdownTimeoutMs: spec.shutdownTimeoutMs,
    disposeEofGraceMs: spec.disposeEofGraceMs,
    disposeGraceMs: spec.disposeGraceMs,
    cwd: spec.originCwd ?? spec.cwd,
    provider: spec.provider,
    model: spec.model,
    ...spec.reasoningEffort === undefined ? {} : { reasoningEffort: spec.reasoningEffort },
    ...spec.maxTokens === undefined ? {} : { maxTokens: spec.maxTokens },
  })

  // 取消无需等待协作的子代理即可结算结果。
  const flags = { cancelled: false }
  let signalCancelSettled!: () => void
  const cancelSettled = new Promise<void>((resolve) => { signalCancelSettled = resolve })
  const requestCancel = (): void => {
    if (flags.cancelled) return
    flags.cancelled = true
    signalCancelSettled()
  }
  const onAbort = (): void => { requestCancel() }
  request.signal.addEventListener('abort', onAbort, { once: true })
  const cancelledStartup = new Error('subagent cancelled before the SDK child initialized')

  // 在发布句柄之前建立子握手。任何失败都拥有仍是私有的进程，
  // 并在拒绝之前回收它。
  try {
    await Promise.race([
      harness.start(),
      cancelSettled.then((): never => { throw cancelledStartup }),
    ])
    // 防御性：abort() 是一个宏任务，且在握手兑现与本 continuation 之间的
    // 微任务排空中没有用户回调运行，因此当前的回调顺序无法调度该复查；
    // 它防范未来的重入。
    /* v8 ignore next */
    if (flags.cancelled) throw cancelledStartup
  } catch (error: unknown) {
    request.signal.removeEventListener('abort', onAbort)
    if (error !== cancelledStartup) {
      throw sdkStartupFailure(spec, error)
    }
    try {
      await harness.close()
    } catch (cleanupError: unknown) {
      reportFailure(spec, cleanupError)
      const cleanupFailure = new SdkRunFailure({ stage: 'shutdown', category: 'unknown' }, cleanupError)
      // 把失败的清理保留为一个失败的 Job；settleStart 只把被中止的
      // 非 AggregateError 拒绝视为一次被干净杀死的启动。
      throw new AggregateError([cleanupFailure], cleanupFailure.message)
    }
    throw new Error('subagent request was aborted before the SDK child started')
  }

  const childSessionId = `session-${randomUUID().replaceAll('-', '')}`
  // 子代理在接缝规范选取规则下的最终答案（`AssistantOutputFold`）；
  // 部分答案能挺过取消与错误路径。
  const fold = new AssistantOutputFold()
  const subscription = harness.client.subscribe(notification =>
    notification.method === 'session.event' && notification.params.sessionId === childSessionId)
  let lastEnd: TurnEndReason | undefined
  const drainNotifications = (): void => {
    let notification
    while ((notification = subscription.tryNext()) !== undefined) {
      const event = validatedSessionEvent(notification.params.event)
      fold.push(event)
      if (event.type === 'turn/end') lastEnd = event.data.reason
    }
  }
  const collectOutput = (): readonly ContentBlock[] => fold.collect() ?? []
  const teardown = async (): Promise<void> => {
    try {
      await harness.close()
    } catch (error: unknown) {
      reportFailure(spec, error)
      throw new SdkRunFailure({ stage: 'shutdown', category: 'unknown' }, error)
    }
  }

  // 让子任务与本地取消竞速；共享结算在接缝的永不拒绝契约下扁平化失败。
  let diagnostic: string | undefined
  let accepted = false
  const result: Promise<SubagentResult> = settleRunResult({
    attempt: async () => {
      try {
        try {
          await Promise.race([
            (async () => {
              await harness.session(childSessionId).setWorkingDirectory(spec.cwd)
              if (flags.cancelled) return
              await harness.client.prompt(childSessionId, request.prompt)
              accepted = true
              await harness.client.request('session/wait', { sessionId: childSessionId })
            })(),
            cancelSettled,
          ])
        } finally {
          // wait 响应在同一管道上跟随已提交的通知。
          // 取消与传输失败保留每一个已收到的事件。
          if (accepted) drainNotifications()
        }
        if (flags.cancelled) return { output: collectOutput(), stopReason: 'aborted' }
        const outcome = sdkChildOutcome(lastEnd)
        diagnostic = outcome.diagnostic
        return {
          output: collectOutput(),
          ...outcome,
        }
      } catch (error: unknown) {
        diagnostic = failureDiagnostic(sdkFailure(error, 'session-run').facts)
        throw error
      } finally {
        subscription.close()
      }
    },
    collectOutput,
    collectDiagnostic: () => diagnostic,
    cancelled: () => flags.cancelled,
    onError: spec.onError,
    signal: request.signal,
    onAbort,
  })

  // 没有wire 级别的 prompt 取消：dispose 在本地结算结果，
  // 然后有界的 shutdown 请求 + dispose 阶梯把子代理拆解掉。
  return subprocessRunHandle({
    id,
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown,
  })
}
