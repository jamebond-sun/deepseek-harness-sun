/**
 * 构建在 `ctx.jobs` 之上的、面向模型的 `job_output`、`job_list` 与 `job_kill` 工具。
 * 加载该插件会挂载生产者所需的控制器。它还把模型尚未取走的完成投递给所属 agent：注入
 * 忙碌所有者的下一步，或在默认的 `wakeup` 投递下为空闲的所有者开启一轮——除非
 * `maxConsecutiveWakes` 按所有者给它设了上限。
 * @module @deepseek-ai/dsh-tool-jobs
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { boundContextSummary, createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { TextRetainer } from '@deepseek-ai/dsh-output-retention'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import { JobId } from '@deepseek-ai/dsh-jobs'
import type { JobView, JobRead } from '@deepseek-ai/dsh-jobs'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent'
import { publicJob, renderModelDelta, statusLine } from './render.ts'
import type { PublicJobSnapshot } from './render.ts'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'tool-jobs': { kind: 'tool-jobs' } & ContextFormed
  }
}

export const name = 'tool-jobs'
export const inject = ['tools', 'jobs', 'systemPrompt']

/**
 * 一个未被取走的完成如何抵达已经空闲的所有者：`wakeup` 为它开启一轮，`quiet` 让它挂起，
 * 直到有别的东西唤醒该所有者。忙碌的所有者在两种模式下都是注入。
 */
export type CompletionDelivery = 'quiet' | 'wakeup'

/** 配置有界的 `job_output` 等待与完成通知的投递。 */
export interface Config {
  /** 当 `job_output` 设置了 `wait` 而没有给 `timeout_ms` 时应用的等待时长（默认 30s）。 */
  waitTimeoutMs?: number
  /** 任何单次等待的硬上限；模型给出的更大 `timeout_ms` 会被夹到它（默认 10min）。 */
  maxWaitTimeoutMs?: number
  /** 一次完成是否为空闲的所有者开启一轮（默认 `wakeup`）。 */
  completionDelivery?: CompletionDelivery
  /**
   * 在下一条通知降级为注入之前，一个所有者允许被完成唤醒开启多少轮；任何用户发起的输入
   * 都会重置它。默认不存在：每一次空闲完成都唤醒它的所有者。设置它可以给那条自我激发的
   * 链条设界——被唤醒的一轮又启动了那个其完成会再次唤醒它的任务——代价是超出上限的通知
   * 会静默等待下一次用户输入。
   */
  maxConsecutiveWakes?: number
}

export const Config: z<Config> = z.object({
  waitTimeoutMs: z.number().min(1).default(30_000),
  maxWaitTimeoutMs: z.number().min(1).default(600_000),
  completionDelivery: z.union(['quiet', 'wakeup'] as const).default('wakeup'),
  maxConsecutiveWakes: z.number().min(1),
})

/** 任务控制的输出共用的 schema。 */
const PUBLIC_JOB_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    label: { type: 'string', required: true },
    status: {
      type: 'string',
      required: true,
      enum: ['running', 'stopping', 'completed', 'killed', 'failed'],
    },
    detail: { type: 'string' },
    startedAt: { type: 'integer', required: true },
    finishedAt: { type: 'integer' },
  },
} as const

const encoder = new TextEncoder()

function retainTail(text: string, maxBytes: number): string {
  const retainer = new TextRetainer({ kind: 'tail', maxBytes })
  retainer.push(text)
  return retainer.finish().text
}

function retainHead(text: string, maxBytes: number): string {
  const retainer = new TextRetainer({ kind: 'head', maxBytes })
  retainer.push(text)
  return retainer.finish().text
}

function fitWithSuffix(
  content: string,
  suffix: string,
  maxBytes: number | undefined,
  omitted: string,
): string {
  const complete = `${content}${suffix}`
  if (maxBytes === undefined || encoder.encode(complete).byteLength <= maxBytes) return complete
  const fixed = `${content.endsWith(omitted.trimStart()) ? '' : omitted}${suffix}`
  const fixedBytes = encoder.encode(fixed).byteLength
  if (fixedBytes >= maxBytes) return retainTail(fixed, maxBytes)
  return `${retainTail(content, maxBytes - fixedBytes)}${fixed}`
}

/**
 * 为 `notice` 形态的折叠行准备的、已结算任务的一行说明。
 * @param job - 已结算的任务。
 * @returns 它的类型、标签与状态，与每条通知摘要一样受上限约束。
 */
