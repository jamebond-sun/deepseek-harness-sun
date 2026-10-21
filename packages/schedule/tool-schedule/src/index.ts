/**
 * 位于 Host `ctx.schedule` 服务之上、面向模型的 `schedule_create`、
 * `schedule_list`、`schedule_update` 与 `schedule_delete` 工具。
 * 挂载该插件会在挂载作用域中注册它们，因此由 preset 决定哪些 agent
 * 获得它们；每次调用都作用于发起调用的 Agent 的 Session。
 * @module @deepseek-ai/dsh-tool-schedule
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import {
  MAX_TITLE_LENGTH, MIN_EVERY_INTERVAL_SECONDS, REQUIRED_TITLE_MESSAGE, ScheduleId, ScheduleInputError, scheduleView,
} from '@deepseek-ai/dsh-schedule'
import type {
  AtInput, CronInput, DailyInput, WeeklyInput, InternalScheduleError, ScheduleCreateValue, ScheduleDeleteValue,
  ScheduleListValue, ScheduleTimingChange, ScheduleToolError, ScheduleUpdateValue,
} from '@deepseek-ai/dsh-schedule'

/** 注册到 Loader 的插件名。 */
export const name = 'tool-schedule'

/** 本插件消费的 Host 服务。Schedule 服务按作用域解析，因此当交付的组合
 * 关闭该服务时，一个声明了本插件的 preset 会保持不起作用。 */
export const inject = ['tools']

const SHARED_VIEW_PROPERTIES = {
  id: { type: 'string', required: true },
  title: { type: 'string', required: true },
  prompt: { type: 'string', required: true },
  scheduledAt: { type: 'string', required: true },
  state: { type: 'string', required: true, enum: ['scheduled', 'overdue'] },
  deliveryMode: { type: 'string', required: true, const: 'host' },
} as const

const AFTER_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...SHARED_VIEW_PROPERTIES,
    kind: { type: 'string', required: true, const: 'after' },
    afterSeconds: { type: 'integer', required: true },
  },
} as const

const AT_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...SHARED_VIEW_PROPERTIES,
    kind: { type: 'string', required: true, const: 'at' },
  },
} as const

const EVERY_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...SHARED_VIEW_PROPERTIES,
    kind: { type: 'string', required: true, const: 'every' },
    everySeconds: { type: 'integer', required: true },
  },
} as const

const DAILY_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...SHARED_VIEW_PROPERTIES,
    kind: { type: 'string', required: true, const: 'daily' },
    time: { type: 'string', required: true },
    timeZone: { type: 'string', required: true },
  },
} as const

const WEEKLY_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...SHARED_VIEW_PROPERTIES,
    kind: { type: 'string', required: true, const: 'weekly' },
    time: { type: 'string', required: true },
    timeZone: { type: 'string', required: true },
    weekdays: { type: 'array', required: true, items: { type: 'integer' } },
  },
} as const

const CRON_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...SHARED_VIEW_PROPERTIES,
    kind: { type: 'string', required: true, const: 'cron' },
    expression: { type: 'string', required: true },
    timeZone: { type: 'string', required: true },
  },
} as const

const VIEW_SCHEMA = {
  oneOf: [
    AFTER_VIEW_SCHEMA, AT_VIEW_SCHEMA, EVERY_VIEW_SCHEMA, DAILY_VIEW_SCHEMA, WEEKLY_VIEW_SCHEMA, CRON_VIEW_SCHEMA,
  ],
} as const

/** 构造一个精确的双字段错误 schema，同时保留其字面量 code。 */
function basicErrorSchema<const C extends string>(code: C) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      code: { type: 'string', required: true, const: code },
      message: { type: 'string', required: true },
    },
  } as const
}

const ERROR_SCHEMAS = [
  basicErrorSchema('invalid_prompt'),
  basicErrorSchema('invalid_selector'),
  basicErrorSchema('invalid_rule'),
  basicErrorSchema('invalid_time_zone'),
  basicErrorSchema('not_future'),
  basicErrorSchema('time_out_of_range'),
  basicErrorSchema('frequency_too_high'),
  basicErrorSchema('subagent_session'),
  basicErrorSchema('internal_error'),
] as const

