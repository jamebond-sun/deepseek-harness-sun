/**
 * 形似 `claude-code/testing` 的测试套件：加载 mod、注册在各 mod 之下代替引擎
 * 应答的桩、经由 mod 的钩子触发事件，并挂载一个表面来断言某个 mod 绘制了什么 ——
 * 不涉及会话、代理或任何 harness 服务。本仓库的测试装置把它包装成
 * `claude-code/testing`，供示例 mod 自身的测试使用。
 * @module
 */

import type { LoadedMod, RegisteredHook } from './chain.ts'
import type { ModPlugin } from './define-mod.ts'
import { findAll, renderText, treeProblem } from './elements.ts'
import type { TreePattern, UiElement, UiNode } from './elements.ts'
import { ModsEngine, OpDenied } from './engine.ts'
import type { OpCore } from './engine.ts'
import type {
  CommandRunInput, CommandRunResult, ModDefinition, ModsApi, PromptSubmitInput, PromptSubmitResult,
  SessionEndInput, SessionEndResult, SessionStartInput, SessionStartResult, ToolCallInput, ToolCallResult,
  TurnCompleteInput, TurnCompleteResult, TurnStartInput, TurnStartResult, UiRenderInput,
} from './types.ts'

/**
 * 代替引擎应答单个事件的桩。对于引擎事件它返回该事件的结果；对于 mods API
 * 调用它返回 `{ value }` 或 `{ deny }`，二者均返回 `undefined` 时读作"未应答"。
 */
export type StubHook = ($: ModsApi, e: never) => unknown

/** 测试套件的构造选项。 */
export interface ModTestKitOptions {
  /** 要加载的 mod，按链接顺序：可以是定义，也可以是 `defineMod` 制作的插件。 */
  readonly mods?: readonly (ModDefinition | ModPlugin)[]
  /** 按插件名的 `register` 选项值，叠加在每个 mod 各自的选项之上。 */
  readonly options?: Readonly<Record<string, ModDefinition['options']>>
  /** 钩子自身的运行时间上限，单位毫秒；默认为 5 秒，即 Claude Code 的测试上限。 */
  readonly budgetMs?: number
}

/** `$.ui.mount` 所接收的内容：要绘制的表面，以及宿主会传入的 props。 */
export interface MountArgs {
  /** 受测插件；为源码兼容而保留，每个已加载 mod 的 `ui.render` 钩子都按链接顺序运行。 */
  readonly plugin?: string
  /** 绘制表面的名称（`terminal`、`desktop`）；为源码兼容而保留。 */
  readonly surface?: string
  readonly component: UiRenderInput['component']
  /** `Pane` 被打开时使用的窗格 id；横幅没有此值。 */
  readonly requestId?: string
  readonly props?: Readonly<Record<string, unknown>>
}

/** 一个被找到的元素，以及测试可对其施加的动作。 */
export interface MountedElement {
  readonly element: UiElement
  /** 元素的类型。 */
  readonly type: UiElement['type']
  /** 元素绘制的文本，包含其后代。 */
  readonly text: string
  /** 运行 Button 的 `onPress` 并重绘。 */
  press(): Promise<void>
}

/** 一个已挂载的表面：每次读取都经由 mod 的 `ui.render` 钩子重新渲染。 */
export interface MountedSurface {
  /** 当前的树，即钩子返回的结果。 */
  tree(): Promise<UiNode>
  /** 绘制的文本，每个顶层节点一行。 */
  text(): Promise<string>
  /** 第一个匹配模式的元素，或 undefined。 */
  find(pattern: TreePattern): Promise<MountedElement | undefined>
  /** 所有匹配模式的元素，按绘制顺序。 */
  findAll(pattern: TreePattern): Promise<MountedElement[]>
  unmount(): Promise<void>
}

