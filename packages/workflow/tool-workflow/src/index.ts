/**
 * 模型面向的 `workflow` 工具：运行一段 JavaScript 编排脚本，扇出子代理，
 * 并返回脚本的最终值。它拥有模型可见的 schema 与运行生命周期；脚本解析、
 * 执行、额度与取消则置于 `ctx.workflowEngine`（`@deepseek-ai/dsh-workflow`）
 * 之后，这样换入一个加固过的引擎无需触碰模型所见内容。前台执行会等待
 * `run.result` 且总会释放该运行；非 `completed` 的结束原因会变为工具错误。
 * `run_in_background: true` 则将该运行登记为一个受管的 `ctx.jobs` job，
 * 并立即返回其 id —— job 的输出环形缓冲会流式推送实时进度，运行的值
 * 随 job 的完成通知一同到达。呈现是一个仅含参数的通用卡片，标题取自
 * `meta.name`。显式询问的使用指引作为工具自身的提示段落而非部署人设文案登记。
 * @module @deepseek-ai/dsh-tool-workflow
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JobId, JobOutcome, JobToolCall } from '@deepseek-ai/dsh-jobs'
import type { Session, SessionEventMap } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {
  WorkflowResult, WorkflowRun, WorkflowRunId, WorkflowStopReason,
} from '@deepseek-ai/dsh-workflow'
import { createWorkflowRecordMirror } from './record.ts'
import type { WorkflowRecordMirror } from './record.ts'
import type {
  ToolWorkflowAgentEndData, ToolWorkflowAgentStartData,
  ToolWorkflowRunEndData, ToolWorkflowRunStartData,
} from './types.ts'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    workflow: 'workflow'
  }
}

export const name = 'tool-workflow'
export const inject = ['tools', 'workflowEngine', 'systemPrompt']

/** 配置：模型可见的工具名，以及结果渲染额度。 */
export interface Config {
  /** 要登记的模型可见工具名（默认 `workflow`）。 */
  toolName?: string
  /** 渲染结果的字符上限：超过的 JSON 值会带提示被截断（默认 50000）。 */
  maxResultChars?: number
  /**
   * 是否暴露 `run_in_background`（默认 true）；禁用时调用也会被拒绝。
   * 后台运行需要一个带有为调用方提供服务的控制器的存活 `ctx.jobs` 注册表
   * （shipped 组合中的 `dsh-jobs-local` 加 `dsh-tool-jobs`）；缺少时调用会
   * 以缺失的组件命名而失败。
   */
  enableRunInBackground?: boolean
}

export const Config: z<Config> = z.object({
  toolName: z.string().default('workflow'),
  maxResultChars: z.natural().min(1).default(50_000),
  enableRunInBackground: z.boolean().default(true),
})

type ResolvedConfig = Required<Config>

interface WorkflowRecorder {
  start(session: Session, run: WorkflowRun): void
  finish(runId: WorkflowRunId, stopReason: WorkflowStopReason): void
  abandon(runId: WorkflowRunId): void
}

interface ToolWorkflowRecordEventMap {
  'tool-workflow/run-start': ToolWorkflowRunStartData
  'tool-workflow/agent-start': ToolWorkflowAgentStartData
  'tool-workflow/agent-end': ToolWorkflowAgentEndData
  'tool-workflow/run-end': ToolWorkflowRunEndData
}

/** 渲染一个被隔离的录制失败，而不信任被抛出的值。 */
function renderRecordingError(error: unknown): string {
  try {
    return String(error)
  } catch {
    return '[unrenderable thrown value]'
  }
}

/**
 * 在不让录制失败影响工具执行的前提下，将活跃顶层 workflow 运行映射到
 * 它们的父 Session。
 */
