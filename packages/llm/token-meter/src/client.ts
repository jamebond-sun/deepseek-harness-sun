/**
 * token-meter 的浏览器安全契约与折叠在 client 命名空间下的投影。
 *
 * @module @deepseek-ai/dsh-token-meter/client
 */

export type * from './projection.ts'
export { deriveTurnTokenUsage } from './turn-usage.ts'
export type { TurnTokenUsage, TurnTokenUsageRoute } from './turn-usage.ts'
