/** Session 拥有的用户终端，具有执行环境的系统用户权限。 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-working-directory'
import { Remote, RemoteError, TypertRemoteService, type RemoteStream } from '@deepseek-ai/dsh-typert-protocol'
import { discoverShells, resolveShell } from './shells.ts'
import { BrowserTerminal } from './terminal.ts'
import { TerminalRetention } from './retention.ts'
import type {
  TerminalShell, TerminalInput, TerminalCreateRequest, TerminalEnvironment, TerminalFrame, TerminalRetentionFrame,
  WebTerminalId, WebTerminalInfo,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 交互式用户终端，独立于 Agent 的终端工具注册表。 */
    terminalController: TerminalController
  }
}

/** 部署限制与可选的 shell 配置。 */
export interface Config {
  /** 显式 shell 配置；省略时使用执行环境的默认 shell。 */
  readonly shell?: {
    /** 可执行文件路径或 PATH 名称，由子进程提供方验证。 */
    path: string
    /** 用户可见的配置名称。 */
    name: string
    /** 传递给交互式 shell 的参数。 */
    args: string[]
  } | undefined
  /** 为新建终端 shell 选择器检查的可执行名称或路径。 */
  readonly shellCandidates: string[]
  /** 每个 Session 可保留终端与待完成分配的最大数量。 */
  readonly maxTerminals: number
  /** 终端最大宽度（列数）。 */
  readonly maxCols: number
  /** 终端最大高度（行数）。 */
  readonly maxRows: number
  /** 为重连 client 保留的屏幕历史行数。 */
  readonly scrollback: number
  /** 每个输出跟随端与 Client 输入缓冲区中可入队 UTF-8 帧字节的最大值。 */
  readonly maxBufferedBytes: number
  /** 每条输入命令及未确认 Client 输入总量的原始 UTF-8 字节上限。 */
  readonly maxInputBytes: number
  /** 提供方进程终止宽限期（毫秒）。 */
  readonly disposeGraceMs: number
  /** 回收之前无窗口持有的连续确认空闲时长；为零则禁用回收。 */
  readonly unattendedTimeoutMs: number
  /** 无人值守 shell 与进程观察之间的间隔。 */
  readonly activityPollIntervalMs: number
  /** 重试失败的所辖终端清理前的延迟。 */
  readonly cleanupRetryMs: number
}

interface TerminalAllocation {
  info: WebTerminalInfo
  readonly cleanup: TerminalRetention
}

interface OwnedSession {
  readonly lifetime: AbortController
  readonly closedIds: Set<WebTerminalId>
  cleanup?: Promise<void>
  readonly terminals: Map<WebTerminalId, BrowserTerminal>
  readonly pending: Map<WebTerminalId, Promise<BrowserTerminal>>
  readonly allocations: Map<WebTerminalId, TerminalAllocation>
}

/** 对瞬态 Session 拥有终端进程的类型化 Remote 控制。 */
export class TerminalController extends TypertRemoteService {
  static inject = ['subprocess', 'sandboxPolicy', 'workingDirectory', 'typert']
  static Config: z<Config> = z.object({
    shell: z.union([z.object({
      path: z.string().required(), name: z.string().required(), args: z.array(z.string()).default([]),
    }), z.const(undefined)]),
    shellCandidates: z.array(z.string().min(1)).default(['zsh', 'bash', 'fish', 'pwsh', 'powershell', 'cmd']),
    maxTerminals: z.number().step(1).min(1).default(8),
    maxCols: z.number().step(1).min(2).default(500),
    maxRows: z.number().step(1).min(1).default(200),
    scrollback: z.number().step(1).min(0).default(1000),
    maxBufferedBytes: z.number().step(1).min(1024).default(2 * 1024 * 1024),
    maxInputBytes: z.number().step(1).min(1).default(64 * 1024),
    disposeGraceMs: z.number().step(1).min(1).default(1000),
    unattendedTimeoutMs: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(7_200_000),
    activityPollIntervalMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(30_000),
    cleanupRetryMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(60_000),
  })

  private readonly owners = new Map<SessionId, OwnedSession>()
  private readonly lifetime = new AbortController()

