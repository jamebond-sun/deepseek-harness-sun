/**
 * 携带页面首个访问快照的 index 全局，由写入它的
 * Host 行与读取它的 Client 挂载共享。
 * @module @deepseek-ai/dsh-api-remote-access/src/snapshot
 */

/** index 注入行赋给页面开场 baseline 的 `globalThis` 属性。 */
export const REMOTE_ACCESS_SNAPSHOT_KEY = '__DSH_REMOTE_ACCESS__'
