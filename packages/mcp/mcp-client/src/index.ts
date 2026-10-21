/**
 * MCP 客户端桥接插件：连接外部 MCP 服务端，并把它的工具以服务端限定的公开名
 * （`mcp__<serverName>__<rawName>`）注册到 `ctx.tools`。每个插件实例连接一个
 * MCP 服务端；需要多个服务端时，在 `cordis.yml` 中加载多个实例。
 *
 * 命名空间插件（具名导出，无默认导出）。生命周期由 effect 界定：销毁时断开
 * 与服务端、注销全部工具，并释放 `serverName` 的命名空间预留。HMR 通过销毁
 * 旧实例、创建新实例完成热替换；相同的 `serverName` 会生成相同的公开工具名。
 *
 * @module @deepseek-ai/dsh-mcp-client
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { DEFAULT_MAX_INSTRUCTION_BYTES, RECONNECT_DEFAULTS, resolveReconnectPolicy, startConnection } from './connection.ts'
import type { ReconnectConfig } from './connection.ts'
import { registerServerContext } from './server-context.ts'
// 副作用类型导入：把 `ctx.tools` 声明合并到 Context 上。
import type {} from '@deepseek-ai/dsh-tools'

export { createMcpToolDefinition } from './tools.ts'
export type { McpResult, McpToolDefinitionOptions } from './tools.ts'
export type { ReconnectConfig, ResolvedReconnectPolicy } from './connection.ts'

/** 供加载器诊断使用的 Cordis 插件名。 */
export const name = 'mcp-client'

/** 本插件所需的服务。 */
export const inject = ['tools']

/** 单次 MCP 工具调用与资源请求的默认超时（毫秒）。 */
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000

/** 合法的 `serverName`，保持在公开工具名的长度预算之内。 */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/**
 * 每个注册作用域内活跃的 `serverName` 预留。Agent 作用域的 MCP 服务端可以在
 * 另一个 Agent 中复用同一命名空间，而全局实例、以及同一 Agent 内的重名实例
 * 依然互斥。
 */
const activeServerNames = new WeakMap<object, Set<string>>()

// ---- 配置 ----

/** 通过派生的子进程以 stdio 连接 MCP 服务端的配置。 */
export interface StdioConfig {
  /** 选择子进程 stdio 传输。 */
  transport: 'stdio'
  /**
   * 本服务端模型可见工具名的稳定本地命名空间
   * （`mcp__<serverName>__<rawName>`）。必须匹配 `[A-Za-z0-9_-]{1,32}`，
   * 且在活跃的 mcp-client 实例之间唯一。
   */
  serverName: string
  /** 用于启动服务端的可执行文件。 */
  command: string
  /** 直接传入的参数，不做 shell 插值。 */
  args: string[]
  /** 叠加在经过清洗的环境变量之上的额外环境变量。 */
  env: Record<string, string>
  /** 子进程的工作目录。 */
  cwd: string
  /** 单次工具调用或资源请求的超时（毫秒）。 */
  toolCallTimeoutMs: number
  /** 初始连接或工具同步失败时，让插件激活失败。 */
  failOnStartupError: boolean
  /** 归集的服务端指令文本的 UTF-8 字节上限（默认 32768）。 */
  maxInstructionBytes?: number
  /** 连接丢失后的自动重连策略；省略则使用默认值。 */
  reconnect?: ReconnectConfig
}

/** 通过 Streamable HTTP（SSE）连接 MCP 服务端的配置。 */
export interface StreamableHttpConfig {
  /** 选择 Streamable HTTP 传输。 */
  transport: 'streamable-http'
  /**
   * 本服务端模型可见工具名的稳定本地命名空间
   * （`mcp__<serverName>__<rawName>`）。必须匹配 `[A-Za-z0-9_-]{1,32}`，
   * 且在活跃的 mcp-client 实例之间唯一。
   */
  serverName: string
  /** MCP 端点 URL。 */
  url: string
  /** 附加到 MCP 请求上的额外请求头。 */
  headers: Record<string, string>
  /** 单次工具调用或资源请求的超时（毫秒）。 */
  toolCallTimeoutMs: number
  /** 初始连接或工具同步失败时，让插件激活失败。 */
  failOnStartupError: boolean
  /** 归集的服务端指令文本的 UTF-8 字节上限（默认 32768）。 */
  maxInstructionBytes?: number
  /** 连接丢失后的自动重连策略；省略则使用默认值。 */
  reconnect?: ReconnectConfig
}

/** 单个 stdio 或 Streamable HTTP MCP 服务端的配置。 */
export type Config = StdioConfig | StreamableHttpConfig

