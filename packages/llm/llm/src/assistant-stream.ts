/**
 * 一次模型流式尝试的无损紧凑表示，以及无需物化各成员即可回答常见
 * 消费者问题的记录级读取器。读取器信任静态的记录类型；
 * `expandAssistantStream` 是在持久化边界处读取记录时使用的校验路径。
 */

import { assertNever, deepFreeze, snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import { BlockAssembler } from './assembler.ts'
import type { ToolCallId } from './brand.ts'
import type { ContentBlock, StreamChunk } from './types.ts'

/** 一个模型块，与它原始的 Session 时间戳配对。 */
export interface TimedStreamChunk {
  readonly time: number
  readonly chunk: StreamChunk
}

/** 内嵌在持久化 Assistant 尝试事件中的无损紧凑记录。 */
export type AssistantStreamRecord =
  | {
    readonly type: 'text-chunks'
    readonly time0: number
    readonly index: number
    readonly dt: readonly number[]
    readonly texts: readonly string[]
  }
  | {
    readonly type: 'reasoning-chunks'
    readonly time0: number
    readonly index: number
    readonly dt: readonly number[]
    readonly texts: readonly string[]
  }
  | {
    readonly type: 'tool-call-chunks'
    readonly time0: number
    readonly index: number
    readonly dt: readonly number[]
    readonly id: ToolCallId
    readonly name?: string
    readonly args: readonly string[]
  }
  | { readonly type: 'chunk'; readonly time: number; readonly chunk: StreamChunk }

/** 一段已打包的增量序列：除一个原始 `chunk` 之外的每条紧凑记录。 */
export type AssistantStreamRun = Exclude<AssistantStreamRecord, { type: 'chunk' }>

/**
 * 累加器从不打包进序列的那些块类型，因此每次出现都是一个原始 `chunk`
 * 记录。增量类型被排除，是因为它们打包后的成员不是原始块。
 */
export type RawStreamChunkType = Exclude<StreamChunk['type'], 'text-delta' | 'reasoning-delta' | 'tool-call-delta'>

type MutableRecord =
  | {
    type: 'text-chunks' | 'reasoning-chunks'
    time0: number
    index: number
    dt: number[]
    texts: string[]
    lastTime: number
  }
  | {
    type: 'tool-call-chunks'
    time0: number
    index: number
    dt: number[]
    id: ToolCallId
    name?: string
    args: string[]
    lastTime: number
  }
  | { type: 'chunk'; time: number; chunk: StreamChunk }

function safeTime(value: number): number {
  if (!Number.isSafeInteger(value)) throw new TypeError(`Assistant stream time must be a safe integer, got ${String(value)}`)
  return value
}

function safeIndex(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new TypeError(`${label} index must be a non-negative safe integer`)
  }
  return value
}

function snapshotChunk(chunk: StreamChunk): StreamChunk {
  const snapshot = snapshotJsonValue(chunk)
  if (snapshot === undefined) throw new TypeError('Assistant stream chunk must be losslessly JSON-serializable')
  return snapshot
}

function safeGap(previous: number, next: number): number | undefined {
  const gap = next - previous
  return Number.isSafeInteger(gap) && previous + gap === next ? gap : undefined
}

/** 增量地压缩一次尝试，而不保留第二份原始块列表。 */
export class AssistantStreamAccumulator {
  private readonly records: MutableRecord[] = []