function completionSummary(job: JobView): string {
  return boundContextSummary(`${job.kind} ${job.label} ${statusLine(publicJob(job))}`)
}

function fitCompletionNotice(job: JobView): string {
  const prefix = `background job ${job.id}`
  const detail = ` (${job.kind}: ${job.label}) finished ${statusLine(publicJob(job))}`
  const action = '\nDone; job_output.'
  const complete = `${prefix}${detail}. Read its output with job_output.`
  const maxBytes = job.outputLimitBytes
  if (maxBytes === undefined || encoder.encode(complete).byteLength <= maxBytes) return complete
  const omitted = '\n[notice truncated]'
  const fixed = `${prefix}${omitted}${action}`
  const fixedBytes = encoder.encode(fixed).byteLength
  if (fixedBytes <= maxBytes) {
    return fixedBytes === maxBytes
      ? fixed
      : `${prefix}${retainHead(detail, maxBytes - fixedBytes)}${omitted}${action}`
  }
  const compact = `${prefix}${action}`
  const compactBytes = encoder.encode(compact).byteLength
  if (compactBytes <= maxBytes) return compact
  // 半个 UUID 无法标识该任务。改为把模型指向列表。
  const recovery = 'background job ended; use job_list for id.'
  if (encoder.encode(recovery).byteLength <= maxBytes) return recovery
  return retainHead('job_list', maxBytes)
}

function rawSingleText(content: readonly ContentBlock[]): string | undefined {
  if (content.length !== 1) return undefined
  const block = content[0]
  if (block?.type !== 'text') return undefined
  return block.text
}

function boundSingleText(content: readonly ContentBlock[], maxBytes: number): ContentBlock[] | undefined {
  const text = rawSingleText(content)
  if (text === undefined) return undefined
  return [{
    type: 'text',
    text: fitWithSuffix(text, '', maxBytes, '\n[result truncated]'),
  }]
}

/** 当调用方可见时，`job_output` 或 `job_kill` 调用所指名的那个任务的生产者上限。 */
function visibleOutputLimit(ctx: Context, exec: ToolExecution): number | undefined {
  if (exec.name !== 'job_output' && exec.name !== 'job_kill') return undefined
  const jobId = (exec.arguments as { job_id?: unknown } | null | undefined)?.job_id
  if (typeof jobId !== 'string' || jobId.length === 0) return undefined
  return ctx.jobs.list(exec.agent?.id).find(job => job.id === jobId)?.outputLimitBytes
}

/** 校验 ParameterSchemaSpec 无法表达的那条非空约束。 */
function validateJobId(value: string): JobId {
  if (value.length === 0) {
    throw new Error(`invalid job_id: expected a non-empty string, got ${JSON.stringify(value)}`)
  }
  return JobId(value)
}

/** 三个通用任务控制共用的待决呈现。 */
function presentJobCall(title: string, kind: 'read' | 'execute', rawInput?: string): GenericCallView {
  return { card: 'generic', title, kind, ...rawInput !== undefined ? { rawInput } : {} }
}

/** 模型所看到的消费型读取：增量，然后是只给一次的结果，然后是状态行。 */
function readBody(read: JobRead): { text: string; job: PublicJobSnapshot } {
  const delta = renderModelDelta(read.chunks, read.lossy, read.job.output.spillPaths ?? [])
  const text = read.result === undefined
    ? delta
    : `${delta}${delta.length > 0 && !delta.endsWith('\n') ? '\n' : ''}${read.result}`
  return { text, job: publicJob(read.job) }
}

