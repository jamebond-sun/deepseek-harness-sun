/**
 * 具备重放感知能力的基础压缩后端的配置词汇。
 *
 * @module @deepseek-ai/dsh-compaction-basic/types
 */

import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'

/** 默认策略与精确模型覆盖所共享的策略字段。 */
export interface CompactionPolicyConfig {
  /** 压力对应的窗口比例；上限为上下文窗口减去预留输出与 `headroomTokens`。默认 `0.8`。 */
  thresholdRatio?: number
  /** 在路由输出预留之外追加的压力余量。非负整数；默认 `65536`。 */
  headroomTokens?: number
  /** 作为上下文窗口（减去预留输出 token）比例而保留的近期上下文。默认 `0.16`。 */
  retainRatio?: number
  /** 绝对的近期上下文预算；与 `retainRatio` 互斥。 */
  retainTokens?: number
  /** 摘要提供方；与 `summarizationModel` 成对设置，或继承对话目标。 */
  summarizationProvider?: string
  /** 摘要模型；与 `summarizationProvider` 成对设置，或继承对话目标。 */
  summarizationModel?: string
  /** 供方为摘要设定的生成上限。默认解析为 `headroomTokens`；显式上限必须为正数。 */
  maxTokens?: number
  /** 首次压缩后、压力仍高于阈值时的额外尝试次数。默认 `1`。 */
  compactionRetries?: number
  /** 规范上下文溢出后的最大重试次数；`0` 表示关闭恢复。默认 `1`。 */
  maxOverflowRetries?: number
}

/** 合并到默认压缩策略之上的精确 provider/model 覆盖。 */
export interface ModelCompactPolicyConfig extends CompactionPolicyConfig {
  /** 需匹配的已注册提供方路由。 */
  provider: string
  /** `provider` 内需匹配的精确路由模型 id。 */
  model: string
}

/** 带可选精确目标策略表的基础压缩配置。 */
export interface BasicCompactionConfig extends CompactionPolicyConfig {
  /** 精确的 provider/model 覆盖；重复目标会使插件加载失败。 */
  modelPolicies?: ModelCompactPolicyConfig[]
  /** 启用自动的步边界压力与溢出恢复监听器。默认 `true`。 */
  auto?: boolean
}

/** 唯一一种经过校验的保留形式。 */
export type ResolvedRetention =
  | { readonly retainRatio: number; readonly retainTokens?: never }
  | { readonly retainRatio?: never; readonly retainTokens: number }

/** 精确目标匹配前后所共享的已校验策略字段。 */
interface ResolvedPolicyFields {
  readonly thresholdRatio: number
  readonly headroomTokens: number
  readonly summarizationProvider: string
  readonly summarizationModel: string
  readonly maxTokens: number
  readonly compactionRetries: number
  readonly maxOverflowRetries: number
}

/** 已校验的不可变配置，其目标特定的默认值仍未被解析。 */
export type ResolvedConfig = ResolvedPolicyFields & ResolvedRetention & {
  readonly modelPolicies: readonly Readonly<ModelCompactPolicyConfig>[]
  readonly auto: boolean
}

/** 某个路由对话目标在容量缩放之前的、完全合并的策略。 */
export type ResolvedTargetPolicy = ResolvedPolicyFields & ResolvedRetention & {
  readonly target: Pick<LlmCallConfig, 'provider' | 'model'>
}

/** 某个路由模型的具体压力与保留预算。 */
export type ResolvedCompactSpec = Omit<ResolvedTargetPolicy, 'retainRatio' | 'retainTokens' | 'headroomTokens'> & {
  /** 适配器声明的完整窗口；以下 token 预算不包含预留输出 token。 */
  readonly contextWindow: number
  readonly thresholdTokens: number
  readonly retainTokens: number
}
