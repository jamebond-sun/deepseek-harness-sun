/**
 * 工具注册表、模型呈现模式，以及 pre/guard/around/post/result 执行管线。
 * @module @deepseek-ai/dsh-tools
 */

import type {} from '@deepseek-ai/dsh-working-directory'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AnonymousEntries, NamedEntries, ScopedLayers, scopeOf, scopeTarget } from '@deepseek-ai/dsh-scope'
import type { ScopeKey, ScopeLayer, Scoped } from '@deepseek-ai/dsh-scope'
import type { ToolCallId, ContentBlock, ToolSchema } from '@deepseek-ai/dsh-llm'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { assertNever, deepFreeze, snapshotJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import type { PromptSection, ToolProviderResult } from '@deepseek-ai/dsh-system-prompt'
import type { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
// 仅类型：让 `ctx.get('approval')` 解析到 ApprovalService 的类型扩充。
// 该接缝在运行期保持可选——见 `serviceAsk`。
import type {} from '@deepseek-ai/dsh-user-approval'
import type { ToolCallView, ToolResultView } from './presentation.ts'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from './json-schema.ts'
import type { JsonSchemaNode } from './json-schema.ts'
import { createRunCodeTool, RUN_CODE_NAME } from './ptc.ts'
import type { PtcSdkLanguage } from './ptc.ts'
import { renderToolsSdk } from './ts-types.ts'
import type { ToolSdkSchema } from './ts-types.ts'
import { renderToolsSdkPy } from './py-types.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** 由工具注册表提供的工具可用性变化。 */
    'tool-registry': { kind: 'tool-registry' }
  }
}

/**
 * 语言 → SDK 节渲染器。在非原生模式下组装 `tools:sdk` 节时，注册表以
 * 已加载的 `ctx.ptcRuntime.language` 在此表中查找；语言不是表键的运行期
 * 会让组装响亮失败（与 `toolOrder` 违规同一惯例）。新增一个后端语言需要
 * 三处并行修改——一个 {@link PtcSdkLanguage} 成员、本表的一个条目，以及
 * `ptc.ts` 中为其 `run_code` 模式字符串准备的 `RUN_CODE_FLAVORS` 条目
 * ——再加本表指向的渲染器函数。`satisfies` 子句把本表的键集固定到该联合，
 * 风味表同样受其检查，因此三处任缺其一都是类型检查失败。任何检查都够不
 * 到的是点名这些值而非推导它们的文字：接缝的 `dsh-ptc-runtime` README 对、
 * 其 `PtcRuntime.language` JSDoc、带中文对的
 * `docs/subsystems/ptc-runtime.md`，以及本包自己的 README 对与
 * {@link Config.mode} JSDoc。
 */
/**
 * 面向模型的 `ptc` 收拢声明。点名后果（调用失败）与路径（在程序内部），
 * 因为模型只能靠被拒绝才能发现的规则，是它纠正得太晚的规则。
 */
const PTC_ONLY_INSTRUCTION = `\`${RUN_CODE_NAME}\` is the only tool you can call directly — a tool call naming any other tool fails. Reach every tool the SDK declares below from inside the program.`

const SDK_RENDERERS: Record<string, (schemas: ToolSdkSchema[], programFormat: 'function-body' | 'repl') => string> = {
  typescript: renderToolsSdk,
  python: renderToolsSdkPy,
} satisfies Record<PtcSdkLanguage, (schemas: ToolSdkSchema[], programFormat: 'function-body' | 'repl') => string>

export {
  defineTool,
  valueSchemaSpecToJsonSchema,
  parameterSchemaSpecToJsonSchema,
  validateArgs,
  ToolArgsError,
  type ValueSchemaAnnotations,
  type StringValueSchemaSpec,
  type NumberValueSchemaSpec,
  type IntegerValueSchemaSpec,
  type BooleanValueSchemaSpec,
  type NullValueSchemaSpec,
  type ArrayValueSchemaSpec,
  type ObjectValueSchemaSpec,
  type JsonValueSchemaSpec,
  type OneOfValueSchemaSpec,
  type ValueSchemaSpec,
  type ParameterPropertySpec,
  type ParameterSchemaSpec,
  type ParameterJsonSchema,
  type InferValue,
  type InferArgs,
  type DefineToolOptions,
} from './schema.ts'

export {
  assertSupportedJsonSchema,
  assertObjectJsonSchema,
  validateJsonSchemaValue,
  JsonSchemaError,
  type JsonSchemaNode,
  type ObjectJsonSchema,
  type JsonSchemaType,
  type JsonSchemaScalar,
} from './json-schema.ts'

export type { PtcDispatchEventData, PtcDispatchStartEventData } from './types.ts'

export { CodeRunFailedError, RUN_CODE_NAME } from './ptc.ts'
export { jsonSchemaToTs, renderToolsSdk } from './ts-types.ts'
export { jsonSchemaToPy, renderToolsSdkPy } from './py-types.ts'
export { defineContentToolFixture, type ContentToolFixtureOptions } from './testing.ts'

// 工具经 `presentCall`/`presentResult` 声明的渲染意图词汇表位于其独立的
// UI 模块；在此再导出，使 `@deepseek-ai/dsh-tools` 保持为工具生产方与
// UI 适配器的唯一公共 API。
export type {
  ToolCallKind,
  FileLocation,
  FileDiff,
  ReadFileLine,
  ToolCallView,
  GenericCallView,
  TerminalCallView,
  DiffCallView,
  ToolResultView,
  GenericResultView,
  TerminalResultView,
  DiffResultView,
  SearchResultView,
  SearchMatchesResultView,
  SearchPathsResultView,
  SearchFileMatches,
  SearchLineMatch,
  ReadResultView,
  WebResultView,
  WebSearchResultView,
  WebFetchResultView,
  WebSource,
} from './presentation.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tools: ToolRuntime
  }

  interface Events {
    /**
     * 在派发前允许、拒绝、取消或询问。`next()` 委托为允许；`cancel` 选择
     * 规范的派发前取消结果，缺少审批支持会把 `ask` 变为拒绝。异步门必须
     * 观察 `exec.signal`；注册表在其落定后复查取消，但从不放弃其 promise。
     * 按范围过滤的派发（`@deepseek-ai/dsh-scope`）：agent 范围的监听器只收到该 agent 的调用。
     * @param exec - 待决调用（名称、已解析参数、调用方 agent）。
     * @mode waterfall
     */
    'tools/pre-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>
    /**
     * 围绕派发的瀑布，用于超时、重试或度量。`next()` 返回规范化的结果；
     * 包装器只能改 `exec.signal`，调用身份保持不可变。注册表在函数体之前
     * 重新熔合原始调用方信号，因此替换无法脱离调用方取消；包装器仍须恢复
     * 自己的信号并达到静默。
     * 按范围过滤的派发（`@deepseek-ai/dsh-scope`）：agent 范围的监听器只收到该 agent 的调用。
     * @param exec - 即将派发的已允许调用（名称、已解析参数、调用方 agent、信号）。
     * @mode waterfall
     */
    'tools/execute'(this: Scoped<ToolRuntime>, exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult>
    /**
     * 接受、替换、充实或阻止一个规范化的派发结果。`next()` 原样接受；
     * 抛错的工具仍以错误身份进入本瀑布。异步监听器必须观察 `exec.signal`；
     * 它们落定后，调用方取消只会依据工具体是否被调用，把一个成功且被接受
     * 的结果替换为相应代码。
     * 按范围过滤的派发（`@deepseek-ai/dsh-scope`）：agent 范围的监听器只收到该 agent 的调用。
     * @param exec - 刚执行完的调用（名称、已解析参数、调用方 agent）。
     * @param result - 监听器可接受、替换或阻止的派发结果。
     * @mode waterfall
     */
    'tools/post-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>): Promise<PostToolDecision>
    /**
     * 在桥接追加其 `tool/ptc-dispatch` 事件之前，允许监听器替换一次
     * `run_code` 子派发结果的持久日志副本中的内容。`next()` 保持内容
     * 不变；监听器可返回替换块（例如溢出策略对超大文本结果的预览 + 定位
     * 符）。只影响日志副本——程序本身已收到完整值，模型两者都看不到。
     * 抛错的监听器被包含：桥接回退为记录原始落定内容。
     * 按范围过滤的派发（`@deepseek-ai/dsh-scope`）：agent 范围的监听器只收到该 agent 的派发。
     * @param dispatch - 父执行、子调用身份，以及待记录的已落定内容。
     * @mode waterfall
     */
    'tools/ptc-dispatch-log'(this: Scoped<ToolRuntime>, dispatch: PtcDispatchLog, next: () => Promise<ContentBlock[]>): Promise<ContentBlock[]>
    /**
     * 观察冻结、无损 JSON 的最终结果。监听器失败被包含。
     * 按范围过滤的派发（`@deepseek-ai/dsh-scope`）：以 `exec.agent` 为键。
     * @param exec - 穿过管线的执行对象。
     * @param result - 最终返回结果的深冻结快照。
     * @mode emit
     */
    'tools/result'(this: Scoped<ToolRuntime>, exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): undefined
    /**
     * 工具被注册或注销，或某个范围限制发生了变化（可用工具集变化
     * ——可能只对一个范围）。这是不加过滤的注册表主体通知，刻意不按范围
     * 过滤派发：全局变化关系到每个 agent 的下一次组装，因此在此订阅的
     * 范围化监听器会看到每一次变化，而不只是其自身范围的。
     * @mode emit
     */
    'tools/change'(): void
  }
}

/** 工具体返回 JSON 值之后使用的工具自有规范输出契约。 */
export interface ToolOutputDefinition {
  /** 对每个成功的规范值强制执行的原始受支持 JSON Schema。 */
  readonly schema: JsonSchemaNode
  /** 从已验证参数与值到原生/模型内容的纯投影。 */
  render(args: unknown, value: JsonValue): ContentBlock[]
  /** 面向原生调用与嵌套调用的纯可回放呈现投影。 */
  presentationMeta?(args: unknown, value: JsonValue): JsonValue
}

