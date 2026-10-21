/** 共享的 DeepSeek Messages API 端点与请求头策略。 @module dsh-llm-deepseek/messages-api */

/** Messages 文件操作与文件引用图像请求所必需的显式启用项。 */
export const MESSAGES_FILES_BETA = 'files-api-2025-04-14'

/** 对话中途出现的 `tool_addition` 与 `tool_removal` 块所必需的显式启用项。 */
export const MESSAGES_TOOL_CHANGES_BETA = 'mid-conversation-tool-changes-2026-07-01'

/**
 * 解析 API 根路径，且不重复显式的提供方版本路径。
 * @param baseURL - 已校验的、已配置的端点根路径。
 * @returns 暴露 Messages 资源所使用的根路径。
 */
export function messagesApiRoot(baseURL: string): string {
  const base = baseURL.replace(/\/+$/u, '')
  return new URL(base).pathname.endsWith('/v1') ? base : `${base}/v1`
}