export function apply(ctx: Context, config: Config): void {
  const waitDefault = config.waitTimeoutMs ?? 30_000
  const waitCap = config.maxWaitTimeoutMs ?? 600_000
  const delivery = config.completionDelivery ?? 'wakeup'
  const wakeBudget = config.maxConsecutiveWakes

  // 自某个所有者上次消费人类输入以来，本插件在它身上开启过的轮数。以确切的 Agent 为键，
  // 因此同一会话的替换实例从一个满额预算开始。
  const spentWakes = new WeakMap<Agent, number>()
  if (waitDefault > waitCap) {
    throw new Error(`tool-jobs: waitTimeoutMs (${waitDefault}) exceeds maxWaitTimeoutMs (${waitCap})`)
  }
  // 预算是一个轮数：小数永远无法指名一轮，而 `Infinity` 会写出一个省略该字段本就已经
  // 表达出来的“无界”。
  if (wakeBudget !== undefined && !Number.isSafeInteger(wakeBudget)) {
    throw new Error(`tool-jobs: maxConsecutiveWakes (${wakeBudget}) must be a whole number of turns`)
  }
  // 在 quiet 投递下或没有上限时，没有任何东西会花掉预算，因此也不需要重新填满它。
  if (delivery === 'wakeup' && wakeBudget !== undefined) {
    ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      // 认领正是人类输入真正进入一步的时刻；本插件自己排入的通知不得重新填满它刚刚
      // 花掉的预算。
      if (message.source.kind === 'user') spentWakes.delete(agent)
    })
  }

  const outputLimits = new WeakMap<ToolExecution, number>()
  ctx.on('tools/pre-execute', (exec, next) => {
    const maxBytes = visibleOutputLimit(ctx, exec)
    if (maxBytes !== undefined) outputLimits.set(exec, maxBytes)
    return next()
  }, { prepend: true })
  const finalizeJobContent: NonNullable<ToolDefinition['finalizeContent']> = (exec, result) => {
    const maxBytes = outputLimits.get(exec) ?? visibleOutputLimit(ctx, exec)
    outputLimits.delete(exec)
    if (maxBytes === undefined) return undefined
    if (exec.name === 'job_output' && !result.isError) {
      // 本定义拥有并做 schema 校验这个规范值。只有在策略没有动过默认渲染的情况下，
      // 才保留它的输出/状态拆分。
      const value = result.value as unknown as { text: string; job: PublicJobSnapshot }
      const body = value.text.length > 0 ? value.text : '(no new output)'
      const content = body.endsWith('\n') ? body.slice(0, -1) : body
      const suffix = `\n${statusLine(value.job)}`
      if (rawSingleText(result.content) === `${content}${suffix}`) {
        return [{
          type: 'text',
          text: fitWithSuffix(content, suffix, maxBytes, '\n[output truncated]'),
        }]
      }
    }
    return boundSingleText(result.content, maxBytes)
  }

  // 只有在控制器已挂载时，生产者才可以开工。
  ctx.jobs.attachController('tool-jobs')

  // 跨调用指引排在文件系统小节之后、产品小节之前。
  ctx.systemPrompt.section({
    name: 'tool:jobs',
    order: ctx.systemPrompt.getSectionOrder('TOOL_JOBS'),
    text: 'Track every background job id you start. You are notified in-session when a job finishes — do not busy-poll or sleep on one; keep working on independent steps and do not duplicate a running job\'s work. Before giving a final answer, collect every still-relevant job with job_output (set wait: true only when you are genuinely blocked on it), and job_kill jobs that stopped mattering.',
  })

  // 模型自己通过 `job_kill` 请求 kill 的在世任务：那次工具结果就是模型的投递，所以结算
  // 通知只会重复它。等待不需要在这里登记——注册表会把释放了一个在世等待的结算报告为
  // `awaited`，无论等待的是哪个插件。
  const killedByModel = new Set<JobId>()

  // 忙碌的所有者被注入：通知在它下一步的收件箱里等待，而那一轮无法覆盖到它，因此同时
  // 结算的多个任务只花一步。空闲的所有者则被唤醒，因为一份未投递的通知就是一个模型永远
  // 不会得知的完成。两种情况下，投递之前的销毁都会把它随所有者一起丢弃，而一次 teardown
  // 结算已经没有读者了。
  //
  // 注册表把每次结算路由到本插件被挂载的那个作用域，因此挂载在某个 preset 下的实例永远
  // 看不到另一个 preset 的 agent；这个监听器负责投递，而不负责选择投递给谁。
  ctx.jobs.events.subscribe({ owners: 'scope' }, (event) => {
    if (event.type === 'removed') {
      killedByModel.delete(event.job.id)
      return
    }
    if (event.type !== 'settled') return
    const delivered = killedByModel.delete(event.job.id) || event.awaited
    if (delivered || event.cause === 'teardown' || event.job.owner === undefined) return
    // 目的地是此刻为该所有者会话注册的 agent。带所有者的任务需要 agent 注册表才能启动，
    // 因此这里只有在它于结算之前离开时注册表才不存在——而那时也没有任何收件箱剩下。
    const owner = ctx.get('agents')?.get(event.job.owner)
    if (owner === undefined) return
    const message = createUserMessage({
      content: [{
        type: 'text',
        text: fitCompletionNotice(event.job),
      }],
      source: {
        kind: 'tool-jobs',
        form: 'notice',
        summary: completionSummary(event.job),
      },
    })
    if (delivery === 'wakeup' && owner.status === 'idle') {
      if (wakeBudget === undefined) {
        owner.followup(message)
        return
      }
      const spent = spentWakes.get(owner) ?? 0
      if (spent < wakeBudget) {
        spentWakes.set(owner, spent + 1)
        owner.followup(message)
        return
      }
    }
    owner.inject(message)
  })

  ctx.tools.register(defineTool({
    name: 'job_output',
    description: 'Read a background job: output since the previous read for stream jobs, or the result of a finished final-output job.',
    // 一次超时的等待返回任务状态而不是 TOOL_TIMEOUT 错误，所以这个工具自己掌握截止时间，
    // 而不使用 ToolDefinition.timeoutMs。
    parameters: {
      job_id: { type: 'string', required: true, description: 'Job id returned by the tool that started the background work.' },
      wait: { type: 'boolean', description: 'Block until the job finishes or the timeout expires; a timed-out wait leaves the job running. Defaults to false.' },
      timeout_ms: { type: 'number', description: 'Max wait in milliseconds with wait: true. Defaults to and is capped by configuration.' },
    },
    finalizeContent: finalizeJobContent,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          job: { ...PUBLIC_JOB_SCHEMA, required: true },
        },
      },
      render: (_args, value) => {
        const body = value.text.length > 0 ? value.text : '(no new output)'
        const separator = body.endsWith('\n') ? '' : '\n'
        return [{ type: 'text', text: `${body}${separator}${statusLine(value.job)}` }]
      },
    },
    async execute(args, exec) {
      const id = validateJobId(args.job_id)
      const jobs = ctx.jobs
      if (args.wait === true) {
        // 释放本次等待的那次结算会被报告为 `awaited`，所以上面的通知监听器会跳过它：本
        // 结果已经带上了终态。已超时或被中止的等待在之后任何结算之前就已离开注册表的
        // 等待者集合，因此那次结算照常通知。
        await jobs.wait(id, Math.min(args.timeout_ms ?? waitDefault, waitCap), exec.agent?.id, exec.signal)
      }
      return readBody(jobs.read(id, exec.agent?.id))
    },
    presentCall: args => presentJobCall(`Read output from background job ${args.job_id}`, 'read', args.job_id),
  }))

  ctx.tools.register(defineTool({
    name: 'job_list',
    description: 'List your background jobs (running and finished) with their ids, kinds, and statuses.',
    parameters: {},
    output: {
      schema: { type: 'array', items: PUBLIC_JOB_SCHEMA },
      render: (_args, jobs) => [{
        type: 'text',
        text: jobs.length === 0
          ? '(no background jobs)'
          : jobs.map(t => `${t.id} [${t.kind}] ${t.status} — ${t.label}`).join('\n'),
      }],
    },
    execute(_args, exec) {
      const jobs = ctx.jobs.list(exec.agent?.id)
      return Promise.resolve(jobs.map(publicJob))
    },
    presentCall: () => presentJobCall('List background jobs', 'read'),
  }))

  ctx.tools.register(defineTool({
    name: 'job_kill',
    description: 'Request cancellation of a running background job.',
    parameters: {
      job_id: { type: 'string', required: true, description: 'Job id returned by the tool that started the background work.' },
      reason: { type: 'string', description: 'Optional short reason, recorded in the log and forwarded to the job.' },
    },
    finalizeContent: finalizeJobContent,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          outcome: {
            type: 'string',
            required: true,
            enum: ['cancellation-requested', 'already-finished'],
          },
          job: { ...PUBLIC_JOB_SCHEMA, required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.outcome === 'already-finished'
          ? `job ${value.job.id} had already finished ${statusLine(value.job)}`
          : `requested cancellation of job ${value.job.id}`,
      }],
    },
    execute(args, exec) {
      const id = validateJobId(args.job_id)
      const jobs = ctx.jobs
      const result = jobs.kill(id, exec.agent?.id, args.reason)
      // 模型自己的 kill 就是它的投递：结算通知只会重复这个工具结果已经说过的话。
      if (result === 'requested') killedByModel.add(id)
      // 一个投影描述当前状态，而不消费待取的输出。
      const job = publicJob(jobs.get(id, exec.agent?.id))
      return Promise.resolve({
        outcome: result === 'already-finished' ? 'already-finished' as const : 'cancellation-requested' as const,
        job,
      })
    },
    presentCall: args => presentJobCall(`Kill background job ${args.job_id}`, 'execute', args.job_id),
  }))
}
