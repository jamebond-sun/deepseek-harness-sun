/**
 * 汇总每个顶层回合从回合开始与回合结束所拍摄的 git 工作树快照中
 * 发生的文件变更，外加针对 git 未覆盖的路径、在每次文件工具编辑
 * 周围拍摄的整文件捕获，并按需为每一个被列出的文件提供其前后比较。每次摘要由
 * 仅携带回合号的 `workspace/changes` Session 事件宣布；摘要与比较通过
 * `workspaceChanges` 服务一直提供，直到 Session 被释放。在 git 仓库之外，或
 * 没有 git 时，摘要仅列出文件工具的编辑。
 */
import { homedir, tmpdir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-tools'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { GitRunner } from './git.ts'
import { TurnRecorder } from './recorder.ts'
import type { WorkspaceChanges } from './types.ts'

export type {
  WorkspaceChangedFile, WorkspaceChanges, WorkspaceChangesSummary, WorkspaceDiffHunk, WorkspaceFileDiff,
} from './types.ts'

/** 稳定的 Loader 标识。 */
export const name = 'workspace-changes'

/** 用于运行 git、解析变更目标以及观察回合的服务。 */
export const inject = ['subprocess', 'fs']

/** 快照、捕获与比较的边界。无效值会导致插件加载失败。 */
export interface Config {
  /** 一条 git 命令在回合记录被放弃之前可运行的毫秒数。 */
  timeoutMs: number
  /** 每次命令保留的 git 输出字节数；更大的差异列表会放弃该记录。 */
  outputMaxBytes: number
  /** 一个摘要所携带的最大文件数；`total` 仍报告完整计数。 */
  maxFiles: number
  /**
   * 一个文件可持有的、用于在文件工具编辑周围被捕获、或从快照读取以进行比较的字节数。
   * 更大的文件不会得到比较；在文件工具编辑周围被捕获的更大文件也列而无计数。
   */
  maxFileBytes: number
  /** 行比较在退化为整文件替换之前可运行的毫秒数。 */
  diffTimeoutMs: number
}

/** 针对 {@link Config} 的 Schemastery 校验。 */
export const Config: z<Config> = z.object({
  timeoutMs: z.number().default(30_000),
  outputMaxBytes: z.number().default(8 * 1024 * 1024),
  maxFiles: z.number().default(500),
  maxFileBytes: z.number().default(2 * 1024 * 1024),
  diffTimeoutMs: z.number().default(100),
})

function eligible(session: Session): string | undefined {
  const { cwd, origin, delegationDepth } = session.header
  return origin === 'subagent' || (delegationDepth ?? 0) > 0 ? undefined : cwd
}

/**
 * 一次性解析 git 可执行文件。在 macOS 上，`/usr/bin/git` 处的 Xcode 桩
 * 会打开安装对话框而非运行，因此在选择开发者工具之前它算作缺失。
 * @param ctx - 子进程能力。
 * @param signal - 插件生命周期。
 * @returns 可执行文件路径；当 git 不可用时为 null。
 */
async function resolveGit(ctx: Context, signal: AbortSignal): Promise<string | null> {
  let executable: string
  try {
    executable = await ctx.subprocess.resolveExecutable('git', undefined, signal)
  } catch {
    return null
  }
  if (process.platform !== 'darwin' || executable !== '/usr/bin/git') return executable
  const probe = ctx.subprocess.spawn({
    argv: ['/usr/bin/xcode-select', '-p'], cwd: homedir(),
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } }, graceMs: 1_000, signal,
  })
  const outcome = await probe.done.catch(() => ({ exitCode: null }))
  return outcome.exitCode === 0 ? executable : null
}

/**
 * 观察每个拥有工作目录的 Session 的顶层回合，捕获
 * 文件工具编辑，宣布变更摘要，并以 `workspaceChanges` 身份
 * 连同其比较一起提供服务。
 * @param ctx - 带有 `subprocess` 与 `fs` 的宿主上下文。
 * @param config - 已校验的边界。
 */
export function apply(ctx: Context, config: Config): void {
  for (const [field, value] of [
    ['timeoutMs', config.timeoutMs], ['outputMaxBytes', config.outputMaxBytes], ['maxFiles', config.maxFiles],
    ['maxFileBytes', config.maxFileBytes], ['diffTimeoutMs', config.diffTimeoutMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`workspace-changes requires a positive integer ${field}`)
  }
  const lifetime = new AbortController()
  const recorders = new Map<Session, TurnRecorder>()
  const mutations = new WeakMap<object, TurnRecorder>()
  const byId = new Map<SessionId, TurnRecorder>()
  const forget = (session: Session): Promise<void> => {
    const recorder = recorders.get(session)
    recorders.delete(session)
    byId.delete(session.id)
    return recorder?.dispose() ?? Promise.resolve()
  }
  ctx.effect(() => async () => {
    lifetime.abort()
    await Promise.all([...recorders.keys()].map(forget))
  })
  const service: WorkspaceChanges = {
    summary: (sessionId, seq) => byId.get(sessionId)?.summary(seq),
    diff: (sessionId, seq, index, signal) => byId.get(sessionId)?.diff(seq, index, signal) ?? Promise.resolve(undefined),
  }
  ctx.provide('workspaceChanges', service)
  let runner: Promise<GitRunner | null> | undefined
  const gitRunner = (): Promise<GitRunner | null> => {
    runner ??= resolveGit(ctx, lifetime.signal).then((executable) => {
      if (executable === null) {
        ctx.logger.info('workspace-changes: git is unavailable; only file-tool edits are summarized')
        return null
      }
      return new GitRunner(ctx.subprocess, executable, { timeoutMs: config.timeoutMs, outputMaxBytes: config.outputMaxBytes })
    })
    return runner
  }
  const recorderFor = (session: Session, cwd: string): TurnRecorder => {
    let recorder = recorders.get(session)
    if (recorder === undefined) {
      recorder = new TurnRecorder(session, cwd, {
        git: gitRunner(), tempRoot: tmpdir(), maxFiles: config.maxFiles,
        maxFileBytes: config.maxFileBytes, diffTimeoutMs: config.diffTimeoutMs,
        warn: (message) => { ctx.logger.warn(message) },
      })
      recorders.set(session, recorder)
      byId.set(session.id, recorder)
    }
    return recorder
  }
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') {
      const cwd = eligible(session)
      if (cwd !== undefined) recorderFor(session, cwd).start(event.data.turn)
      return
    }
    if (event.type === 'tool/result') recorders.get(session)?.observe(event)
    else if (event.type === 'turn/end') recorders.get(session)?.end(event.data.turn)
  })
  ctx.on('session/disposed', (session) => { void forget(session) })
  ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
    await recorders.get(agent.session)?.stopping(turn)
  })
  const capture = async (target: FsTarget, actor: object | undefined): Promise<void> => {
    const recorder = actor === undefined ? undefined : mutations.get(actor)
    if (recorder === undefined) return
    recorder.capture(ctx.fs.processPath(target))
    await recorder.settled()
  }
  ctx.on('fs/write-intent', async (target, actor, next) => {
    const intent = await next()
    await capture(target, actor)
    return intent
  }, { prepend: true })
  ctx.on('fs/edit-intent', async (target, actor, next) => {
    const intent = await next()
    await capture(target, actor)
    return intent
  }, { prepend: true })
  ctx.on('tools/pre-execute', async (exec, next) => {
    const session = exec.agent?.session
    const recorder = session === undefined ? undefined : recorders.get(session)
    if (recorder !== undefined) {
      mutations.set(exec, recorder)
      await recorder.settled()
    }
    return next()
  })
}
