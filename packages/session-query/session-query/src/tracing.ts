/** 一次性的会话谱系与事件关系追踪辅助函数。 */

import { currentSessionMessageProjections } from '@deepseek-ai/dsh-session-format-catalog/message-projections'
import { foldSurface, isSurfaceEvent, snapshotSessionEvent } from '@deepseek-ai/dsh-session'
import type {
  SessionEvent,
  SessionId,
  SessionSeq,
  SurfaceEvent,
} from '@deepseek-ai/dsh-session'
import { SessionQueryError } from './config.ts'
import type {
  SessionEventRecord,
  SessionEventTrace,
  SessionLineageNode,
  SessionLineageTrace,
  SessionRecord,
} from './types.ts'

interface EventLogAnalysis {
  records: SessionEventRecord[]
  replacedBy: Map<SessionSeq, SessionSeq>
  replacedEventSeqs: Map<SessionSeq, SessionSeq[]>
  currentSeqs: SessionSeq[]
}

/**
 * 用一次规范的 surface 折叠对原始事件日志分类。
 * @param sessionId - 事件日志的属主。
 * @param events - 分离的原始事件日志。
 * @returns 按日志顺序（升序）排列的轻量记录。
 */
export function eventRecords(
  sessionId: SessionId,
  events: readonly SessionEvent[],
): SessionEventRecord[] {
  return analyzeEventLog(sessionId, events).records
}

/**
 * 在校验完整日志之后折叠并返回当前的模型 surface。
 * @param sessionId - 用于查询诊断信息的属主。
 * @param events - 来自一次语料观察的分离原始事件日志。
 * @returns 按折叠顺序排列的、分离的当前 surface 事件。
 */
export function currentSurfaceEvents(
  sessionId: SessionId,
  events: readonly SessionEvent[],
): SurfaceEvent[] {
  const analysis = analyzeEventLog(sessionId, events)
  return analysis.currentSeqs.map((seq) => {
    const event = events[seq]
    /* v8 ignore next 6 -- analyzeEventLog 已校验 seq 连续，且 foldSurface 只返回 surface 事件的 seq。 */
    if (event === undefined || event.seq !== seq || !isSurfaceEvent(event)) {
      throw new SessionQueryError(
        `invalid session surface: current node ${seq} is not a surface event`,
        'SESSION_QUERY_INVALID_SURFACE',
      )
    }
    return snapshotSessionEvent(event)
  })
}

/**
 * 在一次规范的 surface 折叠与全日志校验之后追踪一个目标事件。
 * @param sessionId - 事件日志的属主。
 * @param events - 分离的原始事件日志。
 * @param seq - 目标事件 seq。
 * @returns 直接的 surface 替换关系，以及与被引用的源事件之间的关系。
 */
export function traceEvent(
  sessionId: SessionId,
  events: readonly SessionEvent[],
  seq: SessionSeq,
): SessionEventTrace {
  const target = events[seq]
  if (target === undefined || target.seq !== seq) {
    throw new SessionQueryError(
      `session "${sessionId}" has no event at seq ${seq}`,
      'SESSION_QUERY_EVENT_NOT_FOUND',
    )
  }

  const analysis = analyzeEventLog(sessionId, events)

  const replacementChain: SessionSeq[] = []
  let replacement = analysis.replacedBy.get(seq)
  while (replacement !== undefined) {
    replacementChain.push(replacement)
    replacement = analysis.replacedBy.get(replacement)
  }

  const derivedEventSeqs: SessionSeq[] = []
  for (const event of events) {
    if (event.seq <= seq) continue
    if (eventSources(event).includes(seq)) derivedEventSeqs.push(event.seq)
  }

  // 上面的目标检查已证明该索引处的平行记录存在。
  // oxlint-disable-next-line typescript/no-non-null-assertion
  const targetRecord = analysis.records[seq]!
  const replacedBy = analysis.replacedBy.get(seq)
  return {
    target: targetRecord,
    ...replacedBy === undefined ? {} : { replacedBy },
    replacementChain,
    replacedEventSeqs: analysis.replacedEventSeqs.get(seq) ?? [],
    sourceEventSeqs: [...eventSources(target)],
    derivedEventSeqs,
  }
}

/**
 * 追踪一个目标的已知祖先链与递归已知后代。
 * @param records - 来自一次观察的完整逻辑语料。
 * @param sessionId - 目标会话 id。
 * @returns 完整的谱系，或显式标注为不完整的谱系。
 */
