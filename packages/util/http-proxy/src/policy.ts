/**
 * 代理策略解析：本包纯粹、无传输的那一半。它将启动环境转换为一份
 * {@link ProxyPolicy}，并回答某个给定的 URL 会经过哪个代理（若有）。
 *
 * 此处没有任何地方导入 `undici`，因此该模块在浏览器 worker 运行时中仍可加载，
 * 而该运行时会在没有 Node 传输的情况下执行 `dsh-web-fetch-http`。
 * @module @deepseek-ai/dsh-http-proxy/policy
 */

/**
 * 解析所需要的唯一一件来自环境的东西：输入一个名称，输出胜出的值。启动器
 * 的快照在结构上满足这一点，并原样传入，因此本模块无需点名任何包来描述其
 * 输入——测试也可用对象字面量构造一个。
 */
export interface EnvLookup {
  /**
   * 解析一个变量名。
   * @param name - 变量名。
   * @returns 胜出的条目，或当没有任何来源提供时返回 `undefined`。
   */
  get(name: string): { readonly value: string } | undefined
}

/**
 * 合并进每份策略 `noProxy` 的环回条目。一个同时服务 harness 自身环回流量的
 * 代理，会把 Web UI、Connection 传输以及每个本地测试服务器都变成路由环路，
 * 因此该绕过不是可选的。
 *
 * `::1` 与 `[::1]` 都被列出，因为解析后的字符串也会被交给 undici，其匹配器
 * 会把裸 `::1` 读作主机 `:` 端口 `1`，从而永远无法绕过它。
 */
export const LOOPBACK_NO_PROXY: readonly string[] = ['localhost', '127.0.0.1', '::1', '[::1]']

/**
 * 每个策略字段所拥有的环境名，小写在前——undici 先读取小写名，因此两种大小写
 * 总是被一同写入或清除。
 */
export const POLICY_ENV_NAMES = {
  httpProxy: ['http_proxy', 'HTTP_PROXY'],
  httpsProxy: ['https_proxy', 'HTTPS_PROXY'],
  noProxy: ['no_proxy', 'NO_PROXY'],
} as const

/**
 * 承载代理配置的每个环境名，包括本包解析但从不写回的 `ALL_PROXY` 回退。需要
 * 把一个子进程与机器网络策略隔离的调用方，需精确清除这些名称。
 */
export const PROXY_ENV_NAMES: readonly string[] = [
  ...Object.values(POLICY_ENV_NAMES).flat(),
  'all_proxy',
  'ALL_PROXY',
]

/** 本包会经其路由的代理 URL scheme。其他一切都会被报告，而非静默丢弃。 */
const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:'])

/** 足以在诊断中指明名称、而非称之为畸形的 scheme。 */
const SOCKS_PROTOCOLS = new Set(['socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:'])

/**
 * 一份已解析的出口代理策略。纯数据，没有任何方法：worker 线程通过
 * `workerData` 的结构化克隆接收它，因此两端运行的是完全相同的策略，而非各自
 * 重新读取一个它们可能不共享的环境。
 */
export interface ProxyPolicy {
  /** `http:` 来源的代理，或缺席以表示直连。始终为一个已校验的 `http(s):` URL。 */
  readonly httpProxy?: string
  /** `https:` 来源的代理，或缺席以表示直连。始终为一个已校验的 `http(s):` URL。 */
  readonly httpsProxy?: string
  /** 绕过列表，已与 {@link LOOPBACK_NO_PROXY} 合并。无绕过时为空。 */
  readonly noProxy: string
  /** 哪个层级提供了胜出的代理 URL；任一字段来自环境时为 `env`。 */
  readonly source: 'env' | 'none'
}

/** 一个什么也不代理的策略。尚未安装策略的调用方据此解析 URL。 */
export const DIRECT_POLICY: ProxyPolicy = { noProxy: '', source: 'none' }