function createWorkflowRecorder(ctx: Context): WorkflowRecorder {
  const active = new Map<WorkflowRunId, Session>()
  const append = <Type extends keyof ToolWorkflowRecordEventMap>(
    session: Session,
    type: Type,
    data: SessionEventMap[Type],
  ): boolean => {
    // 这四个包内拥有的事件都是仅日志的。此处收窄通用的 append 接口，
    // 以消减 Session.append 的条件 options 元组。
    const appendRecord = session.append.bind(session) as <Event extends keyof ToolWorkflowRecordEventMap>(
      event: Event,
      value: SessionEventMap[Event],
    ) => void
    try {
      appendRecord(type, data)
      return true
    } catch (error: unknown) {
      ctx.logger.warn(`tool-workflow: disabled durable record after ${type} append failed: ${renderRecordingError(error)}`)
      return false
    }
  }

  ctx.on('workflow/agent-start', (info, agent) => {
    const session = active.get(info.id)
    if (session === undefined) return
    const data: ToolWorkflowAgentStartData = {
      runId: info.id,
      seq: agent.seq,
      label: agent.label,
      ...agent.phase === undefined ? {} : { phase: agent.phase },
      childId: agent.childId,
    }
    if (!append(session, 'tool-workflow/agent-start', data)) active.delete(info.id)
  })
  ctx.on('workflow/agent-end', (info, agent) => {
    const session = active.get(info.id)
    if (session === undefined) return
    const data: ToolWorkflowAgentEndData = {
      runId: info.id,
      seq: agent.seq,
      outcome: agent.outcome,
    }
    if (!append(session, 'tool-workflow/agent-end', data)) active.delete(info.id)
  })

  return {
    start(session, run) {
      if (append(session, 'tool-workflow/run-start', { runId: run.id, name: run.meta.name })) {
        active.set(run.id, session)
      }
    },
    finish(runId, stopReason) {
      const session = active.get(runId)
      if (session !== undefined) append(session, 'tool-workflow/run-end', { runId, stopReason })
      active.delete(runId)
    },
    abandon: (runId) => { active.delete(runId) },
  }
}

/**
 * 脚本编写契约，内嵌于工具描述中：各钩子、其确切语义，以及受支持的
 * schema 子集。参数级的规则位于参数描述中。
 */
const DESCRIPTION = `Run a JavaScript workflow script that orchestrates subagents at scale. Use this for work that fans out across many independent pieces — an audit over many files, a migration, multi-angle research, adversarial verification of findings — where you write the orchestration as a script instead of delegating turn by turn.

Script-body hooks:
- \`agent(prompt, opts?): Promise<any>\` — run one subagent to completion. Without \`opts.schema\` it resolves to the child's final text; with \`opts.schema\` (an object-rooted JSON Schema using ONLY type/properties/required/additionalProperties/items/enum/const/oneOf) it resolves to the validated object. Resolves \`null\` when the child fails (filter with \`.filter(Boolean)\`). Other opts: \`label\` (display), \`phase\` (progress group), and independent \`provider\`/\`model\` LLM target overrides.
- \`pipeline(items, ...stages): Promise<any[]>\` — run each item through the stages independently with NO barrier between stages (prefer this for multi-stage work). Each stage receives \`(prev, item, index)\`. A stage throw drops that ITEM to \`null\` and skips its remaining stages.
- \`parallel(thunks): Promise<any[]>\` — run zero-argument functions concurrently and await ALL of them (a barrier; use only when a stage genuinely needs every prior result together). A throwing thunk resolves to \`null\`.
- \`phase(title)\` — start a progress phase; \`log(message)\` — narrate progress; \`args\` — the tool call's \`args\` input, verbatim.

Misused hooks (bad arguments, unknown options, unsupported schemas, tripped caps) end the whole script instead of producing \`null\`. The script has no filesystem, network, timer, or Node.js APIs; the agents do the work.`

type WorkflowCallArgs = {
  script: string
  meta: {
    name: string
    description: string
    whenToUse?: string
    phases?: { title: string; detail?: string; provider?: string; model?: string }[]
  }
  args?: Record<string, unknown>
  run_in_background?: boolean
}

/** 等待态卡片：以 workflow 的 meta 名命名的通用卡片。 */
function presentWorkflowCall(args: WorkflowCallArgs): ToolCallView {
  return {
    card: 'generic',
    title: `workflow: ${args.meta.name}`,
    rawInput: args.script,
  }
}