/** 一个已注册的工具：其模式加上执行函数。 */
export interface ToolDefinition extends ToolSchema {
  /** 强制的规范输出声明。 */
  readonly output: ToolOutputDefinition
  /**
   * 执行一次已接受的调用，只返回其规范的无损 JSON 值。异步工作必须观察或
   * 转发 `exec.signal`，并只在自有工作达到静默后落定。注册表在
   * around-dispatch 信号替换中保留调用方取消，也不放弃本 promise，但它无法
   * 硬杀同进程代码。
   * @param args - 无损快照并冻结的模型参数。
   * @param exec - 执行身份、取消信号与上下文延后。
   * @returns `output.schema` 声明的规范值。
   */
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
  /**
   * 在 `tools/post-execute` 策略之前安装执行方准备的内容。回调在调用开始时
   * 被捕获，对进入 post-execute 的规范化结果各运行一次。策略替换保持权威；
   * 绕过 post-execute 的管线失败会跳过投影。
   * @param exec - 不可变的执行身份与参数。
   * @param result - post-execute 策略之前的规范化结果。
   * @returns 替换内容，或 undefined 以保留渲染器输出。
   */
  projectContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined
  /**
   * 面向模型内容的同步最后一步变换。注册表在执行开始时快照此回调，对每个
   * 规范化结果恰好调用一次，包括绕过 `tools/post-execute` 的管线失败，
   * 在无损物化之前立即执行。返回 `undefined` 保留内容；其他任何结果字段
   * 仍归注册表所有。回调必须是全函数且不得抛出。
   * @param exec - 不可变的执行身份与参数。
   * @param result - 物化之前的完整规范化结果。
   * @returns 替换内容，或 `undefined` 以保留原内容。
   */
  finalizeContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined
  /**
   * 协作式工具调用超时预算，毫秒。省略表示无期限。由
   * `@deepseek-ai/dsh-tool-call-timeout-policy`（一个 `tools/execute` 包装器）
   * 强制执行；它从不发送给模型——`schemas()` 只把 name/description/
   * parameters 列入白名单。声明它即断言本工具把 `exec.signal` 转发给一个
   * 协作式实现，该实现能在信号中止时达到静默。
   */
  timeoutMs?: number
  /**
   * 用于与兄弟工具调用重叠判定的纯同步分类器。只有 `true` 选择加入；
   * 省略、异常、非 `true` 返回值和无效的 `defineTool` 参数都是互斥的。
   * 此元数据对模型永不可见。
   *
   * 选择加入的执行不得改变父级所有的状态。共享状态必须容忍并发派发；
   * 记录器竞态仅在其可交换或失败即关闭时才被允许。完整契约见
   * [parallel-tool-call Agent Note](../../../../.agents/notes/implemented/feature/2026-07-10-parallel-tool-call-execution.md)。
   * @param args - 已解析参数；`defineTool` 在调用前验证。
   * @returns 本次调用是否可加入并行组。
   */
  isConcurrencySafe?(args: unknown): boolean
  /**
   * 可选：如何在 UI 中呈现一次调用的 PENDING 状态，从调用的 `args` 派生
   * （已解析参数，`unknown`——工具自行验证/收窄其输入）。返回
   * {@link ToolCallView}（`card` 标签的渲染意图），或 `undefined`
   * （或省略该方法）以回退到通用呈现（标题 = 工具名，原始参数作为输入）。
   * 纯函数且无副作用：UI 可能既在实时流式传输期间调用它，也在会话日志回放
   * 期间调用它，因此它只能依赖 `args`。
   */
  presentCall?(args: unknown): ToolCallView | undefined
  /**
   * 可选：如何呈现 COMPLETED 状态，给定相同的 `args` 与持久结果投影
   * （`content`、失败状态与可选的 `meta`）。返回 {@link ToolResultView}，
   * 或 `undefined`（或省略该方法）以保留 pending 标题并渲染原始结果内容。
   * 出于同样的回放原因，它必须是纯函数且无副作用。
   */
  presentResult?(args: unknown, result: ToolResult): ToolResultView | undefined
}

/** 交给 {@link ToolDefinition.presentResult} 的已完成结果。 */
export interface ToolResult {
  /** 最终的模型可见内容（失败时为渲染后的错误文本）。 */
  content: ContentBlock[]
  /** 调用是否失败。 */
  isError: boolean
  /**
   * 由工具的输出声明投影的工具私有呈现负载。它持久化在 `tool/result` 或
   * `tool/ptc-dispatch` 上，供 Host 呈现器与 Client 渲染器各自独立收窄。
   * 工具未声明投影器时缺省。
   */
  meta?: JsonValue
}

declare const toolExecutionTokenBrand: unique symbol

/** 不透明的调用身份，允许关联而不暴露可变的执行状态。 */
export type ToolExecutionToken = symbol & { readonly [toolExecutionTokenBrand]: true }

/**
 * 调用方对一次工具调用的描述。{@link ToolRuntime.execute} 加入注册表所有的
 * token 以构成管线 {@link ToolExecution}；该 token 不由调用方选择。
 */
export interface ToolExecutionInput {
  readonly callId: ToolCallId
  /**
   * 拥有本执行树的根级模型请求调用。根执行由调用方省略它；嵌套派发器传播
   * 外层的值。
   */
  readonly rootCallId?: ToolCallId
  readonly name: string
  /** PTC 内部调用的绑定期工具模式；由其生产方冻结且从不记录日志。 */
  readonly schema?: ToolSchema
  /** 无损 JSON 可序列化的已解析参数（工具自行验证其模式）。 */
  readonly arguments: unknown
  /** 调用所代表的 agent（由 agent 循环设置）。 */
  readonly agent?: Agent
  /**
   * 外层传输执行的不可变 token（若存在）。PTC 模式在 SDK 子派发上设置它，
   * 使提交式观察者可以等待外层 `run_code` 结果而不接收其活跃可变执行。
   * 该 token 也把调用标记为传输子派发而非模型直接调用：在 `mode: 'ptc'`
   * 下，只有带父级的调用才可执行原生工具名——模型直接调用（无父级）在策略
   * 管线之前即以 `UNKNOWN_TOOL` 拒绝。见 {@link ToolRuntime.execute}。
   */
  readonly parent?: ToolExecutionToken
  /** 本次调用必需的调用方自有的取消信号。 */
  readonly signal: AbortSignal
}

/**
 * 一次待决调用的调度模式。`parallel` 可与兄弟调用重叠；`exclusive` 单独
 * 运行并构成排序屏障。
 */
export type ToolExecutionMode =
  | { kind: 'parallel' }
  | { kind: 'exclusive' }

/**
 * 即将被记录的一次已落定的 `run_code` 子派发，即 `tools/ptc-dispatch-log`
 * 瀑布所见：父执行（会话所有者、外层调用身份）、子调用身份，以及其持久
 * 副本可被监听器重塑的结果。`content` 是渲染后的结果投影（原生
 * `tool/result` 会携带的内容）——程序本身收到的是结构化的 `value`
 * （失败时只有错误消息）；只有 `tool/ptc-dispatch` 事件的副本会变化。
 */
export interface PtcDispatchLog {
  /** 外层 `run_code` 执行。 */
  readonly exec: ToolExecution
  /** 发起调用的 agent（范围路由键与溢出所有者），外层调用存在时提供。 */
  readonly agent?: Agent
  /** 不透明的子调用 id；新调用使用 `<parent>:ptc:<n>`。 */
  readonly subCallId: ToolCallId
  /** 被派发的子工具名称。 */
  readonly name: string
  /** 子调用是否以错误落定。 */
  readonly isError: boolean
  /** 子调用完整的模型可见内容（落定事件的默认负载）。 */
  readonly content: ContentBlock[]
}

/**
 * 注册表管线内的一次待决工具调用。已解析参数在策略之前跨过一个无损 JSON
 * 物化点并被深冻结；调用身份、调用方信号与注册表分配的 {@link token}
 * 均为只读。注册表在 `tools/result` 观察者运行之前冻结整个对象。
 */
export interface ToolExecution extends ToolExecutionInput {
  /** 根级模型请求调用，对每个根执行与嵌套执行均已解析。 */
  readonly rootCallId: ToolCallId
  /** 注册表分配的身份，仅以子调用的不透明 `parent` token 形式共享。 */
  readonly token: ToolExecutionToken
}

/**
 * {@link ToolExecution} 的 around-dispatch 视图。`tools/execute` 包装器可在
 * 其委托存续期内替换信号，但不能移除信号。注册表把每次替换与捕获的调用方
 * 信号熔合。
 */
export interface ToolDispatchExecution extends Omit<ToolExecution, 'signal'> {
  /** 对下一个包装器或工具体可见的取消信号。 */
  signal: AbortSignal
}

/**
 * 注册表接受 {@link ToolExecution} 后交给工具实现的运行时上下文。
 * {@link deferContext} 把上下文附加到本执行自己的结果上——复合工具把嵌套
 * 派发的上下文摆渡回外层结果，叶子工具可以铸一枚新的插件来源指令；循环
 * 只在 `tool/result` 之后追加它。
 */
export interface ToolRunContext extends ToolExecution {
  /**
   * 延后一个上下文——通常是复合工具摆渡的嵌套派发上下文，或一枚新的
   * 插件来源指令——直到本工具的最终结果到达 agent 循环。各上下文保留
   * 自身的来源与元数据，并按调用顺序输出。
   */
  deferContext(context: UserMessage): void
  /**
   * 把一个成功的最终结果标记为当前 agent 回合的终结。标记随本执行自己的
   * 结果传播（`concludesTurn` 只存在于 {@link ToolExecutionSuccess} 上）；
   * 派发嵌套调用的复合工具像 `additionalContexts` 一样从嵌套结果转发它，
   * 因此只有权威的嵌套成功才能终结外层运行。
   */
  concludeTurn(): void
}

/** 注册表所有的活跃执行对象；公共管线视图保持只读。 */
type MutableToolRunContext = Omit<ToolRunContext, 'signal'> & { signal: AbortSignal }

/**
 * 仅调度器可见的结果，位于有序的 pre-execute 与守卫之后。`post-result`
 * 仍会经历 post-execute；`final-result` 绕过它。
 * @internal
 */
export type ScheduledToolPreparation =
  | { kind: 'dispatch'; exec: ToolRunContext }
  | { kind: 'post-result'; exec: ToolRunContext; result: ToolExecutionResult }
  | { kind: 'final-result'; exec: ToolRunContext; result: ToolExecutionResult }

/**
 * 仅调度器可见的派发结果。`post-result` 仍会经历 post-execute；
 * `final-result` 已符合 {@link ToolRuntime.execute} 的失败语义。
 * @internal
 */
export type ScheduledToolDispatch =
  | { kind: 'post-result'; result: ToolExecutionResult }
  | { kind: 'final-result'; result: ToolExecutionResult }

/**
 * 以 symbol 为键的调度器视图，在重叠派发的同时保持 pre/post 策略有序。
 * 普通调用方使用 {@link ToolRuntime.execute}；这不是插件扩展点。
 * @internal
 */
export interface ToolRuntimeScheduler {
  /** 物化输入，运行有序的 pre-execute/守卫门，并决定后续阶段。 */
  prepare(exec: ToolExecutionInput): Promise<ScheduledToolPreparation>
  /** 只运行 around-dispatch/函数体阶段。 */
  dispatch(exec: ToolRunContext): Promise<ScheduledToolDispatch>
  /** 运行 post-execute 与定义所有的内容定稿，然后物化并通知。 */
  finalize(exec: ToolRunContext, result: ToolExecutionResult): Promise<ToolExecutionResult>
  /** 运行定义所有的内容定稿，然后物化并通知，不经过 post-execute。 */
  finish(exec: ToolRunContext, result: ToolExecutionResult): ToolExecutionResult
}

