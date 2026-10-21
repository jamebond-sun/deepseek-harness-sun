/** 面向逻辑会话与事件文本的、与提供方无关的纯谓词。 */

import type {
  SessionEventResultFilter,
  SessionEventSearchDocument,
  SessionRecord,
  SessionResultFilter,
  SessionResultRange,
} from './types.ts'
import { SessionQueryError } from './config.ts'

/**
 * 应用按 AND 组合的逻辑会话过滤器，同时保持输入顺序。
 * @param records - 要检查的、分离的逻辑会话记录。
 * @param filters - 各子句；子句内的列表值按 OR 组合。
 * @returns 被每个子句都接受的记录。
 */
export function filterSessionResults<T extends SessionRecord>(
  records: readonly T[],
  filters: readonly SessionResultFilter[] = [],
): T[] {
  const predicates = filters.map(sessionPredicate)
  return records.filter(record => predicates.every(predicate => predicate(record)))
}

/**
 * 对抽取出的语义文档应用按 AND 组合的事件过滤器。
 * @param documents - 由 {@link buildSessionEventSearchDocuments} 生成的语义文档。
 * @param filters - 元数据谓词与字面文本谓词。
 * @returns 按输入顺序排列的、被每个子句都接受的文档。
 */
export function filterSessionEventDocuments<T extends SessionEventSearchDocument>(
  documents: readonly T[],
  filters: readonly SessionEventResultFilter[] = [],
): T[] {
  const predicates = filters.map(eventPredicate)
  return documents.filter(document => predicates.every(predicate => predicate(document)))
}

/**
 * 在跨越异步边界之前复制并校验逻辑会话过滤器。
 * @param filters - 由调用方持有的、需要物化的子句。
 * @returns 分离且经过校验的子句。
 */
export function materializeSessionResultFilters(
  filters: readonly SessionResultFilter[],
): SessionResultFilter[] {
  assertArray(filters)
  return filters.map((filter) => {
    switch (filter.kind) {
      case 'id':
        return { kind: filter.kind, values: copyStrings(filter.kind, filter.values) }
      case 'cwd':
        return { kind: filter.kind, values: copyNullableStrings(filter.kind, filter.values) }
      case 'created-at':
        return copyRange(filter.kind, filter)
      case 'parent':
        return { kind: filter.kind, values: copyNullableStrings(filter.kind, filter.values) }
      case 'availability': {
        const values = copyStrings(filter.kind, filter.values)
        assertAllowedValues(filter.kind, values, ['live', 'persisted'])
        return { kind: filter.kind, values }
      }
      default:
        return unknownFilter(filter)
    }
  })
}

/**
 * 在跨越异步边界之前复制并校验事件过滤器。
 * @param filters - 由调用方持有的、需要物化的子句。
 * @returns 分离且经过校验的子句。
 */
export function materializeSessionEventResultFilters(
  filters: readonly SessionEventResultFilter[],
): SessionEventResultFilter[] {
  assertArray(filters)
  return filters.map((filter) => {
    switch (filter.kind) {
      case 'seq':
      case 'time':
        return copyRange(filter.kind, filter)
      case 'type':
        return { kind: filter.kind, values: copyStrings(filter.kind, filter.values) }
      case 'surface': {
        const values = copyStrings(filter.kind, filter.values)
        assertAllowedValues(filter.kind, values, ['current', 'shadowed', 'log-only'])
        return { kind: filter.kind, values }
      }
      case 'text':
        if (typeof filter.text !== 'string') throw invalidFilter('text filter text must be a string')
        return { kind: filter.kind, text: filter.text }
      default:
        return unknownFilter(filter)
    }
  })
}

/**
 * 编译一个字面量、大小写不敏感且对空白宽松的语义文本匹配。
 * @param text - 调用方提供的字面文本。
 * @returns 可感知 Unicode 且不受正则注入影响的正则表达式。
 */
export function compileSessionTextFilter(text: string): RegExp {
  const trimmed = text.trim()
  if (trimmed.length === 0) {
    throw new SessionQueryError(
      'session text filter must contain non-whitespace text',
      'SESSION_QUERY_INVALID_FILTER',
    )
  }
  const pattern = trimmed
    .split(/\s+/u)
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
    .join('\\s+')
  return new RegExp(pattern, 'iu')
}