const CREATE_OUTPUT_SCHEMA = { oneOf: [VIEW_SCHEMA, ...ERROR_SCHEMAS] } as const
const LIST_OUTPUT_SCHEMA = {
  oneOf: [
    { type: 'array', items: VIEW_SCHEMA },
    ...ERROR_SCHEMAS,
  ],
} as const
const DELETE_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', required: true },
        deleted: { type: 'boolean', required: true, const: true },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', required: true },
        deleted: { type: 'boolean', required: true, const: false },
        code: { type: 'string', required: true, const: 'schedule_not_found' },
      },
    },
    ...ERROR_SCHEMAS,
  ],
} as const

const UPDATE_OUTPUT_SCHEMA = {
  oneOf: [
    VIEW_SCHEMA,
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', required: true },
        updated: { type: 'boolean', required: true, const: false },
        code: {
          type: 'string',
          required: true,
          enum: ['schedule_not_found', 'schedule_ended', 'schedule_conflict'],
        },
      },
    },
    ...ERROR_SCHEMAS,
  ],
} as const

const CREATE_DESCRIPTION =
  'Create a reminder in the current session that delivers prompt when it becomes due. '
  + 'Supply exactly one timing parameter: after_seconds, at, every_seconds, daily, weekly, or cron. '
  + 'Local times that do not exist in the zone are skipped; repeated local times fire once, at the earlier instant. '
  + 'After downtime, a recurring reminder delivers only its latest missed occurrence. Delivery can repeat after a crash.'

const LIST_DESCRIPTION = 'List the active reminders in the current session.'

const DELETE_DESCRIPTION =
  'Delete a reminder in the current session, active or inactive. Deletion does not retract a reminder message that is already queued.'

const UPDATE_DESCRIPTION =
  'Change a reminder in place, keeping its id. Supply a new title, prompt, or at most one timing parameter; '
  + 'omitted fields keep their stored values. To change a relative delay, create a new reminder.'

const CREATE_TITLE_DESCRIPTION =
  `Concise task name in the user's language, at most ${MAX_TITLE_LENGTH} characters. `
  + 'Name only the core action and subject; keep essential target identifiers such as PR numbers and branch names. '
  + 'Do not include execution frequency (e.g. daily, hourly), scheduled dates/times, time zones, task status, '
  + 'or configuration and execution details (e.g. read-only mode, profile-tag filters), even when embedded in the requested or existing title. '
  + 'Do not append parenthetical notes. '
  + 'Put scheduling information in the timing parameters and execution instructions in prompt.'

/** 为每个规范 Schedule 值生成确定性的模型内容。 */
function renderValue(_args: unknown, value: unknown): ContentBlock[] {
  // ToolRuntime 已经针对无损 JSON 输出 schema 校验过该值。
  const text = JSON.stringify(value)
  return [{ type: 'text', text }]
}

/** 纯的通用待处理卡片。 */
function present(title: string, kind: 'read' | 'other', rawInput?: unknown): GenericCallView {
  return { card: 'generic', title, kind, ...rawInput === undefined ? {} : { rawInput } }
}

/** 针对不宜暴露的失败所返回的稳定错误。 */
function internalError(): InternalScheduleError {
  return { code: 'internal_error', message: 'The schedule operation failed.' }
}

/** 转译非法输入，同时隐瞒内部存储失败。 */
function operationError(error: unknown): ScheduleToolError {
  return error instanceof ScheduleInputError ? { code: error.code, message: error.message } : internalError()
}

/**
 * 拒绝一个作为被委派子级的调用方。subagent 根本不能使用提醒，
 * 因此每个工具都在派发之前拒绝，而不是只依赖挂载 preset 的工具过滤。
 * @param agent - 外层调用存在时的发起调用 agent。
 * @returns 稳定的拒绝，或对顶层调用方返回 undefined。
 */
function subagentCallerRefusal(agent: Agent | undefined): ScheduleToolError | undefined {
  if (agent === undefined || delegationDepthOf(agent) === 0) return undefined
  return { code: 'subagent_session', message: 'A delegated subagent cannot use reminders.' }
}

/** 校验所提供的固定频率间隔：不低于 Host 下限的安全整数，或 undefined。 */
function invalidInterval(everySeconds: number | undefined): ScheduleToolError | undefined {
  if (everySeconds === undefined) return undefined
  if (!Number.isSafeInteger(everySeconds)) {
    return { code: 'invalid_rule', message: 'every_seconds must be a safe integer.' }
  }
  if (everySeconds < MIN_EVERY_INTERVAL_SECONDS) {
    return {
      code: 'frequency_too_high',
      message: `every_seconds must be at least ${MIN_EVERY_INTERVAL_SECONDS}.`,
    }
  }
  return undefined
}

