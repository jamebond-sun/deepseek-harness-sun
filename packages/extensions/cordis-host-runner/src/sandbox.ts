/**
 * 一个动态包的 HOST 半区在其中求值的 `node:vm` 沙箱：一个全新领域，其全局对象
 * 是一个带标签的透写式 console、那些 `harness` 注册辅助函数、一个裸 vm 上下文所
 * 缺少的编码原语，以及对 Node API 的可调用陷阱——沙箱刻意扣留这些 API。陷阱把
 * 文件系统、网络、进程与定时器工作导向 `ctx.fs`、`ctx.web`、
 * `ctx.bash` 与 Cordis 定时器。这让协作型包可被检视与释放，但
 * 并非隔离：宿主领域的辅助函数仍是一条逃逸路径。
 *
 * 浏览器半区永远不会触及本模块——它由客户端运行器在一个
 * 闭包中、连同它自身的门面一起求值。
 * @module @deepseek-ai/dsh-cordis-host-runner/sandbox
 */

import { createContext, runInContext, Script } from 'node:vm'
import { sandboxDefineTool, sandboxRegisterTool } from './guard.ts'

/**
 * 一个包的、为每一行打上包 id 标签的透写式 console。透写（宿主 stdout/stderr），
 * 而非缓冲进工具结果：一个已注册的监听器会在 run 调用返回很久之后才触发，而它的输出
 * 必须落在用户能看见的地方——对于终端入口点，就是宿主终端。
 */
function taggedConsole(id: string): Record<'log' | 'info' | 'warn' | 'error' | 'debug', (...args: unknown[]) => void> {
  const tag = `[cordis:${id}]`
  const log = (...args: unknown[]): void => { console.log(tag, ...args) }
  const error = (...args: unknown[]): void => { console.error(tag, ...args) }
  return { log, info: log, warn: log, debug: log, error }
}

/**
 * 只修补 VM 构造器，从而 `instanceof` 同时接受作为
 * 参数、事件或服务结果传入的 VM 值与宿主值；宿主固有对象保持不动。
 */
const DUAL_REALM_INSTANCEOF_PRELUDE = `
(hostIntrinsics) => {
  'use strict'
  const ordinary = Function.prototype[Symbol.hasInstance]
  for (const name of Object.keys(hostIntrinsics)) {
    const VmCtor = globalThis[name]
    const HostCtor = hostIntrinsics[name]
    if (typeof VmCtor !== 'function' || typeof HostCtor !== 'function') continue
    Object.defineProperty(VmCtor, Symbol.hasInstance, {
      value: (instance) => ordinary.call(VmCtor, instance) || ordinary.call(HostCtor, instance),
      configurable: true,
    })
  }
}
`

/** 在一个全新创建的沙箱中运行 {@link DUAL_REALM_INSTANCEOF_PRELUDE}，把宿主固有对象交给它配对。 */
function patchDualRealmInstanceof(sandbox: object): void {
  const patch = runInContext(DUAL_REALM_INSTANCEOF_PRELUDE, sandbox) as (intrinsics: Record<string, unknown>) => void
  patch({ Object, Array, Function, Error, TypeError, RangeError, SyntaxError, Promise, RegExp, Date, Map, Set })
}

const TIMER_REDIRECT
  = 'Node timers are unavailable. Use the cordis timer service instead: declare inject: [\'timer\'] on your plugin '
    + 'and call ctx.timeout / ctx.interval after querying Host Service.listService for the exact overloads. '
    + 'Those calls are fiber effects, cleaned up automatically when stopped.'

/**
 * 沙箱刻意禁用的、可调用 Node API，每个都映射到其陷阱错误所命名的
 * cordis 替代项。只有函数值的全局对象会被陷阱捕获；一个数据值的全局对象（如 `process`）
 * 保持 `undefined`，因为一个会抛出的访问器会在解析时引爆常见的 `typeof process` 特性探测。
 */
const NODE_API_REDIRECTS: Record<string, string> = {
  require:
    'Node modules are unavailable. Use the cordis services on ctx instead — e.g. inject: [\'fs\'] for files, '
    + '[\'web\'] for HTTP, [\'bash\'] for processes; query Service.listService with cordis_inspect_query first.',
  setTimeout: TIMER_REDIRECT,
  setInterval: TIMER_REDIRECT,
  setImmediate: TIMER_REDIRECT,
  clearTimeout: TIMER_REDIRECT,
  clearInterval: TIMER_REDIRECT,
  fetch:
    'Network access goes through the cordis web service: declare inject: [\'web\'] and call ctx.web '
    + '(query Host Service.listService with cordis_inspect_query for its methods).',
}