/** 某个候选代理值未被使用的原因。由调用方决定这是告警还是导致加载失败。 */
export interface ProxyDiagnostic {
  /** 本包无法路由的 SOCKS 或 PAC URL 为 `socks`；任何不可解析的为 `invalid`。 */
  readonly kind: 'socks' | 'invalid'
  /** 提供了被拒绝值的那个环境变量。 */
  readonly origin: string
  /** 面向运维者、指明拒绝原因与解决方向的句子。不含凭据。 */
  readonly message: string
}


/** 一份已解析的策略，外加通往它途中被拒绝的每个候选值。 */
export interface ProxyResolution {
  /** 待安装的策略。绝不携带被拒绝的值。 */
  readonly policy: ProxyPolicy
  /** 拒绝记录，按候选值被考虑的顺序。干净解析时为空。 */
  readonly diagnostics: readonly ProxyDiagnostic[]
}

/**
 * 按 undici 的优先级顺序读取一个环境名——小写优先，大写作为回退——将空白值
 * 视为未设置。空白很重要：undici 自身的 `??` 链会让一个空的小写名遮蔽一个
 * 已填充的大写名。
 *
 * @param env - 待读取的启动环境快照。
 * @param lower - 小写变量名。
 * @returns 去除空白后的值及提供它的名称，或当两者都未设置时返回 `undefined`。
 */
function readEnv(
  env: EnvLookup,
  lower: string,
): { value: string; name: string } | undefined {
  for (const name of [lower, lower.toUpperCase()]) {
    const value = env.get(name)?.value.trim()
    if (value !== undefined && value !== '') return { value, name }
  }
  return undefined
}

/**
 * 一个环境变量所提供的内容。被拒绝的槽位与缺失的槽位不同：用户为该 scheme
 * 命名了一个代理，因此回退到另一个 scheme 的代理，会把请求发往他们从未要求
 * 的地方，而诊断却说它保持直连。
 */
type ProxyCandidate =
  | { readonly kind: 'accepted'; readonly value: string }
  | { readonly kind: 'rejected' }
  | { readonly kind: 'absent' }

/** 一个无人填入的槽位。 */
const ABSENT: ProxyCandidate = { kind: 'absent' }

/**
 * 校验一个候选代理 URL。
 *
 * @param candidate - 原始值及在诊断中需指明的来源。
 * @param diagnostics - 拒绝记录所追加到的收集器。
 * @returns 该候选的可用性，区分被拒绝的槽位与空的槽位。
 */
function acceptProxyUrl(
  candidate: { value: string; name: string } | undefined,
  diagnostics: ProxyDiagnostic[],
): ProxyCandidate {
  if (candidate === undefined) return ABSENT
  const parsed = URL.parse(candidate.value)
  if (parsed === null) {
    diagnostics.push({
      kind: 'invalid',
      origin: candidate.name,
      message: `${candidate.name} is not a valid URL; connecting directly`,
    })
    return { kind: 'rejected' }
  }
  if (SOCKS_PROTOCOLS.has(parsed.protocol)) {
    diagnostics.push({
      kind: 'socks',
      origin: candidate.name,
      message: `${candidate.name} names a SOCKS proxy, which is not supported; connecting directly for that scheme — set an http:// or https:// proxy URL instead`,
    })
    return { kind: 'rejected' }
  }
  if (!SUPPORTED_PROTOCOLS.has(parsed.protocol)) {
    diagnostics.push({
      kind: 'invalid',
      origin: candidate.name,
      message: `${candidate.name} uses the unsupported ${parsed.protocol}// scheme; connecting directly for that scheme — set an http:// or https:// proxy URL instead`,
    })
    return { kind: 'rejected' }
  }
  return { kind: 'accepted', value: candidate.value }
}

/**
 * 一个代理 URL 是否为本包所接受的：可解析，且为 `http:` 或 `https:` scheme。
 * 与 {@link acceptProxyUrl} 应用的测试相同，但不带其诊断。
 *
 * @param value - 环境变量所持有的那个代理 URL。
 * @returns 该 URL 会被接受时为 true。
 */
export function isSupportedProxyUrl(value: string): boolean {
  const parsed = URL.parse(value)
  return parsed !== null && SUPPORTED_PROTOCOLS.has(parsed.protocol)
}

