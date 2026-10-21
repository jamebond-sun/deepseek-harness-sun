/**
 * 授权能力 seam（`ctx.authorization`）的 Service Definition：获取一份任何人都
 * 无法仅凭配置提供的凭证，因为得到它需要一场与人类的对话——打开此页、粘贴
 * 那段代码、选择一个账户。
 *
 * 该 seam 拥有对话与生命周期；它从不拥有协议。一个知道如何获取自身凭证的插件
 * 注册一个以该流程所写入的 `CredentialKey` 为键的流程，而该流程通过一套中性的
 * 通知与提示词汇，与启动它的任意界面对话。因此第二种授权协议以又一个流程的
 * 形式到来，而非又一个 seam；而能渲染一个流程的界面也就能渲染它们全部。
 *
 * ```ts
 * const dispose = ctx.authorization.registerFlow({
 *   key: credentialKey('llm-pi-ai', 'openai-codex'),
 *   label: 'ChatGPT (Codex)',
 *   methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
 *   async run(session) {
 *     session.notify({ message: 'Continue in your browser', url })
 *     await commitThroughCredentials(await exchange(session.signal))
 *   },
 * })
 * ```
 *
 * @module @deepseek-ai/dsh-authorization
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { HarnessError } from '@deepseek-ai/dsh-llm'

import type {
  AuthorizationEntry, AuthorizationMethod, AuthorizationNotice, AuthorizationOutcome, AuthorizationPrompt,
  AuthorizationSettlement,
} from './types.ts'

export type {
  AuthorizationEntry, AuthorizationMethod, AuthorizationNotice, AuthorizationOutcome, AuthorizationPrompt,
  AuthorizationPromptOption, AuthorizationSettlement, AuthorizationStatus,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    authorization: AuthorizationService
  }

  interface Events {
    /**
     * 一次授权尝试已结束并释放了其键。为每一个终态结果（含失败）触发，因此一个
     * 正在观察它未发起的键的界面（第二个浏览器标签页）也能得知该尝试已结束。
     * @mode emit
     * @param key - 已结束尝试所正在授权的凭证记录。
     * @param settlement - 它如何结束，包括其调用方视为抛出错误的 `failed` 情况。
     */
    'authorization/settled'(key: CredentialKey, settlement: AuthorizationSettlement): void
  }
}

/** 授权失败的、稳定的错误分类。 */
export class AuthorizationError extends HarnessError {
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'AuthorizationError'
  }
}

/**
 * {@link AuthorizationInteraction.prompt} 用来表达“人类拒绝”的拒绝——驳回了
 * 问题、选择不回答——而非界面崩溃。一个在提示被拒绝之后流程失败的尝试以
 * `cancelled` 结算，与撤回的信号结果相同，因为人类说“不”是一种拒绝，而非故障。
 * 只有人类的“不”才可用此类拒绝：一个被自身 `signal` 撤回的提示（流程弃用竞速中
 * 落败的问题）必须以其他东西拒绝，否则稍后真正的失败会被误读为拒绝。
 */
export class AuthorizationDeclinedError extends AuthorizationError {
  constructor(message = 'the authorization prompt was declined') {
    super(message, 'DECLINED')
    this.name = 'AuthorizationDeclinedError'
  }
}

/**
 * 一个运行中的流程被给予、用来与人类对话的东西。每个成员都限定于一次尝试：
 * 流程既不知道也不选择哪个界面在倾听。
 */
export interface AuthorizationSession {
  /** 调用方所选的方法 id，始终是该流程声明过的一个。 */
  readonly method: string
  /** 当调用方撤回或针对此键调用 `cancel()` 时中止。 */
  readonly signal: AbortSignal
  /**
   * 提交一条记录，同时拒绝已被取消的尝试。一旦被接纳，取消会等待完成。
   * @param record - 由本流程拥有的凭证。
   * @returns 在凭证存储提交该记录之后。
   */
  commit(record: CredentialRecord): Promise<void>
  /**
   * 报告进度，或告诉人类接下来要做什么。即发即忘：一个无法渲染通知的界面
   * 绝不能让流程停滞。
   * @param notice - 消息，以及它所涉及的任何页面或代码。
   */
  notify(notice: AuthorizationNotice): void
  /**
   * 向人类提出一个流程无法自行回答的问题。
   * @param prompt - 要问什么，以及应如何呈现。
   * @returns 人类键入的文本，或所选选项的 id。
   * @throws 当人类拒绝，或提示自身的 signal 将其撤回时。
   */
  prompt(prompt: AuthorizationPrompt): Promise<string>
}