/** 为 {@link NODE_API_REDIRECTS} 构建陷阱函数：调用任一都会抛出重定向。 */
function nodeApiTraps(): Record<string, () => never> {
  const traps: Record<string, () => never> = {}
  for (const [name, redirect] of Object.entries(NODE_API_REDIRECTS)) {
    traps[name] = () => {
      throw new Error(`${name} is not available in the dynamic package sandbox — ${redirect}`)
    }
  }
  return traps
}

/**
 * 构建一个 host 半区在其中求值的 vm 上下文：带标签的 console、
 * 那些 `harness` 注册辅助函数、编码原语、Node-API 陷阱，
 * 以及已 `createContext` 化的双领域 `instanceof` 修补。
 * @param id - 包 id（`dyn-<n>`），用作 console 标签与文件名词干。
 * @param harnessExtras - 注册对之外的、每包专属 `harness` 动词（`handle`）。
 * @returns 传给 {@link evaluateHostCode} 的、已语境化的沙箱对象。
 */
export function createSandbox(id: string, harnessExtras: Record<string, unknown> = {}): object {
  const sandbox = {
    ...nodeApiTraps(),
    console: taggedConsole(id),
    harness: { defineTool: sandboxDefineTool, registerTool: sandboxRegisterTool, ...harnessExtras },
    // 全新 vm 上下文中缺失的 Web API——使其可用，从而模型
    // 无需 Buffer（同样缺失）即可编解码 base64。宿主
    // 对 Buffer 闭包，而绝不暴露 Buffer 本身。
    btoa: (s: string) => Buffer.from(s, 'utf-8').toString('base64'),
    atob: (s: string) => Buffer.from(s, 'base64').toString('utf-8'),
    TextEncoder,
    TextDecoder,
  }
  createContext(sandbox)
  patchDualRealmInstanceof(sandbox)
  return sandbox
}

/**
 * 跨领域的 SyntaxError 检测：一次 `runInContext` 内的编译失败
 * 会在 SANDBOX 领域中构造其错误，因此宿主的 `instanceof
 * SyntaxError` 静默为假——`name` 属性才是领域安全的标签。
 */
function isSyntaxError(error: unknown): error is Error {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'SyntaxError'
}

/**
 * 一个 vm `SyntaxError` 所携带的解析失败上下文：vm 会在消息
 * 之前打印违规源码行与插入符号，这正是模型自我修正所需——
 * 把它呈现出来，而非赤裸的消息。当栈中不携带此类前缀时回退到 `String(error)`。
 * @param error - 在编译包代码时抛出的 `SyntaxError`（宿主或沙箱领域）。
 * @returns 截至并包含 `SyntaxError: …` 行的栈前缀。
 */
export function syntaxErrorContext(error: Error): string {
  const lines = (error.stack ?? '').split('\n')
  const messageIndex = lines.findIndex(line => line.startsWith('SyntaxError'))
  if (messageIndex === -1) return String(error)
  return lines.slice(0, messageIndex + 1).join('\n')
}

/**
 * 一次解析失败所产生的、教学性的文本，由 define 期的
 * 预检与运行期求值共享，从而无论哪个动词捕获到，模型读到的是同一份诊断。
 * @param half - 哪个半区解析失败，以其所携带的 define 参数命名。
 * @param context - 该失败的 {@link syntaxErrorContext}。
 * @returns 面向模型的错误消息。
 */
export function parseErrorMessage(half: 'code.host' | 'code.client', context: string): string {
  // 把 TypeScript 启发式限定在违规行，而非整段代码：
  // 普通描述字符串中的 ` as ` 不得把一条普通的
  // 语法错误变成误导性的“移除注解”消息。
  const offendingLine = context.split('\n')[1] ?? ''
  if (/\bas\b/.test(offendingLine)) {
    return `dynamic package \`${half}\` failed to parse:\n${context}\n`
      + 'The sandbox runs plain JavaScript, not TypeScript. Remove type annotations:\n'
      + '  ✗ { type: \'text\' as const, text: x }\n'
      + '  ✓ { type: \'text\', text: x }'
  }
  return `dynamic package \`${half}\` failed to parse:\n${context}\n`
    + 'Note: it runs as the BODY of an async function (line numbers are offset by the 1-line wrapper). '
    + 'Check bracket balance — ending the returned plugin object with `});` closes a call that was never opened; '
    + 'a plain `return { … }` ends with `}` (an optional `;`), never `)`.'
}

