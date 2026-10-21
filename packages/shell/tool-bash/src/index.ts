/**
 * `ctx.shell` 能力缝面向模型的消费方。在作业注册表被装配时，每次调用都会在
 * 启动时把其进程注册到 `ctx.jobs`：`run_in_background` 立即返回 id，而前台
 * 调用会等待其作业，直到命令结束或等待超时，并在那时返回同一个 id。没有
 * 注册表时，本工具只能前台运行，并由执行器的期限终止命令。
 *
 * TODO(permissions)：部署策略属于 `tools/pre-execute` 与带沙箱能力的执行器；
 * 参见 docs/architecture.md 的“新行为应放在哪里”一节。
 * @module @deepseek-ai/dsh-tool-bash
 */

import type {} from '@deepseek-ai/dsh-working-directory'
import { FiberState } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { isAbsolute, sep } from 'node:path'
import { defineTool, TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, TerminalCallView, ToolDefinition, ToolExecution, ToolResult, ToolResultView } from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { JobId, JobRegistry, JobView } from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-shell-env'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { ESCALATION_TARGETS, approveEscalation, sandboxPermissionsDescription, validateEscalationArgs } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { DSH_ENV_PREFIX } from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellExecSpec, ShellExecution, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { processJob, processOutcome, processSources, ringDelta } from './background.ts'
import { parseExitStatus, renderJobRead, renderPromoted, renderResult } from './render.ts'

export const name = 'tool-bash'
export const inject = ['tools', 'shell', 'systemPrompt', 'shellEnv', 'workingDirectory']

/** bash 工具的配置。 */
export interface Config {
  /**
   * 在作业注册表被装配时暴露 `run_in_background`（默认 true）；被禁用时，
   * 相关调用也会被拒绝。没有注册表时，本工具无论如何都只能前台运行。
   */
  enableRunInBackground?: boolean
  /**
   * 让达到超时的前台命令继续作为后台作业运行，而不是被终止（默认 true）。
   * 仅在后台执行可用时生效：`enableRunInBackground` 为 false 或没有作业
   * 注册表时，执行器的期限会终止命令。注册表在其启动处拒绝的前台命令
   * （准入被拒或缺少控制器）同样在期限终止下运行。
   */
  promoteOnTimeout?: boolean
}

/** bash 工具插件的运行时配置 schema。 */
export const Config: z<Config> = z.object({
  enableRunInBackground: z.boolean().default(true),
  promoteOnTimeout: z.boolean().default(true),
})

/** 已解析的工具参数；execute 会校验 ParameterSchemaSpec 未涵盖的取值约束。 */
interface BashToolArgs {
  command: string
  description: string
  timeoutMs?: number
  workdir?: string
  run_in_background?: boolean
  sandbox_permissions?: string
  /** 在生效模式被省略或重复时为可选；放宽权限需要给出非空的理由。 */
  justification?: string
}

function validateBashArgs(args: BashToolArgs, effectiveMode: SandboxMode | undefined): void {
  if (args.command.trim().length === 0) {
    throw new Error('invalid command: expected a non-empty string')
  }
  if (args.description.trim().length === 0) {
    throw new Error('invalid description: expected a non-empty string')
  }
  if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
    throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(args.timeoutMs)}`)
  }
  if (args.sandbox_permissions !== undefined && args.sandbox_permissions === effectiveMode) return
  const justification = args.sandbox_permissions === undefined && args.justification?.trim() === ''
    ? undefined
    : args.justification
  validateEscalationArgs(args.sandbox_permissions, justification)
}

function bashDescription(): string {
  return 'Execute a bash command (`bash -c`) and return its stdout/stderr. '
    + 'Each call runs in a fresh shell; pass `workdir` instead of using `cd`. '
    + `Managed \`$${DSH_ENV_PREFIX}*\` variables expose current harness environment facts. `
    + 'Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. '
    + 'Provide `description` before `command` in the arguments. '
    + 'Before any delete or move, verify that the resolved absolute target path is the intended one; never run it against a computed path you have not checked. '
    + 'An unset variable expands to an empty string, so guard variables in such paths with `${VAR:?}`. '
    + 'Commands may run under a file sandbox; a blocked file operation is reported as `[sandbox: file access denied under <mode> mode]`, a policy denial: do not retry another way.'
}

/**
 * 把前台调用呈现为终端卡片，把后台启动呈现为通用卡片。两条路径上都以命令
 * 作为标题；前台的 cwd 会透传给桥接去解析，而后台的 description 则仍是
 * 卡片内容。
 */
