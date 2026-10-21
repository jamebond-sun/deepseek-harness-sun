/**
 * 中间件链：按序运行为某一事件选中的钩子，每个钩子的 `next` 会触及更深层
 * 的钩子，最终触及引擎行为，并遵循 Claude Code 的失败规则（跳过抛出、
 * 超时或返回无结果的钩子；当更深层已调用过 `next` 时保留其结果；给
 * `.catch` 处理器一个替代应答的机会）。
 * @module
 */

import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import { messageOf } from './values.ts'
import type { AnyHook, HookFailure, HookOrigin, HookMatcher, ModsApi, HookNext, PluginOptions } from './types.ts'
import { matcherMatches } from './matcher.ts'

/** 一个已加载的 mod：其插件身份，以及它所收到的 `register` 选项。 */
export interface LoadedMod {
  readonly name: string
  readonly version: string | undefined
  /** 该 mod 所内置的绝对目录，正如 `$.plugin.root` 所报告的那样。 */
  readonly root: string
  readonly options: PluginOptions
  /** 加载顺序；更靠前 mod 的钩子运行在更靠后 mod 的钩子之外。 */
  readonly order: number
}

/** 一次 `on(...)` 注册。 */
export interface RegisteredHook {
  readonly mod: LoadedMod
  readonly event: string
  readonly matcher: HookMatcher | undefined
  readonly hook: AnyHook
  catchHandler: AnyHook | undefined
  /** 本钩子已经报告过的失败种类；每种一行，直到该 mod 重新加载。 */
  readonly reported: Set<string>
}

/** `next.error.kind === 'timeout'` 这一失败。 */
export class HookTimeoutError extends Error {
  constructor(budgetMs: number) {
    super(`ran past its ${budgetMs} ms limit`)
    this.name = 'HookTimeoutError'
  }
}

/**
 * 统计某个钩子自身的运行时间：该钩子忙碌时时钟运行，而当它 await `next`
 * 或一次 mods API 调用时暂停。一旦忙碌时间到达上限，该截止时限承诺便会拒却。
 */
export class BudgetClock {
  private spent = 0
  private busySince: number | undefined
  private pauses = 0
  private stopped = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly deadline = Promise.withResolvers<never>()

  /**
   * @param ms - 以毫秒计的运行时间上限。
   * @param now - 以毫秒计的单调时钟。
   */
  constructor(readonly ms: number, private readonly now: () => number = () => performance.now()) {
    // 该截止时限仅在某个竞态在 await 它时才要紧；钩子的结算之后、未被观察的
    // 拒却不得浮出。
    this.deadline.promise.catch(() => {})
  }

  /** 当忙碌时间到达上限时，以 {@link HookTimeoutError} 拒却。 */
  get expired(): Promise<never> {
    return this.deadline.promise
  }

  /** 截止时限触发前所剩的毫秒数。 */
  get remainingMs(): number {
    const busy = this.busySince === undefined ? 0 : this.now() - this.busySince
    return Math.max(0, this.ms - this.spent - busy)
  }

  /** 开始计时；从此钩子进入忙碌状态。 */
  start(): void {
    if (this.stopped) return
    this.busySince = this.now()
    this.arm()
  }

  /** 在钩子 await `next` 或一次 mods API 调用期间停止计时。嵌套的暂停会被计数。 */
  pause(): void {
    if (this.stopped) return
    this.pauses += 1
    if (this.busySince !== undefined) {
      this.spent += this.now() - this.busySince
      this.busySince = undefined
    }
    this.disarm()
  }

  /** 在所 await 的调用结算之后，恢复计时。 */
  resume(): void {
    if (this.stopped || this.pauses === 0) return
    this.pauses -= 1
    if (this.pauses === 0) {
      this.busySince = this.now()
      this.arm()
    }
  }

  /** 钩子已结算：从此刻起不会再有任何截止时限触发。 */
  stop(): void {
    if (this.busySince !== undefined) this.spent += this.now() - this.busySince
    this.stopped = true
    this.busySince = undefined
    this.disarm()
  }

  private arm(): void {
    this.disarm()
    const remaining = this.remainingMs
    this.timer = setTimeout(() => {
      this.stopped = true
      this.busySince = undefined
      this.spent = this.ms
      this.deadline.reject(new HookTimeoutError(this.ms))
    }, remaining)
    this.timer.unref()
  }

  private disarm(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }
}

