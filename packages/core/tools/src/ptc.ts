/**
 * PTC 模式的 `run_code` 传输层。程序通过在原生并发契约下调度的嵌套执行
 * 调用注册表中代理可见的工具；每个子分发都记录日志以便重建，而只有外层
 * 整理后的结果进入模型历史。
 * @module @deepseek-ai/dsh-tools/src/ptc
 */

import { symbols, type Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, HarnessError } from '@deepseek-ai/dsh-llm'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** 从成功的 PTC 子调用最终结果中延迟附加的图片。 */
    'ptc-mode': { kind: 'ptc-mode' }
  }
}

import type { ContentBlock, ToolCallId, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { PtcBindingFunction, PtcRunResult, PtcRunSandbox, PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import { approveEscalation, ESCALATION_TARGETS, validateEscalationArgs } from '@deepseek-ai/dsh-sandbox'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import { deepFreeze, snapshotJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool, parameterSchemaSpecToJsonSchema } from './schema.ts'
import { PtcCalls } from './ptc-calls.ts'
import { TOOL_RUNTIME_SCHEDULER } from './index.ts'
import type { PtcDispatchLog, ToolDefinition, ToolExecutionResult, ToolRuntime, ToolRunContext } from './index.ts'
import type {} from './types.ts'

/** PTC 模式工具面向模型的名称。 */
export const RUN_CODE_NAME = 'run_code'

/**
 * 各语言的 `run_code` 模式文本：工具的 `description` 与其 `code` 参数描述，
 * 两者放在一起，使一种语言的两个面向模型的字符串共享同一事实来源。以
 * `PtcRuntime.language` 为键，对应 {@link ./index.ts} 中的 `SDK_RENDERERS`。
 * 发出的 flavor 必须与同一语言的 SDK 指令承诺的语义一致，这样模型绝不会
 * 在 Python SDK 旁收到 TypeScript 模式（反之亦然）。
 */
interface RunCodeFlavor {
  /** 此语言下模型看到的工具 `description`。 */
  readonly description: string
  /** 此语言下 `code` 参数的描述。 */
  readonly codeDescription: string
}

/** 工具调用规则保存在此处；运行时负责求值语法与状态保留。 */
function runCodeFlavor(language: string, execution = {
  programDescription: 'the program to execute',
  outputInstruction: 'Curate the program output.',
  codeDescription: `The ${language} program to execute, following this tool's execution instructions.`,
}): RunCodeFlavor {
  return {
    description: `Execute a ${language} program against the available tools. Takes two required arguments: `
      + `\`code\`, ${execution.programDescription}, and \`description\`, a short summary of what the program does. `
      + 'Call tools as `await tools.name(args)` per the declarations in the system prompt. '
      + `${execution.outputInstruction} Image-bearing subtool results are attached after the run.`,
    codeDescription: execution.codeDescription,
  }
}

const TYPESCRIPT_FLAVOR = runCodeFlavor('TypeScript')
const TYPESCRIPT_FUNCTION_FLAVOR = runCodeFlavor('TypeScript', {
  programDescription: 'the BODY of an async function (erasable syntax only; top-level `await` and `return` work)',
  outputInstruction: 'Only what you print or return is program output — curate it.',
  codeDescription: 'The program: the body of an async TypeScript function.',
})
const PYTHON_FLAVOR = runCodeFlavor('Python')

/**
 * PTC 模式提供了展示的语言。两张按语言划分的表——此处的 {@link RUN_CODE_FLAVORS}
 * 与 {@link ./index.ts} 中的 `SDK_RENDERERS`——都用 `satisfies` 对照该联合类型
 * 检查，因此只加入其中一张表的语言会让 `typecheck` 失败，而不必等某个运行时
 * 报告它。这两张表仍声明为 `Record<string, …>`，因为 `PtcRuntime.language`
 * 是不受约束的 `string`：该联合类型固定 harness 附带的内容，而 `Object.hasOwn`
 * 守卫拒绝已挂载运行时可能报告的其他值。
 */
export type PtcSdkLanguage = 'typescript' | 'python'

/** 各语言的 `run_code` 模式 flavor（见 {@link RunCodeFlavor}）；每个 {@link PtcSdkLanguage} 一项。 */
const RUN_CODE_FLAVORS: Record<string, RunCodeFlavor> = {
  typescript: TYPESCRIPT_FLAVOR,
  python: PYTHON_FLAVOR,
} satisfies Record<PtcSdkLanguage, RunCodeFlavor>

/**
 * `description` 参数面向模型的描述：与语言无关（UI 标签契约对所有运行时
 * 相同），由静态规范与感知语言的 `parameters` getter 共享，使两次发出
 * 永远不会漂移。
 */
const RUN_CODE_DESCRIPTION_PARAM_DESCRIPTION
  = 'Clear, concise description of what this program does in active voice, '
    + '5-10 words (shown in the UI). '
    + 'Examples: "Count TODO markers across packages"; '
    + '"Read failing test and its fixture"; "Rename config key in every cordis.yml".'

const RUN_CODE_CONTROLS = {
  timeoutMs: { type: 'number', description: 'Positive elapsed-time budget in milliseconds, capped by the deployment maximum.' },
  sandbox_permissions: { type: 'string', enum: [...ESCALATION_TARGETS], description: 'Wider sandbox mode for this complete program execution; requires justification and approval.' },
  justification: { type: 'string', description: 'Reason this complete program needs wider access, shown to the user for approval. Use the language of the user’s current request.' },
} as const

function controlParameters(runtime: PtcRuntime | undefined) {
  // 目录读取器没有挂载运行时；真正的模型组装需要运行时。
  if (runtime === undefined) return RUN_CODE_CONTROLS
  return {
    ...runtime.timeout === undefined ? {} : {
      timeoutMs: { ...RUN_CODE_CONTROLS.timeoutMs,
        description: `Positive elapsed-time budget in milliseconds, including nested tool and approval waits. Default ${runtime.timeout.defaultMs}; capped at ${runtime.timeout.maxMs}. Zero does not disable the deadline.` },
    },
    ...runtime.sandboxMode === undefined ? {} : {
      sandbox_permissions: RUN_CODE_CONTROLS.sandbox_permissions,
      justification: RUN_CODE_CONTROLS.justification,
    },
  }
}

function escalationGuidance(runtime: PtcRuntime | undefined): string {
  return runtime?.sandboxMode === undefined ? ''
    : ' A sandbox escalation approves this complete program for one execution only. Nested tools retain their own policies and approvals. Request wider access only after evidence of a denial. Earlier effects may already have completed: inspect them before explicitly retrying. Programs are never replayed automatically.'
}

/**
 * 为已加载运行时的语言解析 {@link RunCodeFlavor}，在模式发出时读取，使
 * 面向模型的 `run_code` 模式始终与 SDK 章节的语言一致。`peekRuntime` 仅在
 * 未挂载运行时时返回 `undefined`，该情况经定义读取器和 `schemas()` 到达
 * 此函数——文档目录收割是唯一随附的读取器，且都不喂给模型，因为
 * `wireSchemas` 在投影前会调用 `requirePtcRuntime`——所以该路径退化为
 * {@link TYPESCRIPT_FLAVOR}。已挂载运行时的语言没有 flavor 条目时响亮
 * 失败，与 `requirePtcRuntime` 在组装时拒绝它完全一致。让这张表与
 * `SDK_RENDERERS` 保持同步是编译器的职责（{@link PtcSdkLanguage}）；本守卫
 * 负责的是两张表都不知道的运行时提供的语言，它绝不会为真实运行时产生
 * 错误语言的模式。
 */
function resolveFlavor(peekRuntime: () => PtcRuntime | undefined): RunCodeFlavor {
  const runtime = peekRuntime()
  if (runtime === undefined) {
    // 未挂载运行时：经定义读取器和 `schemas()` 到达，其中文档目录收割是
    // 唯一随附的读取器。都不喂给模型——`wireSchemas` 在投影前调用
    // `requirePtcRuntime`，因此组装路径永远不会到这里。退化为 TS 默认值。
    return TYPESCRIPT_FLAVOR
  }
  // 自有属性读取：否则像 `toString`/`constructor` 这样的语言会把继承的
  // Object.prototype 成员解析成 flavor。
  const flavor = RUN_CODE_FLAVORS[runtime.language]
  if (!Object.hasOwn(RUN_CODE_FLAVORS, runtime.language) || flavor === undefined) {
    const known = Object.keys(RUN_CODE_FLAVORS).map(name => JSON.stringify(name)).join(', ')
    throw new Error(`dsh-tools: no run_code schema flavor registered for runtime language ${JSON.stringify(runtime.language)} (known: ${known})`)
  }
  return runtime.language === 'typescript' && runtime.programFormat === 'function-body'
    ? TYPESCRIPT_FUNCTION_FLAVOR : flavor
}

/**
 * 程序运行本身失败时由 `run_code` 抛出——程序异常、预算到期、中止或底座
 * 死亡。扩展 {@link HarnessError}（`code: 'CODE_RUN_FAILED'`）；注册表的
 * 执行管线将其转换为结构化的 `isError` 结果，其文本携带失败类别与捕获的
 * 日志，使模型能够自我纠正。
 */
export class CodeRunFailedError extends HarnessError {
  constructor(message: string) {
    super(message, 'CODE_RUN_FAILED')
    this.name = 'CodeRunFailedError'
  }
}

/**
 * 将一次绑定调用的参数快照为无损 JSON，再对该脱离后的值重新快照，使分发
 * 与日志记录相互独立，又不重新引入结构化克隆的平台相关嵌套上限。
 */
function jsonNormalizeArgs(value: unknown): { dispatched: unknown; logged: unknown } {
  let snapshot: JsonValue | undefined
  try {
    snapshot = snapshotJsonValue(value) as JsonValue | undefined
  } catch (error: unknown) {
    throw new Error(`tool arguments must be lossless JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (snapshot === undefined) {
    throw new Error('tool arguments must be lossless JSON (call the tool with an arguments object, e.g. `{}`)')
  }
  const logged = snapshotJsonValue(snapshot)
  /* v8 ignore next -- snapshot is already a detached lossless JSON value. */
  if (logged === undefined) {
    throw new Error('tool arguments could not be detached for durable logging')
  }
  return { dispatched: snapshot, logged }
}

/** 两空格 JSON 展示，与现有的浅层 `run_code` 文本契约一致。 */
const JSON_INDENT = '  '

/**
 * ECMAScript 将 `JSON.stringify` 的 `space` 字符串限制在十个字符内。渲染器
 * 也将总缩进限制在该值，压缩更深的子树，使格式化输出在规范 JSON 大小上
 * 保持线性。
 */
const MAX_JSON_INDENT_CHARS = 10

/** 迭代式 JSON 展示遍历中的一个待处理片段。 */
type JsonRenderTask =
  | { kind: 'text'; text: string }
  | { kind: 'value'; value: JsonValue; depth: number; compact: boolean }

/** 渲染一个非字符串 JSON 根，不使用递归遍历，缩进也不无界增长。 */
function renderJsonValue(value: Exclude<JsonValue, string>): string {
  const chunks: string[] = []
  const tasks: JsonRenderTask[] = [{ kind: 'value', value, depth: 0, compact: false }]
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    if (task.kind === 'text') {
      chunks.push(task.text)
      continue
    }

    const current = task.value
    if (current === null || typeof current === 'boolean' || typeof current === 'number') {
      chunks.push(String(current))
      continue
    }
    if (typeof current === 'string') {
      chunks.push(JSON.stringify(current))
      continue
    }

    const compact = task.compact || (task.depth + 1) * JSON_INDENT.length > MAX_JSON_INDENT_CHARS
    const childDepth = task.depth + 1
    if (Array.isArray(current)) {
      chunks.push('[')
      if (current.length === 0) {
        chunks.push(']')
        continue
      }
      tasks.push({ kind: 'text', text: compact ? ']' : `\n${JSON_INDENT.repeat(task.depth)}]` })
      for (let index = current.length - 1; index >= 0; index--) {
        const item = current[index]
        /* v8 ignore next -- canonical JsonValue arrays are dense. */
        if (item === undefined) throw new Error('cannot render a sparse JSON array')
        tasks.push({ kind: 'value', value: item, depth: childDepth, compact })
        tasks.push({
          kind: 'text',
          text: compact
            ? index === 0 ? '' : ','
            : `${index === 0 ? '\n' : ',\n'}${JSON_INDENT.repeat(childDepth)}`,
        })
      }
      continue
    }

    const keys = Object.keys(current)
    chunks.push('{')
    if (keys.length === 0) {
      chunks.push('}')
      continue
    }
    tasks.push({ kind: 'text', text: compact ? '}' : `\n${JSON_INDENT.repeat(task.depth)}}` })
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index]
      /* v8 ignore next -- the loop is bounded by the captured key count. */
      if (key === undefined) throw new Error('cannot render a missing JSON object key')
      const item = current[key]
      /* v8 ignore next -- canonical JsonValue records contain no undefined properties. */
      if (item === undefined) throw new Error('cannot render an undefined JSON object property')
      tasks.push({ kind: 'value', value: item, depth: childDepth, compact })
      tasks.push({
        kind: 'text',
        text: compact
          ? `${index === 0 ? '' : ','}${JSON.stringify(key)}:`
          : `${index === 0 ? '\n' : ',\n'}${JSON_INDENT.repeat(childDepth)}${JSON.stringify(key)}: `,
      })
    }
  }
  return chunks.join('')
}

/** 为面向模型的结果文本渲染一个可展示的程序完成值。 */
function renderValue(value: JsonValue): string {
  return typeof value === 'string' ? value : renderJsonValue(value)
}

/** 外层 PTC 模式传输层返回的规范值。 */
type RunCodeOutput = { logs: string[]; result?: JsonValue; sandbox?: PtcRunSandbox }

/**
 * 桥接层在构造时收到的注册表私有能力——`requireRuntime` 惯用法：只有
 * 持有注册表能铸造的操作不进入其公共服务 API，而以闭包形式流入此处。
 */
export interface RunCodeBridgeOptions {
  /** 在程序创建前捕获调用方 Session 的当前目录。 */
  resolveWorkingDirectory: (exec: ToolRunContext) => Promise<string | undefined>
  /** 当程序请求更宽的沙箱模式时读取审批通道。 */
  peekApprover: () => ApprovalService | undefined
  /** 仅为执行文件策略的运行时解析常设 Session 权限。 */
  resolveSandboxPolicy: (exec: ToolRunContext) => SandboxExecutionPolicy
  /** 解析 `ctx.ptcRuntime` 或抛出响亮的配置错误（与注册表组装时检查共享）。 */
  requireRuntime: () => PtcRuntime
  /**
   * 不抛出地读取 `ctx.ptcRuntime`：未挂载时为 `undefined`。让模式发出能区分
   * "无运行时"（退化为 TS；到达此处的读取器见 {@link resolveFlavor}）与
   * "未知语言"（响亮失败）。
   */
  peekRuntime: () => PtcRuntime | undefined
  /** 运行对并行类子调用的重叠上限（注册表传入其已验证的 `maxParallelSubCalls`）。 */
  maxParallel: number
  /** 对一个已落定的子分发运行内聚的 `tools/ptc-dispatch-log` 瀑布（注册表的私有调用器）。 */
  shapeDispatchLog: (dispatch: PtcDispatchLog) => Promise<ContentBlock[]>
}

/**
 * 构建 `run_code` {@link ToolDefinition}：必需的 `code` 与 `description`
 * 参数，通过上述分发桥执行。注册表在非原生模式下将其保留为展示基础设施，
 * 位于可过滤的全局/作用域能力层之外。
 * @param registry - 持有的注册表（子调用经其 `execute` 进行，绑定覆盖其
 *   注册的工具）。
 * @param options - 上述注册表私有能力。
 * @param ctx - 持有注册表的上下文，独立于调用的 Agent。
 * @returns 注册表就绪的定义。
 */
export function createRunCodeTool(registry: ToolRuntime, options: RunCodeBridgeOptions, ctx: Context): ToolDefinition {
  const { requireRuntime, peekRuntime, maxParallel, shapeDispatchLog } = options
  const stateOwners = new WeakMap<object, WeakSet<PtcRuntime>>()
  const calls = new PtcCalls(ctx)
  const definition = defineTool({
    name: RUN_CODE_NAME,
    // 这里的 description 与 `code` 参数描述只是占位符：下方安装的感知语言的
    // getter 会替换两者，在模式发出时解析已加载运行时的 flavor，使 MODEL
    // 看到的模式与 SDK 章节的语言一致。参数 VALIDATION 仍以此静态规范为准
    // （defineTool 闭包引用它），它与语言无关（一个必填字符串 `code`）。
    description: TYPESCRIPT_FLAVOR.description,
    parameters: {
      code: { type: 'string', required: true, description: TYPESCRIPT_FLAVOR.codeDescription },
      description: {
        type: 'string',
        required: true,
        description: RUN_CODE_DESCRIPTION_PARAM_DESCRIPTION,
      },
      ...RUN_CODE_CONTROLS,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          logs: { type: 'array', required: true, items: { type: 'string' } },
          result: { type: 'json' },
          sandbox: {
            type: 'object',
            additionalProperties: false,
            properties: {
              mode: { type: 'string', required: true, enum: ['read-only', 'workspace-write', 'danger-full-access'] },
              denied: { type: 'boolean', required: true },
              enforcement: { type: 'string', enum: ['full', 'partial'] },
            },
          },
        },
      },
      render: (_args, value) => {
        const rendered = value.result === undefined ? '' : renderValue(value.result)
        const parts = [value.logs.join('\n'), rendered].filter(part => part.length > 0)
        if (value.sandbox?.enforcement === 'partial') parts.push('File sandbox enforcement is partial on this host.')
        if (value.sandbox?.denied) parts.push(`The ${value.sandbox.mode} file sandbox denied an operation.${escalationGuidance(peekRuntime())}`)
        return [{ type: 'text', text: parts.length > 0 ? parts.join('\n') : '(run_code completed with no output)' }]
      },
    },
    async execute(args, exec): Promise<RunCodeOutput> {
      if (args.description.trim().length === 0) {
        throw new Error('invalid description: expected a non-empty string')
      }
      const runtime = requireRuntime()
      const run = async (callSignal: AbortSignal): Promise<RunCodeOutput> => {
        validateEscalationArgs(args.sandbox_permissions, args.justification)
        if (args.timeoutMs !== undefined && runtime.timeout === undefined) {
          throw new Error('timeoutMs is not available for this PTC runtime')
        }
        if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
          throw new Error('invalid timeoutMs: expected a positive finite number')
        }
        const standingPolicy = runtime.sandboxMode === undefined ? undefined : options.resolveSandboxPolicy(exec)
        let policy = standingPolicy
        if (args.sandbox_permissions !== undefined && args.justification !== undefined) {
          if (standingPolicy === undefined) throw new Error('sandbox_permissions is not available for this PTC runtime')
          const approvedMode = await approveEscalation({
            requestedMode: args.sandbox_permissions,
            justification: args.justification,
            effectiveMode: standingPolicy.mode,
            subject: 'program',
          }, {
            approver: options.peekApprover(), agent: exec.agent, callId: exec.callId,
            toolName: RUN_CODE_NAME, signal: callSignal,
          })
          policy = { ...standingPolicy, mode: approvedMode }
        }
        const cwd = await options.resolveWorkingDirectory({ ...exec, signal: callSignal })
        callSignal.throwIfAborted()

        // 运行级中止：跟随外层信号进入，并在运行因任何原因落定时触发，使
        // 进行中的子分发被中止（其执行器在该信号上终止）而非成为孤儿，
        // 排队未启动的分发则被放弃。
        const runController = new AbortController()
        const onOuterAbort = (): void => { runController.abort(callSignal.reason) }
        callSignal.addEventListener('abort', onOuterAbort, { once: true })

        let dispatches = 0
        // 每次运行的调度器使用注册表的分阶段接口，并遵循与原生循环相同的
        // 并发规则。它还遵循原生循环的顺序性：每个有序阶段（dispatch-start
        // 追加、prepare = 执行前/守卫、finalize/finish = 执行后、上下文延后、
        // settle 追加）都在同一条驱动车道内运行，因此有序策略阶段彼此不重叠，
        // 只有 around-dispatch/body 阶段并发运行。启动严格按提交顺序；结果
        // 通过队首游标按提交顺序提交。连续的并行类调用最多重叠 maxParallel
        // 个；独占调用等待池排空、单独运行，并在其 COMMIT（含执行后）完成前
        // 保持屏障，与原生独占组完全一致。每次启动前立即通过 executionMode()
        // 重新读取分类（排队期间注册表变更可将调用翻转为独占），与原生调度器
        // 的惰性重分类一致。
        interface PendingDispatch {
          /** 有序阶段：追加启动事件，等待 prepare（执行前/守卫），将主体启动到 `flight`。 */
          start(): Promise<void>
          classify(): 'parallel' | 'exclusive'
          abandon(): void
          /** 有序阶段：执行后 + 上下文延后 + settle 事件，按提交顺序。 */
          commit(): Promise<void>
          /** 已启动的 around-dispatch/body 阶段；在 start() 替换前为已解决状态。 */
          flight: Promise<void>
          /** 分发阶段寄存其结果后为真；提交游标等待它。 */
          settled: boolean
          /** 本条目启动时的分类；独占在 commit() 期间保持其屏障。 */
          mode?: 'parallel' | 'exclusive'
        }
        const pendingQueue: PendingDispatch[] = []
        const inFlight = new Set<Promise<void>>()
        /** 被跟踪的 settle 事件副工作（日志内容监听器 + 追加），在运行落定时排空。 */
        const logWork = new Set<Promise<void>>()
        const commitQueue: PendingDispatch[] = []
        let exclusiveActive = false
        let driving = false
        let driverRun: Promise<void> = Promise.resolve()
        let wake: (() => void) | undefined
        const wakeup = (): void => {
          const release = wake
          wake = undefined
          release?.()
        }
        /**
         * 唯一的有序车道。每轮先提交队首已落定的分发（有序执行后），然后在
         * 槽位空闲时启动下一个排队条目（有序执行前），否则休眠，直到某个
         * 主体落定或新提交到达。一次运行达到空队列/空池状态即为静止。
         */
        const drive = (): Promise<void> => {
          if (driving) return driverRun
          driving = true
          driverRun = (async () => {
            try {
              for (;;) {
                // 在检查状态前创建唤醒 promise，使检查与下方 await 之间到达的
                // 落定或提交不会丢失。
                const signal = new Promise<void>((resolve) => { wake = resolve })
                const commitHead = commitQueue[0]
                if (commitHead !== undefined && commitHead.settled) {
                  commitQueue.shift()
                  await commitHead.commit()
                  // 屏障覆盖执行后：后续启动等待独占调用的完整管线，与原生
                  // 循环一致。
                  if (commitHead.mode === 'exclusive') exclusiveActive = false
                  continue
                }
                const head = pendingQueue[0]
                if (head !== undefined) {
                  if (runController.signal.aborted) {
                    pendingQueue.shift()
                    head.abandon()
                    continue
                  }
                  // 启动时重新分类（注册表变更时失败关闭）。
                  const mode = head.classify()
                  const capacity = !exclusiveActive
                    && (mode === 'exclusive' ? inFlight.size === 0 : inFlight.size < maxParallel)
                  if (capacity) {
                    if (mode === 'exclusive') exclusiveActive = true
                    head.mode = mode
                    pendingQueue.shift()
                    // 在 start() 前加入，使提交游标看到提交顺序；`settled`
                    // 翻转前不会有任何东西提交它。
                    commitQueue.push(head)
                    await head.start()
                    const flight: Promise<void> = head.flight.finally(() => {
                      inFlight.delete(flight)
                      wakeup()
                    })
                    inFlight.add(flight)
                    continue
                  }
                }
                if (pendingQueue.length === 0 && commitQueue.length === 0 && inFlight.size === 0) return
                await signal
              }
            } finally {
              driving = false
              wake = undefined
            }
          })()
          return driverRun
        }
        /** 每个分发都已落定并提交；不能再启动任何东西（运行在调用时已被中止）。 */
        const drainDispatches = async (): Promise<void> => {
          // 中止已触发：驱动器放弃排队未启动的条目，等待存活池，并排空有序
          // 提交车道——包括程序返回时已在进行的提交。
          await drive()
          // 每个 settle 事件都在打开的 run_code 轮次内追加（任务在落定时
          // 自行移除）。
          while (logWork.size > 0) await Promise.allSettled([...logWork])
        }

        // 通过调用读取，而非裸属性：中止状态在 await 之间确实会变化，一次
        // await 之后直接重查 `.aborted` 会被控制流分析收窄掉。
        const runOver = (): boolean => runController.signal.aborted

        const binding = (schema: ToolSchema): PtcBindingFunction => async (rawArgs: unknown): Promise<JsonValue> => {
          const { name } = schema
          if (runOver()) {
            throw new Error(`run_code run is over (${String(runController.signal.reason)}); ${name} not dispatched`)
          }
          const normalized = jsonNormalizeArgs(rawArgs)
          const n = ++dispatches
          const subCallId = brandString<ToolCallId>(`${String(exec.callId)}:ptc:${n}`)
          const input = {
            callId: subCallId,
            rootCallId: exec.rootCallId,
            name,
            schema,
            arguments: normalized.dispatched,
            ...exec.agent ? { agent: exec.agent } : {},
            parent: exec.token,
            signal: runController.signal,
          }
          type DispatchOutcome = { isError: true; message: string } | { isError: false; value: JsonValue }
          const scheduler = registry[TOOL_RUNTIME_SCHEDULER]
          const outcome = await new Promise<DispatchOutcome>((resolve, reject) => {
            // 由分发阶段设置（预落定结果则由 start() 设置）：commit() 按提交顺序最终化该结果。
            let parked:
              | { kind: 'post-result' | 'final-result'; exec: ToolRunContext; result: ToolExecutionResult }
              | undefined
            const settle = (result: ToolExecutionResult): void => {
              // 程序现在就拿到值：日志内容监听器（例如溢出后端）绝不能延迟
              // 绑定或占用分发槽位。事件追加是被跟踪的副工作；运行落定时会
              // 排空 logWork，使每个 settle 事件仍在打开的轮次内追加
              // （shapeDispatchLog 是内聚的，因此该链不会拒绝）。
              resolve(result.isError
                ? { isError: true, message: result.error.message }
                : { isError: false, value: result.value })
              const agent = exec.agent
              if (agent === undefined) return
              const task: Promise<void> = (async () => {
                // 监听器可能用预览与定位器替换持久副本；程序的值与面向模型
                // 的结果不受影响。
                const logged = await shapeDispatchLog({
                  exec, agent, subCallId, name, isError: result.isError,
                  // 注册表在结果最终化时深冻结此投影；追加时再次快照最终
                  // 副本，使日志保持脱离。
                  content: result.content,
                })
                agent.session.append('tool/ptc-dispatch', {
                  rootCallId: exec.rootCallId,
                  parentCallId: exec.callId,
                  subCallId,
                  name,
                  // 已分发值的兄弟解析：字节相同的 JSON，但是独立对象——
                  // 工具变更其参数也无法使此记录与实际收到的内容失步。
                  arguments: normalized.logged,
                  isError: result.isError,
                  ...result.error?.info === undefined ? {} : { error: result.error.info },
                  content: logged,
                  ...result.meta === undefined ? {} : { meta: result.meta },
                })
              })().finally(() => { logWork.delete(task) })
              logWork.add(task)
            }
            pendingQueue.push({
              flight: Promise.resolve(),
              settled: false,
              // 每轮驱动按 SDK 声明的同一 agent 视图重新读取；未声明/无效时
              // 失败关闭为独占。
              classify: () => registry.executionMode(input).kind,
              abandon: () => {
                reject(new Error(`run_code run is over (${String(runController.signal.reason)}); ${name} tool call abandoned`))
              },
              async start(): Promise<void> {
                exec.agent?.session.append('tool/ptc-dispatch-start', {
                  rootCallId: exec.rootCallId,
                  parentCallId: exec.callId,
                  subCallId,
                  name,
                  arguments: normalized.logged,
                })
                // 有序 prepare 在驱动车道内运行：下一个条目的执行前等待此次
                // 解析，与原生调度器一致。只有下方已启动的主体并发。
                const prepared = await scheduler.prepare(input)
                if (prepared.kind === 'dispatch') {
                  this.flight = scheduler.dispatch(prepared.exec).then((dispatchOutcome) => {
                    parked = { kind: dispatchOutcome.kind, exec: prepared.exec, result: dispatchOutcome.result }
                    this.settled = true
                  })
                  return
                }
                parked = { kind: prepared.kind, exec: prepared.exec, result: prepared.result }
                this.settled = true
              },
              async commit(): Promise<void> {
                /* v8 ignore next -- commit() runs only after `settled` flipped, which set parked. */
                if (parked === undefined) return
                const result = parked.kind === 'post-result'
                  ? await scheduler.finalize(parked.exec, parked.result)
                  : scheduler.finish(parked.exec, parked.result)
                if (!result.isError && result.content.some(block => block.type === 'image')) {
                  exec.deferContext(createUserMessage({
                    content: result.content,
                    source: { kind: 'ptc-mode' },
                  }))
                }
                for (const context of result.additionalContexts ?? []) {
                  exec.deferContext(context)
                }
                // 复合层从嵌套结果向上转发 `additionalContexts`，并在此处转发
                // `concludesTurn`。只有成功的嵌套结果才能携带终止标记
                // （ToolExecutionFailure 的类型绝不可能），因此策略转换的失败
                // 无法经由恢复中的程序停止轮次。
                if (result.concludesTurn) exec.concludeTurn()
                settle(result)
                // 对待处理事件追加任务的背压：慢后端存储期间每个任务都持有
                // 完整结果，因此池上限约束其数量。超过上限时有序车道等待，
                // 后续子调用无法启动，待处理 I/O/内存也不会无界增长。
                while (logWork.size > maxParallel) await Promise.race(logWork)
              },
            })
            wakeup()
            void drive()
          })
          // 此调用在飞行中发生的预算到期或外层取消已经中止了分发；现在停止
          // 程序，而不是把已结束运行的结果交给它。
          if (runOver()) {
            throw new Error(`run_code run is over (${String(runController.signal.reason)}); ${name} result discarded`)
          }
          // 工作进程将绑定拒绝转换为 ToolCallError，并只附加绑定名。原生内容
          // 与内部错误元数据不进入面向程序的失败契约。
          if (outcome.isError) throw new Error(outcome.message)
          return outcome.value
        }

        // 空原型 + defineProperty，对应工作进程侧的命名空间构建：名为
        // `__proto__` 的注册工具必须成为普通自有键（普通对象赋值会命中原型
        // setter，静默丢弃绑定），且运行时宿主只将绑定名解析为自有属性。
        const functions: Record<string, PtcBindingFunction> = Object.create(null) as Record<string, PtcBindingFunction>
        // 枚举调用 AGENT 的可见集合（作用域工具加入，受限全局消失）——与
        // SDK 章节声明的视图相同，使程序能绑定其提示词承诺的全部内容；
        // 子分发按调用经同一视图重新解析（exec.agent 逐层下传）。
        for (const schema of registry.schemas(exec.agent)) {
          if (schema.name === RUN_CODE_NAME) continue
          Object.defineProperty(functions, schema.name, { enumerable: true, value: binding(deepFreeze(schema)) })
        }

        try {
          let result: PtcRunResult
          try {
            if (exec.agent !== undefined) {
              const agent = exec.agent
              let runtimes = stateOwners.get(agent)
              if (runtimes === undefined) stateOwners.set(agent, runtimes = new WeakSet())
              // Cordis 可能反复包装服务返回值；清理归属于最初的提供方。
              let provider = runtime
              for (;;) {
                const original = (provider as PtcRuntime & { [symbols.original]?: PtcRuntime })[symbols.original]
                if (original === undefined) break
                provider = original
              }
              if (!runtimes.has(provider)) {
                agent.ctx.effect(() => () => runtime.release(agent), 'PTC retained environment')
                runtimes.add(provider)
              }
            }
            result = await runtime.run(runtime.resolve({
              program: args.code,
              ...exec.agent === undefined || policy?.mode !== standingPolicy?.mode ? {} : { stateOwner: exec.agent },
              bindings: [{
                global: 'tools',
                functions,
                errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' },
              }],
              signal: runController.signal,
              ...cwd !== undefined ? { cwd } : {},
              ...policy !== undefined ? { sandboxPolicy: policy } : {},
              ...args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {},
            }))
          } finally {
            // 在关闭轮次前中止子分发并排空每个进行中的分发（排队未启动的
            // 被放弃且不记日志）。绑定失败仍可通过各自的 promise 观测到。
            runController.abort('run_code settled')
            await drainDispatches()
          }

          if (result.error) {
            const logsText = result.logs.length > 0 ? `\nCaptured output:\n${result.logs.join('\n')}` : ''
            const sandboxText = result.sandbox === undefined ? ''
              : `\nFile sandbox: ${result.sandbox.mode}${result.sandbox.enforcement === undefined ? '' : `; enforcement: ${result.sandbox.enforcement}`}${result.sandbox.denied ? '; operation denied' : ''}.`
            throw new CodeRunFailedError(`code run failed (${result.error.kind}): ${result.error.message}${logsText}${sandboxText}${result.sandbox?.denied ? escalationGuidance(runtime) : ''}`)
          }
          return {
            logs: result.logs,
            ...result.sandbox === undefined ? {} : { sandbox: result.sandbox },
            ...result.value !== undefined ? { result: result.value } : {},
          }
        } finally {
          callSignal.removeEventListener('abort', onOuterAbort)
        }
      }
      return runtime.sandboxMode === undefined || exec.agent === undefined ? run(exec.signal)
        : calls.run(exec.agent.session.id, exec.signal, () => options.resolveSandboxPolicy(exec).mode, run)
    },
    // 模型撰写的 description 是调用始终可见的 UI 标签（bash `description`
    // 的先例）；程序本身放在 rawInput 中。
    presentCall: args => ({
      card: 'generic',
      title: args.description,
      kind: 'execute',
      rawInput: args.code,
    }),
    // 刻意不提供 presentResult：通用卡片回退保留此标题并读取持久结果内容，
    // 不把大型原始结果复制进宿主视图载荷。
  })
  // 惰性解析语言 flavor，在注册表投影模式的时刻（`schemaOf` 解构
  // `description`/`parameters`）。定义在注册时铸造一次，早于运行时可知；
  // 在此处延迟是仍能发出已加载运行时语言的侵入最小的点。
  Object.defineProperty(definition, 'description', {
    enumerable: true,
    get: () => {
      const runtime = peekRuntime()
      const instructions = runtime?.executionInstructions
      return resolveFlavor(peekRuntime).description
        + (instructions ? ` ${instructions}` : '')
        + (runtime === undefined ? '' : " Each program starts in the Session's current directory. Running programs keep their initial directory.")
        + escalationGuidance(runtime)
    },
  })
  Object.defineProperty(definition, 'parameters', {
    enumerable: true,
    // 经 defineTool 使用的同一 spec→schema 投影重新编译，使发出的模式始终
    // 与已验证的规范一致。
    get: () => parameterSchemaSpecToJsonSchema({
      code: { type: 'string', required: true, description: resolveFlavor(peekRuntime).codeDescription },
      description: { type: 'string', required: true, description: RUN_CODE_DESCRIPTION_PARAM_DESCRIPTION },
      ...controlParameters(peekRuntime()),
    }),
  })
  return definition
}
