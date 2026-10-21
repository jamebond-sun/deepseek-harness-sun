/** 由生产环境与重放校验共享的、ISO 形态 time-context 时间戳格式化。 */

type TimestampPart = 'day' | 'hour' | 'minute' | 'month' | 'second' | 'timeZoneName' | 'year'

/**
 * 创建持久化 time-context 读数所使用的确切格式化器。
 * @param timeZone - 显式的显示时区；为 `undefined` 时使用进程回退时区。
 * @returns 一个具有稳定数字本地字段与长数字偏移量的格式化器。
 */
export function createTimestampFormatter(timeZone?: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    ...(timeZone === undefined ? {} : { timeZone }),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  })
}

/**
 * 将一个纪元毫秒值格式化为带有偏移量与 IANA 时区的、ISO 形态时间戳。
 * @param now - 待显示的纪元毫秒数。
 * @param formatter - 为 `timeZone` 所创建的格式化器。
 * @param timeZone - 括在方括号中的规范时区标签。
 * @returns 持久化的时间戳文本。
 */
export function formatTimestamp(now: number, formatter: Intl.DateTimeFormat, timeZone: string): string {
  const parts = Object.fromEntries(
    formatter.formatToParts(now).map(part => [part.type, part.value]),
  ) as Record<TimestampPart, string>
  const offset = parts.timeZoneName.replace(/^GMT$/, 'GMT+00:00').slice(3)
  return `${parts['year']}-${parts['month']}-${parts['day']}T${parts['hour']}:${parts['minute']}:${parts['second']}${offset}[${timeZone}]`
}