/** 一次分发所需的、除钩子本身之外的一切。 */
export interface DispatchRequest<E, R> {
  readonly event: string
  readonly input: E
  /** 位于链底部的引擎行为；收到的是链所留下的输入。 */
  readonly core: (e: E) => Promise<R> | R
  readonly origin: HookOrigin
  /** 其事件模式选中本事件的钩子，最外层的在前；匹配器按每个钩子分别求值。 */
  readonly hooks: readonly RegisteredHook[]
  /** 构建某个钩子所收到的 `$`；在其调用被 await 期间时钟暂停。 */
  readonly api: (hook: RegisteredHook, clock: BudgetClock) => ModsApi
  /** 某个钩子自身的运行时间上限。 */
  readonly budgetMs: number
  /** `.catch` 处理器的运行时间上限。 */
  readonly catchBudgetMs: number
  readonly signal: AbortSignal
  /** 每跳过一条钩子或一种失败，都会收到一行诊断信息。 */
  readonly report: (line: string) => void
  /**
   * 在更深层运行之前，检查某个钩子传给 `next` 的输入；一次抛出会将该钩子
   * 作为它自身的失败跳过，而链则以该钩子所收到的输入继续。
   */
  readonly validateNext?: (e: E, hook: RegisteredHook) => void
}

/** 由 {@link DispatchRequest.validateNext} 抛出：该钩子请求了本宿主不予服务的重写。 */
export class RewriteRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RewriteRefusedError'
  }
}

/** 引擎自身的来源。 */
export const ENGINE_ORIGIN: HookOrigin = Object.freeze({ plugin: 'engine', tier: 'core' })

/** 某个钩子结算时所带的是结果对象之外的东西。 */
class NoResultError extends Error {
  constructor() {
    super('returned no result')
    this.name = 'NoResultError'
  }
}

/** 归类一个失败的钩子，并措辞化诊断行的尾部。 */
function failureOf(error: unknown): HookFailure & { readonly line: string } {
  if (error instanceof HookTimeoutError) return { kind: 'timeout', message: error.message, line: `timeout, ${error.message}` }
  if (error instanceof NoResultError || error instanceof RewriteRefusedError) return { kind: 'throw', message: error.message, line: error.message }
  const message = error instanceof Error ? `${error.name}: ${error.message}` : messageOf(error)
  return { kind: 'throw', message, line: `threw ${message}` }
}

/** 在每一个深度原地把事件输入冻结，正如 mods API 所承诺的那样。 */
function freezeInput<E>(input: E): E {
  return typeof input === 'object' && input !== null ? deepFreeze(input) : input
}

/**
 * 让一个事件穿过它的钩子与引擎行为。
 * @param request - 该事件、它的钩子，以及它们之下的引擎行为。
 * @returns 该事件的结果，即最外层钩子所返回的那个。
 */
