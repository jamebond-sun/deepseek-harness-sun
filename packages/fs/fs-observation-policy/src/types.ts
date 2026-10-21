/**
 * fs-observation-policy 插件的词汇表：用于通过收窄 `fs/*` 事件所携带的不透明 `object`
 * actor 来派生已观测状态 owner 所需的最小执行上下文字段。
 *
 * 提供者侧的词汇（`FsTarget`、`FsVersion`、写入/编辑请求类型）复用自
 * `@deepseek-ai/dsh-fs`；本包只在其上拥有"已观测状态 owner"这一结构。
 *
 * @module @deepseek-ai/dsh-fs-observation-policy/types
 */

/**
 * 策略插件派生已观测状态 owner 所需的工具执行的最小结构化视图。
 * `@deepseek-ai/dsh-tools` 的 `ToolExecution` 就包含这些字段，因此工具把它的 `exec`
 * 原样作为不透明的 `object` actor 传给 `fs/*` 事件；本插件把该 actor 收窄为
 * `FsObservationActor`，而无须导入 `dsh-tools`、`dsh-agent` 或 `dsh-session`。
 *
 * owner 存在时为 `agent.session`。它被当作不透明的对象同一性（`WeakMap` 的键）；
 * 本包从不读取它的任何字段。
 */
export interface FsObservationActor {
  /** 当存在代为执行此次调用的 agent 时给出该 agent。 */
  agent?: {
    /** 持有已观测文件状态的会话，用作不透明的键。 */
    session?: object
  }
}
