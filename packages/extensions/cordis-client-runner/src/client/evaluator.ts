/**
 * 浏览器半区的闭包求值：包源码作为 async 函数的函数体运行，其参数
 * 即为符号面。通过重影参数（setTimeout/fetch/require/…）将浏览器
 * 环境全局对象转化为教学性重定向，而无需触碰页面。Host 在定义时
 * 已对源码做了语法预检；此处的 SyntaxError 处理是引擎差异的兜底，
 * 并通过加载报告送达模型。
 */

import * as React from 'react'
import type { CordisDynamicPluginId } from '@deepseek-ai/dsh-api-remotes/client'

/** 闭包必须返回的可挂载插件（FUNCTION 或 OBJECT 形式）。 */
export interface DynamicCordisEvaluatedPlugin {
  /** 可选的插件名；运行器会用模块 id 覆盖它。 */
  name?: string
  /** 浏览器半区声明的服务；运行器会从派发行覆盖它。 */
  inject?: string[]
  /** 接收守卫门面的插件主体。 */
  apply: (ctx: unknown, config?: unknown) => unknown
}

/** 求值器为了构建一个包的闭包而需要从运行器获得的依赖。 */
export interface DynamicCordisClosureEnv {
  /** 将 `host.call` 通过连线路由到本包的 host 半区。 */
  invoke(method: string, args: unknown): Promise<unknown>
  /** 将一条运行时错误文本镜像进加载报告（console.error 的副本）。 */
  noteError(message: string): void
}

const TIMER_REDIRECT
  = 'browser timer globals are unavailable in dynamic packages. Declare inject: [\'timer\'] on the returned plugin, '
    + 'query Client Service.listService for the exact API, and close over that plugin ctx. In React, create timers '
    + 'from an event handler or React.useEffect and return callback-form disposers from the effect cleanup.'

/**
 * 每个被扣留的浏览器全局对象改而指向作者的去处。两处消费者的同一出处：
 * 下面的闭包陷阱会抛出它们，而一条错误消息点名其中之一的渲染崩溃也会
 * 追加同样的重定向 —— 以其它方式触达该全局对象（如 `window.setInterval`）的
 * 包会以引擎自身的裸文本崩溃，而作者无论如何都需要这条重定向。
 */
export const DYNAMIC_CLIENT_REDIRECTS: Readonly<Record<string, string>> = {
  setTimeout: TIMER_REDIRECT,
  setInterval: TIMER_REDIRECT,
  clearTimeout: TIMER_REDIRECT,
  clearInterval: TIMER_REDIRECT,
  fetch:
    'network belongs to the HOST half: register a handler there with harness.handle(method, fn) and call it here via host.call(method, args).',
  require:
    'modules cannot be imported here. React arrives as the `React` closure symbol; everything else goes through ctx services or host.call.',
}

/** 可调用教学陷阱，重影闭包不可触达的环境全局对象。 */
function closureTraps(): Record<string, () => never> {
  const traps: Record<string, () => never> = {}
  for (const [name, redirect] of Object.entries(DYNAMIC_CLIENT_REDIRECTS)) {
    traps[name] = (): never => {
      throw new Error(`${name} is not available in a dynamic client half — ${redirect}`)
    }
  }
  return traps
}

/** `harness` 席位仅存在于 host 侧；任何触碰都会教学化地说明拆分。 */
function harnessTrap(): unknown {
  return new Proxy({}, {
    get(_target, prop) {
      throw new Error(
        `harness.${String(prop)} belongs to the HOST half (\`code\`): register handlers there with harness.handle(method, fn); `
        + 'the browser half calls them via host.call(method, args).',
      )
    },
  })
}

/** `styles.insert` 符号背后的、按包维度的样式标签记账。 */
export class DynamicCordisStyles {
  private readonly tags = new Set<HTMLStyleElement>()

  /** @param pluginId - 所属 Plugin ID，会被打在每个标签的 `data-dyn` 上。 */
  constructor(private readonly pluginId: CordisDynamicPluginId) {}

  /**
   * 注入一张样式表，在包卸载时自动移除。
   * @param css - 原始 CSS 文本。
   * @returns 提前移除这一标签的释放器。
   */
  insert(css: string): () => void {
    if (typeof css !== 'string') throw new Error('styles.insert(css) needs a CSS string')
    const tag = document.createElement('style')
    tag.dataset.dyn = this.pluginId
    tag.textContent = css
    document.head.append(tag)
    this.tags.add(tag)
    return () => {
      this.tags.delete(tag)
      tag.remove()
    }
  }

  /** 当前标签数量（加载报告贡献摘要）。 */
  get count(): number {
    return this.tags.size
  }

  /** 移除本包仍拥有的所有标签（卸载路径）。 */
  dispose(): void {
    for (const tag of this.tags) tag.remove()
    this.tags.clear()
  }
}