/**
 * 从生成的命名服务 API 中省略的调度器入口点。
 * @internal
 */
export const TOOL_RUNTIME_SCHEDULER: unique symbol = Symbol('@deepseek-ai/dsh-tools.scheduler')

/** 工具体被调用之后发生取消的规范错误码。 */
export const TOOL_ABORTED = 'ABORTED'

/** 工具体被调用之前发生取消的规范错误码。 */
export const TOOL_ABORTED_BEFORE_DISPATCH = 'ABORTED_BEFORE_DISPATCH'

/** 失败工具调用的结构化错误元数据（与模型可见文本并列）。 */
export interface ToolErrorInfo {
  name: string
  code: string
  /** 可选的原始面向用户细节；持久投影保留它，但模型可见内容不包含它。 */
  reason?: string
}

/** 规范的失败细节；内部路由信息保持可选。 */
export interface ToolFailure {
  /** 人类可读的失败消息，不带原生 `Error: ` 信封。 */
  message: string
  /** 策略与持久诊断使用的内部错误类/码。 */
  info?: ToolErrorInfo
}

/**
 * 模型请求未注册的工具时（在内部）抛出。扩展 {@link HarnessError}
 * （`code: 'UNKNOWN_TOOL'`），使未知工具失败与工具自身抛错一样可路由
 * ——重试/沙箱/回放代码可以把它与工具体的错误区分开。
 */
export class ToolNotFoundError extends HarnessError {
  /**
   * @param toolName - 调用方请求的名称。
   * @param reachableFrom - 模型改为经由何处到达该工具：名称可见而只是
   *   呈现方式禁止直接调用时提供。完全未注册的名称省略它。
   */
  constructor(toolName: string, reachableFrom?: string) {
    super(
      reachableFrom === undefined
        ? `unknown tool "${toolName}"`
        : `unknown tool "${toolName}": ${reachableFrom}`,
      'UNKNOWN_TOOL',
    )
    this.name = 'ToolNotFoundError'
  }
}

/** 工具体或 post 策略值违反其声明的输出时抛出。 */
export class ToolOutputError extends HarnessError {
  /** 按验证顺序排列的模式/值违规。 */
  readonly violations: string[]

  constructor(toolName: string, violations: string[]) {
    super(`tool "${toolName}" returned invalid output: ${violations.join('; ')}`, 'INVALID_TOOL_OUTPUT')
    this.name = 'ToolOutputError'
    this.violations = violations
  }
}

/** 把一次投影器异常转换为规范的无效输出失败。 */
function projectionError(toolName: string, projector: 'render' | 'presentationMeta', error: unknown): ToolOutputError {
  return new ToolOutputError(toolName, [`output.${projector} failed: ${errorMessage(error)}`])
}

/** 在后续持久结果物化之前快照一个投影器结果。 */
function snapshotProjection<T>(toolName: string, projector: 'render' | 'presentationMeta', candidate: T): T {
  try {
    const detached = snapshotJsonValue(candidate)
    if (detached === undefined) {
      throw new ToolOutputError(toolName, [`output.${projector} returned non-lossless JSON`])
    }
    return detached
  } catch (error: unknown) {
    if (error instanceof ToolOutputError) throw error
    throw projectionError(toolName, projector, error)
  }
}

/** 把一个函数体或策略值快照进规范的无效输出失败类。 */
function snapshotToolValue(toolName: string, candidate: unknown): JsonValue {
  try {
    const detached = snapshotJsonValue(candidate)
    if (detached === undefined) throw new ToolOutputError(toolName, ['value is not lossless JSON'])
    return detached as JsonValue
  } catch (error: unknown) {
    if (error instanceof ToolOutputError) throw error
    throw new ToolOutputError(toolName, [`value snapshot failed: ${errorMessage(error)}`])
  }
}

/** 成功的规范工具执行，含其原生/模型投影。 */
export interface ToolExecutionSuccess {
  readonly isError: false
  /** 执行局部的规范值；刻意不进入持久事件。 */
  readonly value: JsonValue
  readonly content: ContentBlock[]
  readonly error?: never
  readonly meta?: JsonValue
  readonly additionalContexts?: UserMessage[]
  /** agent 循环在提交本批成功结果后停止。 */
  readonly concludesTurn?: true
}

/** 失败的规范工具执行；失败绝不携带成功的值。 */
export interface ToolExecutionFailure {
  readonly isError: true
  readonly error: ToolFailure
  readonly value?: never
  readonly content: ContentBlock[]
  readonly meta?: JsonValue
  readonly additionalContexts?: UserMessage[]
  readonly concludesTurn?: never
}

/** 一次工具调用的判别式、执行局部结果。 */
export type ToolExecutionResult = ToolExecutionSuccess | ToolExecutionFailure

/**
 * 派发前决策。`allow` 运行调用；`deny` 物化其面向模型的理由与可选的结构化
 * 错误身份；`cancel` 选中规范的取消结果而不呈现策略拒绝；`ask` 只在审批
 * 服务返回 `allowed-once` 后运行，否则拒绝；其 `reason` 是经审计的审批
 * 理由，可选的 `displayReason` 是本地化提示文本。输入改写被排除，因为
 * 参数已被记录并呈现。
 */
export type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string; info?: ToolErrorInfo }
  | { kind: 'cancel' }
  | { kind: 'ask'; reason?: string; displayReason?: { readonly en: string; readonly [locale: string]: string } }

/**
 * 派发后决策：接受、替换一次投影、为下一次请求附加上下文，或通过把纠正
 * 反馈变成错误结果来阻止。
 */
export type PostToolDecision =
  | { kind: 'accept'; content?: ContentBlock[]; value?: never; additionalContexts?: UserMessage[] }
  | { kind: 'accept'; value: JsonValue; content?: never; additionalContexts?: UserMessage[] }
  | { kind: 'block'; feedback: ContentBlock[]; additionalContexts?: UserMessage[] }

/**
 * 从任意抛出值尽力提取人类可读消息：Error 实例使用 `.message`；带字符串
 * `message` 属性的非 Error 对象（如 `throw { message: 'denied' }`）也使用
 * 它；其余一律字符串化。
 */
function errorMessage(error: unknown): string {
  try {
    if (error instanceof Error) return error.message
    if (typeof error === 'object' && error !== null
      && 'message' in error && typeof error.message === 'string') {
      return error.message
    }
    return String(error)
  } catch {
    // 恶意的抛出值可能让 `instanceof`、属性访问或字符串强转陷入陷阱。
    // 错误规范化是最外层安全边界，因此其回退自身必须是全函数。
    return '<unprintable thrown value>'
  }
}

/** 从策略反馈导出一条失败消息，不改变其已渲染的内容块。 */
function failureMessageFromContent(content: ContentBlock[]): string {
  const text = content
    .map(block => block.type === 'text' ? block.text : `[${block.type} content]`)
    .join('\n')
  return text.length > 0 ? text : 'tool result blocked by post-execute policy'
}

/** 快照并冻结一个持久的工具结果投影，或拒绝有损数据。 */
function materializePresentation<T>(candidate: T): T {
  const detached = snapshotJsonValue(candidate)
  if (detached === undefined) {
    throw new TypeError('tool result must be losslessly JSON-serializable')
  }
  return deepFreeze(detached)
}

/** 抛出的 HarnessError 的结构化 `{ name, code }`，否则 undefined。 */
function errorInfo(error: unknown): ToolErrorInfo | undefined {
  try {
    return error instanceof HarnessError ? { name: error.name, code: error.code } : undefined
  } catch {
    return undefined
  }
}

/** 注册表向模型呈现工具的方式（见 {@link Config.mode}）。 */
export type ToolPresentationMode = 'native' | 'ptc'

/** 插件配置：已注册工具向模型呈现的方式。 */
export interface Config {
  /**
   * 模型呈现。`native`（默认）发送每个可见模式；`ptc` 只发送 `run_code`
   * 加一份生成的 SDK 提示词，并把执行器收拢到同一表面（模型直接调用只能
   * 点名 `run_code`；`run_code` 的 SDK 子派发保留每个可见工具）。PTC 模式
   * 要求存在一个 `ctx.ptcRuntime`，其 `language` 已注册 SDK 渲染器
   * （TypeScript 或 Python）；缺失或无渲染器时提示词组装失败。在 `ptc`
   * 下，`toolOrder` 中的原生名称无效。
   */
  mode?: ToolPresentationMode
  /**
   * `run_code` 程序的重叠子调用并发上限（默认 10，即循环调度器自身的
   * 默认值）。子调用遵循原生调度契约——只有工具判定为并发安全的调用才
   * 重叠；独占调用构成屏障——因此 `1` 恢复严格串行派发。必须是正整数。
   */
  maxParallelSubCalls?: number
}

/**
 * 对全局工具的按范围过滤器。限制相交，且不影响范围化注册或保留的 PTC
 * 模式传输。
 */
export interface ToolRestriction {
  /** 保持可见的全局工具名；其余全部移除。 */
  readonly allow?: readonly string[]
  /** 从可见性中移除的全局工具名。 */
  readonly deny?: readonly string[]
}

/** 注册时编译一次、供反复实时全局查找的过滤器。 */
interface CompiledToolRestriction {
  readonly allow?: ReadonlySet<string>
  readonly deny?: ReadonlySet<string>
}

/** 一个范围的完整注册表视图，由单次层级遍历导出。 */
interface ToolView {
  /** 经限制、范围遮蔽与传输插入之后的可见定义。 */
  readonly visible: ReadonlyMap<string, ToolDefinition>
  /** 限制前的能力名，供提示词顺序校验使用。 */
  readonly knownNames: ReadonlySet<string>
  /** 范围限制可以点名的当前全局名称。 */
  readonly restrictableNames: ReadonlySet<string>
}

/**
 * 在每个 `tools/pre-execute` 监听器之后、工具体之前求值的单调执行守卫。
 * 返回理由即拒绝调用；返回 `undefined` 保持不变。由于守卫没有 allow 结果，
 * 监听器顺序无法把拒绝翻回许可。
 * @param execution - 可扩展 pre-execute 策略完成后的身份受保护调用。
 * @returns 最终拒绝理由，或 `undefined` 保持调用被允许。
 */
export type ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined

