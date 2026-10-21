/**
 * 注册 `turnOutline` 投影单元的函数插件：通过 session-projection 接缝——
 * 注册表快照、变更流与每个投影载体——提供整日志的回合大纲（回合数、
 * `turn/start` seq、有界的提示预览），因此客户端能在不持有事件的情况下
 * 提供会话的每个回合，并把历史分页精确定位到具体 seq。本插件只拥有折叠；
 * 投递是接缝的事。
 *
 * @module @deepseek-ai/dsh-session-turn-outline
 */

import type { Context } from '@deepseek-ai/cordis'
import { turnOutlineProjectionDefinition } from './projection.ts'

export type * from './types.ts'

/** Cordis 插件名称。 */
export const name = 'session-turn-outline'
/** 投影注册表是本插件的全部目的；没有它，纤程会一直保持 pending。 */
export const inject = ['sessionProjections']

/**
 * 注册 `turnOutline` 单元；该注册是作用于本插件纤程的一种 effect，因此
 * 卸载会移除该键。
 * @param ctx - 携带投影注册表的注册方上下文。
 */
export function apply(ctx: Context): void {
  ctx.sessionProjections.register(turnOutlineProjectionDefinition)
}
