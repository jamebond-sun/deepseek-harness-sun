/** 用于运行时巡检的纯可重放安全渲染意图。 */
import type { GenericCallView } from '@deepseek-ai/dsh-tools'

/**
 * 渲染提供方目录巡检。
 * @returns 可重放安全的通用调用呈现。
 */
export function presentInspectListCall(): GenericCallView {
  return { card: 'generic', kind: 'read', title: 'List Cordis Inspect Providers' }
}

/**
 * 渲染单次提供方查询。
 * @param args - 目标平台、提供方与方法。
 * @returns 可重放安全的通用调用呈现。
 */
export function presentInspectQueryCall(args: { platform: string; provider: string; method: string }): GenericCallView {
  return { card: 'generic', kind: 'read', title: `Query Cordis ${args.platform} ${args.provider}.${args.method}` }
}
