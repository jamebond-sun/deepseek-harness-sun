/**
 * 上下文压力投影的 O(1) 表面令牌折叠。
 *
 * 它的检查点保存标量总计，而不是度量所使用的保留表面。替换沿着
 * 压缩接缝的影子价格协议进行：紧邻一次表面 `replace`
 * （`compaction/summary` 或 `compaction/prune`）之前的计量事件会声明
 * 被替换区间的精确启发式价格，因此该折叠只保留一个滚动总计，
 * 外加至多一个待处理的声明，而从不保留逐节点价格。
 * 这些计数在构造上就是精确的：生产者用与本模块给追加计价相同的
 * 固定估计器导出它们。一次没有已装备声明的替换会以零增量折叠，
 * 因为有界状态无法重建被替换的区间；这以可能的漂移为代价保留了可回放性。
 *
 * @module @deepseek-ai/dsh-token-meter/surface-projection
 */

import { deriveEventMessage, isSurfaceEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// 仅类型：那些 `compaction/*` SessionEventMap 合并（影子价格事件）。
import type {} from '@deepseek-ai/dsh-compaction'
import { estimateMessage } from './estimate.ts'

/**
 * 一个已装备的影子价格：紧随其后的事件所替换的表面区间的启发式令牌数。
 * 纯 JSON —— 在装备期间它是被持久化单元状态的一部分。
 */
export interface ShadowPriceClaim {
  /** 所声明的、被计价区间的首个表面节点 seq（闭区间）。 */
  start: SessionSeq
  /** 所声明的、被计价区间的最后一个表面节点 seq（闭区间）。 */
  end: SessionSeq
  /** 在固定估计器之下，被计价区间的启发式令牌数。 */
  tokens: number
}

/** 一个事件对一个滚动表面令牌总计的影响。 */
export interface SurfaceTokensFold {
  /** 表面总计的带符号变化；对于不在表面上的事件为 0。 */
  readonly deltaTokens: number
  /** 要带入下一个事件的声明；没有存活的声明时为 undefined。 */
  readonly claim: ShadowPriceClaim | undefined
}

/**
 * 把一个已提交的事件折叠到一个滚动的表面令牌总计上。
 *
 * 影子价格事件会装备一个声明；任何其他事件都会让它过期，而一次表面
 * `replace` 会消费指名了其精确区间的声明——生产者同步且相邻地追加
 * 该计量事件与替换，因此一个存活的声明总是给紧接着的下一个事件计价。
 * 没有声明的替换以零增量折叠，因为有界状态无法重建被替换的区间。
 * 为另一个区间装备的声明仍然会失败，因为相邻的两个事件彼此矛盾。
 * @param claim - 由紧邻的上一个事件所装备的声明，若有。
 * @param event - 下一个已提交的会话事件。
 * @returns 带符号的令牌增量，以及该事件之后的声明状态。
 * @throws 当一次替换到达时却为另一个区间装备了声明——计量事件是相邻的，
 *   因此这是活跃生产者违反影子价格契约，而不是历史数据，必须立即失败，
 *   而不是让总计发生漂移。
 */
export function foldSurfaceProjection(
  claim: ShadowPriceClaim | undefined,
  event: SessionEvent,
): SurfaceTokensFold {
  if (event.type === 'compaction/summary' || event.type === 'compaction/prune') {
    const { shadowedRange, shadowedTokenCount } = event.data
    return {
      deltaTokens: 0,
      claim: {
        start: SessionSeq(shadowedRange.start),
        end: SessionSeq(shadowedRange.end),
        tokens: shadowedTokenCount,
      },
    }
  }
  if (!isSurfaceEvent(event)) return { deltaTokens: 0, claim: undefined }
  const message = deriveEventMessage(event)
  const tokens = message === null ? 0 : estimateMessage(message)
  const op = event.surfaceOp
  if (op === 'append') return { deltaTokens: tokens, claim: undefined }
  // 在影子价格协议之前记录的会话，其替换没有相邻的计量事件；
  // 有界状态无法重建被替换区间的价格，因此中立地折叠它们——
  // 历史回放退化为漂移，而不是失败。
  if (claim === undefined) return { deltaTokens: 0, claim: undefined }
  if (claim.start !== op.startSeq || claim.end !== op.endSeq) {
    throw new Error(
      `token surface: replace at seq ${event.seq} over range ${op.startSeq}-${op.endSeq} has no adjacent shadow price`
      + ` (armed claim covers ${claim.start}-${claim.end})`,
    )
  }
  return { deltaTokens: tokens - claim.tokens, claim: undefined }
}
