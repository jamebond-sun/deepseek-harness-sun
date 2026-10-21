/**
 * 位于 {@link HarnessClient} 之上的高层运行 API：`DeepSeekHarness` 跨多个
 * session 持有同一个运行时子进程；`HarnessSession.run` 发送一次提示，
 * 并在整个 agent 下一次变为空闲时 settle。
 *
 * @module @deepseek-ai/dsh-sdk-client/api
 */

import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import { createProcessHarnessClient, HarnessClient, isRecord, SdkProtocolError } from './client.ts'
import type { RuntimeProcessOptions } from './launch.ts'
import type { ContentBlock, DeepSeekHarnessOptions, HarnessNotification, RunResult, SdkPromptContentBlock } from './types.ts'

/**
 * 用于在运行时子进程中运行 DeepSeek Harness agent 轮次的可复用 SDK。
 * 子进程在首次使用时惰性启动，并一直由本实例持有，直到 {@link close}；
 * 请务必关闭（或使用 `await using`），以便子进程被回收。
 */
export class DeepSeekHarness implements AsyncDisposable {
  private clientInstance: HarnessClient
  private readonly createClient: () => HarnessClient
  private readonly cwd: string
  private readonly provider: string
  private readonly model: string
  private readonly reasoningEffort: DeepSeekHarnessOptions['reasoningEffort']
  private readonly maxTokens: number | undefined
  private initialized: Promise<void> | undefined
  private closed = false

  /** @param options - dsh 启动配置，加上 session 路由、推理强度与输出上限。 */
  constructor(options?: DeepSeekHarnessOptions)
  constructor(options: DeepSeekHarnessOptions = {}, clientFactory?: () => HarnessClient) {
    this.createClient = clientFactory ?? (() => new HarnessClient(options))
    this.clientInstance = this.createClient()
    // 在握手之前取绝对值：子进程相对「本」进程的 cwd 启动，而线上的 cwd
    // 会在子进程内部再次解析 —— 相对值会被解析两次
    // （例如 `worker` → `worker/worker`）。
    this.cwd = resolve(options.cwd ?? options.processCwd ?? process.cwd())
    this.provider = options.provider ?? 'deepseek-official'
    this.model = options.model ?? 'deepseek-v4-flash'
    this.reasoningEffort = options.reasoningEffort
    this.maxTokens = options.maxTokens
  }

  /**
   * 底层 JSON-RPC 客户端（为低层访问而暴露）。握手失败只有在清理证明确认
   * 运行时已经退出之后，才会换入一个全新的实例；清理失败则保留该客户端，
   * 因此不要在失败的 {@link start} 之后缓存它。
   * @returns 当前持有运行时子进程的客户端。
   */
  get client(): HarnessClient {
    return this.clientInstance
  }

  /**
   * 启动子进程并执行一次 `initialize` 握手。失败时，若 SDK 自管的清理成功，
   * 则回收运行时并安装一个新客户端（`HarnessClient.close` 是永久性的），
   * 因此后续调用会以新的子进程重试 —— 除非 {@link close} 已经终结了本 harness。
   * 如果清理同样失败，则以 `AggregateError` reject，其有序错误保留了两个原因，
   * 并保留失败的客户端，而不是在一个退出未被证明的进程旁边再启动一个。
   * @returns （记忆化的）握手的 settle 结果。
   */
  start(): Promise<void> {
    this.initialized ??= (async () => {
      try {
        this.clientInstance.start()
        await this.clientInstance.initialize({
          cwd: this.cwd,
          provider: this.provider,
          model: this.model,
          ...this.reasoningEffort === undefined ? {} : { reasoningEffort: this.reasoningEffort },
          ...this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens },
        })
      } catch (error) {
        this.initialized = undefined
        try {
          await this.clientInstance.close()
        } catch (cleanupError: unknown) {
          throw new AggregateError(
            [error, cleanupError],
            'DeepSeek Harness initialization and cleanup failed',
          )
        }
        if (!this.closed) this.clientInstance = this.createClient()
        throw error
      }
    })()
    return this.initialized
  }

  /**
   * 打开一个 session 句柄（不产生线上流量；运行时在该 session 的首次提示
   * 或工作目录操作时创建它）。
   * @param sessionId - 要复用的显式 id；省略时铸造一个新的。
   * @returns session 句柄。
   */
  session(sessionId?: string): HarnessSession {
    return new HarnessSession(this, sessionId ?? `session-${randomUUID().replaceAll('-', '')}`)
  }

  /**
   * 启动运行时并恢复一个持久化的 session，而不发送任何输入。
   * 所配置的 Harness home 必须包含其历史记录；缺失或已被占用的 session 会被拒绝。
   * @param sessionId - 待续接的确切持久化标识。
   * @returns 一个可以在已恢复历史上运行新提示的句柄。
   */
  async resumeSession(sessionId: string): Promise<HarnessSession> {
    await this.start()
    await this.client.resumeSession(sessionId)
    return new HarnessSession(this, sessionId)
  }

  /**
   * 在一个全新（或具名）的 session 上运行一次提示。
   * @param input - 提示文本，或原样发送的内容块。
   * @param options - 可选的 session id 与逐条通知的观察者。
   * @returns 受管的活动区间。
   */
  run(input: string | SdkPromptContentBlock[], options?: RunOptions): Promise<RunResult> {
    return this.session(options?.sessionId).run(input, options)
  }

  /**
   * 关闭并回收运行时子进程。幂等且终结 —— 已关闭的 harness 不再重试失败的握手。
   * @returns 完整拆除的 settle 结果。
   */
  close(): Promise<void> {
    this.closed = true
    return this.clientInstance.close()
  }

  /**
   * 支持 `await using`：同 {@link close}。
   * @returns 拆除的 settle 结果。
   */
  [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }
}

