/**
 * mods 引擎：已加载的 mods 及其钩子、由引擎引发的事件、以事件形式抛出的
 * mods API 调用、每个会话的 `$.state`，以及 mods 所启动的定时器。它
 * 对 Cordis 一无所知；插件为每个 mods API 调用提供引擎行为，而测试套件
 * 提供桩件。
 * @module
 */

import type { BudgetClock, LoadedMod, RegisteredHook } from './chain.ts'
import { dispatch, ENGINE_ORIGIN } from './chain.ts'
import { createModsApi } from './api.ts'
import type { TimerHost } from './api.ts'
import { messageOf, record } from './values.ts'
import { HookRegistry, registerMod } from './module.ts'
import type { ModDefinition, ModsApi, OpResult, ModTimer } from './types.ts'

/** 针对某一次 mods API 调用的引擎行为。 */
export type OpCore<B> = (input: unknown, context: OpContext<B>) => unknown

/** 按事件名（`<namespace>.<method>`）索引的引擎行为。 */
export type OpTable<B> = Readonly<Record<string, OpCore<B>>>

/** 查找某一次 mods API 调用的引擎行为；`undefined` 表示没有提供服务端行为。 */
export type OpResolver<B> = (op: string) => OpCore<B> | undefined

/**
 * 由某个引擎行为抛出，用以携带 `{ deny }` 应答某次 mods API 调用，
 * 从而让发起调用的 mod 的 `$` 调用以该理由拒却。
 */
export class OpDenied extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = 'OpDenied'
  }
}

/** 一次操作核心与 `$` 实例所知的、关于正在抛出的钩子环境的信息。 */
export interface OpContext<B> {
  readonly mod: LoadedMod
  /** 正在运行的事件的、引擎特定的绑定：插件的 agent，或测试套件的 fixture。 */
  readonly binding: B
  readonly signal: AbortSignal
  readonly engine: ModsEngine<B>
}

/** 引擎的构造选项。 */
export interface ModsEngineOptions<B> {
  /**
   * 针对 mods API 调用的引擎行为。当解析器没有提供时，引擎自身会应答
   * `state.*`、`clock.now` 与 `clock.sleep`。
   */
  readonly ops: OpResolver<B>
  /**
   * `$.state` 的取值与某个 mod 的定时器所归属的键：即 Claude Code 的
   * “面向整个会话”。空字符串代表无会话的作用域。
   */
  readonly stateKey: (binding: B) => string
  /** 某个钩子自身的运行时间上限（毫秒）。 */
  readonly budgetMs: number
  /** `.catch` 处理器的运行时间上限（毫秒）。 */
  readonly catchBudgetMs: number
  /** 接收诊断信息：被跳过的钩子、失败的“触发即忘”调用、定时器回调错误。 */
  readonly report: (line: string) => void
  /** 观察 `$.state` 的读取，按会话键与 `<plugin>\u0000<key>` 槽位，以便某次绘制可以订阅它读取过的内容。 */
  readonly onStateRead?: (key: string, slot: string) => void
  /** 观察 `$.state` 的写入，按会话键与槽位。 */
  readonly onStateWritten?: (key: string, slot: string) => void
}

/** 抛出某一个引擎事件的选项。 */
export interface RaiseOptions<B, E = unknown> {
  readonly binding: B
  readonly signal?: AbortSignal
  /** 检查某个钩子传给 `next` 的输入；一次抛出会跳过该钩子，并以它收到的输入继续。 */
  readonly validateNext?: (e: E, hook: RegisteredHook) => void
}

const NEVER_ABORTS = new AbortController().signal

