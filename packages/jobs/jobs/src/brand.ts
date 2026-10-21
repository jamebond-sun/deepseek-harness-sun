/**
 * dsh-jobs 自己的品牌化 id，贯穿注册表、面向模型的控制界面以及客户端传输。
 *
 * 它单独放在一个叶子模块里，是因为包根目录与 `./types` 都通过所有者与监听器签名触达
 * `dsh-agent`，而 Client 程序即使只作为类型也无法解析它。浏览器安全的消费者从这里导入
 * 该 id；`Branded<B>` 本身来自零依赖的 `@deepseek-ai/dsh-brand`。
 *
 * @module @deepseek-ai/dsh-jobs/brand
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * 跨注册表生命周期标识一个任务。注册表生成 `<kind>-<short-uuid>`；
 * 访问仍然需要所有者授权。
 */
export type JobId = Branded<'JobId'>

/**
 * 把一个字符串标注为 {@link JobId}。
 * @param id - 原始的任务 id 字符串（注册表在类型之后生成 16 个 UUID 十六进制字符）。
 * @returns 同一个字符串，带品牌；不做任何校验。
 */
export function JobId(id: string): JobId {
  return id as JobId
}
