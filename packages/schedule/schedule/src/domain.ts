/**
 * 严格的 Schedule 解码、重放、时间校验与文本框架。
 * @module @deepseek-ai/dsh-schedule
 */

import { Temporal } from '@js-temporal/polyfill'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionLogOffset as SessionLogOffsetType } from '@deepseek-ai/dsh-session'
import type {
  AfterScheduleRecord,
  AtInput,
  AtScheduleRecord,
  EveryScheduleRecord,
  CronInput,
  CronScheduleRecord,
  DailyInput,
  DailyScheduleRecord,
  WeeklyInput,
  WeeklyScheduleRecord,
  LegacyAfterScheduleRecord,
  LegacyAtScheduleRecord,
  LegacyEveryScheduleRecord,
  LegacyScheduleRecord,
  RecurringScheduleRecord,
  LocalAtInput,
  OneShotScheduleRecord,
  ScheduleChange,
  ScheduleId as ScheduleIdType,
  ScheduleRecord,
  ScheduleView,
} from './types.ts'

/** 本包所实现的持久化 Schedule 协议版本。 */
export const SCHEDULE_CHANGE_VERSION = 1 as const

/** v1 中固定频率提醒的固定下限。 */
export const MIN_EVERY_INTERVAL_SECONDS = 60

/** v1 中已存储任务名称的固定上限。 */
export const MAX_TITLE_LENGTH = 120

/**
 * cron 日期搜索的最长向前或向后遍历范围，以年为单位。
 *
 * 格里高利历（proleptic）的闰年与星期对齐每 400 年重复一次，因此任何
 * 能匹配到某个本地日期的规则，在这个窗口内必定有匹配；再往前走只可能
 * 遇到一个永远不匹配的规则。给遍历加上边界，把一个有效但不可满足的规则
 * 的创建与决策代价固定下来，而不是朝四位年份上限不断枚举候选日期。
 */
export const CRON_SEARCH_HORIZON_YEARS = 400

const MIN_FOUR_DIGIT_YEAR_MS = Date.parse('0001-01-01T00:00:00.000Z')
const MAX_FOUR_DIGIT_YEAR_MS = Date.parse('9999-12-31T23:59:59.999Z')
const UTC_INSTANT = /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/
const OFFSET_INSTANT = new RegExp(
  String.raw`^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})`
  + String.raw`T(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})`
  + String.raw`(?:\.(?<fraction>\d{1,3}))?(?<zone>Z|(?<sign>[+-])`
  + String.raw`(?<offsetHour>\d{2}):(?<offsetMinute>\d{2}))$`,
)
const LOCAL_DATE = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/
const LOCAL_TIME = /^(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.(?<fraction>\d{1,3}))?$/
const LOCAL_CLOCK_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?$/
const IANA_ZONE = /^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+$/

/** 来自畸形的、或状态迁移非法的持久化 Schedule 数据的错误。 */
export class ScheduleLogError extends Error {
  /** 稳定的机器可读错误码。 */
  readonly code = 'corrupt_schedule_log' as const

  /**
   * 构造一次持久化日志失败。
   * @param message - 被违反的包内不变量。
   */
  constructor(message: string) {
    super(message)
    this.name = 'ScheduleLogError'
  }
}

/** 来自模型提供的、无法成为记录的 Schedule 规则或目标 Session 的错误。 */
export class ScheduleInputError extends Error {
  /** 稳定的公开 Schedule 输入码。 */
  readonly code:
    | 'invalid_prompt'
    | 'invalid_selector'
    | 'invalid_rule'
    | 'invalid_time_zone'
    | 'not_future'
    | 'time_out_of_range'
    | 'frequency_too_high'
    | 'subagent_session'

  /**
   * 构造一次稳定的输入失败。
   * @param code - 公开的 Schedule 错误判别式。
   * @param message - 稳定的公开诊断信息。
   * @param options - 可选的、被包含的实现原因。
   */
  constructor(
    code:
      | 'invalid_prompt'
      | 'invalid_selector'
      | 'invalid_rule'
      | 'invalid_time_zone'
      | 'not_future'
      | 'time_out_of_range'
      | 'frequency_too_high'
      | 'subagent_session',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'ScheduleInputError'
    this.code = code
  }
}

/** 纯粹的重放结果，保留活动记录的创建顺序与每一个已使用过的 id。 */
export interface FoldedSchedules {
  /** 按原始创建顺序排列的活动记录。 */
  readonly active: readonly LegacyScheduleRecord[]
  /** 该 session 局部后缀中曾经创建过的每一个 id。 */
  readonly seenIds: readonly ScheduleIdType[]
}

/** 一次仅取最新的重复决策，无需枚举积压。 */
export interface RecurringOccurrence {
  /** 在决策时刻到期的最新 occurrence。 */
  readonly occurrenceAt: string
  /** 决策之后的第一个合规目标，或表示耗尽。 */
  readonly nextScheduledAt?: string
}

/**
 * 给一个原始的 session 局部 id 打上品牌标记，而不改变其运行时值。
 * @param value - 原始的 session 局部 id。
 * @returns 同一个字符串，带上 Schedule 品牌。
 */
export function ScheduleId(value: string): ScheduleIdType {
  return value as ScheduleIdType
}

/** 判断一个未知值是否为非数组的对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 要求恰好具有所命名的持久化对象键。 */
function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const allowed = new Set(expected)
  return expected.every(key => key in value) && Object.keys(value).every(key => allowed.has(key))
}

/** 要求所命名的持久化键，同时允许额外的可选成员。 */
function hasExactKeysWithOptional(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional])
  return required.every(key => key in value) && Object.keys(value).every(key => allowed.has(key))
}

/** 针对缺失的、或修剪后为空的名称的稳定诊断信息。 */
export const REQUIRED_TITLE_MESSAGE = 'title is required and must be non-empty after trimming.'

/**
 * 校验创建时提供的名称。
 *
 * 创建要求一个显式的名称：缺失、修剪后为空或超长的值会抛出，
 * 而不是从指令推导出一个名称。
 * @param title - 创建时提供的任务名。
 * @returns 修剪后的名称；非法名称抛出 ScheduleInputError。
 */
export function scheduleTitle(title: string): string {
  if (typeof title !== 'string' || title.trim().length === 0) {
    throw new ScheduleInputError('invalid_prompt', REQUIRED_TITLE_MESSAGE)
  }
  const normalized = title.trim()
  if (normalized.length > MAX_TITLE_LENGTH) {
    throw new ScheduleInputError('invalid_prompt', `title must be at most ${MAX_TITLE_LENGTH} characters.`)
  }
  return normalized
}

/**
 * 在持久化边界校验一个必需的已存储名称。
 *
 * 只有在名称成为必需之后写入的记录才会被读取：缺失、修剪后为空、
 * 未修剪或超长的已存储名称都是非法的，且不会从指令推导出名称。
 * @param value - 不可信的持久化名称字段。
 * @returns 已存储的名称；非法名称抛出 ScheduleLogError。
 */
export function decodeStoredTitle(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ScheduleLogError(REQUIRED_TITLE_MESSAGE)
  }
  if (value.length > MAX_TITLE_LENGTH) {
    throw new ScheduleLogError(`title must be at most ${MAX_TITLE_LENGTH} characters`)
  }
  if (value.trim() !== value) {
    throw new ScheduleLogError('title must be a trimmed string')
  }
  return value
}

/**
 * 先解码一个持久化 Host 记录必需的已存储名称，再要求其精确的键集合。
 *
 * 名称先解码，这样一条缺少该键的记录会报告名称的诊断信息，
 * 而不是该记录的必需键列表。
 * @param value - 已知为对象的、不可信的持久化记录。
 * @param expected - 该记录必须携带的精确键集合，包含 `title`。
 * @param message - 指出该记录必需键的诊断信息。
 * @returns 已存储的名称；非法的名称或键集合抛出 ScheduleLogError。
 */
function decodeRecordTitle(value: Record<string, unknown>, expected: readonly string[], message: string): string {
  const title = decodeStoredTitle(value['title'])
  if (!hasExactKeys(value, expected)) throw new ScheduleLogError(message)
  return title
}

/**
 * 解码一条历史 `schedule/change` 创建记录的已存储名称。
 *
 * 在名称存在之前写入的版本 1 事件没有 `title` 成员，因此键集合在没有
 * 它的情况下被要求，而缺失的成员解码为 undefined。存在的名称
 * 仍然受规范存储形式的约束。
 * @param value - 已知为对象的、不可信的持久化记录。
 * @param expected - 该记录可以携带的精确键集合；其中 `title` 是可选的。
 * @param message - 指出该记录键集合的诊断信息。
 * @returns 已存储的名称，或当该历史记录早于名称存在时返回 undefined。
 */
function decodeHistoricalRecordTitle(
  value: Record<string, unknown>,
  expected: readonly string[],
  message: string,
): string | undefined {
  const keys = expected.filter(key => key !== 'title')
  if (!hasExactKeysWithOptional(value, keys, ['title'])) throw new ScheduleLogError(message)
  return value['title'] === undefined ? undefined : decodeStoredTitle(value['title'])
}

/** 在持久化边界校验一个稳定的 session 局部 id。 */
function decodeId(value: unknown): ScheduleIdType {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new ScheduleLogError('schedule id must be a non-empty string without surrounding whitespace')
  }
  return ScheduleId(value)
}

/** 校验一个规范的四位年份 UTC 时刻。 */
function decodeInstant(value: unknown): string {
  if (typeof value !== 'string' || !UTC_INSTANT.test(value)) {
    throw new ScheduleLogError('scheduledAt must be a canonical four-digit-year RFC 3339 UTC instant')
  }
  const epoch = Date.parse(value)
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    throw new ScheduleLogError('scheduledAt is not a real UTC calendar instant')
  }
  return value
}

interface CalendarParts {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly second: number
  readonly millisecond: number
}

/** 把一个必需的具名正则分组读成数字。 */
function groupNumber(groups: Record<string, string | undefined>, name: string): number {
  const value = groups[name]
  /* v8 ignore next -- 成功的固定正则总是提供每一个被请求的分组。 */
  if (value === undefined) throw new ScheduleInputError('invalid_rule', 'The at value has an invalid shape.')
  return Number(value)
}

