/**
 * tool-cordis 上下文门面的浏览器孪生：一份生命周期安全的动词白名单，
 * 外加可选的 `ctx.get()` 查找与已声明服务的属性访问，其中
 * 框架内部被扣留，返回 Context 值被拒绝。两个席位带有额外机制：
 * `slots`，其注册代理分配任意的重影优先级，并把普通条目或 Factory
 * 定义记入台账 —— 以被追踪的接收者调用服务，从而让副作用落在
 * 调用方插件的 fiber 上（SlotRegistry.register 正是因此必须保持为
 * 原型方法）—— 以及 `theme`，其覆盖来源被固定到包 id。
 *
 * 这是 API 纪律，而非安全边界：动态包的代码与接受其定义的
 * host 进程同样受信任。
 */

import { Context } from '@deepseek-ai/cordis'
import type { DynamicCordisPackage } from '@deepseek-ai/dsh-api-remotes/client'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ThemeRuntime } from '@deepseek-ai/dsh-client-ui-theme/client'

/** 已声明服务之外的门面动词（host CTX_VERBS 孪生）。 */
const CTX_VERBS = new Set([
  'effect', 'on', 'once', 'provide', 'timeout', 'interval', 'setTimeout', 'setInterval', 'throttle', 'debounce',
])
const TIMER_VERBS = new Set(['timeout', 'interval', 'setTimeout', 'setInterval', 'throttle', 'debounce'])

/** 一个包的 Slot 或 Factory 注册台账行（贡献投影来源）。 */
export interface DynamicCordisSlotLedgerRow {
  /** 目标 Slot 名，或 Factory 定义的 `factory:<name>`。 */
  slot: string
  /** 被分配的重影优先级（全局唯一 —— 据此将胜出者匹配回所属包）。 */
  priority: number | undefined
}

/** 门面在真实 ctx 之外、为了管控一个包而所需的依赖。 */
export interface DynamicCordisGuardEnv {
  /** 被派发的 Package 行。 */
  pkg: DynamicCordisPackage
  /** 台账汇点：本包所做的每次 Slot 或 Factory 注册。 */
  ledger: DynamicCordisSlotLedgerRow[]
  /**
   * 归属索引汇点：坐落到槽位中的组件对象，以便后续
   * 针对所存条目报告的渲染崩溃能归因回
   * 本包。身份是关键 —— 注册表逐字存储组件，
   * 正因如此，条目无需再记住其它任何东西。
   * @param component - 包作为组件传入的任何值。
   */
  claim(component: unknown): void
  /** 分配一个页面局部的重影等级；后注册的排在前。 */
  allocatePriority(): number
  /** 向所属 Agent 报告一次激活后的守卫拒绝。 */
  reportFailure(error: Error): void
}

/** 拒绝任何返回值为 cordis Context 的服务（host 守卫孪生）。 */
function denyContext(value: unknown, service: string, env: DynamicCordisGuardEnv): unknown {
  if (value instanceof Context) {
    return rejectGuard(env,
      `service "${service}" returned a cordis Context, which the dynamic facade does not expose. `
      + 'Operate through your own plugin ctx and the services you declared — never another context.',
    )
  }
  return value
}

/**
 * 以被追踪的服务为接收者转发服务方法 —— 原型方法（slots.register）内
 * 的 `this.ctx` 必须保持为调用方的 ctx，以便副作用落在
 * 调用方插件的 fiber 上 —— 同时拒绝 Context 返回值。
 */
function guardedService(service: object, name: string, env: DynamicCordisGuardEnv): unknown {
  return new Proxy(service, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target)
      if (typeof value !== 'function') return denyContext(value, name, env)
      return (...args: unknown[]): unknown => {
        const result: unknown = Reflect.apply(value, target, args)
        if (result instanceof Promise) return result.then(resolved => denyContext(resolved, name, env))
        return denyContext(result, name, env)
      }
    },
  })
}

/** 本门面读取并重写的、被擦除的注册选项。 */
interface ErasedSlotOptions {
  name?: string
  priority?: number
  [key: string]: unknown
}

/**
 * slots 席位：在被追踪服务自身的 Slot 与 Factory 注册方法周围，
 * 自动处理重影优先级与台账记录。
 */
function guardedSlots(slots: SlotRegistry, env: DynamicCordisGuardEnv): unknown {
  return new Proxy(slots, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target)
      if (prop !== 'register' && prop !== 'registerFactory') {
        if (typeof value !== 'function') return denyContext(value, 'slots', env)
        return (...args: unknown[]): unknown => denyContext(Reflect.apply(value, target, args), 'slots', env)
      }
      return (rawOptions: unknown, component: unknown): unknown => {
        if (typeof rawOptions !== 'object' || rawOptions === null) {
          return rejectGuard(env, 'slots.register(options, component) needs an options object with a `name`')
        }
        const options = { ...rawOptions as ErasedSlotOptions }
        const slot = options.name
        if (typeof slot !== 'string' || slot.length === 0) {
          return rejectGuard(env, `slots.${prop} options need a string \`name\``)
        }
        if (prop === 'registerFactory') {
          const dispose = Reflect.apply(value as (...args: unknown[]) => unknown, target, [options, component])
          env.ledger.push({ slot: `factory:${slot}`, priority: undefined })
          env.claim(component)
          return dispose
        }
        if (slot === 'tool.view.cordis') {
          if (options.key !== 'self') {
            return rejectGuard(env, 'tool.view.cordis only accepts key "self"; the runtime binds it to this Package')
          }
          options.key = `${env.pkg.pluginId}.${env.pkg.packageId}`
        }
        // 重影类槽位会获得一个页面局部的排序等级。后注册的排在前；
        // 链槽保留自身的选举（选择顺序）不变。
        const spec = (slots.spec as (key: string) => { kind?: string } | undefined)(slot)
        let priority = options.priority
        if (spec === undefined || spec.kind !== 'chain') {
          priority = env.allocatePriority()
          options.priority = priority
        }
        const register = Reflect.get(target, 'register', target) as (opts: object, comp: unknown) => () => void
        const dispose = register.call(target, options, component)
        env.ledger.push({ slot, priority })
        // 在注册表接受之后：被拒绝的注册不会落座任何条目，
        // 因此认领一个就会索引到一个任何崩溃都无法点名的组件。
        env.claim(component)
        return dispose
      }
    },
  })
}

