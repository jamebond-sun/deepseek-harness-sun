/**
 * 面向结果时刻的 write/edit 上下文 diff 展示。存储层返回 before/after 文本；
 * 这一面向模型的层为每个已应用的补丁块派生出一张带三行上下文的卡片。
 * @module @deepseek-ai/dsh-tool-fs/src/diff
 */

import { structuredPatch } from 'diff'
import type { FileDiff } from '@deepseek-ai/dsh-tools'

/** 每个已应用补丁块单侧展示的上下文行数。 */
export const DIFF_CONTEXT = 3

/**
 * `write`/`edit` 工具私有的 `tool/result` `meta` 载荷：已应用的上下文 diff 补丁块；
 * 对 `write` 还会带上本次调用是创建还是更新了文件，用于区分"空的补丁块列表"究竟表示一次
 * 创建还是一次无变化的覆盖。它以不透明形式（作为 `unknown`）挂在工具结果上并随会话日志
 * 持久化 —— 因此它必须是可 JSON 序列化的（会话在 `append` 时会校验这一点），
 * 这样 `presentResult` 才能在重放时复现这张 diff 卡片。产出该结果的工具拥有并收窄这个
 * 不透明结构。
 */
export type FsDiffMeta = { diffs: FileDiff[]; operation?: 'create' | 'update' }

/**
 * 在 `before` 与 `after` 之间为每个补丁块计算一个 {@link FileDiff}，各携带已应用的改动
 * 外加 {@link DIFF_CONTEXT} 行上下文。纯插入使用 `oldText: null`，仅属于 patch 的
 * "无换行符"标记会被跳过，分散的替换仍保持为独立的补丁块。
 *
 * @param path - 打在每个产出 diff 上的路径（面向模型的 `file_path`；bridge 会把它相对化）。
 * @param before - 改动之前的文件文本（后端 LF 规范化的 diff 基线）。
 * @param after - 改动之后的文件文本，基于同一基线。
 * @returns 每个已应用补丁块一个 diff，按文件顺序排列；两份文本相同时为空数组。
 */
export function computeHunkDiffs(path: string, before: string, after: string): FileDiff[] {
  const patch = structuredPatch('', '', before, after, undefined, undefined, { context: DIFF_CONTEXT })
  const diffs: FileDiff[] = []
  for (const hunk of patch.hunks) {
    const oldLines: string[] = []
    const newLines: string[] = []
    for (const line of hunk.lines) {
      // 统一 diff 中"缺少结尾换行符"的标记是在注解 patch 而不是内容 ——
      // 跳过它，使它永远不会泄漏进 diff 区块里。
      if (line.startsWith('\\')) continue
      const text = line.slice(1)
      if (line.startsWith('-')) {
        oldLines.push(text)
      } else if (line.startsWith('+')) {
        newLines.push(text)
      } else {
        // 上下文（未改动）行同时出现在两侧。
        oldLines.push(text)
        newLines.push(text)
      }
    }
    diffs.push({ path, oldText: oldLines.length > 0 ? oldLines.join('\n') : null, newText: newLines.join('\n') })
  }
  return diffs
}

/** `value` 是否为合法的 {@link FileDiff}（从不透明的 `meta` 做防御性收窄）。 */
function isFileDiff(value: unknown): value is FileDiff {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { path, oldText, newText } = value as Record<string, unknown>
  return typeof path === 'string'
    && (oldText === null || typeof oldText === 'string')
    && typeof newText === 'string'
}

/**
 * 把不透明的实时或重放结果元数据收窄为非空的文件 diff。元数据格式有误时返回 `undefined`，
 * 使展示层可以回退，而不是在重放期间抛错。
 * @param meta - 结果元数据。
 * @returns 已校验的补丁块；数据缺失或格式有误时为 `undefined`。
 */
export function diffsFromMeta(meta: unknown): FileDiff[] | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const diffs = (meta as Record<string, unknown>).diffs
  if (!Array.isArray(diffs) || diffs.length === 0 || !diffs.every(isFileDiff)) return undefined
  return diffs
}

/**
 * 即使已应用的 diff 为空，也读出该次操作的文件路径。
 * @param meta - 不透明的持久化结果元数据。
 * @returns 记录下来的路径；元数据过旧或格式有误时为 undefined。
 */
export function pathFromMeta(meta: unknown): string | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const path = (meta as Record<string, unknown>).path
  return typeof path === 'string' && path.length > 0 ? path : undefined
}
