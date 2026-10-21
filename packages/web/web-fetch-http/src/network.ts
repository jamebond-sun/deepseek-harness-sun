/**
 * `web-fetch-http` 的公共网络解析与地址钉死的 HTTP 传输层。在 Undici 通过自定义
 * lookup 接收 DNS 答案之前，先验证一整组 DNS 答案，从而连接无法再把主机名重新解析为
 * 私有地址。
 *
 * @module @deepseek-ai/dsh-web-fetch-http/network
 */

import { lookup as systemLookup } from 'node:dns/promises'
import type { LookupAddress, LookupOptions } from 'node:dns'
import { isIP } from 'node:net'
import type { Dispatcher, Response } from 'undici'

import ipaddr from 'ipaddr.js'
import { WebError } from '@deepseek-ai/dsh-web'

/** 为后续钉死连接解析并保留的一个地址。 */
export interface PublicAddress {
  /** 规范化的文本形式 IPv4 或 IPv6 地址。 */
  readonly address: string
  /** Node 连接 lookup 回调接受的地址族。 */
  readonly family: 4 | 6
}

/** 一次地址钉死请求的结果；关闭会释放其私有连接池。 */
export interface PinnedResponse {
  /** HTTP 响应，其正文在 `close()` 被调用之前保持可读。 */
  readonly response: Response
  /** 在响应正文被消费或取消后释放该请求的分发器。 */
  close(): Promise<void>
}

/** 用于在不改动进程级 DNS 的情况下测试公共地址策略的解析器签名。 */
export type AddressResolver = (hostname: string, options: { all: true; order: 'verbatim' }) => Promise<LookupAddress[]>

/** 可能通过 NAT64 携带 IPv4 目标的 RFC 6052 前缀长度。 */
const RFC6052_PREFIX_LENGTHS = [32, 40, 48, 56, 64, 96] as const
const IPV4ONLY_DISCOVERY_HOST = 'ipv4only.arpa'
const IPV4ONLY_SENTINELS = new Set(['192.0.0.170', '192.0.0.171'])

interface Nat64Prefix {
  readonly bytes: readonly number[]
  readonly length: typeof RFC6052_PREFIX_LENGTHS[number]
}

/**
 * 返回一个地址是否为全局可达的单播地址。IPv4 映射的 IPv6 按其内嵌的 IPv4 地址分类；
 * 过渡与转换前缀保持被阻止，因为它们最终的 IPv4 目标在此无法被钉死。
 *
 * @param input - 文本形式的 IPv4 或 IPv6 地址。
 * @returns 仅当是公共单播目标时为 true。
 */
export function isPublicIpAddress(input: string): boolean {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6
  try {
    parsed = ipaddr.parse(stripIpv6Brackets(input))
  } catch {
    return false
  }
  if (parsed instanceof ipaddr.IPv4) return parsed.range() === 'unicast'
  if (parsed.isIPv4MappedAddress()) return parsed.toIPv4Address().range() === 'unicast'
  return parsed.range() === 'unicast'
}

/**
 * 解析一次主机名，并在整套答案中任意目标非公共时拒绝。返回地址是传输层唯一可用的地址。
 *
 * @param hostname - URL 主机名，当其为 IPv6 字面量时含括号。
 * @param signal - 中止等待系统解析；一个进行中的 OS 查找可能未被使用即结束。
 * @param resolver - lookup 实现，仅由针对性测试覆盖。
 * @returns 校验通过的非空地址集。
 */
export async function resolvePublicAddresses(
  hostname: string,
  signal: AbortSignal,
  resolver: AddressResolver = systemLookup,
): Promise<PublicAddress[]> {
  const unbracketed = stripIpv6Brackets(hostname)
  const literalFamily = isIP(unbracketed)
  const resolved = literalFamily === 0
    ? await raceWithSignal(resolver(unbracketed, { all: true, order: 'verbatim' }), signal)
    : [{ address: unbracketed, family: literalFamily }]

  if (resolved.length === 0) {
    throw new WebError(`hostname "${hostname}" resolved to no addresses`, 'WEB_PROVIDER_ERROR')
  }

  const hasIpv6 = resolved.some(entry => entry.family === 6 && isIP(entry.address) === 6)
  const nat64Prefixes = hasIpv6
    ? await discoverNat64Prefixes(signal, resolver)
    : []

  const addresses: PublicAddress[] = []
  for (const entry of resolved) {
    if ((entry.family !== 4 && entry.family !== 6) || isIP(entry.address) !== entry.family) {
      throw new WebError(`hostname "${hostname}" resolved to an invalid IP address`, 'WEB_PROVIDER_ERROR')
    }
    if (!isPublicIpAddress(entry.address)) {
      throw new WebError(`URL hostname "${hostname}" resolves to a non-public IP address`, 'WEB_BLOCKED_URL')
    }
    const translatedIpv4 = translatedIpv4Address(entry.address, nat64Prefixes)
    if (translatedIpv4 !== undefined && !isPublicIpAddress(translatedIpv4)) {
      throw new WebError(`URL hostname "${hostname}" resolves through NAT64 to a non-public IPv4 address`, 'WEB_BLOCKED_URL')
    }
    addresses.push({ address: entry.address, family: entry.family })
  }
  return addresses
}