type BashCallArgs = { command: string; description: string; workdir?: string; run_in_background?: boolean }

function presentBashCall(args: BashCallArgs): GenericCallView | TerminalCallView {
  if (args.run_in_background === true) {
    return {
      card: 'generic',
      title: args.command,
      kind: 'execute',
      rawInput: args.command,
      content: [{ type: 'text', text: args.description }],
    }
  }
  return {
    card: 'terminal',
    title: args.command,
    description: args.description,
    ...args.workdir !== undefined ? { cwd: args.workdir } : {},
  }
}

/**
 * 把已完成的前台输出呈现为终端卡片；后台的启动确认与执行错误则使用不带
 * 退出状态徽标的通用围栏输出。
 */
function presentBashResult(args: unknown, result: ToolResult): ToolResultView | undefined {
  const block = result.content.length === 1 ? result.content[0] : undefined
  if (block === undefined || block.type !== 'text') return undefined
  const raw = block.text
  const isBackground = typeof args === 'object' && args !== null && (args as { run_in_background?: unknown }).run_in_background === true
  const isPromoted = (result as { value?: { kind?: unknown } }).value?.kind === 'promoted'
  // 后台确认、晋升与错误都没有终端退出状态。
  if (isBackground || isPromoted || result.isError) {
    return { card: 'generic', content: [{ type: 'text', text: `\`\`\`console\n${raw.replace(/\n+$/, '')}\n\`\`\`` }] }
  }
  // 退出标记会成为卡片上的退出徽标，因此它要从输出主体中移出。
  const { body, ...exit } = parseExitStatus(raw)
  return { card: 'terminal', output: body, ...exit }
}

/** 针对会话当前目录解析单次调用的相对路径覆盖值。 */
function resolveWorkdir(modelWorkdir: string | undefined, sessionCwd: string | undefined): string | undefined {
  if (modelWorkdir === undefined) return sessionCwd
  if (sessionCwd !== undefined && !isAbsolute(modelWorkdir)) {
    return `${sessionCwd}${sep}${modelWorkdir}`
  }
  return modelWorkdir
}

/** 把执行器的 DTO 从只读的服务定义类型中剥离出来，转为纯 JSON 数据。 */
function canonicalBashResult(result: ShellRunResult, cwd: string) {
  const output = (stream: ShellRunResult['stdout']) => ({
    text: stream.text,
    truncated: stream.truncated,
    ...stream.spillPath !== undefined ? { spillPath: stream.spillPath } : {},
  })
  return {
    cwd,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    aborted: result.aborted,
    timeoutMs: result.timeoutMs,
    stdout: output(result.stdout),
    stderr: output(result.stderr),
    ...result.sandbox !== undefined ? {
      sandbox: {
        mode: result.sandbox.mode,
        denied: result.sandbox.denied,
        ...result.sandbox.enforcement !== undefined ? { enforcement: result.sandbox.enforcement } : {},
        ...result.sandbox.runnerFailed !== undefined ? { runnerFailed: result.sandbox.runnerFailed } : {},
      },
    } : {},
  }
}

/** 调用方取消本次调用时，前台路径抛出的结构化中止错误。 */
function toolAborted(): HarnessError {
  const error = new HarnessError('tool call aborted', TOOL_ABORTED)
  error.name = 'AbortError'
  return error
}

/** 一个已注册的命令：其 id、启动器 spawn 出来的进程，以及外部终止给出的原因。 */
interface StartedJob {
  readonly id: JobId
  readonly process: () => ShellExecution | undefined
  readonly stopped: () => string | undefined
}

/** bash 输出联合类型共用的后台句柄规范属性。 */
const BACKGROUND_OUTPUT_PROPERTIES = {
  kind: { type: 'string', required: true, const: 'background' },
  jobId: { type: 'string', required: true },
  cwd: { type: 'string', required: true },
} as const