/** 把精确的日历字段转换为 UTC 形态的 epoch，同时拒绝归一化。 */
function calendarEpoch(parts: CalendarParts): number {
  const value = new Date(0)
  value.setUTCHours(0, 0, 0, 0)
  value.setUTCFullYear(parts.year, parts.month - 1, parts.day)
  value.setUTCHours(parts.hour, parts.minute, parts.second, parts.millisecond)
  const epoch = value.getTime()
  if (!Number.isFinite(epoch)
    || value.getUTCFullYear() !== parts.year
    || value.getUTCMonth() + 1 !== parts.month
    || value.getUTCDate() !== parts.day
    || value.getUTCHours() !== parts.hour
    || value.getUTCMinutes() !== parts.minute
    || value.getUTCSeconds() !== parts.second
    || value.getUTCMilliseconds() !== parts.millisecond) {
    throw new ScheduleInputError('invalid_rule', 'The at value must be a real ISO calendar date and time.')
  }
  return epoch
}

/** 把可选的一到三位小数秒归一化为毫秒。 */
function milliseconds(value: string | undefined): number {
  return value === undefined ? 0 : Number(value.padEnd(3, '0'))
}

/** 要求一个安全、可表示且严格处于未来的 UTC 目标。 */
function futureInstant(epoch: number, now: number): string {
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(epoch)
    || epoch < MIN_FOUR_DIGIT_YEAR_MS || epoch > MAX_FOUR_DIGIT_YEAR_MS) {
    throw new ScheduleInputError(
      'time_out_of_range',
      'The scheduled time must be representable as a four-digit-year RFC 3339 UTC instant.',
    )
  }
  if (epoch <= now) {
    throw new ScheduleInputError('not_future', 'The scheduled time must be strictly in the future.')
  }
  const instant = new Date(epoch).toISOString()
  /* v8 ignore next -- 范围内的整数 Date 总是格式化为规范的 UTC 形态。 */
  if (!UTC_INSTANT.test(instant)) {
    throw new ScheduleInputError(
      'time_out_of_range',
      'The scheduled time must be representable as a four-digit-year RFC 3339 UTC instant.',
    )
  }
  return instant
}

/** 解析一个严格的 RFC 3339 时刻，其数字偏移是输入的一部分。 */
function parseOffsetInstant(value: string): number {
  const match = OFFSET_INSTANT.exec(value)
  const groups = match?.groups
  if (groups === undefined) {
    throw new ScheduleInputError(
      'invalid_rule',
      'at must use YYYY-MM-DDTHH:mm:ss with optional 1-3 digit fractional seconds and an explicit Z or numeric offset.',
    )
  }
  const parts: CalendarParts = {
    year: groupNumber(groups, 'year'),
    month: groupNumber(groups, 'month'),
    day: groupNumber(groups, 'day'),
    hour: groupNumber(groups, 'hour'),
    minute: groupNumber(groups, 'minute'),
    second: groupNumber(groups, 'second'),
    millisecond: milliseconds(groups['fraction']),
  }
  if (parts.year === 0 || parts.hour > 23 || parts.minute > 59 || parts.second > 59) {
    throw new ScheduleInputError('invalid_rule', 'The at value must be a real ISO calendar date and time.')
  }
  const localEpoch = calendarEpoch(parts)
  if (groups['zone'] === 'Z') return localEpoch
  const offsetHour = groupNumber(groups, 'offsetHour')
  const offsetMinute = groupNumber(groups, 'offsetMinute')
  if (offsetHour > 23 || offsetMinute > 59
    || (groups['sign'] === '-' && offsetHour === 0 && offsetMinute === 0)) {
    throw new ScheduleInputError('invalid_rule', 'The at numeric offset is invalid.')
  }
  const direction = groups['sign'] === '+' ? 1 : -1
  return localEpoch - direction * (offsetHour * 60 + offsetMinute) * 60_000
}

/**
 * 校验并规范化一个原始的 IANA 时区选择器。
 * @param value - 候选的 `UTC` 或 IANA Area/Location 名称。
 * @returns 运行时的规范 IANA 名称。
 */
export function canonicalizeTimeZone(value: string): string {
  if (value.length === 0 || value.trim() !== value || (value !== 'UTC' && !IANA_ZONE.test(value))) {
    throw new ScheduleInputError('invalid_time_zone', 'time_zone must be UTC or a valid IANA Area/Location name.')
  }
  let canonical: string
  try {
    canonical = new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone
  } catch (error: unknown) {
    throw new ScheduleInputError(
      'invalid_time_zone',
      'time_zone must be UTC or a valid IANA Area/Location name.',
      { cause: error },
    )
  }
  /* v8 ignore next -- Intl 返回请求的规范时区，或一个 IANA 规范别名。 */
  if (canonical !== 'UTC' && !IANA_ZONE.test(canonical)) {
    throw new ScheduleInputError('invalid_time_zone', 'time_zone must resolve to UTC or an IANA Area/Location name.')
  }
  return canonical
}

/** 解析严格的本地日历字段，不查询进程时区。 */
function parseLocalAt(value: LocalAtInput): CalendarParts {
  const dateMatch = LOCAL_DATE.exec(value.date)
  const timeMatch = LOCAL_TIME.exec(value.time)
  const date = dateMatch?.groups
  const time = timeMatch?.groups
  if (date === undefined || time === undefined) {
    throw new ScheduleInputError(
      'invalid_rule',
      'Local at requires date YYYY-MM-DD and time HH:mm:ss with optional one-to-three digit milliseconds.',
    )
  }
  const parts: CalendarParts = {
    year: groupNumber(date, 'year'),
    month: groupNumber(date, 'month'),
    day: groupNumber(date, 'day'),
    hour: groupNumber(time, 'hour'),
    minute: groupNumber(time, 'minute'),
    second: groupNumber(time, 'second'),
    millisecond: milliseconds(time['fraction']),
  }
  if (parts.year === 0 || parts.hour > 23 || parts.minute > 59 || parts.second > 59) {
    throw new ScheduleInputError('invalid_rule', 'The local at value must be a real ISO calendar date and time.')
  }
  calendarEpoch(parts)
  return parts
}

/** 只解析较早的重叠时刻；时间间隙会让本地字段往返失败。 */
function localInstant(local: Temporal.PlainDateTime, timeZone: string): number | undefined {
  const zoned = local.toZonedDateTime(timeZone, { disambiguation: 'earlier' })
  return zoned.toPlainDateTime().equals(local) ? zoned.epochMilliseconds : undefined
}

/** 解析一个本地一次性目标，拒绝不存在的墙上时钟时间。 */
function resolveLocalInstant(parts: CalendarParts, timeZone: string): number {
  const target = localInstant(Temporal.PlainDateTime.from(parts, { overflow: 'reject' }), timeZone)
  if (target === undefined) {
    throw new ScheduleInputError('invalid_rule', 'The local at time does not exist in the selected time zone.')
  }
  return target
}

/** 解码精确的 v1 after 记录结构。 */
function decodeAfterRecord(value: unknown): LegacyAfterScheduleRecord {
  /* v8 ignore next -- decodeLegacyScheduleRecord 在分派到这里之前已拒绝非对象。 */
  if (!isRecord(value)) throw new ScheduleLogError('after schedule must be an object')
  const title = decodeHistoricalRecordTitle(
    value,
    ['id', 'kind', 'title', 'prompt', 'afterSeconds', 'scheduledAt'],
    'after schedule must contain exactly id, kind, title, prompt, afterSeconds, and scheduledAt',
  )
  const prompt = value['prompt']
  if (typeof prompt !== 'string' || prompt.length === 0 || prompt.trim() !== prompt) {
    throw new ScheduleLogError('after prompt must be non-empty and already trimmed')
  }
  const afterSeconds = value['afterSeconds']
  if (!Number.isSafeInteger(afterSeconds) || (afterSeconds as number) <= 0) {
    throw new ScheduleLogError('afterSeconds must be a positive safe integer')
  }
  return Object.freeze({
    id: decodeId(value['id']),
    kind: 'after',
    ...(title === undefined ? {} : { title }),
    prompt,
    afterSeconds: afterSeconds as number,
    scheduledAt: decodeInstant(value['scheduledAt']),
  })
}

/** 解码精确的 v1 绝对一次性记录结构。 */
function decodeAtRecord(value: unknown): LegacyAtScheduleRecord {
  /* v8 ignore next -- decodeLegacyScheduleRecord 在分派到这里之前已拒绝非对象。 */
  if (!isRecord(value)) throw new ScheduleLogError('at schedule must be an object')
  const title = decodeHistoricalRecordTitle(
    value,
    ['id', 'kind', 'title', 'prompt', 'scheduledAt'],
    'at schedule must contain exactly id, kind, title, prompt, and scheduledAt',
  )
  const prompt = value['prompt']
  if (typeof prompt !== 'string' || prompt.length === 0 || prompt.trim() !== prompt) {
    throw new ScheduleLogError('at prompt must be non-empty and already trimmed')
  }
  return Object.freeze({
    id: decodeId(value['id']),
    kind: 'at',
    ...(title === undefined ? {} : { title }),
    prompt,
    scheduledAt: decodeInstant(value['scheduledAt']),
  })
}

/** 解码精确的 v1 固定频率记录结构。 */
function decodeEveryRecord(value: unknown): LegacyEveryScheduleRecord {
  /* v8 ignore next -- decodeLegacyScheduleRecord 在分派到这里之前已拒绝非对象。 */
  if (!isRecord(value)) throw new ScheduleLogError('every schedule must be an object')
  const title = decodeHistoricalRecordTitle(
    value,
    ['id', 'kind', 'title', 'prompt', 'everySeconds', 'scheduledAt'],
    'every schedule must contain exactly id, kind, title, prompt, everySeconds, and scheduledAt',
  )
  const prompt = value['prompt']
  if (typeof prompt !== 'string' || prompt.length === 0 || prompt.trim() !== prompt) {
    throw new ScheduleLogError('every prompt must be non-empty and already trimmed')
  }
  const everySeconds = value['everySeconds']
  const interval = typeof everySeconds === 'number' ? everySeconds * 1_000 : Number.NaN
  if (!Number.isSafeInteger(everySeconds)
    || (everySeconds as number) < MIN_EVERY_INTERVAL_SECONDS
    || !Number.isSafeInteger(interval)) {
    throw new ScheduleLogError(`everySeconds must be a safe integer of at least ${MIN_EVERY_INTERVAL_SECONDS}`)
  }
  return Object.freeze({
    id: decodeId(value['id']),
    kind: 'every',
    ...(title === undefined ? {} : { title }),
    prompt,
    everySeconds: everySeconds as number,
    scheduledAt: decodeInstant(value['scheduledAt']),
  })
}

