/**
 * 转发 Host 事件允许列表的类型面：消费方键投影
 * 及其填充的选择席位。允许列表的 VALUE 位于
 * `./remote-events.ts`，按包约定使本模块保持 type-only；
 * 两个编译面都列出这两个文件，因此 Host 转发循环
 * 与消费方 `ctx.remote.$on` 键面读取同一份声明，
 * 而不是两份可能漂移的副本。
 *
 * @module @deepseek-ai/dsh-api-remotes/types
 */

import type { API_REMOTE_FORWARDED_EVENTS } from './remote-events.ts'

/** 允许列表的类型投影；消费方与 Host 读取这一份。 */
export type ApiRemoteForwardedEvent = typeof API_REMOTE_FORWARDED_EVENTS[number]['event']

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteEventSelection extends Record<ApiRemoteForwardedEvent, true> {}
}
