/** 生成 Host Remote 贡献的平台中立装配。 */

import type { Context } from '@deepseek-ai/cordis'
import productAnalyticsRemote from '@deepseek-ai/dsh-client-product-analytics/remote'
export type {} from '@deepseek-ai/dsh-client-product-analytics/remote'
import agentPresetsRemote from '@deepseek-ai/dsh-agent-preset-registry/remote'
import userQuestionsRemote from '@deepseek-ai/dsh-user-questions/remote'
import commandsRemote from '@deepseek-ai/dsh-commands/remote'
import accountRemote from '@deepseek-ai/dsh-api-account-controller/remote'
import settingsControllerRemote from '@deepseek-ai/dsh-api-settings-controller/remote'
import officeToPdfRemote from '@deepseek-ai/dsh-office-to-pdf/remote'
import goalsRemote from '@deepseek-ai/dsh-goal/remote'
import scheduleRemote from '@deepseek-ai/dsh-schedule/remote'
import llmRemote from '@deepseek-ai/dsh-llm/remote'
import dynamicRemote from '@deepseek-ai/dsh-cordis-host-runner/remote'
import pluginManagerRemote from '@deepseek-ai/dsh-plugin-manager/remote'
import pluginRegistryProbeRemote from '@deepseek-ai/dsh-client-ui-plugin-manager/remote'
import pluginMarketRemote from '@deepseek-ai/dsh-plugin-market/remote'
import pluginInventoryRemote from '@deepseek-ai/dsh-host-plugin-inventory/remote'
import messageFeedbackRemote from '@deepseek-ai/dsh-message-feedback/remote'
import permissionPresetsRemote from '@deepseek-ai/dsh-permission-presets/remote'
import sessionFeedbackRemote from '@deepseek-ai/dsh-command-feedback/remote'
import fileUploadsRemote from '@deepseek-ai/dsh-client-file-upload/remote'
import sessionReferencesRemote from '@deepseek-ai/dsh-session-reference/remote'
import subagentsRemote from '@deepseek-ai/dsh-subagent/remote'
import sessionRemote from '@deepseek-ai/dsh-api-session-controller/remote'
import jobRemote from '@deepseek-ai/dsh-api-job-controller/remote'
import workspaceRemote from '@deepseek-ai/dsh-api-workspace-controller/remote'
import terminalRemote from '@deepseek-ai/dsh-api-terminal-controller/remote'
import workspaceFilesRemote from '@deepseek-ai/dsh-api-workspace-files/remote'
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'