/**
 * 解析各墙上时钟选择器共享的一个严格本地时钟时间。
 * @param value - 候选的 `HH:mm:ss` 时间，可带一到三位小数。
 * @param selector - 诊断信息中使用的公开选择器名称。
 * @returns 解析出的 plain time；畸形输入抛出 ScheduleInputError。
 */
function localClockTime(value: string, selector: string): Temporal.PlainTime {
  if (!LOCAL_CLOCK_TIME.test(value)) {
    throw new ScheduleInputError(
      'invalid_rule',
      `${selector}.time must use HH:mm:ss with optional 1-3 fractional digits, without leap seconds or 24:00.`,
    )
  }
  return Temporal.PlainTime.from(value)
}

/** 在 Temporal 能够约束或强制转换所提供的时间之前先行严格解析。 */
function dailyTime(value: string): Temporal.PlainTime {
  return localClockTime(value, 'daily')
}

/**
 * 解析 weekly 选择器接受的一个严格本地时钟时间。
 * @param value - 候选的 `HH:mm:ss` 时间，可带一到三位小数。
 * @returns 解析出的 plain time；畸形输入抛出 ScheduleInputError。
 */
export function weeklyTime(value: string): Temporal.PlainTime {
  return localClockTime(value, 'weekly')
}

/** 让已带类型的持久化值失败，而不包装存储数据的诊断信息。 */
function rethrowLogError(error: unknown): never {
  /* v8 ignore next -- 每个被包装的调用抛出的都是 ScheduleInputError，所以这条透传永不触发。 */
  if (error instanceof ScheduleLogError) throw error
  throw new ScheduleLogError(String(error))
}

/** 解码一个 Host 每日规则，而不重新解析其已提交的 UTC 目标。 */
function decodeDailyRecord(value: Record<string, unknown>): DailyScheduleRecord {
  const title = decodeRecordTitle(
    value,
    ['id', 'kind', 'title', 'prompt', 'time', 'timeZone', 'scheduledAt'],
    'daily schedule must contain exactly id, kind, title, prompt, time, timeZone, and scheduledAt',
  )
  const prompt = value['prompt']
  if (typeof prompt !== 'string' || prompt.length === 0 || prompt.trim() !== prompt) {
    throw new ScheduleLogError('daily prompt must be non-empty and already trimmed')
  }
  const time = value['time']
  const timeZone = value['timeZone']
  if (typeof time !== 'string' || typeof timeZone !== 'string') {
    throw new ScheduleLogError('daily time and timeZone must be strings')
  }
  let normalized: string
  try {
    normalized = dailyTime(time).toString({ fractionalSecondDigits: 3 })
    canonicalizeTimeZone(timeZone)
  } catch (error: unknown) {
    rethrowLogError(error)
  }
  if (time !== normalized) throw new ScheduleLogError('daily time must be normalized to HH:mm:ss.SSS')
  return Object.freeze({
    id: decodeId(value['id']), kind: 'daily', title, prompt, time, timeZone,
    scheduledAt: decodeInstant(value['scheduledAt']),
  })
}

/**
 * 归一化一个每周规则的显式 ISO 星期集合。
 * @param weekdays - 不可信的候选星期值。
 * @returns 冻结的、从 1（周一）到 7（周日）的唯一升序星期。
 */
export function normalizeWeekdays(weekdays: unknown): number[] {
  if (!Array.isArray(weekdays) || weekdays.length === 0) {
    throw new ScheduleInputError('invalid_rule', 'weekly.weekdays must be a non-empty array of ISO weekday numbers.')
  }
  const unique = new Set<number>()
  for (const weekday of weekdays as unknown[]) {
    if (typeof weekday !== 'number' || !Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
      throw new ScheduleInputError(
        'invalid_rule', 'Each weekly.weekdays entry must be an integer from 1 (Monday) through 7 (Sunday).',
      )
    }
    if (unique.has(weekday)) {
      throw new ScheduleInputError('invalid_rule', `weekly.weekdays must not repeat weekday ${weekday}.`)
    }
    unique.add(weekday)
  }
  const ordered = [...unique].sort((left, right) => left - right)
  Object.freeze(ordered)
  return ordered
}
/**
 * 解码一个 Host 每周规则，而不重新解析其已提交的 UTC 目标。
 * @param value - 已识别为 weekly 的、不可信的持久化记录。
 * @returns 脱钩并冻结的每周记录；畸形字段抛出 ScheduleLogError。
 */
function decodeWeeklyRecord(value: Record<string, unknown>): WeeklyScheduleRecord {
  const title = decodeRecordTitle(
    value,
    ['id', 'kind', 'title', 'prompt', 'time', 'timeZone', 'weekdays', 'scheduledAt'],
    'weekly schedule must contain exactly id, kind, title, prompt, time, timeZone, weekdays, and scheduledAt',
  )
  const prompt = value['prompt']
  if (typeof prompt !== 'string' || prompt.length === 0 || prompt.trim() !== prompt) {
    throw new ScheduleLogError('weekly prompt must be non-empty and already trimmed')
  }
  const time = value['time']
  const timeZone = value['timeZone']
  if (typeof time !== 'string' || typeof timeZone !== 'string') {
    throw new ScheduleLogError('weekly time and timeZone must be strings')
  }
  try {
    canonicalizeTimeZone(timeZone)
  } catch (error: unknown) {
    rethrowLogError(error)
  }
  let normalized: string
  try {
    normalized = weeklyTime(time).toString({ fractionalSecondDigits: 3 })
  } catch (error: unknown) {
    rethrowLogError(error)
  }
  if (time !== normalized) throw new ScheduleLogError('weekly time must be normalized to HH:mm:ss.SSS')
  // normalizeWeekdays 在本检查把它与解码副本比较之前，已证明该字段是数字数组。
  const stored = value['weekdays'] as number[]
  let weekdays: number[]
  try {
    weekdays = normalizeWeekdays(stored)
  } catch (error: unknown) {
    rethrowLogError(error)
  }
  if (weekdays.some((weekday, index) => weekday !== stored[index])) {
    throw new ScheduleLogError('weekly weekdays must be normalized to unique ascending ISO weekday numbers')
  }
  return Object.freeze({
    id: decodeId(value['id']), kind: 'weekly', title, prompt, time, timeZone,
    weekdays, scheduledAt: decodeInstant(value['scheduledAt']),
  })
}

/**
 * 解码一个 Host cron 规则，而不重新解析其已提交的 UTC 目标。
 * @param value - 已识别为 cron 的、不可信的持久化记录。
 * @returns 脱钩并冻结的 cron 记录；畸形字段抛出 ScheduleLogError。
 */
function decodeCronRecord(value: Record<string, unknown>): CronScheduleRecord {
  const title = decodeRecordTitle(
    value,
    ['id', 'kind', 'title', 'prompt', 'expression', 'timeZone', 'scheduledAt'],
    'cron schedule must contain exactly id, kind, title, prompt, expression, timeZone, and scheduledAt',
  )
  const prompt = value['prompt']
  if (typeof prompt !== 'string' || prompt.length === 0 || prompt.trim() !== prompt) {
    throw new ScheduleLogError('cron prompt must be non-empty and already trimmed')
  }
  const expression = value['expression']
  const timeZone = value['timeZone']
  if (typeof expression !== 'string' || typeof timeZone !== 'string') {
    throw new ScheduleLogError('cron expression and timeZone must be strings')
  }
  try {
    canonicalizeTimeZone(timeZone)
  } catch (error: unknown) {
    rethrowLogError(error)
  }
  let canonical: string
  try {
    canonical = parseCronExpression(expression).expression
  } catch (error: unknown) {
    rethrowLogError(error)
  }
  if (expression !== canonical) throw new ScheduleLogError('cron expression must be canonical')
  return Object.freeze({
    id: decodeId(value['id']), kind: 'cron', title, prompt, expression, timeZone,
    scheduledAt: decodeInstant(value['scheduledAt']),
  })
}

/**
 * 解码一个当前的 Host 任务记录，保留其已提交的目标与已存储的时区拼写。
 *
 * 一个已存储 Host 任务的每个变体都携带其名称，因此历史的一次性变体
 * 在其结构解码之后会被再次检查该成员。
 * @param value - 不可信的持久化 JSON 记录。
 * @returns 脱钩并冻结的记录；畸形字段抛出 ScheduleLogError。
 */
export function decodeScheduleRecord(value: unknown): ScheduleRecord {
  if (isRecord(value) && value['kind'] === 'daily') return decodeDailyRecord(value)
  if (isRecord(value) && value['kind'] === 'weekly') return decodeWeeklyRecord(value)
  if (isRecord(value) && value['kind'] === 'cron') return decodeCronRecord(value)
  const record = decodeLegacyScheduleRecord(value)
  if (record.title === undefined) throw new ScheduleLogError(REQUIRED_TITLE_MESSAGE)
  return record as ScheduleRecord
}

/**
 * 只解码历史版本 1 Session 事件所承认的那些变体。
 *
 * 在名称存在之前写入的记录会解码为不带该成员，因此折叠过程仍能读取
 * 一段当前创建路径无法写入的日志。
 * @param value - 来自 Session 事件的、不可信的持久化 JSON 记录。
 * @returns 脱钩并冻结的记录；当事件省略了名称时不带名称。
 */
function decodeLegacyScheduleRecord(value: unknown): LegacyScheduleRecord {
  if (!isRecord(value)) throw new ScheduleLogError('schedule record must be an object')
  switch (value['kind']) {
    case 'after': return decodeAfterRecord(value)
    case 'at': return decodeAtRecord(value)
    case 'every': return decodeEveryRecord(value)
    default: throw new ScheduleLogError('v1 schedule kind must be "after", "at", or "every"')
  }
}

/**
 * 解码一个严格的版本 1 `schedule/change` 载荷。
 * @param value - 不可信的持久化 JSON 值。
 * @returns 脱钩并冻结的 Schedule 变更。
 */
