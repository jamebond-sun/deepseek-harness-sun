/** 通过 Remote 装配再导出的、Client 安全的动态 Cordis 词表。 */

// 仅类型：将 `ctx.remote` 与转发的事件键集合并到本程序。
import type {} from '@deepseek-ai/dsh-api-remotes/client'

export type {
  ApprovalRequestId,
  CordisDynamicPackageId,
  CordisDynamicPluginId,
  CordisDynamicPluginRunId,
  CordisDynamicRunMode,
  DynamicCordisInventoryRow,
  DynamicCordisPackage,
  DynamicCordisRequestResolved,
  DynamicCordisRetracted,
  DynamicCordisRunRequest,
} from '@deepseek-ai/dsh-api-remotes/client'
