/**
 * 权限领域在 Client 命名空间的投影：对本包类型出口的纯再导出。
 * Client 代码只导入 Client 命名空间（仓库纪律），因此 `./client` 投影的内容与
 * `./types` 投给 Host 消费方的是同一份单一来源 —— 零重复。
 *
 * @module @deepseek-ai/dsh-permission-presets/client
 */

export type * from './types.ts'
