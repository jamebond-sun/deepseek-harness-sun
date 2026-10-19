/** 对已抓取索引响应体的解码、JSON 解析与格式校验；解析 Worker 会运行它。 */
import { MarketIndexError, parseMarketIndex, type MarketIndex } from '@deepseek-ai/dsh-plugin-market-index'

/** 一个已校验的索引，或第一处违规的 JSON 路径、规则与诊断信息；`$` 涵盖 UTF-8 与 JSON 错误。 */
export type IndexParseResult =
  | { readonly ok: true; readonly index: MarketIndex }
  | { readonly ok: false; readonly path: string; readonly reason: string; readonly message: string }

/** 解析 Worker 作为 `workerData` 收到的请求。 */
export interface IndexParseRequest {
  readonly body: Uint8Array
  readonly url: string
}

/**
 * 将响应体按严格 UTF-8 解码，按 JSON 解析，并校验为格式 1。
 * @param body - 完整的响应体。
 * @param url - 相对图标引用据以解析的索引 URL。
 * @returns 已校验的索引，或第一处违规。
 */
export function parseIndexBody(body: Uint8Array, url: string): IndexParseResult {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    // 致命的 TextDecoder 仅在 UTF-8 畸形时抛出。
    return { ok: false, path: '$', reason: 'must be UTF-8', message: 'must be UTF-8' }
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    const reason = `must be JSON: ${(error as Error).message}`
    return { ok: false, path: '$', reason, message: reason }
  }
  try {
    return { ok: true, index: parseMarketIndex(value, url) }
  } catch (error) {
    /* v8 ignore next -- parseMarketIndex throws nothing but its own validation failure */
    if (!(error instanceof MarketIndexError)) throw error
    return { ok: false, path: error.path, reason: error.reason, message: error.message }
  }
}
