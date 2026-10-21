/**
 * session-projection 服务定义的纯类型出口：那张唯一的投影类型表，可从
 * 客户端聚合中导入，而无需拖入包根（dsh-agent → dsh-session）的主机侧
 * cordis Context 合并。领域包既可以通过包根，也可以通过这个出口来声明合并——
 * 重新导出保留了符号身份，因此两者都落在同一张表上。
 *
 * @module @deepseek-ai/dsh-session-projection/types
 */

/**
 * 由 wire 区块、客户端 cell 与 React hook 共用的、可合并扩展的客户端投影表。
 * 领域包在此合并其客户端可见的键；值为 wire-JSON 整体值。某值如何被渲染
 * 是插槽系统的事，与本层无关。
 */
export interface SessionProjectionMap {}

/**
 * 可合并扩展的主机折叠状态表。每个客户端可见的键也会出现在
 * {@link SessionProjectionMap} 中；仅主机侧的键只出现在这里。值必须是
 * 纯 JSON，以便投影缓存能够持久化它们。
 */
export interface SessionProjectionStateMap {}
