/**
 * 面向 OUT-OF-PROCESS（进程外）子代理后端的提供方侧词汇 —— 围绕另一个进程中的
 * 子代理来强制本接缝自身契约的那些部分：无能力声明、时序界限校验、子代理
 * 工作目录校验、从不拒绝的结果结算，以及标准的运行句柄发布。后端把这些
 * 与各自的wire 驱动组合起来；进程机制本身（spawn、env 清理、受管范围拆解）
 * 属于 `dsh-subprocess` 接缝。
 *
 * @module @deepseek-ai/dsh-subagent/out-of-process
 */

import { accessSync, constants, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentCapabilities, SubagentResult, SubagentRun, SubagentStopReason } from './types.ts'

/** {@link SubagentResult.diagnostic} 的最大 UTF-8 大小。 */
const MAX_SUBAGENT_DIAGNOSTIC_BYTES = 4_096

const DIAGNOSTIC_TRUNCATION_SUFFIX = '\n[diagnostic truncated]'
const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder()

/**
 * 限制提供方撰写的失败详情，而不切断 UTF-8 序列。
 * @param diagnostic - 提供方产生的安全诊断文本。
 * @returns 原文本，或位于上限之内且可见被截断的值。
 */
function limitSubagentDiagnostic(diagnostic: string): string {
  const bytes = utf8Encoder.encode(diagnostic)
  if (bytes.byteLength <= MAX_SUBAGENT_DIAGNOSTIC_BYTES) return diagnostic

  const suffixBytes = utf8Encoder.encode(DIAGNOSTIC_TRUNCATION_SUFFIX).byteLength
  let prefixBytes = MAX_SUBAGENT_DIAGNOSTIC_BYTES - suffixBytes
  while (((bytes[prefixBytes] as number) & 0b1100_0000) === 0b1000_0000) {
    prefixBytes -= 1
  }
  return utf8Decoder.decode(bytes.subarray(0, prefixBytes))
    + DIAGNOSTIC_TRUNCATION_SUFFIX
}

/** 对提供方返回的诊断强制执行字节上限。 */
function normalizeSubagentDiagnostic(result: SubagentResult): SubagentResult {
  return result.diagnostic === undefined
    ? result
    : { ...result, diagnostic: limitSubagentDiagnostic(result.diagnostic) }
}

/**
 * 进程外后端的能力声明：NONE（全无）。另一个进程中的子代理无法兑现由父代理
 * 强制的启动特性（`agentOptions`/`agentPreset`/`outputSchema`/`maxDepth`），
 * 因此 service 会在 `start` 运行之前拒绝任何需要它们的请求 —— 绝不先接受再忽略。
 */
export const NO_START_CAPABILITIES: SubagentCapabilities = Object.freeze({
  agentOptions: false,
  agentPreset: false,
  outputSchema: false,
  depthLimit: false,
})

/**
 * 断言一个已配置的时序界限是正有限数（它界定一次拆解或关停等待；零、负数
 * 或 NaN 会跳过或卡住它）。
 * @param prefix - 消费方插件的诊断前缀（例如 `subagent-acp`）。
 * @param name - 配置字段名，用于诊断。
 * @param value - 已配置的值。
 */
