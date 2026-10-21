/**
 * Todo 领域的纯类型：这里是 `todos` 投影键声明的唯一归属，
 * 包含其负载类型，且不依赖本包宿主端的值导入（dsh-tools、zod）。
 * 两个命名空间投影服务于它 —— `./types` 供宿主消费者使用，
 * `./client/types`（浏览器半入口的再导出）供客户端聚合使用 ——
 * 内容零重复。
 *
 * @module @deepseek-ai/dsh-tool-todo/types
 */

/**
 * Agent 待办列表中的一项 —— 本包声明的 `todo/write` 整列表
 * 快照的单位。
 *
 * 刻意保持最小：一条人类可读的 `content` 文本，以及三态的
 * `status`。没有 id、优先级或 `activeForm` —— 列表在每次写入时
 * 整体替换（后写覆盖），因此条目无需稳定标识。三种状态描述了
 * 模型与 UI 消费者所需的完整可移植生命周期。
 */
export interface TodoItem {
  /** 本任务的内容 —— UI 中展示的一句简短祈使句。 */
  content: string
  /** 生命周期状态。`in_progress` 标记当前正在处理的任务；并行任务可标记多个。 */
  status: 'pending' | 'in_progress' | 'completed'
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** 整列表快照；重放时以最新写入为准。仅用于日志的 UI 状态；绝不派生历史。 */
    'todo/write': { todos: TodoItem[] }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    todos: TodoItem[] | null
  }
  interface SessionProjectionMap {
    /**
     * Agent 当前的完整待办列表（最新的 `todo/write` 快照），
     * 或在首次写入前为 `null`。整值规则：每次 `todo/write`
     * 都携带完整的替换列表，因此折叠为后写覆盖。
     */
    todos: TodoItem[] | null
  }
}
