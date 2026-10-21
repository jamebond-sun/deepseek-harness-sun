/**
 * 面向 mod 的类型：钩子模块契约（`register`、`on`、钩子、`next`），本桥接触发的
 * 事件输入与结果，以及它所提供的 `$` mods API 子集。字段名沿用 Claude Code 的
 * 声明，使未经修改的 mod 能针对相同名称通过类型检查；只声明本桥接实现的成员。
 * @module
 */

import type { UiElements, UiNode } from './elements.ts'

/** 插件清单的 `userConfig` 字段与 `register(on, options)` 所携带的值。 */
export type PluginOptionValue = string | number | boolean | readonly string[]

/** `register` 的 `options` 参数：由部署值叠加在清单 `userConfig` 默认值之上。 */
export type PluginOptions = Readonly<Record<string, PluginOptionValue>>

/** mod 运行的层级；本桥接以 `user` 加载每个 mod，其自身引擎行为为 `core`。 */
export type ModTier = 'prepend' | 'user' | 'append' | 'builtin' | 'core'

/** 事件的触发者：引擎自身，或那个 `$` 调用成为该事件的 mod。 */
export interface HookOrigin {
  readonly plugin: string
  readonly tier: ModTier
}

/** 失败钩子的错误，供 `.catch` 处理器在 `next.error` 上查看。 */
export interface HookFailure {
  readonly kind: 'throw' | 'timeout'
  readonly message: string
}

/** 钩子自身的运行时间上限：总上限与当前剩余。 */
export interface HookBudget {
  readonly ms: number
  readonly remainingMs: number
}

/**
 * 每个钩子都会收到的 `next` 处理器：调用它会运行其下方的钩子，再运行引擎行为，
 * 并解析为该事件的结果。等待它时所花的时间不计入钩子的时间预算。
 */
export interface HookNext<E, R> {
  (e: E): Promise<R>
  /** 事件被放弃时（所属代理取消）触发。 */
  readonly signal: AbortSignal
  /** 事件的触发者。 */
  readonly origin: HookOrigin
  /** 钩子的运行时间上限。 */
  readonly budget: HookBudget
  /** 跳过层级是受管设置特性，本桥接未实现；总是抛出。 */
  to(e: E, tier: ModTier): Promise<R>
  /** 在 `.catch` 处理器中：钩子如何失败。 */
  readonly error?: HookFailure
  /** 在 `.catch` 处理器中：失败的钩子是否已调用过 `next`。 */
  readonly called?: boolean
}

/** 单个事件的钩子：mods API、冻结的事件输入，以及 next 处理器。 */
export type ModHook<E, R> = ($: ModsApi, e: E, next: HookNext<E, R>) => R | Promise<R>

/** 事件与结果不被注册表收窄的钩子。 */
export type AnyHook = ModHook<unknown, unknown>

/** `on` 的返回值：`.catch` 用于挂载钩子的错误处理器。 */
export interface HookRegistration {
  catch(handler: AnyHook): void
}

/** 匹配字段：单个值、一组允许的值，或正则表达式。 */
export type MatcherValue = string | number | boolean | null | RegExp | readonly (string | number | boolean | null)[]

/** `on` 的可选第二个参数：钩子要求的最顶层事件字段。 */
export type HookMatcher = Readonly<Record<string, MatcherValue>>

/** 本宿主触发的引擎事件，含其输入与结果，使类型化钩子无需转型即可读取 `e`。 */
export interface ModEvents {
  'session.start': { input: SessionStartInput; result: SessionStartResult }
  'session.end': { input: SessionEndInput; result: SessionEndResult }
  'prompt.submit': { input: PromptSubmitInput; result: PromptSubmitResult }
  'turn.start': { input: TurnStartInput; result: TurnStartResult }
  'turn.complete': { input: TurnCompleteInput; result: TurnCompleteResult }
  'tool.call': { input: ToolCallInput; result: ToolCallResult }
  'command.run': { input: CommandRunInput; result: CommandRunResult }
  'ui.render': { input: UiRenderInput; result: UiRenderResult }
}

