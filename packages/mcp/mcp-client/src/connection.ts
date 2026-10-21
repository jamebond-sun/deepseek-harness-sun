/**
 * 连接监督器：为一个插件实例持有 MCP 客户端/传输的世代（generation），
 * 让 harness 工具注册表与当前活跃世代保持同步，并在连接断开时以有界的
 * 指数退避重启已配置的服务端。
 *
 * 一次故障期共享一份尝试预算（连续失败 `maxAttempts` 次，延迟从
 * `initialDelayMs` 起翻倍直至 `maxDelayMs`）。连接存活超过稳定窗口即视为
 * 本次故障期结束，下一次断线重新计一份预算；而反复崩溃的服务端——即便偶尔
 * 连接成功——仍会耗尽上限，不会无限重启。预算耗尽后注销该服务端的全部工具
 * 并停止重连；只有销毁（含 HMR）才能从该状态恢复。
 *
 * @module
 */

import { Client, type Transport } from '@modelcontextprotocol/client'
import type { Context } from '@deepseek-ai/cordis'
import { assertNever, type JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ServerContext } from './server-context.ts'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { createTransport } from './transport.ts'
import { syncTools } from './tools.ts'
import type { ToolBridgeOptions, ToolDisposers } from './tools.ts'
import type { Config } from './index.ts'

/** 单个 MCP 服务端连接的自动重连策略。 */
export interface ReconnectConfig {
  /** 连接丢失后自动重连（默认 true）。 */
  enabled?: boolean
  /** 首次重连延迟（毫秒）；每连续失败一次即翻倍（默认 500）。 */
  initialDelayMs?: number
  /** 退避上限（毫秒）；同时也是重置尝试预算所需的存活时长（默认 30000）。 */
  maxDelayMs?: number
  /** 一次故障期内连续失败多少次后彻底放弃（默认 10）。 */
  maxAttempts?: number
}

/** Config schema 与 {@link resolveReconnectPolicy} 共用的默认值。 */
export const RECONNECT_DEFAULTS: Required<ReconnectConfig> = Object.freeze({
  enabled: true,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  maxAttempts: 10,
})

/** 归集的服务端指令文本的 UTF-8 字节默认上限。 */
export const DEFAULT_MAX_INSTRUCTION_BYTES = 32_768

// SDK 的 stdio 传输自带两段两秒的终止宽限期。
// 再多留一秒给进程关闭事件，用以确认旧世代已经消失；超时按「关闭失败」处理，
// 以免子进程重叠。
const GENERATION_CLOSE_TIMEOUT_MS = 5_000

/** 插件加载时捕获的、完全解析后的重连策略。 */
export type ResolvedReconnectPolicy = Readonly<Required<ReconnectConfig>>

/**
 * 从原始重连配置到监督器实际执行策略的唯一一次显式解析。
 * 以编程方式构造插件可能绕过 Schemastery 的规范化，因此此处重新判定每一个
 * 默认值与边界——配置错误会在加载时让该插件实例失败。
 *
 * @param config - 原始的 `reconnect` 配置；省略则使用默认值。
 * @param path - 诊断前缀，用于在抛出的信息中标明配置位置。
 * @returns 冻结后的已解析策略。
 */