export type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
export type {
  BundleInfo, BundleRowInfo, ChangeResult, IncompatiblePlugin, InspectOptions, InstallBundleOptions, InstallSpecKind, ManagementError,
  PackageResult,
  PluginChange, PluginEntryId, PluginInfo, PluginInspectProblem, PluginInstallCancellation, PluginInstallFailureKind,
  PluginInstallLogChunk, PluginInstallProgress, PluginInstallRequestId, PluginRegistries, PluginSpecInspection,
  ReadOnlyReason, Registry, RestartReason,
} from '@deepseek-ai/dsh-plugin-manager/types'
export type {} from '@deepseek-ai/dsh-plugin-manager/remote'
export type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/remote'
export type {} from '@deepseek-ai/dsh-plugin-market/remote'
export type {
  MarketCompatibility, MarketIndexSummary, MarketInstallation, MarketInstallationStatus, MarketListingEntry, MarketListingVersion,
  MarketQuery, MarketSearchResult, MarketSort,
} from '@deepseek-ai/dsh-plugin-market/types'
export type { PluginInventorySnapshot } from '@deepseek-ai/dsh-host-plugin-inventory/types'
export type {} from '@deepseek-ai/dsh-agent-preset-registry/remote'
export type {} from '@deepseek-ai/dsh-user-questions/remote'
export type {} from '@deepseek-ai/dsh-commands/remote'
export type {} from '@deepseek-ai/dsh-api-settings-controller/remote'
export type {} from '@deepseek-ai/dsh-api-account-controller/remote'
export type {} from '@deepseek-ai/dsh-goal/remote'
export type {} from '@deepseek-ai/dsh-schedule/remote'
export type {} from '@deepseek-ai/dsh-office-to-pdf/remote'
export type {} from '@deepseek-ai/dsh-llm/remote'
export type {} from '@deepseek-ai/dsh-host-plugin-inventory/remote'
export type {} from '@deepseek-ai/dsh-message-feedback/remote'
export type {} from '@deepseek-ai/dsh-permission-presets/remote'
export type {} from '@deepseek-ai/dsh-command-feedback/remote'
export type {} from '@deepseek-ai/dsh-client-file-upload/remote'
export type {} from '@deepseek-ai/dsh-session-reference/remote'
export type {} from '@deepseek-ai/dsh-subagent/remote'
export type * from '@deepseek-ai/dsh-subagent/client'
export type {} from '@deepseek-ai/dsh-api-session-controller/remote'
export type * from '@deepseek-ai/dsh-api-session-controller/types'
export type {} from '@deepseek-ai/dsh-api-job-controller/remote'
export type * from '@deepseek-ai/dsh-api-job-controller/types'
export type {} from '@deepseek-ai/dsh-api-workspace-controller/remote'
export type * from '@deepseek-ai/dsh-api-workspace-controller/types'
export type {} from '@deepseek-ai/dsh-api-workspace-files/remote'
export type * from '@deepseek-ai/dsh-api-workspace-files/types'
export type {} from '@deepseek-ai/dsh-api-terminal-controller/remote'
export type * from '@deepseek-ai/dsh-api-terminal-controller/types'
// 转发事件允许列表的选择席位：若消费方编译面缺少它，
// `TypertRemoteEvent` 即为 `never`，每个 `$on` 调用都会失败。
export type { ApiRemoteForwardedEvent } from '../types.ts'
// owner 包的 client-safe `./types` 导出提供 `$on` 交给监听器的
// `Events` 签名，因此消费方读取的正是 Host 发出的那份
// 声明，而非它的扁平化复述。
export type {} from '@deepseek-ai/dsh-commands/types'
export type {} from '@deepseek-ai/dsh-cordis-host-runner/types'
export type {} from '@deepseek-ai/dsh-credentials/types'
export type {} from '@deepseek-ai/dsh-llm/types'
export type {} from '@deepseek-ai/dsh-agent-preset-registry/types'
export type {} from '@deepseek-ai/dsh-permission-presets/types'
export type {} from '@deepseek-ai/dsh-settings/types'
export type {} from '@deepseek-ai/dsh-user-approval/types'
export type {} from '@deepseek-ai/dsh-user-questions/types'
export type {} from '@deepseek-ai/dsh-api-session-controller/types'

/**
 * carrier 面向 Client 的类型，再导出它们是为了让业务包
 * 只命名一个装配包，而不是同时命名本门面与 Connection
 * 插件。仅类型：carrier 的运行时值仍留在其自身的模块边界之后。
 */
export type {
  ConnectionHandle, ConnectionSinks, ContentBlock,
  MessageId,
  RpcId, RpcRequest, RpcResponse, RpcResult, SessionId,
  StreamChunk,
} from '@deepseek-ai/dsh-client-connection/client'
export type {} from '@deepseek-ai/dsh-api-gateway/client'
export type {} from '@deepseek-ai/dsh-cordis-host-runner/remote'