export function decodeScheduleChange(value: unknown): ScheduleChange {
  if (!isRecord(value)) throw new ScheduleLogError('schedule/change payload must be an object')
  if (value['version'] !== SCHEDULE_CHANGE_VERSION) {
    throw new ScheduleLogError('schedule/change version must be 1')
  }
  switch (value['operation']) {
    case 'create':
      if (!hasExactKeys(value, ['version', 'operation', 'schedule'])) {
        throw new ScheduleLogError('schedule create must contain exactly version, operation, and schedule')
      }
      return Object.freeze({
        version: SCHEDULE_CHANGE_VERSION,
        operation: 'create',
        schedule: decodeLegacyScheduleRecord(value['schedule']),
      })
    case 'delete': {
      if (!hasExactKeys(value, ['version', 'operation', 'id'])) {
        throw new ScheduleLogError('schedule delete must contain exactly version, operation, and id')
      }
      return Object.freeze({
        version: SCHEDULE_CHANGE_VERSION,
        operation: 'delete',
        id: decodeId(value['id']),
      })
    }
    case 'dispatch': {
      if (hasExactKeys(value, ['version', 'operation', 'id'])) {
        return Object.freeze({
          version: SCHEDULE_CHANGE_VERSION,
          operation: 'dispatch',
          id: decodeId(value['id']),
        })
      }
      if (hasExactKeys(value, ['version', 'operation', 'id', 'acceptedAt'])) {
        return Object.freeze({
          version: SCHEDULE_CHANGE_VERSION,
          operation: 'dispatch',
          id: decodeId(value['id']),
          acceptedAt: decodeInstant(value['acceptedAt']),
        })
      }
      throw new ScheduleLogError('schedule dispatch must contain id and optional acceptedAt only')
    }
    default:
      throw new ScheduleLogError('schedule/change operation must be create, delete, or dispatch')
  }
}

/** 一次固定频率决策需要从其记录中取得的定时字段。 */
type EveryOccurrenceInput = Pick<EveryScheduleRecord, 'everySeconds' | 'scheduledAt'>

/**
 * 解析一次固定频率决策，而不枚举错过的 occurrence。
 * @param record - 其目标为最早未被接受 occurrence 的活动记录。
 * @param acceptedAt - 以 epoch 毫秒表示的墙上时钟决策时间。
 * @returns 最新的到期 occurrence，以及第一个严格处于未来的目标（若可表示）。
 */
export function resolveEveryOccurrence(
  record: EveryOccurrenceInput,
  acceptedAt: number,
): RecurringOccurrence {
  const target = Date.parse(record.scheduledAt)
  const interval = record.everySeconds * 1_000
  if (!Number.isSafeInteger(acceptedAt)
    || acceptedAt < MIN_FOUR_DIGIT_YEAR_MS
    || acceptedAt > MAX_FOUR_DIGIT_YEAR_MS) {
    throw new ScheduleLogError('every acceptedAt must be a representable four-digit-year instant')
  }
  if (!Number.isSafeInteger(interval) || interval <= 0) {
    throw new ScheduleLogError('every interval milliseconds must be a positive safe integer')
  }
  if (acceptedAt < target) {
    throw new ScheduleLogError('every dispatch cannot precede the active scheduledAt')
  }
  const steps = Math.floor((acceptedAt - target) / interval)
  const occurrence = target + steps * interval
  /* v8 ignore next -- 有界的操作数与由商推导出的乘积始终保持安全。 */
  if (!Number.isSafeInteger(occurrence) || occurrence < target || occurrence > acceptedAt) {
    throw new ScheduleLogError('every occurrence arithmetic must stay within the accepted interval')
  }
  const occurrenceAt = new Date(occurrence).toISOString()
  const next = occurrence + interval
  if (!Number.isSafeInteger(next) || next > MAX_FOUR_DIGIT_YEAR_MS) {
    return Object.freeze({ occurrenceAt })
  }
  return Object.freeze({
    occurrenceAt,
    nextScheduledAt: new Date(next).toISOString(),
  })
}

/** 把一个显式时刻投影到该规则时区下的日历日期。 */
function localDate(epoch: number, timeZone: string): Temporal.PlainDate {
  return Temporal.Instant.fromEpochMilliseconds(epoch).toZonedDateTimeISO(timeZone).toPlainDate()
}

/** 在一个本地日历日期上识别该规则的某个显式 ISO 星期。 */
type WeekdayMatch = (date: Temporal.PlainDate) => boolean

/** 不跳过任何本地日期；供仅按时间选择的规则使用。 */
const EVERY_DATE: WeekdayMatch = () => true

/** 选择一个已归一化每周规则的显式 ISO 星期。 */
function weekdaySet(weekdays: readonly number[]): WeekdayMatch {
  const selected = new Set(weekdays)
  return date => selected.has(date.dayOfWeek)
}

/** 找出 now 之后、且在提供时还在某个已投递日期之后的第一个实际 occurrence。 */
function nextMatchingTarget(
  time: Temporal.PlainTime,
  timeZone: string,
  now: number,
  matches: WeekdayMatch,
  afterDate?: Temporal.PlainDate,
): string | undefined {
  let date = localDate(now, timeZone)
  const lastDate = localDate(MAX_FOUR_DIGIT_YEAR_MS, 'UTC').add({ days: 1 })
  if (afterDate !== undefined && Temporal.PlainDate.compare(date, afterDate) <= 0) {
    date = afterDate.add({ days: 1 })
  }
  for (; Temporal.PlainDate.compare(date, lastDate) <= 0; date = date.add({ days: 1 })) {
    if (!matches(date)) continue
    const target = localInstant(date.toPlainDateTime(time), timeZone)
    if (target === undefined) continue
    if (target > MAX_FOUR_DIGIT_YEAR_MS) return undefined
    if (target >= MIN_FOUR_DIGIT_YEAR_MS && target > now) return new Date(target).toISOString()
  }
  return undefined
}

/** 在不越过已提交下限的前提下，找出决策时刻或之前的最新实际 occurrence。 */
function latestDueOccurrence(
  timeZone: string,
  matches: WeekdayMatch,
  time: Temporal.PlainTime,
  acceptedAt: number,
  savedTarget: number,
): number {
  // 偏移量小于 24 小时；日期线回退可能使当前本地日期早于某个到期日期。
  let date = localDate(acceptedAt, 'UTC').add({ days: 1 })
  for (;; date = date.subtract({ days: 1 })) {
    if (!matches(date)) continue
    const candidate = localInstant(date.toPlainDateTime(time), timeZone)
    if (candidate === undefined || candidate > acceptedAt) continue
    // 即使当前的 tzdata 把该规则排到它之前，已提交的目标仍然到期。
    return Math.max(candidate, savedTarget)
  }
}

/** 仅当墙上时钟规则的决策处于一个可表示的四位年份时刻时才解析它。 */
function acceptedDecision(selector: string, acceptedAt: number): number {
  if (!Number.isSafeInteger(acceptedAt)
    || acceptedAt < MIN_FOUR_DIGIT_YEAR_MS || acceptedAt > MAX_FOUR_DIGIT_YEAR_MS) {
    throw new ScheduleLogError(`${selector} acceptedAt must be a representable four-digit-year instant`)
  }
  return acceptedAt
}

/** 找出 now 之后、且在提供时还在某个已投递日期之后的第一个实际每日 occurrence。 */
function nextDailyTarget(
  time: Temporal.PlainTime,
  timeZone: string,
  now: number,
  afterDate?: Temporal.PlainDate,
): string | undefined {
  return nextMatchingTarget(time, timeZone, now, EVERY_DATE, afterDate)
}

/**
 * 在决策所在的本地日期附近解析一次每日决策，而不是跨越其错过的历史。
 * @param record - 带有已提交的最早未被接受 UTC 目标的每日规则。
 * @param acceptedAt - 显式的墙上时钟决策时间，不早于已提交的目标。
 * @returns 最新的实际到期 occurrence，以及更晚一个本地日期上的下一次 occurrence。
 */
export function resolveDailyOccurrence(record: DailyScheduleRecord, acceptedAt: number): RecurringOccurrence {
  const decision = acceptedDecision('daily', acceptedAt)
  const savedTarget = Date.parse(record.scheduledAt)
  if (decision < savedTarget) throw new ScheduleLogError('daily dispatch cannot precede the active scheduledAt')
  const time = dailyTime(record.time)
  const occurrence = latestDueOccurrence(record.timeZone, EVERY_DATE, time, decision, savedTarget)
  const occurrenceAt = new Date(occurrence).toISOString()
  const nextScheduledAt = nextDailyTarget(time, record.timeZone, decision, localDate(occurrence, record.timeZone))
  return Object.freeze(nextScheduledAt === undefined ? { occurrenceAt } : { occurrenceAt, nextScheduledAt })
}

/**
 * 找出 now 之后、且在提供时还在某个已投递日期之后的第一个实际每周 occurrence。
 * @param time - 规则的已归一化本地时钟时间。
 * @param timeZone - 解释该时钟时间的显式时区。
 * @param weekdays - 规则的已归一化显式 ISO 星期。
 * @param now - 以 epoch 毫秒表示的显式决策时间。
 * @param afterDate - 已投递 occurrence 所在的本地日期，不参与搜索。
 * @returns 第一个严格处于未来的目标，或耗尽时为 undefined。
 */
function nextWeeklyTarget(
  time: Temporal.PlainTime,
  timeZone: string,
  weekdays: readonly number[],
  now: number,
  afterDate?: Temporal.PlainDate,
): string | undefined {
  return nextMatchingTarget(time, timeZone, now, weekdaySet(weekdays), afterDate)
}

/**
 * 在决策所在的本地日期附近解析一次每周决策，而不是跨越其错过的历史。
 * @param record - 带有已提交的最早未被接受 UTC 目标的每周规则。
 * @param acceptedAt - 显式的墙上时钟决策时间，不早于已提交的目标。
 * @returns 最新的实际到期 occurrence，以及某个被选中星期上的下一次 occurrence。
 */
export function resolveWeeklyOccurrence(record: WeeklyScheduleRecord, acceptedAt: number): RecurringOccurrence {
  const decision = acceptedDecision('weekly', acceptedAt)
  const savedTarget = Date.parse(record.scheduledAt)
  if (decision < savedTarget) throw new ScheduleLogError('weekly dispatch cannot precede the active scheduledAt')
  const time = weeklyTime(record.time)
  const weekdays = normalizeWeekdays(record.weekdays)
  const occurrence = latestDueOccurrence(record.timeZone, weekdaySet(weekdays), time, decision, savedTarget)
  const occurrenceAt = new Date(occurrence).toISOString()
  const nextScheduledAt = nextWeeklyTarget(time, record.timeZone, weekdays, decision, localDate(occurrence, record.timeZone))
  return Object.freeze(nextScheduledAt === undefined ? { occurrenceAt } : { occurrenceAt, nextScheduledAt })
}

/**
 * 按 Vixie 的日/周语义构造一个已解析 cron 规则的本地日期判定函数。
 *
 * star 标志只用于选择分支；它绝不会豁免字段自身的匹配值。当任一字段文本
 * 以 `*` 开头时，一个本地日期必须同时满足两个字段，因此像 `*` 后跟 `/2`
 * 这样的步进 star 依然限制它所匹配的日期。裸 `*` 匹配每一个值，这使该字段
 * 的匹配恒为真，并把 AND 退化为另一个字段，正如 Vixie 的
 * `DOM_STAR`/`DOW_STAR` 判定。只有当两个字段文本都不以 `*` 开头时，
 * 任一字段匹配才足够。
 * @param parsed - 带有规范字段文本与匹配值的已解析 cron 规则。
 * @returns 某个本地日期是否匹配该规则。
 */