export function traceSession(
  records: readonly SessionRecord[],
  sessionId: SessionId,
): SessionLineageTrace {
  const byId = new Map(records.map(record => [record.header.id, record]))
  const target = byId.get(sessionId)
  if (target === undefined) {
    throw new SessionQueryError(
      `session "${sessionId}" not found`,
      'SESSION_QUERY_SESSION_NOT_FOUND',
    )
  }

  const ancestors: SessionRecord[] = []
  const ancestrySeen = new Set<SessionId>([sessionId])
  let unresolvedParentId: SessionId | undefined
  let parentId = target.header.parentSession
  while (parentId !== undefined) {
    if (ancestrySeen.has(parentId)) {
      throw new SessionQueryError(
        `session lineage contains a cycle at "${parentId}"`,
        'SESSION_QUERY_INVALID_LINEAGE',
      )
    }
    ancestrySeen.add(parentId)
    const parent = byId.get(parentId)
    if (parent === undefined) {
      unresolvedParentId = parentId
      break
    }
    ancestors.push(parent)
    parentId = parent.header.parentSession
  }

  const childrenByParent = new Map<SessionId, SessionRecord[]>()
  for (const record of records) {
    const parent = record.header.parentSession
    if (parent === undefined) continue
    const children = childrenByParent.get(parent) ?? []
    children.push(record)
    childrenByParent.set(parent, children)
  }
  for (const children of childrenByParent.values()) {
    children.sort((a, b) => a.header.createdAt - b.header.createdAt || a.header.id.localeCompare(b.header.id))
  }

  const descendants = buildDescendants(childrenByParent, sessionId)
  const common = {
    target: cloneRecord(target),
    ancestors: ancestors.map(cloneRecord),
    descendants,
  }
  if (unresolvedParentId !== undefined) {
    return { ...common, complete: false, unresolvedParentId }
  }
  return {
    ...common,
    complete: true,
    root: cloneRecord(ancestors.at(-1) ?? target),
  }
}

function analyzeEventLog(
  sessionId: SessionId,
  events: readonly SessionEvent[],
): EventLogAnalysis {
  let folded: ReturnType<typeof foldSurface>
  try {
    folded = foldSurface(events, currentSessionMessageProjections)
  } catch (error: unknown) {
    throw new SessionQueryError(
      /* v8 ignore next -- foldSurface 抛出的都是 Error 实例 */
      `invalid session surface: ${error instanceof Error ? error.message : 'unknown error'}`,
      'SESSION_QUERY_INVALID_SURFACE',
      { cause: error },
    )
  }
  const current = new Set(folded.nodes)
  const replacedBy = new Map<SessionSeq, SessionSeq>()
  const replacedEventSeqs = new Map<SessionSeq, SessionSeq[]>()
  for (const replacement of folded.replacements) {
    const removed = replacement.shadowedSeqs
    replacedEventSeqs.set(replacement.seq, removed)
    for (const removedSeq of removed) {
      replacedBy.set(removedSeq, replacement.seq)
    }
  }
  return {
    records: events.map(event => ({
      sessionId,
      seq: event.seq,
      type: event.type,
      time: event.time,
      surface: current.has(event.seq)
        ? 'current'
        : replacedBy.has(event.seq) ? 'shadowed' : 'log-only',
    })),
    replacedBy,
    replacedEventSeqs,
    currentSeqs: [...folded.nodes],
  }
}

function eventSources(event: SessionEvent): readonly SessionSeq[] {
  return event.sourceEventSeqs ?? []
}

function buildDescendants(
  childrenByParent: ReadonlyMap<SessionId, readonly SessionRecord[]>,
  sessionId: SessionId,
): SessionLineageNode[] {
  const descendants: SessionLineageNode[] = []
  const stack = [{ sessionId, descendants }]
  while (stack.length > 0) {
    // 长度守卫已证明存在一帧。
    // oxlint-disable-next-line typescript/no-non-null-assertion
    const frame = stack.pop()!
    const nodes: SessionLineageNode[] = []
    for (const child of childrenByParent.get(frame.sessionId) ?? []) {
      const node = { session: cloneRecord(child), descendants: [] }
      nodes.push(node)
      frame.descendants.push(node)
    }
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      // 循环边界已证明该索引处的节点存在。
      // oxlint-disable-next-line typescript/no-non-null-assertion
      const node = nodes[index]!
      stack.push({ sessionId: node.session.header.id, descendants: node.descendants })
    }
  }
  return descendants
}

function cloneRecord(record: SessionRecord): SessionRecord {
  return { ...record, header: structuredClone(record.header) }
}