/** 引擎自身 `$` 形态的触发函数：每一个都把事件经 mod 送出，并解析为结果。 */
export interface TestKitRaisers {
  readonly tool: { call(input: Omit<ToolCallInput, 'tool_use_id'> & { tool_use_id?: string }): Promise<ToolCallResult> }
  readonly command: { run(input: Pick<CommandRunInput, 'command' | 'args'>): Promise<CommandRunResult> }
  readonly prompt: { submit(input: Pick<PromptSubmitInput, 'text'> & Partial<PromptSubmitInput>): Promise<PromptSubmitResult> }
  readonly session: {
    start(input?: Partial<SessionStartInput>): Promise<SessionStartResult>
    end(input?: Partial<SessionEndInput>): Promise<SessionEndResult>
  }
  readonly turn: {
    start(input: Partial<TurnStartInput> & Pick<TurnStartInput, 'turnId'>): Promise<TurnStartResult>
    complete(input?: Partial<TurnCompleteInput>): Promise<TurnCompleteResult>
  }
  readonly ui: {
    /** 挂载一个表面：每次读取都经由 mod 的 `ui.render` 钩子渲染。 */
    mount(args: MountArgs): Promise<MountedSurface>
  }
}

/** 该套件触发的引擎事件及其输入，使类型化桩无需转型即可读取 `e`。 */
export interface KitEventInputs {
  'session.start': SessionStartInput
  'session.end': SessionEndInput
  'turn.start': TurnStartInput
  'turn.complete': TurnCompleteInput
  'prompt.submit': PromptSubmitInput
  'tool.call': ToolCallInput
  'command.run': CommandRunInput
  'ui.render': UiRenderInput
}

/** 套件的 `on`：注册一个在各 mod 之下应答单个事件的桩；命名 mods API 调用时省略 `$.`。 */
export interface KitOn {
  /** 针对单个引擎事件的桩，带有该事件的类型化输入。 */
  <K extends keyof KitEventInputs>(event: K, stub: ($: ModsApi, e: KitEventInputs[K]) => unknown): void
  /** 针对任意事件或 mods API 调用的桩。 */
  (event: string, stub: StubHook): void
}

/** 一个已加载的测试套件。 */
export interface ModTestKit {
  /** 注册一个在各 mod 之下应答 `event` 的桩；命名 mods API 调用时省略 `$.`。 */
  readonly on: KitOn
  /** 经 mod 触发任意事件；最底层由桩、内置默认值，或 `no implementation for <event>` 应答。 */
  raise<R>(event: string, input: unknown): Promise<R>
  /** 本桥接从 harness 送出的各事件的类型化触发函数，外加 `ui.mount`。 */
  readonly $: TestKitRaisers
  /** 引擎上报的诊断行：被跳过的钩子、失败的即发即弃调用、定时器错误。 */
  readonly reports: string[]
  /** 按链接顺序的已加载 mod。 */
  readonly mods: readonly LoadedMod[]
  /**
   * 丢弃所有注册并关闭所有 mod 定时器。
   * @returns 运行中的定时器回调完成后结束。
   */
  dispose(): Promise<void>
}