  /**
   * @param ctx - 携带类型化 Remote 与执行提供方的 Host 上下文。
   * @param config - 已验证的终端限制与可选 shell 配置。
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'terminalController', { namespace: 'terminal' })
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('Terminal controller disposed'))
      const results = await Promise.allSettled([...this.owners].map(([id, owner]) => this.disposeOwner(id, owner)))
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason as unknown)
      if (errors.length > 0) throw new AggregateError(errors, 'Browser terminal cleanup failed')
    }, 'terminal-controller.processes')
  }

  /**
   * 读取 Session 的当前目录与终端限制，不做文件系统校验或 shell 查找。
   * @param agent - 由 Gateway 提供的 Session 拥有者。
   * @param signal - 请求取消。
   * @returns 已记录的当前目录与终端限制；已保留的终端保留各自的进程目录。
   */
  @Remote
  environment(agent: Agent, signal: AbortSignal): TerminalEnvironment {
    signal.throwIfAborted()
    const { workingDirectory } = this.execution(agent)
    return { cwd: workingDirectory.get(agent.session),
      maxInputBytes: this.config.maxInputBytes, maxBufferedBytes: this.config.maxBufferedBytes, maxCols: this.config.maxCols,
      maxRows: this.config.maxRows, scrollback: this.config.scrollback }
  }

  /**
   * 发现 Session 执行环境中已安装的 shell。
   * @param agent - 由 Gateway 提供的 Session 拥有者。
   * @param signal - 请求取消。
   * @returns 已验证的配置，配置的或系统默认的排在最前。
   */
  @Remote
  shells(agent: Agent, signal: AbortSignal): Promise<TerminalShell[]> {
    signal.throwIfAborted()
    return discoverShells(this.execution(agent).subprocess, this.config.shell, this.config.shellCandidates, signal)
  }

  /**
   * 列出已保留的终端，无需解析或激活 Agent。
   * @param sessionId - 展示的 Session 标识，包括离线历史。
   * @returns 此 Host 生命周期内保留的终端。
   */
  @Remote
  list(sessionId: SessionId): WebTerminalInfo[] {
    const owner = this.owners.get(sessionId)
    if (owner === undefined) return []
    return [...owner.terminals.values(), ...owner.allocations.values()].map(terminal => terminal.info)
  }

  /**
   * 为调用方生成的标识一次性分配用户 shell，不受 Agent 沙箱或审批限制。
   * @param agent - 由 Gateway 提供的 Session 拥有者。
   * @param request - 初始尺寸与幂等标识。
   * @param signal - 分配取消；已提交的终端可在断开后存活。
   * @returns 已存在的或新提交的终端。
   */
  @Remote
  async create(agent: Agent, request: TerminalCreateRequest, signal: AbortSignal): Promise<WebTerminalInfo> {
    this.lifetime.signal.throwIfAborted()
    if (!/^[\w-]{1,128}$/u.test(request.id)) throw new Error('Invalid terminal identity')
    this.dimensions(request.cols, request.rows)
    const owner = this.owner(agent)
    owner.lifetime.signal.throwIfAborted()
    this.requireOpen(owner, request.id)
    const existing = owner.terminals.get(request.id)
    if (existing !== undefined) return existing.info
    const pending = owner.pending.get(request.id)
    if (pending !== undefined) {
      const terminal = await pending
      this.requireOpen(owner, request.id)
      return terminal.info
    }
    if (new Set([...owner.terminals.keys(), ...owner.pending.keys(), ...owner.allocations.keys()]).size >= this.config.maxTerminals) throw new RemoteError('terminal/limit-reached', 'Session terminal limit reached', { limit: this.config.maxTerminals })
    const allocation = this.spawn(agent, owner, request, AbortSignal.any([signal, this.lifetime.signal, owner.lifetime.signal]))
    owner.pending.set(request.id, allocation)
    try {
      const terminal = await allocation
      owner.terminals.set(request.id, terminal)
      owner.allocations.delete(request.id)
      terminal.monitor(this.config, () => { owner.closedIds.add(request.id) }, () => {
        owner.terminals.delete(request.id)
      }, (error) => { this.ctx.logger.error('Browser terminal cleanup failed', error) })
      this.requireOpen(owner, request.id)
      return terminal.info
    } finally {
      owner.pending.delete(request.id)
    }
  }