export function apply(ctx: Context, config: Config = {}): void {
  const backgroundEnabled = config.enableRunInBackground ?? true
  // 保留一条已超时的命令需要整套后台能力：用于收集与停止它的作业工具，
  // 以及执行时可用的注册表本身。
  const promoteOnTimeout = (config.promoteOnTimeout ?? true) && backgroundEnabled
  const defaultMode = ctx.shell.sandboxMode
  const escalationModes: readonly SandboxMode[] = defaultMode === undefined ? [] : ESCALATION_TARGETS
  const sandboxPolicy: SandboxPolicyService | undefined = defaultMode === undefined ? undefined : ctx.get('sandboxPolicy')
  if (defaultMode !== undefined && sandboxPolicy === undefined) {
    throw new Error('tool-bash: the mounted bash executor confines but ctx.sandboxPolicy is missing')
  }
  /** 在装配了隔离型执行器时，为本次调用解析完整的常设策略。 */
  const resolveSandboxPolicy = (exec: ToolExecution): SandboxExecutionPolicy | undefined =>
    sandboxPolicy?.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })

  /**
   * 在任何东西执行之前，通过 `ctx.approval` 处理一次沙箱升级请求，把共享的
   * 失败即关闭序列（严格放宽、通道解析、结果映射）委托给
   * {@link approveEscalation}。本工具只贡献装配守卫（没有带沙箱能力的
   * 执行器时这些字段不会被声明，而 schema 校验只检查已声明的键，因此未
   * 被声明的 `sandbox_permissions` 仍会抵达 execute）以及审批所需的材料。
   * 只要执行器声明了隔离能力，共享策略解析器就是必需的，因此被割裂的
   * 装配会在工具插件加载时就失败。
   */
  const approveBashEscalation = (
    mode: string,
    justification: string,
    exec: ToolExecution,
    standingPolicy: SandboxExecutionPolicy | undefined,
  ): Promise<SandboxMode> => {
    if (escalationModes.length === 0) {
      throw new Error('sandbox_permissions is not available in this composition (no sandboxing executor to escalate)')
    }
    const effectiveMode = (standingPolicy as SandboxExecutionPolicy).mode
    return approveEscalation(
      { requestedMode: mode, justification, effectiveMode, subject: 'command' },
      {
        approver: ctx.get('approval'),
        agent: exec.agent,
        callId: exec.callId,
        toolName: 'bash',
        signal: exec.signal,
      },
    )
  }

  // 跨调用的指引属于提示词，而不是单次调用 schema 的说明文字。
  ctx.systemPrompt.section({
    name: 'tool:bash',
    order: ctx.systemPrompt.getSectionOrder('TOOL_BASH'),
    text: 'Check the [exit code: N] marker on every bash result; investigate failures before moving on.',
  })

  /**
   * `bash` 工具的一次注册。有注册表时，每次调用都会在启动时把其进程注册为
   * 一个作业；没有注册表时，本工具只能前台运行，并由执行器的期限终止命令。
   */
  const bashTool = (jobs: JobRegistry | undefined): ToolDefinition => {
    const background = jobs !== undefined
    const promote = background && promoteOnTimeout
    /** 把命令注册为作业；进程在准入通过之后于启动器内部 spawn。 */
    const startJob = (registry: JobRegistry, args: BashToolArgs, exec: ToolExecution, spec: ShellExecSpec): StartedJob => {
      let proc: ShellExecution | undefined
      let stopped: string | undefined
      const id = registry.start({
        kind: 'bash',
        label: args.command,
        toolCall: { callId: exec.callId, rootCallId: exec.rootCallId },
        ...exec.agent ? { owner: exec.agent.id } : {},
        output: processSources(() => proc),
        run: () => {
          const hooks = processJob(
            async (signal) => {
              proc = await ctx.shell.execute({ ...spec, signal })
              return proc
            },
            started => processOutcome(started, escalationModes),
          )
          return {
            done: hooks.done,
            // 来自本次调用之外的终止（人类的操作、并行的 job_kill）
            // 会在这里作用到进程上；其给出的原因就是模型读到的内容。
            cancel: (reason) => {
              stopped = reason
              hooks.cancel(reason)
            },
          }
        },
      })
      return { id, process: () => proc, stopped: () => stopped }
    }
    /** 等待一个已注册的前台命令，直到它落定或超时过去。 */
    const waitOnJob = async (registry: JobRegistry, attached: StartedJob, exec: ToolExecution, spec: ShellExecSpec) => {
      const owner = exec.agent?.id
      const timeoutMs = spec.timeoutMs
      /**
       * 以本次调用自身的名义停止该作业，并持续跟进直到它落定，这样落定
       * 就被 `await` 了，也不会有完成通知跟在一个本次调用已经携带的结果
       * 之后；随后记录随本次调用一起离开，因为模型从未见过这个 id。
       */
      const stop = async (reason: string): Promise<JobView> => {
        registry.kill(attached.id, owner, reason)
        const settled = await registry.wait(attached.id, timeoutMs, owner)
        if (settled.status !== 'running' && settled.status !== 'stopping') registry.remove(attached.id, owner)
        return settled
      }
      let view: JobView
      try {
        view = await registry.wait(attached.id, timeoutMs, owner, exec.signal)
      } catch {
        // 对调用方自己那个活动作业的等待，只会因为调用方中止而拒绝：
        // 模型的这次调用已经结束，命令随之而去，正如期限终止下的情形。
        await stop('tool call aborted')
        throw toolAborted()
      }
      if ((view.status === 'running' || view.status === 'stopping') && attached.process() === undefined) {
        // 等待在准备阶段仍在运行时到期：没有任何东西在跑可供保留，
        // 因此这就是期限的准备阶段超时，并带有执行器自身期限本会给出的
        // 那个已落定的空结果。
        await stop('timed out during preparation')
        return {
          kind: 'foreground' as const,
          cwd: spec.workdir,
          exitCode: null,
          signal: null,
          timedOut: true,
          aborted: false,
          timeoutMs,
          stdout: { text: '', truncated: false },
          stderr: { text: '', truncated: false },
          ...spec.sandboxPolicy !== undefined ? { sandbox: { mode: spec.sandboxPolicy.mode, denied: false } } : {},
        }
      }
      if (view.status === 'running' || view.status === 'stopping') {
        // 等待超时：作业继续运行。一次消费式读取用目前为止的输出作为结果的
        // 起点，因此 `job_output` 会恰好从本结果停下的地方继续。
        const read = registry.read(attached.id, owner)
        return {
          kind: 'promoted' as const,
          cwd: spec.workdir,
          jobId: attached.id,
          timeoutMs,
          output: renderJobRead(
            ringDelta(read.chunks), read.lossy, read.job.output.spillPaths ?? [], attached.process()?.sandbox, escalationModes,
          ),
        }
      }
      // 在本次调用等待期间落定：模型从未见过这个 id，因此记录随本结果一起
      // 离开注册表。进程句柄保留着前台结果所需的分流输出与分类。
      registry.remove(attached.id, owner)
      const process = attached.process()
      // 没有发布任何进程：启动器在 spawn 之前就失败了，而作业的终止详情
      // 正是前台投影本会用以拒绝的那个失败。
      if (process === undefined) throw new Error(view.detail)
      const result = await process.result()
      const stopped = attached.stopped()
      return { kind: 'foreground' as const, ...canonicalBashResult(result, spec.workdir), ...stopped !== undefined ? { stopped } : {} }
    }
    return defineTool({
      name: 'bash',
      description: bashDescription(),
      parameters: {
        description: {
          type: 'string',
          required: true,
          description: 'Clear, concise description of what this command does in active voice, '
            + '5-10 words (shown in the UI). Examples: "ls" → "List files in current directory"; '
            + '"git status" → "Show working tree status"; "npm install" → "Install package dependencies".',
        },
        command: { type: 'string', required: true, description: 'The bash command to execute.' },
        timeoutMs: {
          type: 'number',
          description: promote
            ? 'Timeout in milliseconds. The executor applies its configured default and cap; on expiry the command moves to the background as a job instead of being killed.'
            : 'Timeout in milliseconds. The executor applies its configured default and cap, and kills the command on expiry.',
        },
        workdir: { type: 'string', description: 'Working directory for this command. Defaults to the session workspace; a relative path is resolved against it.' },
        ...background ? {
          run_in_background: { type: 'boolean' as const, description: 'Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies.' },
        } : {},
        ...escalationModes.length > 0 ? {
          sandbox_permissions: {
            type: 'string' as const,
            enum: [...escalationModes],
            description: sandboxPermissionsDescription('command'),
          },
          justification: {
            type: 'string' as const,
            description: 'Required with sandbox_permissions: one sentence for the user explaining why this exact command needs the wider access. '
              + 'Use the language of the user’s current request.',
          },
        } : {},
      },
      output: {
        schema: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: BACKGROUND_OUTPUT_PROPERTIES,
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, const: 'promoted' },
                cwd: { type: 'string', required: true },
                jobId: { type: 'string', required: true },
                timeoutMs: { type: 'number', required: true },
                output: { type: 'string', required: true },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, const: 'foreground' },
                cwd: { type: 'string', required: true },
                exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
                signal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
                timedOut: { type: 'boolean', required: true },
                aborted: { type: 'boolean', required: true },
                stopped: { type: 'string' },
                timeoutMs: { type: 'number', required: true },
                stdout: {
                  type: 'object',
                  additionalProperties: false,
                  required: true,
                  properties: {
                    text: { type: 'string', required: true },
                    truncated: { type: 'boolean', required: true },
                    spillPath: { type: 'string' },
                  },
                },
                stderr: {
                  type: 'object',
                  additionalProperties: false,
                  required: true,
                  properties: {
                    text: { type: 'string', required: true },
                    truncated: { type: 'boolean', required: true },
                    spillPath: { type: 'string' },
                  },
                },
                sandbox: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    mode: { type: 'string', required: true },
                    denied: { type: 'boolean', required: true },
                    enforcement: { type: 'string' },
                    runnerFailed: { type: 'boolean' },
                  },
                },
              },
            },
          ],
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.kind === 'background'
            ? `started background job ${value.jobId}`
            : value.kind === 'promoted'
              ? renderPromoted(value)
              : renderResult(value as { kind: 'foreground' } & ShellRunResult, escalationModes),
        }],
        presentationMeta: (_args, value) => ({ cwd: value.cwd }),
      },
      async execute(args: BashToolArgs, exec) {
        // description 只是展示用的元数据；workdir 默认为调用方会话的目录。
        const standingPolicy = resolveSandboxPolicy(exec)
        validateBashArgs(args, standingPolicy?.mode)
        const approvedMode = args.sandbox_permissions !== undefined && args.justification !== undefined
          ? await approveBashEscalation(args.sandbox_permissions, args.justification, exec, standingPolicy)
          : undefined
        const policy = approvedMode === undefined
          ? standingPolicy
          : { ...(standingPolicy as SandboxExecutionPolicy), mode: approvedMode }
        const cwd = exec.agent === undefined ? undefined : await ctx.workingDirectory.ensure(exec.agent, exec.signal)
        const workdir = resolveWorkdir(args.workdir, cwd)
        const dshEnv = ctx.shellEnv.collect(exec)
        const request: ShellExecRequest = {
          command: args.command,
          ...workdir !== undefined ? { workdir } : {},
          ...args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {},
          dshEnv,
          ...policy !== undefined ? { sandboxPolicy: policy } : {},
        }
        if (args.run_in_background === true) {
          // 未声明的键是允许出现的，因此 schema 的省略也需要被强制执行。
          if (!backgroundEnabled) {
            throw new Error('run_in_background is disabled for this deployment (enableRunInBackground: false)')
          }
          if (jobs === undefined) {
            throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
          }
          // 在 ctx.jobs 落实脱离本次调用的归属之前，取消权归调用方所有。
          if (exec.signal.aborted) throw toolAborted()
          const spec = ctx.shell.resolve({ ...request, onExpiry: 'none' })
          return { kind: 'background' as const, jobId: startJob(jobs, args, exec, spec).id, cwd: spec.workdir }
        }
        // 前台调用是一个工具会等待的作业，因此命令自启动那一刻起就可见
        // 且可被终止，并在超时过去后存活于这次等待之外。在启动处被拒绝
        // 准入的命令（归属者的作业上限、没有控制器）改为在期限终止下
        // 运行，正如没有注册表的装配所做的那样。
        if (jobs !== undefined && promote) {
          const spec = ctx.shell.resolve({ ...request, onExpiry: 'none' })
          let attached: StartedJob | undefined
          try {
            attached = startJob(jobs, args, exec, spec)
          } catch (error) {
            ctx.logger.warn(`bash: job registration refused, running in the foreground with the timeout kill instead: ${String(error)}`)
          }
          if (attached !== undefined) return waitOnJob(jobs, attached, exec, spec)
        }
        const spec = ctx.shell.resolve({ ...request, signal: exec.signal })
        const foreground = await ctx.shell.execute(spec)
        const result = await foreground.result()
        if (result.aborted) throw toolAborted()
        return { kind: 'foreground' as const, ...canonicalBashResult(result, spec.workdir) }
      },
      presentCall: presentBashCall,
      presentResult: presentBashResult,
    })
  }

  // 后台能力随注册表而定。除非注册表已被装配，否则先注册仅前台的变体；
  // 只要 `ctx.jobs` 在场，作业驱动的变体就会取代它；而在本插件留存、注册
  // 表卸载时，仅前台的变体又会回来。两次注册都属于本插件自身的 fiber。
  if (!backgroundEnabled) {
    ctx.tools.register(bashTool(undefined))
    return
  }
  let foregroundOnly = ctx.get('jobs') === undefined ? ctx.tools.register(bashTool(undefined)) : undefined
  ctx.inject(['jobs'], (jobCtx) => {
    foregroundOnly?.()
    foregroundOnly = undefined
    const unregister = ctx.tools.register(bashTool(jobCtx.jobs))
    jobCtx.effect(() => () => {
      unregister()
      if (ctx.fiber.state === FiberState.ACTIVE) foregroundOnly = ctx.tools.register(bashTool(undefined))
    })
  })
}