/** `register` 收到的 `on` 函数：对本宿主触发的事件有类型，对其它任意 Claude Code 事件开放。 */
export interface ModOn {
  <K extends keyof ModEvents>(event: K, hook: ModHook<ModEvents[K]['input'], ModEvents[K]['result']>): HookRegistration
  <K extends keyof ModEvents>(event: K, matcher: HookMatcher, hook: ModHook<ModEvents[K]['input'], ModEvents[K]['result']>): HookRegistration
  (event: string, hook: AnyHook): HookRegistration
  (event: string, matcher: HookMatcher, hook: AnyHook): HookRegistration
}

/** 一个钩子模块导出的函数。 */
export type ModRegister = (on: ModOn, options: PluginOptions) => unknown

/**
 * 一个 mod 作为 DSH 插件交给桥接时的形态：Claude Code 从 `plugin.json` 读取的
 * 插件标识、其钩子模块导出的 `register`，以及 `register` 收到的 `options`
 * （即经过校验的 mod 插件配置）。
 */
export interface ModDefinition {
  /** 插件名：字母、数字、`_` 与 `-`；作为 `$.state` 引用的 `plugin`，以及 `mcp__<plugin>__` 工具前缀。 */
  readonly name: string
  readonly version?: string
  /** mod 所在的绝对目录，即 `$.plugin.root` 所报告的；默认为进程 cwd。 */
  readonly root?: string
  readonly options?: PluginOptions
  readonly register: ModRegister
}

// ---- 绘制出的表面，即 Client 收到的形态 ----

/** 序列化后的元素：回调被宿主所持有的 action id 替代。 */
export interface SerializedElement {
  readonly type: 'Box' | 'Text' | 'Button'
  readonly props: Readonly<Record<string, string | number | boolean>>
  readonly children: readonly SerializedNode[]
  /** 设置在 `Button` 上，其 `onPress` 由宿主持有。 */
  readonly actionId?: string
}

/** 一个序列化的树节点：元素或一段连续文本。 */
export type SerializedNode = SerializedElement | string

/** 一次会话在提示词上方横幅的一代绘制。 */
export interface SurfaceSnapshot {
  /** 每次重绘递增；一次按下会指明它所见到的代。 */
  readonly generation: number
  /** 序列化树；当没有 mod 绘制时为 null。 */
  readonly tree: readonly SerializedNode[] | null
}

// ---- 事件输入与结果 ----

/** `ui.render`：宿主请求 mod 绘制一个表面；第一个返回树的钩子绘制它。 */
export interface UiRenderInput {
  /** 正在绘制的表面：提示词上方的横幅，或 mod 打开的窗格。 */
  component: 'AbovePrompt' | 'Pane'
  /** 稳定的表面实例 id：窗格 id，或横幅所用的组件名。 */
  surface: string
  /** mod 在 `$.ui.open` 中选择的窗格 id，出现在 `Pane` 上。 */
  requestId?: string
  /** 表面自有的 props：横幅上的 `bodyColumns`、`hasSurvey`、`isWorking`、`maxRows`。 */
  props: Readonly<Record<string, unknown>>
  /** 宿主所知的可用绘制尺寸。 */
  viewport: { readonly columns: number; readonly rows?: number }
}

/** `ui.render` 结果：要绘制的树；`next(e)` 把表面交给下一个 mod，最终交给不绘制任何内容的宿主。 */
export type UiRenderResult = UiNode

/** 提示词或命令的来源。 */
export type PromptOrigin =
  | { kind: 'composer' }
  | { kind: 'plugin'; name: string }

/** `session.start`：每个根代理在其首个提示词之前各触发一次；每个已加载 mod 的钩子都见到同一事件。 */
export interface SessionStartInput {
  cwd: string
  /** 绘制表面的名称（Claude Code：`terminal`、`desktop`）；当没有表面绘制 mod 时本宿主报告 `null`。 */
  surface: string | null
  /** 是否组合了一个人类应答者，以便 `$.ui.ask` 能够解析。 */
  isInteractive: boolean
}

/** `session.start` 的结果。 */
export interface SessionStartResult {
  cwd: string
}

/** `session.end`：代理被释放。 */
export interface SessionEndInput {
  reason: 'clear' | 'logout' | 'prompt_input_exit' | 'resume' | 'other'
  sessionId: string
}

/** `session.end` 的结果。 */
export interface SessionEndResult {
  sessionId: string
}