  /**
   * 把一个带时间戳的块加入这次紧凑的尝试流。
   * @param value - 模型块及其原始的 Session 时间戳。
   * @returns 一份已分离的不可变副本，供装配与实时发布使用。
   */
  push(value: TimedStreamChunk): TimedStreamChunk {
    const time = safeTime(value.time)
    const chunk = snapshotChunk(value.chunk)
    const timed = deepFreeze({ time, chunk })
    const previous = this.records.at(-1)
    switch (chunk.type) {
      case 'text-delta':
      case 'reasoning-delta': {
        safeIndex(chunk.index, chunk.type)
        if (typeof chunk.text !== 'string') throw new TypeError(`${chunk.type} text must be a string`)
        const type = chunk.type === 'text-delta' ? 'text-chunks' : 'reasoning-chunks'
        const gap = previous !== undefined && previous.type === type ? safeGap(previous.lastTime, time) : undefined
        if (previous !== undefined && previous.type === type && previous.index === chunk.index && gap !== undefined) {
          previous.dt.push(gap)
          previous.texts.push(chunk.text)
          previous.lastTime = time
        } else {
          this.records.push({ type, time0: time, index: chunk.index, dt: [], texts: [chunk.text], lastTime: time })
        }
        return timed
      }
      case 'tool-call-delta': {
        safeIndex(chunk.index, chunk.type)
        if (typeof chunk.id !== 'string') throw new TypeError('tool-call-delta id must be a string')
        if (Object.hasOwn(chunk, 'name') && typeof chunk.name !== 'string') {
          throw new TypeError('tool-call-delta name must be a string')
        }
        if (typeof chunk.argumentsDelta !== 'string') {
          throw new TypeError('tool-call-delta argumentsDelta must be a string')
        }
        if (chunk.id.length === 0 || chunk.name === '') {
          this.records.push({ type: 'chunk', time, chunk })
          return timed
        }
        const gap = previous?.type === 'tool-call-chunks' ? safeGap(previous.lastTime, time) : undefined
        const sameName = previous?.type === 'tool-call-chunks'
          && Object.hasOwn(previous, 'name') === Object.hasOwn(chunk, 'name')
          && previous.name === chunk.name
        if (previous?.type === 'tool-call-chunks'
          && previous.index === chunk.index
          && previous.id === chunk.id
          && sameName
          && gap !== undefined) {
          previous.dt.push(gap)
          previous.args.push(chunk.argumentsDelta)
          previous.lastTime = time
        } else {
          this.records.push({
            type: 'tool-call-chunks',
            time0: time,
            index: chunk.index,
            dt: [],
            id: chunk.id,
            ...Object.hasOwn(chunk, 'name') ? { name: chunk.name } : {},
            args: [chunk.argumentsDelta],
            lastTime: time,
          })
        }
        return timed
      }
      case 'block-start':
      case 'block-end':
      case 'usage':
      case 'finish':
        this.records.push({ type: 'chunk', time, chunk })
        return timed
      default:
        return assertNever(chunk, 'AssistantStreamAccumulator.push')
    }
  }

  /**
   * 返回当前的紧凑尝试流。
   * @returns 一份适合放进持久化事件的、已分离的不可变记录列表。
   */
  snapshot(): readonly AssistantStreamRecord[] {
    const records = this.records.map((record): AssistantStreamRecord => {
      if (record.type === 'chunk') return { ...record }
      const { lastTime: _lastTime, ...durable } = record
      if (durable.type === 'tool-call-chunks') {
        return { ...durable, dt: [...durable.dt], args: [...durable.args] }
      }
      return { ...durable, dt: [...durable.dt], texts: [...durable.texts] }
    })
    return deepFreeze(records)
  }
}

/**
 * 把紧凑记录展开为精确的、带时间戳的块序列。
 * @param stream - 来自一次持久化 Assistant 落定的紧凑记录。
 * @returns 已分离的、带时间戳的块，其中每个原始增量边界都得以保留。
 * @throws {TypeError} 当某条记录或某个被重建的时间戳无效时。
 */
export function expandAssistantStream(stream: readonly AssistantStreamRecord[]): readonly TimedStreamChunk[] {
  const chunks: TimedStreamChunk[] = []
  for (const candidate of stream) {
    const record = validateRecord(candidate)
    if (record.type === 'chunk') {
      chunks.push({ time: record.time, chunk: record.chunk })
      continue
    }
    const members = record.type === 'tool-call-chunks' ? record.args : record.texts
    let time = record.time0
    for (let index = 0; index < members.length; index += 1) {
      if (index > 0) time += record.dt[index - 1] as number
      let chunk: StreamChunk
      if (record.type === 'text-chunks') {
        chunk = { type: 'text-delta', index: record.index, text: members[index] as string }
      } else if (record.type === 'reasoning-chunks') {
        chunk = { type: 'reasoning-delta', index: record.index, text: members[index] as string }
      } else {
        chunk = {
          type: 'tool-call-delta',
          index: record.index,
          id: record.id,
          ...Object.hasOwn(record, 'name') ? { name: record.name } : {},
          argumentsDelta: members[index] as string,
        }
      }
      chunks.push({ time, chunk })
    }
  }
  return chunks
}

