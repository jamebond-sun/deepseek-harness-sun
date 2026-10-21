/**
 * meta 校验会针对 {@link WorkflowMeta} 契约检查调用方提供的数据，并按名称
 * 拒绝每一项违规。meta 以经 schema 检查的 JSON 数据到达，绝不会是被求值的
 * 脚本文本。模型编写的 JavaScript 在受限的 PTC 进程内执行。
 * @module @deepseek-ai/dsh-workflow-ptc/meta
 */

import { WorkflowError } from '@deepseek-ai/dsh-workflow'
import type { WorkflowMeta, WorkflowPhase } from '@deepseek-ai/dsh-workflow'

/** 为一个 meta 值收集形状违规（按 seam 契约为纯 JSON 数据）。 */
function validateMetaShape(meta: unknown): { meta?: WorkflowMeta; violations: string[] } {
  const violations: string[] = []
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    return { violations: ['meta must be an object'] }
  }
  const record = meta as Record<string, unknown>
  const known = new Set(['name', 'description', 'whenToUse', 'phases'])
  for (const key of Object.keys(record)) {
    if (!known.has(key)) violations.push(`meta.${key} is not a recognized field (name/description/whenToUse/phases)`)
  }
  if (typeof record.name !== 'string' || record.name.length === 0) violations.push('meta.name must be a non-empty string')
  if (typeof record.description !== 'string' || record.description.length === 0) violations.push('meta.description must be a non-empty string')
  if (record.whenToUse !== undefined && typeof record.whenToUse !== 'string') violations.push('meta.whenToUse must be a string')
  const phases: WorkflowPhase[] = []
  if (record.phases !== undefined) {
    if (!Array.isArray(record.phases)) {
      violations.push('meta.phases must be an array')
    } else {
      record.phases.forEach((phase, index) => {
        if (typeof phase !== 'object' || phase === null || Array.isArray(phase)) {
          violations.push(`meta.phases[${index}] must be an object`)
          return
        }
        const entry = phase as Record<string, unknown>
        for (const key of Object.keys(entry)) {
          if (!['title', 'detail', 'provider', 'model'].includes(key)) violations.push(`meta.phases[${index}].${key} is not a recognized field`)
        }
        if (typeof entry.title !== 'string' || entry.title.length === 0) violations.push(`meta.phases[${index}].title must be a non-empty string`)
        if (entry.detail !== undefined && typeof entry.detail !== 'string') violations.push(`meta.phases[${index}].detail must be a string`)
        if (entry.provider !== undefined && typeof entry.provider !== 'string') violations.push(`meta.phases[${index}].provider must be a string`)
        if (entry.model !== undefined && typeof entry.model !== 'string') violations.push(`meta.phases[${index}].model must be a string`)
        if (violations.length === 0) {
          phases.push({
            title: entry.title as string,
            ...entry.detail !== undefined ? { detail: entry.detail as string } : {},
            ...entry.provider !== undefined ? { provider: entry.provider as string } : {},
            ...entry.model !== undefined ? { model: entry.model as string } : {},
          })
        }
      })
    }
  }
  if (violations.length > 0) return { violations }
  return {
    violations,
    meta: {
      name: record.name as string,
      description: record.description as string,
      ...record.whenToUse !== undefined ? { whenToUse: record.whenToUse as string } : {},
      ...record.phases !== undefined ? { phases } : {},
    },
  }
}

/**
 * 针对 {@link WorkflowMeta} 契约校验调用方提供的 meta 值。抛出 `META_INVALID`，
 * 并逐一列出每一项违规（未知字段、缺失/类型错误的 `name`/`description`、
 * 畸形的 `phases`）；返回值是基于已校验字段构建的 NORMALIZED 副本，因此
 * 引擎绝不会别名调用方的对象。
 * @param value - 来自 start 请求的 meta 数据（按 seam 契约为纯 JSON）。
 * @returns 已校验、已规范化的 meta 块。
 */
export function validateMeta(value: unknown): WorkflowMeta {
  const { meta, violations } = validateMetaShape(value)
  if (meta === undefined) {
    throw new WorkflowError(`invalid meta: ${violations.join('; ')}`, 'META_INVALID')
  }
  return meta
}
