/** 对观测到的沙箱运行器失败与文件效应拒绝进行分类。 */
import { accessSync, constants, statSync } from 'node:fs'
import type { RunnerFailureRule } from './index.ts'

/** 已证实可标识可执行文件解析或权限失败的 Node 本地 spawn 错误码。 */
const EXECUTABLE_SPAWN_CODES = new Set(['EACCES', 'ENOENT'])

/** 调用方提供的 spawn 工作目录是否可进入。 */
function isUsableWorkdir(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 仅在独立排除调用方工作目录之后，才把错误路径等于 argv[0] 的 Node
 * ENOENT/EACCES 失败归因到运行器：错误自带路径时必须精确指认运行器，
 * 否则由 syscall 指认。在工作目录可用的前提下，这些错误码描述的正是该
 * argv[0] 或其 shebang 解释器的解析失败或执行权限问题。
 * 工作目录是在分类时检查的，与 spawn 并非原子操作；并发的路径替换可能
 * 改变归属判断，但不会让一次不受限的执行被放行。
 * @param error - 原始的 spawn 拒绝错误。
 * @param runnerProgram - 提供者的 argv[0]，即建立限制执行环境的可执行文件。
 * @param workdir - 调用方提供的 spawn 工作目录，独立检查其是否可用。
 * @returns 该拒绝是否带有针对该可执行文件的运行器证据。
 */
export function isRunnerSpawnFailure(
  error: unknown,
  runnerProgram: string | undefined,
  workdir: string,
): boolean {
  if (runnerProgram === undefined || !isUsableWorkdir(workdir)) return false
  if (typeof error !== 'object' || error === null) return false
  const { code, path, syscall } = error as { code?: unknown; path?: unknown; syscall?: unknown }
  if (typeof code !== 'string' || !EXECUTABLE_SPAWN_CODES.has(code)) return false
  if (typeof syscall !== 'string') return false
  const exactSyscall = `spawn ${runnerProgram}`
  if (path === undefined) return syscall === exactSyscall
  if (typeof path !== 'string' || path.length === 0 || path !== runnerProgram) return false
  return syscall === 'spawn' || syscall === exactSyscall
}

/** 为基础设施错误详情保留的致命运行器证据。 */
interface RunnerFailureMatch {
  /** 命中致命特征串的原始 stderr 行。 */
  detail: string
}

/**
 * 依据所选后端的运行器失败结构化规则，对一次已结束的进程进行分类。
 * 每条规则都要求：非零退出、可选的退出码门槛，以及在排除完全匹配的信息性
 * 行之后，某一 stderr 行上出现致命特征串。
 * @param exitCode - 进程退出码；null 表示被信号终止。
 * @param stderr - 收集到的 stderr 文本，不做修改。
 * @param rules - 来自当前包装的运行器失败结构化规则。
 * @returns 首个匹配的致命行；证据不足时返回 undefined。
 */
export function classifyRunnerFailure(
  exitCode: number | null,
  stderr: string,
  rules: readonly RunnerFailureRule[],
): RunnerFailureMatch | undefined {
  if (exitCode === null || exitCode === 0) return undefined
  const lines = stderr.split(/\r?\n/)
  for (const rule of rules) {
    if (rule.allowedExitCodes !== undefined && !rule.allowedExitCodes.includes(exitCode)) continue
    const informationalLines = new Set((rule.informationalLines ?? []).map(line => line.toLowerCase()))
    // 空串或纯空白子串不构成有意义的运行器证据：忽略它，同时让其旁边
    // 其他有效特征串继续生效。
    const fatalSignatures = rule.fatalSignatures
      .filter(signature => signature.trim().length > 0)
      .map(signature => signature.toLowerCase())
    for (const line of lines) {
      const lowered = line.toLowerCase()
      if (informationalLines.has(lowered)) continue
      if (fatalSignatures.some(signature => lowered.includes(signature))) return { detail: line }
    }
  }
  return undefined
}

/**
 * 将非零退出与大小写不敏感的 stderr 特征串做匹配。
 * @param exitCode - 进程退出码；null 表示被信号终止。
 * @param stderr - 收集到的 stderr 文本。
 * @param signatures - 标识所选后端方言的子串。
 * @returns 是否为 stderr 命中特征串的非零退出。
 */
export function matchesSignature(exitCode: number | null, stderr: string, signatures: readonly string[]): boolean {
  if (exitCode === null || exitCode === 0) return false
  const lowered = stderr.toLowerCase()
  return signatures.some(signature => lowered.includes(signature.toLowerCase()))
}
