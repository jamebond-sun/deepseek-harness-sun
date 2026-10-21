/** 持有单个版本匹配的 POSIX helper 及其独立转发流的 OpenSSH 连接。 */

import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createConnection, type Socket } from 'node:net'
import { Context, Service } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { SshRpcPeer, SSH_PROTOCOL_VERSION } from './protocol.ts'
import { helloSchema, type SshStreamEndpoint } from './schemas.ts'
import { authenticateStream } from './stream-security.ts'

type Hello = z.infer<typeof helloSchema>

/** 已安装的 helper 调用方式；脚本部署还可以额外安装一份 PTC 引导脚本。 */
export type HelperLaunch = {
  /** 使用单独安装的 Node 可执行文件运行已安装脚本。 */
  kind: 'node-script'
  /** 远端 Node 可执行文件的绝对路径。 */
  node: string
  /** 远端 PTC 引导脚本的绝对路径；必须与 bootstrapHash 同时给出。 */
  bootstrapPath?: string
  /** bootstrapPath 的小写 SHA-256 摘要；必须与该文件路径同时给出。 */
  bootstrapHash?: string
} | {
  /** 运行内嵌 Node 与 PTC worker 的 helper 可执行文件。 */
  kind: 'executable'
}

/** 由部署方持有的 SSH 身份与已安装 helper；任何模型参数都不能选择这些取值。 */
export interface Config {
  /** OpenSSH 主机别名，沿用其已有的 user、key 与 known-host 配置。 */
  host: string
  /** 显式脚本调用或自包含可执行文件调用。 */
  launch: HelperLaunch
  /** 已安装、已打包的 helper 入口的绝对路径。 */
  helper: string
  /** 该打包 helper 的 SHA-256 摘要；不一致时拒绝连接。 */
  helperHash: string
  /** 远端默认工作区的绝对路径。 */
  workspace: string
  /** 连接与管理类请求的截止时间，最大为 2,147,483,647 毫秒。 */
  requestTimeoutMs?: number
  /** 单次 helper 请求或响应的最大 JSON 载荷字节数。 */
  maxFrameBytes?: number
  /** 普通请求的最大数量；心跳与有界资源清理占用预留额度。 */
  maxPending?: number
  /** 远端 helper 租约；心跳丢失即启动远端托管清理。 */
  leaseMs?: number
}

declare module '@deepseek-ai/cordis' {
  interface Context { ssh: SshConnection }
}

/** 一个不会重连的 SSH 会话；连接失效后所有进行中的操作均作废。 */
export class SshConnection extends Service {
  static Config: schema<Config> = schema.object({
    host: schema.string().required(), helper: schema.string().required(),
    launch: schema.union([
      schema.object({ kind: schema.const('node-script').required(), node: schema.string().required(), bootstrapPath: schema.string(), bootstrapHash: schema.string() }),
      schema.object({ kind: schema.const('executable').required() }),
    ]).required(),
    helperHash: schema.string().required(), workspace: schema.string().required(),
    requestTimeoutMs: schema.number().default(30_000), maxFrameBytes: schema.number().default(64 * 1024 * 1024),
    maxPending: schema.number().default(128), leaseMs: schema.number().default(30_000),
  })