export function assertPositiveFinite(prefix: string, name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${prefix}: ${name} must be a positive finite number`)
  }
}

/**
 * `path` 是否指向一个 harness 可进入的既有目录。搜索权限探测很关键：
 * `statSync().isDirectory()` 对 mode-600 目录也返回 true，但子进程 cwd 需要
 * `X_OK`，否则 spawn 会报 EACCES。
 */
function isEnterableDirectory(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    // 此处 statSync/accessSync 只抛出文件系统访问错误
    // （ENOENT/EACCES/ENOTDIR/…），而其中任何一个都意味着该路径无法
    // 充当子代理的 cwd。
    return false
  }
}

/**
 * 断言 `cwd` 确实能承载子代理：绝对路径（它同时充当子代理的工作区身份，
 * 相对路径会被重新锚定到服务器进程的启动目录）且是既有目录（在此处、
 * 在进程边界之前失败，而非变成一个含糊的 spawn ENOENT）。
 * @param prefix - 消费方插件的诊断前缀。
 * @param label - 供诊断用，指明该值来自哪个来源。
 * @param cwd - 候选工作目录。
 * @returns 已校验的 `cwd`。
 */
export function assertUsableCwd(prefix: string, label: string, cwd: string): string {
  if (!isAbsolute(cwd)) {
    throw new Error(`${prefix}: ${label} must be an absolute path: ${cwd}`)
  }
  if (!isEnterableDirectory(cwd)) {
    throw new Error(`${prefix}: ${label} is not an accessible directory: ${cwd}`)
  }
  return cwd
}

/** 把未知抛出值规范化为 Error（catch 绑定是 `unknown`）。 */
function toError(value: unknown): Error {
  // 拒绝面（wire 客户端、spawn 失败）只抛 `Error`；`String(value)`
  // 分支是针对类型化表面无法产生的非 Error 抛出的防御性兜底。
  /* v8 ignore next */
  return value instanceof Error ? value : new Error(String(value))
}

/** {@link settleRunResult} 的输入。 */
export interface RunResultSettlement {
  /** 轮次尝试（通常与本地取消竞速）；返回终止结果。 */
  attempt: () => Promise<SubagentResult>
  /** 当取消或失败赢得结算时，提供方暴露的快照。 */
  collectOutput: () => readonly ContentBlock[]
  /** 当失败赢得结算时，安全的提供方撰写详情快照。 */
  collectDiagnostic?: (() => string | undefined) | undefined
  /** 在观察到尝试结果之前，本地取消是否已结算。 */
  cancelled: () => boolean
  /** 被扁平化为停止原因的失败所用的诊断汇；其中的抛出会被隔离。 */
  onError?: ((error: Error, stopReason: SubagentStopReason) => void) | undefined
  /** 请求的取消信号（监听器在结算时被移除）。 */
  signal: AbortSignal
  /** 在启动时注册到 {@link signal} 上的 abort 监听器。 */
  onAbort: () => void
}

/**
 * 在接缝契约下结算一个进程外运行结果：发布之后 `result` 永不拒绝。
 * 正常完成或被拒绝的尝试，若取消已在本地结算，则解析为 `aborted`；
 * 另一种拒绝则经由被隔离的诊断汇被扁平化为 `stopReason: 'error'`。
 * 提供方返回的诊断沿用同一字节上限。abort 监听器在每条路径上都会被移除。
 * @param parts - 尝试、输出快照、取消状态、诊断汇与信号接线。
 * @returns 终止结果（从不为拒绝）。
 */
export async function settleRunResult(parts: RunResultSettlement): Promise<SubagentResult> {
  try {
    const result = await parts.attempt()
    return parts.cancelled()
      ? { output: parts.collectOutput(), stopReason: 'aborted' }
      : normalizeSubagentDiagnostic(result)
  } catch (error: unknown) {
    // 覆盖取消到达时已排队的拒绝。
    if (parts.cancelled()) return { output: parts.collectOutput(), stopReason: 'aborted' }
    // 扁平化发布之后的传输失败，同时保留诊断。
    try {
      parts.onError?.(toError(error), 'error')
    } catch {
      // 诊断汇不能拒绝运行结果。
    }
    const collected = parts.collectDiagnostic?.()
    const diagnostic = collected === undefined
      ? undefined
      : limitSubagentDiagnostic(collected)
    return {
      output: parts.collectOutput(),
      ...diagnostic === undefined ? {} : { diagnostic },
      stopReason: 'error',
    }
  } finally {
    parts.signal.removeEventListener('abort', parts.onAbort)
  }
}

/** {@link subprocessRunHandle} 的输入。 */
export interface SubprocessRunHandleParts {
  /** 父作用域的运行 id。 */
  id: SubagentRun['id']
  /** 已被扁平化、从不拒绝的结果（接缝契约）。 */
  result: Promise<SubagentResult>
  /** 请求的取消信号（监听器在 dispose 时被移除）。 */
  signal: AbortSignal
  /** 在启动时注册到 {@link signal} 上的 abort 监听器。 */
  onAbort: () => void
  /** 结算本地取消，使 {@link result} 无需子代理即可解析。 */
  requestCancel: () => void
  /** 把子进程拆解到静默状态（后端自有的阶梯）。 */
  teardown: () => Promise<void>
}

/**
 * 为进程外子代理发布接缝运行句柄。`dispose()` 是幂等的（一次记忆化拆解）：
 * 它移除 abort 监听器、结算本地取消 —— 不假设子代理会配合 —— 然后等待
 * 后端的拆解直至真正退出。
 * @param parts - 运行身份、结果、取消接线与拆解。
 * @returns 外部运行句柄。
 */
export function subprocessRunHandle(parts: SubprocessRunHandleParts): SubagentRun {
  let disposal: Promise<void> | undefined
  return {
    id: parts.id,
    result: parts.result,
    dispose(): Promise<void> {
      if (disposal !== undefined) return disposal
      parts.signal.removeEventListener('abort', parts.onAbort)
      parts.requestCancel()
      disposal = parts.teardown()
      return disposal
    },
  }
}
