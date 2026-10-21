/**
 * 对一个 JSON 对象顶层字段的惰性扫描视图，构建自可能仍在中流的文本，或一个已解析
 * 的对象。在读者发问之前不做任何扫描；视图记住它回答过的每个问题，并在所有者为
 * 发布而刷新时报告已改变的答案。用于模型工具调用参数：一行按其关注的字段，以它
 * 所显示的粒度，在调用的每个阶段读取。
 * @module @deepseek-ai/dsh-util-values/src/partial-json
 */
import { assertNever, type JsonValue } from './index.ts'

/** 长度读取的粒度；仅当向上取整的步进移动时才报告变化。 */
export interface LengthReadOptions {
  /** 每步的字符数；默认为 1（每个字符都计）。 */
  readonly step?: number
  /** 计入显示总数的已完成字符；仅影响变化检测。 */
  readonly offset?: number
}

/** 对象文本内的扫描器位置。 */
type Mode =
  | 'root' | 'key-or-end' | 'key-only' | 'key' | 'colon' | 'value'
  | 'string' | 'scalar' | 'nested' | 'comma-or-end' | 'closed' | 'invalid'

/** 一个内容读取器独立于边界扫描器推进。 */
interface StringRead {
  at: number
  length: number
  text: string
}

/** 原始范围排除字符串引号，并包含一个非字符串值自身的括号。 */
type Entry =
  | {
    readonly kind: 'string'
    readonly start: number
    end: number
    needsDecoding: boolean
    invalidAt: number | undefined
    length: StringRead | undefined
    text: StringRead | undefined
    prefixes: Map<number, StringRead> | undefined
  }
  | { readonly kind: 'value'; readonly start: number; end: number; parsed: JsonValue | undefined; invalid: boolean }

type ReadKind = 'closed' | 'keys' | 'has' | 'complete' | 'text' | 'value'
  | `length:${number}:${number}` | `prefix:${number}` | `exceeds:${number}`

/** 一个已回答的问题，保留以检测后续文本是否改变了答案。 */
interface Read {
  readonly completion: boolean
  readonly answer: () => unknown
  last: unknown
}

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t',
}

const CONTENT_ESCAPE = /[\\\u0000-\u001f]/u

function isWhitespace(c: string): boolean {
  return c === ' ' || c === '\n' || c === '\r' || c === '\t'
}

function isHex(c: string): boolean {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
}

/**
 * 该视图。一个流式实例通过 {@link PartialArguments.append} 增长；
 * {@link PartialArguments.fromText} 与 {@link PartialArguments.fromObject} 在已完成的
 * 调用之上构建封闭实例。每个读取器都是全的：缺失或类型不同的字段回答 `undefined`
 * （或 `false`），绝不抛出。
 */
export class PartialArguments {
  /** 视图一个没有任何可用参数的调用。 */
  static readonly EMPTY: PartialArguments = PartialArguments.fromObject({})

  /**
   * 查看已完成的参数文本，在读者发问之前不扫描它。
   * @param text - 完整的参数 JSON 文本。
   * @returns 一个封闭的视图。
   */
  static fromText(text: string): PartialArguments {
    const view = new PartialArguments()
    view.append(text)
    view.sealed = true
    return view
  }

  /**
   * 查看一个已解析的参数负载，例如一个 PTC 派发对象。
   * @param value - 已解析的参数值。
   * @returns 一个封闭的视图；非对象负载没有字段。
   */
  static fromObject(value: unknown): PartialArguments {
    const view = new PartialArguments()
    view.object = typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Readonly<Record<string, JsonValue>>
      : {}
    view.sealed = true
    return view
  }