/**
 * 一个插件关于如何获取某份凭证的知识。流程拥有写入：`run()` 的解析意味着 `key`
 * 对应的记录在此次运行期间通过 `ctx.credentials` 提交，这是该 seam 在报告成功前
 * 所确认的事实——一次在尝试内观测到、且在尝试之后仍然存在的提交。在流程内部提交，
 * 使得一个通过其自身存储适配器持久化的库（pi-ai 的 `Models.login()`）得以成为
 * 唯一的写入方，而非被复制出来写两次。
 */
export interface AuthorizationFlow {
  /** 此流程所写入的凭证记录。其 scope 命名了拥有插件。 */
  readonly key: CredentialKey
  /** 正被授权内容的、面向用户的名称。 */
  readonly label: string
  /**
   * 所提供的方法，按偏好程度从高到低；未指定方法者取第一个。以非空元组类型化，
   * 因为一个无事可运行的流程是一个无法开始的流程，而类型在唯一书写流程之处
   * 即说明了这一点。
   */
  readonly methods: readonly [AuthorizationMethod, ...AuthorizationMethod[]]
  /**
   * 运行一次尝试以获取并提交凭证。
   * @param session - 所选方法、取消信号，以及交互回调。
   * @returns 在记录被提交之后。
   * @throws 当尝试失败或人类拒绝时。
   */
  run(session: AuthorizationSession): Promise<void>
}

/**
 * 一次尝试的界面半边。随请求提供而非注册，因为发起授权的调用方正是那个能与
 * 人类谈论它的一方：提示恰好抵达发起请求的页面，而无头调用方提供一个会拒绝的
 * 交互。
 */
export interface AuthorizationInteraction {
  /**
   * 渲染来自运行流程的通知。
   * @param notice - 消息，以及它所涉及的任何页面或代码。
   */
  notify(notice: AuthorizationNotice): void
  /**
   * 向人类提出问题并等待。
   * @param prompt - 要问什么，以及应如何呈现。
   * @returns 键入的文本，或所选选项的 id。
   * @throws {AuthorizationDeclinedError} 当人类拒绝时；任何其他拒绝都读作界面
   *   失败，而非一个答案。
   */
  prompt(prompt: AuthorizationPrompt): Promise<string>
}

/** 一次授权某个键的请求。 */
export interface AuthorizationRequest {
  /** 要授权的凭证记录；必须已为其注册一个流程。 */
  key: CredentialKey
  /** 要运行的流程方法之一。默认为流程的第一个。 */
  method?: string
  /** 将渲染此次尝试的通知与提示的界面。 */
  interaction: AuthorizationInteraction
  /** 撤回整个尝试。 */
  signal?: AbortSignal
}

/** 一次在途的尝试，以及撤回它的句柄。 */
interface InFlight {
  readonly controller: AbortController
  committing: boolean
}

/**
 * `ctx.authorization`：一个凭证获取流程的注册表，每个键同一时刻仅一次尝试。
 */
export class AuthorizationService extends Service {
  /** 本 seam 所确认的那次提交是一次凭证记录的写入，因此存储是必需的，而非可选的。 */
  static inject = ['credentials']

  private readonly flows = new Map<CredentialKey, AuthorizationFlow>()
  private readonly running = new Map<CredentialKey, InFlight>()

  constructor(ctx: Context) {
    super(ctx, 'authorization')
  }

  /**
   * 提供一种获取某份凭证的方式。每个键仅一个流程：两个插件若声明同一键，会各自
   * 以自己的格式写入一条记录，而最后运行的那个会让另一个读到它无法解析的载荷。
   *
   * @param flow - 它写入的键、其标签、其方法，以及其运行器。
   * @returns 撤回此流程的释放器。
   * @throws {AuthorizationError} 当该键已被声明时，错误码 `DUPLICATE_FLOW`。
   */
  registerFlow(flow: AuthorizationFlow): () => void {
    const dispose = this.ctx.effect(function* (this: AuthorizationService) {
      if (this.flows.has(flow.key)) {
        throw new AuthorizationError(
          `an authorization flow for "${flow.key}" is already registered`, 'DUPLICATE_FLOW')
      }
      this.flows.set(flow.key, flow)
      yield () => {
        this.flows.delete(flow.key)
        // 一个在尝试中途离场的流程会带上它的尝试一并离开：运行器属于一个正在
        // 退出的插件，因此任由它继续提示会超越那个能够为其作答的 fiber 的寿命。
        this.cancel(flow.key)
      }
    }.bind(this), 'authorization.registerFlow()')
    return () => void dispose()
  }

  /**
   * 每个已注册流程，供界面列出可被授权的内容。
   * @returns 按注册顺序、每个流程一个条目。
   */
  list(): readonly AuthorizationEntry[] {
    return [...this.flows.values()].map(flow => this.entry(flow))
  }