/** 完成态卡片：保留等待态标题；按原样渲染结果内容。 */
function presentWorkflowResult(args: WorkflowCallArgs, result: { content: ContentBlock[]; isError: boolean }): ToolResultView {
  void args
  void result
  return { card: 'generic' }
}

/** 非 `completed` 的结束原因意味着脚本没有干净地结束。 */
function stopReasonError(result: WorkflowResult): string | undefined {
  switch (result.stopReason) {
    case 'completed':
      return undefined
    case 'cancelled':
      return `workflow run was cancelled${result.error !== undefined ? ` (${result.error})` : ''}`
    case 'error':
      return `workflow run failed: ${result.error ?? 'unknown error'}`
    /* v8 ignore start -- 防御性：WorkflowStopReason 是封闭联合，按构造可穷尽；未来的变体在此处会显式失败 */
    default:
      return `workflow run ended abnormally (${String(result.stopReason satisfies never)})`
    /* v8 ignore stop */
  }
}

/**
 * 将一个已结算的后台运行映射到 job 结果词汇表。一个已完成的运行携带渲染后的
 * 返回值作为 job 的结果；一个被取消的运行把细节交给注册表的终止原因合并
 * （它转发的取消原因就是同一个字符串）；一个出错的运行以脚本的失败消息失败。
 */
function jobOutcomeOf(result: WorkflowResult, name: string, maxChars: number): JobOutcome {
  switch (result.stopReason) {
    case 'completed':
      return {
        status: 'completed',
        detail: `${result.agentsStarted} agent${result.agentsStarted === 1 ? '' : 's'}`,
        result: renderResult(name, result.agentsStarted, result.value as JsonValue, maxChars),
      }
    case 'cancelled':
      return { status: 'killed' }
    case 'error':
      return { status: 'failed', detail: result.error ?? 'unknown error' }
    /* v8 ignore start -- 防御性：WorkflowStopReason 是封闭联合，按构造可穷尽；未来的变体在此处会显式失败 */
    default:
      return { status: 'failed', detail: `workflow run ended abnormally (${String(result.stopReason satisfies never)})` }
    /* v8 ignore stop */
  }
}

/** 渲染运行的结果文本：meta 名、代理数量，以及（有上限的）JSON 值。 */
function renderResult(name: string, agentsStarted: number, value: JsonValue, maxChars: number): string {
  // 引擎返回 JSON 数据（无值脚本为 null），因此 stringify 永远不会产出 undefined。
  const rendered = JSON.stringify(value, null, 2)
  const clipped = rendered.length > maxChars
    ? `${rendered.slice(0, maxChars)}\n… [truncated: ${rendered.length - maxChars} more characters]`
    : rendered
  return `workflow "${name}" completed (${agentsStarted} agent${agentsStarted === 1 ? '' : 's'}).\nReturn value:\n${clipped}`
}

/**
 * 将一个后台运行登记为一个受管的 job。引擎运行在 job 启动器内部启动，
 * 没有工具步骤信号 —— 该运行属于 job，因此一个注册表终止或属主拆解
 * 才是取消它的方式 —— 而其结算即 job 的结算：释放、停止镜像，随后将
 * 结束原因映射到 job 结果（已完成运行的渲染返回值随结算后模型首次读取
 * 而进入 `result`）。
 * @param ctx - 插件上下文（引擎、可选的 jobs 注册表、日志器）。
 * @param args - 已校验的工具调用。
 * @param parent - 调用代理；拥有该 job。
 * @param toolCall - 创建本次调用的调用，含其根调用。
 * @param recordsRun - 该顶层调用是否记录持久运行事件。
 * @param deps - 工具的录制器/镜像接入点，以及渲染上限。
 * @returns 工具输出 schema 对应的后台结果。
 */