function cronDateMatch(parsed: ParsedCronExpression): WeekdayMatch {
  const months = new Set(parsed.months)
  const daysOfMonth = new Set(parsed.daysOfMonth)
  const daysOfWeek = new Set(parsed.daysOfWeek)
  const dayOfMonthRestricted = !parsed.dayOfMonthStar
  const dayOfWeekRestricted = !parsed.dayOfWeekStar
  return (date) => {
    /* v8 ignore next -- 两个调用方在匹配日期之前都已按月份预筛。 */
    if (!months.has(date.month)) return false
    const dayOfMonth = daysOfMonth.has(date.day)
    const dayOfWeek = daysOfWeek.has(date.dayOfWeek % 7)
    if (dayOfMonthRestricted && dayOfWeekRestricted) return dayOfMonth || dayOfWeek
    return dayOfMonth && dayOfWeek
  }
}

/** 按墙上时钟升序列出一个已解析 cron 规则的本地时刻。 */
function cronTimes(parsed: ParsedCronExpression): readonly Temporal.PlainTime[] {
  const times: Temporal.PlainTime[] = []
  for (const hour of parsed.hours) {
    for (const minute of parsed.minutes) times.push(Temporal.PlainTime.from({ hour, minute }))
  }
  return times
}

/**
 * 找出第一个严格处于未来的 cron occurrence，且不越出四位 UTC 年份范围。
 *
 * 当该视野早于四位年份上限时，遍历会在下限日期之后
 * {@link CRON_SEARCH_HORIZON_YEARS} 处停止：一个在该视野内没有任何匹配
 * 的规则永不匹配，因此它的搜索解析为耗尽，而不是一路扫描到上限。
 * @param parsed - 已解析的 cron 规则。
 * @param timeZone - 解释其本地日期与时间的显式时区。
 * @param floor - 每个返回目标都必须超过的时刻。
 * @returns 第一个匹配的目标，或耗尽时为 undefined。
 */
function nextCronTarget(parsed: ParsedCronExpression, timeZone: string, floor: number): string | undefined {
  const times = cronTimes(parsed)
  const matches = cronDateMatch(parsed)
  const months = new Set(parsed.months)
  const firstDate = localDate(floor, timeZone)
  let date = firstDate
  // 下限自身的本地墙上时钟，这样首个日期只转换那些可能超过它的候选时刻，
  // 而不是它整整一天的所有时刻。
  const floorTime = Temporal.Instant.fromEpochMilliseconds(floor).toZonedDateTimeISO(timeZone).toPlainTime()
  const ceiling = localDate(MAX_FOUR_DIGIT_YEAR_MS, 'UTC').add({ days: 1 })
  const horizon = date.add({ years: CRON_SEARCH_HORIZON_YEARS })
  const lastDate = Temporal.PlainDate.compare(horizon, ceiling) < 0 ? horizon : ceiling
  while (Temporal.PlainDate.compare(date, lastDate) <= 0) {
    if (!months.has(date.month)) {
      date = date.add({ months: 1 }).with({ day: 1 })
      continue
    }
    if (matches(date)) {
      for (const time of times) {
        if (date.equals(firstDate) && Temporal.PlainTime.compare(time, floorTime) < 0) continue
        const target = localInstant(date.toPlainDateTime(time), timeZone)
        if (target === undefined) continue
        if (target > MAX_FOUR_DIGIT_YEAR_MS) return undefined
        if (target >= MIN_FOUR_DIGIT_YEAR_MS && target > floor) return new Date(target).toISOString()
      }
    }
    date = date.add({ days: 1 })
  }
  return undefined
}

/**
 * 在不越过已提交下限的前提下，找出决策时刻或之前的最新匹配 cron occurrence。
 *
 * 当该视野晚于四位年份下限时，遍历会在决策日期之前
 * {@link CRON_SEARCH_HORIZON_YEARS} 处停止；该下限即在规则自身时区中
 * 持有该下限时刻的那个本地日期：一个在该视野内没有任何匹配的规则
 * 保留已提交的目标，而不是一路回溯到下限，而早于该下限时刻的候选会被跳过。
 * @param parsed - 已解析的 cron 规则。
 * @param timeZone - 解释其本地日期与时间的显式时区。
 * @param decision - 以 epoch 毫秒表示的墙上时钟决策时间。
 * @param savedTarget - 已提交的目标，即使当前时区数据把它解析到更晚也仍然到期。
 * @returns 最新的到期 occurrence，或当没有本地 occurrence 可表示时的已提交目标。
 */
function latestCronOccurrence(
  parsed: ParsedCronExpression,
  timeZone: string,
  decision: number,
  savedTarget: number,
): number {
  const times = cronTimes(parsed)
  const matches = cronDateMatch(parsed)
  const months = new Set(parsed.months)
  // 偏移量小于 24 小时；日期线回退可能使一个到期的本地日期晚于 UTC 决策日期，
  // 这正是遍历从它之后一天开始的原因。
  let date = localDate(decision, 'UTC').add({ days: 1 })
  // 下限是一个时刻：遍历可以到达的最早本地日期，是在规则自身时区中
  // 持有该时刻的那个日期，而低于它的候选会被跳过，因此一个负偏移
  // 仍然可以解析出一个日期早于 UTC 下限的到期本地分钟。
  const floorDate = localDate(MIN_FOUR_DIGIT_YEAR_MS, timeZone)
  const horizon = date.subtract({ years: CRON_SEARCH_HORIZON_YEARS })
  const firstDate = Temporal.PlainDate.compare(horizon, floorDate) > 0 ? horizon : floorDate
  while (Temporal.PlainDate.compare(date, firstDate) >= 0) {
    if (!months.has(date.month)) {
      date = date.with({ day: 1 }).subtract({ days: 1 })
      continue
    }
    if (matches(date)) {
      // 对这一天最早的墙上时钟做一次转换，即可判定整日是否都超出决策：
      // 该日更晚的时刻也更晚，因此遍历直接回退，而不是转换完一整天
      // 不可能匹配的其余时刻。被 DST 间隙消除的最早时刻会让这个界
      // 退到第一个确实存在的时刻，而一个没有任何存在时刻的日期则保留完整遍历。
      const earliest = times.reduce<number | undefined>(
        (found, time) => found ?? localInstant(date.toPlainDateTime(time), timeZone),
        undefined,
      )
      if (earliest !== undefined && earliest > decision) {
        date = date.subtract({ days: 1 })
        continue
      }
      for (const time of [...times].reverse()) {
        const candidate = localInstant(date.toPlainDateTime(time), timeZone)
        if (candidate === undefined || candidate > decision || candidate < MIN_FOUR_DIGIT_YEAR_MS) continue
        // 即使当前的 tzdata 把该规则排到它之前，已提交的目标仍然到期。
        return Math.max(candidate, savedTarget)
      }
    }
    date = date.subtract({ days: 1 })
  }
  return savedTarget
}

/**
 * 在决策所在的本地日期附近解析一次 cron 决策，而不是跨越其错过的历史。
 * @param record - 带有已提交的最早未被接受 UTC 目标的 cron 规则。
 * @param acceptedAt - 显式的墙上时钟决策时间，不早于已提交的目标。
 * @returns 最新的实际到期 occurrence 与第一个未来的 occurrence。
 */
export function resolveCronOccurrence(record: CronScheduleRecord, acceptedAt: number): RecurringOccurrence {
  const decision = acceptedDecision('cron', acceptedAt)
  const savedTarget = Date.parse(record.scheduledAt)
  if (decision < savedTarget) throw new ScheduleLogError('cron dispatch cannot precede the active scheduledAt')
  const parsed = parseCronExpression(record.expression)
  const occurrence = latestCronOccurrence(parsed, record.timeZone, decision, savedTarget)
  const occurrenceAt = new Date(occurrence).toISOString()
  const nextScheduledAt = nextCronTarget(parsed, record.timeZone, decision)
  return Object.freeze(nextScheduledAt === undefined ? { occurrenceAt } : { occurrenceAt, nextScheduledAt })
}

/**
 * 显式地识别重复型 Host 记录，排除两个一次性变体。
 * @param record - 当前的 Host schedule 记录。
 * @returns 该记录是否使用重复规则。
 */
export function isRecurringScheduleRecord(record: ScheduleRecord): record is RecurringScheduleRecord {
  return record.kind === 'every' || record.kind === 'daily' || record.kind === 'weekly' || record.kind === 'cron'
}

/**
 * 用其规则专属的日历或间隔算术，解析一个已到期的重复型 Host 记录。
 * @param record - 已到期的重复规则。
 * @param acceptedAt - 以 epoch 毫秒表示的显式决策时间。
 * @returns 最新的到期 occurrence 与可选的未来目标。
 */
export function resolveRecurringOccurrence(record: RecurringScheduleRecord, acceptedAt: number): RecurringOccurrence {
  switch (record.kind) {
    case 'every': return resolveEveryOccurrence(record, acceptedAt)
    case 'daily': return resolveDailyOccurrence(record, acceptedAt)
    case 'weekly': return resolveWeeklyOccurrence(record, acceptedAt)
    case 'cron': return resolveCronOccurrence(record, acceptedAt)
  }
}

type DecodedDispatch = Extract<ScheduleChange, { operation: 'dispatch' }>

/** 把一次已解码的派发应用到其精确的活动记录上。 */
function dispatchedRecord(record: LegacyScheduleRecord, change: DecodedDispatch): LegacyScheduleRecord | undefined {
  const hasAcceptedAt = 'acceptedAt' in change
  if (record.kind !== 'every') {
    if (hasAcceptedAt) throw new ScheduleLogError('one-shot dispatch must not contain acceptedAt')
    return undefined
  }
  if (!hasAcceptedAt) throw new ScheduleLogError('every dispatch must contain acceptedAt')
  const occurrence = resolveEveryOccurrence(record, Date.parse(change.acceptedAt))
  return occurrence.nextScheduledAt === undefined
    ? undefined
    : Object.freeze({ ...record, scheduledAt: occurrence.nextScheduledAt })
}

