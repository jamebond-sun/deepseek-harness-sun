/**
 * 计划模式领域的客户端命名空间投影：对本包类型出口的纯再导出。客户端代码只能
 * 导入 client 命名空间（仓库纪律），因此 `./client` 与 `./types` 服务于宿主消费方
 * 的是同一份单一来源内容 —— 零重复。
 *
 * @module @deepseek-ai/dsh-plan-mode/client
 */

export type * from './types.ts'
