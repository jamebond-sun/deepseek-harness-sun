/** 对保留的 Host 任务做乐观的名称、指令与定时更新，而不改动 Session。 */
import { isDeepStrictEqual } from 'node:util'
import {
  canonicalizeCronExpression, canonicalizeTimeZone, createAtScheduleRecord, createCronScheduleRecord,
  createDailyScheduleRecord, createEveryScheduleRecord, createWeeklyScheduleRecord, decodeScheduleRecord,
  decodeStoredTitle, parseAtInput, parseCronInput, parseDailyInput, parseWeeklyInput,
  ScheduleInputError, ScheduleLogError, scheduleTitle,
} from './domain.ts'
import type { ScheduleRecord, ScheduleTimingChange, ScheduleUpdateContent, ScheduleUpdateResult } from './types.ts'

/** 给出每种定时类型必须携带的精确选择器属性名；未知判别式返回 undefined。 */
function timingSelector(kind: string): string | undefined {
  switch (kind) {
    case 'at': return 'at'
    case 'every': return 'every_seconds'
    case 'daily': return 'daily'
    case 'weekly': return 'weekly'
    case 'cron': return 'cron'
    default: return undefined
  }
}

/**
 * 校验通过 RPC 收到的精确定时选择器键。
 * @param value - 不可信的定时变更；线上可能携带 null、数组或外来判别式。
 * @returns 同一值，窄化到封闭的定时变更联合类型。
 */
function validateChange(value: unknown): ScheduleTimingChange {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ScheduleInputError('invalid_rule', 'Timing change must be an object with exactly one supported timing selector.')
  }
  const change = value as ScheduleTimingChange
  const selector = timingSelector(change.kind)
  const keys = Object.keys(change)
  if (selector === undefined || keys.length !== 2 || !keys.includes('kind') || !keys.includes(selector)) {
    throw new ScheduleInputError('invalid_rule', 'Timing change must contain exactly kind and its matching timing selector.')
  }
  return change
}

/**
 * 校验通过 RPC 收到的替换指令。
 * @param prompt - 不可信的指令值；线上可能携带非字符串。
 * @returns 修剪后的指令；非法指令抛出 ScheduleInputError。
 */
function schedulePrompt(prompt: string): string {
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new ScheduleInputError('invalid_prompt', 'prompt must be non-empty after trimming.')
  }
  return prompt.trim()
}

/**
 * 一次更新必须保留或替换的名称。
 *
 * 已解码的记录总是携带一个已存储的名称。没有合法名称的记录值会以
 * 持久化解码错误被拒绝，而不是推导出一个名称。
 * @param record - 当前的 Host 活动记录。
 * @returns 已存储的名称；缺失、空白、未修剪或过长的名称抛出 ScheduleLogError。
 */
export function retainedTitle(record: ScheduleRecord): string {
  return decodeStoredTitle(record.title)
}

/**
 * 把一个替换后的名称与指令应用到已存储的记录上，而不触碰其规则。
 * @param current - 持有已提交目标的当前活动记录。
 * @param title - 已校验的替换名称或保留的名称。
 * @param prompt - 已校验的替换指令或保留的指令。
 * @returns 两者都未变时返回同一记录，否则返回带新内容的冻结副本。
 */
function withContent(current: ScheduleRecord, title: string, prompt: string): ScheduleRecord {
  return title === current.title && prompt === current.prompt
    ? current
    : Object.freeze({ ...current, title, prompt })
}

/**
 * 在完整的期望记录匹配之后，针对当前记录解析所请求的规则。
 *
 * 变更类型可能与当前记录的类型不同；若某次变更归一化后的定时等于当前规则，
 * 则保留已提交的目标，只应用所提供的名称与指令；其他任何变更都会完全
 * 按创建时的算法，依据同一个 now 重算目标。
 */
