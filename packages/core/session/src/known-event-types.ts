/**
 * 由 `scripts/gen-persistence-catalog.ts` 生成——请勿手工编辑；运行
 * `pnpm run gen-persistence-catalog` 重新生成（由 `pnpm run
 * verify-persistence-catalog` 验证新鲜度，它是 `doc-sync` 的一部分）。
 * @module @deepseek-ai/dsh-session/known-event-types
 */

/**
 * 本仓库声明的每个 `SessionEventMap` 成员——本次构建理解的事件词汇表。持久
 * 化读取路径拒绝解读包含此集合之外类型的日志，除非事件携带信封的
 * `ignorable` 标记（见 `./types.ts` 中的 `SessionEvent.ignorable`）：这样的
 * 日志很可能由更新的 harness 写入，而静默跳过一个必需事件会重建出错误的
 * session。下游（仓库外）插件事件按构造就在此列表之外。持久化的
 * `SessionEvent.ignorable` 标记是兼容性机制；事件名注册被否决，因为它不区
 * 分省略安全性，且会使读取依赖组合方式。理由见
 * `.agents/notes/implemented/architecture/2026-08-30-retain-ignorable-external-session-events.md`。
 */
export const KNOWN_SESSION_EVENT_TYPES: ReadonlySet<string> = new Set([
  'agent-preset/selected',
  'agent/inbox/spliced',
  'approval/asked',
  'approval/decided',
  'approval/policy',
  'assistant/attempt',
  'assistant/message',
  'command/done',
  'command/run',
  'compaction/end',
  'compaction/prune',
  'compaction/start',
  'compaction/summary',
  'deliverables/presented',
  'developer/message',
  'feedback/message-delete',
  'feedback/message-put',
  'feedback/record',
  'goal/change',
  'hook/invoked',
  'hook/result',
  'image/offload',
  'job/registered',
  'job/settled',
  'llm/retry',
  'llm/retry-started',
  'model/selection',
  'permission/preset',
  'plan/mode',
  'request/context',
  'request/header',
  'sandbox/mode',
  'schedule/change',
  'session-log-deepseek/delivery-accepted',
  'session/end-seed',
  'session/title',
  'session/title-llm-request',
  'step/end',
  'step/start',
  'subagent/catalog',
  'subagent/descriptor',
  'subagent/model-selection-policy',
  'system/message',
  'team/member',
  'team/message/delivered',
  'team/message/queued',
  'team/task',
  'todo/write',
  'tool-workflow/agent-end',
  'tool-workflow/agent-start',
  'tool-workflow/run-end',
  'tool-workflow/run-start',
  'tool/call',
  'tool/ptc-dispatch',
  'tool/ptc-dispatch-start',
  'tool/result',
  'turn/end',
  'turn/start',
  'user/message',
  'web/deepseek-search-llm-request',
  'working-directory/change',
  'workspace/changes',
])

/** 其模型可见效果需要显式纯解释器的事件类型。 */
export const MESSAGE_PROJECTION_EVENT_TYPES: ReadonlySet<string> = new Set([
  'image/offload',
])