/** `prompt.submit`：一条提示词即将进入一轮。 */
export interface PromptSubmitInput {
  text: string
  /** 只有模型读取、追加在提示词之后的额外文本。 */
  context?: readonly string[]
  turnId?: string
  wait: boolean
  origin: PromptOrigin
}

/** `prompt.submit` 的结果：进入的文本，或带原因的丢弃。 */
export type PromptSubmitResult =
  | { text: string; context?: readonly string[]; drop?: undefined }
  | { drop: string; text?: undefined; context?: undefined }

/** `turn.start`：一轮以该提示词文本开始。 */
export interface TurnStartInput {
  text: string
  turnId: string
  agentId?: string
}

/** `turn.start` 的结果。 */
export interface TurnStartResult {
  turnId: string
}

/** 一轮的 token 总量，使用 Claude Code 的 API 词汇。 */
export interface TurnUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  model: string
}

/** `turn.complete`：一轮已结束。 */
export interface TurnCompleteInput {
  turnId: string
  answer: string
  durationMs: number
  isAborted: boolean
  reason: 'answer' | 'aborted' | 'error'
  agentId?: string
  usage?: TurnUsage
}

/** `turn.complete` 的结果：`text` 作为答案下方的一行显示。 */
export interface TurnCompleteResult {
  text: string
}

/** `tool.call`：以顶层字段给出工具名与参数。 */
export interface ToolCallInput {
  tool: string
  tool_use_id: string
  agentId?: string
  [argument: string]: unknown
}

/** `tool.call` 的结果：拒绝，或工具的结果。 */
export type ToolCallResult =
  | { deny: string; result?: undefined; isError?: undefined }
  | { result: unknown; isError?: true; deny?: undefined }

/** `command.run`：一个已注册的命令被键入。 */
export interface CommandRunInput {
  command: string
  /** 命令名之后键入的文本，或空字符串。 */
  args: string
  origin: PromptOrigin
}

/** `command.run` 的结果：`text` 打印进记录；`{}` 不打印任何内容。 */
export interface CommandRunResult {
  text?: string
}

/** 一次 mods API 调用作为事件的结果：值，或拒绝。 */
export type OpResult = { value: unknown; deny?: undefined } | { deny: string; value?: undefined }

// ---- mods API（`$`） ----

/** 一个 mod 为用户注册的命令。 */
export interface CommandSpec {
  name: string
  description: string
  argumentHint?: string
  immediate?: true
}

/** 生效列表中的一个命令。 */
export interface CommandInfo {
  name: string
  description: string
  source: 'builtin' | 'plugin' | 'user' | 'mcp'
  plugin?: string
}

/** 一个 mod 为模型注册的工具。 */
export interface ToolSpec {
  name: string
  description: string
  inputSchema?: Record<string, unknown>
}

/** 生效列表中的一个工具。 */
export interface ToolInfo {
  name: string
  description: string
}

/** 记录中的一条消息，即 `$.session.messages()` 返回的内容。 */
export interface SessionMessage {
  role: 'user' | 'assistant'
  text: string
  toolUses: ToolUseSummary[]
}

/** 助手消息内部的一次工具调用。 */
export interface ToolUseSummary {
  tool_use_id: string
  tool: string
  input: Record<string, unknown>
}

/** 上下文窗口占用与计划上限。 */
export interface SessionUsage {
  startedAt: number
  context: { tokens?: number; window: number; percent?: number }
  rateLimits: never[]
}

/** 桥接所报告的 mods API 版本。 */
export interface SessionVersion {
  version: string
  engine: 'deepseek-harness'
}

/** `$.ui.ask` 选项。 */
export interface AskOptions {
  options?: readonly string[]
  header?: string
  multiSelect?: true
}

/** `$.ui.log` 的写入位置。 */
export interface UiLogOptions {
  to?: 'transcript' | 'debug'
}

/** `$.ui.toast` 选项。 */
export interface ToastOptions {
  timeoutMs?: number
}

/** `$.ui.open` 参数。 */
export interface PaneOpenArgs {
  id: string
  title?: string
  focus?: true
  closeOnEscape?: true
  holdToasts?: true
  rows?: number
  columns?: number
}

