/**
 * @deepseek-ai/dsh-host-webserver —— 基于 node:http 的路由注册——当 `tls` 指定了证书与私钥
 * 时改用 node:https——并带有可选的 gzip、index 注入以及一个回退座位。它不了解任何框架概念，
 * 也不服务任何文件；dist 服务由组合应用自己负责。Electron 改用 file:// 加 IPC，而本包从不
 * 打印 URL。路由处理器保留对响应的直接所有权。
 */

import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse, Server } from 'node:http'
import { createServer as createSecureServer } from 'node:https'
import { isIP, type AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import type { Duplex } from 'node:stream'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import compressionMiddleware from 'compression'
import ipaddr from 'ipaddr.js'
import Negotiator from 'negotiator'
import { renderIndexInjections, type IndexInjection } from './injections.ts'

export { renderIndexInjections } from './injections.ts'
export type { IndexInjection, IndexInjectionPlacement } from './injections.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: WebServer
  }
  interface Events {
    /**
     * 收集结构化 index 注入表。每次 index 渲染以及每次 worker 启动载荷请求时发出；监听者
     * 推入各自的当前行，因此行的数据是在发出时新鲜读取的。
     * @param table - 可变的行表；监听者按激活顺序追加。
     * @mode emit
     */
    'webserver/index-inject'(table: IndexInjection[]): void
  }
}

/** 路由匹配类型：'exact' 逐字匹配 pathname；'prefix' p 匹配 p 以及 p/<任意内容>。 */
export type WebRouteKind = 'exact' | 'prefix'

/** 一条具名路由注册。 */
export interface WebRoute {
  kind: WebRouteKind
  /** 绝对 pathname，不带结尾斜杠。 */
  path: string
  /** 拥有完整的响应生命周期（可以保持响应打开，例如 SSE）。 */
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** 一条精确路径的 HTTP upgrade 注册。 */
export interface WebUpgradeRoute {
  /** 绝对 pathname，不带结尾斜杠。 */
  path: string
  /** 拥有协议协商以及分发之后已升级的 socket。 */
  handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>
}

/**
 * HTTPS 监听器所用的 TLS 材料：一个证书链文件以及与它配对的私钥文件。两者都是 PEM 文本，
 * 且都相对进程工作目录解析。
 */
export interface TlsConfig {
  /** 证书链文件，叶证书在前，PEM 格式，无口令。 */
  certFile: string
  /** 证书链叶证书对应的私钥文件；未加密的 PEM。 */
  keyFile: string
}

/** Web 服务器的监听、TLS 与响应压缩配置。 */
export interface Config {
  /**
   * 监听地址：某个本地接口的具体 IPv4 或 IPv6 字面量，例如来自 `hostname -i` 的容器自身
   * Pod 地址。回环字面量（127/8 内的任意地址、`::1`，或它们任一者的映射形式）会把服务器
   * 留在本机；其他任何字面量则在未设置 `tls` 的情况下以普通 HTTP 服务该地址所属的网络。
   * 未指定地址——IPv4 any、IPv6 any，以及 IPv4 any 的 IPv4 映射形式——在加载时被拒绝：它会
   * 一次性把该端口暴露在每一个接口上。
   */
  host: string
  /** 监听端口；0 表示请求由操作系统分配端口。 */
  port: number
  /**
   * 用此证书与私钥以 HTTPS 提供服务，而不是普通 HTTP。两个文件都在监听器绑定之前各读取
   * 一次：文件不可读或为空、PEM 无效、或私钥与证书不匹配，都会让初始化被拒绝，而不是回退
   * 到 HTTP。这些材料永不重读，因此更换证书需要一次重载。省略或为 null 时以普通 HTTP 监听。
   */
  tls?: TlsConfig
  /** 面向 socket 支撑的 HTTP 请求的响应压缩。 @default 'none' */
  compression?: 'none' | 'gzip'
  /** gzip 的 DEFLATE 级别，0 到 9。 @default 1 */
  compressionLevel?: number
  /** 有资格使用 gzip 的最小已知响应长度；长度未知的流同样有资格。 @default 1024 */
  compressionThresholdBytes?: number
}

const DEFAULT_COMPRESSION = 'none' as const
const DEFAULT_COMPRESSION_LEVEL = 1
const DEFAULT_COMPRESSION_THRESHOLD_BYTES = 1024

interface ResolvedConfig extends Config {
  compression: 'none' | 'gzip'
  compressionLevel: number
  compressionThresholdBytes: number
}

type NodeMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
) => void