// 所选命名空间的载荷词汇，再导出它们是为了让 Client 贡献
// 无需导入 Host 包即可命名其收发内容：本装配是两个平面
// 唯一合法交汇之处。
export type {
  ApprovalRequestId,
  CordisHalfState,
  CordisDynamicPackageId,
  CordisDynamicPluginId,
  CordisDynamicPluginRunId,
  CordisDynamicRunMode,
  CordisInspectMethodManifest,
  CordisInspectPlatform,
  CordisInspectProviderManifest,
  CordisInspectProviderView,
  CordisInspectQueryRequest,
  CordisInspectQueryResolution,
  CordisInspectQueryResolved,
  CordisInspectRequestId,
  CordisInspectResolveAck,
  CordisRunDiagnostic,
  CordisRunStatus,
  DynamicCordisClientSource,
  DynamicCordisHostHalfResult,
  DynamicCordisInventoryRow,
  DynamicCordisInvokeResult,
  DynamicCordisPackage,
  DynamicCordisRequestResolved,
  DynamicCordisResolveAck,
  DynamicCordisRetracted,
  DynamicCordisRunRequest,
  DynamicCordisRunResolution,
  DynamicCordisRunAttempt,
  DynamicCordisRunResponse,
  DynamicCordisStopResponse,
  DynamicCordisUndefineReceipt,
  RequestRunOutcome,
} from '@deepseek-ai/dsh-cordis-host-runner/types'
// credentials 命名空间的凭据状态词汇（值绝不随其传输）。
export type { CredentialInfo } from '@deepseek-ai/dsh-credentials/types'
// settings 命名空间的脱敏词汇（机密绝不随其
// 传输）。它随自身接缝一同携带，Client 编译面已读取其 `./types`。
export type {
  SettingsDescribeValue, SettingsNamespaceView, SettingsPathOpView, SettingsSecretView,
} from '@deepseek-ai/dsh-settings/types'
// llm 命名空间的提供方注册表与发现词汇。
export type {
  LlmConfigurableProvider, LlmDiscoveredModel,
  LlmModelDiscoveryRequest, LlmNativeAuth, LlmProviderInfo,
} from '@deepseek-ai/dsh-llm/types'
// fileReferences 与 sessionReferenceResolver 命名空间的
// 引用发现结果词汇。
export type { FileReferenceCandidate } from '@deepseek-ai/dsh-file-reference/types'
export type { SessionReferenceMentionCandidate } from '@deepseek-ai/dsh-session-reference/types'

// Remote 失败词汇，再导出它们是为了让业务包继续只命名
// 本装配。仅类型：值导出会使 spec 导入加载
// 本模块的 owner /remote 产物；spec 改从
// dsh-client-test-runtime 获取 RemoteError。
export type {
  RemoteErrorCode, RemoteErrorDetailsMap, RemoteFailure, RemoteResult,
} from '@deepseek-ai/dsh-typert-protocol'
export type { RemoteHostFacts } from '@deepseek-ai/dsh-api-gateway/client'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 本 Client 装配所选的生成 Remote 命名空间。 */
    remote: ClientRemote
  }
}

/** 必需服务：带类型的 Client Remote 贡献挂载。 */
export const inject = ['remote']

/**
 * 挂载为本 Client 装配显式选择的 Host 能力。
 * @param ctx - 携带带类型 API 服务的 Client Cordis 根上下文。
 * @returns 每个所选 Remote 命名空间就绪后的释放器。
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposers: Array<() => Promise<void>> = []
  try {
    for (const contribution of [
      productAnalyticsRemote, agentPresetsRemote, commandsRemote, settingsControllerRemote, accountRemote,
      goalsRemote, llmRemote, dynamicRemote, scheduleRemote,
      pluginInventoryRemote, pluginManagerRemote, pluginMarketRemote, pluginRegistryProbeRemote,
      messageFeedbackRemote, sessionFeedbackRemote,
      fileUploadsRemote, sessionReferencesRemote,
      permissionPresetsRemote, subagentsRemote, sessionRemote, jobRemote, workspaceRemote, workspaceFilesRemote, terminalRemote,
      officeToPdfRemote, userQuestionsRemote,
    ]) {
      disposers.push(await ctx.remote.$mount(contribution))
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) await dispose()
    throw error
  }
  // 按挂载的逆序释放，因此一个命名空间绝不会比在它之后
  // 挂载的命名空间存活更久。
  return async () => {
    for (const dispose of disposers.reverse()) await dispose()
  }
}
