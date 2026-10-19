/** 持久化的模型选择意图与请求使用投影。 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import type {
  ModelSelection,
  ModelSelectionProjection,
  ModelSelectionProjectionState,
} from './types.ts'

const modelSelectionSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1).optional(),
}) as unknown as z.ZodType<ModelSelection>

const modelSelectionProjectionStateSchema = z.object({
  lastUsed: modelSelectionSchema.nullable(),
  pending: modelSelectionSchema.nullable(),
}) as z.ZodType<ModelSelectionProjectionState>

const modelSelectionProjectionSchema = z.object({
  lastUsed: modelSelectionSchema.nullable(),
  next: modelSelectionSchema.nullable(),
}) as z.ZodType<ModelSelectionProjection>

/**
 * 按一个 Session 事件推进持久化模型选择状态。
 * @param state - 事件之前的选择状态。
 * @param event - 下一个已提交的 Session 事件。
 * @returns 原始或推进后的选择状态。
 */
function applyModelSelectionProjection(
  state: ModelSelectionProjectionState,
  event: SessionEvent,
): ModelSelectionProjectionState {
  if (event.type === 'model/selection') {
    return sameSelection(state.pending, event.data)
      ? state
      : { lastUsed: state.lastUsed, pending: event.data }
  }
  if (event.type !== 'request/header') return state
  const lastUsed: ModelSelection = {
    provider: event.data.header.config.provider,
    model: event.data.header.config.model,
    ...(event.data.header.config.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: String(event.data.header.config.reasoningEffort) }),
  }
  const pending = sameSelection(state.pending, lastUsed) ? null : state.pending
  return sameSelection(state.lastUsed, lastUsed) && pending === state.pending
    ? state
    : { lastUsed, pending }
}

const modelSelectionProjection = {
  key: 'modelSelection',
  stateSchema: modelSelectionProjectionStateSchema,
  init: () => ({ lastUsed: null, pending: null }),
  apply: applyModelSelectionProjection,
  wire: {
    viewSchema: modelSelectionProjectionSchema,
    view: state => ({ lastUsed: state.lastUsed, next: state.pending ?? state.lastUsed }),
  },
  stateVersion: 2,
} satisfies ProjectionDefinition<'modelSelection', ModelSelectionProjectionState>

function sameSelection(left: ModelSelection | null, right: ModelSelection | null): boolean {
  return left === right || (left !== null && right !== null
    && left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort)
}

/**
 * 当注册表存在时注册持久化模型选择投影。
 * @param ctx - Session Controller 上下文。
 */
export function installModelSelectionProjection(ctx: Context): void {
  ctx.sessionProjections.register(modelSelectionProjection)
}
