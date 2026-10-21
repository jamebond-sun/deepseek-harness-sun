/** 用户可控的模型选择选择加入的、按 session 的持久化状态。 */

import { z as zod } from 'zod'
import type { Session } from '@deepseek-ai/dsh-session'
import type SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { assertAllowedModelRoutes, type AllowedModelRoute } from './model-selection.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * 记录本 session 的委托工具暴露了子 provider、model 与 reasoning-effort
     * 选择。在首次模型请求之前追加；缺失意味着固定路由定义。仅日志：
     * 它不携带 `surfaceOp`，且从不进入模型历史。
     */
    'subagent/model-selection-policy': {
      /** 本 Session 可以为子代理显式选择的精确路由。 */
      allowedModels: AllowedModelRoute[]
    }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** 被授权用于子 LLM 选择的精确路由，禁用时为 null。 */
    subagentModelSelectionPolicy: AllowedModelRoute[] | null
  }
}

const modelSelectionPolicySchema: zod.ZodType<AllowedModelRoute[] | null> = zod.array(zod.object({
  provider: zod.string().min(1),
  model: zod.string().min(1),
}).strict()).min(1).nullable()

/** 持久化模型选择策略的仅宿主投影。 */
export const subagentModelSelectionProjectionDefinition = {
  key: 'subagentModelSelectionPolicy',
  stateVersion: 1,
  stateSchema: modelSelectionPolicySchema,
  init: () => null,
  apply: (policy, event) => {
    if (policy !== null || event.type !== 'subagent/model-selection-policy') return policy
    const { allowedModels } = event.data
    assertAllowedModelRoutes(allowedModels)
    if (allowedModels.length === 0) {
      throw new Error('subagent/model-selection-policy requires at least one route')
    }
    return allowedModels
  },
} satisfies ProjectionDefinition<'subagentModelSelectionPolicy', AllowedModelRoute[] | null>

/**
 * 读取为一个可选模型定义所捕获的精确路由列表。
 * @param projections - 拥有该策略投影的注册表。
 * @param session - 读取其持久化决定的 session。
 * @returns 已分离的路由列表，固定路由定义时为 undefined。
 */
export function subagentModelSelectionPolicy(
  projections: Pick<SessionProjectionRegistry, 'stateOf'>,
  session: Session,
): AllowedModelRoute[] | undefined {
  return projections.stateOf(session, 'subagentModelSelectionPolicy')?.map(route => ({ ...route }))
}

/**
 * 在其定义能到达模型请求之前追加一次路由策略。
 * @param projections - 拥有该策略投影的注册表。
 * @param session - 接收可选模型定义的 session。
 * @param allowedModels - 该定义可以显式选择的精确路由。
 */
export function recordSubagentModelSelection(
  projections: Pick<SessionProjectionRegistry, 'stateOf'>,
  session: Session,
  allowedModels: readonly AllowedModelRoute[],
): void {
  if (subagentModelSelectionPolicy(projections, session) !== undefined) return
  session.append('subagent/model-selection-policy', {
    allowedModels: allowedModels.map(route => ({ ...route })),
  })
}