export function resolveReconnectPolicy(config: ReconnectConfig | undefined, path: string): ResolvedReconnectPolicy {
  if (config !== undefined) {
    for (const key of Object.keys(config)) {
      if (!Object.hasOwn(RECONNECT_DEFAULTS, key)) throw new Error(`${path}.${key} is not a reconnect option`)
    }
  }
  const enabled = config?.enabled ?? RECONNECT_DEFAULTS.enabled
  const initialDelayMs = config?.initialDelayMs ?? RECONNECT_DEFAULTS.initialDelayMs
  const maxDelayMs = config?.maxDelayMs ?? RECONNECT_DEFAULTS.maxDelayMs
  const maxAttempts = config?.maxAttempts ?? RECONNECT_DEFAULTS.maxAttempts
  /* jscpd:ignore-start — 该延迟校验属领域特定逻辑，与 llm 重试策略平行；不可抽取 */
  if (!Number.isFinite(initialDelayMs) || initialDelayMs <= 0 || initialDelayMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${path}.initialDelayMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (!Number.isFinite(maxDelayMs) || maxDelayMs <= 0 || maxDelayMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${path}.maxDelayMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (initialDelayMs > maxDelayMs) {
    throw new Error(`${path}.initialDelayMs must be less than or equal to maxDelayMs`)
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`${path}.maxAttempts must be a positive integer`)
  }
  /* jscpd:ignore-end */
  return Object.freeze({ enabled, initialDelayMs, maxDelayMs, maxAttempts })
}

/** 首次连接尝试的结果，服务于「等待启动」语义。 */
export interface ConnectionOutcome {
  /** 首次连接或工具同步失败时为对应错误；否则不存在。 */
  error?: unknown
}

/** 一个插件实例的受监督连接句柄。 */
export interface ConnectionHandle extends ServerContext {
  /**
   * 在首次连接尝试完成（成功或失败）时结算。
   * 无论结果如何，监督器都会进入重连循环；启动失败是否致命，由调用方通过
   * `failOnStartupError` 决定。
   */
  ready: Promise<ConnectionOutcome>
  /**
   * 停止重连，关闭正在协商的传输或在线客户端，等待进行中的尝试与已排队的
   * 工具同步归于静止，然后注销该服务端仍持有的全部工具。
   */
  dispose(): Promise<void>
}

/**
 * 为一个 MCP 服务端启动受监督连接，并按重连策略保持其存活。
 *
 * @param ctx - 提供 `tools` 注册表与 logger 的 Cordis 上下文。
 * @param config - 已解析的插件配置，决定传输方式与服务端标识。
 * @param policy - {@link resolveReconnectPolicy} 得到的已解析重连策略。
 * @returns 句柄：含用于等待启动的 `ready` promise 与用于拆除的 `dispose`。
 */
export function startConnection(ctx: Context, config: Config, policy: ResolvedReconnectPolicy): ConnectionHandle {
  const label = `mcp-client(${config.serverName})`
  const incompleteDisposalMessage = `${label}: transport closure could not be confirmed during disposal — server shutdown may be incomplete`
  const opts: ToolBridgeOptions = {
    registrationFailure: 'contain',
    serverName: config.serverName,
    toolCallTimeoutMs: config.toolCallTimeoutMs,
  }
  // 配置了 failOnStartupError 时，初始同步使用 'throw'，使注册冲突传播到
  // 启动等待路径。重新同步与重连后的同步一律包容冲突。
  const startupOpts: ToolBridgeOptions = config.failOnStartupError
    ? { ...opts, registrationFailure: 'throw' }
    : opts

  let disposed = false
  const maxInstructionBytes = config.maxInstructionBytes ?? DEFAULT_MAX_INSTRUCTION_BYTES
  let serverInstructions = ''
  /** 当前世代：正在连接或已连接的客户端；退避等待期间与最终失败后为 undefined。 */
  let client: Client | undefined
  /** 与 {@link client} 配对的、感知传输的关闭操作。 */
  let closeClient: (() => Promise<boolean>) | undefined
  /** 本服务端持有的在线工具注册；只有 {@link enqueueSync} 与 dispose 会替换它。 */
  let disposers: ToolDisposers = new Map()
  let reconnectTimer: NodeJS.Timeout | undefined
  /** 当前故障期内连续失败的连接尝试次数。 */
  let failedAttempts = 0
  /** 当前世代完成连接与初始同步的时刻；掉线期间为 undefined。 */
  let connectedAt: number | undefined
  /** 首次连接尝试的真实错误，用于启动等待的诊断。 */
  let firstAttemptError: unknown

  /** 只有当某个世代是插件存活期间的当前世代时，它才可以行动。 */
  const isCurrent = (generation: Client): boolean => !disposed && client === generation

  /**
   * 将每一次 syncTools 调用串行化——包括所有世代的初始同步与通知触发的
   * 重新同步——使两次同步的「先销毁旧的、再注册新的」切换永不交错
   * （否则会把一个世代重复销毁，并泄漏另一个世代）。
   */
  let syncChain: Promise<void> = Promise.resolve()
  function enqueueSync(generation: Client, syncOpts: ToolBridgeOptions = opts): Promise<void> {
    const run = syncChain.then(async () => {
      if (!isCurrent(generation)) return
      disposers = await syncTools(generation, ctx, syncOpts, disposers)
    })
    // 链尾必须能在某次同步失败后继续存活；报告责任归发起调用的一方。
    syncChain = run.catch(() => {})
    return run
  }

  /** 每个世代只做一次断线决策：isCurrent 守卫让相互竞争的关闭/错误信号保持幂等。 */
  function generationDown(generation: Client): void {
    if (!isCurrent(generation)) return
    client = undefined
    closeClient = undefined
    scheduleReconnect()
  }

  /** 在失败连接的关闭屏障结算之后，决定重试归属。 */
  function settleFailedGeneration(generation: Client, quiesced: boolean): void {
    if (!isCurrent(generation)) return
    if (!quiesced) {
      client = undefined
      closeClient = undefined
      ctx.logger.error(`${label}: failed generation could not confirm transport closure — reconnect stopped to avoid overlapping server processes; reload the plugin or restart the Host to retry`)
      return
    }
    generationDown(generation)
  }

  /** 等待传输持有的关闭信号，同时不让坏掉的传输把拆除流程永久卡死。 */
  function waitForClose(closed: Promise<void>): Promise<boolean> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => { resolve(false) }, GENERATION_CLOSE_TIMEOUT_MS)
      timeout.unref()
      void closed.then(() => {
        clearTimeout(timeout)
        resolve(true)
      })
    })
  }

  function scheduleReconnect(): void {
    const lostEstablishedConnection = connectedAt !== undefined
    if (!policy.enabled) {
      const message = lostEstablishedConnection
        ? 'connection lost and reconnect is disabled — registered tools will fail until an HMR reload or Host restart'
        : 'connection failed and reconnect is disabled — no tools were registered; reload the plugin or restart the Host to connect'
      ctx.logger.error(`${label}: ${message}`)
      return
    }
    // 存活超过稳定窗口（= maxDelayMs，即最长的退避间隔）的连接意味着上一次
    // 故障期已经结束：重新开启一份预算。
    if (connectedAt !== undefined && Date.now() - connectedAt >= policy.maxDelayMs) failedAttempts = 0
    connectedAt = undefined
    failedAttempts += 1
    if (failedAttempts > policy.maxAttempts) {
      // 把「放弃」时的销毁动作排入队列，以免它与进行中同步的第二阶段切换
      // 竞争（该切换在队列内部检查 isCurrent）。
      syncChain = syncChain.then(() => {
        for (const dispose of disposers.values()) dispose()
        disposers = new Map()
        serverInstructions = ''
      })
      ctx.logger.error(`${label}: giving up after ${policy.maxAttempts} consecutive failed reconnect attempts — tools unregistered; reload the plugin or restart the Host to reconnect`)
      return
    }
    const delayMs = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** (failedAttempts - 1))
    const action = lostEstablishedConnection ? 'connection lost; reconnecting' : 'connection failed; retrying'
    ctx.logger.warn(`${label}: ${action} in ${delayMs}ms (attempt ${failedAttempts}/${policy.maxAttempts})`)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      settling = connectGeneration(false)
    }, delayMs)
    // 已就绪的重连定时器绝不能凭一己之力让进程保持存活。
    reconnectTimer.unref()
  }

  /**
   * 一次连接尝试：新建传输 + 客户端（MCP SDK 中一个 Protocol 终生绑定一个
   * 传输），连接，然后把初始工具同步排入队列。启动标志归属于该次尝试而非
   * 共享同步队列，因此早期通知无法消耗严格的启动语义。
   * 一切失败都经由 {@link generationDown} 收敛；成功则挂上由 onclose 驱动的
   * 断线路径。永不 reject。
   *
   * @param startup - 是否为该插件的激活尝试。
   */
  async function connectGeneration(startup: boolean): Promise<void> {
    const generation = new Client(
      { name: 'dsh-mcp-client', version: '0.0.1' },
      {
        capabilities: {},
        versionNegotiation: { mode: 'auto' },
        listChanged: {
          tools: {
            autoRefresh: false,
            debounceMs: 0,
            onChanged: () => { void refreshTools() },
          },
        },
      },
    )
    const closed: PromiseWithResolvers<void> = Promise.withResolvers()
    let attemptSettled = false
    let closeObserved = false
    let transport: Transport | undefined
    const hasClosed = (): boolean => closeObserved
    client = generation
    closeClient = closeGeneration
    generation.onclose = () => {
      closeObserved = true
      closed.resolve()
      // 失败的连接在下面的 catch 路径中自行持有其关闭屏障。已建立连接的
      // 世代可以直接从该信号转入掉线状态。
      if (attemptSettled) generationDown(generation)
    }
    /** 未附加的探测经由各自的传输关闭；已附加的客户端还必须报告传输已关闭。 */
    async function closeGeneration(): Promise<boolean> {
      const attached = generation.transport !== undefined
      try {
        await (attached ? generation.close() : transport?.close())
      } catch (_error) {
        if (!attached) return hasClosed()
      }
      return !attached || hasClosed() || await waitForClose(closed.promise)
    }
    async function refreshTools(): Promise<void> {
      if (!isCurrent(generation)) return
      ctx.logger.info(`${label}: tool list changed, re-syncing`)
      try {
        await enqueueSync(generation)
      } catch (error) {
        if (!disposed) ctx.logger.error(`${label}: tool re-sync failed: ${String(error)}`)
      }
    }
    let instructions: string
    try {
      transport = createTransport(config)
      await generation.connect(transport)
      if (hasClosed()) {
        attemptSettled = true
        generationDown(generation)
        return
      }
      if (!isCurrent(generation)) {
        if (!await closeGeneration()) ctx.logger.error(incompleteDisposalMessage)
        return
      }
      const serverText = generation.getInstructions()?.trimEnd() ?? ''
      instructions = serverText ? `### MCP server: ${config.serverName}\n\n${serverText}` : ''
      if (Buffer.byteLength(instructions) > maxInstructionBytes) {
        throw new Error(`${label}: server instructions exceed maxInstructionBytes (${maxInstructionBytes})`)
      }
      await enqueueSync(generation, startup ? startupOpts : opts)
    } catch (error) {
      if (firstAttemptError === undefined) firstAttemptError = error
      // 销毁会在关闭世代之前清除当前归属，因此只有存活的监督器才会报告
      // 一次尝试失败。
      if (isCurrent(generation)) ctx.logger.warn(`${label}: connection attempt failed: ${String(error)}`)
      const quiesced = await closeGeneration()
      attemptSettled = true
      settleFailedGeneration(generation, quiesced)
      return
    }
    attemptSettled = true
    if (hasClosed()) {
      generationDown(generation)
      return
    }
    if (!isCurrent(generation)) return
    serverInstructions = instructions
    connectedAt = Date.now()
    if (failedAttempts > 0) ctx.logger.info(`${label}: reconnected and re-synced tools (attempt ${failedAttempts}/${policy.maxAttempts})`)
  }

  /** 进行中（或最近已结算的）连接尝试；dispose 等待它以达致静止。 */
  let settling = connectGeneration(true)

  // ready promise 在首次尝试结束（无论成败）时结算。若首次尝试失败且启用了
  // 重连，监督器已经在安排重试——ready 只负责报告结果。
  const ready: Promise<ConnectionOutcome> = settling.then(() => {
    // 结算之后：若 client 已被设置，说明初始连接 + 同步成功。
    // 否则监督器要么已安排重试（错误已记录），要么已放弃（错误已记录）。
    // 两种情况下都会连同真实错误一起报告结果。
    // 注意：settling.then() 是微任务，而 stdio 的 onclose 是宏任务——因此
    // 在初始同步成功之后才崩溃的服务端，无法在该续体运行之前把 client
    // 翻转为 undefined。
    if (client !== undefined) return {}
    /* v8 ignore next -- 防御性：连接/同步失败时 firstAttemptError 必定已被设置 */
    return { error: firstAttemptError ?? new Error(`${label}: initial connection failed`) }
  })

  return {
    ready,
    instructions: () => serverInstructions,
    resources: {
      async request(request, exec): Promise<JsonValue> {
        const generation = client
        if (!generation || connectedAt === undefined) throw new Error(`${label}: server is disconnected`)
        const options = { signal: exec.signal, timeout: config.toolCallTimeoutMs }
        switch (request.method) {
          case 'resources/list':
            return await generation.listResources(
              request.cursor === undefined ? undefined : { cursor: request.cursor }, options,
            ) as JsonValue
          case 'resources/templates/list':
            return await generation.listResourceTemplates(
              request.cursor === undefined ? undefined : { cursor: request.cursor }, options,
            ) as JsonValue
          case 'resources/read':
            return await generation.readResource({ uri: request.uri }, options) as JsonValue
          /* v8 ignore next 2 -- 资源请求是封闭的、带类型的工具操作联合 */
          default:
            return assertNever(request)
        }
      },
    },
    async dispose(): Promise<void> {
      disposed = true
      serverInstructions = ''
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer)
        reconnectTimer = undefined
      }
      const close = closeClient
      client = undefined
      closeClient = undefined
      if (close !== undefined && !await close()) {
        ctx.logger.error(incompleteDisposalMessage)
      }
      // 要等到真正静止，而不只是发出请求：进行中的尝试会在结算之前把同步
      // 排入队列，因此同时等待两者之后 `disposers` 才是最终状态。
      await settling
      await syncChain
      for (const dispose of disposers.values()) dispose()
      disposers = new Map()
    },
  }
}
