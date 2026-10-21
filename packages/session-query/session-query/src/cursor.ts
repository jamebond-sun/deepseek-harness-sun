/** 会话搜索分页所用的不透明游标标识。 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** 由提供方持有的不透明续接令牌，由会话搜索返回。 */
export type SessionSearchCursor = Branded<'SessionSearchCursor'>

/**
 * 为公共搜索契约标记一个已编码的提供方游标。
 * @param value - 不透明的已编码游标值。
 * @returns 运行时相同的字符串，附带会话搜索游标标识。
 */
export function SessionSearchCursor(value: string): SessionSearchCursor {
  return value as SessionSearchCursor
}
