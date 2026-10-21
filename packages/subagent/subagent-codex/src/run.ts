/**
 * 一次性 Codex 子代理生命周期：通过 subprocess 接缝 spawn 真实的
 * app-server，只在初始化与临时线程创建之后发布，扁平化发布之后的失败，
 * 并处置到整体范围静默。
 *
 * @module @deepseek-ai/dsh-subagent-codex/run
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  settleRunResult,
  subprocessRunHandle,
  type SubagentResult,
  type SubagentRun,
  type SubagentStartRequest,
  type SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import {
  CodexAppServerWire,
  type CodexWireFailureFacts,
} from './wire.ts'

/** 子进程终止各层之间的默认 POSIX 宽限。 */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

interface CodexPackageManifest {
  readonly bin: {
    readonly codex: string
  }
}

const codexPackageJsonPath = createRequire(import.meta.url).resolve('@openai/codex/package.json')
const codexPackageManifest = JSON.parse(
  readFileSync(codexPackageJsonPath, 'utf8'),
) as CodexPackageManifest

/** 由包 manifest 选定的、包局部的绝对 JavaScript 包装器。 */
const CODEX_PACKAGE_BIN = resolve(
  dirname(codexPackageJsonPath),
  codexPackageManifest.bin.codex,
)

/** 可由 profile 选择的非交互 Codex 权限模式。 */
export type CodexPermissionMode =
  | 'never'
  | 'approve-for-me'
  | 'dangerously-bypass-approvals-and-sandbox'

/** 映射到官方 `thread/start` 字段的原生非交互 Codex 模式。 */
export const CODEX_PERMISSION_MODES = [
  'never',
  'approve-for-me',
  'dangerously-bypass-approvals-and-sandbox',
] as const satisfies readonly CodexPermissionMode[]

/** 无人值守 Codex 运行的安全默认值。 */
export const DEFAULT_CODEX_PERMISSION_MODE: CodexPermissionMode = 'never'

type CodexFailureStage =
  | 'initialize'
  | 'thread-start'
  | CodexWireFailureFacts['stage']
  | 'process'
  | 'teardown'

type CodexFailureCategory = CodexWireFailureFacts['category'] | 'process'

interface CodexFailureFacts {
  readonly stage: CodexFailureStage
  readonly category: CodexFailureCategory
  readonly httpStatus?: number | undefined
  readonly outcome?: SubprocessOutcome | undefined
}

function failureDiagnostic(facts: CodexFailureFacts): string {
  const fields = [
    'product: Codex',
    `stage: ${facts.stage}`,
    `category: ${facts.category}`,
  ]
  if (facts.httpStatus !== undefined) {
    fields.push(`HTTP status: ${facts.httpStatus}`)
  }
  const processFields = [
    ['exit code', facts.outcome?.exitCode],
    ['signal', facts.outcome?.signal],
  ] as const
  for (const [label, value] of processFields) {
    if (value !== null && value !== undefined) fields.push(`${label}: ${value}`)
  }
  return `Product subagent failure (${fields.join('; ')})`
}

class CodexRunFailure extends Error {
  constructor(
    readonly facts: CodexFailureFacts,
    cause?: unknown,
  ) {
    super(
      `subagent-codex: ${failureDiagnostic(facts)}`,
      cause === undefined ? undefined : { cause },
    )
    this.name = 'CodexRunFailure'
  }
}

/**
 * 把一个未发布的宿主机失败隐藏在固定的安全启动事实之后。
 * @param cause 为内部诊断保留的原始宿主机失败。
 * @returns 一个其消息只包含固定安全事实的启动失败。
 */
export function codexStartupFailure(cause: unknown): Error {
  return new CodexRunFailure({
    stage: 'initialize',
    category: 'unknown',
  }, cause)
}

/**
 * 固定的、包局部的 app-server 命令，与宿主 `PATH` 无关。
 * @returns Node、官方包装器与固定的 app-server 实参。
 */
export function codexAppServerArgv(): string[] {
  return [process.execPath, CODEX_PACKAGE_BIN, 'app-server', '--stdio']
}

/** 一次 Codex app-server 运行的、已完全解析的输入。 */
export interface CodexRunSpec {
  /** 已选定的子工作目录，同时也提供给 `thread/start`。 */
  readonly cwd: string
  /** 由 profile 选择的原生模型；省略以保留 Codex 设置。 */
  readonly model?: string
  /** 由 profile 选择的原生非交互权限模式。 */
  readonly permissionMode: CodexPermissionMode
  /** 在共享清洗之后叠加的显式部署/测试环境。 */
  readonly env: Record<string, string>
  /** 传给共享受管范围属主的 subprocess 终止宽限。 */
  readonly disposeGraceMs: number
  /** 共享 subprocess 服务的 spawn 操作。 */
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** 用于把被扁平化进结果的、发布后错误的诊断汇。 */
  readonly onError?: (error: Error, stopReason: SubagentStopReason) => void
}

