// flattenLineage：摘要 -> 带谱系缩进的扁平列表（纯函数）。
// 输入顺序是权威的；谱系只是让每个子级与其父级相邻。
// 孤立的谱系降级为根级；循环软失败并按根输出。

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import type { SessionSummary } from '../../types.ts'

/** 由最新 Session Controller title 投影充实的 Host 列表摘要。 */
export interface TitledSessionSummary extends SessionSummary {
  title?: string
  /** 供列表消费方使用的当前 Host 计算投影值。 */
  projectionValues?: Readonly<Partial<SessionProjectionMap>>
}

/** 一条带谱系深度的展平 session 列表行。 */
export interface SessionListEntry {
  sessionId: SessionId
  title?: string
  updatedAt: number
  running: boolean
  /**
   * New Session 呈现与复用资格，与 `sessionListMetadata` 调和；
   * 列表隐藏空白 session（过滤由消费方负责）。
   */
  blank: boolean
  parentSessionId?: SessionId
  /** 用于导航过滤的粗粒度持久化来源；不是继续会话的能力。 */
  origin?: 'subagent'
  /** Host 列表提供的格式分类。 */
  formatStatus?: SessionSummary['formatStatus']
  cwd?: string
  /** 供列表消费方使用的当前 Host 计算投影值。 */
  projectionValues?: Readonly<Partial<SessionProjectionMap>>
  /** 谱系缩进深度：根 = 0；UI 只是用缩进宽度相乘。 */
  depth: number
}

/**
 * 摘要 -> 带谱系缩进的扁平列表。根与兄弟顺序遵循既定的输入
 * 顺序；该投影绝不依据可变时间戳对已水合的列表重新排序。
 * @param summaries - Host 的 session.list 条目。
 * @returns 按渲染顺序排列的展示行。
 */
export function flattenLineage(
  summaries: readonly TitledSessionSummary[],
): SessionListEntry[] {
  const byId = new Map<SessionId, TitledSessionSummary>()
  for (const s of summaries) byId.set(s.sessionId, s)

  const children = new Map<SessionId, TitledSessionSummary[]>()
  const roots: TitledSessionSummary[] = []
  for (const s of summaries) {
    if (s.parentSessionId !== undefined && byId.has(s.parentSessionId)) {
      const list = children.get(s.parentSessionId) ?? []
      list.push(s)
      children.set(s.parentSessionId, list)
    } else {
      roots.push(s) // 根，或父级不在摘要中的孤立节点（降级为根，绝不丢弃）
    }
  }

  const out: SessionListEntry[] = []
  const visited = new Set<SessionId>()
  const walk = (s: TitledSessionSummary, depth: number): void => {
    if (visited.has(s.sessionId)) {
      console.warn(`[session-controller] lineage cycle at ${s.sessionId}; emitting as root`)
      return
    }
    visited.add(s.sessionId)
    const { agentAvailable: _agentAvailable, ...row } = s
    out.push({
      ...row,
      depth,
    })
    const kids = children.get(s.sessionId)
    if (kids === undefined) return
    for (const kid of kids) walk(kid, depth + 1)
  }
  for (const root of roots) walk(root, 0)
  // 循环成员（从任何根都不可达）：按根输出，避免丢失条目。
  for (const s of summaries) {
    if (!visited.has(s.sessionId)) walk(s, 0)
  }
  return out
}