/** 从内存中应答整个命名空间的桩。 */
export const mock = Object.freeze({
  /**
   * 从一个内存映射中应答 `$.store`。
   * @param on - 套件的 `on`。
   * @param initial - 存储起步时带有的条目。
   * @returns 实时映射，可读取 mod 保存的内容。
   */
  store(on: ModTestKit['on'], initial: Readonly<Record<string, unknown>> = {}): Map<string, unknown> {
    const saved = new Map(Object.entries(initial))
    on('store.get', (_$, e: { key: string }) => ({ value: saved.get(e.key) }))
    on('store.set', (_$, e: { key: string; value: unknown }) => {
      saved.set(e.key, e.value)
      return { value: undefined }
    })
    on('store.delete', (_$, e: { key: string }) => {
      saved.delete(e.key)
      return { value: undefined }
    })
    on('store.keys', () => ({ value: [...saved.keys()] }))
    return saved
  },
  /**
   * 从固定变量中应答 `$.env.get`，并记录 `$.env.set` 的写入。
   * @param on - 套件的 `on`。
   * @param variables - mod 所见的环境。
   * @returns 实时记录，可读取 mod 设置的内容。
   */
  env(on: ModTestKit['on'], variables: Readonly<Record<string, string>> = {}): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...variables }
    on('env.get', (_$, e: { name: string }) => ({ value: env[e.name] }))
    on('env.set', (_$, e: { name: string; value?: string }) => {
      env[e.name] = e.value
      return { value: undefined }
    })
    return env
  },
  /**
   * 从一个可设置的瞬时应答 `$.clock.now`，并立即应答 `$.clock.sleep`，同时推进它。
   * @param on - 套件的 `on`。
   * @param startAt - 第一个 `now()`，为纪元毫秒。
   * @returns 时钟，可读取或推进 `now`。
   */
  clock(on: ModTestKit['on'], startAt = 0): { now: number; advance(ms: number): void } {
    const clock = {
      now: startAt,
      advance(ms: number): void { clock.now += ms },
    }
    on('clock.now', () => ({ value: clock.now }))
    on('clock.sleep', (_$, e: { ms: number }) => {
      clock.now += e.ms
      return { value: undefined }
    })
    return clock
  },
})

/** 未注册桩时，默认答案与 Claude Code 测试套件表格相符的引擎事件。 */
const DEFAULT_ENGINE_ANSWERS: Readonly<Record<string, (e: never) => unknown>> = {
  'session.start': (e: SessionStartInput) => ({ cwd: e.cwd }),
  'session.end': (e: SessionEndInput) => ({ sessionId: e.sessionId }),
  'turn.start': (e: TurnStartInput) => ({ turnId: e.turnId }),
  'turn.complete': () => ({ text: '' }),
  'prompt.submit': (e: PromptSubmitInput) => ({ text: e.text, ...e.context === undefined ? {} : { context: e.context } }),
  'command.run': () => ({}),
  'ui.render': () => null,
}

/** 套件自身应答的 mods API 调用，如同 Claude Code 的套件那样。 */
const DEFAULT_OP_ANSWERS: Readonly<Record<string, StubHook>> = {
  'ui.invalidate': () => ({ value: undefined }),
  'ui.open': (_$, e: { id: string }) => ({ value: { id: e.id, isPlaced: false } }),
  'ui.close': () => ({ value: undefined }),
}

function definitionOf(mod: ModDefinition | ModPlugin): ModDefinition {
  return 'definition' in mod ? mod.definition : mod
}

/**
 * 为测试加载 mod 并返回套件。
 * @param options - 要加载的 mod 与钩子时间上限。
 * @returns 套件，其中每个 mod 的 `register` 都已运行。
 */
