/**
 * 面向确切来源事件前缀的分叉 seed 构造。
 * @module @deepseek-ai/dsh-session/fork
 */

import { openTurnClosers } from './repair.ts'
import { SessionSeq } from './types.ts'
import type { SessionEvent, SessionSeq as SessionSeqType } from './types.ts'

/**
 * 复制一个含端点事件前缀，标记其继承切点，并以 forked 结果与 step/turn 收
 * 尾关闭其打开尾部。已关闭的 step 与 turn 保持原样。
 * 调用方验证边界是已存在的连续事件 seq；
 * Session 构造在发布前对借用事件做快照。
 *
 * @param events - 序号从零开始连续的 source 日志。
 * @param boundary - 子级继承到的含端点 source 事件 seq。
 * @returns 保留 source 事件对象的新数组，后跟 `inheritedEventCount` 所计
 *   继承前缀之外的合成收尾事件。
 */
export function buildForkSeed(events: readonly SessionEvent[], boundary: SessionSeqType): SessionEvent[] {
  const prefix = events.slice(0, boundary + 1)
  prefix.push({
    type: 'session/end-seed', seq: SessionSeq(boundary + 1),
    // oxlint-disable-next-line typescript/no-non-null-assertion -- 调用方已验证该确切 source 事件。
    time: events[boundary]!.time,
    data: { inherited: true },
  })
  return prefix.concat(openTurnClosers(prefix, { kind: 'forked' }))
}