function changedRecord(
  current: ScheduleRecord,
  title: string,
  prompt: string,
  value: ScheduleTimingChange | undefined,
  now: number,
): ScheduleRecord {
  if (value === undefined) return withContent(current, title, prompt)
  const change = validateChange(value)
  switch (change.kind) {
    case 'at':
      if ((current.kind === 'after' || current.kind === 'at')
        && parseAtInput(change.at) === Date.parse(current.scheduledAt)) return withContent(current, title, prompt)
      return createAtScheduleRecord(current.id, prompt, change.at, now, title)
    case 'every':
      if (current.kind === 'every' && change.every_seconds === current.everySeconds) {
        return withContent(current, title, prompt)
      }
      return createEveryScheduleRecord(current.id, prompt, change.every_seconds, now, title)
    case 'daily': {
      if (current.kind === 'daily') {
        const normalized = parseDailyInput(change.daily)
        if (normalized.time === current.time
          && normalized.timeZone === canonicalizeTimeZone(current.timeZone)) return withContent(current, title, prompt)
      }
      return createDailyScheduleRecord(current.id, prompt, change.daily, now, title)
    }
    case 'weekly': {
      if (current.kind === 'weekly') {
        const normalized = parseWeeklyInput(change.weekly)
        if (normalized.time === current.time
          && normalized.timeZone === canonicalizeTimeZone(current.timeZone)
          && isDeepStrictEqual(normalized.weekdays, current.weekdays)) return withContent(current, title, prompt)
      }
      return createWeeklyScheduleRecord(current.id, prompt, change.weekly, now, title)
    }
    case 'cron': {
      if (current.kind === 'cron') {
        const normalized = parseCronInput(change.cron)
        if (normalized.expression === canonicalizeCronExpression(current.expression)
          && normalized.timeZone === canonicalizeTimeZone(current.timeZone)) return withContent(current, title, prompt)
      }
      return createCronScheduleRecord(current.id, prompt, change.cron, now, title)
    }
    /* v8 ignore next 4 -- validateChange 在这个封闭联合类型 switch 之前就会拒绝未知判别式。 */
    default: {
      const unreachable: never = change
      throw new Error(`Unknown validated timing change: ${String(unreachable)}`)
    }
  }
}

/**
 * 使用单次入队时刻的采样，比较完整的观测记录，并解析一次名称、指令与定时更新。
 *
 * 省略的变更、名称或指令保留其已存储的值。单独提供名称或指令绝不会重新
 * 锚定该 schedule；等价的归一化定时变更同样保留已提交的目标。
 * @param current - 当前的 Host 活动记录。
 * @param expected - 调用方观测到的、不可信的完整记录。
 * @param change - 严格的定时选择器，其类型可能与当前记录的类型不同；undefined 表示保留定时。
 * @param now - 来自已接受的 FIFO 槽位的单次墙上时钟采样。
 * @param content - 不可信的替换名称与指令；每个省略的字段保留其已存储的值。
 * @returns 当前/新记录，或有界的输入/冲突结果；无关的失败会抛出。
 */
export function resolveScheduleUpdate(
  current: ScheduleRecord,
  expected: ScheduleRecord,
  change: ScheduleTimingChange | undefined,
  now: number,
  content: ScheduleUpdateContent = {},
): ScheduleUpdateResult {
  let decoded: ScheduleRecord
  try {
    decoded = decodeScheduleRecord(expected)
  } catch (error) {
    if (!(error instanceof ScheduleLogError)) throw error
    return { code: 'invalid_rule', message: 'expected must be a complete valid Schedule record.' }
  }
  if (!isDeepStrictEqual(current, decoded)) {
    return { id: current.id, updated: false, code: 'schedule_conflict' }
  }
  try {
    const retained = retainedTitle(current)
    const title = content.title === undefined ? retained : scheduleTitle(content.title)
    const prompt = content.prompt === undefined ? current.prompt : schedulePrompt(content.prompt)
    const record = changedRecord(current, title, prompt, change, now)
    return { id: current.id, updated: record !== current, record }
  } catch (error) {
    if (!(error instanceof ScheduleInputError)) throw error
    return { code: error.code, message: error.message }
  }
}
