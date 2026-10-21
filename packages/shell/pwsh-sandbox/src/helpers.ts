/**
 * 沙箱结果分类的内部辅助函数——对 `@deepseek-ai/dsh-bash-sandbox/src/helpers.ts`
 * 的逐调用刻意镜像（bash 消费方的 pwsh 孪生体共用完全相同的分类方言）。
 *
 * @module @deepseek-ai/dsh-pwsh-sandbox/helpers
 */

/* jscpd:ignore-start */
import { accessSync, constants, statSync } from 'node:fs'
import type { ShellRunResult } from '@deepseek-ai/dsh-shell'
import type { RunnerFailureRule } from '@deepseek-ai/dsh-sandbox'

/** 已被证实能标识可执行解析或权限失败的 Node spawn 错误码。 */
const EXECUTABLE_SPAWN_CODES = new Set(['EACCES', 'ENOENT'])

/** 调用方持有的 spawn cwd 是否可进入。 */
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
 * 只把那些路径或 syscall 能指名 argv[0]、且已独立排除调用方所持 cwd 的
 * Node ENOENT/EACCES 失败归因于运行器。若提供了错误路径，它必须精确指名
 * 运行器；没有路径时，则必须由 syscall 指名。在 cwd 可用时，这些错误码
 * 描述的是该 argv[0] 或其 shebang 解释器的解析或执行权限问题。
 * workdir 是在分类时检查的，而非与 spawn 原子地检查；并发的路径替换
 * 可能改变归因，但绝不会放行一次未受隔离的执行。
 * @param error - 原始的 spawn 拒绝。
 * @param runnerProgram - provider 的 argv[0]，即建立隔离的可执行文件。
 * @param workdir - 调用方持有的 spawn cwd，会被独立检查其可用性。
 * @returns 该拒绝是否带有可执行文件特有的运行器证据。
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

/** 为基础设施错误详情而保留的致命运行器证据。 */
interface RunnerFailureMatch {
  /** 匹配到致命特征的原始 stderr 行。 */
  detail: string
}

/**
 * 按所选后端的拒绝方言对一次失败的运行进行分类。
 * @param result - 已落定的前台运行。
 * @param signatures - 来自当前包装的、大小写不敏感的拒绝特征子串。
 * @returns 该失败运行是否匹配这一拒绝方言。
 */
export function classifyDenial(result: ShellRunResult, signatures: readonly string[]): boolean {
  return matchesSignature(result.exitCode, result.stderr.text, signatures)
}

/**
 * 按所选后端结构化的运行器失败规则，对一个已落定的进程进行分类。每条规则
 * 都要求非零退出、其可选的退出码闸门，以及在排除完全匹配的信息性行之后
 * 某一 stderr 行上的致命特征。
 * @param exitCode - 进程退出码；null 表示被信号终止。
 * @param stderr - 采集到的 stderr 文本，不做改动。
 * @param rules - 来自当前包装的结构化运行器失败规则。
 * @returns 首个匹配到的致命行；证据不足时返回 undefined。
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
    // 空子串或仅由空白组成的子串不构成有意义的运行器证据；
    // 忽略它，同时保持与之并列的合法特征仍然生效。
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
 * 把非零退出与大小写不敏感的 stderr 特征相匹配。
 * @param exitCode - 进程退出码；null 表示被信号终止。
 * @param stderr - 采集到的 stderr 文本。
 * @param signatures - 标识所选后端方言的子串。
 * @returns 这是否是一个 stderr 匹配到特征的非零退出。
 */
export function matchesSignature(exitCode: number | null, stderr: string, signatures: readonly string[]): boolean {
  if (exitCode === null || exitCode === 0) return false
  const lowered = stderr.toLowerCase()
  return signatures.some(signature => lowered.includes(signature.toLowerCase()))
}
/* jscpd:ignore-end */