function startBackgroundRun(
  ctx: Context,
  args: WorkflowCallArgs,
  parent: Agent,
  toolCall: JobToolCall,
  recordsRun: boolean,
  deps: { recorder: WorkflowRecorder; mirror: WorkflowRecordMirror; maxResultChars: number },
): { kind: 'background'; jobId: JobId; runId: WorkflowRunId } {
  const jobs = ctx.get('jobs')
  if (jobs === undefined) {
    throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
  }
  let run!: WorkflowRun
  const jobId = jobs.start({
    kind: 'workflow',
    label: args.meta.name,
    owner: parent.id,
    toolCall,
    run: (job) => {
      // 一个同步的引擎拒绝（META_INVALID/SCRIPT_PARSE）会从启动器向外传播，
      // 因此注册表什么都不登记，模型会看到违规列表，作为一个普通工具错误。
      run = ctx.workflowEngine.start({
        script: args.script,
        meta: args.meta,
        ...args.args !== undefined ? { args: args.args } : {},
        parent,
      })
      deps.mirror.start(run.id, job)
      if (recordsRun) deps.recorder.start(parent.session, run)
      const done = run.result.then(async (result): Promise<JobOutcome> => {
        try {
          // 在释放过程中保持成员监听器存活：引擎可能在达到静止态时
          // 合成被取消的成员结束。
          await run.dispose()
        } catch (error: unknown) {
          // done 不得 reject；一个失败的释放仍然有一个已结算的结果要报告。
          ctx.logger.warn(`background workflow run ${run.id} dispose failed: ${String(error)}`)
        }
        deps.mirror.stop(run.id)
        if (recordsRun) {
          deps.recorder.finish(run.id, result.stopReason)
          deps.recorder.abandon(run.id)
        }
        return jobOutcomeOf(result, args.meta.name, deps.maxResultChars)
      })
      return {
        cancel: (reason?: string) => { run.cancel(reason ?? 'background workflow job killed') },
        done,
      }
    },
  })
  return { kind: 'background' as const, jobId, runId: run.id }
}

