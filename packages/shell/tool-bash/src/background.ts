/**
 * bash 进程句柄到通用作业的适配：注册表记录的终止结局、它抽取的拉取源，
 * 以及前台调用停止等待时渲染的环形读取。
 *
 * @module @deepseek-ai/dsh-tool-bash/background
 */

import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { escalationHintMarker, sandboxDenialMarker } from '@deepseek-ai/dsh-sandbox'
import type { ShellProcess, ShellSandboxInfo } from '@deepseek-ai/dsh-shell'
import type { JobChunk, JobHooks, JobOutcome, JobOutputSource } from '@deepseek-ai/dsh-jobs'

/**
 * 值得进入终止详情的沙箱事实：从未真正运行过命令的运行器，或一次拒绝
 * （并附上本装配所提供的升级提示）。
 * @param sandbox - 已落定的沙箱事实，即这是一个受隔离的进程时。
 * @param escalationModes - 本装配所声明的升级目标。
 * @returns 要追加的标记，按由旧到新排列。
 */
function sandboxNotes(sandbox: ShellSandboxInfo | undefined, escalationModes: readonly SandboxMode[]): string[] {
  if (sandbox?.runnerFailed) {
    return [`[sandbox: the sandbox runner itself failed under ${sandbox.mode} mode — the command did not run; this is a sandbox problem, not a command failure]`]
  }
  if (sandbox?.denied) {
    const notes = [sandboxDenialMarker(sandbox.mode)]
    if (escalationModes.length > 0) notes.push(escalationHintMarker('command'))
    return notes
  }
  return []
}

/**
 * 把一个已落定的后台进程映射到通用作业结局词汇上：`killed` 仍映射为
 * `killed`（详情：已知信号时给出信号），其余一律是 `completed`，以退出码
 * 作为详情。非零的命令退出被上报而非判为失败，与前台渲染完全一致。沙箱
 * 事实也会并入详情，因为作业的终止原因是每一位读者——模型的状态行、
 * 名单行——都会展示的那一行。
 * @param proc - 已落定的进程句柄。
 * @param escalationModes - 本装配所声明的升级目标。
 * @returns 供 `ctx.jobs` 注册的结局。
 */
export function processOutcome(proc: ShellProcess, escalationModes: readonly SandboxMode[] = []): JobOutcome {
  // TODO(background-infrastructure-outcome)：为 ShellProcess 增加显式的
  // 基础设施故障结局，再把它映射到作业 `failed`。受限运行器的失败会暴露
  // sandbox.runnerFailed，但未受隔离的 spawn 失败仍混同于无信号的 kill；
  // 真正的非零命令退出必须保持为 `completed`。
  const base: JobOutcome = proc.status === 'killed'
    ? { status: 'killed', detail: proc.signal !== null ? `signal: ${proc.signal}` : 'killed before exit' }
    : { status: 'completed', detail: `exit code: ${proc.exitCode ?? 0}` }
  const notes = sandboxNotes(proc.sandbox, escalationModes)
  return notes.length === 0 ? base : { ...base, detail: `${base.detail}; ${notes.join(' ')}` }
}

/**
 * 把进程的非消费式流读取器作为注册表的拉取源。它们是惰性绑定的，因为进程
 * 是在注册表准入该作业之后、于启动器内部 spawn 的；spawn 之前的读取得不到
 * 任何内容，而抽取过程不会触碰模型的消费游标。被拒绝的 spawn，其 stderr
 * 读取器会携带 provider 的 `subprocess failed before reporting an outcome: …`
 * 提示。
 * @param proc - 启动器 spawn 之后该进程的观察型流。
 * @returns 每条流一个源，stdout 在前。
 */
export function processSources(proc: () => Pick<ShellProcess, 'observed'> | undefined): JobOutputSource[] {
  const source = (channel: 'stdout' | 'stderr'): JobOutputSource => ({
    channel,
    read: (fromByte) => {
      const live = proc()
      return live === undefined ? { text: '', nextOffset: fromByte, lossy: false } : live.observed[channel].readFrom(fromByte)
    },
  })
  return [source('stdout'), source('stderr')]
}

/**
 * 把一次消费式注册表读取的环形分块，按 shell 工具渲染进程读取的方式呈现：
 * 先是顺序排列的 stdout 分块，然后把所有 stderr 分块放进同一个 `[stderr]`
 * 区块，这样前台调用停止等待时交出的输出，读起来与随后而来的那些
 * `job_output` 读取完全一致。
 * @param chunks - 自模型游标以来的分块，按偏移顺序排列。
 * @returns delta 文本，可能为空。
 */
export function ringDelta(chunks: readonly JobChunk[]): string {
  const out = chunks.filter(chunk => chunk.channel !== 'stderr').map(chunk => chunk.text).join('')
  const err = chunks.filter(chunk => chunk.channel === 'stderr').map(chunk => chunk.text).join('')
  const separator = out.length > 0 && !out.endsWith('\n') ? '\n' : ''
  return out + (err.length > 0 ? `${separator}[stderr]\n${err}` : '')
}

/**
 * 在作业准入之后适配异步的 shell 准备过程，而不暴露出半成品进程。
 * @param start - 以作业持有的取消信号启动进程。
 * @param outcome - 把已落定的进程投影为作业结局。
 * @returns 同步的作业钩子，其完成过程涵盖准备阶段与进程落定。
 */
export function processJob(
  start: (signal: AbortSignal) => Promise<ShellProcess>,
  outcome: (process: ShellProcess) => JobOutcome,
): JobHooks {
  const controller = new AbortController()
  let process: ShellProcess | undefined
  const done: Promise<JobOutcome> = (async () => {
    try {
      process = await start(controller.signal)
      try {
        if (controller.signal.aborted) process.kill()
      } finally {
        await process.done
      }
      return outcome(process)
    } catch (error: unknown) {
      return {
        status: controller.signal.aborted && process === undefined ? 'killed' : 'failed',
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  })()
  return {
    cancel: (reason) => {
      if (controller.signal.aborted) return
      controller.abort(reason)
      process?.kill()
    },
    done,
  }
}
