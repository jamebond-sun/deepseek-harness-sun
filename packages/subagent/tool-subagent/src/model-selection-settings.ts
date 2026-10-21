/** 宿主机拥有的、用于可选模型选择子代理委托的选择加入设置。 */
import type { Volatile } from '@deepseek-ai/cordis'

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  AllowedModelRouteSchema,
  assertAllowedModelRoutes,
  type AllowedModelRoute,
} from './model-selection.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 当一个新的 Session 收到委托工具时所采样的用户偏好。 */
    subagentModelSelection: SubagentModelSelectionConfig
  }
}

/** 已存储的用户偏好；已发布的组合默认关闭它。 */
export interface SubagentModelSelectionSettings {
  /** 新组合的顶层 Session 是否获得模型选择能力。 */
  enabled: boolean
  /** 提供给新组合的顶层 Session 的精确子 LLM 路由。 */
  allowedModels: AllowedModelRoute[]
}

/** 该偏好的可选部署基线。 */
export interface Config {
  /** 当用户文档未覆盖时继承的初始启用状态。 */
  enabled: Volatile<boolean>
  /** 当用户文档未覆盖时继承的初始路由列表。 */
  allowedModels: Volatile<AllowedModelRoute[]>
}

/** 在为一次 Session 组合委托工具时被读取的单例设置属主。 */
export class SubagentModelSelectionConfig extends Service {
  static Config = z.object({
    enabled: z.boolean().default(false).volatile(),
    allowedModels: z.array(AllowedModelRouteSchema).default([]).volatile(),
  })

  constructor(ctx: Context, private config: Config) {
    super(ctx, 'subagentModelSelection')
  }

  /**
   * 为下一次符合条件的 Session 组合读取一份已分离的选择偏好。
   * @returns 启用状态与精确的允许路由。
   */
  current(): SubagentModelSelectionSettings {
    const enabled = this.config.enabled.get()
    const allowedModels = this.config.allowedModels.get()
    assertAllowedModelRoutes(allowedModels)
    if (enabled && allowedModels.length === 0) {
      throw new Error('enabled subagent model selection requires at least one allowed model')
    }
    return { enabled, allowedModels: allowedModels.map(route => ({ ...route })) }
  }

}

export const name = 'subagent-model-selection-settings'
export default SubagentModelSelectionConfig