  /**
   * 来源：迄今的文本或一个已解析的对象，外加它是否还能增长。
   * 这些是唯一可枚举的字段，因此两个基于同一来源的视图在结构上相等，无论各自
   * 已读到多远。
   */
  private chunks: string[] = []
  private object: Readonly<Record<string, JsonValue>> | undefined
  private sealed = false
  // 扫描进度、已定位的字段，以及记住的读取，都是基于来源的缓存。
  #ends: number[] = []
  #size = 0
  #consumed = 0
  #mode: Mode = 'root'
  #escape = false
  #keyStart = 0
  #keyEscaped = false
  #key = ''
  #current: Entry | null = null
  #nestedEnds: string[] = []
  #nestedInString = false
  #invalidAt: number | undefined
  #invalidValue = false
  readonly #entries = new Map<string, Entry>()
  readonly #order: string[] = []
  readonly #reads = new Map<string, Read>()

  /** 本视图是否拒绝进一步追加；不扫描文本也不注册读取。 */
  get isSealed(): boolean {
    return this.sealed
  }

  /** 索引或内容读取是否发现了无效 JSON；未读取的值内容不会被校验。 */
  get invalid(): boolean {
    this.scan()
    return this.#mode === 'invalid' || this.#invalidValue
  }

  /**
   * 保留流式参数文本，不做扫描也不比较已观察到的答案。
   * @param fragment - 在之前追加的每个分片之后的文本。
   */
  append(fragment: string): void {
    if (this.sealed) throw new Error('PartialArguments: cannot append to a sealed view')
    if (fragment.length === 0) return
    this.chunks.push(fragment)
    this.#size += fragment.length
    this.#ends.push(this.#size)
  }

