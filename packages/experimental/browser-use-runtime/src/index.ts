/**
 * 面向实验性提供方的浏览器资源所有权。资源归属于某一次精确的实时 Agent 激活，
 * 且永远不会转移到一个被恢复的 Session。
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** 一个由提供方拥有的浏览器或连接，及其静默清理逻辑。 */
export interface OwnedSessionResource<T> {
  /** 暴露给各项操作、提供方私有的句柄。 */
  value: T
  /** 停止准入、中断待处理的操作，并等待资源关闭。 */
  close: () => Promise<void>
}

/** 由某一个提供方所选择的、资源创建与附加的所有权。 */
export interface SessionResourceOptions<T> {
  /** 包含在生命周期诊断中的提供方名称。 */
  label: string
  /** 为一个既有的浏览器预留，至多对应一个实时 Session。 */
  exclusive: boolean
  /**
   * 获取一个资源；只有在回滚部分获取之后才拒绝。
   * @param agent - 本次获取的、精确的实时所有者。
   * @param signal - 当该所有者或提供方被处置时中止。
   * @returns 已获取的资源及其清理逻辑。
   */
  open: (agent: Agent, signal: AbortSignal) => Promise<OwnedSessionResource<T>>
}

interface Entry<T> {
  controller: AbortController
  ready: Promise<OwnedSessionResource<T>>
  tail: Promise<void>
  closing?: Promise<void>
}

/** 在保留资源所有者工作上各项处理器的前提下，停止调用方的等待。 */
function awaitOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => { reject(signal.reason instanceof Error ? signal.reason : new Error('browser operation canceled', { cause: signal.reason })) }
    signal.addEventListener('abort', aborted, { once: true })
    void operation.then((value) => {
      signal.removeEventListener('abort', aborted)
      resolve(value)
    }, (error: unknown) => {
      signal.removeEventListener('abort', aborted)
      reject(error instanceof Error ? error : new Error(String(error), { cause: error }))
    })
  })
}

/**
 * 为每个实时 Session 惰性获取一个资源，并对其操作进行串行化。
 * 提供方处置会在等待操作之前先关闭连接，从而让传输层关闭能够中断那些
 * 上游 API 不支持中止的工作。
 */
export class SessionResources<T> {
  private readonly entries = new Map<Agent, Entry<T>>()
  private readonly ownerCleanups = new Map<Agent, () => Promise<void>>()
  private readonly disposedOwners = new WeakSet<Agent>()
  private disposing: Promise<void> | undefined

  /**
   * @param ctx - 带有实时 Agent 注册表的提供方上下文。
   * @param options - 提供方拥有的获取与附加策略。
   */
  constructor(private readonly ctx: Context, private readonly options: SessionResourceOptions<T>) {}

  /**
   * 在不预留或获取浏览器的情况下检查准入。
   * @param agent - 将拥有该资源的、精确的实时 Agent。
   * @returns 该所有者是否可以使用或获取所配置的浏览器。
   */
  available(agent: Agent): boolean {
    return this.disposing === undefined && !this.disposedOwners.has(agent)
      && this.ctx.get('agents')?.get(agent.id) === agent
      && (this.entries.has(agent) || !this.options.exclusive || this.entries.size === 0)
  }

  /**
   * 获取当前激活的资源，在缺失时获取一次。
   * @param agent - 精确的实时所有者，绝不仅仅是某个持久的 Session id。
   * @param signal - 本次等待的可选取消信号；获取动作仍归属于 Session。
   * @returns 经过获取与所有权检查之后、提供方的资源。
   */
  async get(agent: Agent, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    const entry = this.entry(agent)
    const resource = await (signal === undefined ? entry.ready : awaitOperation(entry.ready, signal))
    signal?.throwIfAborted()
    entry.controller.signal.throwIfAborted()
    return resource.value
  }

