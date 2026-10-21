/**
 * 标题领域的客户端命名空间投影：对本包类型出口的纯重新导出。客户端代码
 * 只导入客户端命名空间（仓库纪律），因此 `./client` 投影出的、`./types`
 * 提供给主机消费方的，是同一个单一来源内容——零重复。
 *
 * @module @deepseek-ai/dsh-session-title/client
 */

export type * from './types.ts'