/**
 * theme 席位：`overrideTokens` 的 source 被强制固定为包 id —— 动态包
 * 永远无法冒充（或驱逐）其它来源的层，而其自身的层在单一身份下
 * 汇聚，卸载能够据此推理。该层的释放器还额外挂在调用方 fiber 上，
 * 因为文档化契约是"卸载即恢复"，且模型代码不可被信任会
 * 保留返回的句柄（与 slots 对称 —— register 挂起自身的清理）。
 * 其余一切都经由通用守卫转发。
 */
function guardedTheme(theme: ThemeRuntime, env: DynamicCordisGuardEnv, ctx: Context): unknown {
  return new Proxy(theme, {
    get(target, prop) {
      if (prop !== 'overrideTokens') {
        const value: unknown = Reflect.get(target, prop, target)
        if (typeof value !== 'function') return denyContext(value, 'theme', env)
        return (...args: unknown[]): unknown => {
          const result: unknown = Reflect.apply(value, target, args)
          if (result instanceof Promise) return result.then(resolved => denyContext(resolved, 'theme', env))
          return denyContext(result, 'theme', env)
        }
      }
      return (source: unknown, tokens: unknown): unknown => {
        // 保留双参数形态，以便门面与文档化的
        // 服务签名一致；source 的值是被替换的，绝不被信任。
        if (tokens === undefined && typeof source === 'object' && source !== null) {
          return rejectGuard(env,
            'theme.overrideTokens(source, tokens) takes two arguments; source is replaced with your package id, '
            + 'so pass any string first and the token map second: overrideTokens(\'mine\', { \'--dsw-alias-…\': { light: \'…\', dark: \'…\' } })',
          )
        }
        const method = Reflect.get(target, 'overrideTokens', target)
        const dispose = Reflect.apply(method, target, [`${env.pkg.pluginId}.${env.pkg.packageId}`, tokens]) as () => void
        // 归属 Fiber 的生命周期；返回的句柄对提前
        // 移除仍有效（服务释放器按层身份是幂等的）。
        ctx.effect(() => dispose, 'cordis-client-runner: dynamic theme override layer')
        return dispose
      }
    },
  })
}

/**
 * 构建某个动态插件的 `apply` 所接收的门面（host sandboxContext
 * 孪生，浏览器席位）。`ctx.get(name)` 执行可选查找；直接
 * 的 `ctx.serviceName` 访问由 fiber 的 `inject` 声明把关。
 * @param ctx - 插件的真实 fiber ctx（由 loader 创建）。
 * @param env - 包行 + 台账汇点。
 * @returns 代替 ctx 的白名单代理。
 */
export function dynamicCordisContext(ctx: Context, env: DynamicCordisGuardEnv): Context {
  const declared = new Set(Object.keys(ctx.fiber.inject))
  const denyRead = (prop: string): never => {
    if (ctx.get(prop) !== undefined) {
      return rejectGuard(env,
        `service "${prop}" is not declared by your plugin. Declare it on the plugin you return: `
        + `{ inject: ['${prop}', …], apply(ctx) { … } } — a plain \`function\` has no declaration site, `
        + 'so use the object form. The runtime then parks the package if the provider unloads.',
      )
    }
    return rejectGuard(env,
      `dynamic ctx does not expose "${prop}". Available: ctx.on / ctx.provide / timer helpers after injecting timer, and any service your `
      + 'returned plugin declared in inject (slots and theme are the usual UI seats). Framework internals are withheld '
      + 'by design.',
    )
  }
  const readService = (name: string, requireDeclaration: boolean): unknown => {
    if (requireDeclaration && !declared.has(name)) return denyRead(name)
    const service = denyContext(ctx.get(name), name, env)
    if (service === null || (typeof service !== 'object' && typeof service !== 'function')) return service
    if (name === 'slots') return guardedSlots(service as SlotRegistry, env)
    if (name === 'theme') return guardedTheme(service as ThemeRuntime, env, ctx)
    return guardedService(service, name, env)
  }
  return new Proxy({}, {
    get(_target, prop) {
      if (prop === 'get') return (name: string): unknown => readService(name, false)
      if (typeof prop !== 'string') return undefined
      // 惰性动词转发器（host 孪生）：仅在被调用时才解析 ctx[verb]。
      if (CTX_VERBS.has(prop)) {
        return (...args: unknown[]): unknown => {
          if (TIMER_VERBS.has(prop) && !declared.has('timer')) return denyRead('timer')
          const method = ctx[prop as keyof Context]
          return Reflect.apply(method as (...a: unknown[]) => unknown, ctx, args)
        }
      }
      return readService(prop, true)
    },
    set(_target, prop) {
      return rejectGuard(env, `dynamic ctx is read-only; cannot assign "${String(prop)}"`)
    },
    has: (_target, prop) => prop === 'get'
      || (typeof prop === 'string'
        && ((CTX_VERBS.has(prop) && (!TIMER_VERBS.has(prop) || declared.has('timer'))) || declared.has(prop))),
  }) as Context
}

function rejectGuard(env: DynamicCordisGuardEnv, message: string): never {
  const error = new Error(message)
  env.reportFailure(error)
  throw error
}
