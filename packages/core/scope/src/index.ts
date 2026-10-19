/**
 * 作用域上下文原语：铸造一个 Cordis 上下文，为注册打上不透明身份的标签，
 * 并为该身份构建仅用于路由的事件载体。
 *
 * @module @deepseek-ai/dsh-scope
 */

import type { Context, Fiber } from '@deepseek-ai/cordis'
import { Context as CordisContext } from '@deepseek-ai/cordis'

export { AnonymousEntries, NamedEntries, ScopedLayers } from './store.ts'
export type { ScopeLayer } from './store.ts'

/** 不透明、按身份比较的作用域键。 */
export type ScopeKey = object

/** 由 {@link createScope} 写入的上下文标签。 */
const kScope = Symbol('dsh.scope')

declare const ScopedBrand: unique symbol

/**
 * 由 {@link scopeTarget} 构建的仅用于路由的事件接收器。类型
 * 参数记录主体类型以供分发检查；载体不暴露主体的属性。
 * 事件负载携带真实主体。
 */
export type Scoped<T extends object> = object & { readonly [ScopedBrand]: T }

/** 与每个载体关联的键。以存在与否区分未带键的载体和非载体。 */
const carrierKeys = new WeakMap<object, ScopeKey | undefined>()

/**
 * 每个键的外围作用域。一个关系驱动作用域嵌套的两个方向：
 * 注册视图沿链向下继承（子作用域可见其祖先的层——{@link ScopedLayers}），
 * 事件接纳沿链向上扩展（以祖先标记的监听器接收分发到后代键的事件——
 * {@link scopeTarget}）。
 */
const scopeParents = new WeakMap<ScopeKey, ScopeKey>()

/** 移动单个作用域键父链接的特权句柄。 */
export interface ScopeParentBinding {
  /**
   * 将绑定的键重新链接到不同的父级，进行与绑定时相同的环检查。
   * 仅在旧父级下产生的任何内容都不被保留时有效——
   * 即空白会话重组契约，由持有者维护，
   * 因为此关系无法看到会话记录了什么。
   * @param parent - 新的外围作用域键。
   */
  rebind(parent: ScopeKey): void
}

/** 由绑定和每次重绑定共享的带环检查写入。 */
function linkScopeParent(key: ScopeKey, parent: ScopeKey): void {
  for (let cursor: ScopeKey | undefined = parent; cursor !== undefined; cursor = scopeParents.get(cursor)) {
    if (cursor === key) throw new Error('dsh-scope: scope parent link would form a cycle')
  }
  scopeParents.set(key, parent)
}

/**
 * 将 `parent` 绑定为 `key` 的外围作用域，仅一次。
 *
 * 已有父级的键会抛出：不存在开放的重新链接路径，因此作用域的祖先关系
 * 无法被原始绑定者以外的任何人移动，只有其一人收到
 * {@link ScopeParentBinding}。会闭合环的链接被拒绝，
 * 因为每个链消费方都会沿父级走到根。
 * @param key - 子作用域键。
 * @param parent - 其外围作用域键。
 * @returns 唯一可以重新链接此键的绑定。
 */
export function bindScopeParent(key: ScopeKey, parent: ScopeKey): ScopeParentBinding {
  if (scopeParents.has(key)) {
    throw new Error('dsh-scope: scope key is already bound to a parent; re-linking requires the binding returned by the original bind')
  }
  linkScopeParent(key, parent)
  return {
    rebind(next: ScopeKey): void {
      linkScopeParent(key, next)
    },
  }
}

/**
 * 读取单个键的外围作用域。
 * @param key - 要检查的作用域键。
 * @returns 其父键，根作用域为 `undefined`。
 */
export function scopeParentOf(key: ScopeKey): ScopeKey | undefined {
  return scopeParents.get(key)
}

/**
 * 从一个键到其根祖先的链。
 * @param key - 起始键，空链为 `undefined`。
 * @returns 以最近优先的键：`[key, parent, grandparent, …]`。
 */
export function scopeChainOf(key: ScopeKey | undefined): ScopeKey[] {
  const chain: ScopeKey[] = []
  for (let cursor = key; cursor !== undefined; cursor = scopeParents.get(cursor)) chain.push(cursor)
  return chain
}

