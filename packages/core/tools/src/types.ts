/**
 * 与仅类型消费方共享的持久化工具事件词汇表。
 *
 * @module @deepseek-ai/dsh-tools/types
 */

import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** 一个嵌套 PTC 模式工具分发开始时记录的载荷。 */
export interface PtcDispatchStartEventData {
  rootCallId: ToolCallId
  parentCallId: ToolCallId
  subCallId: ToolCallId
  name: string
  arguments: unknown
}

/** 一个嵌套 PTC 模式工具分发落定时记录的载荷。 */
export interface PtcDispatchEventData extends PtcDispatchStartEventData {
  isError: boolean
  content: ContentBlock[]
  /** 可重放的工具自有展示元数据，与模型内容分开。 */
  meta?: JsonValue
  /** 可选的失败身份与原始面向用户的细节，在面向模型内容之外。 */
  error?: { name: string; code: string; reason?: string }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * `run_code` 程序内一个子分发开始（STARTING）：父 `run_code` 调用 id、
     * 不透明的子调用 id（新调用使用 `<parent>:ptc:<n>`，按提交顺序编号），
     * 以及工具 `name` 及其 JSON 规范化的 `arguments`——分发前的精确值，
     * 在分发之前规范化，因此此追加绝不会因载荷形态而失败。在调度器实际
     * 启动调用时追加（而非提交时），因此 start 意味着已进入工具主体管线；
     * 在队列中被放弃的调用不记录任何内容。仅日志：`deriveMessages()` 忽略
     * 它；UI 用它呈现每个子调用的实时运行状态，并按 `subCallId` 与
     * `tool/ptc-dispatch` 配对（计时 = 两个事件的 `time` 字段）。
     */
    'tool/ptc-dispatch-start': PtcDispatchStartEventData
    /**
     * 一个桥接子分发落定（SETTLING）：配对 id（与相同 `subCallId` 的
     * `tool/ptc-dispatch-start` 匹配）、工具 `name` 与相同的 JSON 规范化
     * `arguments`，以及子调用以 `tool/result` 自身词汇表达的完整持久化
     * 结果（`content` + `isError` + 可选的展示 `meta` 与结构化 `error`），
     * 使 UI 与 SDK 用与原生调用完全相同的路径渲染子调用。每个已启动的
     * 子调用恰好以其中一个落定（含中止：被中止的管线结果是 `isError`
     * 结果）。
     * 仅日志：`deriveMessages()` 忽略它，子调用因此绝不重新进入模型上下文；
     * 持久化与 UI 获得每次调用。在父 `run_code` 的执行内追加（桥接层在返回
     * 前排空进行中的分发），因此其执行包含关系按构造成立。
     */
    'tool/ptc-dispatch': PtcDispatchEventData
  }
}