/** 校验开放参数根无法表达的选择器约束。 */
function validateCreateArgs(args: {
  prompt: string
  title: string
  after_seconds?: number
  at?: AtInput
  every_seconds?: number
  daily?: DailyInput
  weekly?: WeeklyInput
  cron?: CronInput
}): ScheduleToolError | undefined {
  const keys = Object.keys(args)
  if (keys.some(key => key !== 'prompt'
    && key !== 'title'
    && key !== 'after_seconds'
    && key !== 'at'
    && key !== 'every_seconds'
    && key !== 'daily'
    && key !== 'weekly'
    && key !== 'cron')
    || Number(args.after_seconds !== undefined)
    + Number(args.at !== undefined)
    + Number(args.every_seconds !== undefined)
    + Number(args.daily !== undefined)
    + Number(args.weekly !== undefined)
    + Number(args.cron !== undefined) !== 1) {
    return {
      code: 'invalid_selector',
      message: 'schedule_create accepts exactly one of after_seconds, at, every_seconds, daily, weekly, or cron.',
    }
  }
  if (args.prompt.trim().length === 0) {
    return { code: 'invalid_prompt', message: 'prompt must be non-empty after trimming.' }
  }
  if (args.title.trim().length === 0) {
    return { code: 'invalid_prompt', message: REQUIRED_TITLE_MESSAGE }
  }
  if (args.title.trim().length > MAX_TITLE_LENGTH) {
    return { code: 'invalid_prompt', message: `title must be at most ${MAX_TITLE_LENGTH} characters.` }
  }
  if (args.after_seconds !== undefined
    && (!Number.isSafeInteger(args.after_seconds) || args.after_seconds <= 0)) {
    return { code: 'invalid_rule', message: 'after_seconds must be a positive safe integer.' }
  }
  return invalidInterval(args.every_seconds)
}

/** 校验原地更新的选择器数量、id，以及任何提供的名称、指令或间隔。 */
function validateUpdateArgs(args: {
  id: string
  title?: string
  prompt?: string
  at?: AtInput
  every_seconds?: number
  daily?: DailyInput
  weekly?: WeeklyInput
  cron?: CronInput
}): ScheduleToolError | undefined {
  const selectors = [
    args.at !== undefined,
    args.every_seconds !== undefined,
    args.daily !== undefined,
    args.weekly !== undefined,
    args.cron !== undefined,
  ].filter(Boolean).length
  if (Object.keys(args).some(key => key !== 'id'
    && key !== 'title'
    && key !== 'prompt'
    && key !== 'at'
    && key !== 'every_seconds'
    && key !== 'daily'
    && key !== 'weekly'
    && key !== 'cron')
    || selectors > 1) {
    return {
      code: 'invalid_selector',
      message: 'schedule_update accepts at most one of at, every_seconds, daily, weekly, or cron.',
    }
  }
  if (args.id.length === 0 || args.id.trim() !== args.id) {
    return { code: 'invalid_rule', message: 'schedule_update id must be non-empty without surrounding whitespace.' }
  }
  if (selectors === 0 && args.title === undefined && args.prompt === undefined) {
    return {
      code: 'invalid_selector',
      message: 'schedule_update needs a new title, prompt, or one of at, every_seconds, daily, weekly, or cron.',
    }
  }
  if (args.title !== undefined && args.title.trim().length === 0) {
    return { code: 'invalid_prompt', message: REQUIRED_TITLE_MESSAGE }
  }
  if (args.title !== undefined && args.title.trim().length > MAX_TITLE_LENGTH) {
    return { code: 'invalid_prompt', message: `title must be at most ${MAX_TITLE_LENGTH} characters.` }
  }
  if (args.prompt !== undefined && args.prompt.trim().length === 0) {
    return { code: 'invalid_prompt', message: 'prompt must be non-empty after trimming.' }
  }
  return invalidInterval(args.every_seconds)
}