/**
 * 把已解码的 Schedule 变更应用到一个完整的折叠值上。
 *
 * 这是完整日志重放的迁移权威。一对可变的 Map/Set 贯穿整批变更；
 * 返回的数组只被物化并冻结一次。
 * @param folded - 变更之前的完整活动记录与已用 id 历史。
 * @param changes - 按日志顺序排列的、严格解码的持久化变更。
 * @returns 每一次变更之后的完整折叠值。
 */
export function applyScheduleChanges(
  folded: FoldedSchedules,
  changes: Iterable<ScheduleChange>,
): FoldedSchedules {
  const active = new Map(folded.active.map(record => [record.id, record]))
  const seen = new Set(folded.seenIds)
  for (const change of changes) {
    switch (change.operation) {
      case 'create':
        if (seen.has(change.schedule.id)) {
          throw new ScheduleLogError(`schedule id ${JSON.stringify(change.schedule.id)} was reused`)
        }
        seen.add(change.schedule.id)
        active.set(change.schedule.id, change.schedule)
        break
      case 'delete':
        if (!active.delete(change.id)) {
          throw new ScheduleLogError(`schedule delete targets inactive id ${JSON.stringify(change.id)}`)
        }
        break
      case 'dispatch': {
        const record = active.get(change.id)
        if (record === undefined) {
          throw new ScheduleLogError(`schedule dispatch targets inactive id ${JSON.stringify(change.id)}`)
        }
        const next = dispatchedRecord(record, change)
        if (next === undefined) active.delete(change.id)
        else active.set(change.id, next)
        break
      }
      /* v8 ignore next 3 -- decodeScheduleChange 返回一个封闭的 operation 联合类型。 */
      default: {
        const unreachable: never = change
        throw new ScheduleLogError(`unknown decoded schedule change ${String(unreachable)}`)
      }
    }
  }
  return Object.freeze({
    active: Object.freeze([...active.values()]),
    seenIds: Object.freeze([...seen]),
  })
}

/**
 * 在持久化分叉种子边界之后，折叠本包拥有的事件流。
 * @param events - 完整有序的 session 日志，或候选扩展后的日志。
 * @param inheritedEventCount - 被排除在子级所有权之外的继承前缀长度。
 * @returns 活动记录与所有此前使用过的 id。
 */
export function foldScheduleEvents(
  events: readonly SessionEvent[],
  inheritedEventCount: SessionLogOffsetType = SessionLogOffset(0),
): FoldedSchedules {
  if (!Number.isSafeInteger(inheritedEventCount)
    || inheritedEventCount < 0
    || inheritedEventCount > events.length) {
    throw new ScheduleLogError('schedule inheritedEventCount must be within the supplied event log')
  }
  const initial: FoldedSchedules = Object.freeze({
    active: Object.freeze([]),
    seenIds: Object.freeze([]),
  })
  const changes = function* (): Generator<ScheduleChange> {
    for (const event of events.slice(inheritedEventCount)) {
      if (event.type === 'schedule/change') yield decodeScheduleChange(event.data)
    }
  }
  return applyScheduleChanges(initial, changes())
}

/**
 * 分配下一个可读 id，而不复用任何先前的 session 局部 id。
 * @param folded - 含有每一个此前创建过的 id 的折叠结果。
 * @returns 一个全新的 `schedule-N` 标识。
 */
export function allocateScheduleId(folded: FoldedSchedules): ScheduleIdType {
  const seen = new Set(folded.seenIds)
  let sequence = seen.size + 1
  let candidate = ScheduleId(`schedule-${sequence}`)
  while (seen.has(candidate)) {
    sequence += 1
    candidate = ScheduleId(`schedule-${sequence}`)
  }
  return candidate
}

/**
 * 校验一个 model after 规则，并计算其持久化目标。
 * @param id - 已分配的任务 id。
 * @param prompt - 创建时提供的提醒内容。
 * @param afterSeconds - 请求的正延迟。
 * @param now - 单次规则接受的墙上时钟采样，以 epoch 毫秒表示。
 * @param title - 创建时提供的必需任务名。
 * @returns 冻结的持久化 after 记录。
 */
export function createAfterScheduleRecord(
  id: ScheduleIdType,
  prompt: string,
  afterSeconds: number,
  now: number,
  title: string,
): AfterScheduleRecord {
  const normalizedPrompt = prompt.trim()
  if (normalizedPrompt.length === 0) {
    throw new ScheduleInputError('invalid_prompt', 'prompt must be non-empty after trimming.')
  }
  if (!Number.isSafeInteger(afterSeconds) || afterSeconds <= 0) {
    throw new ScheduleInputError('invalid_rule', 'after_seconds must be a positive safe integer.')
  }
  const delay = afterSeconds * 1_000
  const target = now + delay
  return Object.freeze({
    id,
    kind: 'after',
    title: scheduleTitle(title),
    prompt: normalizedPrompt,
    afterSeconds,
    scheduledAt: futureInstant(target, now),
  })
}

/**
 * 校验一个绝对选择器，并计算其唯一的持久化 UTC 目标。
 * @param id - 已分配的任务 id。
 * @param prompt - 创建时提供的提醒内容。
 * @param at - 带显式偏移的时刻，或结构化的本地日历值。
 * @param now - 单次规则接受的墙上时钟采样，以 epoch 毫秒表示。
 * @param title - 创建时提供的必需任务名。
 * @returns 冻结的持久化绝对一次性记录。
 */
export function createAtScheduleRecord(
  id: ScheduleIdType,
  prompt: string,
  at: AtInput,
  now: number,
  title: string,
): AtScheduleRecord {
  const normalizedPrompt = prompt.trim()
  if (normalizedPrompt.length === 0) {
    throw new ScheduleInputError('invalid_prompt', 'prompt must be non-empty after trimming.')
  }

  return Object.freeze({
    id,
    kind: 'at',
    title: scheduleTitle(title),
    prompt: normalizedPrompt,
    scheduledAt: futureInstant(parseAtInput(at), now),
  })
}

/**
 * 解析一个绝对选择器，而不要求它处于未来。
 * @param at - 带显式偏移的时刻，或严格的本地日历输入。
 * @returns 解析出的 epoch 毫秒；畸形输入抛出 ScheduleInputError。
 */
export function parseAtInput(at: AtInput): number {
  let target: number
  if (typeof at === 'string') {
    target = parseOffsetInstant(at)
  } else if (isRecord(at)) {
    if (!hasExactKeys(at, ['date', 'time', 'time_zone'])) {
      throw new ScheduleInputError('invalid_rule', 'Local at must contain exactly date, time, and time_zone.')
    }
    if (typeof at['date'] !== 'string' || typeof at['time'] !== 'string') {
      throw new ScheduleInputError('invalid_rule', 'Local at date and time must be strings.')
    }
    const rawTimeZone = at['time_zone']
    if (typeof rawTimeZone !== 'string') {
      throw new ScheduleInputError('invalid_time_zone', 'time_zone must be a string.')
    }
    const local: LocalAtInput = {
      date: at['date'],
      time: at['time'],
      time_zone: rawTimeZone,
    }
    target = resolveLocalInstant(parseLocalAt(local), canonicalizeTimeZone(rawTimeZone))
  } else {
    throw new ScheduleInputError('invalid_rule', 'at must be an explicit-offset string or local calendar object.')
  }

  return target
}

/**
 * 校验一个固定频率选择器，并计算一个新间隔锚点的第一个目标。
 * @param id - 已分配的任务 id。
 * @param prompt - 创建时提供的提醒内容。
 * @param everySeconds - 请求的固定安全整数间隔。
 * @param now - 单次规则接受的墙上时钟采样，以 epoch 毫秒表示。
 * @param title - 创建时提供的必需任务名。
 * @returns 冻结的持久化固定频率记录。
 */
export function createEveryScheduleRecord(
  id: ScheduleIdType,
  prompt: string,
  everySeconds: number,
  now: number,
  title: string,
): EveryScheduleRecord {
  const normalizedPrompt = prompt.trim()
  if (normalizedPrompt.length === 0) {
    throw new ScheduleInputError('invalid_prompt', 'prompt must be non-empty after trimming.')
  }
  if (!Number.isSafeInteger(everySeconds)) {
    throw new ScheduleInputError('invalid_rule', 'every_seconds must be a safe integer.')
  }
  if (everySeconds < MIN_EVERY_INTERVAL_SECONDS) {
    throw new ScheduleInputError(
      'frequency_too_high',
      `every_seconds must be at least ${MIN_EVERY_INTERVAL_SECONDS}.`,
    )
  }
  const interval = everySeconds * 1_000
  const target = now + interval
  return Object.freeze({
    id,
    kind: 'every',
    title: scheduleTitle(title),
    prompt: normalizedPrompt,
    everySeconds,
    scheduledAt: futureInstant(target, now),
  })
}

/**
 * 创建一个带有严格处于未来的已提交 UTC 目标的每日墙上时钟规则。
 * @param id - 已分配的任务标识。
 * @param prompt - 创建时提供的提醒内容。
 * @param daily - 严格的本地时间与显式的 IANA 时区。
 * @param now - 单次规则接受的墙上时钟采样，以 epoch 毫秒表示。
 * @param title - 创建时提供的必需任务名。
 * @returns 冻结的每日记录；没有未来日期时抛出 time_out_of_range。
 */
export function createDailyScheduleRecord(
  id: ScheduleIdType,
  prompt: string,
  daily: DailyInput,
  now: number,
  title: string,
): DailyScheduleRecord {
  const normalizedPrompt = prompt.trim()
  if (normalizedPrompt.length === 0) {
    throw new ScheduleInputError('invalid_prompt', 'prompt must be non-empty after trimming.')
  }
  const { time, timeZone } = parseDailyInput(daily)
  if (!Number.isSafeInteger(now) || now < MIN_FOUR_DIGIT_YEAR_MS || now > MAX_FOUR_DIGIT_YEAR_MS) {
    throw new ScheduleInputError('time_out_of_range', 'Daily creation time must be a representable four-digit-year UTC instant.')
  }
  const scheduledAt = nextDailyTarget(dailyTime(time), timeZone, now)
  if (scheduledAt === undefined) {
    throw new ScheduleInputError('time_out_of_range', 'No future daily occurrence is representable as a four-digit-year UTC instant.')
  }
  return Object.freeze({
    id, kind: 'daily', title: scheduleTitle(title), prompt: normalizedPrompt, time, timeZone, scheduledAt,
  })
}

/**
 * 归一化一个每日选择器，而不计算新的已提交目标。
 * @param daily - 严格的本地时间与显式的 IANA 时区。
 * @returns 归一化的时间与规范时区；畸形输入抛出 ScheduleInputError。
 */