/**
 * 在不运行的前提下解析一个半区的源码：define 期的预检，
 * 它把无法解析的代码挡在注册表之外，从而模型先修正它再重新 define，
 * 而不是在运行期才发现失败。`new Function` 是这道闸门——没有真正 `node:vm` 的宿主
 * （浏览器 worker）同样会拒绝无法解析的代码——而 `vm.Script` 只是尽力而为的
 * 美化器：在 Node 宿主上，它的失败携带教学文本所依托的“源码行加插入符号”前缀，而在
 * vm 为桩时消息保持赤裸。两个解析器的语法面在边缘处不同（`new.target` 能在函数体
 * 中解析，却不能在 vm 包装器的顶层解析），这是无 vm 闸门的、被接受的成本；而在缺少
 * `'unsafe-eval'` 的页面 CSP 之下，`new Function` 会抛出 `EvalError`，它不经包装地传播。
 * @param code - 模型编写的函数体。
 * @param half - 携带它的 define 参数，用于错误文本。
 * @throws 当函数体无法解析时抛出，附带违规行与一条教学性提示。
 */
export function precheckCode(code: string, half: 'code.host' | 'code.client'): void {
  const wrapped = `(async () => {\n${code}\n})()`
  try {
    // 仅编译：构造该函数会解析源码而不运行任何东西。
    // oxlint-disable-next-line typescript/no-implied-eval -- 对模型编写代码的解析闸门；没有任何东西被调用
    new Function(wrapped)
  } catch (error) {
    if (!isSyntaxError(error)) throw error
    throw new Error(parseErrorMessage(half, prettyParseContext(wrapped, half, error)))
  }
}

/**
 * 对一段 `new Function` 已拒绝的正文做尽力的 vm 重编译，仅用于
 * “源码行加插入符号”的前缀。
 * @param wrapped - 解析失败的那段包裹后的源码。
 * @param half - 携带它的 define 参数，用于 vm 文件名。
 * @param refusal - 闸门自身的 `SyntaxError`，即回退的上下文来源。
 * @returns 当真实 vm 产生前缀时返回该前缀，否则返回赤裸的拒绝信息。
 */
function prettyParseContext(wrapped: string, half: 'code.host' | 'code.client', refusal: Error): string {
  try {
    new Script(wrapped, { filename: `cordis-dyn-${half}.js` })
  } catch (vmError) {
    if (isSyntaxError(vmError)) return syntaxErrorContext(vmError)
    // 一个被桩化的 vm（浏览器 worker）会拒绝 Script 本身；那处
    // 闸门的错误是唯一的上下文来源。
  }
  return String(refusal)
}

/**
 * 把 host 半区作为一个 async 函数体在沙箱内求值。`vmTimeoutMs` 只
 * 约束同步部分；一个 async 体可以逃逸它——在本模块的信任立场下是可接受的。解析错误
 * 附带违规行，以及一条“移除 TypeScript”或“括号平衡”的提示。
 * @param sandbox - 来自 {@link createSandbox} 的、已语境化的对象。
 * @param code - 模型编写的函数体；必须 `return` 一个插件。
 * @param id - 包 id，用作 vm 文件名（`cordis-dyn-<id>.js`）。
 * @param vmTimeoutMs - 同步求值的上限，以毫秒计。
 * @returns 代码所返回的任何东西，仍未被收窄（运行生命周期会检查插件形态）。
 */
export async function evaluateHostCode(sandbox: object, code: string, id: string, vmTimeoutMs: number): Promise<unknown> {
  try {
    return await runInContext(
      `(async () => {\n${code}\n})()`,
      sandbox,
      { filename: `cordis-dyn-${id}.js`, timeout: vmTimeoutMs },
    )
  } catch (error) {
    if (!isSyntaxError(error)) throw error
    throw new Error(parseErrorMessage('code.host', syntaxErrorContext(error)))
  }
}
