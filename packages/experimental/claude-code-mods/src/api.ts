/**
 * 某个钩子所收到的 `$`。每个方法把它的参数塑造成同名的 mods API
 * 事件，并交给绑定的 `invoke`，后者会先运行在本 mod 之前加载的 mods，
 * 再运行引擎的实现。该钩子运行时间的时钟在一次调用被 await 期间暂停，
 * 但 `$.clock.sleep` 除外，Claude Code 将其算作该钩子自身的时间。
 * @module
 */

import { uiElements } from './elements.ts'
import type { BudgetClock, LoadedMod } from './chain.ts'
import { messageOf } from './values.ts'
import type {
  AskOptions, CommandInfo, CommandRunResult, CommandSpec, FsEntry, FsStat, HttpInit, HttpResponse, ModsApi, PaneOpenArgs,
  PaneOpenResult, ProcessRunInit, ProcessRunResult, PromptSubmitArgs, SessionMessage, SessionUsage, SessionVersion,
  StateRef, ModTimer, ToastOptions, ToolCallResult, ToolInfo, ToolSpec, UiLogOptions,
} from './types.ts'

/** 引擎代表某个 mod 所拥有的定时器，以便处置与重新加载时能够取消它们。 */
export interface TimerHost {
  after(ms: number, fn: () => unknown): ModTimer
  every(ms: number, fn: () => unknown): ModTimer
}

/** 某一个 `$` 实例所绑定到的内容。 */
export interface ApiBinding {
  readonly mod: LoadedMod
  /** 运行中的钩子的时钟，在 mods API 调用被 await 期间暂停；在钩子之外时缺失。 */
  readonly clock: BudgetClock | undefined
  /**
   * 将一次 mods API 调用作为同名事件抛出，并解析为链所应答的值；
   * 一次 `{ deny }` 应答会以该理由拒却。
   */
  readonly invoke: (op: string, input: unknown) => Promise<unknown>
  readonly timers: TimerHost
  /** 接收一次“触发即忘”调用被拒却时的理由。 */
  readonly report: (line: string) => void
}

/**
 * 为一次钩子调用构建 `$`。
 * @param binding - 本实例所用的 mod、时钟，以及引擎入口点。
 * @returns mods API。
 */