/** 本次更新所携带的那一个定时替换；当请求保留已提交目标时为 undefined。 */
function timingChangeFrom(args: {
  at?: AtInput
  every_seconds?: number
  daily?: DailyInput
  weekly?: WeeklyInput
  cron?: CronInput
}): ScheduleTimingChange | undefined {
  if (args.at !== undefined) return { kind: 'at', at: args.at }
  if (args.every_seconds !== undefined) return { kind: 'every', every_seconds: args.every_seconds }
  if (args.daily !== undefined) return { kind: 'daily', daily: args.daily }
  if (args.weekly !== undefined) return { kind: 'weekly', weekly: args.weekly }
  if (args.cron !== undefined) return { kind: 'cron', cron: args.cron }
  return undefined
}

/**
 * `schedule_create` 与 `schedule_update` 共享的选择器参数，
 * 按生成的工具目录所声明的顺序排列。
 */
const SELECTOR_PARAMETERS = {
  every_seconds: {
    type: 'number',
    description: `Fixed-rate interval in whole seconds, at least ${MIN_EVERY_INTERVAL_SECONDS}, aligned to the creation time; changing it with schedule_update re-aligns it to the save time.`,
  },
  daily: {
    type: 'object',
    additionalProperties: false,
    description: 'Every day at a local time.',
    properties: {
      time: { type: 'string', required: true, description: 'HH:mm:ss with optional 1-3 fractional digits, for example 23:00:00.' },
      time_zone: { type: 'string', required: true, description: 'UTC or IANA Area/Location, for example Asia/Shanghai.' },
    },
  },
  weekly: {
    type: 'object',
    additionalProperties: false,
    description: 'On the given weekdays at a local time.',
    properties: {
      time: { type: 'string', required: true, description: 'HH:mm:ss with optional 1-3 fractional digits, for example 09:00:00.' },
      time_zone: { type: 'string', required: true, description: 'UTC or IANA Area/Location, for example Asia/Shanghai.' },
      weekdays: {
        type: 'array',
        required: true,
        description: 'ISO weekdays, Monday 1 through Sunday 7, without repetitions.',
        items: { type: 'integer' },
      },
    },
  },
  cron: {
    type: 'object',
    additionalProperties: false,
    description: 'Five-field Vixie cron expression in a time zone.',
    properties: {
      expression: {
        type: 'string',
        required: true,
        description: 'minute hour day-of-month month day-of-week, for example "*/15 9-17 * * 1-5". '
          + 'When both day fields are restricted, a date matches if either one matches.',
      },
      time_zone: { type: 'string', required: true, description: 'UTC or IANA Area/Location, for example Asia/Shanghai.' },
    },
  },
  at: {
    description: 'Absolute target: an RFC 3339 date-time with offset, or a local date, time, and IANA time_zone.',
    oneOf: [
      { type: 'string' },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          date: { type: 'string', required: true },
          time: { type: 'string', required: true },
          time_zone: { type: 'string', required: true },
        },
      },
    ],
  },
} as const

/**
 * 在挂载作用域中注册四个 Schedule 工具。
 *
 * 每次调用都会改动派发它的 Agent 的 Session，因此在 agent 作用域之外挂载
 * 仍然会注册这些工具，但每次没有调用方 Agent 的调用都会作为内部失败被拒绝。
 * @param ctx - 持有 `tools` 注册表与 Host `schedule` 服务的 Context。
 */
export function apply(ctx: Context): void {
  ctx.inject(['schedule'], (scheduleCtx) => { registerScheduleTools(scheduleCtx) })
}

/**
 * 在解析出 Schedule 服务的那个作用域中注册四个提醒工具。
 * @param ctx - 工具通过它来操作 `schedule` 服务的作用域。
 */
