/**
 * 针对会话表层的工具配对平衡。压缩会改变表层位置，因此安全的切割点
 * 是基于当前表层顺序中的工具调用/结果内容派生的，而非基于步骤标记。
 * @module @deepseek-ai/dsh-compaction/tool-pairing
 */

import type { Session, SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'

/** 一次会话表层生成的增量平衡状态。 */
interface BalanceCache {
  /** 本状态所描述的表层重写代次。 */
  generation: number
  /**
   * 当前顺序下每个表层切割点的平衡性：一个包含 N 个序列的表层有
   * N + 1 个切割点，第 `i` 项为序列 `i` 之前的切割点，最后一项为
   * 表层尾部之后的切割点。
   */
  cutBalanced: readonly boolean[]
  /** 每个事件 seq 的当前表层位置，用于索引 {@link cutBalanced}。 */
  indexBySeq: Map<SessionSeq, number>
  /** 已处理的表层尾部之后的进行中工具调用计数。 */
  inProgressToolCalls: number
}

const balanceCacheBySession = new WeakMap<Session, BalanceCache>()

/** 返回单个表层事件如何改变进行中的工具调用计数。 */
function eventDelta(event: SessionEvent): number {
  switch (event.type) {
    case 'assistant/message':
      return event.data.message.content.filter(block => block.type === 'tool-call').length
    case 'tool/result':
      return -1
    default:
      return 0
  }
}

/** 将缓存中尚不存在的表层序列并入其平衡状态。 */
function extendCache(
  session: Session,
  cache: BalanceCache,
  seqs: readonly SessionSeq[],
): BalanceCache {
  const processed = cache.cutBalanced.length - 1
  const tail = seqs.slice(processed)
  // 在修改活动缓存之前先校验尚未可见的尾部，这样一段损坏的
  // 追加就不会留下半完成的前进状态。
  const pendingCuts: boolean[] = []
  let inProgressToolCalls = cache.inProgressToolCalls
  for (const seq of tail) {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const event = session.eventAt(seq)
    if (event === undefined || event.seq !== seq) {
      throw new Error(`tool-pairing balance: surface seq ${seq} has no matching session event (corrupt surface)`)
    }
    inProgressToolCalls += eventDelta(event)
    if (inProgressToolCalls < 0) {
      throw new Error(`tool-pairing balance: tool/result at surface seq ${seq} has no matching tool-call (corrupt surface)`)
    }
    pendingCuts.push(inProgressToolCalls === 0)
  }

  tail.forEach((seq, offset) => cache.indexBySeq.set(seq, processed + offset))
  cache.cutBalanced = cache.cutBalanced.concat(pendingCuts)
  cache.inProgressToolCalls = inProgressToolCalls
  return cache
}

/** 返回与当前会话表层保持同步的平衡状态。 */
function balanceCache(session: Session): BalanceCache {
  const surface = session.surface
  const seqs = surface.nodes
  const generation = surface.replaceGeneration
  const cached = balanceCacheBySession.get(session)

  if (cached === undefined || cached.generation !== generation || cached.cutBalanced.length - 1 > seqs.length) {
    // 重建即是从空表层状态开始的同一次折叠，其唯一的起始切割点天然是平衡的。
    const rebuilt = extendCache(session, {
      generation,
      cutBalanced: [true],
      indexBySeq: new Map(),
      inProgressToolCalls: 0,
    }, seqs)
    balanceCacheBySession.set(session, rebuilt)
    return rebuilt
  }
  if (cached.cutBalanced.length - 1 < seqs.length) return extendCache(session, cached, seqs)
  return cached
}

/** 某序列位置加上偏移处的切割点平衡性，拒绝不在当前成员范围内的 seq。 */
function cutBalance(cache: BalanceCache, seq: SessionSeq, offset: 0 | 1): boolean {
  const index = cache.indexBySeq.get(seq)
  const balanced = index === undefined ? undefined : cache.cutBalanced[index + offset]
  if (balanced === undefined) {
    throw new Error(`tool-pairing balance: surface seq ${seq} not found`)
  }
  return balanced
}

/**
 * 当前表层序列紧邻的前置切割点是否保持了工具配对平衡。
 * @param session - 被检查表层的会话。
 * @param seq - 被检查其前置切割点的事件序列。
 * @returns 当没有未应答的工具调用跨越该切割点时返回 true。
 * @throws 当该 seq 不在当前表层中、某个表层序列没有匹配的日志事件，
 * 或某个工具结果没有前置的开放调用时。
 */
export function toolPairingBalancedBefore(session: Session, seq: SessionSeq): boolean {
  return cutBalance(balanceCache(session), seq, 0)
}

/**
 * 当前表层序列紧邻的后置切割点是否保持了工具配对平衡。
 * @param session - 被检查表层的会话。
 * @param seq - 被检查其后置切割点的事件序列。
 * @returns 当没有未应答的工具调用跨越该切割点时返回 true。
 * @throws 当该 seq 不在当前表层中、某个表层序列没有匹配的日志事件，
 * 或某个工具结果没有前置的开放调用时。
 */
export function toolPairingBalancedAfter(session: Session, seq: SessionSeq): boolean {
  return cutBalance(balanceCache(session), seq, 1)
}
