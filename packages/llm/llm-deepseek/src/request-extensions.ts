/** 准备由插件贡献的请求字段，并在 HTTP 接受之后提交它们的投递。 */

import { errorChain, LlmError } from '@deepseek-ai/dsh-llm'
import type { DeepSeekLlmApiExtensionRequest, PreparedDeepSeekLlmApiExtensions } from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import type { DeepSeekAdapterOptions } from './types.ts'

/**
 * 合并各项贡献，且不替换 Messages 字段。准备被拒绝或发生基础字段冲突时，
 * 会以 REQUEST_EXTENSION 报告，并把原因链追加到消息中。当合并后的请求无法序列化时，
 * 载荷就是基础请求本身，且接受动作为空操作，于是各贡献方会在之后的请求上重发
 * 它们未被接受的状态。接受失败会被报告，但不会让本次请求失败。
 * @param body - 附加扩展字段之前、已序列化的 Messages 请求。
 * @param options - 请求身份、用途与取消信号。
 * @param prepare - 为本适配器捕获的贡献方注册表。
 * @param onOmitted - 接收被省略的字段名与序列化失败。
 * @param onUnaccepted - 在 HTTP 2xx 之后接收接受失败。
 * @returns HTTP 载荷，以及仅在成功 HTTP 响应之后才调用的提交动作。
 */
export async function prepareRequestExtensions(
  body: DeepSeekLlmApiExtensionRequest['body'],
  options: Omit<DeepSeekLlmApiExtensionRequest, 'body'>,
  prepare: DeepSeekAdapterOptions['prepareExtensions'],
  onOmitted: (fields: readonly string[], error: unknown) => void,
  onUnaccepted: (error: unknown) => void,
): Promise<{ payload: string; accept(): Promise<void> }> {
  let extensions: PreparedDeepSeekLlmApiExtensions
  try {
    extensions = await prepare({ body, ...options })
  } catch (error) {
    throw new LlmError(`DeepSeek request extension preparation failed: ${errorChain(error)}`, 'REQUEST_EXTENSION', { cause: error })
  }
  const fields = Object.keys(extensions.fields)
  for (const field of fields) {
    if (Object.hasOwn(body, field)) {
      throw new LlmError(`DeepSeek request extension field ${JSON.stringify(field)} collides with the base request`, 'REQUEST_EXTENSION')
    }
  }
  let payload: string
  try {
    payload = JSON.stringify({ ...body, ...extensions.fields })
  } catch (error) {
    // 无法序列化的基础请求会在这里抛出，先于任何字段被报告为已省略。
    const base = JSON.stringify(body)
    onOmitted(fields, error)
    return { payload: base, accept: () => Promise.resolve() }
  }
  return {
    payload,
    async accept() {
      try {
        await extensions.accept()
      } catch (error) {
        onUnaccepted(error)
      }
    },
  }
}