function hasNonWhitespace(text: string): boolean {
  return /\S/.test(text)
}

function blockIsVisible(block: ContentBlock): boolean {
  if (block.type === 'tool-call') return false
  if (block.type === 'text' || block.type === 'reasoning') return hasNonWhitespace(block.text)
  return true
}

/**
 * 某个块是否承载了模型用于延迟测量的首个输出令牌。
 * @param chunk - 任意流式块。
 * @returns 对一个非空的文本、推理或工具调用参数片段，以及每个携带名称的
 *   工具调用增量为 true；对 block、usage 与 finish 块为 false。
 */
export function isTokenDelta(chunk: StreamChunk): boolean {
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return chunk.text !== ''
    case 'tool-call-delta':
      return chunk.argumentsDelta !== '' || chunk.name !== undefined
    default:
      return false
  }
}

/**
 * 某个块自身是否贡献了读取者可见的对话内容。
 * 文本与推理只在具备非空白内容时计入，无论是作为增量流式输出还是
 * 作为一个已完成的块；任何其他种类的块在它的开始与结束时各计入一次，
 * 但工具调用除外——它是协议而非内容。usage 与 finish 永不计入。
 * @param chunk - 任意流式块。
 * @returns 一个对话读取者是否会看到这个块。
 */
export function isVisibleChunk(chunk: StreamChunk): boolean {
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return hasNonWhitespace(chunk.text)
    case 'block-start':
      return chunk.blockType !== 'text' && chunk.blockType !== 'reasoning' && chunk.blockType !== 'tool-call'
    case 'block-end':
      return blockIsVisible(chunk.block)
    default:
      return false
  }
}

/**
 * 某个块是否承载非空白文本，无论是作为一个文本增量还是一个已完成的文本块。
 * 推理、工具调用与其他块种类永不计入。
 * @param chunk - 任意流式块。
 * @returns 该块是否贡献了可见文本。
 */
export function chunkHasVisibleText(chunk: StreamChunk): boolean {
  if (chunk.type === 'text-delta') return hasNonWhitespace(chunk.text)
  return chunk.type === 'block-end' && chunk.block.type === 'text' && hasNonWhitespace(chunk.block.text)
}

function firstRunMemberTime(run: AssistantStreamRun, predicate: (fragment: string) => boolean): number | undefined {
  const fragments = run.type === 'tool-call-chunks' ? run.args : run.texts
  let time = run.time0
  for (let index = 0; index < fragments.length; index += 1) {
    if (index > 0) time += run.dt[index - 1] as number
    if (predicate(fragments[index] as string)) return time
  }
  return undefined
}

/**
 * 一段已打包序列中第一个被 {@link isTokenDelta} 接受的成员的时间：
 * 一个携带名称的工具调用序列从它的第一个成员开始，否则是第一个非空片段。
 * 扫描在该成员处停止。
 * @param run - 一段已打包的增量序列。
 * @returns 该成员被重建出来的时间，或当没有成员合格时为 undefined。
 */
export function runFirstTokenTime(run: AssistantStreamRun): number | undefined {
  if (run.type === 'tool-call-chunks' && run.name !== undefined) return run.time0
  return firstRunMemberTime(run, fragment => fragment !== '')
}

/**
 * 一段已打包序列中第一个被 {@link isVisibleChunk} 接受的成员的时间：
 * 第一个非空白的文本或推理片段。一个工具调用序列没有这样的成员。
 * 扫描在该成员处停止。
 * @param run - 一段已打包的增量序列。
 * @returns 该成员被重建出来的时间，或当没有成员合格时为 undefined。
 */
export function runFirstVisibleTime(run: AssistantStreamRun): number | undefined {
  return run.type === 'tool-call-chunks' ? undefined : firstRunMemberTime(run, hasNonWhitespace)
}

/**
 * 按 {@link isTokenDelta}，从记录自身读取、并在第一个合格成员处停止的
 * 某条紧凑流中首个令牌的时间。
 * @param stream - 来自一次持久化 Assistant 落定的紧凑记录。
 * @returns 首个令牌的时间，或当该流不承载任何令牌时为 undefined。
 */
