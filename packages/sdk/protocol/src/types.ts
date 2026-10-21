/**
 * DeepSeek Harness SDK 运行时协议的具名线上类型：在基于换行分隔的 JSON-RPC
 * stdio 传输之上交换的请求/结果对，以及服务端到客户端的通知载荷。服务端插件
 * （`@deepseek-ai/dsh-sdk-jsonrpc-server`）与 SDK 客户端共用这些结构；
 * `serverInfo.name` 保持为线上稳定的 `deepseek-harness-sdk-runtime`。
 *
 * @module @deepseek-ai/dsh-sdk-protocol/types
 */

import type { ContentBlock, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SubagentStopReason } from '@deepseek-ai/dsh-subagent'

/** 进程级 SDK 握手的参数。 */
export interface InitializeParams {
  /** 记录在每个 SDK 所创建 session 头部的工作目录。 */
  cwd: string
  /** 每个 SDK 创建的 agent 所运行的 provider 路由。 */
  provider: string
  /** 每个 SDK 创建的 agent 所运行的模型名（服务端可能挂载兜底适配器；参见 `HarnessSdkJsonRpcServer.initialize`）。 */
  model: string
  /** 所选 provider/model 路由上由适配器拥有的可选推理强度。 */
  reasoningEffort?: ReasoningEffortId
  /** 可选的正数输出 token 上限，由 SDK 创建的 agent 及其进程内后代继承。 */
  maxTokens?: number
}

/** 初始化返回的线上稳定服务端身份。 */
export interface InitializeResult {
  /** 线上稳定的服务端身份（`deepseek-harness-sdk-runtime`）与版本。 */
  serverInfo: { name: string; version: string }
}

/** 某个 SDK session 上的一轮用户输入。 */
export interface SessionPromptParams {
  /** SDK 侧的 session id；未知 id 会惰性创建 agent 与 session 的组合。 */
  sessionId: string
  /** 提示内容块，原样作为用户消息发送。 */
  contentBlocks: SdkPromptContentBlock[]
}

/** 被准入运行时持久化附件存储的内联位图输入。 */
export interface SdkEncodedImageBlock {
  type: 'image'
  /** 规范的 base64 编码位图字节。 */
  data: string
  /** 声明的位图 MIME 类型，在准入时校验。 */
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
}

/** SDK 提示输入：普通持久化块，加上待准入的内联图片。 */
export type SdkPromptContentBlock = ContentBlock | SdkEncodedImageBlock

/** 一次提示的持久化入队回执。 */
export interface SessionPromptResult {
  /** 已入队用户消息的标识。 */
  messageId: string
}

/** 恢复一个持久化的 session，而不入队任何提示。 */
export interface SessionResumeParams {
  /** 持久化 session 标识；缺失或已被占用的 session 会被拒绝。 */
  sessionId: string
}

/** 等待一个已存在的 SDK session 及其受管后代结束。 */
export interface SessionWaitParams {
  /** 一个 SDK 拥有的 session id；等待绝不会创建 session。 */
  sessionId: string
}

/** 被请求有效工作目录的 session；未知 id 会创建该 Session。 */
export interface SessionWorkingDirectoryParams {
  /** SDK 侧的 Session 标识。 */
  sessionId: string
}

/** 修改某个 Session 的有效目录，而不改变其来源或权限。 */
export interface SessionWorkingDirectorySetParams extends SessionWorkingDirectoryParams {
  /** 要进入的目录；相对路径基于该 Session 的当前目录解析。 */
  path: string
}

/** 读取、修改或缺失目录恢复之后经过校验的有效目录。 */
export interface SessionWorkingDirectoryResult {
  /** 后续独立操作与新进程所使用的绝对目录。 */
  cwd: string
}

/** 由部署映射的 SDK 结果：被接受的结果为 `ok`，否则为 `error`。 */
export type SdkRunStatus = 'ok' | 'error'

/** `session.event` 载荷：一条 session 日志事件，在记录的同时流式发出。 */
export interface SessionEventNotification {
  /** 该事件所属的 session（运行时中的每个 session，而不只是 SDK 创建的那些）。 */
  sessionId: string
  /** 完整的 session 日志事件信封。 */
  event: SessionEvent
}

/** 某个 session 的整体 agent 生命周期状态。 */
export interface SessionStatusNotification {
  /** 其活动 agent 状态发生变化的 session。 */
  sessionId: string
  /** 状态迁移之后的整体 agent 状态。 */
  status: 'idle' | 'running'
}

/** `subagent.started` 载荷：运行时内创建了一个子 session。 */
export interface SubagentStartedNotification {
  /** 委派方 session。 */
  parentSessionId: string
  /** 新建的子 session。 */
  childSessionId: string
}

/** `subagent.finished` 载荷：一次进程内 subagent 运行结束（远程运行不上报）。 */
export interface SubagentFinishedNotification {
  /** 运行该子任务的 subagent provider 名称。 */
  provider: string
  /** 子 agent 的 id（本地运行时等于 {@link childSessionId}）。 */
  agentId: string
  /** 委派方 session。 */
  parentSessionId: string
  /** 子 session。 */
  childSessionId: string
  /** 由部署映射的运行结果。 */
  status: SdkRunStatus
  /** provider 上报的停止原因。 */
  stopReason: SubagentStopReason
  /** 子任务选中的助手输出；当子任务未产出任何输出时缺省。 */
  lastAssistantMessage?: ContentBlock[]
}

/** 按 JSON-RPC 方法名索引的服务端到客户端通知。 */
export interface HarnessSdkNotificationMap {
  'session.event': SessionEventNotification
  'session.status': SessionStatusNotification
  'subagent.started': SubagentStartedNotification
  'subagent.finished': SubagentFinishedNotification
}

/** 客户端到服务端的请求方法及其参数与结果结构。 */
export interface HarnessSdkRequestMap {
  'initialize': { params: InitializeParams; result: InitializeResult }
  'session/prompt': { params: SessionPromptParams; result: SessionPromptResult }
  'session/resume': { params: SessionResumeParams; result: Record<string, never> }
  'session/wait': { params: SessionWaitParams; result: Record<string, never> }
  'session/working-directory/get': { params: SessionWorkingDirectoryParams; result: SessionWorkingDirectoryResult }
  'session/working-directory/set': { params: SessionWorkingDirectorySetParams; result: SessionWorkingDirectoryResult }
  'shutdown': { params: undefined; result: Record<string, never> }
}