/** 一个范围对工具注册表的完整贡献。 */
class ToolLayer implements ScopeLayer {
  readonly tools: NamedEntries<ToolDefinition>
  readonly restrictions = new AnonymousEntries<CompiledToolRestriction>()
  readonly guards = new AnonymousEntries<ToolGuard>()
  /**
   * 本范围 agent 为自己声明的呈现方式，遮蔽部署默认值。单格而非条目表：
   * 对"模型看到哪种形态"有两个答案，是矛盾而非合并。
   */
  mode: ToolPresentationMode | undefined

  constructor(scope: ScopeKey | undefined) {
    this.tools = new NamedEntries(name => new Error(scope === undefined
      ? `tool "${name}" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)`
      : `tool "${name}" is already registered in this scope`))
  }

  /** 本聚合层的每个贡献表是否都为空。 */
  isEmpty(): boolean {
    return this.tools.isEmpty() && this.restrictions.isEmpty() && this.guards.isEmpty()
      && this.mode === undefined
  }

  /** 本层每个已编译限制是否都放行该全局工具名。 */
  admits(name: string): boolean {
    for (const filter of this.restrictions.values()) {
      if ((filter.allow !== undefined && !filter.allow.has(name))
        || (filter.deny !== undefined && filter.deny.has(name))) return false
    }
    return true
  }

  /** 本层活跃守卫注册中首个单调拒绝。 */
  guardReason(exec: ToolExecution): string | undefined {
    for (const guard of this.guards.values()) {
      const reason = guard(exec)
      if (reason !== undefined) return reason
    }
    return undefined
  }
}

/** 审批决策，外加审批通道是否报告了取消。 */
interface ToolAskResolution {
  readonly decision: Extract<PreToolDecision, { kind: 'allow' | 'deny' }>
  readonly approvalCancelled: boolean
}

/** 调用方取消与派发状态，保持在 around 包装器视图之外。 */
interface ToolCancellationState {
  readonly callerSignal: AbortSignal
  bodyInvoked: boolean
}

/** 一次派发范围内的熔合信号，外加工具体落定后的监听器清理。 */
interface FusedToolSignal {
  readonly signal: AbortSignal
  dispose(): void
}

/** 在所属配置边界解析 run_code 重叠上限（直接构造会绕过 Loader 模式）。 */
function resolveMaxParallelSubCalls(value: number | undefined): number {
  const maxParallelSubCalls = value ?? 10
  if (!Number.isInteger(maxParallelSubCalls) || maxParallelSubCalls < 1) {
    throw new Error('maxParallelSubCalls must be a positive integer')
  }
  return maxParallelSubCalls
}

/**
 * 工具注册表与执行管线。范围化注册遮蔽全局；一个可见性解析器同时供给
 * 呈现、查找与派发。
 */
export class ToolRuntime extends Service {
  static inject = ['systemPrompt']

  static Config: z<Config> = z.object({
    mode: z.union(['native', 'ptc'] as const).default('native'),
    maxParallelSubCalls: z.natural().min(1).default(10),
  })

  /** 供 `dsh-agent-loop` 并行调度器消费的内部分阶段视图。 */
  readonly [TOOL_RUNTIME_SCHEDULER]: ToolRuntimeScheduler = {
    prepare: exec => this.prepareScheduledExecution(exec),
    dispatch: exec => this.dispatchScheduledExecution(exec),
    finalize: (exec, result) => this.finalizeScheduledExecution(exec, result),
    finish: (exec, result) => this.finishScheduledExecution(exec, result),
  }