export async function createModTestKit(options: ModTestKitOptions = {}): Promise<ModTestKit> {
  const reports: string[] = []
  const stubs = new Map<string, StubHook>()
  const engine = new ModsEngine<Record<never, never>>({
    ops: (op) => {
      const stub = stubs.get(op) ?? DEFAULT_OP_ANSWERS[op]
      return stub === undefined ? undefined : opStub(op, stub)
    },
    stateKey: () => 'test',
    budgetMs: options.budgetMs ?? 5_000,
    catchBudgetMs: 1_000,
    report: (line) => { reports.push(line) },
  })
  const kitMod: LoadedMod = Object.freeze({
    name: 'claude-code-testing', version: undefined, root: process.cwd(), options: Object.freeze({}), order: Number.MAX_SAFE_INTEGER,
  })
  const binding = {}
  const signal = new AbortController().signal

  function opStub(op: string, stub: StubHook): OpCore<Record<never, never>> {
    return async (input) => {
      const answer = await stub(engine.api(kitMod, undefined, binding, signal), input as never)
      if (typeof answer !== 'object' || answer === null) throw new Error(`${op}: a stub returned neither { value } nor { deny }`)
      const result = answer as { value?: unknown; deny?: unknown }
      if (typeof result.deny === 'string') throw new OpDenied(result.deny)
      if (!('value' in result)) throw new Error(`${op}: a stub returned neither { value } nor { deny }`)
      return result.value
    }
  }

  for (const entry of options.mods ?? []) {
    const definition = definitionOf(entry)
    await engine.add({ ...definition, options: { ...definition.options, ...options.options?.[definition.name] } })
  }

  function raise<R>(event: string, input: unknown): Promise<R> {
    return engine.raise<unknown, R>(event, input, async (e) => {
      const stub = stubs.get(event)
      if (stub !== undefined) {
        const answer = await stub(engine.api(kitMod, undefined, binding, signal), e as never)
        if (typeof answer !== 'object' || answer === null) throw new Error(`${event}: the stub returned no result`)
        return answer as R
      }
      const fallback = DEFAULT_ENGINE_ANSWERS[event]
      if (fallback === undefined) throw new Error(`no implementation for ${event}`)
      return fallback(e as never) as R
    }, { binding, signal })
  }

  let calls = 0
  const mounted = new Set<string>()

  async function render(args: MountArgs): Promise<UiNode> {
    const props = args.props ?? {}
    const columns = typeof props['bodyColumns'] === 'number' ? props['bodyColumns'] : 80
    const input: UiRenderInput = {
      component: args.component,
      surface: args.requestId ?? args.component,
      ...args.requestId === undefined ? {} : { requestId: args.requestId },
      props,
      viewport: { columns },
    }
    const tree = await raise<UiNode>('ui.render', input)
    const problem = treeProblem(tree)
    if (problem !== undefined) throw new Error(`ui.render returned a tree that does not validate: ${problem}`)
    return tree
  }

  function mountedElement(element: UiElement, redraw: () => Promise<UiNode>): MountedElement {
    return {
      element,
      type: element.type,
      text: renderText(element),
      async press(): Promise<void> {
        const onPress = element.props['onPress']
        if (element.type !== 'Button' || typeof onPress !== 'function') throw new Error(`press() needs a Button with onPress, not a ${element.type}`)
        await (onPress as () => unknown)()
        await redraw()
      },
    }
  }

  return {
    on: (event: string, stub: StubHook): void => {
      stubs.set(event, stub)
    },
    raise,
    $: {
      tool: {
        call: input => raise<ToolCallResult>('tool.call', { tool_use_id: `test-${++calls}`, ...input }),
      },
      command: {
        run: input => raise<CommandRunResult>('command.run', { ...input, origin: { kind: 'composer' } }),
      },
      prompt: {
        submit: input => raise<PromptSubmitResult>('prompt.submit', { wait: false, origin: { kind: 'composer' }, ...input }),
      },
      session: {
        start: (input = {}) => raise<SessionStartResult>('session.start', { cwd: process.cwd(), surface: null, isInteractive: true, ...input }),
        end: (input = {}) => raise<SessionEndResult>('session.end', { reason: 'other', sessionId: 'test', ...input }),
      },
      turn: {
        start: input => raise<TurnStartResult>('turn.start', { text: '', ...input }),
        complete: (input = {}) => raise<TurnCompleteResult>('turn.complete', {
          turnId: '1', answer: '', durationMs: 0, isAborted: false, reason: 'answer', ...input,
        }),
      },
      ui: {
        mount: async (args) => {
          const key = args.requestId ?? args.component
          if (mounted.has(key)) throw new Error(`surface ${key} is already mounted`)
          mounted.add(key)
          const redraw = (): Promise<UiNode> => render(args)
          await redraw()
          return {
            tree: redraw,
            text: async () => renderText(await redraw()),
            find: async pattern => findAll(await redraw(), pattern).map(element => mountedElement(element, redraw))[0],
            findAll: async pattern => findAll(await redraw(), pattern).map(element => mountedElement(element, redraw)),
            unmount: () => {
              mounted.delete(key)
              return Promise.resolve()
            },
          }
        },
      },
    },
    reports,
    get mods() {
      return engine.registry.list()
    },
    dispose() {
      return engine.dispose()
    },
  }
}

export type { RegisteredHook }