/** IPv6 混合记法中的点分四段尾部：`::0.0.0.1`、`1:2:3:4:5:6:127.0.0.1`。 */
const IPV4_TAIL = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/**
 * 把点分四段尾部改写为持有相同字节的两个十六进制组。ipaddr.js 2.5.0 会把全零前缀加一个
 * 四段（`::0.0.0.1`）读作 IPv4 映射形式 `::ffff:0:1`，而 `getaddrinfo`——进而 `listen`——
 * 把该尾部读作地址自身的低 32 位，这使得 `::0.0.0.1` 成为回环字面量 `::1`。解析改写后的
 * 文本，可以让解析出的值与 socket 实际绑定的值一致。
 */
function withHexTail(host: string): string {
  const tail = IPV4_TAIL.exec(host)
  if (tail === null) return host
  const [, head = '', a = '', b = '', c = '', d = ''] = tail
  const high = ((Number(a) << 8) | Number(b)).toString(16)
  const low = ((Number(c) << 8) | Number(d)).toString(16)
  return `${head}${high}:${low}`
}

/**
 * 解析一个具体的 IP 字面量，并把 IPv4 映射的 IPv6 归一化为 IPv4。`node:net` 决定了一个值
 * 必须长成什么样才能被 `listen` 接受，而结尾的 `%zone`（本地接口选择符，绝不是地址文本）
 * 会在解析之前被去掉；交给 `listen` 的值则保留其 zone。
 */
function parseIpLiteral(host: string): ipaddr.IPv4 | ipaddr.IPv6 | undefined {
  if (isIP(host) === 0) return undefined
  const zoneAt = host.indexOf('%')
  const parsed = ipaddr.parse(withHexTail(zoneAt === -1 ? host : host.slice(0, zoneAt)))
  return parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress() ? parsed.toIPv4Address() : parsed
}

/** 对不是具体 IP 字面量的绑定地址的拒绝错误。 */
function notLiteralError(value: string): Error {
  return new Error(`webserver: host ${JSON.stringify(value)} is not a concrete IPv4 or IPv6 address literal`)
}

/** ipaddr 的 IPv4 未指定范围覆盖整个 0/8；只有全零地址才会绑定每一个接口。 */
function isWildcardAddress(parsed: ipaddr.IPv4 | ipaddr.IPv6): boolean {
  const parts = parsed instanceof ipaddr.IPv4 ? parsed.octets : parsed.parts
  return parts.every(part => part === 0)
}

/**
 * 某个绑定地址是否一次性请求了所有接口。
 * @param host - 来自配置的绑定地址。
 * @returns 对 IPv4 any、IPv6 any，以及 IPv4 any 的 IPv4 映射形式为 true。
 */
export function isWildcardHost(host: string): boolean {
  const parsed = parseIpLiteral(host)
  return parsed !== undefined && isWildcardAddress(parsed)
}

/**
 * 某个绑定地址是否指代本地回环来源。
 * @param host - 来自配置的绑定地址。
 * @returns 对 127/8 内的任意地址、`::1` 及其 IPv4 映射形式为 true。
 */
export function isLoopbackHost(host: string): boolean {
  const parsed = parseIpLiteral(host)
  return parsed !== undefined && parsed.range() === 'loopback'
}

/**
 * 某个绑定字面量所指代地址的规范文本：IPv4 与 IPv4 映射字面量读作点分四段，其他每个字面量
 * 读作其压缩后的 IPv6 值。该文本命名的是 `listen` 所绑定的地址，因此 `::0.0.0.1` 读作
 * `::1`。`%zone` 选择的是一个接口，绝不出现在文本中。
 * @param host - 具体的 IPv4 或 IPv6 字面量，带或不带 zone。
 * @returns 地址文本，可直接作为 URL 主机。
 * @throws 当 `host` 不是具体的 IPv4 或 IPv6 地址字面量时。
 */
