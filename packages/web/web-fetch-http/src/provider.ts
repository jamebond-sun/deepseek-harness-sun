/**
 * 面向 `ctx.web` 的安全 HTTP(S) 检索：验证并钉死公共 IP 目标，仅跟随同源重定向，强制实施
 * 时间与大小限制，分类并解码文本，并将呈现交给 `@deepseek-ai/dsh-tool-web`。请求不携带任何
 * 浏览器 Cookie 或环境凭据。
 * @module @deepseek-ai/dsh-web-fetch-http/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type { WebFetchBody, WebFetchProvider, WebFetchRequest, WebFetchResult } from '@deepseek-ai/dsh-web'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { Response } from 'undici'
import { proxyRouteFor } from '@deepseek-ai/dsh-http-proxy'
import { isNonPublicIpLiteral, publicHttpNetwork } from './network.ts'
import type { PublicAddress } from './network.ts'
import { classifyContentType, decoderForCharset, isSameOrigin, parseCharset, validateFetchUrl } from './policy.ts'

/** 已解析的提供方限制（插件的 schemastery Config 提供默认值）。 */
export interface HttpFetchLimits {
  /** 响应正文的最大字节数（超限即中止读取）。 */
  maxResponseBytes: number
  /** 已解码正文的最大字符数（超限即截断）。 */
  maxBodyChars: number
  /** 默认抓取超时（毫秒）。 */
  timeoutMs: number
  /** 要跟随的（同源）重定向跳数上限。 */
  maxRedirects: number
  /** 每次请求发送的 `User-Agent` 头。 */
  userAgent: string
}

/** 将一个主机名解析为一组已通过策略验证的地址。 */
export type HttpFetchResolver = (hostname: string, signal: AbortSignal) => Promise<PublicAddress[]>

/** 本提供方注册的固定 id。 */
export const LOCAL_FETCH_PROVIDER_ID = 'http'

/** 匿名公共 HTTP(S) 抓取提供方。 */
export class HttpFetchProvider implements WebFetchProvider {
  readonly id = LOCAL_FETCH_PROVIDER_ID

  /**
   * @param limits - 已解析的传输与响应限制。
   * @param resolveAddresses - 在返回前拒绝非公共目标的解析器。
   */
  constructor(
    private readonly limits: HttpFetchLimits,
    private readonly resolveAddresses: HttpFetchResolver = publicHttpNetwork.resolve,
  ) {}

  /** 没有需检查的凭据 —— 匿名公共抓取器始终可用。 */
  available(): boolean {
    return true
  }

  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    if (signal?.aborted) throw new WebError('web fetch aborted', 'WEB_ABORTED')