/** 使用 RFC 7050 的保留主机名发现活跃的 DNS64 前缀集。 */
async function discoverNat64Prefixes(signal: AbortSignal, resolver: AddressResolver): Promise<Nat64Prefix[]> {
  const discovered = await raceWithSignal(
    resolver(IPV4ONLY_DISCOVERY_HOST, { all: true, order: 'verbatim' }),
    signal,
  )
  const prefixes: Nat64Prefix[] = []
  const seen = new Set<string>()
  for (const entry of discovered) {
    if (entry.family !== 6 || isIP(entry.address) !== 6) continue
    const bytes = ipaddr.parse(entry.address).toByteArray()
    for (const length of RFC6052_PREFIX_LENGTHS) {
      const embedded = embeddedIpv4Address(bytes, length)
      if (embedded === undefined || !IPV4ONLY_SENTINELS.has(embedded)) continue
      const prefixBytes = bytes.slice(0, length / 8)
      const key = `${String(length)}:${prefixBytes.join('.')}`
      if (seen.has(key)) continue
      seen.add(key)
      prefixes.push({ bytes: prefixBytes, length })
    }
  }
  return prefixes
}

/** 当 IPv6 地址匹配某个已发现前缀时，返回 RFC 6052 内嵌的 IPv4 地址。 */
function translatedIpv4Address(input: string, prefixes: readonly Nat64Prefix[]): string | undefined {
  if (isIP(input) !== 6) return undefined
  const bytes = ipaddr.parse(input).toByteArray()
  for (const prefix of prefixes) {
    if (!prefix.bytes.every((byte, index) => bytes[index] === byte)) continue
    const embedded = embeddedIpv4Address(bytes, prefix.length)
    if (embedded !== undefined) return embedded
  }
  return undefined
}

/** 从 RFC 6052 的 IPv6 布局中提取一个 IPv4 地址。 */
function embeddedIpv4Address(bytes: readonly number[], prefixLength: Nat64Prefix['length']): string | undefined {
  if (prefixLength === 96) return bytes.slice(12, 16).join('.')
  if (bytes[8] !== 0) return undefined
  const prefixBytes = prefixLength / 8
  const beforeReservedOctet = 8 - prefixBytes
  const ipv4 = [
    ...bytes.slice(prefixBytes, prefixBytes + beforeReservedOctet),
    ...bytes.slice(9, 9 + 4 - beforeReservedOctet),
  ]
  return ipv4.join('.')
}

/**
 * 判断一个主机名是否为 {@link resolvePublicAddresses} 会拒绝的 IP 字面量。
 *
 * 一个经过代理的跳转会跳过这些检查，因为代理解析源站；而字面量无需解析：地址已经给出，
 * 把它交给运行在本机上的代理会恰好到达那些检查本要将其挡在可达范围之外的回环或私有服务。
 *
 * @param hostname - 一个 URL 的主机名，可带括号。
 * @returns 当该主机是一个任何请求都不得发往的字面地址时为 true。
 */
export function isNonPublicIpLiteral(hostname: string): boolean {
  const unbracketed = stripIpv6Brackets(hostname)
  return isIP(unbracketed) !== 0 && !isPublicIpAddress(unbracketed)
}