export function normalizeBindAddress(host: string): string {
  const parsed = parseIpLiteral(host)
  if (parsed === undefined) throw notLiteralError(host)
  return parsed.toString()
}

/**
 * 绑定地址的 URL 主机形式。回环地址使用其规范文本，使浏览器把它们当作本地的、值得信任的
 * 来源：像 `::ffff:127.0.0.1` 这样的映射字面量读作 `127.0.0.1`，而 `::0.0.0.1` 读作 `::1`。
 * 冗余的回环 zone 会被丢弃；其他地址保留其文本，且 IPv6 文本会加方括号。
 * @param host - 具体的 IPv4 或 IPv6 绑定字面量。
 * @returns URL 主机；当非回环接口的 zone id 使该地址无法在 URL 中表达时为 `undefined`。
 */
export function bindUrlHost(host: string): string | undefined {
  const zoneAt = host.indexOf('%')
  const bare = zoneAt === -1 ? host : host.slice(0, zoneAt)
  if (!isLoopbackHost(bare) && zoneAt !== -1) return undefined
  const text = isLoopbackHost(bare) ? normalizeBindAddress(bare) : host
  return isIP(text) === 6 ? `[${text}]` : text
}

function createGzipMiddleware(config: ResolvedConfig): NodeMiddleware {
  // `compression` 的类型是为 Express 写的，但它在运行时只用到此处提供的 node:http 请求与
  // 响应成员。
  const middleware = compressionMiddleware({
    level: config.compressionLevel,
    threshold: config.compressionThresholdBytes,
    filter(request, response) {
      if (response.getHeader('content-range') !== undefined) return false
      const contentType = response.getHeader('content-type')
      if (typeof contentType === 'string' && contentType.toLowerCase().startsWith('text/event-stream')) return false
      if (typeof contentType === 'string' && /^multipart\/form-data(?:;|$)/i.test(contentType)) return true
      return compressionMiddleware.filter(request, response)
    },
  }) as NodeMiddleware

  return (req, res, next) => {
    // Web Worker 隧道没有 socket，且传输的是身份字节。
    if ((res as { socket?: unknown }).socket === undefined) {
      next()
      return
    }
    const encoding = new Negotiator(req).encoding(['gzip', 'identity'])
    const gzipRequest = Object.create(req) as IncomingMessage
    Object.defineProperty(gzipRequest, 'headers', {
      value: { ...req.headers, 'accept-encoding': encoding === 'gzip' ? 'gzip' : 'identity' },
    })
    middleware(gzipRequest, res, next)
  }
}

/**
 * 为激活读取一个 TLS 材料文件。错误信息会指名字段与解析后的路径；空内容在此被拒绝，因为
 * node:tls 会静默接受它，那将绑定出一个永远无法完成握手的监听器。
 * @param field - 正在读取的配置字段，用于诊断信息。
 * @param path - 要读取的绝对路径。
 * @returns 文件的文本。
 */