export function parseDailyInput(daily: DailyInput): { readonly time: string; readonly timeZone: string } {
  if (!isRecord(daily) || !hasExactKeys(daily, ['time', 'time_zone']) || typeof daily['time'] !== 'string') {
    throw new ScheduleInputError(
      'invalid_rule', 'daily must contain exactly time and time_zone, with time HH:mm:ss and optional 1-3 fractional digits.',
    )
  }
  if (typeof daily['time_zone'] !== 'string') {
    throw new ScheduleInputError('invalid_time_zone', 'time_zone must be a string.')
  }
  return {
    time: dailyTime(daily['time']).toString({ fractionalSecondDigits: 3 }),
    timeZone: canonicalizeTimeZone(daily['time_zone']),
  }
}

/**
 * 创建一个带有严格处于未来的已提交 UTC 目标的每周墙上时钟规则。
 * @param id - 已分配的任务标识。
 * @param prompt - 创建时提供的提醒内容。
 * @param weekly - 严格的本地时间、显式 IANA 时区与显式 ISO 星期集合。
 * @param now - 单次规则接受的墙上时钟采样，以 epoch 毫秒表示。
 * @param title - 创建时提供的必需任务名。
 * @returns 冻结的每周记录；没有未来的星期时抛出 time_out_of_range。
 */
export function createWeeklyScheduleRecord(
  id: ScheduleIdType,
  prompt: string,
  weekly: WeeklyInput,
  now: number,
  title: string,
): WeeklyScheduleRecord {
  const normalizedPrompt = prompt.trim()
  if (normalizedPrompt.length === 0) {
    throw new ScheduleInputError('invalid_prompt', 'prompt must be non-empty after trimming.')
  }
  const { time, timeZone, weekdays } = parseWeeklyInput(weekly)
  if (!Number.isSafeInteger(now) || now < MIN_FOUR_DIGIT_YEAR_MS || now > MAX_FOUR_DIGIT_YEAR_MS) {
    throw new ScheduleInputError('time_out_of_range', 'Weekly creation time must be a representable four-digit-year UTC instant.')
  }
  const scheduledAt = nextWeeklyTarget(weeklyTime(time), timeZone, weekdays, now)
  if (scheduledAt === undefined) {
    throw new ScheduleInputError('time_out_of_range', 'No future weekly occurrence is representable as a four-digit-year UTC instant.')
  }
  return Object.freeze({
    id, kind: 'weekly', title: scheduleTitle(title), prompt: normalizedPrompt, time, timeZone,
    weekdays, scheduledAt,
  })
}

/**
 * 创建一个带有严格处于未来的已提交 UTC 目标的 cron 墙上时钟规则。
 * @param id - 已分配的任务标识。
 * @param prompt - 创建时提供的提醒内容。
 * @param cron - 严格的五字段表达式与显式的 IANA 时区。
 * @param now - 单次规则接受的墙上时钟采样，以 epoch 毫秒表示。
 * @param title - 创建时提供的必需任务名。
 * @returns 冻结的 cron 记录；没有未来的 occurrence 时抛出 time_out_of_range。
 */
export function createCronScheduleRecord(
  id: ScheduleIdType,
  prompt: string,
  cron: CronInput,
  now: number,
  title: string,
): CronScheduleRecord {
  const normalizedPrompt = prompt.trim()
  if (normalizedPrompt.length === 0) {
    throw new ScheduleInputError('invalid_prompt', 'prompt must be non-empty after trimming.')
  }
  const { expression, timeZone } = parseCronInput(cron)
  if (!Number.isSafeInteger(now) || now < MIN_FOUR_DIGIT_YEAR_MS || now > MAX_FOUR_DIGIT_YEAR_MS) {
    throw new ScheduleInputError('time_out_of_range', 'Cron creation time must be a representable four-digit-year UTC instant.')
  }
  const scheduledAt = nextCronTarget(parseCronExpression(expression), timeZone, now)
  if (scheduledAt === undefined) {
    throw new ScheduleInputError('time_out_of_range', 'No future cron occurrence is representable as a four-digit-year UTC instant.')
  }
  return Object.freeze({
    id, kind: 'cron', title: scheduleTitle(title), prompt: normalizedPrompt, expression, timeZone, scheduledAt,
  })
}

/**
 * 归一化一个每周选择器，而不计算新的已提交目标。
 * @param weekly - 严格的本地时间、显式 IANA 时区与显式 ISO 星期集合。
 * @returns 归一化的时间、规范时区与唯一升序星期；畸形输入抛出 ScheduleInputError。
 */
export function parseWeeklyInput(
  weekly: WeeklyInput,
): { readonly time: string; readonly timeZone: string; readonly weekdays: number[] } {
  if (!isRecord(weekly)
    || !hasExactKeys(weekly, ['time', 'time_zone', 'weekdays'])
    || typeof weekly['time'] !== 'string') {
    throw new ScheduleInputError(
      'invalid_rule',
      'weekly must contain exactly time, time_zone, and weekdays, with time HH:mm:ss and optional 1-3 fractional digits.',
    )
  }
  if (typeof weekly['time_zone'] !== 'string') {
    throw new ScheduleInputError('invalid_time_zone', 'time_zone must be a string.')
  }
  return {
    time: weeklyTime(weekly['time']).toString({ fractionalSecondDigits: 3 }),
    timeZone: canonicalizeTimeZone(weekly['time_zone']),
    weekdays: normalizeWeekdays(weekly['weekdays']),
  }
}

/** 所支持的五字段 cron 方言的字段边界，按求值顺序排列。 */
interface CronFieldSpec {
  /** 诊断信息中使用的字段名。 */
  readonly name: string
  /** 输入方言中接受的最小值。 */
  readonly min: number
  /** 输入方言中接受的最大值；星期日同时接受 0 与 7。 */
  readonly max: number
  /** 把星期日 7 折叠到 0 之后保留的最大值。 */
  readonly canonicalMax: number
}

const CRON_FIELDS: readonly [CronFieldSpec, CronFieldSpec, CronFieldSpec, CronFieldSpec, CronFieldSpec] = [
  { name: 'minute', min: 0, max: 59, canonicalMax: 59 },
  { name: 'hour', min: 0, max: 23, canonicalMax: 23 },
  { name: 'day-of-month', min: 1, max: 31, canonicalMax: 31 },
  { name: 'month', min: 1, max: 12, canonicalMax: 12 },
  { name: 'day-of-week', min: 0, max: 7, canonicalMax: 6 },
]

/** 一个已解析的 cron 字段：其匹配值、规范拼写与 Vixie star 标志。 */
interface ParsedCronField {
  /** 星期日折叠之后的唯一升序匹配值。 */
  readonly values: readonly number[]
  /** 恰好这些值的规范拼写。 */
  readonly canonical: string
  /** 字段文本是否以 `*` 开头，即 Vixie 的 DOM_STAR/DOW_STAR 判定。 */
  readonly star: boolean
}

/** 为一个畸形的 cron 字段元素构造稳定的诊断信息。 */
function invalidCronField(spec: CronFieldSpec, element: string): ScheduleInputError {
  return new ScheduleInputError(
    'invalid_rule',
    `cron.expression ${spec.name} field element ${JSON.stringify(element)} must be *, a value, a-b, */n, a-b/n, `
    + 'or a comma-separated list of those.',
  )
}

/** 读取一个在范围内的 cron 字段值。 */
function cronFieldValue(text: string, spec: CronFieldSpec): number {
  const value = Number(text)
  if (!Number.isSafeInteger(value) || value < spec.min || value > spec.max) {
    throw new ScheduleInputError(
      'invalid_rule',
      `cron.expression ${spec.name} field value ${text} is outside ${spec.min}-${spec.max}.`,
    )
  }
  return value
}

/** 读取一个正的 cron 字段步长。 */
function cronFieldStep(text: string, spec: CronFieldSpec): number {
  const step = Number(text)
  if (!Number.isSafeInteger(step) || step < 1) {
    throw new ScheduleInputError('invalid_rule', `cron.expression ${spec.name} field step must be a positive integer.`)
  }
  return step
}

/** 把一个逗号分隔的 cron 字段展开为它的匹配值集合。 */
function cronFieldValues(raw: string, spec: CronFieldSpec): number[] {
  const matched = new Set<number>()
  for (const element of raw.split(',')) {
    if (element.length === 0) {
      throw new ScheduleInputError(
        'invalid_rule', `cron.expression ${spec.name} field must not contain an empty list element.`,
      )
    }
    if (element === '*') {
      for (let value = spec.min; value <= spec.max; value += 1) matched.add(value)
      continue
    }
    if (element.startsWith('*')) {
      const stepped = /^\*\/(?<step>\d+)$/.exec(element)
      const groups = stepped?.groups
      if (groups === undefined) throw invalidCronField(spec, element)
      const stepText = groups['step']
      /* v8 ignore next -- 成功的固定正则总是提供 step 分组。 */
      if (stepText === undefined) throw invalidCronField(spec, element)
      const step = cronFieldStep(stepText, spec)
      for (let value = spec.min; value <= spec.max; value += step) matched.add(value)
      continue
    }
    const parsed = /^(?<start>\d+)(?:-(?<end>\d+))?(?:\/(?<step>\d+))?$/.exec(element)
    const groups = parsed?.groups
    if (groups === undefined) throw invalidCronField(spec, element)
    const startText = groups['start']
    /* v8 ignore next -- 成功的固定正则总是提供 start 分组。 */
    if (startText === undefined) throw invalidCronField(spec, element)
    const start = cronFieldValue(startText, spec)
    const end = groups['end']
    const stepText = groups['step']
    if (end === undefined) {
      if (stepText !== undefined) throw invalidCronField(spec, element)
      matched.add(start)
      continue
    }
    const last = cronFieldValue(end, spec)
    if (start > last) {
      throw new ScheduleInputError(
        'invalid_rule', `cron.expression ${spec.name} field range ${start}-${last} is inverted.`,
      )
    }
    const step = stepText === undefined ? 1 : cronFieldStep(stepText, spec)
    for (let value = start; value <= last; value += step) matched.add(value)
  }
  const values = new Set<number>()
  for (const value of matched) {
    values.add(spec.canonicalMax !== spec.max && value === spec.max ? spec.min : value)
  }
  return [...values].sort((left, right) => left - right)
}

/**
 * 读取一个编码器已证明存在的值。
 * @param values - 解析器总是会填满的匹配值集合。
 * @param index - 调用方从该集合推导出的下标。
 * @returns 该下标处的值。
 */
