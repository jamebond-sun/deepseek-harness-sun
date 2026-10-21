/**
 * DeepSeek Harness 运行时的 TypeScript 客户端 SDK：以子进程形式启动同版本的
 * `dsh --profile sdk` 运行时，并通过 stdio JSON-RPC 驱动 agent 轮次。
 * `DeepSeekHarness` 是高层运行 API；`HarnessClient` 是更底层的协议客户端。
 * 这是一个纯库 —— 它不在 Cordis context 上注册任何东西；具名 profile 与有序
 * 补丁文件用于定制它所启动的运行时进程。
 *
 * @module @deepseek-ai/dsh-sdk-client
 */

export { DeepSeekHarness, HarnessSession, validatedSessionEvent } from './api.ts'
export type { RunOptions } from './api.ts'
export {
  HarnessClient,
  RequestTimeoutError,
  SdkProtocolError,
  TransportClosedError,
} from './client.ts'
export type { NotificationSubscription } from './client.ts'
export { JsonRpcResponseError } from '@deepseek-ai/dsh-sdk-protocol'
export type {
  ContentBlock,
  SdkPromptContentBlock,
  DeepSeekHarnessOptions,
  HarnessClientOptions,
  HarnessNotification,
  NotificationFilter,
  RunResult,
} from './types.ts'