  /**
   * 一个已注册流程。
   * @param key - 要询问的凭证记录。
   * @returns 该条目；当没有流程声明该键时为 undefined。
   */
  describe(key: CredentialKey): AuthorizationEntry | undefined {
    const flow = this.flows.get(key)
    return flow === undefined ? undefined : this.entry(flow)
  }

  /** 一个已注册流程的公开视图。 */
  private entry(flow: AuthorizationFlow): AuthorizationEntry {
    return {
      key: flow.key,
      label: flow.label,
      methods: flow.methods,
      inFlight: this.running.has(flow.key),
    }
  }

  /**
   * 撤回为某个键正在运行的尝试（若有）。与请求自身的 signal 分开，是因为
   * 请求/响应传输会在第二次调用时响应“取消”按钮，而手上没有第一次调用 signal 的句柄。
   * @param key - 其尝试应当停止的凭证记录。
   */
  cancel(key: CredentialKey): void {
    const running = this.running.get(key)
    if (running !== undefined && !running.committing) running.controller.abort()
  }

  /**
   * 运行一次尝试以授权某个键，并报告其如何结束。
   *
   * 每个键同一时刻仅一次尝试。第二个调用方会被拒绝而非被合并：两者会通过同一个
   * 流程提示不同的人类，而第二个会去回答第一个被问到的问题。
   *
   * @param request - 键、方法、界面，以及取消信号。
   * @returns 当流程的记录在此次尝试期间被提交并被观测到时为 `authorized`，
   *   当人类拒绝或调用方撤回时为 `cancelled`。
   * @throws {AuthorizationError} 当没有流程声明该键时为 `NO_FLOW`；当所命名的
   *   方法不是该流程提供的方法之一时为 `UNKNOWN_METHOD`；当已有针对该键的尝试
   *   在运行时为 `ALREADY_IN_FLIGHT`；当流程在尝试期间未提交任何记录即解析时为
   *   `NOT_COMMITTED`。
   */
  async begin(request: AuthorizationRequest): Promise<AuthorizationOutcome> {
    const { key } = request
    const flow = this.flows.get(key)
    if (flow === undefined) {
      throw new AuthorizationError(`no authorization flow is registered for "${key}"`, 'NO_FLOW')
    }
    const method = request.method ?? flow.methods[0].id
    if (!flow.methods.some(candidate => candidate.id === method)) {
      throw new AuthorizationError(
        `authorization flow for "${key}" offers no method "${method}"`, 'UNKNOWN_METHOD')
    }
    if (this.running.has(key)) {
      throw new AuthorizationError(
        `an authorization attempt for "${key}" is already running`, 'ALREADY_IN_FLIGHT')
    }
    // 在开始之前就撤回：绝不占用槽位，也绝不运行流程。把一个已中止的 signal 交给
    // `run()` 会依赖于每个流程在它的第一个 await 之前都检查它，而一旦有流程不检查，
    // 就会在持有该键的情况下挂起。校验仍先运行，因此无论调用方是否同时放弃，
    // 只要它命名了一个不存在的键或方法，就会收到相应错误。
    if (request.signal?.aborted === true) return { status: 'cancelled' }
    const controller = new AbortController()
    const withdraw = (): void => {
      const running = this.running.get(key)
      if (running !== undefined && !running.committing) controller.abort(request.signal?.reason)
    }
    request.signal?.addEventListener('abort', withdraw, { once: true })
    this.running.set(key, { controller, committing: false })
    let settlement: AuthorizationSettlement = 'failed'
    try {
      const outcome = await this.attempt(flow, method, controller.signal, request.interaction)
      settlement = outcome.status
      return outcome
    } finally {
      request.signal?.removeEventListener('abort', withdraw)
      this.running.delete(key)
      // After the slot is released, so a listener that reacts by starting the
      // next attempt is not refused by the one that just finished.
      this.settle(key, settlement)
    }
  }

  /* jscpd:ignore-start -- 与 credentials seam 的提交扇出（`CredentialProvider`）
     刻意为之的对称性：被包容派发的形态是经过审阅的监听器生命周期契约，抽取它会
     把两个 seam 的事件语义耦合起来。 */
  /**
   * 将 `authorization/settled` 扇出，并包容监听器失败：每个监听器都会运行，
   * 同步抛出或异步拒绝都会被记录，而不改变已结束尝试自身的结果。当此函数触发时，
   * 该尝试已经结束且其键已被释放，因此一个损坏的观察者（那第二个浏览器标签页）
   * 绝不可能把调用方已结算的结果变成它自己的失败。
   */
  private settle(key: CredentialKey, settlement: AuthorizationSettlement): void {
    const args = ['authorization/settled', key, settlement]
    for (const listener of this.ctx.events.dispatch('emit', args) as Array<(...listenerArgs: unknown[]) => unknown>) {
      try {
        const returned = listener(key, settlement)
        if (returned != null && typeof (returned as PromiseLike<unknown>).then === 'function') {
          void Promise.resolve(returned as PromiseLike<unknown>).then(undefined, (error: unknown) => {
            this.warnSettledListenerFailure(key, error)
          })
        }
      } catch (error) {
        this.warnSettledListenerFailure(key, error)
      }
    }
  }
  /* jscpd:ignore-end */

