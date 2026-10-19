/**
 * 面向完整 `request/header` session 事件的请求 header 重建工具。任何持有
 * session 日志的人，通过取最新的规范快照即可重建任意请求构建时所用的
 * {@link EpochHeader}；循环使用同一个相等性 helper 以避免记录未变化的
 * header。
 *
 * @module dsh-session/request-header
 */

import { callConfigEquals } from '@deepseek-ai/dsh-llm'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { EpochHeader, SessionEvent } from './types.ts'

/**
 * 把 header 规范化：空工具列表变为缺席字段，与请求的构建方式一致。
 * 记录、折叠与比较都使用这一种表示。
 * @param header - 要规范化的 header（不修改）。
 * @returns 规范 header。
 */
export function canonicalHeader(header: EpochHeader): EpochHeader {
  const adapterDefaults = header.adapterDefaults
  return {
    config: header.config,
    ...adapterDefaults?.reasoningEffort === true || adapterDefaults?.maxTokens === true
      ? { adapterDefaults }
      : {},
    ...header.tools !== undefined && header.tools.length > 0 ? { tools: header.tools } : {},
  }
}

/** 通过同一路径组装的工具 schema 的规范 JSON 相等性。 */
function sameSchema(a: ToolSchema, b: ToolSchema): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * 逐字段比较规范 header。工具 schema 按顺序比较。
 * @param a - 一个规范 header。
 * @param b - 另一个。
 * @returns config、adapter 默认值与工具是否全部匹配。
 */
export function headerEquals(a: EpochHeader, b: EpochHeader): boolean {
  if (
    !callConfigEquals(a.config, b.config)
    || a.adapterDefaults?.reasoningEffort !== b.adapterDefaults?.reasoningEffort
    || a.adapterDefaults?.maxTokens !== b.adapterDefaults?.maxTokens
  ) return false
  const at = a.tools ?? []
  const bt = b.tools ?? []
  return at.length === bt.length && at.every((tool, i) => sameSchema(tool, bt[i] as ToolSchema))
}

/**
 * 把日志（或任意前缀）的 header 事件折叠为最后一个快照之后生效的
 * {@link EpochHeader}。非 header 事件被跳过。这是纯离线重建路径；活跃
 * session 以增量方式执行同一折叠。
 * @param events - 按日志顺序排列的 session 事件。
 * @param from - 要延续的先前折叠状态。
 * @returns 最新的规范 header，尚无时为 undefined。
 */
export function foldRequestHeader(events: readonly SessionEvent[], from?: EpochHeader): EpochHeader | undefined {
  let state = from
  for (const event of events) {
    if (event.type === 'request/header') state = canonicalHeader(event.data.header)
  }
  return state
}
