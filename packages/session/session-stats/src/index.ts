/**
 * 注册 `sessionStats` 投影单元的函数插件：通过 session-projection 接缝
 * （注册表快照、变更流与每个投影载体）提供整个日志的回合/步骤计数，以及
 * LLM/工具/首 token/解码的墙钟时间，因此客户端能渲染出分页与压缩都无法
 * 改变的、整会话的数字。本插件只拥有折叠；投递是接缝的事。
 *
 * @module @deepseek-ai/dsh-session-stats
 */

import type { Context } from '@deepseek-ai/cordis'
import { sessionStatsProjectionDefinition } from './projection.ts'

export type * from './types.ts'

/** Cordis 插件名称。 */
export const name = 'session-stats'
/** 投影注册表是本插件的全部目的；没有它，纤程会一直保持 pending。 */
export const inject = ['sessionProjections']

/**
 * 注册 `sessionStats` 单元；该注册是作用于本插件纤程的一种 effect，因此
 * 卸载会移除该键。
 * @param ctx - 携带投影注册表的注册方上下文。
 */
export function apply(ctx: Context): void {
  ctx.sessionProjections.register(sessionStatsProjectionDefinition)
}
