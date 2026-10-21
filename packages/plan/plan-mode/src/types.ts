/**
 * 计划模式领域的纯类型：`plan` 投影键声明的唯一归属，且不含本包的宿主侧值导入
 * （cordis、dsh-tools、dsh-agent）。两个命名空间投影服务于它 —— `./types` 面向
 * 宿主消费方，`./client` 面向客户端聚合 —— 内容零重复。
 *
 * @module @deepseek-ai/dsh-plan-mode/types
 */

import type { CommandId } from '@deepseek-ai/dsh-commands/brand'

/**
 * `plan` 投影的协议值。`active` 是生效中的已记录状态（最后一次 `plan/mode`，
 * 首次之前为 inactive）；`pending` 为 true 的条件是：一条已记录的 `/plan` 选择
 * 的目标状态与 `active` 不同、尚未在其配对的 `command/done` 中失败，且没有更晚的
 * `plan/mode` 事件记录过该状态。能力缺失（未组合 plan-mode）表现为键的缺席，
 * 而不是某个值。
 */
export interface PlanProjection {
  active: boolean
  pending: boolean
}

/** 用于派生 {@link PlanProjection} 的宿主状态。 */
export interface PlanUnitState {
  /** 已记录的计划模式。 */
  active: boolean
  /** 该次选择的目标模式；没有未完成的选择时为 null。 */
  wanted: boolean | null
  /** 最新一条等待其配对结算的计划命令。 */
  running: { commandId: CommandId; wanted: boolean } | null
  /** 最近一次 `request/header` 所记录的生效状态，或 null。 */
  activeAtLastHeader: boolean | null
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** 宿主的 plan-mode 折叠状态。 */
    plan: PlanUnitState
  }
  interface SessionProjectionMap {
    /** 由计划命令生命周期与 `plan/mode` 事件折叠出的计划协作状态。 */
    plan: PlanProjection
  }
}
