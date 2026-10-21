/**
 * Mod 注册：运行某个 mod 的 `register(on, options)`，并将每一次
 * `on(...)` 注册保留在一个有序注册表中，由分发逻辑从中选取。
 * @module
 */

import type { LoadedMod, RegisteredHook } from './chain.ts'
import { messageOf } from './values.ts'
import { describeMatcher, ENGINE_EVENTS, eventMatches, isEventPattern } from './matcher.ts'
import type { AnyHook, HookMatcher, ModDefinition, ModOn, HookRegistration } from './types.ts'

/** Claude Code 接受的插件名称：字母、数字、`_` 与 `-`。 */
const PLUGIN_NAME = /^[A-Za-z0-9_-]{1,64}$/u

/** Mods 按加载顺序排列；钩子先按 mod、再按注册顺序排列。 */
export class HookRegistry {
  private readonly hooks: RegisteredHook[] = []
  private readonly mods: LoadedMod[] = []

  /**
   * 已加载的 mod（按加载顺序）。
   * @returns 按加载顺序排列的 mod。
   */
  list(): readonly LoadedMod[] {
    return this.mods
  }

  /**
   * 添加一个 mod 及其注册项；同名 mod 必须先被移除。
   * @param mod - 这些钩子所属的 mod。
   * @param hooks - 按 `on` 顺序排布的、它的注册项。
   */
  add(mod: LoadedMod, hooks: readonly RegisteredHook[]): void {
    if (this.mods.some(loaded => loaded.name === mod.name)) {
      throw new Error(`hooks module ${mod.name} not loaded: another plugin of that name loads first`)
    }
    this.mods.push(mod)
    this.hooks.push(...hooks)
  }

  /**
   * 丢弃一个 mod 及其钩子。
   * @param name - 插件名称。
   */
  remove(name: string): void {
    const index = this.mods.findIndex(mod => mod.name === name)
    if (index === -1) return
    const [mod] = this.mods.splice(index, 1)
    for (let i = this.hooks.length - 1; i >= 0; i -= 1) {
      if (this.hooks[i]?.mod === mod) this.hooks.splice(i, 1)
    }
  }

  /**
   * 其模式选中了 `event` 的钩子，最外层的在前。某个 mod 经 mods API 调用所
   * 引发的事件，仅被在它之前加载的 mods 看到。
   * @param event - 事件名称。
   * @param raisedBy - 其 `$` 调用成为该事件的 mod，或为引擎时的 undefined。
   * @returns 有序的钩子；匹配器在运行时求值。
   */
  select(event: string, raisedBy?: LoadedMod): RegisteredHook[] {
    return this.hooks
      .filter(hook => (raisedBy === undefined || hook.mod.order < raisedBy.order) && eventMatches(hook.event, event))
      .sort((left, right) => left.mod.order - right.mod.order)
  }

  /**
   * 某个 mod 以精确名称钩住、却永远不会被宿主引发的引擎事件。
   * @param mod - 已加载的 mod。
   * @param served - 宿主所引发的引擎事件。
   * @returns 未被服务的事件名称，按注册顺序，各出现一次。
   */
  unserved(mod: LoadedMod, served: ReadonlySet<string>): string[] {
    const names: string[] = []
    for (const hook of this.hooks) {
      if (hook.mod !== mod || !ENGINE_EVENTS.has(hook.event) || served.has(hook.event) || names.includes(hook.event)) continue
      names.push(hook.event)
    }
    return names
  }

  /**
   * 带有匹配器的事件名称，格式如同 `claude plugin validate` 打印 `hooks:` 行那样。
   * @param mod - 已加载的 mod。
   * @returns 它带有匹配器的事件，以逗号分隔。
   */
  describe(mod: LoadedMod): string {
    return this.hooks
      .filter(hook => hook.mod === mod)
      .map(hook => `${hook.event}${describeMatcher(hook.matcher)}`)
      .join(', ')
  }
}

function isMatcher(value: unknown): value is HookMatcher {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 构建某一次 `register` 调用所收到的 `on` 函数，并收集其注册项。
 * 校验遵循 Claude Code：事件名称必须是一个已知的名称或 glob，且一个事件
 * 在没有匹配器的情况下只能被注册一次。
 * @param mod - 正在注册的 mod。
 * @returns `on` 以及它向其追加的列表。
 */
export function createOn(mod: LoadedMod): { on: ModOn; hooks: RegisteredHook[] } {
  const hooks: RegisteredHook[] = []
  const unmatched = new Set<string>()
  const on = ((event: unknown, matcherOrHook: unknown, maybeHook?: unknown): HookRegistration => {
    if (typeof event !== 'string') throw new TypeError(`${mod.name}: the event name passed to on() is not a string literal`)
    if (!isEventPattern(event)) throw new Error(`${mod.name}: "${event}" is not an event`)
    const hook = maybeHook ?? matcherOrHook
    const matcher = maybeHook === undefined ? undefined : matcherOrHook
    if (typeof hook !== 'function') throw new TypeError(`${mod.name}: on("${event}") needs a hook function`)
    if (matcher !== undefined && !isMatcher(matcher)) throw new TypeError(`${mod.name}: on("${event}") matcher must be an object`)
    if (matcher === undefined) {
      if (unmatched.has(event)) throw new Error(`${mod.name}: on("${event}") is registered twice without a matcher`)
      unmatched.add(event)
    }
    const registered: RegisteredHook = {
      mod, event, matcher, hook: hook as AnyHook, catchHandler: undefined, reported: new Set(),
    }
    hooks.push(registered)
    return {
      catch(handler: AnyHook): void {
        if (typeof handler !== 'function') throw new TypeError(`${mod.name}: on("${event}").catch needs a handler function`)
        registered.catchHandler = handler
      },
    }
  }) as ModOn
  return { on, hooks }
}

/**
 * 运行某个 mod 的 `register` 并收集其钩子。一个抛出异常的 `register` 会以
 * Claude Code 的措辞使该 mod 加载失败；是否在没有它的情况下继续会话，
 * 由调用方决定。
 * @param definition - 其插件所定义的、该 mod 的形态。
 * @param order - 该 mod 在链中的位置；更靠前的 mod 在更靠后的 mod 之外运行。
 * @returns 已加载的 mod 及其注册项。
 */
export async function registerMod(definition: ModDefinition, order: number): Promise<{ mod: LoadedMod; hooks: RegisteredHook[] }> {
  if (!PLUGIN_NAME.test(definition.name)) {
    throw new Error(`mod "${definition.name}" not loaded: a plugin name uses letters, digits, _ and - only`)
  }
  const mod: LoadedMod = Object.freeze({
    name: definition.name,
    version: definition.version,
    root: definition.root ?? process.cwd(),
    options: Object.freeze({ ...definition.options }),
    order,
  })
  const { on, hooks } = createOn(mod)
  try {
    await definition.register(on, mod.options)
  } catch (error: unknown) {
    throw new Error(`${definition.name}: hooks module did not load: register threw ${messageOf(error)}`, { cause: error })
  }
  return { mod, hooks }
}
