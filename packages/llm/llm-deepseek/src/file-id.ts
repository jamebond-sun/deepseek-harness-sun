/** DeepSeek Files API 标识符。 @module dsh-llm-deepseek/file-id */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** DeepSeek Files API 返回的不透明标识符。 */
export type DeepSeekFileId = Branded<'DeepSeekFileId'>

/**
 * 在线格式校验之后，为提供方返回的文件标识符打上品牌标记。
 * @param id - 非空的 Files API 标识符。
 * @returns 同一个字符串，在类型层面附加了提供方身份。
 */
export function DeepSeekFileId(id: string): DeepSeekFileId {
  return id as DeepSeekFileId
}

/** 标识一个端点与 API 密钥文件命名空间的非机密摘要。 */
export type DeepSeekFileScope = Branded<'DeepSeekFileScope'>

/**
 * 为本派生的命名空间摘要打上品牌标记。
 * @param scope - 端点与 API 密钥的 SHA-256 摘要。
 * @returns 同一个字符串，在类型层面附加了命名空间身份。
 */
export function DeepSeekFileScope(scope: string): DeepSeekFileScope {
  return scope as DeepSeekFileScope
}
