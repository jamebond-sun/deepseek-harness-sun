/** Cordis 生命周期工具调用的、可重放稳定的视图模型。 */

import type { StartedToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type {
  CordisDynamicPackageId, CordisDynamicPluginId, CordisDynamicPluginRunId, CordisDynamicRunMode,
} from './events.ts'

type Block = StartedToolCallViewProps['block']

/** 工具调用自身的生命周期。 */
export type CordisToolState = 'running' | 'ok' | 'error' | 'stopped'

/** 冻结的 `cordis_define` 呈现数据。 */
export interface CordisDefineCard {
  readonly pluginId: CordisDynamicPluginId | null
  readonly packageId: CordisDynamicPackageId | null
  readonly name: string | null
  readonly purpose: string | null
  readonly hostCode: string | null
  readonly clientCode: string | null
  readonly output: string | null
  readonly errorSummary: string | null
  readonly state: CordisToolState
}

/** 冻结的 `cordis_run` 呈现数据。 */
export interface CordisRunCard {
  readonly pluginId: CordisDynamicPluginId | null
  readonly packageId: CordisDynamicPackageId | null
  readonly pluginRunId: CordisDynamicPluginRunId | null
  readonly mode: CordisDynamicRunMode | null
  readonly seq: number | null
  readonly output: string | null
  readonly errorSummary: string | null
  readonly state: CordisToolState
}

/** 冻结的 `cordis_stop` 或 `cordis_undefine` 呈现数据。 */
export interface CordisActionCard {
  readonly pluginId: CordisDynamicPluginId | null
  readonly output: string | null
  readonly errorSummary: string | null
  readonly state: CordisToolState
}

function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

function stringAt(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' && value !== '' ? value : null
}

function objectAt(source: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = source[key]
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
}

function parseArgs(argsRaw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(argsRaw)
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : null
  } catch {
    // 运行中的调用可能暴露一个被截断的 JSON 前缀。
    return null
  }
}

function resultText(block: Extract<Block, { kind: 'tool-result' }>): string | null {
  const text = block.content
    .map(item => item.type === 'text' ? item.text : JSON.stringify(item, null, 2))
    .join('\n')
  if (text !== '') return text
  return block.error === undefined ? null : `${block.error.name}: ${block.error.code}`
}

function stateOf(block: Block): CordisToolState {
  if (!('kind' in block)) return 'running'
  if (block.error?.code === 'interrupted') return 'stopped'
  return block.isError ? 'error' : 'ok'
}

function metaObject(block: Block): Record<string, unknown> | null {
  if (!('kind' in block) || block.isError || typeof block.meta !== 'object' || block.meta === null) return null
  return block.meta as Record<string, unknown>
}

/**
 * 从冻结的调用/结果切片推导出一张 Define 卡片。
 * @param block - 活动或已结算的工具调用块。
 * @returns 归一化的 Define 卡片字段。
 */
export function cordisDefineCard(block: Block): CordisDefineCard {
  const settled = 'kind' in block
  const argsRaw = (settled ? block.call?.argsRaw : block.argsRaw) ?? ''
  const args = parseArgs(argsRaw)
  const code = args === null ? null : objectAt(args, 'code')
  const state = stateOf(block)
  const output = settled ? resultText(block) : null
  const meta = metaObject(block)
  const rawName = argsRaw === '' ? null : firstLine(argsRaw)
  return {
    pluginId: meta === null ? null : stringAt(meta, 'pluginId') as CordisDynamicPluginId | null,
    packageId: meta === null ? null : stringAt(meta, 'packageId') as CordisDynamicPackageId | null,
    name: args === null ? rawName : stringAt(args, 'name') ?? rawName,
    purpose: args === null ? null : stringAt(args, 'purpose'),
    hostCode: code === null ? null : stringAt(code, 'host'),
    clientCode: code === null ? null : stringAt(code, 'client'),
    output,
    errorSummary: state === 'error' && output !== null ? firstLine(output) : null,
    state,
  }
}

/**
 * 推导出一张 Run 卡片及其成功的激活元数据。
 * @param block - 活动或已结算的工具调用块。
 * @returns 归一化的 Run 卡片字段。
 */
export function cordisRunCard(block: Block): CordisRunCard {
  const settled = 'kind' in block
  const argsRaw = (settled ? block.call?.argsRaw : block.argsRaw) ?? ''
  const args = parseArgs(argsRaw)
  const meta = metaObject(block)
  const state = stateOf(block)
  const output = settled ? resultText(block) : null
  const rawMode = args === null ? null : stringAt(args, 'mode')
  const argsPluginId = args === null ? null : stringAt(args, 'pluginId')
  const argsPackageId = args === null ? null : stringAt(args, 'packageId')
  return {
    pluginId: (meta === null ? argsPluginId : stringAt(meta, 'pluginId') ?? argsPluginId) as CordisDynamicPluginId | null,
    packageId: (meta === null ? argsPackageId : stringAt(meta, 'packageId') ?? argsPackageId) as CordisDynamicPackageId | null,
    pluginRunId: (meta === null ? null : stringAt(meta, 'pluginRunId')) as CordisDynamicPluginRunId | null,
    mode: rawMode === 'run' || rawMode === 'update' ? rawMode : null,
    seq: settled ? block.seq : null,
    output,
    errorSummary: state === 'error' && output !== null ? firstLine(output) : null,
    state,
  }
}

/**
 * 从冻结的调用/结果切片推导出一张 Stop 或 Remove 卡片。
 * @param block - 活动或已结算的工具调用块。
 * @returns 归一化的生命周期动作卡片字段。
 */
export function cordisActionCard(block: Block): CordisActionCard {
  const settled = 'kind' in block
  const argsRaw = (settled ? block.call?.argsRaw : block.argsRaw) ?? ''
  const args = parseArgs(argsRaw)
  const state = stateOf(block)
  const output = settled ? resultText(block) : null
  return {
    pluginId: (args === null ? null : stringAt(args, 'pluginId') ?? stringAt(args, 'id')) as CordisDynamicPluginId | null,
    output,
    errorSummary: state === 'error' && output !== null ? firstLine(output) : null,
    state,
  }
}