  /**
   * 为一个窗口保留现有终端，不激活其 Agent，也不获取输入控制。
   * @param sessionId - 拥有该终端的 Session 标识，包括未激活的已保存布局。
   * @param id - 已保留的 Host 终端标识。
   * @param signal - 物理 Remote 流取消。
   * @returns 先返回持有确认，随后是保持打开的生命周期流。
   */
  @Remote({ mode: 'stream' })
  retain(sessionId: SessionId, id: WebTerminalId, signal: AbortSignal): AsyncIterable<TerminalRetentionFrame> {
    const owner = this.owners.get(sessionId)
    const terminal = owner?.terminals.get(id)
    if (terminal === undefined || owner?.closedIds.has(id) === true || owner?.lifetime.signal.aborted === true) {
      throw new RemoteError('terminal/unavailable', 'Terminal is closing or unavailable', {})
    }
    return terminal.retain(signal)
  }

  /**
   * 将终端输入与输出连接到一条物理 Remote 流。
   * @param agent - 由 Gateway 提供的 Session 拥有者。
   * @param id - 终端标识。
   * @param signal - 连接取消；进程保持存活，输入绝不重放。
   * @returns 屏幕恢复、输出、可写状态与提供方接受的确认。
   */
  @Remote({ mode: 'stream' })
  attach(agent: Agent, id: WebTerminalId, signal: AbortSignal): RemoteStream<TerminalFrame, TerminalInput> {
    const invocation = this.ctx.invocation
    if (invocation === undefined) throw new Error('Terminal attachment requires a Remote invocation')
    return this.terminal(agent, id).attach(invocation.uplink<TerminalInput>(), this.config, signal, invocation.uplinkWindow)
  }

  /**
   * 重命名终端而不更换其 shell。
   * @param agent - 由 Gateway 提供的 Session 拥有者。
   * @param id - 终端标识。
   * @param title - 非空显示标题，最多 120 个字符。
   */
  @Remote
  rename(agent: Agent, id: WebTerminalId, title: string): void {
    if (title.trim().length === 0 || title.length > 120) throw new Error('Terminal title must contain 1–120 characters')
    this.terminal(agent, id).rename(title.trim())
  }

  /**
   * 关闭一个标识使其不能再创建，并终止其进程范围；重复关闭会成功。
   * @param agent - 由 Gateway 提供的 Session 拥有者。
   * @param id - 终端标识。
   * @returns 提供方清理成功后返回。失败时终端保留以待重试。
   */
  @Remote
  async close(agent: Agent, id: WebTerminalId): Promise<void> {
    const owner = this.owner(agent)
    owner.closedIds.add(id)
    // create 会在此等待完成之前发布分配；即使 create 随后拒绝，close 仍负责该分配。
    await owner.pending.get(id)?.catch(() => { /* 创建过程会报告其失败；close 仍负责任何已分配的进程。 */ })
    const terminal = owner.terminals.get(id)
    if (terminal !== undefined) {
      await terminal.close()
      owner.terminals.delete(id)
    } else {
      const allocation = owner.allocations.get(id)
      if (allocation === undefined) return
      await allocation.cleanup.close()
      owner.allocations.delete(id)
    }
  }

  private owner(agent: Agent): OwnedSession {
    let owner = this.owners.get(agent.id)
    if (owner === undefined) {
      owner = { terminals: new Map(), pending: new Map(), allocations: new Map(), closedIds: new Set(), lifetime: new AbortController() }
      this.owners.set(agent.id, owner)
      const owned = owner
      agent.ctx.effect(() => async () => { await this.disposeOwner(agent.id, owned) }, 'terminal-controller.owner')
    }
    return owner
  }