function sessionPredicate(filter: SessionResultFilter): (record: SessionRecord) => boolean {
  switch (filter.kind) {
    case 'id':
      return record => filter.values.includes(record.header.id)
    case 'cwd':
      return record => filter.values.includes(record.header.cwd ?? null)
    case 'created-at': {
      const range = validateRange(filter.kind, filter)
      return record => matchesRange(record.header.createdAt, range)
    }
    case 'parent':
      return record => filter.values.includes(record.header.parentSession ?? null)
    case 'availability':
      assertAllowedValues(filter.kind, filter.values, ['live', 'persisted'])
      return record => filter.values.some(value => value === 'live' ? record.live : record.persisted)
    default:
      return unknownFilter(filter)
  }
}

function eventPredicate(filter: SessionEventResultFilter): (document: SessionEventSearchDocument) => boolean {
  switch (filter.kind) {
    case 'seq': {
      const range = validateRange(filter.kind, filter)
      return document => matchesRange(document.seq, range)
    }
    case 'time': {
      const range = validateRange(filter.kind, filter)
      return document => matchesRange(document.time, range)
    }
    case 'type':
      return document => filter.values.includes(document.type)
    case 'surface':
      assertAllowedValues(filter.kind, filter.values, ['current', 'shadowed', 'log-only'])
      return document => filter.values.includes(document.surface)
    case 'text': {
      const pattern = compileSessionTextFilter(filter.text)
      return document => pattern.test(document.text)
    }
    default:
      return unknownFilter(filter)
  }
}

function copyStrings<T extends string>(name: string, values: readonly T[]): T[] {
  if (!isRuntimeArray(values) || values.some(value => typeof value !== 'string')) {
    throw invalidFilter(`${name} filter values must be an array of strings`)
  }
  return [...values]
}

function assertArray(value: unknown): void {
  if (!Array.isArray(value)) throw invalidFilter('filters must be an array')
}

function copyNullableStrings<T extends string>(name: string, values: readonly (T | null)[]): Array<T | null> {
  if (!isRuntimeArray(values) || values.some(value => value !== null && typeof value !== 'string')) {
    throw invalidFilter(`${name} filter values must be an array of strings or null`)
  }
  return [...values]
}

function copyRange<K extends 'created-at' | 'seq' | 'time'>(
  kind: K,
  range: SessionResultRange,
): { kind: K } & SessionResultRange {
  const copy = {
    kind,
    ...range.from === undefined ? {} : { from: range.from },
    ...range.to === undefined ? {} : { to: range.to },
  }
  validateRange(kind, copy)
  return copy
}

function unknownFilter(filter: never): never {
  const kind = (filter as { kind?: unknown }).kind
  throw invalidFilter(`unknown filter kind ${typeof kind === 'string' ? `"${kind}"` : '(missing)'}`)
}

function assertAllowedValues(
  name: string,
  values: readonly string[],
  allowed: readonly string[],
): void {
  for (const value of values) {
    if (!allowed.includes(value)) {
      throw new SessionQueryError(
        `session ${name} filter contains unknown value "${value}"`,
        'SESSION_QUERY_INVALID_FILTER',
      )
    }
  }
}

function validateRange(name: string, range: SessionResultRange): SessionResultRange {
  if (range.from !== undefined && !Number.isFinite(range.from)) {
    throw invalidRange(name, 'from must be finite')
  }
  if (range.to !== undefined && !Number.isFinite(range.to)) {
    throw invalidRange(name, 'to must be finite')
  }
  if (range.from !== undefined && range.to !== undefined && range.from > range.to) {
    throw invalidRange(name, 'from must be less than or equal to to')
  }
  return range
}

function matchesRange(value: number, range: SessionResultRange): boolean {
  return (range.from === undefined || value >= range.from)
    && (range.to === undefined || value <= range.to)
}

function invalidRange(name: string, detail: string): SessionQueryError {
  return invalidFilter(`${name} filter ${detail}`)
}

function invalidFilter(detail: string): SessionQueryError {
  return new SessionQueryError(`session ${detail}`, 'SESSION_QUERY_INVALID_FILTER')
}

function isRuntimeArray(value: unknown): boolean {
  return Array.isArray(value)
}