  /**
   * 将流式前缀与权威的完整文本调和，而不拼接分片。
   * @param text - 最终的参数文本，替换缺失或冲突的增量。
   * @returns 当每个字符都匹配时，保留其缓存并封闭的此视图；否则一个新的封闭视图。
   */
  settle(text: string): PartialArguments {
    if (this.object !== undefined || text.length !== this.#size) return PartialArguments.fromText(text)
    let offset = 0
    for (const chunk of this.chunks) {
      if (!text.startsWith(chunk, offset)) return PartialArguments.fromText(text)
      offset += chunk.length
    }
    this.chunks = text.length === 0 ? [] : [text]
    this.#ends = text.length === 0 ? [] : [text.length]
    this.sealed = true
    return this
  }

  /**
   * 比较已观察到的答案并推进它们的发布基线。未读取的视图保持未扫描。
   * @returns 自首次读取或上次刷新以来，是否有任何已观察的答案发生了变化。
   */
  refresh(): boolean {
    if (this.#reads.size === 0) return false
    this.scan()
    let changed = false
    let completions = false
    for (const read of this.#reads.values()) {
      if (read.completion) {
        completions = true
        continue
      }
      changed = this.refreshRead(read) || changed
    }
    // 内容读取可能发现会改变某个字段完成答案的错误。
    if (completions) {
      for (const read of this.#reads.values()) if (read.completion) changed = this.refreshRead(read) || changed
    }
    if (this.sealed) this.#reads.clear()
    return changed
  }

  private refreshRead(read: Read): boolean {
    const now = read.answer()
    if (Object.is(now, read.last)) return false
    read.last = now
    return true
  }

  /**
   * 检查是否不可能再有字段到达。
   * @returns 外层对象是否已关闭、索引是否失败，或视图是否封闭；未读取的值不会被校验。
   */
  closed(): boolean {
    return this.remember('closed', '', () => this.closedNow())
  }

  /**
   * 按首次出现顺序列出已发现的字段。
   * @returns 迄今可见的顶层键，按首次出现顺序。
   */
  keys(): readonly string[] {
    return this.remember('keys', '', () => this.keysNow(), keys => keys.length)
  }

  /**
   * 检查一个顶层字段是否已出现。
   * @param key - 参数名。
   * @returns 该字段是否已出现（字符串已打开或另一个值已开始）。
   */
  has(key: string): boolean {
    return this.remember('has', key, () => this.hasNow(key))
  }

  /**
   * 检查一个字段的闭合分隔符是否已到达，而不校验其内容。
   * @param key - 参数名。
   * @returns 其分隔符是否已到达，且没有内容读取器为本值报告过错误。
   */
  complete(key: string): boolean {
    return this.remember('complete', key, () => this.completeNow(key))
  }

  /**
   * 读取字符串长度而不物化其文本。
   * @param key - 参数名。
   * @param options - 流式字符串的变化粒度。
   * @returns 字符串字段迄今已解码的 UTF-16 长度；缺失或非字符串时为 undefined。
   */
  stringLength(key: string, options?: LengthReadOptions): number | undefined {
    const step = Math.max(1, Math.floor(options?.step ?? 1))
    const offset = options?.offset ?? 0
    return this.remember(`length:${step}:${offset}`, key, () => this.lengthNow(key),
      length => length === undefined ? undefined : Math.ceil((length + offset) / step))
  }

  /**
   * 在不物化字符串的前提下，对照一个已解码 UTF-16 长度上限检查它。
   * @param key - 参数名。
   * @param maxLength - 已解码 UTF-16 上限，下取整到至少零。
   * @returns 字符串是否长于上限；缺失或非字符串时为 false。
   */
  stringExceeds(key: string, maxLength: number): boolean {
    const limit = Math.max(0, Math.floor(maxLength))
    return this.remember(`exceeds:${limit}`, key,
      () => (this.lengthNow(key, limit + 1) ?? 0) > limit)
  }

  /**
   * 读取一个已解码的字符串，包括流式前缀。
   * @param key - 参数名。
   * @returns 字符串字段迄今已解码的文本；缺失或非字符串时为 undefined。
   */
  text(key: string): string | undefined {
    return this.remember('text', key, () => this.textNow(key))
  }

  /**
   * 读取一个字符串的前至多解码 UTF-16 单元。
   * @param key - 参数名。
   * @param maxLength - 最大已解码 UTF-16 长度，下取整到至少一。
   * @returns 有界的字符串前缀；缺失或非字符串时为 undefined。
   */
  textPrefix(key: string, maxLength: number): string | undefined {
    const limit = Math.max(1, Math.floor(maxLength))
    return this.remember(`prefix:${limit}`, key,
      () => this.textPrefixNow(key, limit))
  }

  /**
   * 读取一个已完成的非字符串参数。
   * @param key - 参数名。
   * @returns 该值关闭后已解析的非字符串值；打开中、缺失或字符串时为 undefined。
   */
  value(key: string): JsonValue | undefined {
    return this.remember('value', key, () => this.valueNow(key))
  }

  /** 回答一个问题，并在流式视图上记住它以进行变化检测。 */
  private remember<T>(
    kind: ReadKind,
    key: string,
    read: () => T,
    comparison?: (value: T) => unknown,
  ): T {
    this.scan()
    const result = read()
    if (!this.sealed) {
      const id = `${kind}/${key}`
      if (!this.#reads.has(id)) {
        this.#reads.set(id, {
          completion: kind === 'complete',
          answer: comparison === undefined ? read : () => comparison(read()),
          last: comparison === undefined ? result : comparison(result),
        })
      }
    }
    return result
  }

  private closedNow(): boolean {
    return this.sealed || this.#mode === 'closed' || this.#mode === 'invalid'
  }

  private keysNow(): readonly string[] {
    return this.object === undefined ? this.#order : Object.keys(this.object)
  }

  private hasNow(key: string): boolean {
    return this.object === undefined ? this.#entries.has(key) : Object.hasOwn(this.object, key)
  }

  private completeNow(key: string): boolean {
    if (this.object !== undefined) return Object.hasOwn(this.object, key)
    const entry = this.#entries.get(key)
    return entry !== undefined && entry.end >= 0
      && (entry.kind === 'string' ? entry.invalidAt === undefined : !entry.invalid)
  }

  private lengthNow(key: string, limit = Number.POSITIVE_INFINITY): number | undefined {
    if (this.object !== undefined) {
      const field = Object.hasOwn(this.object, key) ? this.object[key] : undefined
      return typeof field === 'string' ? field.length : undefined
    }
    const entry = this.#entries.get(key)
    if (entry?.kind !== 'string') return undefined
    if (entry.text !== undefined && entry.text.at === entry.end) return entry.text.length
    const read = entry.length ??= { at: entry.start, length: 0, text: '' }
    this.readString(entry, read, limit, false)
    return read.length
  }

  private textNow(key: string): string | undefined {
    if (this.object !== undefined) {
      const field = Object.hasOwn(this.object, key) ? this.object[key] : undefined
      return typeof field === 'string' ? field : undefined
    }
    const entry = this.#entries.get(key)
    if (entry?.kind !== 'string') return undefined
    if (entry.text === undefined && entry.end >= 0 && entry.needsDecoding && entry.invalidAt === undefined) {
      let text: string | undefined
      try {
        text = JSON.parse(`"${this.slice(entry.start, entry.end)}"`) as string
      } catch (_error) {
        // 增量读取器在完整文本含有无效转义时保留有效前缀。
      }
      if (text !== undefined) entry.text = { at: entry.end, length: text.length, text }
    }
    const read = entry.text ??= { at: entry.start, length: 0, text: '' }
    this.readString(entry, read, Number.POSITIVE_INFINITY, true)
    return read.text
  }

  private textPrefixNow(key: string, maxLength: number): string | undefined {
    if (this.object !== undefined) {
      const field = Object.hasOwn(this.object, key) ? this.object[key] : undefined
      return typeof field === 'string' ? field.slice(0, maxLength) : undefined
    }
    const entry = this.#entries.get(key)
    if (entry?.kind !== 'string') return undefined
    const prefixes = entry.prefixes ??= new Map<number, StringRead>()
    let read = prefixes.get(maxLength)
    if (read === undefined) {
      read = { at: entry.start, length: 0, text: '' }
      prefixes.set(maxLength, read)
    }
    this.readString(entry, read, maxLength, true)
    return read.text
  }

  private valueNow(key: string): JsonValue | undefined {
    if (this.object !== undefined) {
      if (!Object.hasOwn(this.object, key)) return undefined
      const field = this.object[key]
      return typeof field === 'string' ? undefined : field
    }
    const entry = this.#entries.get(key)
    if (entry?.kind !== 'value' || entry.end < 0 || entry.invalid) return undefined
    if (entry.parsed === undefined) {
      try {
        entry.parsed = JSON.parse(this.slice(entry.start, entry.end)) as JsonValue
      } catch (_error) {
        // 未读取的值仅保留其范围；一个被请求的畸形值没有已解析结果。
        entry.invalid = true
        this.#invalidValue = true
      }
    }
    return entry.parsed
  }

  private chunkAt(at: number): number {
    let low = 0
    let high = this.#ends.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if ((this.#ends[mid] as number) <= at) low = mid + 1
      else high = mid
    }
    return low
  }

