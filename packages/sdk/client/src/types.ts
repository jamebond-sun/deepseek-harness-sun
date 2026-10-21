/**
 * TypeScript SDK 客户端的类型：启动选项、通知结构，以及受管活动结果。
 *
 * @module @deepseek-ai/dsh-sdk-client/types
 */

import type { ContentBlock, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SdkPromptContentBlock } from '@deepseek-ai/dsh-sdk-protocol'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** 从线上收到的一条服务端到客户端通知。 */
export interface HarnessNotification {
  /** JSON-RPC 通知方法名。 */
  method: string
  /** 原始 params 对象；各方法对应的结构参见 `HarnessSdkNotificationMap`。 */
  params: Record<string, unknown>
}

/** 决定某个订阅是否接收某条通知的判定函数。 */
export type NotificationFilter = (notification: HarnessNotification) => boolean

/** {@link HarnessClient} 的启动与超时选项。 */
export interface HarnessClientOptions {
  /** 绝对或相对调用方的 dsh CLI 模块；省略时解析本包的同版本依赖。 */
  dshBin?: string
  /** 提供 SDK 协议的具名 profile（默认 `sdk`）。 */
  profile?: string
  /** 每次启动应用的有序 profile 补丁；相对路径在 spawn 之前解析。 */
  patches?: string[]
  /** 该子进程的显式 Harness home；相对路径在 spawn 之前解析。 */
  dshHome?: string
  /** dsh 进程自身的工作目录。 */
  processCwd?: string
  /**
   * 完整的子进程环境，在 {@link HarnessClient.start} 启动子进程时读取。
   * `undefined` 表示届时读取父进程环境；传入对象则在 spawn 时读取该对象，
   * 并完全替换父进程环境，因此凭据策略由调用方掌握
   * （共享的「先清洗再合并」基座参见 `@deepseek-ai/dsh-subprocess` 中的 `scrubbedParentEnv`）。
   */
  env?: NodeJS.ProcessEnv
  /** 初始 profile 握手的时限（毫秒，默认 10000）。 */
  initializeTimeoutMs?: number
  /** 单请求超时（毫秒）；`undefined` 表示无限等待（一轮本就可能合法地跑很久）。 */
  requestTimeoutMs?: number
  /** `close()` 内协议 `shutdown` 交互的时限（毫秒，默认 1000）。 */
  shutdownTimeoutMs?: number
  /** `close()` 期间运行时 stdin-EOF 静默的宽限期（毫秒，默认 6000）。 */
  disposeEofGraceMs?: number
  /** `close()` 期间 SIGTERM/SIGKILL 之后确认终止的窗口（毫秒，默认 3000）。 */
  disposeGraceMs?: number
}

/** 高层 {@link DeepSeekHarness} 封装的选项。 */
export interface DeepSeekHarnessOptions extends HarnessClientOptions {
  /** 记录在每个 SDK 所创建 session 上的工作区 cwd（默认：进程 cwd，否则为 `process.cwd()`）。 */
  cwd?: string
  /** SDK 创建的 agent 所使用的 provider 路由（默认 `deepseek-official`）。 */
  provider?: string
  /** SDK 创建的 agent 所使用的模型（默认 `deepseek-v4-flash`）。 */
  model?: string
  /** 所选 provider/model 路由上由适配器拥有的推理强度。 */
  reasoningEffort?: ReasoningEffortId
  /** 每次会话模型请求的最大输出 token 数。 */
  maxTokens?: number
}

/** 一段受管的 session 活动区间，从入队回执一直到空闲。 */
export interface RunResult {
  /** 活动所运行的 session。 */
  sessionId: string
  /** 该区间最后一条助手消息的拼接文本（没有时为空）。 */
  finalResponse: string
  /** 根 session 的每一条 `session.event` 载荷，按线上顺序排列。 */
  events: SessionEvent[]
  /** 根 session 及已发现后代的每一条通知，按线上顺序排列。 */
  notifications: HarnessNotification[]
}

/** 重新导出的内容块别名，使 SDK 调用方无需额外 import。 */
export type { ContentBlock }
export type { SdkPromptContentBlock }