  /** 同步与异步失败路径所共用的、被包容监听器的诊断。 */
  private warnSettledListenerFailure(key: CredentialKey, error: unknown): void {
    this.ctx.logger.warn('authorization: an authorization/settled listener for "%s" failed', key)
    this.ctx.logger.warn(error)
  }

  /** 运行流程，然后将其约束在它那一半提交契约之内。 */
  private async attempt(
    flow: AuthorizationFlow,
    method: string,
    signal: AbortSignal,
    interaction: AuthorizationInteraction,
  ): Promise<AuthorizationOutcome> {
    // 撤回会结算该尝试，无论流程是否对此作出反应。一个流程本应在其 signal 触发时
    // 停止，但若不停止，它就会在进程的整个生命周期内持有该键，而从外部看，一个卡住的
    // 键与一个忙碌的键无法区分。被遗弃的运行会被留待自行结束；没有任何东西等待它，
    // 而它仍设法提交的一条记录，正是一条人类确实授权过的记录。
    const withdrawn = new Promise<'withdrawn'>((resolve) => {
      // 当其调用方已经撤回时，`begin()` 会在占用该键之前返回，因此此处的 signal
      // 不可能已经被中止。
      signal.addEventListener('abort', () => { resolve('withdrawn') }, { once: true })
    })
    // 该 seam 在运行期间亲眼所见的事实，以属性形式持有，因为闭包写入不会跨 await
    // 收窄局部变量：提示包装器会 firsthand 看到一个拒绝（一个在返回途中重新包装
    // 该拒绝的流程无法隐藏它），而确认提交意味着确认它*此刻*发生——在重新认证时
    // 该记录已然存在，因此仅凭存在性会让一个什么都没写的流程把陈旧的凭证报告为
    // 刚被授权。
    const observed = { declined: false, committed: false }
    const unwatch = this.ctx.on('credentials/record-updated', (key: CredentialKey) => {
      if (key === flow.key) observed.committed = true
    })
    try {
      const running = flow.run({
        method,
        signal,
        commit: async (record) => {
          signal.throwIfAborted()
          const attempt = this.running.get(flow.key)
          if (attempt === undefined || attempt.controller.signal !== signal) {
            throw new AuthorizationError('authorization attempt is no longer active', 'CANCELLED')
          }
          attempt.committing = true
          await this.ctx.credentials.modifyRecord(flow.key, () => Promise.resolve(record))
        },
        notify: (notice) => {
          try {
            interaction.notify(notice)
          } catch (error) {
            // 即发即忘被保持在该 seam 处：一个无法渲染通知的界面（连接刚刚关闭的
            // 页面）会丢失该通知，而绝不会丢失该尝试。
            this.ctx.logger.warn('authorization: the interaction surface failed to render a notice')
            this.ctx.logger.warn(error)
          }
        },
        prompt: prompt => interaction.prompt(prompt).catch((error: unknown) => {
          if (error instanceof AuthorizationDeclinedError) observed.declined = true
          throw error
        }),
      })
      try {
        if (await Promise.race([running.then(() => 'ran' as const), withdrawn]) === 'withdrawn') {
          // 已没有任何东西再等待这个孤儿，因此它最终的失败必须被标记为已处理，
          // 否则会拖垮整个进程。
          void running.catch(() => { this.ctx.logger.debug('authorization: withdrawn flow failed after the fact') })
          return { status: 'cancelled' }
        }
      } catch (error) {
        // 被撤回的尝试与被拒绝的提示是结果，而非失败：人类说了不，或关闭了页面。
        // 除此之外的一切都是流程失败，且归属调用方，原因链保持完整。
        if (signal.aborted || observed.declined) return { status: 'cancelled' }
        throw error
      }
    } finally {
      unwatch()
    }
    if (!observed.committed) {
      throw new AuthorizationError(
        `authorization flow for "${flow.key}" resolved without committing a credential record in this attempt`,
        'NOT_COMMITTED')
    }
    const stored = await this.ctx.credentials.describeRecord(flow.key)
    if (!stored.configured) {
      throw new AuthorizationError(
        `authorization flow for "${flow.key}" deleted its credential record instead of committing one`,
        'NOT_COMMITTED')
    }
    return { status: 'authorized' }
  }
}

export default AuthorizationService