export async function dispatch<E, R>(request: DispatchRequest<E, R>): Promise<R> {
  const { hooks } = request

  async function runFrom(index: number, input: E): Promise<R> {
    for (let i = index; i < hooks.length; i += 1) {
      const hook = hooks[i] as RegisteredHook
      if (hook.matcher !== undefined && !matcherMatches(hook.matcher, input)) continue
      return runHook(hook, i, input)
    }
    return request.core(input)
  }

  async function runHook(hook: RegisteredHook, index: number, input: E): Promise<R> {
    const frozen = freezeInput(input)
    const clock = new BudgetClock(request.budgetMs)
    // 以闭包写入的标志存放在同一个对象上，以便 catch 路径读取它们的当前值。
    const state: {
      abandoned: boolean
      called: boolean
      beneath: Promise<R> | undefined
      beneathError: { readonly error: unknown } | undefined
      refused: { readonly error: unknown } | undefined
    } = { abandoned: false, called: false, beneath: undefined, beneathError: undefined, refused: undefined }
    const next = Object.assign(
      (e: E): Promise<R> => {
        state.called = true
        // 每个钩子在其之下只运行一次：第二次调用会把第一次的运行交回。
        if (state.beneath !== undefined) return state.beneath
        if (state.abandoned) return Promise.resolve(undefined as R)
        if (request.validateNext !== undefined) {
          try {
            request.validateNext(e, hook)
          } catch (error: unknown) {
            const refused = error instanceof Error ? error : new Error(messageOf(error))
            state.refused = { error: refused }
            return Promise.reject(refused)
          }
        }
        clock.pause()
        state.beneath = runFrom(index + 1, e)
          .catch((error: unknown) => {
            state.beneathError = { error }
            throw error
          })
          .finally(() => { clock.resume() })
        return state.beneath
      },
      {
        signal: request.signal,
        origin: request.origin,
        budget: { ms: request.budgetMs, get remainingMs(): number { return clock.remainingMs } },
        to(): Promise<R> {
          return Promise.reject(new Error('next.to is only available to mods in managed prependPlugins or appendPlugins'))
        },
      },
    ) as HookNext<E, R>
    const api = request.api(hook, clock)
    clock.start()
    try {
      const running = Promise.resolve().then(() => hook.hook(api, frozen, next as HookNext<unknown, unknown>) as R | Promise<R>)
      // 一个被放弃的钩子后续的拒却并不是未被处理的拒却。
      running.catch(() => {})
      const result = await Promise.race([running, clock.expired])
      // `null` 是一个应答（一个被绘制为空的画面）；只有以完全没有对象的方式结算的钩子才会被跳过。
      if (typeof result !== 'object') throw new NoResultError()
      // 该钩子已经应答；它在之下启动的一切仍会运行到底，之后该事件才会结算。
      clock.stop()
      if (state.beneath !== undefined) {
        await state.beneath.catch((error: unknown) => {
          request.report(`${hook.mod.name}: ${request.event}: the chain beneath failed after the hook answered: ${messageOf(error)}`)
        })
      }
      return result
    } catch (error: unknown) {
      state.abandoned = true
      // 失败的是其下的引擎，而非该钩子：这一失败属于事件自身。
      if (state.beneathError !== undefined && error === state.beneathError.error) throw error
      // 一次被拒绝的重写是该钩子的失败，即便该钩子让拒却原样通过。
      const failure = failureOf(state.refused !== undefined && error === state.refused.error ? state.refused.error : error)
      if (!hook.reported.has(failure.kind)) {
        hook.reported.add(failure.kind)
        request.report(`${hook.mod.name}: ${request.event} hook skipped: ${failure.line}`)
      }
      if (hook.catchHandler !== undefined) {
        const answered = await runCatch(hook, index, frozen, { kind: failure.kind, message: failure.message }, state)
        if (answered !== undefined) return answered
      }
      // 无论在其之下运行的是钩子还是它的处理器，都已运行一次；其结果保留。
      if (state.beneath !== undefined) return await state.beneath
      return await runFrom(index + 1, input)
    } finally {
      clock.stop()
    }
  }

  /**
   * 运行该失败钩子的 `.catch` 处理器。它与该钩子共享其之下的状态：钩子已经
   * 运行的部分会被交回，处理器运行的部分被记录供跳过路径使用，因此之下的
   * 部分不会运行两次。
   */
  async function runCatch(
    hook: RegisteredHook,
    index: number,
    input: E,
    failure: HookFailure,
    state: { abandoned: boolean; called: boolean; beneath: Promise<R> | undefined },
  ): Promise<R | undefined> {
    const clock = new BudgetClock(request.catchBudgetMs)
    let handlerAbandoned = false
    const next = Object.assign(
      (e: E): Promise<R> => {
        if (state.beneath !== undefined) return state.beneath
        if (handlerAbandoned) return Promise.resolve(undefined as R)
        if (request.validateNext !== undefined) {
          // 与钩子自身 `next` 所做的检查相同：处理器同样不能把一次重写传向更深层。
          try {
            request.validateNext(e, hook)
          } catch (error: unknown) {
            return Promise.reject(error instanceof Error ? error : new Error(messageOf(error)))
          }
        }
        clock.pause()
        state.beneath = runFrom(index + 1, e).finally(() => { clock.resume() })
        return state.beneath
      },
      {
        signal: request.signal,
        origin: request.origin,
        budget: { ms: request.catchBudgetMs, get remainingMs(): number { return clock.remainingMs } },
        to(): Promise<R> { return Promise.reject(new Error('next.to is not available in a .catch handler')) },
        error: failure,
        called: state.called,
      },
    ) as HookNext<E, R>
    const api = request.api(hook, clock)
    clock.start()
    try {
      const handler = hook.catchHandler as AnyHook
      const running = Promise.resolve()
        .then(() => handler(api, input, next as HookNext<unknown, unknown>) as R | undefined | Promise<R | undefined>)
      running.catch(() => {})
      const result = await Promise.race([running, clock.expired])
      if (typeof result === 'object') return result
    } catch (error: unknown) {
      request.report(`${hook.mod.name}: ${request.event} .catch handler skipped: ${failureOf(error).line}`)
    } finally {
      handlerAbandoned = true
      clock.stop()
    }
    return undefined
  }

  return runFrom(0, request.input)
}
