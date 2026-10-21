/**
 * 本地注册表的事件路由：订阅按过滤器归档，每一次提交都以受控的方式向每个匹配的
 * 监听器派发一次。
 * @module @deepseek-ai/dsh-jobs-local/events
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AnonymousEntries, ScopedLayers, scopeOf } from '@deepseek-ai/dsh-scope'
import type { ScopeLayer } from '@deepseek-ai/dsh-scope'
import type { JobEvent, JobEventFilter, JobEventListener } from '@deepseek-ai/dsh-jobs'

/** 一个已注册的监听器及其声明的过滤器。 */
interface Subscription {
  filter: JobEventFilter
  listener: JobEventListener
}

/**
 * 一个作用域的贡献：从它这里挂载的任务控制器，以及注册在这里的 `{ owners: 'scope' }`
 * 订阅。两张表都是匿名的，因为一份贡献由它自己的 disposer 标识，而绝不由一个可能被
 * 第二个注册者遮蔽的名字标识。
 */
export class JobLayer implements ScopeLayer {
  /** 从该作用域挂载的任务控制器的令牌。 */
  readonly controllers = new AnonymousEntries<symbol>()
  /** 从该作用域注册的 `{ owners: 'scope' }` 订阅。 */
  readonly scoped = new AnonymousEntries<Subscription>()

  isEmpty(): boolean {
    return this.controllers.isEmpty() && this.scoped.isEmpty()
  }
}

/**
 * 把事件路由到订阅。`{ owner }` 与 `{ owners: 'all' }` 订阅对每一个事件都参与判定，
 * 无论它们注册在哪里；`{ owners: 'scope' }` 订阅归档到注册上下文的作用域层，并接收其下
 * 组合出的那些所有者——从不限定作用域的上下文到达的全局层接收所有所有者。
 */
export class JobEventHub {
  private readonly unscoped = new Set<Subscription>()

  /**
   * @param layers - 与控制器握手共用的作用域层表。
   * @param warn - 监听器被隔离后的失败的下沉处。
   */
  constructor(
    private readonly layers: ScopedLayers<JobLayer>,
    private readonly warn: (message: string) => void,
  ) {}

  /**
   * 把一个监听器注册为 `ctx` 的一个 effect。
   * @param ctx - 订阅上下文；它拥有该 effect，并在 `'scope'` 情形下指明作用域。
   * @param filter - 投递哪些所有者的事件。
   * @param listener - 接收每个匹配的事件。
   * @returns 注销该监听器的 disposer。
   */
  subscribe(ctx: Context, filter: JobEventFilter, listener: JobEventListener): () => void {
    const subscription: Subscription = { filter, listener }
    if ('owners' in filter && filter.owners === 'scope') {
      return this.layers.effect(ctx, layer => layer.scoped.append(subscription), { label: 'jobs.events.subscribe()' })
    }
    const dispose = ctx.effect(() => {
      this.unscoped.add(subscription)
      return () => { this.unscoped.delete(subscription) }
    }, 'jobs.events.subscribe()')
    // oxlint-disable-next-line typescript/no-misused-promises -- 精确的同步 disposer 保留 Cordis effect 的同一性
    return dispose
  }

  /**
   * 把一个事件投递给每个匹配的订阅，并对每个监听器做隔离，这样观察者无法破坏已经
   * 完成的提交。
   * @param event - 要投递的事件。
   * @param owner - 该任务确切的所有者；无主工作为 undefined。
   */
  emit(event: JobEvent, owner: Agent | undefined): void {
    const ownerId = owner?.id
    for (const subscription of this.unscoped) {
      const { filter } = subscription
      if ('owner' in filter && ownerId !== undefined && ownerId !== filter.owner) continue
      this.deliver(subscription, event)
    }
    for (const subscription of this.layers.global.scoped.values()) this.deliver(subscription, event)
    const scope = owner === undefined ? undefined : scopeOf(owner.ctx)
    for (const layer of this.layers.chainLayers(scope)) {
      for (const subscription of layer.scoped.values()) this.deliver(subscription, event)
    }
  }

  private deliver(subscription: Subscription, event: JobEvent): void {
    try {
      subscription.listener(event)
    } catch (error: unknown) {
      this.warn(`jobs: event listener threw on ${event.type}: ${String(error)}`)
    }
  }
}