/** 针对通用进程构造高层 API，供包内的 fake-runtime 测试使用。 */
export function createProcessDeepSeekHarness(
  runtime: RuntimeProcessOptions,
  options: DeepSeekHarnessOptions = {},
): DeepSeekHarness {
  const Constructor = DeepSeekHarness as new (
    publicOptions: DeepSeekHarnessOptions,
    clientFactory: () => HarnessClient,
  ) => DeepSeekHarness
  return new Constructor({
    ...runtime.cwd === undefined ? {} : { processCwd: runtime.cwd },
    ...options,
  }, () => createProcessHarnessClient(runtime))
}

/** 每次运行的选项：目标 session 与流式观察者。 */
export interface RunOptions {
  /** 运行所用的 session id；省略时每次调用铸造一个新的 session。 */
  sessionId?: string
  /** 以该 session 树的每一条通知调用的观察者，按线上顺序。 */
  onNotification?: (notification: HarnessNotification) => void
}

/**
 * 一个 SDK session：一个稳定 id 加上受管的活动区间。
 */
export class HarnessSession {
  /**
   * @param harness - 所属的 harness（提供客户端与握手）。
   * @param id - 该句柄所运行的线上 session id。
   */
  constructor(readonly harness: DeepSeekHarness, readonly id: string) {}

  /**
   * 读取有效目录，并把缺失的目录恢复到 Session 的来源目录。
   * @returns 新的独立操作所使用的绝对目录。
   */
  async getWorkingDirectory(): Promise<string> {
    await this.harness.start()
    return this.harness.client.getWorkingDirectory(this.id)
  }

  /**
   * 修改有效目录，而不移动已有进程或改变权限。
   * @param path - 绝对目录，或相对 Session 当前目录的目录。
   * @returns 经过校验的绝对目录。
   */
  async setWorkingDirectory(path: string): Promise<string> {
    await this.harness.start()
    return this.harness.client.setWorkingDirectory(this.id, path)
  }

  /**
   * 入队一次提示，然后观察整个 session 直到它的下一次空闲。
   * @param input - 提示文本，或原样发送的内容块。
   * @param options - 可选的逐条通知观察者。
   * @returns 受管的活动区间；传输中断、超时或协议错误时 reject。
   */
  async run(input: string | SdkPromptContentBlock[], options?: Pick<RunOptions, 'onNotification'>): Promise<RunResult> {
    await this.harness.start()
    const client = this.harness.client
    const contentBlocks = normalizeInput(input)
    const events: SessionEvent[] = []
    const notifications: HarnessNotification[] = []

    const subscription = client.subscribeSessionTree(this.id)
    const collect = (notification: HarnessNotification): void => {
      if (notification.method === 'session.event' && notification.params.sessionId === this.id) {
        // 线上边界：该信封会喂给带类型的 RunResult，因此运行时的畸形数据
        // 会表现为协议错误，而不是类型非法的数据（也不会从 finalResponse
        // 里抛出 TypeError）。
        const event = validatedSessionEvent(notification.params.event)
        notifications.push(notification)
        options?.onNotification?.(notification)
        events.push(event)
        return
      }
      notifications.push(notification)
      options?.onNotification?.(notification)
    }
    try {
      const messageId = await client.prompt(this.id, contentBlocks)
      let received = false
      while (true) {
        const notification = await subscription.next()
        if (!received) {
          if (notification.method !== 'session.event'
            || notification.params.sessionId !== this.id
            || !isInboxReceipt(notification.params.event, messageId)) continue
          received = true
        }
        collect(notification)
        if (notification.method === 'session.status'
          && notification.params.sessionId === this.id
          && notification.params.status === 'idle') break
      }
    } finally {
      subscription.close()
    }

    return {
      sessionId: this.id,
      finalResponse: finalResponse(events),
      events,
      notifications,
    }
  }
}

