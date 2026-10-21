/**
 * 基于子进程终端原语、共享沙箱策略、有界输出以及由提供者持有的会话清理之上的
 * 持久化 shell PTY 后端。
 * @module @deepseek-ai/dsh-terminal-bash
 */

import type {} from '@deepseek-ai/dsh-working-directory'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { TerminalBackendCleanupError } from '@deepseek-ai/dsh-terminal'
import type { TerminalBackend, TerminalBackendSpawnSpec, TerminalSendOperation } from '@deepseek-ai/dsh-terminal'
import type { SubprocessTerminalHandle, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-session-projection'
import { ENCODING_PREAMBLE } from '@deepseek-ai/dsh-pwsh-local'
import { type Config, type ResolvedConfig, resolveConfig, type ShellDialect, validateConfig } from './config.ts'
import { LocalPtySession } from './session.ts'
import { CONTROLLED_PROMPT } from './sanitize.ts'

export { Config } from './config.ts'
export type { Config as TerminalLocalConfig } from './config.ts'

/** Cordis 插件名称。 */
export const name = 'terminal-bash'
/** 所需的服务：终端注册表、共享隔离策略、投影注册表与进程子层。 */
export const inject = ['terminals', 'sandboxPolicy', 'sessionProjections', 'subprocess', 'workingDirectory']

interface SandboxModeFenceState {
  pty: Context['terminals']
  sandboxPolicy: Context['sandboxPolicy']
  sessionProjections: Context['sessionProjections']
}

const sandboxModeFences = new WeakMap<Agent, SandboxModeFenceState>()

function ensureSandboxModeFence(ctx: Context, owner: Agent): void {
  const existing = sandboxModeFences.get(owner)
  if (existing !== undefined) {
    existing.pty = ctx.terminals
    existing.sandboxPolicy = ctx.sandboxPolicy
    existing.sessionProjections = ctx.sessionProjections
    return
  }
  const state: SandboxModeFenceState = {
    pty: ctx.terminals,
    sandboxPolicy: ctx.sandboxPolicy,
    sessionProjections: ctx.sessionProjections,
  }
  sandboxModeFences.set(owner, state)
  owner.ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (session !== owner.session || event.type !== 'sandbox/mode') return
    const folded = state.sessionProjections.stateOf(session, 'sandboxMode') ?? null
    const currentMode = folded ?? state.sandboxPolicy.defaultMode
    if (event.data.mode === currentMode || !state.pty.hasOwnerActivity(owner)) return
    throw new Error(
      `cannot change sandbox mode from "${currentMode}" to "${event.data.mode}" while persistent terminal sessions are open or being created; wait for creation to settle and close them first`,
    )
  }, { global: true })
}

function childEnvironment(spec: TerminalBackendSpawnSpec, dialect: ShellDialect): Record<string, string> {
  // 子进程提供者会提供自身经过清理的环境基线；以下是有意叠加在其后的、
  // 终端特有的覆盖项。
  const common = {
    TERM: 'dumb',
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    DSH_SHELL: '1',
    DSH_SESSION_ID: spec.owner.id,
    DSH_PTY_SESSION_ID: spec.sessionId,
  }
  if (dialect === 'pwsh') {
    // pwsh 忽略 PS1/PROMPT_COMMAND；其提示符由启动引导程序安装，而 NO_COLOR
    // 则让渲染器保持安静。
    return { ...common, NO_COLOR: '1' }
  }
  return {
    ...common,
    PS1: CONTROLLED_PROMPT,
    // 在标记之后重新声明 PS1，可在某条命令覆盖了该 shell 变量时仍保持提示符就绪：
    // bash 在渲染每个提示符前都会运行 PROMPT_COMMAND，因此任何覆盖都无法存活到下一个提示符。
    PROMPT_COMMAND: `printf "\\033]133;D;%s\\007" "$?"; PS1='${CONTROLLED_PROMPT}'`,
    BASH_SILENCE_DEPRECATION_WARNING: '1',
  }
}

/**
 * pwsh 的提示函数，在每个提示符前发出共享的 OSC `133;D;` + BEL 标记，
 * 对应 bash 的 PROMPT_COMMAND。`[char]27`/`[char]7` 在运行时构造控制字节，
 * 因为提交输入中的原始 ESC 字符在 PSReadLine 下不可靠。
 */
export const PWSH_PROMPT_SETUP =
  "function prompt { [Console]::Write([char]27 + ']133;D;' + [int]$LASTEXITCODE + [char]7); '" + CONTROLLED_PROMPT + "' }"

async function spawnArgv(ctx: Context, config: ResolvedConfig, policy: SandboxExecutionPolicy, signal?: AbortSignal): Promise<string[]> {
  const argv = [config.shellPath, ...config.shellArgs]
  if (policy.mode === 'danger-full-access') return argv
  const sandbox = ctx.get('sandbox')
  if (sandbox === undefined) {
    throw new Error(`terminal-bash: sandbox mode "${policy.mode}" requires a ctx.sandbox provider in the execution world`)
  }
  // 重新声明判别字段，因为对象展开不会保留其收窄后的类型。
  return (await sandbox.confine(argv, { ...policy, mode: policy.mode }, signal)).argv
}

