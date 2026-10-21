/** 为每个 released-v0 事件类型冻结的精确顶层载荷处置方式。 */
export interface ReleasedV0PayloadDisposition {
  readonly required: readonly string[]
  readonly optional: readonly string[]
  /** 其嵌套表示有意保持为持有者不透明的 JSON 成员。 */
  readonly opaque: readonly string[]
}

/**
 * 为相邻格式校验器冻结一份精确的 released 载荷成员处置方式。
 * @param required - 必须存在的成员。
 * @param optional - 额外被接纳的成员。
 * @param opaque - 作为无损 JSON 保留、不做嵌套语义检查的成员。
 * @returns 已分离的冻结处置方式。
 */
export function defineReleasedPayloadDisposition(
  required: readonly string[],
  optional: readonly string[] = [],
  opaque: readonly string[] = [],
): ReleasedV0PayloadDisposition {
  return Object.freeze({
    required: Object.freeze([...required]),
    optional: Object.freeze([...optional]),
    opaque: Object.freeze([...opaque]),
  })
}

const disposition = defineReleasedPayloadDisposition

/**
 * 已冻结的 released-v0 事件与载荷成员清单。
 * 恒等边会保留列出的每个成员。`opaque` 中的成员保持为无损 JSON，
 * 不做嵌套的 Session 序列解释。嵌套的可合并扩展判别式校验已知变体，
 * 并将未知变体作为持有者不透明的 JSON 保留。
 */
export const RELEASED_V0_EVENT_DISPOSITIONS: Readonly<Record<string, ReleasedV0PayloadDisposition>> = Object.freeze({
  'agent-preset/selected': disposition(['agentPreset']),
  'agent/inbox/spliced': disposition(
    ['target', 'start', 'inserted'],
    ['removedCount', 'outcome'],
  ),
  'approval/asked': disposition(['id', 'toolName'], ['callId', 'reason']),
  'approval/decided': disposition(['id', 'outcome']),
  'approval/policy': disposition(['policy'], ['source']),
  'assistant/chunk': disposition(['turn', 'step', 'chunk']),
  'assistant/message': disposition(
    ['turn', 'step', 'message'],
    ['usage', 'interrupted'],
  ),
  'command/done': disposition(['commandId', 'kind'], ['text', 'sourceEventSeq']),
  'command/run': disposition(['commandId', 'name', 'source'], ['args']),
  'compaction/end': disposition(['compactionId', 'turn'], ['sourceCommandId', 'error']),
  'compaction/prune': disposition(['shadowedRange', 'shadowedSeqs', 'shadowedTokenCount']),
  'compaction/start': disposition(['compactionId', 'turn'], ['sourceCommandId']),
  'compaction/summary': disposition(
    ['compactionId', 'summary', 'shadowedRange', 'shadowedSeqs', 'shadowedTokenCount', 'provider', 'model'],
    ['sourceCommandId', 'maxTokens', 'usage', 'rawOutput', 'llmStreamCall'],
  ),
  'feedback/record': disposition(['text']),
  'goal/change': disposition(
    ['kind', 'version', 'operation'],
    ['goal', 'roundsStarted', 'createdAt', 'updatedAt', 'cleared', 'clearedAt'],
  ),
  'hook/invoked': disposition(['turn', 'point', 'dialect', 'handlerId'], ['matcher']),
  'hook/result': disposition(
    ['turn', 'point', 'handlerId', 'decision', 'durationMs'],
    ['exitCode', 'stderrSummary'],
  ),
  'llm/retry': disposition(
    ['retryId', 'turn', 'step', 'provider', 'mode', 'policyKey', 'retry', 'delayMs', 'failure'],
    ['maxRetries'],
  ),
  'llm/retry-started': disposition(['retryId', 'turn', 'step', 'retry']),
  'model/selection': disposition(['provider', 'model'], ['reasoningEffort']),
  'permission/preset': disposition(['preset']),
  'plan/mode': disposition(['active']),
  'request/context': disposition(['provider', 'model'], ['contextWindow']),
  'request/header': disposition(['header', 'reason'], ['startsSeries']),
  'sandbox/mode': disposition(['mode'], ['source']),
  'schedule/change': disposition(['version', 'operation'], ['schedule', 'id', 'acceptedAt']),
  'session-log-deepseek/delivery-accepted': disposition(
    ['sessionId', 'throughSeq'],
  ),
  'session/end-seed': disposition([]),
  'session/title': disposition(['title', 'messageSeqs', 'source']),
  'session/title-llm-request': disposition(
    ['titleProvider', 'messageSeqs', 'route', 'system', 'messages', 'maxTokens'],
  ),
  'step/end': disposition(['turn', 'step']),
  'step/start': disposition(['turn', 'step']),
  'subagent/descriptor': disposition(
    ['mode', 'version', 'provider'],
    ['label', 'agentProvider', 'agentModel', 'agentReasoningEffort', 'persona', 'toolFilter'],
  ),
  'subagent/model-selection-policy': disposition(['allowedModels']),
  'team/member': disposition(['version', 'teamId', 'member']),
  'team/message/delivered': disposition(['version', 'teamId', 'messageId', 'targetId']),
  'team/message/queued': disposition(['version', 'teamId', 'message']),
  'team/task': disposition(['version', 'teamId', 'task']),
  'todo/write': disposition(['todos']),
  'tool-workflow/agent-end': disposition(['runId', 'seq', 'outcome']),
  'tool-workflow/agent-start': disposition(['runId', 'seq', 'label', 'childId'], ['phase']),
  'tool-workflow/run-end': disposition(['runId', 'stopReason']),
  'tool-workflow/run-start': disposition(['runId', 'name']),
  'tool/call': disposition(['turn', 'step', 'callId', 'name', 'arguments']),
  'tool/code-dispatch': disposition(
    ['rootCallId', 'parentCallId', 'subCallId', 'name', 'arguments', 'isError', 'content'],
    [],
    ['arguments'],
  ),
  'tool/code-dispatch-start': disposition(
    ['rootCallId', 'parentCallId', 'subCallId', 'name', 'arguments'],
    [],
    ['arguments'],
  ),
  'tool/result': disposition(
    ['turn', 'step', 'message'],
    ['error', 'meta'],
    ['meta'],
  ),
  'turn/end': disposition(['turn', 'reason']),
  'turn/start': disposition(['turn']),
  'user/message': disposition(['role', 'id', 'content', 'source']),
  'web/deepseek-search-llm-request': disposition(['endpoint', 'apiVersion', 'body']),
})

/** 稳定排序的 released-v0 事件清单。 */
export const RELEASED_V0_EVENT_TYPES: readonly string[] = Object.freeze(
  Object.keys(RELEASED_V0_EVENT_DISPOSITIONS).sort((left, right) => left.localeCompare(right, 'en')),
)