/** 等待 `ms`；若事件在等待前或等待期间被取消，则以该 signal 的理由拒却。 */
function sleepUnless(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReasonOf(signal))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      reject(abortReasonOf(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function abortReasonOf(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error ? reason : new Error(`$.clock.sleep cancelled: ${messageOf(reason)}`)
}

/** 一个具名的 `$.state` 槽位：`<plugin>\u0000<key>`。 */
function stateSlot(plugin: unknown, key: unknown): string {
  if (typeof plugin !== 'string' || typeof key !== 'string') throw new TypeError('$.state needs { plugin, key } strings')
  return `${plugin}\u0000${key}`
}

/**
 * 由引擎代表某一个 mod 所拥有的定时器。关闭会取消每一个已排程的定时器、
 * 拒绝新的定时器，并等待已经在运行的回调完成，从而使一个 mod 在卸载后
 * 无法重新排程自身或触碰宿主。
 */
class TimerSet implements TimerHost {
  private readonly active = new Set<ReturnType<typeof setTimeout>>()
  private readonly running = new Set<Promise<void>>()
  private closed = false

  constructor(private readonly report: (line: string) => void, private readonly owner: string) {}

  after(ms: number, fn: () => unknown): ModTimer {
    if (this.closed) return { cancel() {} }
    const handle = setTimeout(() => {
      this.active.delete(handle)
      this.run(fn)
    }, ms)
    handle.unref()
    this.active.add(handle)
    return { cancel: () => { clearTimeout(handle); this.active.delete(handle) } }
  }

  every(ms: number, fn: () => unknown): ModTimer {
    if (this.closed) return { cancel() {} }
    const handle = setInterval(() => { this.run(fn) }, ms)
    handle.unref()
    this.active.add(handle)
    return { cancel: () => { clearInterval(handle); this.active.delete(handle) } }
  }

  /**
   * 取消每一个已排程的定时器、拒绝新的定时器，并在已经在运行的回调
   * 完成之后结算。
   */
  async close(): Promise<void> {
    this.closed = true
    for (const handle of this.active) clearTimeout(handle)
    this.active.clear()
    await Promise.all(this.running)
  }

  private run(fn: () => unknown): void {
    const settled = Promise.resolve().then(fn).then(() => undefined, (error: unknown) => {
      this.report(`${this.owner}: timer callback failed: ${messageOf(error)}`)
    })
    this.running.add(settled)
    void settled.finally(() => { this.running.delete(settled) })
  }
}

/**
 * 已加载的 mods、它们的钩子，以及事件抵达它们的两种途径：引擎会
 * 经每一个被选中的钩子抛出一个事件，而某个 mod 的 `$` 调用会经在它
 * 之前加载的 mods 抛出一个事件。
 */
export class ModsEngine<B> {
  /** 已加载的 mods 及其注册项。 */
  readonly registry = new HookRegistry()
  private readonly state = new Map<string, Map<string, unknown>>()
  /** 按 `<session key>\u0000<plugin>` 索引的定时器集合：某个 mod 的定时器归属于启动它们的那个会话的事件。 */
  private readonly timers = new Map<string, TimerSet>()
  private nextOrder = 0

  constructor(private readonly options: ModsEngineOptions<B>) {}

  /**
   * 运行某个 mod 的 `register`，并将其钩子加在每一个在它之前添加的 mod 之下。
   * @param definition - 其插件所定义的、该 mod 的形态。
   * @returns 已加载的 mod。
   * @throws 当名称被占用或无效，或当 `register` 抛出时。
   */
  async add(definition: ModDefinition): Promise<LoadedMod> {
    if (this.registry.list().some(loaded => loaded.name === definition.name)) {
      throw new Error(`mod "${definition.name}" not loaded: another mod of that name is already loaded`)
    }
    const order = this.nextOrder
    this.nextOrder += 1
    const { mod, hooks } = await registerMod(definition, order)
    this.registry.add(mod, hooks)
    return mod
  }

  /**
   * 经其钩子抛出一个引擎事件，最外层的优先。
   * @param event - 事件名称。
   * @param input - 事件输入；在钩子看到它之前被冻结。
   * @param core - 位于每个钩子之下的引擎行为。
   * @param options - 本 agent 的各绑定事件所共享的内容，及其取消。
   * @returns 最外层钩子所返回的结果。
   */
  raise<E, R>(event: string, input: E, core: (e: E) => Promise<R> | R, options: RaiseOptions<B, E>): Promise<R> {
    return this.raiseWith(event, this.registry.select(event), undefined, input, core, options)
  }

  /**
   * 经调用方已经选好的钩子抛出一个事件，并将其归因为引发了它的 mod：
   * 即引擎，或一个其 `$` 调用被宿主转回为本事件的 mod。
   * @param event - 事件名称。
   * @param hooks - 选中的钩子，最外层的优先。
   * @param raisedBy - 该事件所归因到的 mod，或为引擎时的 undefined。
   * @param input - 事件输入；在钩子看到它之前被冻结。
   * @param core - 位于每个钩子之下的引擎行为。
   * @param options - 本 agent 的各绑定事件所共享的内容，及其取消。
   * @returns 最外层钩子所返回的结果。
   */
  raiseWith<E, R>(
    event: string,
    hooks: readonly RegisteredHook[],
    raisedBy: LoadedMod | undefined,
    input: E,
    core: (e: E) => Promise<R> | R,
    options: RaiseOptions<B, E>,
  ): Promise<R> {
    const signal = options.signal ?? NEVER_ABORTS
    return dispatch<E, R>({
      event,
      input,
      core,
      origin: raisedBy === undefined ? ENGINE_ORIGIN : { plugin: raisedBy.name, tier: 'user' },
      hooks,
      api: (hook, clock) => this.api(hook.mod, clock, options.binding, signal),
      budgetMs: this.options.budgetMs,
      catchBudgetMs: this.options.catchBudgetMs,
      signal,
      report: this.options.report,
      ...options.validateNext === undefined ? {} : { validateNext: options.validateNext },
    })
  }

  /**
   * 将某一次 mods API 调用作为同名事件，经在调用方之前加载的 mods 抛出，
   * 然后以引擎行为应答它。
   * @param mod - 发起调用的 mod。
   * @param op - 事件名称，即 `<namespace>.<method>`。
   * @param input - 该调用的输入。
   * @param binding - 调用方正在处理的事件的绑定。
   * @param signal - 该事件的取消信号。
   * @returns 链所应答的值。
   * @throws 当某个钩子或引擎以 `{ deny }` 应答时，以该理由抛出 Error。
   */
  async invoke(mod: LoadedMod, op: string, input: unknown, binding: B, signal: AbortSignal): Promise<unknown> {
    const result = await dispatch<unknown, unknown>({
      event: op,
      input,
      // `tool.call` 只在该宿主从工具流水线抛出它时才会抵达更早的 mods，此处不再重复。
      hooks: op === 'tool.call' ? [] : this.registry.select(op, mod),
      core: async (e): Promise<OpResult> => {
        try {
          return { value: await this.opCore(op, e, { mod, binding, signal, engine: this }) }
        } catch (error: unknown) {
          if (error instanceof OpDenied) return { deny: error.reason }
          throw error
        }
      },
      origin: { plugin: mod.name, tier: 'user' },
      api: (hook, clock) => this.api(hook.mod, clock, binding, signal),
      budgetMs: this.options.budgetMs,
      catchBudgetMs: this.options.catchBudgetMs,
      signal,
      report: this.options.report,
    })
    // 以对象之外的内容结算的钩子会被跳过，因此结果要么是核心的、要么是某个钩子的对象——或者为 null。
    const answer = result as { value?: unknown; deny?: unknown } | null
    if (answer === null || (!('value' in answer) && !('deny' in answer))) {
      throw new Error(`${op}: a hook returned neither { value } nor { deny }`)
    }
    if (typeof answer.deny === 'string') throw new Error(`${op} refused: ${answer.deny}`)
    return answer.value
  }

  /**
   * 在某一个事件内部，为某个 mod 构建 `$`。
   * @param mod - 该实例所隶属的 mod。
   * @param clock - 运行中的钩子的时钟，在钩子之外时为 undefined。
   * @param binding - 该事件的绑定。
   * @param signal - 该事件的取消信号。
   * @returns mods API。
   */
  api(mod: LoadedMod, clock: BudgetClock | undefined, binding: B, signal: AbortSignal): ModsApi {
    return createModsApi({
      mod,
      clock,
      invoke: (op, input) => this.invoke(mod, op, input, binding, signal),
      timers: this.timersOf(mod, this.options.stateKey(binding)),
      report: this.options.report,
    })
  }

  /**
   * 遗忘某个会话的 `$.state` 取值，并关闭由它的事件所启动的定时器。
   * @param key - 这些取值与定时器所归属的会话键。
   * @returns 在该会话的定时器回调全部完成之后结算。
   */
  async forgetSession(key: string): Promise<void> {
    this.state.delete(key)
    const closing: Promise<void>[] = []
    for (const [timerKey, timers] of this.timers) {
      if (timerKey.startsWith(`${key}\u0000`)) {
        this.timers.delete(timerKey)
        closing.push(timers.close())
      }
    }
    await Promise.all(closing)
  }

  /**
   * 某个 mod 的、`claude plugin validate` 风格的 `hooks:` 行。
   * @param mod - 已加载的 mod。
   * @returns 它带有匹配器的事件，以逗号分隔。
   */
  describe(mod: LoadedMod): string {
    return this.registry.describe(mod)
  }

  /**
   * 丢弃一个 mod：它的钩子停止接收事件，它的定时器被取消，
   * 并且它在运行的定时器回调会被等待完成。
   * @param name - 插件名称。
   * @returns 在该 mod 的定时器回调全部完成之后结算。
   */
  async unload(name: string): Promise<void> {
    this.registry.remove(name)
    const closing: Promise<void>[] = []
    for (const [timerKey, timers] of this.timers) {
      if (timerKey.endsWith(`\u0000${name}`)) {
        this.timers.delete(timerKey)
        closing.push(timers.close())
      }
    }
    await Promise.all(closing)
  }

  /**
   * 丢弃每一个注册项，并关闭每个 mod 的定时器。
   * @returns 在每一个定时器回调都完成之后结算。
   */
  async dispose(): Promise<void> {
    await Promise.all([...this.registry.list()].map(mod => this.unload(mod.name)))
    this.state.clear()
  }

  private timersOf(mod: LoadedMod, sessionKey: string): TimerSet {
    const timerKey = `${sessionKey}\u0000${mod.name}`
    let timers = this.timers.get(timerKey)
    if (timers === undefined) {
      timers = new TimerSet(this.options.report, mod.name)
      this.timers.set(timerKey, timers)
    }
    return timers
  }

  private opCore(op: string, input: unknown, context: OpContext<B>): unknown {
    const served = this.options.ops(op)
    if (served !== undefined) return served(input, context)
    const fields = record(input)
    switch (op) {
      case 'state.get': {
        const slot = stateSlot(fields.plugin, fields.key)
        const key = this.options.stateKey(context.binding)
        this.options.onStateRead?.(key, slot)
        return { value: this.state.get(key)?.get(slot) }
      }
      case 'state.set': {
        const slot = stateSlot(fields.plugin, fields.key)
        const key = this.options.stateKey(context.binding)
        let values = this.state.get(key)
        if (values === undefined) {
          values = new Map()
          this.state.set(key, values)
        }
        values.set(slot, fields.value)
        this.options.onStateWritten?.(key, slot)
        return undefined
      }
      case 'clock.now':
        return Date.now()
      case 'clock.sleep': {
        const ms = fields.ms
        if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) throw new TypeError('$.clock.sleep needs a non-negative number of milliseconds')
        return sleepUnless(ms, context.signal)
      }
      default:
        throw new Error(`no implementation for ${op}`)
    }
  }
}

export type { RegisteredHook }
