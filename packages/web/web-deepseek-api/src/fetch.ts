/**
 * DeepSeek Fetch API 提供方：通过一次直接请求获取页面 Markdown，无需模型请求。
 * @module @deepseek-ai/dsh-web-deepseek-api/fetch
 */
import type { WebFetchProvider, WebFetchRequest, WebFetchResult } from '@deepseek-ai/dsh-web'
import { DEEPSEEK_WEB_API_GUIDANCE } from './search.ts'
import {
  dispatchDeepSeekWeb, hasDeepSeekWebCredential, invalidResponse, isRecord,
  type DeepSeekWebAuth,
} from './transport.ts'

/** Fetch API 提供方在抓取注册表中注册的固定 id。 */
export const DEEPSEEK_FETCH_API_PROVIDER_ID = 'deepseek-fetch-api'

/** 为一次抓取快照化的认证与端点设置。 */
export interface DeepSeekFetchApiOptions extends DeepSeekWebAuth {
  /** API 基址，含路径前缀；会追加 `/fetch`。 */
  baseURL: string
}

/**
 * 通过 DeepSeek Fetch API 获取页面 Markdown。该 API 既不报告目标状态码，也不报告最终 URL，
 * 并且在目标未产出可用内容时会失败，因此一次成功即表示以 HTTP 200 获取到了所请求的页面。
 */
export class DeepSeekFetchApiProvider implements WebFetchProvider {
  readonly id = DEEPSEEK_FETCH_API_PROVIDER_ID

  /** @param resolveOptions - 供下一次抓取使用的选项，在每次抓取入口处读取一次。 */
  constructor(private readonly resolveOptions: () => DeepSeekFetchApiOptions) {}

  available(): boolean {
    const options = this.resolveOptions()
    return hasDeepSeekWebCredential(options) && URL.canParse(options.baseURL)
  }

  fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    const options = this.resolveOptions()
    return dispatchDeepSeekWeb(options, {
      endpoint: `${options.baseURL.replace(/\/+$/u, '')}/fetch`,
      body: { url: request.url },
      decode: (payload): WebFetchResult => {
        if (!isRecord(payload) || typeof payload.content !== 'string') throw invalidResponse()
        return { url: request.url, statusCode: 200, body: { kind: 'text', content: payload.content }, truncated: false }
      },
      guidance: { subject: 'Fetch', ...DEEPSEEK_WEB_API_GUIDANCE },
    }, signal)
  }
}