async function readTlsFile(field: 'certFile' | 'keyFile', path: string): Promise<string> {
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch (error) {
    throw new Error(`webserver: cannot read tls.${field} ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (content.trim().length === 0) {
    throw new Error(`webserver: tls.${field} ${path} is empty`)
  }
  return content
}

/**
 * 浏览器 HTTP 载体服务。激活时先加载任何已配置的 TLS 材料，然后立即监听；材料或监听失败
 * 会让初始化被拒绝，并由启动流程报告该失败的 fiber。路由注册顺序不影响请求，因为已配置的
 * 具名路由必须各不相同；而回退处理器在启动期间对尚未被认领的任何请求先以 404 应答，直到
 * 其所有者注册为止。
 */
export class WebServer extends Service {
  static Config: z<Config> = z.object({
    host: z.transform(z.string(), (value) => {
      const parsed = parseIpLiteral(value)
      if (parsed === undefined) throw notLiteralError(value)
      if (isWildcardAddress(parsed)) {
        throw new Error(`webserver: host ${JSON.stringify(value)} is an unspecified (wildcard) address, which is not supported: binding every interface would expose remote code execution to the network; bind one concrete IPv4 or IPv6 address of a local interface instead`)
      }
      return value
    }).required(),
    port: z.natural().max(65535).required(),
    // 省略的对象不能变成 `{}` 而让那对必填字段失败。
    tls: z.object({
      certFile: z.string().required(),
      keyFile: z.string().required(),
    }).default(undefined as never),
    compression: z.union([z.const('none'), z.const('gzip')]).default(DEFAULT_COMPRESSION),
    compressionLevel: z.number().step(1).min(0).max(9).default(DEFAULT_COMPRESSION_LEVEL),
    compressionThresholdBytes: z.natural().default(DEFAULT_COMPRESSION_THRESHOLD_BYTES),
  })

  private readonly exact = new Map<string, WebRoute>()
  private readonly prefixes = new Map<string, WebRoute>()
  private readonly upgrades = new Map<string, WebUpgradeRoute>()
  private readonly upgradedSockets = new Set<Duplex>()
  /**
   * TLS 监听器的原始连接，一直持有到它们关闭。一条 TLS 连接只有在其握手完成之后才会进入
   * closeAllConnections() 的表，因此一个仍在握手中的 socket——或者对端从不发送 ClientHello
   * 的 socket——否则会让 `close()` 一直等到 TLS 握手超时。普通监听器下该集合为空，它的连接
   * 由 closeAllConnections() 覆盖到。
   */
  private readonly tlsConnections = new Set<Duplex>()
  private readonly indexTaps: ((html: string) => string)[] = []
  private fallback: WebRoute['handler'] | undefined
  private server!: Server
  private listenedPort: number | undefined
  private readonly gzip: NodeMiddleware | undefined
  private readonly tlsConfig: TlsConfig | undefined

  constructor(ctx: Context, private config: Config) {
    super(ctx, 'webServer')
    const resolved = config as ResolvedConfig
    // Schemastery 会把显式的 `tls: null` 透传；只有真实的对象才会启用 TLS。
    this.tlsConfig = resolved.tls ?? undefined
    this.gzip = resolved.compression === 'gzip' ? createGzipMiddleware(resolved) : undefined
  }

  /** 监听端口（config.port 为 0 时是操作系统分配的值），或 `listen` 绑定之前的 `undefined`。 */
  get port(): number | undefined {
    return this.listenedPort
  }

  /** 已配置的绑定地址（某个具体的本地接口）。 */
  get host(): Config['host'] {
    return this.config.host
  }

  /**
   * 监听器所使用的协议：配置了 `tls` 时为 `'https:'`。该值只跟随配置，绝不来自 socket 或
   * 请求头，因此消费方可以在任何请求之前读取它，且没有代理能够改变它。
   */
  get protocol(): 'http:' | 'https:' {
    return this.tlsConfig === undefined ? 'http:' : 'https:'
  }

  /**
   * 本地客户端用来触达已绑定监听器的根 URL：协议、绑定地址的 {@link bindUrlHost} 形式，
   * 以及监听端口。
   * @returns origin，例如 `http://127.0.0.1:3080`。
   * @throws 在 `listen` 绑定端口之前，或当绑定地址没有 URL 形式时。
   */
  getOrigin(): string {
    const host = bindUrlHost(this.config.host)
    if (host === undefined) {
      throw new Error(`webserver: bind address ${JSON.stringify(this.config.host)} carries an interface zone id, which no URL can express`)
    }
    if (this.listenedPort === undefined) throw new Error('webserver: origin read before the listener bound a port')
    return `${this.protocol}//${host}:${String(this.listenedPort)}`
  }

  /**
   * 注册一条具名路由。重复的 (kind, path) 会抛出错误——路由模式是组合层面的契约，因此冲突
   * 就是配置错误。
   * @param route - 类型、路径与拥有该路由的处理器。
   * @returns 移除该路由的 disposer。
   */
  register(route: WebRoute): () => void {
    const table = route.kind === 'exact' ? this.exact : this.prefixes
    if (table.has(route.path)) {
      throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
    }
    table.set(route.path, route)
    return () => { table.delete(route.path) }
  }

  /**
   * 注册一条精确路径的 HTTP upgrade 路由。重复路径会抛出错误，因为一个 socket 只能有一个
   * 协议所有者。
   * @param route - 拥有协商与 socket 使用的 pathname 与处理器。
   * @returns 移除该路由的 disposer。
   */
  registerUpgrade(route: WebUpgradeRoute): () => void {
    if (this.upgrades.has(route.path)) {
      throw new Error(`webserver: duplicate upgrade route "${route.path}"`)
    }
    this.upgrades.set(route.path, route)
    return () => { this.upgrades.delete(route.path) }
  }

  /**
   * 认领回退座位：即应答所有没有具名路由匹配的请求的处理器（在发布的 Web 组合中就是 SPA
   * dist 服务器）。只允许一个所有者——第二次注册会抛出错误，因为两个回退无法组合。
   * @param handler - 拥有未匹配请求的完整响应生命周期。
   * @returns 释放该座位的 disposer。
   */
  registerFallback(handler: WebRoute['handler']): () => void {
    if (this.fallback !== undefined) {
      throw new Error('webserver: fallback already registered')
    }
    this.fallback = handler
    return () => { this.fallback = undefined }
  }

  /**
   * 注册一个原始 HTML index 变换，这是供任何 {@link IndexInjection} 行都无法表达的标记使用
   * 的逃生口：{@link renderIndex} 会在渲染完结构化行之后按注册顺序应用这些钩子。
   * @param transform - 纯 html 到 html 的函数。
   * @returns 移除该变换的 disposer。
   */
  tapIndex(transform: (html: string) => string): () => void {
    this.indexTaps.push(transform)
    return () => {
      const at = this.indexTaps.indexOf(transform)
      if (at !== -1) this.indexTaps.splice(at, 1)
    }
  }

  /** 开始监听；socket 绑定完成后 resolve（被拒绝即意味着 FAILED fiber）。 */
  async [Service.init](): Promise<void> {
    const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      /* v8 ignore next -- `?? '/'` 分支：node:http 总是为服务端请求设置 url；
      该字段仅在客户端侧的 IncomingMessage 类型上才是可选的 */
      const rawPath = new URL(req.url ?? '/', 'http://x').pathname
      const route = this.match(rawPath)
      if (route !== undefined) {
        await route.handler(req, res)
        return
      }
      const fallback = this.fallback
      if (fallback === undefined) {
        res.writeHead(404)
        res.end()
        return
      }
      await fallback(req, res)
    }
    // 最后一道守卫：否则 handle() 被拒绝会成为一个未处理的拒绝，因一个畸形请求（坏的
    // %-转义、客户端在请求体中途断开）就杀掉进程。按请求的失败会记录日志并应答 400——
    // 绝不是进程退出。
    const listener = (req: IncomingMessage, res: ServerResponse): void => {
      const next = (): void => {
        void handle(req, res).catch((err: unknown) => {
          this.ctx.logger.warn(err instanceof Error ? err : new Error(String(err)))
          if (res.headersSent) {
            res.destroy()
            return
          }
          res.writeHead(400)
          res.end()
        })
      }
      if (this.gzip === undefined) next()
      else this.gzip(req, res, next)
    }
    const tls = this.tlsConfig
    // 销毁时等待进行中的获取，并关闭它所产生的任何监听器。
    await this.ctx.effect(async () => {
      if (tls === undefined) {
        this.server = createServer(listener)
      } else {
        const certFile = resolve(tls.certFile)
        const keyFile = resolve(tls.keyFile)
        const [cert, key] = await Promise.all([
          readTlsFile('certFile', certFile),
          readTlsFile('keyFile', keyFile),
        ])
        try {
          this.server = createSecureServer({ cert, key }, listener)
        } catch (error) {
          throw new Error(`webserver: tls.certFile ${certFile} and tls.keyFile ${keyFile} are not a usable certificate and key pair: ${error instanceof Error ? error.message : String(error)}`)
        }
        this.server.on('connection', (socket) => {
          this.tlsConnections.add(socket)
          socket.once('close', () => { this.tlsConnections.delete(socket) })
        })
      }
      this.server.on('upgrade', (req, socket, head) => {
        const onError = (error: Error): void => {
          this.ctx.logger.warn(error)
          socket.destroy()
        }
        socket.on('error', onError)
        socket.once('close', () => {
          socket.off('error', onError)
          this.upgradedSockets.delete(socket)
        })
        let route: WebUpgradeRoute | undefined
        try {
          /* v8 ignore next -- node:http 总是为服务端请求设置 url。 */
          route = this.upgrades.get(new URL(req.url ?? '/', 'http://x').pathname)
        } catch (error) {
          this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
          socket.destroy()
          return
        }
        if (route === undefined) {
          socket.destroy()
          return
        }
        this.upgradedSockets.add(socket)
        try {
          Promise.resolve(route.handler(req, socket, head)).catch((error: unknown) => {
            this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
            socket.destroy()
          })
        } catch (error) {
          this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
          socket.destroy()
        }
      })

      await new Promise<void>((resolve, reject) => {
        this.server.once('error', reject)
        this.server.listen(this.config.port, this.config.host, () => {
          this.server.off('error', reject)
          this.server.on('error', (err) => { this.ctx.logger.error(err) })
          this.listenedPort = (this.server.address() as AddressInfo).port
          resolve()
        })
      })

      // Node 不会把已升级的 socket 计入 closeAllConnections()，而一条 TLS 连接只有在其握手
      // 之后才会进入那张表。本服务连同其他连接一起拥有这两类连接，因此会显式地跟踪并销毁
      // 它们。
      return async () => {
        const serverClosed = new Promise<void>((resolve) => {
          this.server.close(() => { resolve() })
        })
        this.server.closeAllConnections()
        const socketsClosed = [...this.upgradedSockets, ...this.tlsConnections].map(socket => new Promise<void>((resolve) => {
          socket.once('close', () => { resolve() })
          socket.destroy()
        }))
        await Promise.all([serverClosed, ...socketsClosed])
      }
    }, 'webServer.listen')
  }

  /** 在精确表未命中之后，对前缀表采用最长前缀胜出。 */
  private match(pathname: string): WebRoute | undefined {
    const exact = this.exact.get(pathname)
    if (exact !== undefined) return exact
    let best: WebRoute | undefined
    for (const [prefix, route] of this.prefixes) {
      if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue
      if (best === undefined || prefix.length > best.path.length) best = route
    }
    return best
  }

  /**
   * 让一个 index.html 消息体按注册顺序经过已注册的钩子——由回退所有者在它渲染的每个 index
   * 响应上调用。
   * @param html - 原始 index.html 消息体。
   * @returns 变换后的消息体。
   */
  applyIndexTaps(html: string): string {
    let out = html
    for (const transform of this.indexTaps) out = transform(out)
    return out
  }

  /**
   * 收集结构化注入表：一次 `webserver/index-inject` 发出，每个订阅者推入其当前的行。每次
   * 调用都是新鲜的，因此订阅者是在发出时读取实时状态（模块图、主题偏好）。
   * @returns 按订阅者激活顺序排列的行。
   */
  collectIndexInjections(): IndexInjection[] {
    const table: IndexInjection[] = []
    this.ctx.emit('webserver/index-inject', table)
    return table
  }

  /**
   * 渲染一个 index.html 消息体：先渲染结构化注入表，然后在结果之上应用原始的 `tapIndex`
   * 变换。
   * @param html - 原始 index.html 消息体。
   * @returns 变换后的消息体。
   */
  renderIndex(html: string): string {
    return this.applyIndexTaps(renderIndexInjections(html, this.collectIndexInjections()))
  }
}

export default WebServer