export function createModsApi(binding: ApiBinding): ModsApi {
  const { mod, clock, timers } = binding

  async function call<T>(op: string, input: unknown): Promise<T> {
    clock?.pause()
    try {
      return await binding.invoke(op, input) as T
    } finally {
      clock?.resume()
    }
  }

  function fire(op: string, input: unknown): void {
    call(op, input).catch((error: unknown) => {
      binding.report(`${mod.name}: $.${op} failed: ${messageOf(error)}`)
    })
  }

  // 未被冻结：下面的代理会返回一个被包装的命名空间，而冻结目标的不变式会禁止这一点。
  const served: ModsApi = {
    plugin: Object.freeze({ name: mod.name, root: mod.root }),
    ui: Object.freeze({
      log(text: string, options?: UiLogOptions): void {
        fire('ui.log', { text, to: options?.to ?? 'transcript' })
      },
      toast(text: string, options?: ToastOptions): void {
        fire('ui.toast', { text, ...options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs } })
      },
      status(text: string | undefined): void {
        fire('ui.status', { text })
      },
      invalidate(event: string): void {
        fire('ui.invalidate', { event })
      },
      open(pane: PaneOpenArgs): Promise<PaneOpenResult> {
        return call('ui.open', pane)
      },
      close(pane: { id: string }): Promise<void> {
        return call('ui.close', { id: pane.id, origin: 'plugin' })
      },
      panes(): Promise<never[]> {
        return call('ui.panes', {})
      },
      ask(question: string, options?: readonly string[] | AskOptions): Promise<string> {
        const normalized: AskOptions = Array.isArray(options) ? { options } : options as AskOptions | undefined ?? {}
        return call('ui.ask', { question, ...normalized })
      },
      resolve: () => uiElements(),
    }),
    command: Object.freeze({
      register(command: CommandSpec): Promise<void> {
        return call('command.register', command)
      },
      run(input: { command: string; args?: string }): Promise<CommandRunResult> {
        return call('command.run', { command: input.command, args: input.args ?? '' })
      },
      list(): Promise<CommandInfo[]> {
        return call('command.list', {})
      },
    }),
    tool: Object.freeze({
      register(tool: ToolSpec): Promise<void> {
        return call('tool.register', tool)
      },
      call(input: { tool: string; [argument: string]: unknown }): Promise<ToolCallResult> {
        return call('tool.call', input)
      },
      list(): Promise<ToolInfo[]> {
        return call('tool.list', {})
      },
    }),
    prompt: Object.freeze({
      submit(input: PromptSubmitArgs): Promise<{ text: string }> {
        return call('prompt.submit', { text: input.text, asUser: input.asUser === true })
      },
    }),
    session: Object.freeze({
      id: (): Promise<string> => call('session.id', {}),
      cwd: (): Promise<string> => call('session.cwd', {}),
      root: (): Promise<string> => call('session.root', {}),
      model: (): Promise<string> => call('session.model', {}),
      turns: (): Promise<number> => call('session.turns', {}),
      messages: (): Promise<SessionMessage[]> => call('session.messages', {}),
      usage: (): Promise<SessionUsage> => call('session.usage', {}),
      version: (): Promise<SessionVersion> => call('session.version', {}),
    }),
    state: Object.freeze({
      get(ref: StateRef): Promise<{ value: unknown }> {
        return call('state.get', { plugin: ref.plugin, key: ref.key })
      },
      set(ref: StateRef, value: unknown): Promise<void> {
        return call('state.set', { plugin: ref.plugin, key: ref.key, value })
      },
    }),
    store: Object.freeze({
      get: (key: string): Promise<unknown> => call('store.get', { key }),
      set: (key: string, value: unknown): Promise<void> => call('store.set', { key, value }),
      delete: (key: string): Promise<void> => call('store.delete', { key }),
      keys: (): Promise<string[]> => call('store.keys', {}),
    }),
    clock: Object.freeze({
      now: (): Promise<number> => call('clock.now', {}),
      // 被算作该钩子自身的时间，因此时钟不会暂停。
      sleep: (ms: number): Promise<void> => binding.invoke('clock.sleep', { ms }) as Promise<void>,
      after: (ms: number, fn: () => unknown): ModTimer => timers.after(ms, fn),
      every: (ms: number, fn: () => unknown): ModTimer => timers.every(ms, fn),
    }),
    fs: Object.freeze({
      read: (path: string): Promise<string> => call('fs.read', { path, as: 'text' }),
      write: (path: string, text: string): Promise<void> => call('fs.write', { path, text }),
      list: (path?: string): Promise<FsEntry[]> => call('fs.list', { path: path ?? '.' }),
      exists: (path: string): Promise<boolean> => call('fs.exists', { path }),
      stat: (path: string): Promise<FsStat> => call('fs.stat', { path, resolve: true }),
    }),
    process: Object.freeze({
      run(argv: readonly string[], init?: ProcessRunInit): Promise<ProcessRunResult> {
        return call('process.run', { argv, ...init === undefined ? {} : { init } })
      },
    }),
    http: Object.freeze({
      fetch(url: string, init?: HttpInit): Promise<HttpResponse> {
        return call('http.fetch', { url, ...init === undefined ? {} : { init } })
      },
    }),
    env: Object.freeze({
      get: (name: string): Promise<string | undefined> => call('env.get', { name }),
      set: (name: string, value: string | undefined): Promise<void> => call('env.set', { name, ...value === undefined ? {} : { value } }),
    }),
  }
  return withUnservedMembers(served, mod.name)
}

/** Claude Code 的 `$` 所具有的各个方法命名空间；`plugin` 持有事实而非方法，因此保持原样提供。 */
const METHOD_NAMESPACES: ReadonlySet<string> = new Set([
  'ui', 'command', 'tool', 'prompt', 'session', 'state', 'store', 'clock', 'fs', 'process', 'http', 'env',
  'model', 'agent', 'config', 'settings', 'mcp', 'audio', 'telemetry', 'turn',
])

/**
 * 赋予 `$` 以 Claude Code 完整的命名空间集合：已提供的成员即其自身；方法命名空间下的
 * 任何其他成员都是一个函数，其调用会以 `no implementation for <namespace>.<member>`
 * 拒却，因此一个越过了本宿主的 mod 会以被点名的缺口失败，而非抛出一个 TypeError。
 * @param served - 已提供命名空间的、被冻结的对象。
 * @param modName - 该 `$` 所隶属的 mod，用于拒却文本。
 * @returns 某个钩子所收到的 `$`。
 */
function withUnservedMembers(served: ModsApi, modName: string): ModsApi {
  const namespaces = new Map<string, object>()
  const namespaceOf = (name: string, base: object): object => {
    let wrapped = namespaces.get(name)
    if (wrapped === undefined) {
      wrapped = new Proxy(base, {
        get(target, member, receiver) {
          const own: unknown = Reflect.get(target, member, receiver)
          if (own !== undefined || typeof member !== 'string' || member === 'then') return own
          return () => Promise.reject(new Error(`${modName}: no implementation for ${name}.${member}`))
        },
      })
      namespaces.set(name, wrapped)
    }
    return wrapped
  }
  return new Proxy(served, {
    get(target, namespace, receiver) {
      const own: unknown = Reflect.get(target, namespace, receiver)
      if (typeof namespace !== 'string' || !METHOD_NAMESPACES.has(namespace)) return own
      return namespaceOf(namespace, typeof own === 'object' && own !== null ? own : Object.freeze({}))
    },
    // `$` 是只读的，正如被冻结的对象那样。
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
  })
}
