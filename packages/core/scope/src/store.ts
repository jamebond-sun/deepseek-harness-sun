/**
 * 作用域感知注册表的共享插入顺序存储与 effect 所有权。
 *
 * @module @deepseek-ai/dsh-scope
 */

import type { Context } from '@deepseek-ai/cordis'
import { scopeChainOf, scopeOf } from './index.ts'
import type { ScopeKey } from './index.ts'

/** 单个作用域对注册表的聚合贡献。 */
export interface ScopeLayer {
  /** 此层中的每个表是否都为空。 */
  isEmpty(): boolean
}

/** 两个条目表实现的内部公共读取契约。 */
interface EntryValues<V> {
  values(): IterableIterator<V>
  isEmpty(): boolean
}

/**
 * 插入顺序的具名条目，重复诊断由调用方拥有。
 *
 * 值是借用。迭代器在单个非空表世代内是活跃的；
 * 清空表会使它们与后续插入分离。每次成功插入都返回
 * 针对该确切条目的幂等撤销。
 */
export class NamedEntries<V> implements EntryValues<V> {
  private data = new Map<string, V>()

  constructor(
    private readonly duplicateError: (name: string) => Error,
  ) {}

  /**
   * 插入一个唯一名称。
   * @param name - 此表内唯一的名称。
   * @param value - 要保留的借用值。
   * @returns 一个幂等撤销，只移除此次插入。
   */
  insert(name: string, value: V): () => void {
    const data = this.data
    if (data.has(name)) throw this.duplicateError(name)
    data.set(name, value)
    let active = true
    return () => {
      if (!active) return
      active = false
      data.delete(name)
      if (data.size === 0 && this.data === data) this.data = new Map()
    }
  }

  /**
   * 读取单个具名值。
   * @param name - 要解析的名称。
   * @returns 保留的值，缺席时为 `undefined`。
   */
  get(name: string): V | undefined {
    return this.data.get(name)
  }

  /**
   * 测试单个名称是否为成员。
   * @param name - 要测试的名称。
   * @returns 表是否包含该名称。
   */
  has(name: string): boolean {
    return this.data.has(name)
  }

  /**
   * 按插入顺序迭代活跃名称。
   * @returns 原生的活跃键迭代器。
   */
  keys(): IterableIterator<string> {
    return this.data.keys()
  }

  /**
   * 按插入顺序迭代活跃条目。
   * @returns 原生的活跃条目迭代器。
   */
  entries(): IterableIterator<[string, V]> {
    return this.data.entries()
  }

  /**
   * 按插入顺序迭代活跃值。
   * @returns 原生的活跃值迭代器。
   */
  values(): IterableIterator<V> {
    return this.data.values()
  }

  /**
   * 测试此表是否没有条目。
   * @returns 表是否为空。
   */
  isEmpty(): boolean {
    return this.data.size === 0
  }
}

/**
 * 插入顺序的匿名条目，具有独立的注册身份。
 *
 * 相等的值保持为独立注册。值是借用，迭代器在单个非空表世代内是活跃的；
 * 清空表会使它们与后续追加分离。
 */
export class AnonymousEntries<V> implements EntryValues<V> {
  private data = new Map<symbol, V>()

  /**
   * 追加一个独立拥有的值。
   * @param value - 要保留的借用值。
   * @returns 针对此确切追加的幂等撤销。
   */
  append(value: V): () => void {
    const data = this.data
    const key = Symbol()
    data.set(key, value)
    let active = true
    return () => {
      if (!active) return
      active = false
      data.delete(key)
      if (data.size === 0 && this.data === data) this.data = new Map()
    }
  }

  /**
   * 按插入顺序迭代活跃值。
   * @returns 原生的活跃值迭代器。
   */
  values(): IterableIterator<V> {
    return this.data.values()
  }

  /**
   * 测试此表是否没有条目。
   * @returns 表是否为空。
   */
  isEmpty(): boolean {
    return this.data.size === 0
  }
}