  /** 仅物化被请求的范围，绝不物化累积来源。 */
  private slice(start: number, end: number): string {
    if (start >= end) return ''
    const first = this.chunkAt(start)
    const last = this.chunkAt(end - 1)
    const base = first === 0 ? 0 : this.#ends[first - 1] as number
    if (first === last) return (this.chunks[first] as string).slice(start - base, end - base)
    const parts = [(this.chunks[first] as string).slice(start - base)]
    for (let i = first + 1; i < last; i++) parts.push(this.chunks[i] as string)
    parts.push((this.chunks[last] as string).slice(0, end - (this.#ends[last - 1] as number)))
    return parts.join('')
  }

  private readString(
    entry: Extract<Entry, { kind: 'string' }>,
    read: StringRead,
    limit: number,
    materialize: boolean,
  ): void {
    const end = Math.min(entry.end < 0 ? this.#consumed : entry.end,
      entry.invalidAt ?? Number.POSITIVE_INFINITY, this.#invalidAt ?? Number.POSITIVE_INFINITY)
    if (!entry.needsDecoding) {
      const length = Math.min(end - read.at, limit - read.length)
      if (length <= 0) return
      if (materialize) read.text += this.slice(read.at, read.at + length)
      read.at += length
      read.length += length
      return
    }
    let chunkIndex = this.chunkAt(read.at)
    while (read.at < end && read.length < limit) {
      const base = chunkIndex === 0 ? 0 : this.#ends[chunkIndex - 1] as number
      const chunk = this.chunks[chunkIndex] as string
      const remaining = chunk.slice(read.at - base, Math.min(chunk.length, end - base))
      const boundary = remaining.search(CONTENT_ESCAPE)
      const length = Math.min(boundary < 0 ? remaining.length : boundary, limit - read.length)
      if (length > 0) {
        if (materialize) read.text += remaining.slice(0, length)
        read.at += length
        read.length += length
        if (read.at === base + chunk.length) chunkIndex++
        continue
      }
      const type = remaining.length > 1 ? remaining[1]
        : read.at + 1 < end ? (this.chunks[chunkIndex + 1] as string)[0] : undefined
      let decoded: string | undefined
      let width = 2
      if (remaining[0] === '\\' && type === undefined && entry.end < 0) return
      if (remaining[0] === '\\' && type === 'u') {
        const hex = this.slice(read.at + 2, Math.min(end, read.at + 6))
        let valid = true
        for (let i = 0; i < hex.length; i++) if (!isHex(hex[i] as string)) valid = false
        if (valid) {
          if (hex.length < 4 && entry.end < 0) return
          if (hex.length === 4) decoded = String.fromCharCode(Number.parseInt(hex, 16))
        }
        width = 6
      } else if (remaining[0] === '\\' && type !== undefined) {
        decoded = SIMPLE_ESCAPES[type]
      }
      if (decoded === undefined) {
        entry.invalidAt = read.at
        this.#invalidValue = true
        return
      }
      if (materialize) read.text += decoded
      read.length++
      read.at += width
      while (chunkIndex < this.chunks.length && read.at >= (this.#ends[chunkIndex] as number)) chunkIndex++
    }
  }

  /** 定位新字段范围，而不解码或解析其内容。 */
  private scan(): void {
    if (this.object !== undefined || this.#consumed === this.#size) return
    for (let i = this.chunkAt(this.#consumed); i < this.chunks.length && this.#invalidAt === undefined; i++) {
      const pending = this.chunks[i] as string
      const base = i === 0 ? 0 : this.#ends[i - 1] as number
      for (let index = this.#consumed - base; index < pending.length && this.#mode !== 'invalid'; index++) {
        if (this.#mode === 'string' || (this.#mode === 'nested' && this.#nestedInString)) {
          const end = this.stringBoundary(pending, index)
          this.#consumed += end - index
          index = end
          if (index === pending.length) break
        }
        this.step(pending[index] as string, this.#consumed)
        this.#consumed++
      }
    }
  }

  /** 只有原始引号及其前导反斜杠序列可以终止一个字符串。 */
  private stringBoundary(fragment: string, start: number): number {
    let at = start
    while (true) {
      const quote = fragment.indexOf('"', at)
      const end = quote < 0 ? fragment.length : quote
      if (this.#mode === 'string') {
        const entry = this.#current as Extract<Entry, { kind: 'string' }>
        if (!entry.needsDecoding && CONTENT_ESCAPE.test(fragment.slice(at, end))) entry.needsDecoding = true
      }
      let slashStart = end
      while (slashStart > at && fragment[slashStart - 1] === '\\') slashStart--
      const escaped = ((end - slashStart) % 2 === 1) !== (slashStart === at && this.#escape)
      this.#escape = quote < 0 && escaped
      if (quote < 0 || !escaped) return end
      at = quote + 1
    }
  }

  private step(c: string, at: number): void {
    switch (this.#mode) {
      case 'root':
        if (isWhitespace(c)) return
        if (c === '{') { this.#mode = 'key-or-end'; return }
        this.fail(); return
      case 'key-or-end':
        if (isWhitespace(c)) return
        if (c === '}') { this.#mode = 'closed'; return }
        if (c === '"') { this.beginKey(at); return }
        this.fail(); return
      case 'key-only':
        if (isWhitespace(c)) return
        if (c === '"') { this.beginKey(at); return }
        this.fail(); return
      case 'key':
        this.stepKey(c, at); return
      case 'colon':
        if (isWhitespace(c)) return
        if (c === ':') { this.#mode = 'value'; return }
        this.fail(); return
      case 'value':
        this.beginValue(c, at); return
      case 'string': {
        const entry = this.#current as Extract<Entry, { kind: 'string' }>
        entry.end = at
        this.#current = null
        this.#mode = 'comma-or-end'
        return
      }
      case 'scalar':
        this.stepScalar(c, at); return
      case 'nested':
        this.stepNested(c, at); return
      case 'comma-or-end':
        if (isWhitespace(c)) return
        if (c === ',') { this.#mode = 'key-only'; return }
        if (c === '}') { this.#mode = 'closed'; return }
        this.fail(); return
      case 'closed':
        if (isWhitespace(c)) return
        this.fail(); return
      /* v8 ignore next 2 -- scan() 一旦视图失效就停止步进。 */
      case 'invalid':
        return
      /* v8 ignore next 2 -- 每个扫描器模式在上方都有处理。 */
      default:
        assertNever(this.#mode)
    }
  }

  private fail(): void {
    this.#invalidAt = this.#consumed
    this.#mode = 'invalid'
    this.#current = null
  }

  private beginKey(at: number): void {
    this.#mode = 'key'
    this.#keyStart = at + 1
    this.#keyEscaped = false
    this.#escape = false
  }

  private stepKey(c: string, at: number): void {
    if (c < ' ') { this.fail(); return }
    if (this.#escape) { this.#escape = false; return }
    if (c === '\\') { this.#escape = true; this.#keyEscaped = true; return }
    if (c !== '"') return
    const raw = this.slice(this.#keyStart, at)
    if (this.#keyEscaped) {
      try {
        this.#key = JSON.parse(`"${raw}"`) as string
      } catch (_error) {
        // 无效的键转义会阻止识别后续字段。
        this.fail()
        return
      }
    } else {
      this.#key = raw
    }
    this.#mode = 'colon'
  }

  private open(entry: Entry): void {
    if (!this.#entries.has(this.#key)) this.#order.push(this.#key)
    this.#entries.set(this.#key, entry)
    this.#current = entry
  }

  private beginValue(c: string, at: number): void {
    if (isWhitespace(c)) return
    if (c === '"') {
      this.open({
        kind: 'string', start: at + 1, end: -1, needsDecoding: false, invalidAt: undefined,
        length: undefined, text: undefined, prefixes: undefined,
      })
      this.#escape = false
      this.#mode = 'string'
      return
    }
    if (c === '}' || c === ',' || c === ':' || c === ']') { this.fail(); return }
    this.open({ kind: 'value', start: at, end: -1, parsed: undefined, invalid: false })
    if (c === '{' || c === '[') {
      this.#mode = 'nested'
      this.#nestedEnds = [c === '{' ? '}' : ']']
      this.#nestedInString = false
      this.#escape = false
      return
    }
    this.#mode = 'scalar'
  }

  private stepScalar(c: string, at: number): void {
    if (c !== ',' && c !== '}' && !isWhitespace(c)) return
    this.closeValue(at)
    this.#mode = c === ',' ? 'key-only' : c === '}' ? 'closed' : 'comma-or-end'
  }

  private stepNested(c: string, at: number): void {
    if (this.#nestedInString) {
      this.#nestedInString = false
      return
    }
    if (c === '"') { this.#nestedInString = true; return }
    if (c === '{' || c === '[') { this.#nestedEnds.push(c === '{' ? '}' : ']'); return }
    if (c === '}' || c === ']') {
      if (this.#nestedEnds.pop() !== c) { this.fail(); return }
      if (this.#nestedEnds.length === 0) {
        this.closeValue(at + 1)
        this.#mode = 'comma-or-end'
      }
    }
  }

  private closeValue(end: number): void {
    const entry = this.#current as Extract<Entry, { kind: 'value' }>
    entry.end = end
    this.#current = null
  }
}
