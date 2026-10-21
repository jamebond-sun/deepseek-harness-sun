/**
 * DeepSeek Harness SDK 运行时的共享线上协议：基于换行分隔的 JSON-RPC stdio 传输，
 * 以及两端共用的具名请求、结果与通知类型。运行时服务端插件
 * （`@deepseek-ai/dsh-sdk-jsonrpc-server`）提供该协议；SDK 客户端
 * （`@deepseek-ai/dsh-sdk-client`、Python SDK）驱动该协议。
 *
 * @module @deepseek-ai/dsh-sdk-protocol
 */

export { JsonRpcLineTransport, JsonRpcResponseError } from './transport.ts'
export type { JsonRpcTransportPeer } from './transport.ts'
export type {
  HarnessSdkNotificationMap,
  HarnessSdkRequestMap,
  InitializeParams,
  InitializeResult,
  SdkEncodedImageBlock,
  SdkPromptContentBlock,
  SdkRunStatus,
  SessionEventNotification,
  SessionStatusNotification,
  SessionPromptParams,
  SessionPromptResult,
  SessionResumeParams,
  SessionWaitParams,
  SessionWorkingDirectoryParams,
  SessionWorkingDirectorySetParams,
  SessionWorkingDirectoryResult,
  SubagentFinishedNotification,
  SubagentStartedNotification,
} from './types.ts'