export function assistantStreamFirstTokenTime(stream: readonly AssistantStreamRecord[]): number | undefined {
  for (const record of stream) {
    const time = record.type === 'chunk'
      ? (isTokenDelta(record.chunk) ? record.time : undefined)
      : runFirstTokenTime(record)
    if (time !== undefined) return time
  }
  return undefined
}

/**
 * 按 {@link isVisibleChunk}，某条紧凑流是否承载任何读取者可见的内容，
 * 在第一个合格成员处停止。
 * @param stream - 来自一次持久化 Assistant 落定的紧凑记录。
 * @returns 一个对话读取者是否会从这条流看到任何东西。
 */
export function assistantStreamHasVisibleContent(stream: readonly AssistantStreamRecord[]): boolean {
  return stream.some(record => record.type === 'chunk'
    ? isVisibleChunk(record.chunk)
    : runFirstVisibleTime(record) !== undefined)
}

/**
 * 按 {@link chunkHasVisibleText}，某条紧凑流是否承载非空白文本，
 * 在第一个合格成员处停止。
 * @param stream - 来自一次持久化 Assistant 落定的紧凑记录。
 * @returns 该流是否贡献了可见文本。
 */
export function assistantStreamHasVisibleText(stream: readonly AssistantStreamRecord[]): boolean {
  return stream.some(record => record.type === 'text-chunks'
    ? record.texts.some(hasNonWhitespace)
    : record.type === 'chunk' && chunkHasVisibleText(record.chunk))
}

/**
 * 某个从不打包的类型的最后一个原始块，从后向前扫描并在首个命中处停止。
 * @param stream - 来自一次持久化 Assistant 落定的紧凑记录。
 * @param type - 只作为原始记录出现的块类型。
 * @returns 该流中该类型的最后一个块，或当它没有时为 undefined。
 */
export function lastAssistantStreamChunk<T extends RawStreamChunkType>(
  stream: readonly AssistantStreamRecord[],
  type: T,
): Extract<StreamChunk, { type: T }> | undefined {
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index] as AssistantStreamRecord
    if (record.type === 'chunk' && record.chunk.type === type) return record.chunk as Extract<StreamChunk, { type: T }>
  }
  return undefined
}

/**
 * 某个从不打包的类型的全部原始块，按流顺序排列。
 * @param stream - 来自一次持久化 Assistant 落定的紧凑记录。
 * @param type - 只作为原始记录出现的块类型。
 * @returns 匹配的各个块；当该流没有时为 empty。
 */
export function assistantStreamChunks<T extends RawStreamChunkType>(
  stream: readonly AssistantStreamRecord[],
  type: T,
): readonly Extract<StreamChunk, { type: T }>[] {
  const chunks: Extract<StreamChunk, { type: T }>[] = []
  for (const record of stream) {
    if (record.type === 'chunk' && record.chunk.type === type) chunks.push(record.chunk as Extract<StreamChunk, { type: T }>)
  }
  return chunks
}

/**
 * 按流顺序拼接起来的、所有已流式输出的 text-delta 片段；
 * 推理与工具调用片段被排除。
 * @param stream - 来自一次持久化 Assistant 落定的紧凑记录。
 * @returns 拼接后的文本，当该流不承载任何文本增量时为空。
 */
export function joinAssistantStreamText(stream: readonly AssistantStreamRecord[]): string {
  const parts: string[] = []
  for (const record of stream) {
    if (record.type === 'text-chunks') parts.push(record.texts.join(''))
    else if (record.type === 'chunk' && record.chunk.type === 'text-delta') parts.push(record.chunk.text)
  }
  return parts.join('')
}

/**
 * 把一条紧凑流喂入一个 {@link BlockAssembler}，而不物化其各个成员。
 * 每段序列贡献一个携带其拼接后片段的增量，这会装配出与原来逐成员增量
 * 相同的块，因为装配只是把它们连接起来；原始块则按记录原样推入。
 * 这些记录是被信任的，而非被校验的：对于在持久化边界处读取的流，
 * 请先用 {@link expandAssistantStream} 校验它。
 * @param stream - 来自一次持久化 Assistant 落定的紧凑记录。
 * @param assembler - 要喂入的装配器；默认为一个全新的。
 * @returns 每条记录都被推入之后的同一个装配器。
 */