function thrown(value: unknown): Error {
  /* v8 ignore next -- 类型化的 subprocess/wire 失败以 Error 拒绝。 */
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * 在跨越进程边界之前校验并保留一次性任务。
 * @param prompt - 从共享子代理 service 接受的任务内容。
 * @returns 精确的非空文本块序列。
 */
export function textTask(prompt: readonly ContentBlock[]): string[] {
  if (prompt.length === 0) {
    throw new Error('subagent-codex: the one-shot task must contain only text blocks')
  }
  const texts: string[] = []
  for (const block of prompt) {
    if (block.type !== 'text') {
      throw new Error('subagent-codex: the one-shot task must contain only text blocks')
    }
    texts.push(block.text)
  }
  if (texts.every(text => text.trim().length === 0)) {
    throw new Error('subagent-codex: the one-shot task must not be empty')
  }
  return texts
}

/**
 * 关闭私有wire、终止受管范围，并等待 subprocess 属主证明它已静默。
 * @param wire - 私有的 app-server 协议连接。
 * @param child - 拥有受管范围的共享服务句柄。
 */
export async function disposeCodexChild(
  wire: CodexAppServerWire,
  child: SubprocessHandle,
): Promise<void> {
  wire.close()

  let outcome: SubprocessOutcome | undefined
  void child.done.then(
    (value) => { outcome = value },
    () => {},
  )
  try {
    child.stdin?.end()
  } catch {
    // 一个并发关闭的 stdin 不改变下方的范围属主关系。
  }
  child.terminate()
  try {
    await child.waitForExit()
  } catch (error: unknown) {
    throw new CodexRunFailure({
      stage: 'teardown',
      category: 'unknown',
      outcome,
    }, thrown(error))
  }
  await child.done.catch(() => {})
}

/**
 * 启动真实的 `codex app-server --stdio` 子代理并发布其一次性运行。
 * @param request - 已解析的共享子代理请求。
 * @param spec - 工作区、环境、进程服务与诊断策略。
 * @returns 在初始化与临时线程创建之后发布的运行。
 */
export async function startCodexRun(
  request: SubagentStartRequest,
  spec: CodexRunSpec,
): Promise<SubagentRun> {
  const texts = textTask(request.prompt)
  if (request.signal.aborted) {
    throw new Error('subagent-codex: request was aborted before app-server startup')
  }

  let child: SubprocessHandle
  try {
    child = spec.spawn({
      argv: codexAppServerArgv(),
      cwd: spec.cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: spec.disposeGraceMs,
      env: spec.env,
    })
  } catch (error: unknown) {
    throw new CodexRunFailure({
      stage: 'initialize',
      category: 'unknown',
    }, thrown(error))
  }

  const wire = new CodexAppServerWire(
    child.stdout as NonNullable<SubprocessHandle['stdout']>,
    child.stdin as NonNullable<SubprocessHandle['stdin']>,
    spec.permissionMode,
    spec.model,
  )
  const onStderr = (chunk: Buffer | string): void => {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    try {
      // 同步的 fd 转发保留字节顺序，而无需拥有一个背压队列。
      // 一个缓慢的宿主机汇可能阻塞这个事件循环轮次。
      writeFileSync(process.stderr.fd, bytes)
    } catch {
      // 宿主 stderr 是一个观测汇，而非子运行的失败权威。
    }
  }
  const onStderrError = (): void => {
    // stderr 观测是辅助性的。若诊断流本身失败，JSON-RPC 与 child.done
    // 仍是唯一的终止权威。
  }
  child.stderr?.on('data', onStderr)
  child.stderr?.on('error', onStderrError)
  const disposeProcess = async (): Promise<void> => {
    try {
      await disposeCodexChild(wire, child)
      // 让进程关闭时已排队的 stderr 在其转发监听器被摘除之前到达宿主机。
      await new Promise<void>((resolve) => { setImmediate(resolve) })
    } finally {
      child.stderr?.off('data', onStderr)
      child.stderr?.off('error', onStderrError)
    }
  }

  let processFailureFacts: CodexFailureFacts | undefined
  const processFailure: Promise<never> = child.done.then<never>(
    (outcome) => {
      processFailureFacts = {
        stage: 'process',
        category: 'process',
        outcome,
      }
      throw new CodexRunFailure(processFailureFacts)
    },
    (error: unknown) => {
      processFailureFacts = {
        stage: 'process',
        category: 'unknown',
      }
      throw new CodexRunFailure(processFailureFacts, thrown(error))
    },
  )
  // 一次正常的结果后处置也会关闭进程。当终止结果先结算时，
  // 保持其预期的迟到拒绝被观测到。
  processFailure.catch(() => {})

  const runAbort = new AbortController()
  const requestCancel = (): void => {
    if (runAbort.signal.aborted) return
    runAbort.abort(new Error('subagent-codex: run cancelled locally'))
    wire.interrupt()
  }
  const onAbort = (): void => { requestCancel() }
  request.signal.addEventListener('abort', onAbort, { once: true })

  let startupStage: 'initialize' | 'thread-start' = 'initialize'
  try {
    wire.start()
    await Promise.race([wire.initialize(request.signal), processFailure])
    startupStage = 'thread-start'
    await Promise.race([wire.startThread(spec.cwd, request.signal), processFailure])
  } catch (error: unknown) {
    request.signal.removeEventListener('abort', onAbort)
    const cancelledBeforeCleanup = runAbort.signal.aborted
    if (!(error instanceof CodexRunFailure) && !cancelledBeforeCleanup) {
      // Node 在拥有其结果的子关闭之前就报告 stdout EOF。
      // 让一个已经在退出的进程在回滚之前发布那些事实。
      await new Promise<void>((resolve) => { setImmediate(resolve) })
    }
    const failure = new CodexRunFailure({
      stage: startupStage,
      category: 'unknown',
      outcome: error instanceof CodexRunFailure
        ? error.facts.outcome
        : processFailureFacts?.outcome,
    }, thrown(error))
    try {
      await disposeProcess()
    } catch (disposeError: unknown) {
      const cleanupFailure = thrown(disposeError)
      throw new AggregateError(
        [failure, cleanupFailure],
        `${failure.message}; ${cleanupFailure.message}`,
      )
    }
    if (cancelledBeforeCleanup) {
      throw new Error('subagent-codex: request was aborted before run publication')
    }
    try {
      request.signal.throwIfAborted()
    } catch {
      throw new Error('subagent-codex: request was aborted before run publication')
    }
    throw failure
  }

  const collectOutput = (): ContentBlock[] => wire.collectOutput()
  let diagnostic: string | undefined
  const recordFailureDiagnostic = (facts: CodexFailureFacts): string => {
    const failure = failureDiagnostic(facts)
    const permission = wire.collectDiagnostic()
    diagnostic = permission === undefined
      ? failure
      : `${failure}\n${permission}`
    return diagnostic
  }
  const withProcessOutcome = (facts: CodexFailureFacts): CodexFailureFacts => {
    const outcome = processFailureFacts?.outcome
    return outcome === undefined
      ? facts
      : { ...facts, outcome }
  }
  const publishedProcessFailure = processFailure.catch(
    async (error: unknown): Promise<never> => {
      // 由正在退出的 app-server 已排队的帧保持权威。
      // 一个 I/O 轮次让它们在进程退出结束运行之前结算。
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      throw error
    },
  )
  const result: Promise<SubagentResult> = settleRunResult({
    attempt: async () => {
      try {
        const terminal = await Promise.race([
          wire.runTurn(texts, runAbort.signal),
          publishedProcessFailure,
        ])
        if (terminal.stopReason === 'completed') return terminal
        // 让已与终止帧一起排队的 stderr 在非完成结果结算之前到达宿主机。
        await new Promise<void>((resolve) => { setImmediate(resolve) })
        const facts = withProcessOutcome(wire.collectFailure())
        return { ...terminal, diagnostic: recordFailureDiagnostic(facts) }
      } catch (error: unknown) {
        // 在错误结算之前，给 Node 中已排队的 stderr 数据一个轮次到达宿主机。
        await new Promise<void>((resolve) => { setImmediate(resolve) })
        const endedBeforeTerminal = wire.endedBeforeTerminal()
        if (
          endedBeforeTerminal
          && processFailureFacts === undefined
          && !runAbort.signal.aborted
        ) {
          try {
            const exited = await child.waitForExit(
              AbortSignal.timeout(Math.ceil(spec.disposeGraceMs)),
            )
            if (exited) await child.done
          } catch {
            // 当退出观测失败时，wire 失败保持权威。
          }
        }
        const facts = error instanceof CodexRunFailure
          ? error.facts
          : endedBeforeTerminal && processFailureFacts !== undefined
            ? processFailureFacts
            : withProcessOutcome(wire.collectFailure())
        recordFailureDiagnostic(facts)
        throw error instanceof CodexRunFailure
          ? error
          : new CodexRunFailure(facts, thrown(error))
      }
    },
    collectOutput,
    collectDiagnostic: () => diagnostic,
    cancelled: () => runAbort.signal.aborted,
    onError: spec.onError,
    signal: request.signal,
    onAbort,
  })

  return subprocessRunHandle({
    id: brandString<SessionId>(randomUUID()),
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown: disposeProcess,
  })
}
