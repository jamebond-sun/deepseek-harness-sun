/** 由全框架 Cordis 面板直接使用的 Host 操作。 */

import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  CordisDynamicPluginId, DynamicCordisInventoryRow,
} from './events.ts'

/** 面板生命周期手势的结果。 */
export type CordisActionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string }

/** 保留在 React 表面之外的 RPC 接缝。 */
export interface CordisDynamicPort {
  /** 停止一个 Plugin，同时保留其不可变的 Package。 */
  stop(sessionId: SessionId, pluginId: CordisDynamicPluginId): Promise<CordisActionResult>
  /** 停止并移除一个 Plugin 及其所有 Package。 */
  remove(sessionId: SessionId, pluginId: CordisDynamicPluginId): Promise<CordisActionResult>
  /** 读取全框架的 Plugin 清单。 */
  inventory(): Promise<readonly DynamicCordisInventoryRow[]>
}

/** 面板所收到的、稳定的 Plugin 行。 */
export type CordisInventoryRow = DynamicCordisInventoryRow