/**
 * 为单个注册表拥有全局与精确作用域层。
 *
 * 读取从不创建作用域层。注册从提供的 Cordis 上下文同时派生可见性和
 * effect 所有权，在通知之前收集撤销，并只回收完全为空的聚合层。
 */
export class ScopedLayers<L extends ScopeLayer> {
  /** 急切构建的上下文全局层。 */
  readonly global: L

  private readonly scoped = new Map<ScopeKey, L>()

  constructor(
    private readonly createLayer: (scope: ScopeKey | undefined) => L,
    private readonly onChange: () => void,
  ) {
    this.global = createLayer(undefined)
  }

  /**
   * 读取既有的精确作用域覆盖。刻意对链不感知：寻址单个作用域自己的
   * 贡献（其限制、其守卫）的调用方不得静默拾取祖先的——
   * 在继承才是重点时使用 {@link chainLayers}。
   * @param scope - 精确作用域键；`undefined` 表示没有覆盖。
   * @returns 既有的作用域层，不创建新的，无覆盖时为 `undefined`。
   */
  peek(scope: ScopeKey | undefined): L | undefined {
    if (scope === undefined) return undefined
    return this.scoped.get(scope)
  }

  /**
   * 沿作用域父链（{@link scopeChainOf}）的既有覆盖，
   * 最远祖先在前、精确作用域在后，使调用方按顺序层叠它们时
   * 给最近的作用域最终决定权。
   * @param scope - 查看作用域，无覆盖为 `undefined`。
   * @returns 既有层，最近者在最后；缺席的覆盖被跳过。
   */
  chainLayers(scope: ScopeKey | undefined): L[] {
    const layers: L[] = []
    for (const key of scopeChainOf(scope).reverse()) {
      const layer = this.scoped.get(key)
      if (layer !== undefined) layers.push(layer)
    }
    return layers
  }

  /**
   * 物化全局具名条目及其后的作用域链遮蔽，
   * 最远祖先在前，使最近作用域的条目赢得名称。
   * @param scope - 查看作用域，全局视图为 `undefined`。
   * @param pick - 从一个层选择具名表。
   * @returns 插入顺序的有效映射。
   */
  merge<V>(
    scope: ScopeKey | undefined,
    pick: (layer: L) => NamedEntries<V>,
  ): Map<string, V> {
    const merged = new Map(pick(this.global).entries())
    for (const layer of this.chainLayers(scope)) {
      for (const [name, value] of pick(layer).entries()) merged.set(name, value)
    }
    return merged
  }

  /**
   * 将单个同步层变更附加到其注册上下文。
   * @param ctx - 同时决定作用域可见性和 effect 所有权的上下文。
   * @param action - 返回其同步撤销的原子变更。
   * @param options - Cordis effect 标签和可选的变更通知。
   * @returns `ctx.effect()` 返回的确切 disposer。
   */
  effect(
    ctx: Context,
    action: (layer: L) => () => void,
    options: { label: string; notify?: boolean },
  ): () => void {
    const scope = scopeOf(ctx)
    const notify = options.notify ?? true
    const dispose = ctx.effect(function* (this: ScopedLayers<L>) {
      let layer: L
      let created = false
      if (scope === undefined) {
        layer = this.global
      } else {
        const existing = this.scoped.get(scope)
        if (existing === undefined) {
          layer = this.createLayer(scope)
          this.scoped.set(scope, layer)
          created = true
        } else {
          layer = existing
        }
      }

      let undo: () => void
      try {
        undo = action(layer)
      } catch (error) {
        if (scope !== undefined && created && layer.isEmpty()) this.scoped.delete(scope)
        throw error
      }

      yield () => {
        undo()
        if (scope !== undefined && layer.isEmpty()) this.scoped.delete(scope)
        if (notify) this.onChange()
      }
      if (notify) this.onChange()
    }.bind(this), options.label)
    // oxlint-disable-next-line typescript/no-misused-promises -- exact synchronous disposer preserves Cordis effect identity
    return dispose
  }
}