function registerScheduleTools(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'schedule_create',
    description: CREATE_DESCRIPTION,
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'Reminder content to present when the target becomes due.',
      },
      title: {
        type: 'string',
        required: true,
        description: CREATE_TITLE_DESCRIPTION,
      },
      after_seconds: {
        type: 'number',
        description: 'Delay in whole seconds.',
      },
      ...SELECTOR_PARAMETERS,
    },
    output: { schema: CREATE_OUTPUT_SCHEMA, render: renderValue },
    async execute(args, exec): Promise<ScheduleCreateValue> {
      const agent = exec.agent
      if (agent === undefined) return internalError()
      const refusal = subagentCallerRefusal(agent)
      if (refusal !== undefined) return refusal
      const invalid = validateCreateArgs(args)
      if (invalid !== undefined) return invalid
      if (exec.signal.aborted) return internalError()
      try {
        return scheduleView(await ctx.schedule.create(agent.session.id, args, exec.signal), Date.now())
      } catch (error: unknown) {
        return operationError(error)
      }
    },
    presentCall: args => present('Create reminder', 'other', args.prompt),
  }))

  ctx.tools.register(defineTool({
    name: 'schedule_list',
    description: LIST_DESCRIPTION,
    parameters: {},
    output: { schema: LIST_OUTPUT_SCHEMA, render: renderValue },
    async execute(_args, exec): Promise<ScheduleListValue> {
      const agent = exec.agent
      if (agent === undefined) return internalError()
      const refusal = subagentCallerRefusal(agent)
      if (refusal !== undefined) return refusal
      if (exec.signal.aborted) return internalError()
      try {
        const records = await ctx.schedule.list({ sessionId: agent.session.id })
        return records.map(record => scheduleView(record, Date.now()))
      } catch (error: unknown) {
        return operationError(error)
      }
    },
    presentCall: () => present('List reminders', 'read'),
  }))

  ctx.tools.register(defineTool({
    name: 'schedule_delete',
    description: DELETE_DESCRIPTION,
    parameters: {
      id: { type: 'string', required: true, description: 'Exact schedule id.' },
    },
    output: { schema: DELETE_OUTPUT_SCHEMA, render: renderValue },
    async execute(args, exec): Promise<ScheduleDeleteValue> {
      if (args.id.length === 0 || args.id.trim() !== args.id) {
        return { code: 'invalid_rule', message: 'schedule_delete id must be non-empty without surrounding whitespace.' }
      }
      const id = ScheduleId(args.id)
      const agent = exec.agent
      if (agent === undefined) return internalError()
      const refusal = subagentCallerRefusal(agent)
      if (refusal !== undefined) return refusal
      if (exec.signal.aborted) return internalError()
      try {
        return await ctx.schedule.delete({ sessionId: agent.session.id, id }, exec.signal)
      } catch (error: unknown) {
        return operationError(error)
      }
    },
    presentCall: args => present('Delete reminder', 'other', args.id),
  }))

  ctx.tools.register(defineTool({
    name: 'schedule_update',
    description: UPDATE_DESCRIPTION,
    parameters: {
      id: { type: 'string', required: true, description: 'Schedule id returned by schedule_list.' },
      title: {
        type: 'string',
        description: 'New task name; follow the schedule_create title rules.',
      },
      prompt: {
        type: 'string',
        description: 'New reminder content.',
      },
      ...SELECTOR_PARAMETERS,
    },
    output: { schema: UPDATE_OUTPUT_SCHEMA, render: renderValue },
    async execute(args, exec): Promise<ScheduleUpdateValue> {
      const agent = exec.agent
      if (agent === undefined) return internalError()
      const refusal = subagentCallerRefusal(agent)
      if (refusal !== undefined) return refusal
      const invalid = validateUpdateArgs(args)
      if (invalid !== undefined) return invalid
      if (exec.signal.aborted) return internalError()
      const id = ScheduleId(args.id)
      try {
        const sessionId = agent.session.id
        const expected = (await ctx.schedule.list({ sessionId }))
          .find(record => record.id === id)
        if (expected === undefined) {
          // 目录里也包含已停用的提醒，这正是模型可以采取行动的那一种
          // 未找到情况：它必须改为创建一个新的提醒。
          const ended = (await ctx.schedule.catalog())
            .some(entry => entry.sessionId === sessionId && entry.id === id)
          return { id, updated: false, code: ended ? 'schedule_ended' : 'schedule_not_found' }
        }
        const change = timingChangeFrom(args)
        const result = await ctx.schedule.update({
          sessionId,
          id,
          expected,
          ...(change === undefined ? {} : { change }),
          ...(args.title === undefined ? {} : { title: args.title }),
          ...(args.prompt === undefined ? {} : { prompt: args.prompt }),
        }, exec.signal)
        return 'record' in result ? scheduleView(result.record, Date.now()) : result
      } catch (error: unknown) {
        return operationError(error)
      }
    },
    presentCall: args => present('Update reminder', 'other', args.id),
  }))
}