export function assembleAssistantStream(
  stream: readonly AssistantStreamRecord[],
  assembler = new BlockAssembler(),
): BlockAssembler {
  for (const record of stream) {
    switch (record.type) {
      case 'chunk':
        assembler.push(record.chunk)
        break
      case 'text-chunks':
        assembler.push({ type: 'text-delta', index: record.index, text: record.texts.join('') })
        break
      case 'reasoning-chunks':
        assembler.push({ type: 'reasoning-delta', index: record.index, text: record.texts.join('') })
        break
      case 'tool-call-chunks':
        assembler.push({
          type: 'tool-call-delta',
          index: record.index,
          id: record.id,
          ...record.name === undefined ? {} : { name: record.name },
          argumentsDelta: record.args.join(''),
        })
        break
      default:
        assertNever(record, 'assembleAssistantStream')
    }
  }
  return assembler
}

function validateRecord(value: unknown): AssistantStreamRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Assistant stream record must be an object')
  }
  const record = value as Record<string, unknown>
  switch (record.type) {
    case 'text-chunks':
    case 'reasoning-chunks': {
      exactKeys(record, ['type', 'time0', 'index', 'dt', 'texts'], record.type)
      const texts = stringArray(record.texts, `${record.type} texts`)
      if (texts.length === 0) throw new TypeError(`${record.type} texts must be non-empty`)
      validateRun(record, texts.length, record.type)
      return record as AssistantStreamRecord
    }
    case 'tool-call-chunks': {
      const keys = Object.hasOwn(record, 'name')
        ? ['type', 'time0', 'index', 'dt', 'id', 'name', 'args']
        : ['type', 'time0', 'index', 'dt', 'id', 'args']
      exactKeys(record, keys, record.type)
      const args = stringArray(record.args, 'tool-call-chunks args')
      if (args.length === 0) throw new TypeError('tool-call-chunks args must be non-empty')
      if (typeof record.id !== 'string' || record.id.length === 0) {
        throw new TypeError('tool-call-chunks id must be a non-empty string')
      }
      if (record.name !== undefined && (typeof record.name !== 'string' || record.name.length === 0)) {
        throw new TypeError('tool-call-chunks name must be a non-empty string')
      }
      validateRun(record, args.length, record.type)
      return record as AssistantStreamRecord
    }
    case 'chunk': {
      exactKeys(record, ['type', 'time', 'chunk'], 'chunk')
      const time = safeTime(record.time as number)
      if (typeof record.chunk !== 'object'
        || record.chunk === null
        || Array.isArray(record.chunk)) {
        throw new TypeError('Assistant stream raw chunk must be a lossless JSON object')
      }
      let chunk: StreamChunk
      try {
        chunk = snapshotChunk(record.chunk as StreamChunk)
      } catch (error: unknown) {
        throw new TypeError('Assistant stream raw chunk must be a lossless JSON object', { cause: error })
      }
      return deepFreeze({ type: 'chunk', time, chunk })
    }
    default:
      throw new TypeError(`Unsupported Assistant stream record ${JSON.stringify(record.type)}`)
  }
}

function validateRun(record: Record<string, unknown>, members: number, label: string): void {
  safeTime(record.time0 as number)
  safeIndex(record.index as number, label)
  if (!Array.isArray(record.dt) || record.dt.some(value => !Number.isSafeInteger(value))) {
    throw new TypeError(`${label} dt must contain safe integers`)
  }
  if (record.dt.length !== members - 1) {
    throw new TypeError(`${label} dt length must be one less than its members`)
  }
  let time = record.time0 as number
  for (const gap of record.dt as number[]) {
    time += gap
    if (!Number.isSafeInteger(time)) throw new TypeError(`${label} member times must stay safe integers`)
  }
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(member => typeof member !== 'string')) {
    throw new TypeError(`${label} must be a string array`)
  }
  return value as string[]
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(record).length !== keys.length || !keys.every(key => Object.hasOwn(record, key))) {
    throw new TypeError(`${label} Assistant stream record must contain exactly ${keys.join(', ')}`)
  }
}