  /** 运行中的工具体延后的上下文，按其调度器所有的执行为键。 */
  private deferredContexts = new WeakMap<ToolRunContext, UserMessage[]>()
  /** 工具体声明当前回合已完成的执行。 */
  private concludingExecutions = new WeakSet<ToolExecution>()
  /** 原始调用方取消，保持在包装器可变的执行对象之外。 */
  private cancellationStates = new WeakMap<ToolRunContext, ToolCancellationState>()
  /** 策略开始前快照的定义所有的最终内容变换。 */
  private contentFinalizers = new WeakMap<ToolRunContext, ToolDefinition['finalizeContent']>()
  /** post-execute 策略之前安装的执行方准备内容。 */
  private contentProjectors = new WeakMap<ToolRunContext, ToolDefinition['projectContent']>()
  private readonly layers = new ScopedLayers(
    scope => new ToolLayer(scope),
    () => { this.ctx.emit('tools/change') },
  )
  /** 未作声明的范围所用呈现方式；{@link presentAs} 可按范围遮蔽它。 */
  private readonly defaultMode: ToolPresentationMode
  private readonly maxParallelSubCalls: number
  /**
   * 保留的呈现传输，保持在可过滤的注册层之外。按需构建而非在构造时构建：
   * 服务构造时已无法得知哪些 agent 运行 PTC 模式，且该传输拥有自己的
   * PTC 调用追踪与状态所有者注册。
   */
  private ptcTransport: ToolDefinition | undefined
  private readonly ptcContext: Context

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'tools')
    this.ptcContext = ctx
    // Config schema 已为省略的 mode 设默认值；?? 为测试中的直接（非
    // Loader）构造收窄可选输入类型。
    this.defaultMode = config.mode ?? 'native'
    this.maxParallelSubCalls = resolveMaxParallelSubCalls(config.maxParallelSubCalls)
    ctx.systemPrompt.tools(context => this.wireSchemas(context.scope))
    if (this.defaultMode !== 'native') {
      ctx.systemPrompt.section(this.collapseSection())
      ctx.systemPrompt.section(this.sdkSection())
    }
  }

  /**
   * `ptc` 执行器收拢的提示词声明，在 {@link sdkSection} 注册之处一并注册，
   * 在有效 `ptc` 之外渲染为空。
   *
   * 每个工具都贡献自己的指引节来点名自己的工具，没有任何一节限定该工具
   * 如何被到达，且它们都渲染在 SDK 之前。没有本节，模型会读到一份被告知
   * 要使用的工具目录，却看不到"只有 `run_code` 可被调用"的声明，于是发出
   * 一个原生调用，为提示词刚声明过的工具收到 `UNKNOWN_TOOL`，进而断定部署
   * 不一致。它的顺序把该规则放在那些指引之前而非之后。
   *
   * 原生范围不渲染任何指令。
   * @returns 节注册。
   */
  private collapseSection(): PromptSection {
    return {
      name: 'tools:ptc-only',
      order: this.ctx.systemPrompt.getSectionOrder('PTC_ONLY'),
      // 与执行器据以拒绝的是同一个谓词，因此提示词不可能声明一条注册表
      // 并不执行的规则（见 `collapses`）。
      text: context => this.modeFor(context.scope) === 'ptc' ? PTC_ONLY_INSTRUCTION : '',
    }
  }

  /**
   * 生成的 SDK 提示词节，由 PTC 模式部署全局注册，并经 {@link presentAs}
   * 按范围注册。
   *
   * 正文从调用方范围重新生成，对以原生方式呈现的 agent 渲染为空——在
   * PTC 模式部署下选择退出的 agent 仍会看到全局注册，而空节会从渲染出的
   * 提示词中丢弃。
   * @returns 节注册。
   */
  private sdkSection(): PromptSection {
    return {
      name: 'tools:sdk',
      order: this.ctx.systemPrompt.getSectionOrder('TOOLS_SDK'),
      interpolate: false,
      // 以稳定顺序从调用方范围的可见工具重新生成。
      text: (context) => {
        const mode = this.modeFor(context.scope)
        if (mode === 'native') return ''
        const runtime = this.requirePtcRuntime(mode)
        // 自有属性读取：否则 `toString`/`constructor` 之类的语言会把继承的
        // Object.prototype 成员解析成渲染器。
        const render = SDK_RENDERERS[runtime.language]
        /* v8 ignore next -- requirePtcRuntime 在此之前已拒绝未知语言。 */
        if (render === undefined) throw new Error(`dsh-tools: no SDK renderer for ${runtime.language}`)
        return render(this.sdkSchemas(context.scope), runtime.programFormat)
      },
    }
  }

  /**
   * 某个范围的 agent 所见的呈现方式：其自身声明，否则部署默认值。
   * @param scope - 调用方 agent，全局视图为 undefined。
   * @returns 已解析的呈现模式。
   */
  private modeFor(scope?: ScopeKey): ToolPresentationMode {
    // 链上最近的范围胜出：preset 的常设声明覆盖其下派生的每个 agent，
    // 而 agent 自己的声明（若有）会覆盖其 preset 的。模式决定模型看到的
    // 内容，正是链所继承的那类事实。
    const layers = this.layers.chainLayers(scope)
    for (let index = layers.length - 1; index >= 0; index -= 1) {
      const mode = layers[index]?.mode
      if (mode !== undefined) return mode
    }
    return this.defaultMode
  }

  /**
   * 保留的 `run_code` 传输，按需构建。
   *
   * 它从不进入全局层：按 agent 的限制不得移除它，范围化注册也不得遮蔽它。
   * 可见性解析器在解析完可过滤的全局/范围能力层之后追加它，且只对模式
   * 确实呈现它的范围追加。
   * @returns 共享的传输定义。
   */
  private requirePtcTransport(): ToolDefinition {
    this.ptcTransport ??= createRunCodeTool(this, {
      resolveWorkingDirectory: async (exec) => {
        // 只有 Agent 持有的 PTC 需要目录状态；原生注册表与无主程序没有本
        // 服务也能运行。
        if (exec.agent === undefined) return undefined
        const directories = this.ctx.get('workingDirectory')
        if (directories === undefined) throw new Error('dsh-tools: run_code with an Agent requires workingDirectory')
        return directories.ensure(exec.agent, exec.signal)
      },
      requireRuntime: () => this.requirePtcRuntime(this.defaultMode),
      peekApprover: () => this.ctx.get('approval'),
      resolveSandboxPolicy: (exec) => {
        const policy = this.ctx.get('sandboxPolicy')
        if (policy === undefined) throw new Error('dsh-tools: confined PTC runtime requires sandboxPolicy')
        return policy.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
      },
      // 语言感知的 description/parameters getter 读取运行时而不强求一个，
      // 因此原生默认的进程仍能为选择代码的 agent 投影该传输。
      peekRuntime: () => this.ctx.get('ptcRuntime'),
      maxParallel: this.maxParallelSubCalls,
      shapeDispatchLog: dispatch => this.shapeDispatchLog(dispatch),
    }, this.ptcContext)
    return this.ptcTransport
  }

  /**
   * 让调用方范围的工具以 `mode` 呈现，而非部署默认值。链上最近的范围
   * 胜出，因此 preset 的常设声明覆盖加入其下的每个 agent。
   *
   * 仅限范围化使用，且每个范围一个声明：这是 agent preset 在同一进程中
   * 把 PTC 模式 agent 与原生 agent 组合起来的方式；进程级覆盖则应是
   * `mode` 配置字段。
   * @param mode - 被覆盖 agent 的模型所见的呈现方式。
   * @returns 恢复部署默认值的精确 disposer。
   */
  presentAs(mode: ToolPresentationMode): () => void {
    const ctx = this.ctx
    if (scopeOf(ctx) === undefined) {
      throw new Error('tools.presentAs() requires a scoped context (agent.ctx): a context-global presentation is the `mode` config field on the tools row')
    }
    const dispose = ctx.effect(function* (this: ToolRuntime) {
      yield this.layers.effect(
        ctx,
        (layer) => {
          if (layer.mode !== undefined) {
            throw new Error(`tools.presentAs("${mode}") conflicts with "${layer.mode}" already declared for this scope; one composition selects one presentation`)
          }
          layer.mode = mode
          return () => { layer.mode = undefined }
        },
        { label: 'tools.presentAs()' },
      )
      // SDK 节与收拢节按范围注册的理由与模式相同。在已默认 PTC 模式的
      // 部署下，这会以相同正文遮蔽全局注册，零成本，且保持一条规则而非
      // 分情况分析。
      if (mode !== 'native') {
        yield ctx.systemPrompt.section(this.collapseSection())
        yield ctx.systemPrompt.section(this.sdkSection())
      }
    }.bind(this), 'tools.presentAs()')
    // oxlint-disable-next-line typescript/no-misused-promises -- 同步的组合式拆卸
    return dispose
  }

  /**
   * 构建一个范围用于传输的模式与名称，供提示词顺序校验。限制不会使已知
   * 工具失效，但模式收拢会。
   */
  private wireSchemas(scope?: ScopeKey): ToolProviderResult {
    const view = this.view(scope)
    const mode = this.modeFor(scope)
    if (mode === 'native') {
      const schemas = [...view.visible.values()].map(definition => this.schemaOf(definition, false))
      return { schemas, knownNames: [...view.knownNames] }
    }
    // 在投影模式之前验证运行时语言：schemaOf 会读取 run_code 的语言感知
    // description/parameters getter，否则其自身的风味表守卫会先报错。这让
    // 渲染器表拒绝保持为无 SDK 渲染器语言在组装期的规范错误。
    this.requirePtcRuntime(mode)
    const schemas = [...view.visible.values()].map(definition => this.schemaOf(definition, false))
    return {
      schemas: schemas.filter(schema => schema.name === RUN_CODE_NAME),
      knownNames: [RUN_CODE_NAME],
    }
  }

  /**
   * 解析 PTC 运行时，否则抛出可操作的配置错误。在使用时（组装 /
   * run_code 执行）读取，而非经静态 `inject`：注入条目会挟持 `ctx.tools`
   * ——及其背后的每个工具插件——令其依赖一个即使在 `mode: 'native'` 下
   * 也必须存在的 PTC 运行时。
   *
   * 组装与 `run_code` 执行分开读取，因此语言不绑定到单次请求。只有一个已
   * 发布后端时无害——两次读取返回同一风味——但若重载在两者之间换入了
   * 第二种语言，会把针对一个 SDK 编写的程序交给另一个。绑定被推迟到
   * 第二个后端发布时（第一个可测试的时点）。
   */
  private requirePtcRuntime(mode: ToolPresentationMode): PtcRuntime {
    const runtime = this.ctx.get('ptcRuntime')
    if (!runtime) {
      throw new Error(`dsh-tools: mode "${mode}" requires a PTC runtime — load a ctx.ptcRuntime implementation (e.g. @deepseek-ai/dsh-ptc-runtime-node) or set tools mode to "native"`)
    }
    if (!Object.hasOwn(SDK_RENDERERS, runtime.language)) {
      const known = Object.keys(SDK_RENDERERS).map(name => JSON.stringify(name)).join(', ')
      throw new Error(`dsh-tools: no SDK renderer registered for runtime language ${JSON.stringify(runtime.language)} (known: ${known})`)
    }
    return runtime
  }

  /**
   * 全局注册，或在调用方 agent 范围注册。范围化工具遮蔽全局；同一层内的
   * 重复与保留的 `run_code` 名称都会失败。
   * @param definition - 工具模式、执行，及可选的定稿/呈现回调。
   * @returns 注销该工具的精确 disposer。
   */
  register(definition: ToolDefinition): () => void {
    const name = definition.name
    const output = (definition as Partial<ToolDefinition>).output
    if (output === undefined || typeof output !== 'object'
      || typeof output.render !== 'function'
      || (output.presentationMeta !== undefined && typeof output.presentationMeta !== 'function')) {
      throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`)
    }
    assertSupportedJsonSchema(output.schema)
    const timeoutMs = definition.timeoutMs
    if (timeoutMs !== undefined
      && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw new TypeError(`tool "${name}" timeoutMs must be a positive finite number`)
    }
    // 无条件保留：任何 agent 都可以为自己选择代码模式，因此在部署默认值
    // 下空闲的名称会在 preset 挂载的那一刻变成冲突。
    if (name === RUN_CODE_NAME) {
      throw new Error(`tool name "${RUN_CODE_NAME}" is reserved for the PTC mode presentation transport and cannot be registered or shadowed`)
    }
    return this.layers.effect(
      this.ctx,
      layer => layer.tools.insert(name, definition),
      { label: 'tools.register()' },
    )
  }

  /**
   * 为调用方 agent 范围限制全局工具。空过滤器、未知名称、范围局部名称与
   * 保留的传输名称都会失败。限制相交；范围化注册保持可见。
   * @param filter - 全局工具掩码：`allow`（仅保留）和/或 `deny`（移除）。
   * @returns 解除该限制的精确 disposer。
   */
  restrict(filter: ToolRestriction): () => void {
    const scope = scopeOf(this.ctx)
    if (scope === undefined) {
      throw new Error('tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent — deny the tool for the intended agent instead')
    }
    const allow = filter.allow
    const deny = filter.deny
    if (allow === undefined && deny === undefined) {
      throw new Error('tools.restrict({}) is a no-op: pass `allow` and/or `deny` (an empty filter is almost always a materialized-empty-config bug)')
    }
    const compiled: CompiledToolRestriction = {
      ...allow !== undefined ? { allow: new Set(allow) } : {},
      ...deny !== undefined ? { deny: new Set(deny) } : {},
    }
    if ([...allow ?? [], ...deny ?? []].includes(RUN_CODE_NAME)) {
      throw new Error(`tools.restrict() cannot name reserved PTC mode presentation transport "${RUN_CODE_NAME}"; restrict end-capability tools instead`)
    }
    const known = this.view(scope).restrictableNames
    const unknown = [...allow ?? [], ...deny ?? []].filter(name => !known.has(name))
    if (unknown.length > 0) {
      throw new Error(`tools.restrict() names unknown global tool${unknown.length > 1 ? 's' : ''} ${unknown.map(n => `"${n}"`).join(', ')}; known global tools: ${[...known].sort().join(', ') || '(none)'}`)
    }
    return this.layers.effect(
      this.ctx,
      layer => layer.restrictions.append(compiled),
      { label: 'tools.restrict()' },
    )
  }

  /**
   * 在可扩展的 `tools/pre-execute` 瀑布之后注册一个单调守卫。普通上下文的
   * 守卫全局生效；经 `agent.ctx` 注册的只对该 agent 生效。任何匹配的守卫
   * 都可以通过返回理由拒绝调用，而没有任何守卫能强制放行另一个守卫已拒绝
   * 的调用。返回精确的 effect disposer 以支持有序所有权与 HMR 清理。
   * @param guard - 同步检查；返回字符串即拒绝该执行。
   * @returns 注销该守卫的精确 disposer。
   */
  guard(guard: ToolGuard): () => void {
    return this.layers.effect(
      this.ctx,
      layer => layer.guards.append(guard),
      { label: 'tools.guard()', notify: false },
    )
  }

  /** 先全局、后范围链守卫层的首个单调拒绝，最远者优先。 */
  private guardReason(exec: ToolExecution): string | undefined {
    const globalReason = this.layers.global.guardReason(exec)
    if (globalReason !== undefined) return globalReason
    if (exec.agent === undefined) return undefined
    for (const layer of this.layers.chainLayers(exec.agent)) {
      const reason = layer.guardReason(exec)
      if (reason !== undefined) return reason
    }
    return undefined
  }

  /**
   * 在一次层级遍历中解析某个范围需要的全部注册表事实。可见映射把限制应用于
   * 继承表面，然后是范围自身的注册与保留的呈现传输；其余集合保留限制前的
   * 事实，供限制与提示词顺序校验使用。
   *
   * 限制过滤的是一个范围继承的内容——全局层与其链上的每个祖先层——而绝不
   * 是其自身层注册的内容。正是这一豁免让按子级的 capability 过滤器得以
   * 保持完整：委派运行时把子级的结构化输出工具注册进子级自己的层，而点名
   * 子级可用 capability 的过滤器不得剥掉它赖以应答的机制。
   *
   * 把豁免集合读作"全局层"而非"非我所有"，只在每个面向模型的工具都驻留
   * 在宿主组合中时成立。preset 把它们移到 agent 平面之后，它们成了祖先
   * 贡献，于是子级的过滤器静默地不再约束任何交给它的东西。
   * @param scope - 查看范围（agent），全局视图为 undefined。
   * @returns 该范围的完整派生视图。
   */
  private view(scope?: ScopeKey): ToolView {
    // 范围链各层，最远祖先在前，确切范围最后。
    const layers = this.layers.chainLayers(scope)
    // 刻意对链盲目：这是唯一一层其注册为该范围所有而非继承的层，在该范围
    // 有贡献之前不存在。
    const own = this.layers.peek(scope)
    // 继承表面，最近祖先最后：更近范围的同名条目遮蔽更远的，全局层最远。
    const inherited = new Map<string, ToolDefinition>(this.layers.global.tools.entries())
    for (const layer of layers) {
      if (layer === own) continue
      for (const [name, definition] of layer.tools.entries()) inherited.set(name, definition)
    }
    const visible = new Map<string, ToolDefinition>()
    const knownNames = new Set<string>()
    const restrictableNames = new Set<string>()
    for (const [name, definition] of inherited) {
      knownNames.add(name)
      restrictableNames.add(name)
      // 限制沿整条链相交：链上任一范围都可以为其中嵌套的一切遮蔽一个
      // 继承的名称。
      if (layers.every(layer => layer.admits(name))) visible.set(name, definition)
    }
    // 范围自身的注册最后加入，遮蔽继承名称，且在上述过滤之外。
    if (own !== undefined) {
      for (const [name, definition] of own.tools.entries()) {
        knownNames.add(name)
        visible.set(name, definition)
      }
    }
    // 呈现基础设施最后解析，且在 capability 过滤之外。注册已拒绝该保留
    // 名称，因此这里的插入既是不变量断言，也是对未来层级变化的防护。
    // 按范围：原生 agent 不得因为进程中的其他 agent 呈现它就在自己的
    // 派发表里找到 `run_code`。
    if (this.modeFor(scope) !== 'native') {
      visible.set(RUN_CODE_NAME, this.requirePtcTransport())
    }
    return { visible, knownNames, restrictableNames }
  }

  /**
   * 按某个范围所见查找工具（范围化遮蔽全局；被限制掉的全局名读作不存在）。
   * 呈现方传入调用方 agent，使渲染的卡片与实际执行的定义一致。
   * @param name - 注册时的工具名。
   * @param scope - 查看范围（agent）；省略 = 全局视图。
   * @returns 该范围解析到的定义，无可见者时为 undefined。
   */
  get(name: string, scope?: ScopeKey): ToolDefinition | undefined {
    return this.view(scope).visible.get(name)
  }

  /**
   * 解析一次调用可能执行的定义，在其所属的操作边界应用模式收拢。注册表
   * 视图（`get`）与呈现方式无关；此处 `ptc` 下的模型直接调用只能点名保留
   * 的 `run_code` 传输，而嵌套子派发（设置了 `parent` token——`run_code`
   * SDK 调用它绑定的工具）可以调用任何可见工具。拒绝经执行器以
   * `UNKNOWN_TOOL` 呈现，与定义缺失一致。
   * @param name - 注册时的工具名。
   * @param scope - 查看范围（agent）；省略 = 全局视图。
   * @param nested - 该调用是否为传输子派发而非模型直接调用。
   * @returns 可运行的定义，调用必须被拒绝时为 undefined。
   */
  private resolveExecution(name: string, scope: ScopeKey | undefined, nested: boolean): ToolDefinition | undefined {
    const tool = this.get(name, scope)
    if (tool === undefined) return undefined
    if (this.collapses(name, scope, nested)) return undefined
    return tool
  }

  /**
   * 把可见定义投影到白名单化的面向模型模式字段，排除执行与呈现回调。
   * @param scope - 查看范围（agent）；省略 = 全局视图。
   * @returns 每个可见工具一个深克隆模式。
   */
  schemas(scope?: ScopeKey): ToolSchema[] {
    return [...this.view(scope).visible.values()].map(definition => this.schemaOf(definition, true))
  }

  /** 把可见的可调用工具投影到生成的 PTC 模式 SDK 契约。 */
  private sdkSchemas(scope?: ScopeKey): ToolSdkSchema[] {
    return [...this.view(scope).visible.values()]
      .filter(definition => definition.name !== RUN_CODE_NAME)
      .map((definition): ToolSdkSchema => {
        const output = snapshotJsonValue(definition.output.schema)
        /* v8 ignore next -- 注册时已把该模式验证并保留为无损 JSON。 */
        if (output === undefined) {
          throw new Error(`tool "${definition.name}" output schema must be lossless JSON before SDK projection`)
        }
        return {
          ...this.schemaOf(definition, true),
          output,
        }
      })
  }

  /** 把一个定义投影到面向模型的模式字段。 */
  private schemaOf(definition: ToolDefinition, detachParameters: boolean): ToolSchema {
    const { name, description, parameters, deferLoading } = definition
    const detached = detachParameters ? snapshotJsonValue(parameters) : parameters
    if (detached === undefined) {
      throw new Error(`tool "${name}" parameters must be lossless JSON before schema projection`)
    }
    return {
      name,
      description,
      parameters: detached,
      ...deferLoading === true ? { deferLoading } : {},
    }
  }

  /**
   * 经调用方可见的工具定义对一次待决调用分类。只有精确的 `true` 才并行；
   * 未知、隐藏、未声明、无效或抛错的分类器都是独占。
   * @param exec - 调用名、已解析参数与可选的 agent 范围。
   * @returns 失败即关闭的调度模式。
   */
  executionMode(exec: ToolExecutionInput): ToolExecutionMode {
    const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== undefined)
    if (!tool?.isConcurrencySafe) return { kind: 'exclusive' }
    try {
      const concurrencySafe: unknown = tool.isConcurrencySafe(exec.arguments)
      return concurrencySafe === true ? { kind: 'parallel' } : { kind: 'exclusive' }
    } catch {
      return { kind: 'exclusive' }
    }
  }

  /**
   * 对一次已落定的子派发运行 `tools/ptc-dispatch-log` 瀑布，返回桥接应在
   * `tool/ptc-dispatch` 上记录的内容。被包含：监听器抛错时，本方法记录
   * 原始落定内容；该失败不得让派发失败或省略落定事件。私有：唯一消费方
   * 是本注册表构造的 `run_code` 桥接，它以 capability 参数形式接收它
   * （`requireRuntime` 惯例）——瀑布而非本调用器才是公共扩展点。
   */
  private async shapeDispatchLog(dispatch: PtcDispatchLog): Promise<ContentBlock[]> {
    try {
      return await this.ctx.waterfall(
        scopeTarget(this, dispatch.agent), 'tools/ptc-dispatch-log', dispatch,
        () => Promise.resolve(dispatch.content),
      )
    } catch (error: unknown) {
      this.ctx.logger.warn(`tools: ptc-dispatch-log listener failed for ${dispatch.name}: ${errorMessage(error)}; logging the original settled content`)
      return dispatch.content
    }
  }

  /**
   * `ptc` 模式收拢是否拒绝模型直接调用：只有保留的 `run_code` 传输可被
   * 点名。嵌套子派发（设置了 `parent` token）绕过收拢。这是安全相关谓词
   * 的唯一居所，由 {@link resolveExecution} 与 {@link createExecution}
   * 共享，使两者永不漂移。
   *
   * 经 {@link modeFor} 解析，而非 `defaultMode`：在原生部署下由 agent
   * preset 给予 `ptc` 的 agent，正是 `dsh-agent-tool-presentation` 存在的
   * 目的；读取部署默认值会让恰好这个 agent 不被收拢——宣告一个表面却执行
   * 另一个，正是本收拢要关闭的绕过。
   * @param name - 注册时的工具名。
   * @param scope - 其有效呈现模式生效的查看范围。
   * @param nested - 该调用是否为传输子派发而非模型直接调用。
   */
  private collapses(name: string, scope: ScopeKey | undefined, nested: boolean): boolean {
    return !nested && this.modeFor(scope) === 'ptc' && name !== RUN_CODE_NAME
  }

  /**
   * 经 pre-policy、守卫、around-dispatch、post-policy、定义所有的内容定稿
   * 与最终通知执行。工具与监听器失败解析为物化的错误结果；不可见的工具
   * 报告 `UNKNOWN_TOOL`。返回的结果与最终观察者收到的无损冻结快照相同。
   * 在进入之后、最终结果物化之前到达的取消，会以 `ABORTED_BEFORE_DISPATCH`
   * 跳过尚未开始的函数体，或以 `ABORTED` 替换一个成功的已开始结果；已开始
   * 的工作仍会被排空，并可能保留工具所有的结构化错误。
   * @param exec - 类型化的同进程调用输入。注册表在策略开始前分配其关联
   *   token。
   * @returns 物化后的最终结果。
   */
  async execute(exec: ToolExecutionInput): Promise<ToolExecutionResult> {
    return this.prepareExecution(exec, prepared => this.completeScheduledExecution(prepared))
  }

  private async completeScheduledExecution(prepared: ScheduledToolPreparation): Promise<ToolExecutionResult> {
    switch (prepared.kind) {
      case 'dispatch': {
        const dispatched = await this.dispatchScheduledExecution(prepared.exec)
        return dispatched.kind === 'post-result'
          ? await this.finalizeScheduledExecution(prepared.exec, dispatched.result)
          : this.finishScheduledExecution(prepared.exec, dispatched.result)
      }
      case 'post-result':
        return await this.finalizeScheduledExecution(prepared.exec, prepared.result)
      case 'final-result':
        return this.finishScheduledExecution(prepared.exec, prepared.result)
      /* v8 ignore next -- 封闭联合的穷尽性守卫 */
      default:
        return assertNever(prepared, 'scheduled tool preparation')
    }
  }

  private createExecution(exec: ToolExecutionInput): ScheduledToolPreparation | { kind: 'ready'; exec: MutableToolRunContext } {
    const deferredContexts: UserMessage[] = []
    const token = createExecutionToken()
    const callId = exec.callId
    const rootCallId = exec.rootCallId ?? callId
    const name = exec.name
    const agent = exec.agent
    const parent = exec.parent
    const signal = exec.signal
    // 区分一次模式收拢的调用（在该范围可见，仅被 `ptc` 收拢拒绝）与真正
    // 未知的工具。收拢的调用被确定性地拒绝，因此它在可扩展策略管线之前
    // 终止：pre-execute 监听器、审批 `ask` 与守卫绝不能观察——更糟的是，
    // 批准——一个只会失败的调用。未知工具保持历史上的派发阶段
    // `UNKNOWN_TOOL` 路径，使策略监听器仍能看到到达注册表的每个名称。
    const visible = this.get(name, agent)
    const collapsed = visible !== undefined && this.collapses(name, agent, parent !== undefined)
    const concludingExecutions = this.concludingExecutions
    const base = {
      token,
      callId,
      rootCallId,
      name,
      signal,
      ...agent !== undefined ? { agent } : {},
      ...parent !== undefined ? { parent } : {},
      ...exec.schema !== undefined ? { schema: exec.schema } : {},
      deferContext(context: UserMessage): void {
        deferredContexts.push(context)
      },
      concludeTurn(): void {
        concludingExecutions.add(this as unknown as ToolExecution)
      },
    }
    // 在参数物化之前捕获 finalizer：`finalizeContent` 契约要求在调用开始时
    // 快照回调，而 arguments getter 可以在 `snapshotJsonValue` 期间替换或
    // 清除已注册的回调。收拢只决定被捕获的回调是否保留：派发前中止路径
    // 保留它（取消契约把已中止结果经它路由——在无效参数失败落地之前于
    // 物化中途中止的 getter 也落入同一保留路径），而 `UNKNOWN_TOOL` 拒绝与
    // 未中止的收拢调用的无效参数失败则丢弃它（该调用绝不可能执行）。
    const capturedFinalizer = visible?.finalizeContent?.bind(visible)
    const capturedProjector = visible?.projectContent?.bind(visible)
    const finalizerFor = (): ToolDefinition['finalizeContent'] | undefined =>
      collapsed && !signal.aborted ? undefined : capturedFinalizer
    try {
      const detached = snapshotJsonValue(exec.arguments)
      if (detached === undefined) {
        throw new TypeError('tool execution arguments must be losslessly JSON-serializable')
      }
      const execution: MutableToolRunContext = { ...base, arguments: deepFreeze(detached) }
      this.deferredContexts.set(execution, deferredContexts)
      this.contentFinalizers.set(execution, finalizerFor())
      if (!collapsed) this.contentProjectors.set(execution, capturedProjector)
      this.cancellationStates.set(execution, {
        callerSignal: signal,
        bodyInvoked: false,
      })
      if (collapsed) {
        // 收拢在策略管线之前拒绝该调用，但派发前中止仍遵守既定的取消
        // 契约：`prepare` 的调用方取消检查对 final-results 被跳过，因此
        // 在这里兑现中止，而不是对已取消的调用呈现 `UNKNOWN_TOOL`。
        if (signal.aborted) {
          return { kind: 'final-result', exec: execution, result: toolAbortedBeforeDispatchResult() }
        }
        // 此处名称可见，因此拒绝携带模型应改走的路径。没有它，模型会为
        // 提示词刚声明过的工具读到一句赤裸的 `unknown tool`，进而断定部署
        // 损坏而不是自我纠正。
        return {
          kind: 'final-result',
          exec: execution,
          result: toolErrorResult(new ToolNotFoundError(
            name,
            `only \`${RUN_CODE_NAME}\` is callable directly — call \`${name}\` from inside a \`${RUN_CODE_NAME}\` program instead`,
          )),
        }
      }
      return { kind: 'ready', exec: execution }
    } catch (error: unknown) {
      const execution: MutableToolRunContext = { ...base, arguments: undefined }
      this.contentFinalizers.set(execution, finalizerFor())
      return { kind: 'final-result', exec: execution, result: toolErrorResult(error) }
    }
  }

  /**
   * 为调度器运行有序的 pre-execute 与单调守卫阶段。
   * @param input - 调用方提供的执行输入。
   * @returns 已准备的执行与下一个调度器阶段。
   * @internal
   */
  private async prepareScheduledExecution(input: ToolExecutionInput): Promise<ScheduledToolPreparation> {
    return this.prepareExecution(input, prepared => prepared)
  }

  private async prepareExecution<T>(
    input: ToolExecutionInput,
    next: (prepared: ScheduledToolPreparation) => T | PromiseLike<T>,
  ): Promise<T> {
    const created = this.createExecution(input)
    if (created.kind !== 'ready') return next(created)
    const exec = created.exec
    if (this.callerCancelled(exec)) {
      return next({ kind: 'final-result', exec, result: toolAbortedBeforeDispatchResult() })
    }
    try {
      const carrier = scopeTarget(this, exec.agent)
      const gate = await this.ctx.waterfall(
        carrier, 'tools/pre-execute', exec,
        () => Promise.resolve<PreToolDecision>({ kind: 'allow' }),
      )
      const askResolution = gate.kind === 'ask'
        ? await this.serviceAsk(exec, gate)
        : { decision: gate, approvalCancelled: false }
      const { decision } = askResolution
      if (this.callerCancelled(exec) && askResolution.approvalCancelled) {
        return await next({ kind: 'post-result', exec, result: toolAbortedBeforeDispatchResult() })
      }
      if (decision.kind === 'cancel') {
        return await next({ kind: 'post-result', exec, result: toolAbortedBeforeDispatchResult() })
      }
      const denialReason = decision.kind === 'allow' ? this.guardReason(exec) : decision.reason
      const denialInfo = decision.kind === 'deny' ? decision.info : undefined
      if (denialReason !== undefined) {
        return await next({
          kind: 'post-result',
          exec,
          result: this.materializeFinalResult({
            content: [{ type: 'text', text: `Error: ${denialReason}` }],
            isError: true,
            error: { message: denialReason, ...denialInfo === undefined ? {} : { info: denialInfo } },
          }),
        })
      }
      if (this.callerCancelled(exec)) {
        return await next({ kind: 'post-result', exec, result: toolAbortedBeforeDispatchResult() })
      }
      return await next({ kind: 'dispatch', exec })
    } catch (error: unknown) {
      return next({ kind: 'final-result', exec, result: toolErrorResult(error) })
    }
  }

  /** 原始调用方信号当前是否已中止。 */
  private callerCancelled(exec: ToolRunContext): boolean {
    const state = this.cancellationStates.get(exec)
    /* v8 ignore next -- 只有注册表铸出的执行才会到达分阶段调度器方法 */
    if (state === undefined) throw new Error('tool registry scheduler invariant violated: missing cancellation state')
    return state.callerSignal.aborted
  }

  /** 按工具体是否已开始选择的规范取消结果。 */
  private cancellationResult(exec: ToolRunContext, prior?: ToolExecutionResult): ToolExecutionResult {
    const state = this.cancellationStates.get(exec)
    /* v8 ignore next -- 只有注册表铸出的执行才会到达分阶段调度器方法 */
    if (state === undefined) throw new Error('tool registry scheduler invariant violated: missing cancellation state')
    return state.bodyInvoked
      ? toolAbortedResult(prior)
      : toolAbortedBeforeDispatchResult(prior)
  }

  /**
   * 把原始调用方信号熔合回 around 包装器的任何替换，再派发已注册的函数体。
   * 取消绝不放弃函数体：已开始的 promise 先达到静默，其结果才变为
   * `ABORTED`。
   */
  private async dispatchToolBody(exec: MutableToolRunContext): Promise<ToolExecutionResult> {
    const state = this.cancellationStates.get(exec)
    /* v8 ignore next -- 只有注册表铸出的执行才会到达分阶段调度器方法 */
    if (state === undefined) throw new Error('tool registry scheduler invariant violated: missing cancellation state')
    const wrapperSignal = exec.signal
    const fused = fuseToolSignals(state.callerSignal, wrapperSignal)
    const signal = fused.signal

    if (isAborted(signal)) {
      fused.dispose()
      return toolAbortedBeforeDispatchResult()
    }
    exec.signal = signal
    try {
      const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== undefined)
      if (!tool) throw new ToolNotFoundError(exec.name)
      state.bodyInvoked = true
      const returned = await tool.execute(exec.arguments, exec)
      const result = this.createSuccessResult(exec, tool, returned)
      return isAborted(signal)
        ? toolAbortedResult(result)
        : result
    } catch (error: unknown) {
      return toolErrorResult(error)
    } finally {
      fused.dispose()
      exec.signal = wrapperSignal
    }
  }

  /**
   * 运行 around-dispatch 与工具体。工具与未知工具失败仍会经历
   * post-execute；管线失败已是最终结果。
   * @param exec - 已准备的执行。
   * @returns 结果是否仍需 post-execute。
   * @internal
   */
  private async dispatchScheduledExecution(exec: ToolRunContext): Promise<ScheduledToolDispatch> {
    try {
      const mutableExec = exec as MutableToolRunContext
      const carrier = scopeTarget(this, exec.agent)
      const result = await this.ctx.waterfall(
        carrier, 'tools/execute', mutableExec,
        () => this.dispatchToolBody(mutableExec),
      )
      const normalized = this.normalizeDispatchResult(exec, result)
      const deferredContexts = this.deferredContexts.get(exec)
      /* v8 ignore next -- 派发只接收本注册表 prepare 阶段铸出的执行 */
      if (deferredContexts === undefined) throw new Error('tool registry scheduler invariant violated: unprepared execution')
      const resultWithDeferredContexts: ToolExecutionResult = deferredContexts.length === 0
        ? normalized
        : this.markCanonical(exec, {
          ...normalized,
          additionalContexts: [
            ...deferredContexts,
            ...normalized.additionalContexts ?? [],
          ],
        })
      return {
        kind: 'post-result',
        result: this.callerCancelled(exec) && !resultWithDeferredContexts.isError
          ? this.cancellationResult(exec, resultWithDeferredContexts)
          : resultWithDeferredContexts,
      }
    } catch (error: unknown) {
      return { kind: 'final-result', result: toolErrorResult(error) }
    }
  }

  /**
   * 运行有序的 post-execute，然后应用定义所有的内容定稿，物化并通知最终
   * 结果。
   * @param exec - 已准备的执行。
   * @param result - 仍需 post-execute 的派发/pre 结果。
   * @returns 物化后的最终结果。
   * @internal
   */
  private async finalizeScheduledExecution(exec: ToolRunContext, result: ToolExecutionResult): Promise<ToolExecutionResult> {
    try {
      const project = this.contentProjectors.get(exec)
      this.contentProjectors.delete(exec)
      const content = project?.(exec, result)
      const projected = content === undefined
        ? result
        : this.markCanonical(exec, this.materializeFinalResult({ ...result, content }))
      const postResult = await this.postExecute(exec, projected)
      return this.finishScheduledExecution(
        exec,
        this.callerCancelled(exec) && !postResult.isError
          ? this.cancellationResult(exec, postResult)
          : postResult,
      )
    } catch (error: unknown) {
      return this.finishScheduledExecution(exec, toolErrorResult(error))
    }
  }

  /**
   * 物化候选结果，应用定义所有的内容定稿，然后物化并通知权威结果。
   * @param exec - 已准备的执行。
   * @param result - 最终结果。
   * @returns 物化后的最终结果。
   * @internal
   */
  private finishScheduledExecution(exec: ToolRunContext, result: ToolExecutionResult): ToolExecutionResult {
    let materializedResult: ToolExecutionResult
    try {
      materializedResult = this.materializeFinalResult(result)
    } catch (error: unknown) {
      materializedResult = this.materializeFinalResult(toolErrorResult(error))
    }
    let finalResult: ToolExecutionResult
    try {
      finalResult = this.materializeFinalResult(this.applyFinalContent(exec, materializedResult))
    } catch (error: unknown) {
      finalResult = this.materializeFinalResult(toolErrorResult(error))
    }
    this.notifyResult(exec, finalResult)
    return finalResult
  }

  /** 应用快照的工具所有内容变换，不暴露其他结果字段。 */
  private applyFinalContent(exec: ToolRunContext, result: ToolExecutionResult): ToolExecutionResult {
    const finalizeContent = this.contentFinalizers.get(exec)
    if (finalizeContent === undefined) return result
    const content = finalizeContent(exec, result)
    return content === undefined ? result : { ...result, content }
  }

  /** 通知观察者，不暴露通往结果的变更或错误通道。 */
  private notifyResult(exec: ToolExecution, result: ToolExecutionResult): void {
    // 在观察者收到其只读、可作 WeakMap 键的视图之前，冻结注册表的活跃对象。
    Object.freeze(exec)
    const { name: toolName, callId } = exec
    const reportFailure = (error: unknown): void => {
      this.ctx.logger.warn(`tool "${toolName}" (${callId}): tools/result observer failed: ${errorMessage(error)}`)
    }
    const callbacks = this.ctx.events.dispatch('emit', [
      scopeTarget(this, exec.agent), 'tools/result', exec, result,
    ])
    for (const callback of callbacks) {
      try {
        const returned: unknown = callback(exec, result)
        void Promise.resolve(returned).catch(reportFailure)
      } catch (error: unknown) {
        reportFailure(error)
      }
    }
  }

  /**
   * 经审批接缝把 `ask` 决策解析为 allow/deny。该接缝以 `ctx.get('approval')`
   * 机会式消费——未组合任何 ApprovalService 的部署保持历史上降级为 deny
   * 的行为，会话中途卸载也会在下一次 ask 时同样降级。无 agent 的执行同样
   * 降级：没有 agent 就没有可供审计的会话，也没有可路由的 UI。其余情况
   * 结果一一映射——`allowed-once` 继续；三个非授予各以不同理由拒绝，使
   * 模型能区分人的"否"与缺失的审批通道。
   */
  private async serviceAsk(
    exec: ToolExecution,
    ask: Extract<PreToolDecision, { kind: 'ask' }>,
  ): Promise<ToolAskResolution> {
    const approval = this.ctx.get('approval')
    if (approval === undefined) {
      return {
        decision: { kind: 'deny', reason: ask.reason ?? `tool "${exec.name}" requires approval (not yet supported)` },
        approvalCancelled: false,
      }
    }
    if (exec.agent === undefined) {
      return {
        decision: { kind: 'deny', reason: `tool "${exec.name}" requires approval, but the call has no agent to route it through` },
        approvalCancelled: false,
      }
    }
    const outcome = await approval.request({
      agent: exec.agent,
      toolName: exec.name,
      callId: exec.callId,
      ...ask.reason !== undefined ? { reason: ask.reason } : {},
      ...ask.displayReason !== undefined ? { displayReason: ask.displayReason } : {},
      signal: exec.signal,
    })
    switch (outcome) {
      case 'allowed-once': return { decision: { kind: 'allow' }, approvalCancelled: false }
      case 'rejected': return {
        decision: { kind: 'deny', reason: `the user rejected tool "${exec.name}"` },
        approvalCancelled: false,
      }
      case 'cancelled': return {
        decision: { kind: 'deny', reason: `approval for tool "${exec.name}" was cancelled` },
        approvalCancelled: true,
      }
      case 'unavailable': return {
        decision: { kind: 'deny', reason: `tool "${exec.name}" requires approval, but no approval channel is available` },
        approvalCancelled: false,
      }
      default: return assertNever(outcome, 'ApprovalOutcome')
    }
  }

  /**
   * 对一次已派发的 `result` 运行 `tools/post-execute` 瀑布并应用其
   * {@link PostToolDecision}：`accept` 保持调用成功（给定 `content` 时加以
   * 替换），`block` 把它变成 `isError`，其内容为纠正性的 `feedback`。两种
   * 决策都可附加 `additionalContexts`，它们随返回结果摆渡，供循环的活跃批
   * FIFO 使用。工具体延后的上下文在接受的结果中幸存，外层调用被阻止时被
   * 丢弃；阻止只暴露阻止决策显式提供的上下文。
   * 运行在 `execute` 的外层 try/catch 内（抛错的监听器 → isError）。
   */
  private async postExecute(exec: ToolExecution, result: ToolExecutionResult): Promise<ToolExecutionResult> {
    const decision = await this.ctx.waterfall(
      scopeTarget(this, exec.agent), 'tools/post-execute', exec, result,
      () => Promise.resolve<PostToolDecision>({ kind: 'accept' }),
    )
    const decisionContexts = decision.additionalContexts ?? []
    if (decision.kind === 'block') {
      const message = failureMessageFromContent(decision.feedback)
      return this.markCanonical(exec, {
        content: decision.feedback,
        isError: true,
        error: { message },
        ...decisionContexts.length > 0 ? { additionalContexts: decisionContexts } : {},
      })
    }
    if (Object.hasOwn(decision, 'content') && Object.hasOwn(decision, 'value')) {
      throw new TypeError('tools/post-execute accept decision cannot replace both value and content')
    }
    const additionalContexts = [
      ...result.additionalContexts ?? [],
      ...decisionContexts,
    ]
    if (Object.hasOwn(decision, 'value')) {
      if (result.isError) {
        throw new TypeError('tools/post-execute cannot replace the value of a failed result')
      }
      const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== undefined)
      if (tool === undefined) throw new ToolNotFoundError(exec.name)
      const replaced = this.createSuccessResult(exec, tool, decision.value)
      return this.markCanonical(exec, {
        ...replaced,
        ...additionalContexts.length > 0 ? { additionalContexts } : {},
      })
    }
    return this.markCanonical(exec, {
      ...result,
      ...decision.content !== undefined ? { content: decision.content } : {},
      ...additionalContexts.length > 0 ? { additionalContexts } : {},
    })
  }

  /** 注册表规范化的结果，以及验证每个值的精确派发。 */
  private readonly canonicalResults = new WeakMap<object, ToolExecutionToken>()

  /** 把一个注册表规范化结果标记为仅对其所属派发是规范的。 */
  private markCanonical<T extends ToolExecutionResult>(exec: ToolExecution, result: T): T {
    this.canonicalResults.set(result, exec.token)
    return result
  }

  /** 快照、验证、渲染一个成功的函数体值，并可选地投影呈现元数据。 */
  private createSuccessResult(exec: ToolExecution, tool: ToolDefinition, candidate: unknown): ToolExecutionSuccess {
    const detached = snapshotToolValue(tool.name, candidate)
    const violations = validateJsonSchemaValue(tool.output.schema, detached, 'value')
    if (violations.length > 0) throw new ToolOutputError(tool.name, violations)
    const value = deepFreeze(detached)
    let rendered: ContentBlock[]
    try {
      rendered = tool.output.render(exec.arguments, value)
    } catch (error: unknown) {
      throw projectionError(tool.name, 'render', error)
    }
    const content = snapshotProjection(tool.name, 'render', rendered)
    let meta: JsonValue | undefined
    if (tool.output.presentationMeta !== undefined) {
      let projected: JsonValue
      try {
        projected = tool.output.presentationMeta(exec.arguments, value)
      } catch (error: unknown) {
        throw projectionError(tool.name, 'presentationMeta', error)
      }
      meta = snapshotProjection(tool.name, 'presentationMeta', projected)
    }
    const concludesTurn = this.concludingExecutions.has(exec)
    return this.markCanonical(exec, this.materializeFinalResult({
      isError: false,
      value,
      content,
      ...meta !== undefined ? { meta } : {},
      ...concludesTurn ? { concludesTurn: true as const } : {},
    }) as ToolExecutionSuccess)
  }

  /** 经所属输出契约规范化 around 包装器自创的结果。 */
  private normalizeDispatchResult(exec: ToolExecution, result: ToolExecutionResult): ToolExecutionResult {
    if (this.canonicalResults.get(result) === exec.token) return result
    if (result.isError) {
      return this.markCanonical(exec, {
        isError: true,
        error: result.error,
        content: result.content,
        ...result.meta !== undefined ? { meta: result.meta } : {},
        ...result.additionalContexts !== undefined ? { additionalContexts: result.additionalContexts } : {},
      })
    }
    const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== undefined)
    if (tool === undefined) throw new ToolNotFoundError(exec.name)
    const normalized = this.createSuccessResult(exec, tool, result.value)
    return this.markCanonical(exec, {
      ...normalized,
      ...result.additionalContexts !== undefined ? { additionalContexts: result.additionalContexts } : {},
    })
  }

  /** 在 `tools/result` 之前恰好物化一次权威的提交结果。 */
  private materializeFinalResult(result: ToolExecutionResult): ToolExecutionResult {
    const presentation = {
      content: result.content,
      ...result.meta !== undefined ? { meta: result.meta } : {},
      ...result.additionalContexts !== undefined ? { additionalContexts: result.additionalContexts } : {},
    }
    if (result.isError) {
      return materializePresentation({ isError: true as const, error: result.error, ...presentation })
    }
    const detached = materializePresentation({
      isError: false as const,
      ...presentation,
      ...result.concludesTurn === true ? { concludesTurn: true as const } : {},
    })
    return deepFreeze({ ...detached, value: result.value })
  }
}