  /**
   * 在本 Session 上较早的操作结算之后运行；其他 Session 独立推进。
   * 取消仅停止本次调用方的获取等待，而不会取消归属于 Session 的初始化。
   * 它会触达一个活跃的提供方操作，并阻止已排队的工作开始。
   * @param agent - 精确的实时资源所有者。
   * @param signal - 本次操作的取消信号。
   * @param operation - 提供方调用，其必须保留所有权直到自身工作结算。
   * @returns 操作结果，或其获取、取消、或执行失败。
   */
  run<R>(agent: Agent, signal: AbortSignal, operation: (resource: T, signal: AbortSignal) => Promise<R>): Promise<R> {
    signal.throwIfAborted()
    const entry = this.entry(agent)
    const combined = AbortSignal.any([signal, entry.controller.signal])
    const releaseDisposed = () => {
      const reason = signal.reason as { kind?: unknown } | undefined
      if (reason?.kind !== 'disposed') return
      this.disposedOwners.add(agent)
      // AgentHandle waits for idle before disposing its scope; close interrupts the owned operation first.
      void this.closeEntry(agent, entry).catch((error: unknown) => {
        this.ctx.logger.warn(`${this.options.label}: browser cleanup during Session cancellation failed: ${String(error)}`)
      })
    }
    signal.addEventListener('abort', releaseDisposed, { once: true })
    const task = entry.tail.then(async () => {
      combined.throwIfAborted()
      const resource = await awaitOperation(entry.ready, combined)
      combined.throwIfAborted()
      const result = await operation(resource.value, combined)
      combined.throwIfAborted()
      return result
    }).finally(() => { signal.removeEventListener('abort', releaseDisposed) })
    // The queue tracks settlement independently of a caller observing its error.
    entry.tail = task.then(() => {}, () => {})
    return task
  }

  /**
   * 停止新的获取，并等待每一个已被获取的资源与所属的操作。
   * 一次失败的关闭会保留其条目并拒绝处置，从而保持独占所有权。
   * @returns 共享的、静默的处置承诺。
   */
  dispose(): Promise<void> {
    return this.disposing ??= Promise.resolve().then(async () => {
      const settled = await Promise.allSettled([...this.entries].map(([agent, entry]) => this.closeEntry(agent, entry)))
      const errors = settled.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
      if (errors.length > 0) throw new AggregateError(errors, `${this.options.label}: browser cleanup failed`)
      await Promise.all([...this.ownerCleanups.values()].map(close => close()))
    })
  }

  private entry(agent: Agent): Entry<T> {
    if (this.disposing !== undefined || this.disposedOwners.has(agent) || this.ctx.get('agents')?.get(agent.id) !== agent) {
      throw new Error(`${this.options.label}: Session is not a live browser owner`)
    }
    const current = this.entries.get(agent)
    if (current !== undefined) return current
    if (this.options.exclusive && this.entries.size > 0) {
      throw new Error(`${this.options.label}: attached browser is already reserved by another Session`)
    }
    if (!this.ownerCleanups.has(agent)) {
      const cleanup = agent.ctx.effect(() => async () => {
        this.disposedOwners.add(agent)
        const owned = this.entries.get(agent)
        if (owned !== undefined) await this.closeEntry(agent, owned)
        this.ownerCleanups.delete(agent)
      }, `${this.options.label}.session`)
      this.ownerCleanups.set(agent, cleanup)
    }
    const controller = new AbortController()
    const entry: Entry<T> = {
      controller,
      ready: Promise.resolve().then(() => {
        controller.signal.throwIfAborted()
        return this.options.open(agent, controller.signal)
      }).catch((error: unknown) => {
        // open() 负责回滚；一次失败的获取不再留有剩余资源。
        this.entries.delete(agent)
        throw error
      }),
      tail: Promise.resolve(),
    }
    // 获取动作可能比每一个被取消的调用方存活得更久；后续的消费者仍会收到其失败。
    void entry.ready.catch(() => {})
    this.entries.set(agent, entry)
    return entry
  }

  private closeEntry(agent: Agent, entry: Entry<T>): Promise<void> {
    return entry.closing ??= Promise.resolve().then(async () => {
      entry.controller.abort(new Error(`${this.options.label}: Session browser is closing`))
      const resource = await entry.ready.catch(() => undefined)
      try {
        await resource?.close()
      } finally {
        await entry.tail
      }
      this.entries.delete(agent)
    })
  }
}