/**
 * 从其自身槽位解析一个 scheme 的代理，然后回退——但仅在该 scheme 自身槽位为空时。
 * 被拒绝的槽位会让该 scheme 保持直连，因此诊断与路由一致。
 *
 * @param own - 该 scheme 自身名称所提供的内容。
 * @param fallbacks - 当 `own` 缺失时按顺序尝试的值。
 * @returns 该 scheme 的代理 URL，或直连时的 `undefined`。
 */
function resolveScheme(own: ProxyCandidate, ...fallbacks: (string | undefined)[]): string | undefined {
  if (own.kind === 'accepted') return own.value
  if (own.kind === 'rejected') return undefined
  return fallbacks.find(value => value !== undefined)
}

/**
 * 把 {@link LOOPBACK_NO_PROXY} 合并进一个绕过列表，保留调用方的条目与顺序。
 * 一个 `*` 列表已绕过一切，因此原样返回。
 *
 * @param noProxy - 环境所提供的绕过列表。
 * @returns 生效的绕过列表。
 */
function withLoopback(noProxy: string | undefined): string {
  const entries = (noProxy ?? '').split(/[,\s]+/).map(entry => entry.trim()).filter(entry => entry !== '')
  if (entries.includes('*')) return '*'
  const present = new Set(entries.map(entry => entry.toLowerCase()))
  return [...entries, ...LOOPBACK_NO_PROXY.filter(entry => !present.has(entry))].join(',')
}

/**
 * 将一个绕过条目拆分为主机与可选端口。
 *
 * 裸 IPv6 字面量带有多个冒号且没有端口，因此只有单冒号条目才拆分；带括号的
 * 字面量从括号之后取端口。处理出错正是 undici 把 `::1` 变成主机 `:` 端口 `1`
 * 的原因。
 *
 * @param entry - 一条已去除空白的绕过条目。
 * @returns 该条目的主机，以及当它带有端口时的端口。
 */
function splitHostPort(entry: string): { host: string; port?: string } {
  if (entry.startsWith('[')) {
    const close = entry.indexOf(']')
    if (close !== -1) {
      const rest = entry.slice(close + 1)
      const host = entry.slice(1, close)
      return rest.startsWith(':') ? { host, port: rest.slice(1) } : { host }
    }
  }
  const colon = entry.indexOf(':')
  if (colon !== -1 && entry.indexOf(':', colon + 1) === -1) {
    return { host: entry.slice(0, colon), port: entry.slice(colon + 1) }
  }
  return { host: entry }
}

/** 一个 IPv4 八位组，因此环回匹配不能接受 `127.999.1.1`。 */
const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)'

/** 整个 `127.0.0.0/8` 网段，而非仅其第一个地址。 */
const LOOPBACK_IPV4 = new RegExp(`^127\\.${OCTET}\\.${OCTET}\\.${OCTET}$`)

/**
 * 一个主机是否命名本机。
 *
 * 代理无法有意义地抵达一台：它会在自身网络中解析地址，而运行在本机上的代理
 * 会抵达一个只监听环回的服务。绕过列表携带 {@link LOOPBACK_NO_PROXY} 给那些
 * 读取环境而非策略的消费方，但那只是四条字面条目——仅靠匹配它们会让
 * `127.0.0.2`、整个 `127.0.0.0/8` 的其余部分，以及 IPv4 映射写法都经代理路由。
 *
 * @param hostname - 一个 URL 的主机名，无论是否带括号。
 * @returns 当主机为环回或未指定地址时为 true。
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '::1' || host === '::' || host === '0.0.0.0') return true
  // 一个 IPv4 映射的 IPv6 地址可能保留其点分尾部，或在 URL 已规范化后，以两个
  // 十六进制组承载相同的四个字节：`::ffff:127.0.0.1` 与 `::ffff:7f00:1` 是同一地址。
  const mappedHigh = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(host)?.[1]
  if (mappedHigh !== undefined) return Number.parseInt(mappedHigh, 16) >>> 8 === 127
  return LOOPBACK_IPV4.test(host.startsWith('::ffff:') ? host.slice('::ffff:'.length) : host)
}

/**
 * 判断一个绕过列表是否豁免某个 URL。一个条目命名一个主机，并与它之下的每个
 * 子域一同匹配——`example.com` 也会绕过 `api.example.com`——而前导的 `.` 或
 * `*.` 被视为同一回事；一个条目可带有 `:port`，而 `*` 绕过一切。CIDR 记法
 * 不被匹配——操作系统绕过列表常携带 `10.0.0.0/8`，它必须被重写为后缀。
 *
 * @param noProxy - 生效的绕过列表。
 * @param url - 请求 URL。
 * @returns 当该 URL 必须绕过代理时为 true。
 */