/** 铸造一个同一进程内的关联 token，其身份即其值。 */
function createExecutionToken(): ToolExecutionToken {
  return Symbol('dsh.tool.execution') as ToolExecutionToken
}

function toolErrorResult(error: unknown): ToolExecutionResult {
  const info = errorInfo(error)
  const message = errorMessage(error)
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
    error: { message, ...info ? { info } : {} },
  }
}

/** 跨越 await 读取实时中止状态，而不把它当作同步不可变。 */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

/**
 * 熔合调用方与包装器取消，而不嵌套 `AbortSignal.any`。
 * 让中继保持派发范围，还能在工作落定时移除监听器。
 */
function fuseToolSignals(caller: AbortSignal, wrapper: AbortSignal): FusedToolSignal {
  if (caller === wrapper) return { signal: caller, dispose() {} }

  const controller = new AbortController()
  let listening = false
  const dispose = (): void => {
    if (!listening) return
    listening = false
    caller.removeEventListener('abort', abortFromCaller)
    wrapper.removeEventListener('abort', abortFromWrapper)
  }
  const abortFrom = (source: AbortSignal): void => {
    const reason: unknown = source.reason
    controller.abort(reason)
    dispose()
  }
  const abortFromCaller = (): void => { abortFrom(caller) }
  const abortFromWrapper = (): void => { abortFrom(wrapper) }

  if (wrapper.aborted) abortFromWrapper()
  else if (caller.aborted) abortFromCaller()
  else {
    listening = true
    caller.addEventListener('abort', abortFromCaller, { once: true })
    wrapper.addEventListener('abort', abortFromWrapper, { once: true })
  }
  return { signal: controller.signal, dispose }
}

/** 函数体调用之后取消取代成功时的规范结果。 */
function toolAbortedResult(prior?: ToolExecutionResult): ToolExecutionResult {
  const additionalContexts = prior?.additionalContexts ?? []
  return {
    content: [{ type: 'text', text: 'Error: tool call aborted' }],
    isError: true,
    error: {
      message: 'tool call aborted',
      info: { name: 'AbortError', code: TOOL_ABORTED },
    },
    ...additionalContexts.length > 0 ? { additionalContexts } : {},
  }
}

/** 取消阻止工具体调用时的规范结果。 */
function toolAbortedBeforeDispatchResult(prior?: ToolExecutionResult): ToolExecutionResult {
  const additionalContexts = prior?.additionalContexts ?? []
  return {
    content: [{ type: 'text', text: 'Error: tool call aborted before dispatch' }],
    isError: true,
    error: {
      message: 'tool call aborted before dispatch',
      info: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH },
    },
    ...additionalContexts.length > 0 ? { additionalContexts } : {},
  }
}

export default ToolRuntime