function cronFieldValueAt(values: readonly number[], index: number): number {
  const value = values[index]
  /* v8 ignore next -- 一个已解析的 cron 字段总是至少匹配一个值。 */
  if (value === undefined) throw new ScheduleLogError('cron field encoding requires a non-empty value set')
  return value
}

/** 把一个匹配值集合编码为最短的等价逗号分隔 cron 字段。
 * @param values - 按升序排列的匹配值。
 * @returns 重新解析后恰好得到 `values` 的字段文本，且绝不以 `*` 开头。
 */
function encodeCronField(values: readonly number[]): string {
  const first = cronFieldValueAt(values, 0)
  if (values.length === 1) return String(first)
  const last = cronFieldValueAt(values, values.length - 1)
  const step = cronFieldValueAt(values, 1) - first
  let uniform = true
  for (let index = 2; index < values.length; index += 1) {
    if (cronFieldValueAt(values, index) - cronFieldValueAt(values, index - 1) !== step) {
      uniform = false
      break
    }
  }
  if (uniform) {
    if (step === 1) return `${first}-${last}`
    return `${first}-${last}/${step}`
  }
  const parts: string[] = []
  let runStart = first
  for (let index = 1; index < values.length; index += 1) {
    const current = cronFieldValueAt(values, index)
    const previous = cronFieldValueAt(values, index - 1)
    if (current === previous + 1) continue
    parts.push(runStart === previous ? String(runStart) : `${runStart}-${previous}`)
    runStart = current
  }
  const final = cronFieldValueAt(values, values.length - 1)
  parts.push(runStart === final ? String(runStart) : `${runStart}-${final}`)
  return parts.join(',')
}

/**
 * 从字段最小值出发的一次均匀遍历，其折叠方式与已解析字段的折叠完全一致。
 * @param spec - 字段范围与规范最大值。
 * @param step - 遍历的正步长。
 * @returns `step` 从最小值出发产生的升序值。
 */
function starWalk(spec: CronFieldSpec, step: number): number[] {
  const walked = new Set<number>()
  for (let value = spec.min; value <= spec.max; value += step) {
    walked.add(spec.canonicalMax !== spec.max && value === spec.max ? spec.min : value)
  }
  return [...walked].sort((left, right) => left - right)
}

/**
 * 一个文本以 `*` 开头的字段的规范拼写。
 *
 * 只有 `*`-前缀的拼写才保留 star 标志，且只有裸 star 或 star-步长
 * （`*` 后跟 `/n`）才允许前导 `*`，因此当覆盖每一个值时编码就是裸 star，
 * 否则是最宽的 star-步长遍历加上列表形式的剩余值。重新解析因此会同时
 * 复现 star 标志与匹配集合，这正是让日/周的 AND/OR 选择在存储一个规范
 * 表达式之后保持稳定不变的原因。
 * @param values - 按升序排列的匹配值。
 * @param spec - 字段范围与规范最大值。
 * @returns 以 `*` 开头的规范字段文本。
 */
function encodeStarCronField(values: readonly number[], spec: CronFieldSpec): string {
  if (values.length === spec.canonicalMax - spec.min + 1) return '*'
  const present = new Set(values)
  let bestStep: number | undefined
  let bestWalk: number[] = []
  for (let step = 1; step <= spec.max - spec.min + 1; step += 1) {
    const walk = starWalk(spec, step)
    if (walk.length > bestWalk.length && walk.every(value => present.has(value))) {
      bestStep = step
      bestWalk = walk
    }
  }
  /* v8 ignore next -- 最宽的步长会产出唯一的那个最小值，而每个以 `*` 开头的字段都匹配它。 */
  if (bestStep === undefined) throw new ScheduleInputError('invalid_rule', `${spec.name} cannot keep a leading \`*\`.`)
  const walked = new Set(bestWalk)
  const remaining = values.filter(value => !walked.has(value))
  const walkText = `*/${bestStep}`
  return remaining.length === 0
    ? walkText
    : `${walkText},${encodeCronField(remaining)}`
}

/**
 * 把一个 cron 字段解析为它的匹配值、规范拼写与 star 标志。
 *
 * star 标志检测字段文本的首字符，这正是 Vixie 设置
 * `DOM_STAR`/`DOW_STAR` 的方式：一个步进 star（`*` 后跟 `/2`）虽然只匹配
 * 半个范围，但仍是 star；而像 `1-31` 这样的显式完整范围则是受限的。
 * 规范化会保留该标志：以 `*` 开头的字段保持以 `*` 开头的拼写，
 * 而一个不是以 `*` 开头的字段绝不会被拼写成 star-步长。
 */
function parseCronField(raw: string, spec: CronFieldSpec): ParsedCronField {
  const values = cronFieldValues(raw, spec)
  const star = raw.startsWith('*')
  return Object.freeze({
    values: Object.freeze(values),
    canonical: star ? encodeStarCronField(values, spec) : encodeCronField(values),
    star,
  })
}

/** 已解析的五字段 cron 规则：规范文本，以及每个字段的匹配值。 */
interface ParsedCronExpression {
  /** 存储在持久化记录中的规范表达式。 */
  readonly expression: string
  /** 唯一升序的匹配分钟。 */
  readonly minutes: readonly number[]
  /** 唯一升序的匹配小时。 */
  readonly hours: readonly number[]
  /** 唯一升序的匹配日期。 */
  readonly daysOfMonth: readonly number[]
  /** 唯一升序的匹配月份。 */
  readonly months: readonly number[]
  /** 唯一升序的匹配 cron 星期，星期日 0 到星期六 6。 */
  readonly daysOfWeek: readonly number[]
  /** 日期字段文本是否以 `*` 开头（Vixie `DOM_STAR`）。 */
  readonly dayOfMonthStar: boolean
  /** 星期字段文本是否以 `*` 开头（Vixie `DOW_STAR`）。 */
  readonly dayOfWeekStar: boolean
}

/** 解析并规范化一个严格的五字段 cron 表达式。 */
function parseCronExpression(expression: string): ParsedCronExpression {
  if (typeof expression !== 'string' || expression.length === 0 || expression.trim() !== expression) {
    throw new ScheduleInputError('invalid_rule', 'cron.expression must be a non-empty trimmed string.')
  }
  const fields = expression.split(/\s+/)
  if (fields.length !== 5) {
    throw new ScheduleInputError(
      'invalid_rule',
      'cron.expression must contain exactly five whitespace-separated fields: '
      + 'minute hour day-of-month month day-of-week.',
    )
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields.map(
    (field, index) => {
      const fieldSpec = CRON_FIELDS[index]
      /* v8 ignore next -- 五字段切分界定了该索引。 */
      if (fieldSpec === undefined) throw new ScheduleLogError('cron field specification is missing')
      return parseCronField(field, fieldSpec)
    },
  ) as [ParsedCronField, ParsedCronField, ParsedCronField, ParsedCronField, ParsedCronField]
  return Object.freeze({
    expression: [minute, hour, dayOfMonth, month, dayOfWeek].map(field => field.canonical).join(' '),
    minutes: minute.values,
    hours: hour.values,
    daysOfMonth: dayOfMonth.values,
    months: month.values,
    daysOfWeek: dayOfWeek.values,
    dayOfMonthStar: dayOfMonth.star,
    dayOfWeekStar: dayOfWeek.star,
  })
}

/**
 * 规范化一个严格的五字段 cron 表达式。
 * @param expression - 候选的 `分 时 日 月 周` 表达式。
 * @returns 规范表达式；畸形或不受支持的输入抛出 ScheduleInputError。
 */
export function canonicalizeCronExpression(expression: string): string {
  return parseCronExpression(expression).expression
}

/**
 * 归一化一个 cron 选择器，而不计算新的已提交目标。
 * @param cron - 严格的五字段表达式与显式的 IANA 时区。
 * @returns 规范表达式与规范时区；畸形输入抛出 ScheduleInputError。
 */
export function parseCronInput(cron: CronInput): { readonly expression: string; readonly timeZone: string } {
  if (!isRecord(cron) || !hasExactKeys(cron, ['expression', 'time_zone']) || typeof cron['expression'] !== 'string') {
    throw new ScheduleInputError(
      'invalid_rule', 'cron must contain exactly expression and time_zone, with a five-field cron expression.',
    )
  }
  if (typeof cron['time_zone'] !== 'string') {
    throw new ScheduleInputError('invalid_time_zone', 'time_zone must be a string.')
  }
  return {
    expression: parseCronExpression(cron['expression']).expression,
    timeZone: canonicalizeTimeZone(cron['time_zone']),
  }
}

/**
 * 派生一个执行局部的管理视图。
 * @param record - 活动的持久化记录。
 * @param now - 用于判定其时序状态的墙上时钟采样。
 * @returns 完整的 Host 投递视图。
 */
export function scheduleView(record: ScheduleRecord, now: number): ScheduleView {
  return Object.freeze({
    ...record,
    state: now >= Date.parse(record.scheduledAt) ? 'overdue' : 'scheduled',
    deliveryMode: 'host',
  })
}

/** 一次性与重复提醒投递共享的、面向模型的固定来源行。 */
const SCHEDULED_MESSAGE_FRAMING = 'This is a scheduled message from the user'

/**
 * 渲染一个到期提醒的固定模型框架文本。
 * @param record - 到期的活动记录。
 * @returns 稳定的模型可见文本，其动态字段经过 JSON 转义。
 */
export function renderReminderFraming(record: OneShotScheduleRecord): string {
  return [
    '[SCHEDULE REMINDER]',
    SCHEDULED_MESSAGE_FRAMING,
    `schedule_id_json: ${JSON.stringify(record.id)}`,
    `occurrence_at: ${record.scheduledAt}`,
    `reminder_prompt_json: ${JSON.stringify(record.prompt)}`,
  ].join('\n')
}

/**
 * 按所提供的顺序渲染一批重复提醒。
 * @param reminders - 完整的已准入批次，每个记录一个最新 occurrence。
 * @returns 稳定的模型可见文本，其动态载荷是规范 JSON。
 */
export function renderRecurringReminderBatchFraming(
  reminders: readonly { readonly record: RecurringScheduleRecord; readonly occurrenceAt: string }[],
): string {
  const payload = reminders.map(({ record, occurrenceAt }) => ({
    schedule_id: record.id,
    occurrence_at: occurrenceAt,
    reminder_prompt: record.prompt,
  }))
  return [
    '[SCHEDULE REMINDER BATCH]',
    SCHEDULED_MESSAGE_FRAMING,
    `reminders_json: ${JSON.stringify(payload)}`,
  ].join('\n')
}
