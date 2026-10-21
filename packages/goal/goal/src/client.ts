/**
 * goal 领域的客户端命名空间投影：对本包类型出口的纯再导出。客户端代码
 * 只导入客户端命名空间（仓库规范），因此 `./client` 投影的正是 `./types`
 * 提供给宿主消费者的同一份单一来源内容——零重复。
 *
 * @module @deepseek-ai/dsh-goal/client
 */

export type * from './types.ts'