/** 为错误镜像把一个 console 参数序列化。 */
function errorText(arg: unknown): string {
  if (arg instanceof Error) return arg.message
  if (typeof arg === 'string') return arg
  if (arg === undefined) return 'undefined'
  try {
    return JSON.stringify(arg)
  } catch {
    // 循环引用或其它不可序列化的 console 参数：镜像会
    // 携带该消息，而此处再无其它可能失败之处。
    return '[unserializable console argument]'
  }
}

/** 带标签透写的 console；错误行还会额外复制到加载报告。 */
function taggedConsole(pluginId: CordisDynamicPluginId, noteError: (message: string) => void): Console {
  const tag = `[cordis:${pluginId}]`
  const forward = (level: 'log' | 'info' | 'warn' | 'error' | 'debug') => (...args: unknown[]): void => {
    console[level](tag, ...args)
    if (level !== 'error') return
    noteError(args.map(errorText).join(' ').slice(0, 500))
  }
  return {
    ...console,
    log: forward('log'),
    info: forward('info'),
    warn: forward('warn'),
    error: forward('error'),
    debug: forward('debug'),
  }
}

/**
 * 将闭包返回值收窄为一个可挂载插件（host 守卫镜像）。
 * @param value - 闭包返回的任何值。
 * @returns 该值是否可挂载。
 */
export function isDynamicCordisPlugin(value: unknown): value is DynamicCordisEvaluatedPlugin | ((ctx: unknown) => unknown) {
  if (typeof value === 'function') return true
  return typeof value === 'object' && value !== null
    && typeof (value as { apply?: unknown }).apply === 'function'
}

/**
 * 求值一个包的浏览器半区并返回（未设防的）插件。
 * @param pluginId - 稳定的 Plugin ID（console 标签与样式归属）。
 * @param clientCode - 浏览器半区的源码：一个返回插件的 async 函数体。
 * @param env - 用于 `host.call` 与错误镜像的运行器接线。
 * @param styles - 包的样式记账（由调用方持有，以便卸载时可释放）。
 * @returns 闭包返回的插件。
 * @throws 针对语法失败与非插件返回的教学性错误。
 */
export async function evaluateClientHalf(
  pluginId: CordisDynamicPluginId,
  clientCode: string,
  env: DynamicCordisClosureEnv,
  styles: DynamicCordisStyles,
): Promise<DynamicCordisEvaluatedPlugin | ((ctx: unknown) => unknown)> {
  const traps = closureTraps()
  const parameters = ['React', 'console', 'styles', 'host', 'harness', ...Object.keys(traps), 'process', 'Buffer']
  let closure: (...args: unknown[]) => Promise<unknown>
  try {
    // 该封装与 host 的预检完全一致，因此行偏移能对齐。
    // 对定义的浏览器半区求值是本包的产品本身：该
    // 源码来自一个已接受并预检过它的 host 进程。
    // oxlint-disable-next-line typescript/no-implied-eval -- 见上文
    const factory = new Function(...parameters, `return (async () => {\n${clientCode}\n})()`)
    closure = factory as (...args: unknown[]) => Promise<unknown>
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    // 引擎差异兜底：host 预检已经带上了
    // 行/插入符的教学内容；浏览器只给出消息。
    throw new Error(
      `client half failed to parse in this browser: ${error.message}\n`
      + 'The browser half is plain JavaScript (no JSX, no TypeScript); build elements with React.createElement.',
    )
  }
  const host = {
    /**
     * 调用本包的 host 半区处理器（与 harness.handle 配对）。一次
     * 无参数可传的调用会省略该参数：它以 `null` 抵达处理器，
     * 因为连线传输的是 JSON，而 `undefined` 不是 JSON ——
     * 要求 `host.call('m', {})` 将流于形式，而默认成 `{}`
     * 又会凭空造出一个调用方从未写下的空参数。
     */
    call: (method: string, args: unknown = null): Promise<unknown> => env.invoke(method, args),
  }
  const returned = await closure(
    React,
    taggedConsole(pluginId, (message) => { env.noteError(message) }),
    styles,
    host,
    harnessTrap(),
    ...Object.values(traps),
    undefined, // process: undefined 可保证 `typeof process` 探针安全
    undefined, // Buffer
  )
  if (!isDynamicCordisPlugin(returned)) {
    if (returned === undefined) {
      throw new Error(
        'client half returned `undefined` — did you forget `return`?\n'
        + '  ✓ return (ctx) => { … }\n'
        + '  ✓ return { name: \'…\', inject: [\'slots\'], apply(ctx) { … } }',
      )
    }
    throw new Error('client half must `return` a plugin: a function, or an object with an `apply(ctx)` method')
  }
  return returned
}
