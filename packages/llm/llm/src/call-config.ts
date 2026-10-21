/**
 * 对话调用配置与冻结工具。提供方路由、模型、推理强度与采样值都是
 * 可能影响缓存复用的请求头状态；请求瀑布会替换它们，而循环会记录
 * 发生变化的快照，而不是允许按调用静默漂移。
 * @module dsh-llm/call-config
 */

import type { GenerateOptions, LlmResolvedModelInfo } from './types.ts'
import type { ReasoningEffortId } from './brand.ts'

/** 由 dsh-agent-loop 组装的请求对象的进程内身份。 */
const AGENT_LOOP_REQUESTS = new WeakSet<GenerateOptions>()

/** 具体的生成设置；省略的控制项使用所选路由的默认值。 */
export interface LlmCallControls {
  reasoningEffort?: ReasoningEffortId
  temperature?: number
  maxTokens?: number
  stop?: string[]
}

// TODO(call-config-shape): 重新审视哪些字段为了缓存复用而属于 epoch 级，
// 以及提供方特有的请求选项应当归属何处。
/**
 * 一次对话的各个请求的提供方、模型、推理强度与采样标量。
 * 每个字段都与 `GenerateOptions` 中同名字段一一对应；
 * 循环从已记录的请求头构建请求，而不是按调用接受这些值。
 */
export interface LlmCallConfig extends LlmCallControls {
  provider: string
  model: string
}

/**
 * 在应用默认值与校验之前，对一次调用进行的同步、纯配置。
 * 按期望的顺序组合各个函数；较晚的写入替换较早的写入。
 * 所返回的控制项无法改变已捕获的路由。错误会在分发之前拒绝这次准备；
 * 只有已解析的配置才是可记录的。
 * @param controls - 已分离、深度冻结的、待提议的控制项，不含默认值。
 * @param model - 来自已捕获适配器配置的、已分离且深度冻结的元数据。
 * @returns 具体的控制项；被省略的字段会取该路由的默认值。
 */
export type ConfigureCall = (
  controls: Readonly<LlmCallControls>,
  model: Readonly<LlmResolvedModelInfo>,
) => LlmCallControls

/**
 * 由精确模型适配器解析所提供、而非由调用方的请求提议所提供的生效配置字段。
 */
export interface LlmCallConfigAdapterDefaults {
  reasoningEffort?: true
  maxTokens?: true
}

/**
 * 在 {@link LlmCallConfig} 之上进行的逐字段相等比较——调用方用它来决定
 * 一个被提议的配置是一次真实变更（值得记录一次请求头快照），
 * 还是既有配置的重复陈述。
 * @param a - 其中一个配置。
 * @param b - 另一个配置。
 * @returns 是否每个字段（包括 `stop` 列表，逐元素）都匹配。
 */
export function callConfigEquals(a: LlmCallConfig, b: LlmCallConfig): boolean {
  if (
    a.provider !== b.provider
    || a.model !== b.model
    || a.reasoningEffort !== b.reasoningEffort
    || a.temperature !== b.temperature
    || a.maxTokens !== b.maxTokens
  ) return false
  if (a.stop === undefined || b.stop === undefined) return a.stop === b.stop
  return a.stop.length === b.stop.length && a.stop.every((s, i) => s === b.stop?.[i])
}

/**
 * 把一个精确的请求对象标记为由 dsh-agent-loop 组装。
 * @param request - LLM 分发之前、由循环持有的请求信封。
 * @returns 同一个请求对象，被标记为进程内 agent 循环所创建。
 */
export function markAgentLoopRequest<T extends GenerateOptions>(request: T): T {
  AGENT_LOOP_REQUESTS.add(request)
  return request
}

/**
 * 测试该精确的请求对象是否由 dsh-agent-loop 组装。
 * @param request - 在 LLM 瀑布处观察到的请求信封。
 * @returns {@link markAgentLoopRequest} 是否记录过这个对象。
 */
export function isAgentLoopRequest(request: GenerateOptions): boolean {
  return AGENT_LOOP_REQUESTS.has(request)
}