// TODO(pty-initialize-race-home): 当发送状态整合落地时，将此外层的 abort 竞态并入
// LocalPtySession.initialize；该会话已经持有此竞态所保护的发送生命周期。
async function startupSession(
  session: LocalPtySession,
  dialect: ShellDialect,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  let startupOperation: TerminalSendOperation | undefined
  const start = async (): Promise<void> => {
    if (dialect === 'bash') {
      await session.initialize(signal)
      return
    }
    // pwsh cannot install its prompt from the environment. Write the prompt
    // function through the session, pin UTF-8 output before user input, and
    // accept only backend stdin_read evidence; echoed setup source containing
    // the printable prompt is not readiness. Follow-up sends bridge silence
    // settlements during startup, while one absolute deadline bounds them.
    let viewport = ''
    for (;;) {
      const first = viewport.length === 0
      startupOperation = session.startSend({
        text: first ? ENCODING_PREAMBLE + PWSH_PROMPT_SETUP : '',
        submit: first,
        ...signal !== undefined ? { signal } : {},
      })
      const result = await startupOperation.done
      if (result.waitReason === 'session_exit') throw new Error('PTY shell exited during startup')
      if (result.waitReason === 'timeout') throw new Error('PTY shell did not reach readiness before startup timeout')
      viewport = result.viewport
      if (result.waitReason === 'stdin_read') break
    }
    session.motd = viewport
  }
  const races: Promise<void>[] = []
  let onAbort: (() => void) | undefined
  if (signal !== undefined) {
    const aborted = Promise.withResolvers<never>()
    onAbort = () => { aborted.reject(signal.reason) }
    signal.addEventListener('abort', onAbort, { once: true })
    races.push(aborted.promise)
  }
  let deadlineTimer: NodeJS.Timeout | undefined
  if (dialect === 'pwsh') {
    const deadline = Promise.withResolvers<never>()
    deadlineTimer = setTimeout(() => {
      startupOperation?.cancel()
      deadline.reject(new Error('PTY shell did not reach readiness before startup timeout'))
    }, timeoutMs)
    races.push(deadline.promise)
  }
  try {
    signal?.throwIfAborted()
    await Promise.race([start(), ...races])
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
    if (signal !== undefined && onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

/** 仅在失败启动的未发布资源达到静止后，才拒绝该次启动。 */
async function rejectAfterStartupCleanup(error: unknown, cleanup: () => Promise<void>): Promise<never> {
  try {
    await cleanup()
  } catch (cleanupError: unknown) {
    throw new TerminalBackendCleanupError(error, cleanupError)
  }
  throw error
}

/** Local shell backend registered under the configured type. */
export class BashTerminalBackend implements TerminalBackend {
  readonly type: string

  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
    private readonly spawnTerminal: (
      spec: SubprocessTerminalSpawnSpec,
    ) => Promise<SubprocessTerminalHandle> = spec => ctx.subprocess.spawnTerminal(spec),
    private readonly createSession: (
      terminal: SubprocessTerminalHandle,
      config: ResolvedConfig,
    ) => LocalPtySession = (terminal, config) => new LocalPtySession(terminal, config),
  ) {
    this.type = config.backendType
  }

  async spawn(spec: TerminalBackendSpawnSpec): Promise<LocalPtySession> {
    spec.signal?.throwIfAborted()
    ensureSandboxModeFence(this.ctx, spec.owner)
    const policy = this.ctx.sandboxPolicy.resolve({ session: spec.owner.session })
    const argv = await spawnArgv(this.ctx, this.config, policy, spec.signal)
    spec.signal?.throwIfAborted()
    if (argv[0] === undefined) throw new Error('terminal-bash: sandbox returned empty argv')
    const terminal = await this.spawnTerminal({
      argv,
      cwd: spec.cwd ?? await this.ctx.workingDirectory.ensure(spec.owner, spec.signal),
      env: childEnvironment(spec, this.config.shellDialect),
      rows: this.config.rows,
      cols: this.config.cols,
      terminalType: 'dumb',
      graceMs: this.config.disposeGraceMs,
      signal: spec.signal,
    })
    let session: LocalPtySession
    try {
      session = this.createSession(terminal, this.config)
    } catch (error) {
      return rejectAfterStartupCleanup(error, () => terminal.terminate())
    }
    try {
      await startupSession(session, this.config.shellDialect, this.config.timeoutMs, spec.signal)
      return session
    } catch (error) {
      return rejectAfterStartupCleanup(error, () => session.close('PTY startup failed'))
    }
  }
}

/** 注册本地 PTY 后端。 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  validateConfig(resolved)
  ctx.terminals.registerBackend(new BashTerminalBackend(ctx, resolved))
}