  /** 已完成校验的远端 helper 信息；调用方在启动前必须先等待它就绪。 */
  readonly ready: Promise<Hello>
  private rpc: SshRpcPeer | undefined
  private child: ChildProcessWithoutNullStreams | undefined
  private childClosed: Promise<void> | undefined
  private directory: string | undefined
  private heartbeat: NodeJS.Timeout | undefined
  private closed = false
  private readonly lifetime = new AbortController()
  private readonly operations = new Set<Promise<unknown>>()
  private disposal: Promise<void> | undefined
  private failure: Error | undefined
  private sockets = new Set<Socket>()
  private nextSocket = 0
  private readonly config: Required<Config>
  private remote: Hello | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx, 'ssh')
    if (process.platform !== 'linux' && process.platform !== 'darwin') throw new Error('SSH runtime requires a POSIX client')
    this.config = z.object({
      host: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/),
      launch: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('node-script'), node: z.string().startsWith('/'),
          bootstrapPath: z.string().startsWith('/').optional(), bootstrapHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
        }).strict().refine(value => (value.bootstrapPath === undefined) === (value.bootstrapHash === undefined), 'bootstrapPath and bootstrapHash must be paired'),
        z.object({ kind: z.literal('executable') }).strict(),
      ]),
      helper: z.string().startsWith('/'), helperHash: z.string().regex(/^[0-9a-f]{64}$/),
      workspace: z.string().startsWith('/'), requestTimeoutMs: z.number().int().positive().max(2_147_483_647),
      maxFrameBytes: z.number().int().positive().max(64 * 1024 * 1024), maxPending: z.number().int().positive().max(128),
      leaseMs: z.number().int().min(3000).max(600_000),
    }).strict().parse(config) as Required<Config>
    this.ready = this.start()
    // 启动过程依赖 Node I/O、本地校验，以及以 Error 形式返回的 RPC 失败。
    void this.ready.catch((error: unknown) => { this.fail(error as Error) })
    ctx.effect(() => () => this.dispose())
  }

  /** 在远端身份与 helper 摘要校验完成之前，插件保持未就绪状态。 */
  async [Service.init](): Promise<void> { await this.ready }

  /** 已完成校验的远端 PTC 启动配置；脚本部署方式要求 bootstrap 也通过校验。 */
  get ptcLaunch(): { kind: 'embedded'; executable: string } | { kind: 'node-script'; executable: string; bootstrapPath: string } {
    if (this.remote === undefined) throw new Error('SSH helper is not ready')
    const launch = this.config.launch
    switch (launch.kind) {
      case 'executable': return { kind: 'embedded', executable: this.remote.executable }
      case 'node-script':
        if (launch.bootstrapPath === undefined) throw new Error('SSH PTC requires a verified bootstrapPath and bootstrapHash')
        return { kind: 'node-script', executable: this.remote.executable, bootstrapPath: launch.bootstrapPath }
      /* v8 ignore next -- 配置解析只允许这两种启动方式。 */
      default: return assertNever(launch)
    }
  }

  /**
   * 发送一次 helper 操作；取消绝不会重放语义不明的远端变更。
   * @param method - 私有 helper 操作名。
   * @param params - 由 helper 校验的 JSON 请求字段。
   * @param result - 返回给调用方可见数据之前的响应校验器。
   * @param signal - 取消信号，它不会撤销已完成的远端副作用。
   * @param wait - 允许一次进程观察超出管理类请求的截止时间。
   * @returns 校验通过的远端结果。
   */
  async request<T>(method: string, params: unknown, result: z.ZodType<T>, signal?: AbortSignal, wait: boolean = false): Promise<T> {
    this.assertOpen()
    await this.ready
    this.assertOpen()
    const bounded = wait ? signal : signal === undefined
      ? AbortSignal.timeout(this.config.requestTimeoutMs)
      : AbortSignal.any([signal, AbortSignal.timeout(this.config.requestTimeoutMs)])
    return (this.rpc as SshRpcPeer).request(method, params, result, bounded)
  }

  /**
   * 通过一条独立的 SSH 通道转发一条已认证的流。
   * @param endpoint - 本连接所属 helper 下发的私有坐标。
   * @param signal - 用于取消通道分配以及由此得到的 socket。
   * @returns 处于暂停状态的 socket；恢复读取前需先挂接消费方。
   */
  async connectStream(endpoint: SshStreamEndpoint, signal?: AbortSignal): Promise<Socket> {
    return this.track(this.establishStream(endpoint, signal))
  }

  private async establishStream(endpoint: SshStreamEndpoint, signal?: AbortSignal): Promise<Socket> {
    const hello = await this.ready
    this.assertOpen()
    signal = signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal])
    const remote = endpoint.path
    if (!remote.startsWith(`${hello.root}/`) || /[:\r\n\0]/u.test(remote)) throw new Error('SSH helper returned an invalid stream path')
    signal.throwIfAborted()
    const local = join(this.directory as string, `s${this.nextSocket++}`)
    const forward = `${local}:${remote}`
    const cancelForward = async (): Promise<void> => {
      // 已失效的 master 已经移除了自己的转发监听器。
      if (!this.closed) await this.controlCommand(['-O', 'cancel', '-L', forward]).catch(() => {})
      await rm(local, { force: true })
    }
    try {
      await this.controlCommand(['-O', 'forward', '-o', 'ExitOnForwardFailure=yes', '-L', forward], signal)
    } catch (error) { await cancelForward(); throw error }
    signal.throwIfAborted()
    const socket = createConnection({ path: local, allowHalfOpen: true })
    this.sockets.add(socket)
    socket.once('close', () => {
      this.sockets.delete(socket)
      void this.track(cancelForward()).catch(() => {})
    })
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        signal.removeEventListener('abort', aborted)
        socket.off('connect', connected)
        socket.off('error', failed)
        socket.off('close', closed)
      }
      const connected = (): void => { cleanup(); resolve() }
      const failed = (error: Error): void => { cleanup(); reject(error) }
      const closed = (): void => { failed(new Error('SSH connection closed before stream establishment')) }
      const aborted = (): void => { socket.destroy(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason))) }
      socket.once('connect', connected)
      socket.once('error', failed)
      socket.once('close', closed)
      signal.addEventListener('abort', aborted, { once: true })
    })
    const authenticated = await authenticateStream(socket, endpoint.capability, this.config.requestTimeoutMs, signal)
    this.sockets.add(authenticated)
    authenticated.on('error', () => { authenticated.destroy() })
    authenticated.once('close', () => { this.sockets.delete(authenticated) })
    return authenticated
  }

  /** 在释放 SSH master（若仍可连通）之前，先拆除 helper 远端的托管进程组。 */
  dispose(): Promise<void> {
    this.disposal ??= this.disposeOnce()
    return this.disposal
  }

  private async disposeOnce(): Promise<void> {
    this.closed = true
    this.lifetime.abort(new Error('SSH connection is closing'))
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    try {
      await this.ready.catch(() => {})
      if (this.failure === undefined) await this.rpc?.request('close', {}, z.null(), AbortSignal.timeout(this.config.requestTimeoutMs))
    } finally {
      this.rpc?.close()
      // TLS 封装层会在其底层 socket 关闭之前先释放读端。
      const socketClosures = [...this.sockets].reverse().map(socket => new Promise<void>((resolve) => {
        if (socket.closed) resolve()
        else { socket.once('close', () => { resolve() }); socket.destroy() }
      }))
      this.child?.kill('SIGTERM')
      const force = setTimeout(() => { this.child?.kill('SIGKILL') }, this.config.requestTimeoutMs)
      try { await this.childClosed } finally { clearTimeout(force) }
      await Promise.all(socketClosures)
      while (this.operations.size > 0) await Promise.allSettled([...this.operations])
      if (this.directory !== undefined) await rm(this.directory, { recursive: true, force: true })
    }
  }

  private controlPath(): string { return join(this.directory as string, 'master') }

  private assertOpen(): void {
    if (this.closed) throw new Error('SSH connection is closed')
    if (this.failure !== undefined) throw this.failure
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation)
    void operation.finally(() => { this.operations.delete(operation) }).catch(() => {})
    return operation
  }

  private async controlCommand(args: string[], signal?: AbortSignal): Promise<void> {
    const signals = [this.lifetime.signal, AbortSignal.timeout(this.config.requestTimeoutMs)]
    if (signal !== undefined) signals.push(signal)
    const combined = AbortSignal.any(signals)
    combined.throwIfAborted()
    const result = Promise.withResolvers<undefined>()
    const command = execFile('ssh', ['-S', this.controlPath(), ...args, this.config.host], {
      signal: combined, maxBuffer: 64 * 1024,
    }, (error) => { if (error === null) result.resolve(undefined); else result.reject(error) })
    const closed = new Promise<void>((resolve) => { command.once('close', () => { resolve() }) })
    let force: NodeJS.Timeout | undefined
    const escalate = (): void => {
      force = setTimeout(() => { command.kill('SIGKILL') }, this.config.requestTimeoutMs)
      force.unref()
    }
    combined.addEventListener('abort', escalate, { once: true })
    try { await result.promise }
    finally {
      await closed
      combined.removeEventListener('abort', escalate)
      if (force !== undefined) clearTimeout(force)
    }
  }

  private fail(error: Error): void {
    if (this.failure !== undefined) return
    this.failure = error
    this.lifetime.abort(error)
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    this.rpc?.close(error)
    for (const socket of [...this.sockets].reverse()) socket.destroy(error)
    this.child?.kill('SIGTERM')
  }

  private async start(): Promise<Hello> {
    this.directory = await mkdtemp('/tmp/dsh-ssh-')
    if (this.closed) throw new Error('SSH connection closed before startup')
    const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
    const launch = this.config.launch
    let command: string
    let bootstrapPath: string | undefined
    let bootstrapHash: string | undefined
    switch (launch.kind) {
      case 'node-script':
        command = [launch.node, '--disable-sigusr1', this.config.helper].map(quote).join(' ')
        bootstrapPath = launch.bootstrapPath
        bootstrapHash = launch.bootstrapHash
        break
      case 'executable':
        command = `NODE_OPTIONS='--disable-sigusr1' ${quote(this.config.helper)}`
        break
      /* v8 ignore next -- 配置解析只允许这两种启动方式。 */
      default: return assertNever(launch)
    }
    const child = spawn('ssh', [
      '-T', '-M', '-S', this.controlPath(), '-o', 'ControlPersist=no', '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=yes', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes',
      '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3', this.config.host, command,
    ], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    this.childClosed = new Promise((resolve) => { child.once('close', () => { resolve() }) })
    child.stderr.resume() // SSH 诊断信息可能包含配置中的路径；操作错误仍保持结构化。
    child.once('error', (error) => { this.fail(error) })
    child.once('close', () => { this.fail(new Error('SSH helper disconnected; remote outcomes and cleanup are unknown')) })
    const rpc = new SshRpcPeer(child.stdout, child.stdin, this.config.maxFrameBytes, this.config.maxPending)
    this.rpc = rpc
    rpc.once('closed', (error) => { this.fail(error as Error) })
    const hello = await rpc.request('hello', {
      protocol: SSH_PROTOCOL_VERSION, workspace: this.config.workspace, leaseMs: this.config.leaseMs,
      ...(bootstrapPath === undefined ? {} : { bootstrapPath }),
    }, helloSchema, AbortSignal.timeout(this.config.requestTimeoutMs))
    if (hello.hash !== this.config.helperHash) throw new Error('SSH helper digest differs from the configured artifact')
    if (hello.kind !== launch.kind) throw new Error('SSH helper runtime differs from the configured launch kind')
    if (hello.bootstrapHash !== bootstrapHash) throw new Error('SSH PTC bootstrap digest differs from the configured artifact')
    this.remote = hello
    let heartbeatPending: Promise<unknown> | undefined
    this.heartbeat = setInterval(() => {
      heartbeatPending ??= rpc.request('heartbeat', {}, z.null(), AbortSignal.timeout(this.config.leaseMs / 2))
        .catch((error: unknown) => { this.fail(error as Error) })
        .finally(() => { heartbeatPending = undefined })
    }, Math.floor(this.config.leaseMs / 3))
    this.heartbeat.unref()
    return hello
  }
}

export default SshConnection
