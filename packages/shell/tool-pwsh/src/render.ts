/**
 * pwsh 工具面向模型的结果渲染——`dsh-tool-bash` 渲染器的 PowerShell
 * 孪生体：stdout、带标记的 stderr 区块、沙箱拒绝／运行器失败标记（连同
 * 同轮次的升级提示）与带溢出路径的截断提示，最后是退出状态标记。非零
 * 退出是被上报而非被判为错误——如何反应由模型决定；只有基础设施故障
 * （spawn 错误、中止）才会以 isError 结果的形式浮现。
 *
 * @module @deepseek-ai/dsh-tool-pwsh/render
 */

import type { ShellSandboxInfo, CollectedOutput } from '@deepseek-ai/dsh-shell'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { escalationHintMarker, sandboxDenialMarker } from '@deepseek-ai/dsh-sandbox'

/* jscpd:ignore-start -- dsh-tool-bash/render.ts 的刻意孪生体（Agent Note）。 */

/** 把截断提示（连同完整输出的溢出路径）追加到某个流的文本之后。 */
function streamText(output: CollectedOutput): string {
  if (!output.truncated) return output.text
  return `${output.text}\n[output truncated; full output: ${output.spillPath ?? '(unavailable)'}]`
}

/** 可渲染的前台结果形状（即由 schema 推导出的值，不含 `kind`）。 */
export interface RenderablePwshResult {
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  /** 当作业的终止结束了该命令时，来自本次调用之外的停止原因。 */
  stopped?: string
  timeoutMs: number
  stdout: CollectedOutput
  stderr: CollectedOutput
  sandbox?: ShellSandboxInfo
}

/**
 * 把一次已完成的运行组织成模型看到的文本：先是 stdout，然后是带标记的
 * stderr 区块，再是退出状态标记，与 bash 工具的故事保持一致——干净的
 * 退出（0，无信号）不产生任何标记。
 * @param result - 来自执行器的、已完成的前台运行。
 * @param escalationModes - 本装配所声明的升级目标；非空时在拒绝标记之后
 *   追加同一轮次内的升级提示（默认 `[]`：不给出提示）。
 * @returns 面向模型的文本：输出主体（或 `(no output)`），随后是任何
 *   超时／信号／退出标记，各自独占一行。
 */
export function renderPwshResult(
  result: RenderablePwshResult,
  escalationModes: readonly SandboxMode[] = [],
): string {
  const out = streamText(result.stdout)
  const err = streamText(result.stderr)

  let body = out
  if (err.length > 0) {
    // 区块之间只保留单个换行（stdout 通常已经以换行结尾）。
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[stderr]\n${err}`
  }
  if (body.length === 0) body = '(no output)'

  const markers: string[] = []
  // 退出标记必须保持在最后，因为 parseExitStatus 以那里为锚点。
  if (result.sandbox?.denied) {
    markers.push(sandboxDenialMarker(result.sandbox.mode))
    // 只有在本装配提供升级能力时，才在最终的退出标记之前给出提示。
    if (escalationModes.length > 0) {
      markers.push(escalationHintMarker('command'))
    }
  }
  // 命令可能捕获终止信号并在超时后以 0 退出；仍需上报它被中断了。
  if (result.timedOut) markers.push(`[timed out after ${result.timeoutMs}ms]`)
  // 来自本次调用之外的终止（人类停止其作业）不是命令失败：
  // 其原因告诉模型不要重试。
  if (result.stopped !== undefined) markers.push(`[stopped: ${result.stopped}]`)
  if (result.signal !== null) {
    markers.push(`[killed by signal: ${result.signal}]`)
  } else if (result.exitCode !== 0) {
    markers.push(`[exit code: ${result.exitCode}]`)
  }
  if (markers.length === 0) return body

  if (!body.endsWith('\n')) body += '\n'
  return body + markers.join('\n')
}

/**
 * 把停止等待的前台调用组织成模型看到的文本：先是到目前为止采集到的输出
 * （在那一刻取用的一次消费式注册表读取，因此 `job_output` 会恰好从它之后
 * 继续），然后是仍在运行的标记与作业交接指引。
 * @param promoted - 晋升结果值：作业 id、已到期的等待，以及目前为止的输出。
 * @returns 一次晋升调用所对应的面向模型的文本。
 */
export function renderPwshPromoted(promoted: { jobId: string; timeoutMs: number; output: string }): string {
  const body = promoted.output.length > 0
    ? promoted.output.endsWith('\n') ? promoted.output : `${promoted.output}\n`
    : ''
  return `${body}[still running after ${promoted.timeoutMs}ms; moved to background job ${promoted.jobId}]\n`
    + 'The command keeps running in the background. You will be notified when it finishes; '
    + 'read newer output with job_output, stop it with job_kill.'
}

/**
 * 组织前台调用在停止等待时嵌入其结果的那次消费式注册表读取：到目前为止
 * 产生的输出，外加模型游标落后于环形缓冲时给出的输出丢弃提示（列出该作业
 * 的溢出文件），以及沙箱提示。之后的 `job_output` 读取会通过作业工具渲染
 * 同一个环形缓冲。
 * @param delta - 本次读取的分块所渲染出的文本。
 * @param lossy - delta 之前的字节是否被未读驱逐。
 * @param spillPaths - 该作业当前声明的完整流文件。
 * @param sandbox - 已落定的沙箱事实，即这是一个受隔离的进程时。
 * @param escalationModes - 本装配所声明的升级目标。
 * @returns 追加了丢失或沙箱提示之后的 delta 文本。
 */
export function renderPwshJobRead(
  delta: string,
  lossy: boolean,
  spillPaths: readonly string[],
  sandbox?: ShellSandboxInfo,
  escalationModes: readonly SandboxMode[] = [],
): string {
  const notices: string[] = []
  if (lossy) {
    notices.push(`[some output was dropped from memory; full output: ${spillPaths.length > 0 ? spillPaths.join(', ') : '(unavailable)'}]`)
  }
  if (sandbox?.runnerFailed) {
    notices.push(`[sandbox: the sandbox runner itself failed under ${sandbox.mode} mode — the command did not run; this is a sandbox problem, not a command failure]`)
  } else if (sandbox?.denied) {
    notices.push(sandboxDenialMarker(sandbox.mode))
    if (escalationModes.length > 0) {
      notices.push(escalationHintMarker('command'))
    }
  }
  if (notices.length === 0) return delta
  return `${delta}${delta.length > 0 && !delta.endsWith('\n') ? '\n' : ''}${notices.join('\n')}`
}
/* jscpd:ignore-end */