/**
 * 通过一个 lookup 回调只返回已验证地址集的代理发起请求。URL 主机名保持原样，用于 HTTP Host
 * 和 TLS SNI。
 *
 * 该代理属于本次请求自身，因为地址集是：钉死正是本包拒绝在验证与连接之间改变的 DNS 答案的方式，
 * 它不能应用于进程级 —— 一个由操作员配置的、位于回环上的 MCP 服务器或模型端点是一个受支持的目标，
 * 只有此工具抓取的 URL 才是模型可以选择的。
 *
 * @param url - 策略不通过代理路由的、已验证的 HTTP(S) URL。
 * @param addresses - 由 {@link resolvePublicAddresses} 返回的公共地址。
 * @param headers - 请求头。
 * @param signal - 请求与正文读取的取消信号。
 * @returns 一个响应，加上其消费方必须调用的清理器。
 */
export async function requestPinned(
  url: URL,
  addresses: readonly PublicAddress[],
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<PinnedResponse> {
  // 让仅 Node 的传输层远离浏览器 worker 的启动。预览版可以加载提供方，
  // 并在其 DNS 桩处响亮失败，而不必求值 Undici；真实请求在此处解析它。
  const { Agent, fetch } = await import('undici')
  // 仅在 `proxyRouteFor` 报告此 URL 无代理时到达此处，而此代理携带的钉死 lookup 是
  // 每请求状态，进程级分发器无法持有。
  // proxy-exempt：钉死一个请求的已验证地址，在一个策略直接路由的 URL 上。
  const dispatcher = new Agent({ autoSelectFamily: true, connect: { lookup: createPinnedLookup(addresses) } })
  try {
    // proxy-exempt：上面的代理，其生命周期就是这一次请求。
    const response = await fetch(url, { method: 'GET', redirect: 'manual', headers, signal, dispatcher })
    return { response, close: async () => { await dispatcher.close() } }
  } catch (error: unknown) {
    await dispatcher.close()
    throw error
  }
}

/**
 * 通过代理策略已安装的代理分发器发起请求，让代理解析源站。
 *
 * 不钉死任何地址集，因为没有可钉死的地址：代理执行 lookup，而钉死到本地解析的地址的连接
 * 会直达源站，从而绕开代理。该分发器是进程级的，因此各跳转共享其连接池，也没有调用方关闭它。
 *
 * @param dispatcher - 该路由的分发器，来自 `proxyRouteFor`。
 * @param url - 策略通过代理路由的、已验证的 HTTP(S) URL。
 * @param headers - 请求头。
 * @param signal - 请求与正文读取的取消信号。
 * @returns 一个响应加上一个释放无物的清理器，使两条路径以相同方式关闭。
 */
export async function requestVia(
  dispatcher: Dispatcher,
  url: URL,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<PinnedResponse> {
  const { fetch } = await import('undici')
  // proxy-exempt：该分发器是已安装策略自身的，由 `proxyRouteFor` 移交。
  const response = await fetch(url, { method: 'GET', redirect: 'manual', headers, signal, dispatcher })
  return { response, close: () => Promise.resolve() }
}

/** 生产网络操作保留为一个对象，以便提供方测试只替换解析。 */
export const publicHttpNetwork = {
  resolve: resolvePublicAddresses,
  request: requestPinned,
  requestVia,
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void

/**
 * 构建提供一组固定、已验证答案的连接器 lookup。
 *
 * @param addresses - 来自先前解析的公共地址。
 * @returns 一个不执行任何网络解析的、Node 兼容的 lookup 回调。
 */
export function createPinnedLookup(addresses: readonly PublicAddress[]): (
  hostname: string,
  options: LookupOptions,
  callback: LookupCallback,
) => void {
  return (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    const family = typeof options.family === 'number'
      ? options.family
      : options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : 0
    const eligible = family === 0 ? addresses : addresses.filter(address => address.family === family)
    const selected = eligible[0]
    if (selected === undefined) {
      const error = Object.assign(new Error(`no validated address for ${hostname} in family ${family}`), {
        code: 'ENOTFOUND',
        hostname,
      })
      callback(error, options.all === true ? [] : '', family)
      return
    }
    if (options.all === true) {
      callback(null, eligible.map(address => ({ ...address })))
      return
    }
    callback(null, selected.address, selected.family)
  }
}

/** 让一个不可取消的 OS lookup 参与竞速，又不让它拖累工具取消。 */
function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  const abortError = () => new Error('web fetch aborted during hostname resolution', { cause: signal.reason })
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    const abort = () => { reject(abortError()) }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort) })
  })
}

/** WHATWG URL 会保留 IPv6 主机名周围的括号；IP 解析器不会。 */
function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}