/** 一个铸造的注册作用域及其静默释放边界。 */
export interface Scope {
  /** 进行作用域拥有注册所经由的上下文。 */
  ctx: Context
  /** 确切的 Cordis disposer，用于将此作用域嵌套进有序的复合 effect 时。 */
  rawDispose: () => Promise<void> | void
  /** 释放每个作用域拥有的注册；竞争调用等待同一次完成。 */
  dispose(): Promise<void>
}

/** 跟随 Cordis fiber 走完异步拆除，即使其原始 disposer 已被认领。 */
async function quiesceFiber(fiber: Fiber): Promise<void> {
  await Promise.resolve(fiber.dispose())
  while (fiber.inertia !== undefined) await fiber.inertia
}

/** 用作支撑作用域 fiber 的共享空操作插件。 */
function scope(): void {}

/** {@link createScope} 接受的选项。 */
export interface CreateScopeOptions {
  /** 在作用域可用之前通过 {@link bindScopeParent} 绑定的外围作用域；绑定保持内部。 */
  parent?: ScopeKey
}

/**
 * 在 `ctx` 下铸造一个作用域。作用域上下文继承铸造插件的依赖 API，
 * 并拥有通过它进行的每个注册。
 * @param ctx - 作用域继承其依赖 API 的活跃上下文。
 * @param key - 用于监听器路由的不透明身份。
 * @param options - 可选的作用域链位置。
 * @returns 作用域上下文和确切/共享的释放边界。
 */
export function createScope(ctx: Context, key: ScopeKey, options?: CreateScopeOptions): Scope {
  if (options?.parent !== undefined) bindScopeParent(key, options.parent)
  const fiber = ctx.plugin(scope)
  const scoped: Context = fiber.ctx.extend({ [kScope]: key })
  let disposing: Promise<void> | undefined
  return {
    ctx: scoped,
    rawDispose: fiber.dispose,
    dispose: () => (disposing ??= quiesceFiber(fiber)),
  }
}

/**
 * 读取上下文继承的最近作用域标签。
 * @param ctx - 要检查的上下文。
 * @returns 其作用域键，未加作用域的上下文为 `undefined`。
 */
export function scopeOf(ctx: Context): ScopeKey | undefined {
  return (ctx as Context & { [kScope]?: ScopeKey })[kScope]
}

/**
 * 构建一个不透明接收器，保留基础过滤器，全局接纳未标记的监听器，
 * 并为匹配键或其任何祖先（{@link bindScopeParent}）接纳已标记的监听器：
 * 外围作用域拥有的监听器接收每个后代作用域的事件，这正是让一个常驻
 * 组合观察在其下组合的每个 agent 的原因。位于分发键之下的标签
 * 始终被排除——事件沿链向上流动，从不向下。
 * @param base - 保留其既有 Cordis 过滤器的主体或服务。
 * @param key - 路由的作用域身份，无作用域主体为 `undefined`。
 * @returns 一个载体，其主体只能通过事件参数获得。
 */
export function scopeTarget<T extends object>(base: T, key: ScopeKey | undefined): Scoped<T> {
  const baseFilter = (base as { [CordisContext.filter]?: (ctx: Context) => boolean })[CordisContext.filter]
  const carrier = {
    [CordisContext.filter](ctx: Context): boolean {
      if (baseFilter !== undefined && !baseFilter.call(base, ctx)) return false
      const tag = scopeOf(ctx)
      if (tag === undefined) return true
      for (let cursor = key; cursor !== undefined; cursor = scopeParents.get(cursor)) {
        if (cursor === tag) return true
      }
      return false
    },
  }
  carrierKeys.set(carrier, key)
  return carrier as unknown as Scoped<T>
}

/**
 * 测试一个值是否是作用域载体。
 * @param value - 要检查的分发接收器。
 * @returns 是否由 {@link scopeTarget} 创建。
 */
export function isScopeCarrier(value: unknown): value is Scoped<object> {
  return typeof value === 'object' && value !== null && carrierKeys.has(value)
}

/**
 * 读取载体的路由键。
 * @param value - 要检查的分发接收器。
 * @returns 载体键，未带键/非载体的值为 `undefined`。
 */
export function carrierKeyOf(value: unknown): ScopeKey | undefined {
  if (!isScopeCarrier(value)) return undefined
  return carrierKeys.get(value)
}
