/** 一个 workflow guest 与其所属宿主运行之间的 JSON 回调。 */

import type { WorkflowAgentEndInfo, WorkflowAgentInfo } from '@deepseek-ai/dsh-workflow'
import type { ChildResult, ChildStartRequest, WorkerInit } from './types.ts'

/** 宿主为一个已发布子项分配的引用。 */
export interface StartedWorkflowChild {
  /** 逐运行的回调标识符，由宿主分配。 */
  callId: number
  /** 子代理 provider 发布的子项标识。 */
  childId: string
}

/** 指向属于本 workflow 运行的一个子项的回调。 */
export interface WorkflowChildRequest {
  /** 宿主分配的回调标识符。 */
  callId: number
}

/** 在 guest 终结结果之前发送的进度。 */
export type WorkflowProgress =
  | { type: 'phase'; title: string }
  | { type: 'log'; message: string }
  | { type: 'agent-start'; info: WorkflowAgentInfo }
  | { type: 'agent-end'; info: WorkflowAgentEndInfo }

/** 通过 PTC 运行时的 JSON 绑定命名空间暴露的宿主函数。 */
export interface WorkflowGuestHost {
  /**
   * 在执行前读取已校验的脚本及其输入。
   * @param input - 空的请求对象。
   * @returns 本 workflow 运行的输入。
   */
  begin(input: Record<string, never>): Promise<WorkerInit>
  /**
   * 通过配置好的子代理 provider 发布一个子项。
   * @param request - 提示与已校验的脚本选项。
   * @returns 宿主分配的子项引用。
   */
  startChild(request: ChildStartRequest): Promise<StartedWorkflowChild>
  /**
   * 观察一个已发布子项的终结结果。
   * @param request - 宿主分配的该子项引用。
   * @returns 子项的 JSON 结果；基础设施故障会 reject。
   */
  childResult(request: WorkflowChildRequest): Promise<ChildResult>
  /**
   * 加入对一个已发布子项的释放。
   * @param request - 宿主分配的该子项引用。
   * @returns 宿主完成释放后为 null。
   */
  disposeChild(request: WorkflowChildRequest): Promise<null>
  /**
   * 发布一批有序的、属于本 workflow 运行的进度。
   * @param events - 按发出顺序排列的脚本叙述与子项生命周期数据。
   * @returns 宿主接收每个事件后为 null。
   */
  progress(events: WorkflowProgress[]): Promise<null>
}
