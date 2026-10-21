/**
 * 会话日志中关于「会话实际运行哪个预设」的记录。
 *
 * 创建头部记录了会话「启动时」所用的预设，并且它是深度冻结的，因为那是创建事实。
 * 会话在空白期间仍可更换预设，而这一更换的影响会长于空白窗口：
 * 第一轮——以及之后的每一轮——都在新挂载的组合下运行。
 * 记录这次更换正是让日志保持诚实的原因；仓库的「模型可见 ⟺ 已记录」规则
 * 更是直接要求如此，因为预设决定了模型看到的工具 schema 与提示词段落。
 *
 * 重建时读取 `agentPreset` 会话投影，而绝不只读头部。
 * @module @deepseek-ai/dsh-agent-preset-registry/session
 */

import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * 会话的 agent 预设是在创建之后、会话仍为空白时选择的。仅用于记录：
     * 它记录了后续各轮所运行的组合，因此恢复或分叉出的会话会重建同一个组合，
     * 而不是头部中记录的那次创建时的取值。在子 Session 中，
     * 出现在其首个自有 `subagent/descriptor` 之前的该事件，
     * 标记了一次独立的生成期选择；冷启动恢复会还原该选择，
     * 而不是加入父级的组合（`dsh-subagent` README，“Restoring child composition”）。
     */
    'agent-preset/selected': { agentPreset: string }
  }
}

const agentPresetSchema = z.union([z.string(), z.null()])

/** 当前 Session 的预设，由头部初始化，并由选择事件推进。 */
export const agentPresetProjectionDefinition = {
  key: 'agentPreset',
  stateSchema: agentPresetSchema,
  init: header => header.agentPreset ?? null,
  apply: (state, event) => event.type === 'agent-preset/selected'
    ? event.data.agentPreset
    : state,
  wire: { viewSchema: agentPresetSchema, view: state => state },
  stateVersion: 1,
} satisfies ProjectionDefinition<'agentPreset', string | null>