/**
 * 归一化运行输入：字符串变成单个文本块；内容块原样透传。
 * @param input - 提示文本或内容块。
 * @returns 要发送的内容块。
 */
export function normalizeInput(input: string | SdkPromptContentBlock[]): SdkPromptContentBlock[] {
  return typeof input === 'string' ? [{ type: 'text', text: input }] : input
}

/** 校验线上 turn-end 原因中由 provider 读取的字段。 */
function validatedTurnEndReason(value: unknown): TurnEndReason {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw new SdkProtocolError(`turn/end carried no reason envelope: ${JSON.stringify(value)}`)
  }
  if (value.kind === 'aborted') {
    if (!isRecord(value.reason) || typeof value.reason.kind !== 'string') {
      throw new SdkProtocolError(`turn/end carried a malformed aborted reason: ${JSON.stringify(value)}`)
    }
    switch (value.reason.kind) {
      case 'user':
      case 'parent':
      case 'disposed':
      case 'legacy':
        break
      case 'hook':
        if (typeof value.reason.reason !== 'string') {
          throw new SdkProtocolError(`turn/end carried a malformed hook abort reason: ${JSON.stringify(value)}`)
        }
        break
      default:
        throw new SdkProtocolError(`turn/end carried an unknown abort reason: ${JSON.stringify(value)}`)
    }
  }
  return value as TurnEndReason
}

/**
 * 校验事件信封，以及 SDK 读取方所消费的 assistant/turn 字段。
 * @param value - 原始的 `session.event` 事件载荷。
 * @returns 该事件；当被消费的字段畸形时抛出协议错误。
 */
export function validatedSessionEvent(value: unknown): SessionEvent {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new SdkProtocolError(`session.event carried no event envelope: ${JSON.stringify(value)}`)
  }
  // 本模块唯一会读入（finalResponse）的那个变体必须携带带 kind 标记的内容块；
  // 其他变体按其信封结构原样通过。
  if (value.type === 'assistant/message') {
    const message = isRecord(value.data) ? value.data.message : undefined
    const content = isRecord(message) ? message.content : undefined
    if (!Array.isArray(content) || !content.every(block => isRecord(block) && typeof block.type === 'string')) {
      throw new SdkProtocolError(`assistant/message event carried malformed content: ${JSON.stringify(value)}`)
    }
  }
  if (value.type === 'turn/end') {
    const data = isRecord(value.data) ? value.data : undefined
    if (data === undefined) {
      throw new SdkProtocolError(`turn/end event carried malformed data: ${JSON.stringify(value)}`)
    }
    validatedTurnEndReason(data.reason)
  }
  return value as SessionEvent
}

/** 判断一条原始 session 事件是否为 `messageId` 的持久化入队回执。 */
function isInboxReceipt(value: unknown, messageId: string): boolean {
  if (!isRecord(value) || value.type !== 'agent/inbox/spliced' || !isRecord(value.data)) return false
  const inserted = value.data.inserted
  return Array.isArray(inserted) && inserted.some(message => isRecord(message) && message.id === messageId)
}

/**
 * 提取最后一条助手消息的拼接文本。
 * @param events - 该活动区间的 `session.event` 载荷，按线上顺序排列。
 * @returns 最终响应文本；当不存在助手消息时为 `''`。
 */
export function finalResponse(events: SessionEvent[]): string {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    return event.data.message.content
      .filter((block): block is ContentBlock & { type: 'text' } => block.type === 'text')
      .map(block => block.text)
      .join('')
  }
  return ''
}