    // 同一个信号同时停止请求与正文读取。deadline 的 TimeoutReason 随后
    // 区分本提供方的超时与调用方或外层 deadline 的取消。
    using d = deadline(signal, this.limits.timeoutMs, 'WEB_FETCH_TIMEOUT')
    return await this.followAndRead(request.url, d.signal)
  }

  /** 跟随同源重定向直到跳数上限，然后读取最终响应。 */
  private async followAndRead(initialUrl: string, signal: AbortSignal): Promise<WebFetchResult> {
    let currentUrl = validateFetchUrl(initialUrl)
    let redirectsFollowed = 0

    for (;;) {
      const request = await this.requestOnce(currentUrl, signal)
      const { response } = request
      try {
        if (isRedirectStatus(response.status)) {
          // 在解析或验证下一跳之前强制实施重定向预算。
          if (redirectsFollowed >= this.limits.maxRedirects) {
            await response.body?.cancel()
            throw new WebError(`exceeded the maximum of ${this.limits.maxRedirects} redirects`, 'WEB_REDIRECT_BLOCKED')
          }
          const location = response.headers.get('location')
          if (location === null) {
            // 一个没有 Location 的重定向状态不是可用资源。在抛出之前取消
            // （可能正在流式传输的）正文，以免 socket 泄漏。
            await response.body?.cancel()
            throw new WebError(`redirect response (HTTP ${response.status}) without a Location header`, 'WEB_PROVIDER_ERROR')
          }
          const target = resolveRedirect(location, currentUrl)
          // 针对同一套直接请求所获得的传输卫生重新验证目标：重定向绝不能成为通往
          // 带凭据、非 http(s) 或过长 URL 的后门，而 validateFetchUrl 本应拒绝它。
          let validatedTarget: URL
          try {
            validatedTarget = validateFetchUrl(target.toString())
            if (!isSameOrigin(validatedTarget, currentUrl)) {
              throw new WebError(
                `cross-origin redirect to ${validatedTarget.origin} is not followed automatically; retry against that URL directly`,
                'WEB_REDIRECT_BLOCKED',
              )
            }
          } catch (error: unknown) {
            await response.body?.cancel()
            throw error
          }
          await response.body?.cancel()
          currentUrl = validatedTarget
          redirectsFollowed++
          continue
        }

        return await this.readBody(response, currentUrl, signal)
      } finally {
        await request.close()
      }
    }
  }

  private async requestOnce(url: URL, signal: AbortSignal) {
    const headers = {
      'user-agent': this.limits.userAgent,
      'accept': 'text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8',
    }
    try {
      // 一个经过代理的跳转跳过公共地址解析与钉死：代理执行源站的 DNS，因此没有
      // 可供验证的本地地址，而钉死一个地址会直达连接并绕开代理。一个被策略绕过的
      // 跳转 —— 每个回环地址和每个 `NO_PROXY` 条目 —— 仍走未改变的解析并钉死路径。
      //
      // 一条路由同时决定分支与分发器，因此两次读取之间的挂载或处置无法为这个分支已清为
      // 已代理的 URL 返回直达的、未钉死的代理。
      //
      // 地址检查会拒绝的 IP 字面量绝不会走该路径。代理解析不了任何东西 —— 地址已经给出 ——
      // 因此这条捷径会为检查白忙一场，并让本机上的代理到达它本要将之挡在可达范围之外的服务。
      const route = proxyRouteFor(url)
      if (route.proxied && !isNonPublicIpLiteral(url.hostname)) {
        return await publicHttpNetwork.requestVia(route.dispatcher, url, headers, signal)
      }
      const addresses = await this.resolveAddresses(url.hostname, signal)
      return await publicHttpNetwork.request(url, addresses, headers, signal)
    } catch (error: unknown) {
      if (error instanceof WebError) throw error
      throw translateAbortOrNetwork(error, signal)
    }
  }

  /** 读取、按字节截断、分类并解码最终响应正文。 */
  private async readBody(response: Response, finalUrl: URL, signal: AbortSignal): Promise<WebFetchResult> {
    const contentType = response.headers.get('content-type')
    const kind = classifyContentType(contentType)
    if (kind === undefined) {
      await response.body?.cancel()
      throw new WebError(`unsupported content type "${contentType ?? 'unknown'}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE')
    }

    // 在读取正文之前解析解码器，使得不支持的 charset 在消费流之前就失败 —— 但在该失败时
    // 取消正文，以免 socket 泄漏（与不支持内容类型的路径一致）。
    let decoder: TextDecoder
    try {
      decoder = decoderForCharset(parseCharset(contentType))
    } catch (error: unknown) {
      await response.body?.cancel()
      throw error
    }
    const { bytes, truncatedByBytes } = await this.readCapped(response, signal)
    const decoded = decoder.decode(bytes)
    const truncatedByChars = decoded.length > this.limits.maxBodyChars
    const content = truncatedByChars ? decoded.slice(0, this.limits.maxBodyChars) : decoded
    const body: WebFetchBody = kind === 'html' ? { kind: 'html', content } : { kind: 'text', content }

    return {
      url: finalUrl.toString(),
      statusCode: response.status,
      body,
      truncated: truncatedByBytes || truncatedByChars,
    }
  }

  /**
   * 读取响应流直到 `maxResponseBytes`。声明长度超过上限会立即以 `WEB_FETCH_TOO_LARGE` 拒绝；
   * 在超限后继续增长的流会被截断（`truncatedByBytes`）而非拒绝，因此一个少报长度的服务器仍能
   * 产生一个有界的可用正文。
   */
  private async readCapped(response: Response, signal: AbortSignal): Promise<{ bytes: Uint8Array; truncatedByBytes: boolean }> {
    const declared = response.headers.get('content-length')
    if (declared !== null) {
      const length = Number(declared)
      if (Number.isFinite(length) && length > this.limits.maxResponseBytes) {
        await response.body?.cancel()
        throw new WebError(`response exceeds the maximum of ${this.limits.maxResponseBytes} bytes`, 'WEB_FETCH_TOO_LARGE')
      }
    }

    /* v8 ignore next -- fetch 返回的 2xx 响应总是暴露一个正文流；null 守卫是防御性的。 */
    if (response.body === null) return { bytes: new Uint8Array(0), truncatedByBytes: false }

    const chunks: Uint8Array[] = []
    let total = 0
    let truncatedByBytes = false
    // Undici 将响应块暴露为 `any`；Fetch 保证正文块是 Uint8Array。
    const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const remaining = this.limits.maxResponseBytes - total
        // 只有被丢弃的字节才算作截断：一个恰好填满剩余容量的块保留其全部字节，
        // 且我们会继续读取以观察 EOF，因此恰好达到上限的正文不会被误标为截断。
        if (value.byteLength > remaining) {
          chunks.push(value.subarray(0, remaining))
          total += remaining
          truncatedByBytes = true
          break
        }
        chunks.push(value)
        total += value.byteLength
      }
    } catch (error: unknown) {
      /* v8 ignore next -- 中途读取故障需要头部之后的网络中断；转换路径被请求阶段测试覆盖。 */
      throw translateAbortOrNetwork(error, signal)
    } finally {
      /* v8 ignore next 4 -- 完成/中断读取之后的 cancel() 会 settle 而不拒绝；未观察到的尽力清理。 */
      await reader.cancel().catch(() => {
        // 成功读取之后（或在我们越过上限之后）的取消是尽力清理；我们所需的字节已经收集。
      })
    }

    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { bytes, truncatedByBytes }
  }
}

/** 携带 `Location` 的 HTTP 重定向状态码。 */
function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

/** 将（可能为相对的）`Location` 针对当前 URL 解析。 */
function resolveRedirect(location: string, base: URL): URL {
  try {
    return new URL(location, base)
  } catch (error: unknown) {
    /* v8 ignore next 2 -- 针对有效绝对 base 的 URL 解析实际上从不抛出；防御性守卫。 */
    throw new WebError(`invalid redirect Location "${location}"`, 'WEB_PROVIDER_ERROR', { cause: error })
  }
}

/**
 * 将一个抛出的 fetch/流错误转换为 `WebError`，按 deadline 信号而非抛出值分类（二者因阶段
 * 而异：请求阶段的 `fetch` 以 abort 原因拒绝，而读取阶段的 reader 抛出一个裸 `AbortError`）。
 * `timeoutOf(signal, 'WEB_FETCH_TIMEOUT')` 恢复出我们的原因意味着我们的超时触发了
 * （`WEB_FETCH_TIMEOUT`）；任何其他中止 —— 上游取消，或嵌套下的外来/外层 deadline 超时 ——
 * 都是 `WEB_ABORTED`；信号未中止时的抛出是传输/网络失败（`WEB_PROVIDER_ERROR`）。
 */
function translateAbortOrNetwork(error: unknown, signal: AbortSignal): WebError {
  const timeout = timeoutOf(signal, 'WEB_FETCH_TIMEOUT')
  if (timeout !== undefined) return new WebError('web fetch timed out', 'WEB_FETCH_TIMEOUT', { cause: timeout })
  if (signal.aborted) return new WebError('web fetch aborted', 'WEB_ABORTED', { cause: error })
  return new WebError(`web fetch failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
}