type StdioConfigInput = Omit<StdioConfig, 'args' | 'env' | 'cwd' | 'toolCallTimeoutMs' | 'failOnStartupError'>
  & Partial<Pick<StdioConfig, 'args' | 'env' | 'cwd' | 'toolCallTimeoutMs' | 'failOnStartupError'>>
type StreamableHttpConfigInput = Omit<StreamableHttpConfig, 'headers' | 'toolCallTimeoutMs' | 'failOnStartupError'>
  & Partial<Pick<StreamableHttpConfig, 'headers' | 'toolCallTimeoutMs' | 'failOnStartupError'>>
type ConfigInput = StdioConfigInput | StreamableHttpConfigInput

const Reconnect: z<ReconnectConfig> = z.object({
  enabled: z.boolean().default(RECONNECT_DEFAULTS.enabled),
  initialDelayMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(RECONNECT_DEFAULTS.initialDelayMs),
  maxDelayMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(RECONNECT_DEFAULTS.maxDelayMs),
  maxAttempts: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(RECONNECT_DEFAULTS.maxAttempts),
})

export const Config = z.union([
  z.object({
    transport: z.const('stdio'),
    serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
    command: z.string().required(),
    args: z.array(String).default([]),
    env: z.dict(String).default({}),
    cwd: z.string().default(''),
    toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
    failOnStartupError: z.boolean().default(false),
    maxInstructionBytes: z.number().step(1).min(1).default(DEFAULT_MAX_INSTRUCTION_BYTES),
    reconnect: Reconnect,
  }),
  z.object({
    transport: z.const('streamable-http'),
    serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
    url: z.string().required(),
    headers: z.dict(String).default({}),
    toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
    failOnStartupError: z.boolean().default(false),
    maxInstructionBytes: z.number().step(1).min(1).default(DEFAULT_MAX_INSTRUCTION_BYTES),
    reconnect: Reconnect,
  }),
]) as z<ConfigInput, Config>

// ---- 插件装配 ----

/**
 * 连接一个 MCP 服务端，并在插件激活前发布其初始工具世代。
 * 该入口显式保持为 `async`：Cordis 会把带 prototype 的普通函数视作构造函数，
 * 而它返回的 Promise 不算启动工作。
 * @param ctx - 携带工具注册表的插件上下文。
 * @param config - 已解析的传输与服务端命名空间配置。
 * @returns 连接与初始工具发现都结算之后的启动就绪状态。
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  // 在加载时显式失败：重连配置错误（包括绕过 Schemastery 的编程式构造）会在
  // 任何 effect 注册之前就拒绝本实例。
  const reconnect = resolveReconnectPolicy(config.reconnect, `mcp-client(${config.serverName}): reconnect`)

  // 接下来预留命名空间：重复的 `serverName` 会在加载时让本实例失败，并给出
  // 可操作的错误信息，同时不影响先前已存在的实例。
  ctx.effect(() => {
    const owner = scopeOf(ctx) ?? ctx.root
    let names = activeServerNames.get(owner)
    if (!names) {
      names = new Set()
      activeServerNames.set(owner, names)
    }
    if (names.has(config.serverName)) {
      throw new Error(
        `mcp-client: serverName "${config.serverName}" is already in use by another mcp-client instance — pick a unique serverName in cordis.yml`,
      )
    }
    names.add(config.serverName)
    return () => void names.delete(config.serverName)
  }, 'mcp-client.serverName')

  // 监督器持有客户端/传输的世代、重连循环与在线的工具注册；销毁会停止重连、
  // 等待进行中的工作归于静止，并注销当前世代。
  const connection = startConnection(ctx, config, reconnect)
  registerServerContext(ctx, config.serverName, connection)
  let stopping: Promise<void> | undefined
  const dispose = (): Promise<void> => stopping ??= connection.dispose()
  // Cordis 会在等待未完成的 apply() 之前宣告卸载。此处关闭传输，可以释放
  // 仍在等待响应的启动请求。
  // oxlint-disable-next-line typescript/no-misused-promises -- Cordis 包容观察者失败；该 effect 也会 await 这个 promise。
  ctx.on('internal/plugin', (fiber) => {
    if (fiber !== ctx.fiber || fiber.uid !== null) return
    return dispose()
  }, { global: true })
  ctx.effect(() => dispose, 'mcp-client.connection')

  // 让插件激活阻塞在初始连接 + 工具发现上，使 Cordis 消费者在 fiber 激活后
  // 立即可见这些工具。failOnStartupError 为 true 时，失败的初始尝试会让该
  // fiber 被拒绝（Cordis 将其回滚）；否则错误只被记录，监督器进入重连循环。
  const outcome = await connection.ready
  if (outcome.error !== undefined && config.failOnStartupError) {
    throw new Error(`mcp-client(${config.serverName}): initial connection or tool synchronization failed`, { cause: outcome.error })
  }
}
