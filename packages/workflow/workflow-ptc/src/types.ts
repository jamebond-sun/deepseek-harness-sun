/**
 * workflow guest 的初始化输入，及其 VM 辅助函数所消费的子项回调。
 * PTC 以无损 JSON 形式传输初始化数据、请求与结果。
 * @module @deepseek-ai/dsh-workflow-ptc/types
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { WorkflowMeta } from '@deepseek-ai/dsh-workflow'

/**
 * guest 辅助函数强制执行的普通脚本限额。
 */
export interface WorkerLimits {
  /** `agent()` 的并发上限（已自动解析；≥ 1）。 */
  maxConcurrentAgents: number
  /** 每次运行 `agent()` 调用总数（失控循环的兜底上限）。 */
  maxTotalAgents: number
  /** 一次 `parallel()`/`pipeline()` 调用所能接受的条目数。 */
  maxItemsPerCall: number
  /** 脚本初始同步片段的 VM 超时。 */
  syncTimeoutMs: number
}

/** 脚本运行前由宿主返回的初始化数据。 */
export interface WorkerInit {
  /** 已校验的 meta 块（来自 start 请求的原始数据，在宿主侧校验）。 */
  meta: WorkflowMeta
  /** 纯 JS 脚本正文，与 start 请求携带的完全一致。 */
  body: string
  /** 该运行的 `args` 值，经由 PTC JSON 通道复制而来。 */
  args?: unknown
  /** guest 辅助函数的各项限额。 */
  limits: WorkerLimits
}

/** 在 guest 校验完脚本选项之后的一个 `agent()` 子项请求。 */
export interface ChildStartRequest {
  /** 子项的提示文本。 */
  prompt: string
  /** 结构化输出 schema，若调用传入（已通过子集检查）。 */
  schema?: ObjectJsonSchema
  /** 逐子项的 provider 覆盖，若调用传入。 */
  provider?: string
  /** 逐子项的 model 覆盖，若调用传入。 */
  model?: string
}

/**
 * 子项 `SubagentResult` 的 JSON 投影。seam 的 `stopReason` 联合是
 * 可合并扩展的，因此在线上退化为 `string` —— 运行时只对 `'completed'`
 * 进行分支判断。
 */
export interface ChildResult {
  /** 子项最终的助手输出块。 */
  output: ContentBlock[]
  /** 结构化值，当且仅当请求携带了 schema 且 provider 兑现了它时存在。 */
  structured?: unknown
  /** 子项运行为何结束（`'completed'` 是运行时唯一会分支判断的值）。 */
  stopReason: string
}

/**
 * 一个已发布子项的 guest 句柄，简化为 VM 辅助函数所消费的形态。
 */
export interface ChildHandle {
  /** 子代理的 id（由子代理 seam 在宿主侧生成）。 */
  readonly id: string
  /**
   * 解析为该子项的终结 {@link ChildResult}；仅当宿主报告
   * 基础设施故障时才 REJECT；一个因自身原因失败的子项会以非
   * `completed` 的结束原因解析。
   */
  readonly result: Promise<ChildResult>
  /** 请求宿主释放该子项；在宿主确认后解析。 */
  dispose(): Promise<void>
}

/**
 * 与 PTC 传输无关的的子项回调。
 */
export interface ChildPort {
  /**
   * 在宿主上启动一个子代理（即 `agent()` 钩子的“启动”半程）。
   * @param request - 提示与已校验的选项。
   * @returns 已发布的子项句柄；当同步启动或 provider 的异步启动失败时 reject。
   */
  startAgent(request: ChildStartRequest): Promise<ChildHandle>
}