export function bypassesProxy(noProxy: string, url: URL): boolean {
  // `URL.hostname` 会保留 IPv6 字面量两侧的括号，而绕过条目两种写法皆有可能，
  // 因此在比较前两侧都去掉括号。
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  const port = url.port !== '' ? url.port : url.protocol === 'https:' ? '443' : '80'
  for (const raw of noProxy.split(/[,\s]+/)) {
    const entry = raw.trim().toLowerCase()
    if (entry === '') continue
    if (entry === '*') return true
    const split = splitHostPort(entry)
    if (split.port !== undefined && split.port !== port) continue
    const candidate = split.host.replace(/^\*?\./, '').replace(/\.$/, '')
    if (candidate === '') continue
    if (host === candidate || host.endsWith(`.${candidate}`)) return true
  }
  return false
}

/**
 * 解析本进程的出口代理策略。
 *
 * 一个 scheme 自身的变量胜出，然后是 `ALL_PROXY`，最后——仅对 HTTPS——是 HTTP
 * 代理，与 undici 一致，因此本函数与已安装 dispatcher 对一个 URL 永不产生分歧。
 *
 * @param env - 启动环境，其自身的分层已经优先真实的变量而非 `.env` 文件。
 * @returns 待安装的策略，外加每个被拒绝的候选。
 */
export function resolveProxyPolicy(env: EnvLookup): ProxyResolution {
  const diagnostics: ProxyDiagnostic[] = []
  const all = acceptProxyUrl(readEnv(env, 'all_proxy'), diagnostics)
  const allValue = all.kind === 'accepted' ? all.value : undefined
  const envHttp = acceptProxyUrl(readEnv(env, 'http_proxy'), diagnostics)
  const envHttps = acceptProxyUrl(readEnv(env, 'https_proxy'), diagnostics)
  const httpProxy = resolveScheme(envHttp, allValue)
  // HTTPS 最后回退到 HTTP 代理，与 undici 一致——但绝不越过用户为 HTTPS 命名、
  // 而本包拒绝的那个值。
  const httpsProxy = resolveScheme(envHttps, allValue, httpProxy)
  if (httpProxy === undefined && httpsProxy === undefined) return { policy: DIRECT_POLICY, diagnostics }
  return {
    policy: {
      ...httpProxy === undefined ? {} : { httpProxy },
      ...httpsProxy === undefined ? {} : { httpsProxy },
      noProxy: withLoopback(readEnv(env, 'no_proxy')?.value),
      source: 'env',
    },
    diagnostics,
  }
}

/**
 * 解析一个 URL 在某份策略下会经过哪个代理。
 *
 * 这是已安装 dispatcher 与 `dsh-web-fetch-http` 共同咨询的唯一答案，因此一个 URL
 * 永远不会被一方钉到某个已解析地址、而被另一方隧道转发。
 *
 * @param policy - 活动策略。
 * @param url - 请求 URL。
 * @returns 待经其隧道转发的代理 URL，或直连时的 `undefined`。
 */
export function proxyForUrl(policy: ProxyPolicy, url: URL): string | undefined {
  const proxy = url.protocol === 'https:' ? policy.httpsProxy : url.protocol === 'http:' ? policy.httpProxy : undefined
  if (proxy === undefined) return undefined
  if (isLoopbackHost(url.hostname)) return undefined
  return bypassesProxy(policy.noProxy, url) ? undefined : proxy
}