export function apply(ctx: Context, config: Config): void {
  // schemastery（导出的 Config schema）已经填好了带默认值的字段；
  // 该断言记录的是那次解析，而非一个隐藏的回退。
  const { toolName, maxResultChars, enableRunInBackground } = config as ResolvedConfig
  const recorder = createWorkflowRecorder(ctx)
  const mirror = createWorkflowRecordMirror(ctx)
  // 使用策略随工具一同发布（核心约定：工具指引作为提示段落存在于工具插件中，
  // 而非部署人设中）。
  ctx.systemPrompt.section({
    name: `tool:${toolName}`,
    order: ctx.systemPrompt.getSectionOrder('TOOL_WORKFLOW'),
    text: `Use the ${toolName} tool ONLY when the user explicitly asks for a workflow or for large multi-agent orchestration: you write a JavaScript script (the tool description documents the exact format) that fans work out across many subagents with phases and structured results. For one or two delegations, prefer plain subagent calls.`,
  })
  ctx.tools.register(defineTool({
    name: toolName,
    description: DESCRIPTION,
    parameters: {
      script: {
        type: 'string',
        required: true,
        description: 'The plain JavaScript body, not TypeScript and without an `export const meta` statement; top-level await is allowed. '
          + 'End with `return <value>`; the JSON-serializable value is this tool\'s result.',
      },
      meta: {
        type: 'object',
        additionalProperties: true,
        required: true,
        description: 'The workflow identity as plain JSON, not code.',
        properties: {
          name: { type: 'string', required: true, description: 'Short kebab-case workflow name.' },
          description: { type: 'string', required: true, description: 'One-line description of what the workflow does.' },
          whenToUse: { type: 'string', description: 'Optional guidance on when this workflow applies.' },
          phases: {
            type: 'array',
            description: 'Optional phase declarations matched by phase() calls.',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                title: { type: 'string', required: true, description: 'The phase title phase() calls match by exact string.' },
                detail: { type: 'string', description: 'Optional one-line description of the phase.' },
                provider: { type: 'string', description: 'Optional provider override this phase is expected to use.' },
                model: { type: 'string', description: 'Optional model override this phase is expected to use.' },
              },
            },
          },
        },
      },
      args: {
        type: 'object',
        additionalProperties: true,
        description: 'Optional JSON input exposed to the script as the `args` global (wrap a bare list as a field, e.g. {"files": [...]}).',
      },
      ...enableRunInBackground ? {
        run_in_background: {
          type: 'boolean' as const,
          description: 'Run as a background job: return a job id immediately instead of waiting; the return value arrives with the completion notice.',
        },
      } : {},
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'background' },
              jobId: { type: 'string', required: true },
              runId: { type: 'string', required: true },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'foreground' },
              runId: { type: 'string', required: true },
              agentsStarted: { type: 'integer', required: true },
              result: { type: 'json', required: true },
            },
          },
        ],
      },
      render: (args, value) => [{
        type: 'text',
        text: value.kind === 'background'
          ? `workflow "${args.meta.name}" started in the background as job ${value.jobId}. Its return value arrives with the completion notice; check on it with job_output, stop it with job_kill.`
          : renderResult(args.meta.name, value.agentsStarted, value.result, maxResultChars),
      }],
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) {
        // 循环会为每次模型驱动的调用设置 `exec.agent`；其缺失意味着一个非代理的
        // 调用方直接调用了该工具，而没有可归属子项的父代理。显式失败而非猜测。
        throw new Error('workflow tool requires a calling agent (exec.agent was undefined)')
      }
      if (args.run_in_background === true) {
        if (!enableRunInBackground) {
          throw new Error('run_in_background is disabled for this tool')
        }
        // 与 bash/pwsh 不同，此处没有预中止检查：ToolRuntime 在 execute() 之前
        // 立即重读调用方信号，而本分支从那里同步到达 jobs.start。shell 工具会在
        // 登记前等待一个沙箱提权审批，那正是它们的检查所覆盖的窗口。
        return startBackgroundRun(ctx, args, parent, { callId: exec.callId, rootCallId: exec.rootCallId }, exec.parent === undefined, {
          recorder,
          mirror,
          maxResultChars,
        })
      }

      // Meta/正文校验失败（META_INVALID/SCRIPT_PARSE）会在此同步抛出，并通过
      // 注册表变为 isError 结果 —— 模型会看到违规列表，并可以纠正调用。
      const run = ctx.workflowEngine.start({
        script: args.script,
        meta: args.meta,
        ...args.args !== undefined ? { args: args.args } : {},
        parent,
        signal: exec.signal,
      })
      const recordsRun = exec.parent === undefined
      // 引擎在 start() 返回后、且本运行记录处于活跃时发布成员事件。
      if (recordsRun) recorder.start(parent.session, run)

      // 将工具的中止信号桥接到运行：若父步骤在脚本执行期间被中止，则取消
      // 整个运行。该信号也直接进入引擎，但这一本地桥接即使在某个实现忽略它时
      // 也能保留工具契约。
      const onAbort = (): void => { run.cancel('parent step aborted') }
      exec.signal.addEventListener('abort', onAbort, { once: true })

      let result: WorkflowResult | undefined
      try {
        result = await run.result
        const error = stopReasonError(result)
        if (error !== undefined) {
          // 将非干净结束映射为一个 isError 结果（注册表会把一个 throw 变成
          // isError）。报告原因，而非部分输出。
          throw new Error(error)
        }
        return {
          kind: 'foreground' as const,
          runId: run.id,
          agentsStarted: result.agentsStarted,
          result: result.value as JsonValue,
        }
      } finally {
        exec.signal.removeEventListener('abort', onAbort)
        try {
          // 在释放过程中保持成员监听器存活：引擎可能在达到静止态时
          // 合成被取消的成员结束。
          await run.dispose()
          if (recordsRun) {
            /* v8 ignore next -- WorkflowRun.result 按契约永不 reject，因此 finally 前 result 已被赋值。 */
            if (result === undefined) throw new Error('workflow run settled without a result')
            recorder.finish(run.id, result.stopReason)
          }
        } finally {
          if (recordsRun) recorder.abandon(run.id)
        }
      }
    },
    presentCall: args => presentWorkflowCall(args),
    presentResult: (args, result) => presentWorkflowResult(args, result),
  }))
}