/** `$.ui.open` 结果：本桥接不放置任何窗格。 */
export interface PaneOpenResult {
  /** mod 选择的窗格 id。 */
  id: string
  isPlaced: boolean
  reason?: string
}

/** 一个 `$.state` 值引用。 */
export interface StateRef {
  plugin: string
  key: string
}

/** `$.clock.after` 与 `$.clock.every` 返回的定时器。 */
export interface ModTimer {
  cancel(): void
}

/** `$.fs.list` 返回的一个文件条目。 */
export interface FsEntry {
  name: string
  kind: 'file' | 'dir' | 'other'
  size: number
  isLink: boolean
}

/** `$.fs.stat` 结果。 */
export interface FsStat {
  kind: 'file' | 'dir' | 'other'
  size: number
  mtimeMs: number
  isLink: boolean
}

/** `$.process.run` 选项。 */
export interface ProcessRunInit {
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
}

/** `$.process.run` 结果，无论退出码如何。 */
export interface ProcessRunResult {
  exitCode: number
  stdout: string
  stderr: string
}

/** `$.http.fetch` 选项。 */
export interface HttpInit {
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}

/** `$.http.fetch` 结果，在读取完响应体之后。 */
export interface HttpResponse {
  status: number
  ok: boolean
  headers: Record<string, string>
  text: string
}

/** `$.prompt.submit` 参数。 */
export interface PromptSubmitArgs {
  text: string
  /** 把文本作为用户自己的话发送，不带指明 mod 的句子。 */
  asUser?: boolean
}

/**
 * 钩子作为 `$` 收到的 mods API。除 `$.plugin` 与 `$.ui.resolve` 外，每个方法
 * 同时也是名为 `<namespace>.<method>` 的事件，链中更早的 mod 可以观察、改写或拒绝它。
 */
export interface ModsApi {
  readonly plugin: { readonly name: string; readonly root: string }
  readonly ui: {
    log(text: string, options?: UiLogOptions): void
    toast(text: string, options?: ToastOptions): void
    status(text: string | undefined): void
    invalidate(event: string): void
    open(pane: PaneOpenArgs): Promise<PaneOpenResult>
    close(pane: { id: string }): Promise<void>
    panes(): Promise<never[]>
    ask(question: string, options?: readonly string[] | AskOptions): Promise<string>
    /** `ui.render` 事件所绘制表面的元素构造器；其本身不是事件。 */
    resolve(e: UiRenderInput): UiElements
  }
  readonly command: {
    register(command: CommandSpec): Promise<void>
    run(input: { command: string; args?: string }): Promise<CommandRunResult>
    list(): Promise<CommandInfo[]>
  }
  readonly tool: {
    register(tool: ToolSpec): Promise<void>
    call(input: { tool: string; [argument: string]: unknown }): Promise<ToolCallResult>
    list(): Promise<ToolInfo[]>
  }
  readonly prompt: {
    submit(input: PromptSubmitArgs): Promise<{ text: string }>
  }
  readonly session: {
    id(): Promise<string>
    cwd(): Promise<string>
    root(): Promise<string>
    model(): Promise<string>
    turns(): Promise<number>
    messages(): Promise<SessionMessage[]>
    usage(): Promise<SessionUsage>
    version(): Promise<SessionVersion>
  }
  readonly state: {
    get(ref: StateRef): Promise<{ value: unknown }>
    set(ref: StateRef, value: unknown): Promise<void>
  }
  readonly store: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
    delete(key: string): Promise<void>
    keys(): Promise<string[]>
  }
  readonly clock: {
    now(): Promise<number>
    sleep(ms: number): Promise<void>
    after(ms: number, fn: () => unknown): ModTimer
    every(ms: number, fn: () => unknown): ModTimer
  }
  readonly fs: {
    read(path: string): Promise<string>
    write(path: string, text: string): Promise<void>
    list(path?: string): Promise<FsEntry[]>
    exists(path: string): Promise<boolean>
    stat(path: string): Promise<FsStat>
  }
  readonly process: {
    run(argv: readonly string[], init?: ProcessRunInit): Promise<ProcessRunResult>
  }
  readonly http: {
    fetch(url: string, init?: HttpInit): Promise<HttpResponse>
  }
  readonly env: {
    get(name: string): Promise<string | undefined>
    set(name: string, value: string | undefined): Promise<void>
  }
}