  private disposeOwner(id: SessionId, owner: OwnedSession): Promise<void> {
    if (owner.cleanup !== undefined) return owner.cleanup
    owner.lifetime.abort(new Error('Terminal Session owner disposed'))
    owner.cleanup = (async () => {
      await Promise.allSettled(owner.pending.values())
      const results = await Promise.allSettled([
        ...[...owner.terminals.values()].map(terminal => terminal.dispose()),
        ...[...owner.allocations.values()].map(allocation => allocation.cleanup.dispose()),
      ])
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason as unknown)
      if (errors.length > 0) throw new AggregateError(errors, 'Session terminal cleanup failed')
      owner.terminals.clear()
      owner.allocations.clear()
      this.owners.delete(id)
    })().catch((error: unknown) => { delete owner.cleanup; throw error })
    return owner.cleanup
  }

  private terminal(agent: Agent, id: WebTerminalId): BrowserTerminal {
    const terminal = this.owners.get(agent.id)?.terminals.get(id)
    if (terminal === undefined) throw new RemoteError('terminal/unavailable', 'Terminal no longer exists in this Session', {})
    this.requireOpen(this.owners.get(agent.id) as OwnedSession, id)
    return terminal
  }

  private requireOpen(owner: OwnedSession, id: WebTerminalId): void {
    if (owner.closedIds.has(id)) throw new RemoteError('terminal/unavailable', 'Terminal was closed in this Session', {})
  }

  private dimensions(cols: number, rows: number): void {
    if (!Number.isSafeInteger(cols) || cols < 2 || cols > this.config.maxCols
      || !Number.isSafeInteger(rows) || rows < 1 || rows > this.config.maxRows) throw new Error('Terminal dimensions exceed the configured limits')
  }

  private execution(agent: Agent): { subprocess: Context['subprocess']; sandboxPolicy: Context['sandboxPolicy']; workingDirectory: Context['workingDirectory'] } {
    // Agent 上下文选择执行提供方，但不注入消费方服务。
    const subprocess = agent.ctx.get('subprocess')
    const sandboxPolicy = agent.ctx.get('sandboxPolicy')
    if (subprocess === undefined || sandboxPolicy === undefined) throw new Error('The Session execution environment requires subprocess and sandbox policy providers')
    const workingDirectory = agent.ctx.get('workingDirectory')
    if (workingDirectory === undefined) throw new Error('The Session execution environment requires a working-directory provider')
    return { subprocess, sandboxPolicy, workingDirectory }
  }

  private async spawn(agent: Agent, owner: OwnedSession, request: TerminalCreateRequest, signal: AbortSignal): Promise<BrowserTerminal> {
    const { subprocess, workingDirectory } = this.execution(agent)
    const cwd = await workingDirectory.ensure(agent, signal)
    const shell = request.shellPath === undefined
      ? await resolveShell(subprocess, this.config.shell, signal)
      : (await this.shells(agent, signal)).find(candidate => candidate.path === request.shellPath)
    if (shell === undefined) throw new Error('Selected shell is not available in this execution environment')
    const handle = await subprocess.spawnTerminal({
      argv: [shell.path, ...shell.args], cwd, cols: request.cols, rows: request.rows,
      terminalType: 'xterm-256color', env: { DSH_SESSION_ID: agent.id },
      shellActivity: true,
      graceMs: this.config.disposeGraceMs, signal,
    })
    const info: WebTerminalInfo = {
      id: request.id, shell, title: shell.name, cwd,
      cols: request.cols, rows: request.rows, state: 'running', exitCode: null,
    }
    try {
      signal.throwIfAborted()
      return new BrowserTerminal(handle, info, this.config.scrollback, this.config.maxBufferedBytes)
    } catch (error) {
      const cleanup = new TerminalRetention(this.config, handle.inspectActivity.bind(handle), async () => {
        owner.closedIds.add(request.id)
        await handle.terminate()
        owner.allocations.delete(request.id)
      }, (cleanupError) => { this.ctx.logger.error('Browser terminal allocation cleanup failed', cleanupError) })
      owner.allocations.set(request.id, {
        info: { ...info, state: 'failed', error: error instanceof Error ? error.message : String(error) }, cleanup,
      })
      try {
        await cleanup.close()
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Terminal allocation cleanup failed')
      }
      throw error
    }
  }
}

/** 浏览器终端服务插件。 */
export default TerminalController
