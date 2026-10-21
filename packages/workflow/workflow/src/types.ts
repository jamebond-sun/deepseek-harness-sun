/**
 * workflow seam 词汇表：一个 workflow 引擎消费与产出所需的请求/运行/结果类型，
 * 外加 `workflow/*` 事件载荷中的字段。仅类型（外加 id 品牌工厂），遵循包约定。
 *
 * @module @deepseek-ai/dsh-workflow/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** 标识一次 workflow 运行。 */
export type WorkflowRunId = Branded<'WorkflowRunId'>

/**
 * 将一个字符串品牌化为 {@link WorkflowRunId}。
 * @param id - 原始 id 字符串（引擎生成 UUID；测试可能传入 fixture）。
 * @returns 同一个被品牌化的字符串。
 */
export function WorkflowRunId(id: string): WorkflowRunId {
  return id as WorkflowRunId
}

/**
 * 一个脚本 `meta.phases` 中声明的阶段（仅进度词汇 —— 阶段在观察者/UI 中
 * 对代理进行分组；它们不施加任何执行结构）。
 */
export interface WorkflowPhase {
  /** 阶段标题；`phase()` 调用按精确字符串与之匹配。 */
  title: string
  /** 关于该阶段做什么的可选单行描述。 */
  detail?: string
  /** 该阶段预期使用的可选 provider 覆盖（仅供参考）。 */
  provider?: string
  /** 该阶段预期使用的可选 model 覆盖（仅供参考）。 */
  model?: string
}

/**
 * 脚本的身份块，与脚本正文一并作为纯 JSON 数据提供（模型面向的工具将其
 * 作为 `meta` 参数携带），并在正文运行前由引擎校验。`name`/`description`
 * 必填；其余为可选注解。字段词汇与 Claude Code 的动态 workflow meta 块一致。
 */
export interface WorkflowMeta {
  /** 短横线命名的 workflow 名称（展示 + 持久化键）。 */
  name: string
  /** 关于 workflow 做什么的单行描述。 */
  description: string
  /** 关于该 workflow 何时适用的可选指引（在列表中展示）。 */
  whenToUse?: string
  /** 由 `phase()` 调用匹配的可选阶段声明。 */
  phases?: WorkflowPhase[]
}

/**
 * 运行为何结算。CLOSED 联合（引擎拥有，消费者可穷尽）：
 * `completed` = 脚本运行至其最终的 `return`；`cancelled` = 运行被取消
 * （调用方 `cancel()`/信号）；`error` = 脚本抛出、一个致命的 `WorkflowError`
 * 被传播，或结果物化失败。
 */
export type WorkflowStopReason = 'completed' | 'cancelled' | 'error'

/**
 * 一个活跃 workflow 运行所解析出的结果。`value` 是脚本物化后的返回值
 * （纯宿主 realm JSON 数据；脚本返回 `undefined` 时为 `null`）—— 仅对
 * `completed` 有意义。一个非 `completed` 的原因会将失败携带在 `error` 中；
 * 消费者将其映射为一个 `isError` 工具结果，而非报告部分输出。
 */
export interface WorkflowResult {
  /** 脚本的返回值（宿主 JSON 数据；无返回时为 `null`）。 */
  value: unknown
  /** 运行为何结算。 */
  stopReason: WorkflowStopReason
  /** 失败消息（仅当 `stopReason` 不是 `completed` 时存在）。 */
  error?: string
  /**
   * 该运行在其整个生命周期内接受了的 `agent()` 调用数量。在优雅结算时，
   * 这是脚本侧的计数（仍在排队等待并发槽位的调用也包括在内）；在终止路径上
   * （取消或进程失败）它退化为宿主观测到的计数 —— 那时终止脚本内排队的
   * 调用是不可知的。
   */
  agentsStarted: number
}

/** 一次运行的标识细节，由每一个 `workflow/*` 事件作为借来的不可变数据携带，绝非活跃运行本身。 */
export interface WorkflowRunInfo {
  /** 运行的 id。 */
  id: WorkflowRunId
  /** 运行已校验的 meta 块。 */
  meta: WorkflowMeta
}

/** 一次运行内一个 `agent()` 调用的身份（即 `workflow/agent-start` 载荷）。 */
export interface WorkflowAgentInfo {
  /** 该 `agent()` 调用在运行内的 1 基序号。 */
  seq: number
  /** 展示标签（`label` 选项，或提示片段）。 */
  label: string
  /** 该代理所属的阶段（`phase` 选项，否则为当前 `phase()` 标题）。 */
  phase?: string
  /** 子代理 seam 上的子代理 id。 */
  childId: SessionId
}

/** 一个 `agent()` 调用如何结算：干净结果、子项失败（脚本看到 `null`），或运行取消。 */
export type WorkflowAgentOutcome = 'completed' | 'failed' | 'cancelled'

/** 一个 `agent()` 调用的结算（即 `workflow/agent-end` 载荷）。 */
export interface WorkflowAgentEndInfo extends WorkflowAgentInfo {
  /** 该调用如何结算。 */
  outcome: WorkflowAgentOutcome
}

/**
 * 作为事件数据的一个已结算运行的结果（即 `workflow/end` 载荷）：
 * {@link WorkflowResult} 减去 `value`（一个观察结果的监听器不得收到对调用方
 * 结果值的可变别名；需要该值的消费者应持有运行并 await `result`）。
 */
export interface WorkflowResultInfo {
  /** 运行为何结算。 */
  stopReason: WorkflowStopReason
  /** 失败消息（仅当 `stopReason` 不是 `completed` 时存在）。 */
  error?: string
  /** 该运行接受了多少次 `agent()` 调用（见 {@link WorkflowResult.agentsStarted}）。 */
  agentsStarted: number
}
