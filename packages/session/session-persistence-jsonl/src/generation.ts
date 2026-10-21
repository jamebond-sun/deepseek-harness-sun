/**
 * JSONL Session 制品的持久整代际发布。
 *
 * 格式包负责转换已解析的 JSON 值。本模块拥有物理编码、精确的源身份、
 * 不可变的代际文件，以及针对两种已配置 JSONL 后缀的独占当前代际发布。
 * @module @deepseek-ai/dsh-session-persistence-jsonl/generation
 */

import { currentSessionMessageProjections } from '@deepseek-ai/dsh-session-format-catalog/message-projections'
import { createHash, randomBytes } from 'node:crypto'
import {
  link as fsLink,
  lstat as fsLstat,
  open as fsOpen,
  readFile as fsReadFile,
  readdir as fsReaddir,
  rm as fsRm,
  stat as fsStat,
  type FileHandle,
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pipeline, Readable } from 'node:stream'
import { scheduler } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import { constants, createZstdCompress } from 'node:zlib'
import { Session } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { BlockAssembler, expandAssistantStream } from '@deepseek-ai/dsh-llm'
import { SessionFormatError } from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatArtifact,
  SessionFormatJsonValue,
  SessionFormatRestore,
} from '@deepseek-ai/dsh-session-format'
import { validateStoredEvents } from '@deepseek-ai/dsh-session-persistence'
import type { JsonlCompression } from './format.ts'
import { generationLogFilename, logSuffix, SessionLogScanner } from './format.ts'
import { publishNewFileWin32 } from './win32.ts'
import {
  compressZstdFrame,
  createZstdFrameDecoder,
  decompressZstdPrefix,
  scanZstdFrames,
} from './zstd.ts'

/** 内部调度上限：保留旧的解码节奏，并为每个同步编码切片设上限。 */
const MIGRATION_DECODE_YIELD_INTERVAL_MS = 500
const MIGRATION_WORK_CHUNK_BYTES = 1024 * 1024
const MIGRATION_WRITE_CHUNK_BYTES = 4 * 1024 * 1024
const ZSTD_CHECKSUM_OPTIONS = {
  chunkSize: MIGRATION_WORK_CHUNK_BYTES,
  params: { [constants.ZSTD_c_checksumFlag]: 1 },
}

/** 后端持有的 JSONL 分帧与格式目录之间的纯适配器。 */
export interface JsonlGenerationFormatAdapter {
  readonly currentVersion: number
  /** 为一个历史头部创建单趟编解码器与迁移状态。 */
  createRestore(header: Record<string, unknown>): SessionFormatRestore
  /** 编码一条当前头部记录，无需物化事件体行。 */
  encodeHeader(header: SessionFormatArtifact['header'], inheritedEventCount: number): SessionFormatJsonValue
  /** 编码一条当前事件记录。 */
  encodeEvent(event: SessionFormatArtifact['events'][number]): SessionFormatJsonValue
  /** 对策略拒绝迁移的、版本受支持的制品做分类。 */
  isUnsupportedMigrationError?(error: unknown): error is Error
}

/** 准备一个历史代际并在之后发布其当前后继者所需的输入。 */
export interface PrepareJsonlMigrationOptions {
  /** 在 preparation 返回之前以及发布之前立即重新校验相关的源事实。 */
  readonly validateRelatedSources?: () => Promise<void>
  /** 由后端解析器选定的不可变代际。 */
  readonly sourcePath: string
  /** 从源文件名选出、并独立地与自身头部核对过的版本。 */
  readonly sourceVersion: number
  /** 同一 Session 目录中 `format.currentVersion` 的规范文件名。 */
  readonly currentPath: string
  readonly compression: JsonlCompression
  readonly format: JsonlGenerationFormatAdapter
  /** 在任何迁移写入之前校验一个所选历史头部的身份。 */
  readonly validateHistoricalHeader?: (
    header: Readonly<Record<string, unknown>>,
  ) => void | Promise<void>
  /** 在发布之前，于一个隔离的 worker 中校验已暂存的文件。 */
  readonly verifyCurrentFile: (
    path: string,
    compression: JsonlCompression,
    expectedId: string,
    expectedEventCount: number,
    expectedPrefix?: JsonlExpectedPrefix,
    signal?: AbortSignal,
  ) => Promise<JsonlVerifiedGeneration>
  readonly signal?: AbortSignal
}

/** 由隔离的代际校验器返回的精简物理身份。 */
export interface JsonlVerifiedGeneration {
  readonly identity: JsonlPhysicalIdentity
  readonly bytes: number
  readonly digest: string
}

/** 已被证明是一个有效完整代际的物理字节前缀。 */
export interface JsonlExpectedPrefix {
  readonly bytes: number
  readonly digest: string
}

/** 某个历史源在其唯一一次解码与迁移过程之后发生了变化。 */
export class JsonlGenerationSourceChangedError extends Error {
  override readonly name = 'JsonlGenerationSourceChangedError'

  /** @param path - 修订已发生变化的历史代际。 */
  constructor(readonly path: string) {
    super(`historical session generation changed during migration: "${path}"`)
  }
}

/** 独立于持久发布而准备好的当前逻辑状态。 */
export interface PreparedJsonlMigration {
  readonly sourceIdentity: JsonlPhysicalIdentity
  readonly artifact: SessionFormatArtifact
  /** 只编码、校验并独占发布一次；每次调用共享同样的成功或失败结果。 */
  publish(): Promise<JsonlPhysicalIdentity>
}

/** 某个历史制品完好无损，但格式边拒绝其内容。 */
export class JsonlGenerationUnsupportedMigrationError extends Error {
  override readonly name = 'JsonlGenerationUnsupportedMigrationError'

  /**
   * @param fromVersion - 未发生变化的源代际版本。
   * @param reason - 格式边的拒绝原因。
   */
  constructor(
    readonly fromVersion: number,
    readonly reason: Error,
  ) {
    super(reason.message, { cause: reason })
  }
}

/** 某个当前代际文件名已经指向不同或无效的字节。 */
export class JsonlGenerationTargetConflictError extends Error {
  override readonly name = 'JsonlGenerationTargetConflictError'

  /**
   * @param path - 阻止了独占发布的不可变目标。
   * @param reason - 现有目标为何无法被接受。
   */
  constructor(
    readonly path: string,
    readonly reason: Error,
  ) {
    super(`current session generation already exists at "${path}": ${reason.message}`, { cause: reason })
  }
}

/** 与精确的代际字节一同捕获的 stat 身份。 */
export interface JsonlPhysicalIdentity {
  readonly dev: bigint
  readonly ino: bigint
  readonly size: bigint
  readonly mtimeNs: bigint
  readonly ctimeNs: bigint
}

/** 某个稳定文件修订的精确字节，连同证明其稳定的 stat 身份。 */
export interface StablePhysicalFile {
  readonly bytes: Buffer
  readonly identity: JsonlPhysicalIdentity
}

interface GenerationFileSystem {
  open(path: string, flags: string, mode?: number): Promise<FileHandle>
  readFile(path: string, signal?: AbortSignal): Promise<Buffer>
  readdir(path: string): Promise<string[]>
  stat(path: string): Promise<JsonlPhysicalIdentity>
  lstat(path: string): Promise<{ isFile(): boolean; isSymbolicLink(): boolean }>
  link(existingPath: string, newPath: string): Promise<void>
  rm(path: string): Promise<void>
}

type GenerationBarrierPhase =
  | 'before-source-check'
  | 'after-publication'

interface JsonlGenerationInternals {
  readonly fs: GenerationFileSystem
  readonly randomToken: () => string
  readonly platform: NodeJS.Platform
  readonly publishNewWin32: typeof publishNewFileWin32
  readonly barrier: (phase: GenerationBarrierPhase, attempt: number) => void | Promise<void>
}

/** 一个隔离代际运行时的依赖覆盖项。 */
export type JsonlGenerationRuntimeOverrides = Partial<Omit<JsonlGenerationInternals, 'fs'>> & {
  readonly fs?: Partial<GenerationFileSystem>
}

/** 供生产默认值与确定性测试使用的已绑定代际操作。 */
export interface JsonlGenerationRuntime {
  readStable(path: string, signal?: AbortSignal): Promise<StablePhysicalFile>
  prepare(options: PrepareJsonlMigrationOptions): Promise<PreparedJsonlMigration>
  verify(
    path: string,
    compression: JsonlCompression,
    expectedId: string,
    expectedEventCount: number,
    expectedPrefix?: JsonlExpectedPrefix,
  ): Promise<JsonlVerifiedGeneration>
}

const defaultFileSystem: GenerationFileSystem = {
  open: (path, flags, mode) => fsOpen(path, flags, mode),
  readFile: (path, signal) => fsReadFile(path, signal === undefined ? undefined : { signal }),
  readdir: path => fsReaddir(path),
  stat: path => fsStat(path, { bigint: true }),
  lstat: path => fsLstat(path),
  link: fsLink,
  rm: path => fsRm(path, { force: true }),
}

const defaultInternals: JsonlGenerationInternals = {
  fs: defaultFileSystem,
  randomToken: () => randomBytes(8).toString('hex'),
  platform: process.platform,
  publishNewWin32: publishNewFileWin32,
  barrier: () => {},
}

function isEEXIST(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EEXIST'
}

/** 判断一个文件系统持有的失败是否应保留其原始 errno 与路径。 */
function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof (error as NodeJS.ErrnoException | null)?.code === 'string'
}

function identity(value: JsonlPhysicalIdentity): string {
  return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(':')
}

/**
 * 以一次重试读取 JSONL 文件的一个稳定修订。如果一次追加与两次读取都重叠，
 * 则返回第二次读取在读取前已提交的前缀，而不是在持续写入者之后一直挨饿。
 * @param path - 要读取的代际文件。
 * @param signal - 可选取消信号，用于 stat/读取工作。
 * @returns 稳定的字节（或已提交的前缀）及其 stat 身份。
 */
export async function readStableJsonlFile(
  path: string,
  signal?: AbortSignal,
): Promise<StablePhysicalFile> {
  return defaultGenerationRuntime.readStable(path, signal)
}

async function readStableSnapshot(
  path: string,
  signal: AbortSignal | undefined,
  fs: GenerationFileSystem,
): Promise<StablePhysicalFile> {
  signal?.throwIfAborted()
  let before = await fs.stat(path)
  for (let attempt = 0; ; attempt += 1) {
    const bytes = await fs.readFile(path, signal)
    signal?.throwIfAborted()
    const after = await fs.stat(path)
    if (identity(before) === identity(after)) {
      signal?.throwIfAborted()
      return { bytes, identity: after }
    }
    if (attempt === 1) {
      return { bytes: bytes.subarray(0, Number(before.size)), identity: before }
    }
    before = after
  }
}

/** 解析版本判别字段，不校验任何与版本相关的字段。 */
function storedVersion(header: unknown): number {
  if (typeof header !== 'object' || header === null || Array.isArray(header)) {
    throw new Error('corrupt session log: first line is not a JSON object')
  }
  const version = (header as { version?: unknown }).version
  if (!Number.isSafeInteger(version) || (version as number) < 0 || Object.is(version, -0)) {
    throw new Error('corrupt session log: header version is not a non-negative safe integer')
  }
  return version as number
}

function parseJson(text: string, subject: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`corrupt session log: ${subject} is not valid JSON`, { cause: error })
  }
}

/** 只保留一个跨帧记录片段的增量 JSONL 解析器。 */
class MigratingJsonlRows {
  private fragments: Buffer[] = []
  private fragmentBytes = 0
  private rowIndex = 0
  private issue: Error | undefined

  constructor(private readonly restore: SessionFormatRestore) {}

  /** 消费紧跟在独立解码的头部之后的明文字节。 */
  write(chunk: Buffer): void {
    /* jscpd:ignore-start -- 迁移解析与可读日志扫描各自拥有不同的恢复与字节记账状态。 */
    let lineStart = 0
    for (
      let newline = chunk.indexOf(0x0A);
      newline !== -1;
      newline = chunk.indexOf(0x0A, lineStart)
    ) {
      const fragment = chunk.subarray(lineStart, newline)
      let line = fragment
      if (this.fragments.length > 0) {
        if (fragment.length > 0) this.fragments.push(fragment)
        line = Buffer.concat(this.fragments, this.fragmentBytes + fragment.length)
        this.fragments = []
        this.fragmentBytes = 0
      }
      this.consume(line)
      lineStart = newline + 1
    }
    if (lineStart < chunk.length) {
      const fragment = Buffer.from(chunk.subarray(lineStart))
      this.fragments.push(fragment)
      this.fragmentBytes += fragment.length
    }
    /* jscpd:ignore-end */
  }

  /** 拒绝结构上完整的 Zstandard 帧所留下的记录片段。 */
  assertCompleteFramesEndOnRecord(): void {
    if (this.fragments.length > 0) {
      throw new Error('corrupt Zstandard session log: complete frame contains a torn JSONL record')
    }
  }

  finish(): SessionFormatArtifact {
    return this.restore.finish()
  }

  private consume(line: Buffer): void {
    const index = this.rowIndex
    this.rowIndex += 1
    let row: unknown
    try {
      row = parseJson(line.toString('utf8'), `row ${index + 1}`)
    } catch (error: unknown) {
      this.issue ??= asError(error)
      return
    }
    if (this.issue !== undefined) {
      if (typeof row === 'object' && row !== null
        && (row as { type?: unknown }).type === 'turn/end') throw this.issue
      return
    }
    this.restore.decodeRow(row)
  }
}

interface StartedMigrationStream {
  readonly parser: MigratingJsonlRows
}

async function startMigrationStream(
  headerRecord: Buffer,
  sourceVersion: number,
  format: Pick<JsonlGenerationFormatAdapter, 'createRestore'>,
  validateHistoricalHeader?: PrepareJsonlMigrationOptions['validateHistoricalHeader'],
): Promise<StartedMigrationStream> {
  const value = parseJson(headerRecord.subarray(0, -1).toString('utf8'), 'header line')
  const version = storedVersion(value)
  if (version !== sourceVersion) {
    throw new Error(`resolved JSONL source filename identifies v${sourceVersion}, but its header identifies v${version}`)
  }
  const header = value as Record<string, unknown>
  const validation = validateHistoricalHeader?.(header)
  if (validation !== undefined) await validation
  const stream = format.createRestore(header)
  return { parser: new MigratingJsonlRows(stream) }
}

async function consumeMigrationBytes(
  rows: MigratingJsonlRows,
  chunks: Iterable<Buffer>,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  let yieldDeadline = performance.now() + MIGRATION_DECODE_YIELD_INTERVAL_MS
  for (const bytes of chunks) {
    for (let offset = 0; offset < bytes.length; offset += MIGRATION_WORK_CHUNK_BYTES) {
      rows.write(bytes.subarray(offset, offset + MIGRATION_WORK_CHUNK_BYTES))
      if (performance.now() < yieldDeadline) continue
      await scheduler.yield()
      signal?.throwIfAborted()
      yieldDeadline = performance.now() + MIGRATION_DECODE_YIELD_INTERVAL_MS
    }
  }
}

async function decodeStreamingMigration(
  bytes: Buffer,
  compression: JsonlCompression,
  sourceVersion: number,
  format: Pick<JsonlGenerationFormatAdapter, 'createRestore'>,
  validateHistoricalHeader: PrepareJsonlMigrationOptions['validateHistoricalHeader'],
  signal?: AbortSignal,
): Promise<SessionFormatArtifact> {
  signal?.throwIfAborted()
  if (compression === 'none') {
    const headerEnd = bytes.indexOf(0x0A)
    if (headerEnd === -1) throw new Error('empty or header-less session log')
    const stream = await startMigrationStream(
      bytes.subarray(0, headerEnd + 1),
      sourceVersion,
      format,
      validateHistoricalHeader,
    )
    signal?.throwIfAborted()
    const bodyEnd = bytes.lastIndexOf(0x0A)
    if (bodyEnd > headerEnd) {
      await consumeMigrationBytes(
        stream.parser,
        [bytes.subarray(headerEnd + 1, bodyEnd + 1)],
        signal,
      )
    }
    return stream.parser.finish()
  }

  const { frames, tornStart } = scanZstdFrames(bytes)
  if (frames.length === 0) throw new Error('empty or header-less Zstandard session log')
  const decoder = createZstdFrameDecoder()
  try {
    const decoded = decoder.decode(bytes, frames)
    const first = decoded.next()
    /* v8 ignore next -- 非空的机构化帧列表要么产出一次，要么抛出。 */
    if (first.done) throw new Error('empty or header-less Zstandard session log')
    assertIndependentHeaderFrame(first.value)
    const stream = await startMigrationStream(
      first.value,
      sourceVersion,
      format,
      validateHistoricalHeader,
    )
    signal?.throwIfAborted()
    await consumeMigrationBytes(stream.parser, decoded, signal)
    stream.parser.assertCompleteFramesEndOnRecord()
    if (tornStart !== undefined) {
      let recovered: Buffer = Buffer.alloc(0)
      try {
        recovered = await decompressZstdPrefix(bytes.subarray(tornStart))
      } catch {
        /* v8 ignore next -- 解码失败叠加并发中止取决于时序。 */
        if (signal?.aborted) signal.throwIfAborted()
      }
      signal?.throwIfAborted()
      const newline = recovered.lastIndexOf(0x0A)
      if (newline !== -1) {
        await consumeMigrationBytes(
          stream.parser,
          [recovered.subarray(0, newline + 1)],
          signal,
        )
      }
    }
    return stream.parser.finish()
  } finally {
    decoder.close()
  }
}

/**
 * 为一个隔离的校验器读取并校验一个完整的当前代际。
 * @param path - 已暂存或与之竞争的当前代际路径。
 * @param compression - 已配置的物理编码方式。
 * @param expectedId - 头部中预期的 Session 身份。
 * @param expectedEventCount - 解码之后预期的精确逻辑事件数。
 * @param expectedPrefix - 已校验的迁移前缀；可能存在追加尾部，且不会被校验。
 * @returns 用于发布比较的稳定物理身份与摘要。
 */
export async function verifyJsonlCurrentGeneration(
  path: string,
  compression: JsonlCompression,
  expectedId: string,
  expectedEventCount: number,
  expectedPrefix?: JsonlExpectedPrefix,
): Promise<JsonlVerifiedGeneration> {
  return defaultGenerationRuntime.verify(path, compression, expectedId, expectedEventCount, expectedPrefix)
}

async function verifyCurrentGeneration(
  path: string,
  compression: JsonlCompression,
  expectedId: string,
  expectedEventCount: number,
  fs: GenerationFileSystem,
  expectedPrefix?: JsonlExpectedPrefix,
): Promise<JsonlVerifiedGeneration> {
  const before = await fs.stat(path)
  const bytes = await fs.readFile(path)
  const after = await fs.stat(path)
  if (expectedPrefix !== undefined) {
    if (bytes.length < expectedPrefix.bytes) {
      throw new Error('target bytes are shorter than the migrated generation')
    }
    const digest = createHash('sha256').update(bytes.subarray(0, expectedPrefix.bytes)).digest('hex')
    if (digest !== expectedPrefix.digest) {
      throw new Error('target bytes do not begin with the migrated generation')
    }
    return { identity: after, bytes: expectedPrefix.bytes, digest }
  }
  if (identity(before) !== identity(after)) {
    throw new Error('current session generation changed during verification')
  }
  const snapshot = { bytes, identity: after }
  const generation = decodeCurrentGeneration(snapshot.bytes, compression)
  validateStoredEvents(generation.meta, generation.events, { kind: 'jsonl', path })
  if (generation.meta.id !== expectedId) {
    throw new Error(`current session generation contains id "${generation.meta.id}", expected "${expectedId}"`)
  }
  if (generation.events.length !== expectedEventCount) {
    throw new Error(
      `current session generation contains ${generation.events.length} events, expected ${expectedEventCount}`,
    )
  }
  Session.fromRestore(
    generation.meta.id,
    generation.events,
    generation.meta,
    generation.inheritedEventCount,
    'detached',
    currentSessionMessageProjections,
  )
  assertCurrentAssistantStreams(generation.events)
  return {
    identity: snapshot.identity,
    bytes: snapshot.bytes.length,
    digest: createHash('sha256').update(snapshot.bytes).digest('hex'),
  }
}

/** 只在隔离的当前代际校验中完整回放内嵌的流。 */
function assertCurrentAssistantStreams(events: readonly SessionEvent[]): void {
  for (const [index, event] of events.entries()) {
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue
    const assembler = new BlockAssembler()
    let timed: ReturnType<typeof expandAssistantStream>
    try {
      timed = expandAssistantStream(event.data.stream)
      for (const member of timed) assembler.push(member.chunk)
    } catch (error: unknown) {
      throw new Error(`seed ${event.type} at index ${index} has an invalid embedded stream`, { cause: error })
    }
    if (event.type === 'assistant/attempt' || timed.length === 0) continue
    const content = event.data.interrupted === true ? assembler.interruptedBlocks() : assembler.blocks()
    if (!isDeepStrictEqual(event.data.message.content, content)) {
      throw new Error(`seed assistant/message at index ${index} content disagrees with its embedded stream`)
    }
    if (!isDeepStrictEqual(event.data.usage, assembler.usage)) {
      throw new Error(`seed assistant/message at index ${index} usage disagrees with its embedded stream`)
    }
    if (!isDeepStrictEqual(event.data.message.source.replayState, assembler.replayState)) {
      throw new Error(`seed assistant/message at index ${index} replay state disagrees with its embedded stream`)
    }
  }
}

function decodeCurrentGeneration(
  bytes: Buffer,
  compression: JsonlCompression,
): ReturnType<SessionLogScanner['finish']> {
  if (compression === 'none') {
    const headerEnd = bytes.indexOf(0x0A)
    if (headerEnd === -1) throw new Error('empty or header-less session log')
    const scanner = new SessionLogScanner(bytes.subarray(0, headerEnd + 1), 'strict')
    scanner.write(bytes.subarray(headerEnd + 1))
    return finishCurrentGenerationScan(scanner)
  }
  const { frames, tornStart } = scanZstdFrames(bytes)
  if (frames.length === 0) throw new Error('empty or header-less Zstandard session log')
  if (tornStart !== undefined) throw new Error('current session generation has a torn physical tail')
  const decoder = createZstdFrameDecoder()
  try {
    const plaintext = decoder.decode(bytes, frames)
    const header = plaintext.next()
    /* v8 ignore next -- 非空的机构化帧列表要么产出一次，要么抛出。 */
    if (header.done) throw new Error('empty or header-less Zstandard session log')
    assertIndependentHeaderFrame(header.value)
    const scanner = new SessionLogScanner(header.value, 'strict')
    for (const chunk of plaintext) scanner.write(chunk)
    return finishCurrentGenerationScan(scanner)
  } finally {
    decoder.close()
  }
}

function finishCurrentGenerationScan(
  scanner: SessionLogScanner,
): ReturnType<SessionLogScanner['finish']> {
  const inputBytes = scanner.checkpoint().inputBytes
  const decoded = scanner.finish()
  if (decoded.committedBytes !== inputBytes) throw new Error('current session generation has a torn physical tail')
  return decoded
}

function stringifyJson(value: unknown, subject: string): string {
  let text: unknown
  try {
    text = JSON.stringify(value)
  } catch (error) {
    throw new Error(`${subject} is not lossless JSON`, { cause: error })
  }
  if (typeof text !== 'string') throw new Error(`${subject} is not lossless JSON`)
  return text
}

function assertIndependentHeaderFrame(plaintext: Buffer): void {
  if (plaintext.length === 0 || plaintext.indexOf(0x0A) !== plaintext.length - 1) {
    throw new Error('corrupt Zstandard session log: first frame is not exactly one header line')
  }
}

function assertGenerationPaths(
  sourcePath: string,
  sourceVersion: number,
  currentPath: string,
  currentVersion: number,
  compression: JsonlCompression,
): string {
  const expectedSource = generationLogFilename(sourceVersion, compression)
  const expectedCurrent = generationLogFilename(currentVersion, compression)
  if (basename(sourcePath) !== expectedSource) {
    throw new Error(`resolved JSONL source path must end with "${expectedSource}": ${sourcePath}`)
  }
  if (basename(currentPath) !== expectedCurrent) {
    throw new Error(`current JSONL generation path must end with "${expectedCurrent}": ${currentPath}`)
  }
  if (dirname(sourcePath) !== dirname(currentPath)) {
    throw new Error('source and current JSONL generations must share one Session directory')
  }
  return logSuffix(compression)
}

async function syncDirectory(path: string, internals: JsonlGenerationInternals): Promise<void> {
  /* v8 ignore next -- Windows 命名空间操作直接请求直写。 */
  if (internals.platform === 'win32') return
  const handle = await internals.fs.open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

interface StreamedMigrationStage {
  readonly path: string
  readonly bytes: number
  readonly digest: string
}

/** 在主线程编码切片之间让出控制权的同时，产出有界的 JSONL 块。 */
async function* encodeMigrationRows(
  artifact: SessionFormatArtifact,
  format: JsonlGenerationFormatAdapter,
  signal?: AbortSignal,
): AsyncGenerator<Buffer, void, void> {
  signal?.throwIfAborted()
  let lines: string[] = []
  let bytes = 0
  for (const value of artifact.events) {
    const line = `${stringifyJson(format.encodeEvent(value), `migrated Session event ${value.seq}`)}\n`
    const lineBytes = Buffer.byteLength(line)
    if (bytes > 0 && bytes + lineBytes > MIGRATION_WORK_CHUNK_BYTES) {
      yield Buffer.from(lines.join(''))
      await scheduler.yield()
      signal?.throwIfAborted()
      lines = []
      bytes = 0
    }
    lines.push(line)
    bytes += lineBytes
  }
  yield Buffer.from(lines.join(''))
}

async function writeMigrationChunks(
  chunks: AsyncIterable<Buffer>,
  write: (chunk: Buffer) => Promise<void>,
): Promise<void> {
  let pending: Buffer[] = []
  let bytes = 0
  for await (const chunk of chunks) {
    pending.push(chunk)
    bytes += chunk.length
    if (bytes < MIGRATION_WRITE_CHUNK_BYTES) continue
    await write(pending.length === 1 ? pending[0] as Buffer : Buffer.concat(pending, bytes))
    pending = []
    bytes = 0
  }
  if (bytes > 0) await write(pending.length === 1 ? pending[0] as Buffer : Buffer.concat(pending, bytes))
}

/** 直接编码到一个已同步的暂存文件中，无需整个制品的行缓冲区或字节缓冲区。 */
async function writeSyncedTemp(
  currentPath: string,
  suffix: string,
  compression: JsonlCompression,
  artifact: SessionFormatArtifact,
  format: JsonlGenerationFormatAdapter,
  signal: AbortSignal | undefined,
  internals: JsonlGenerationInternals,
): Promise<StreamedMigrationStage> {
  signal?.throwIfAborted()
  let path: string
  let handle: FileHandle
  for (;;) {
    path = join(dirname(currentPath), `session.migration.${internals.randomToken()}${suffix}.tmp`)
    try {
      handle = await internals.fs.open(path, 'wx', 0o600)
      break
    } catch (error) {
      if (isEEXIST(error)) continue
      throw error
    }
  }
  const hash = createHash('sha256')
  let bytes = 0
  const write = async (chunk: Buffer): Promise<void> => {
    await handle.writeFile(chunk)
    hash.update(chunk)
    bytes += chunk.length
  }
  let failure: unknown
  try {
    const headerValue = format.encodeHeader(artifact.header, artifact.inheritedEventCount)
    const header = Buffer.from(`${stringifyJson(headerValue, 'migrated session header')}\n`)
    await write(compression === 'zstd' ? await compressZstdFrame(header) : header)
    if (artifact.events.length > 0) {
      const rows = encodeMigrationRows(artifact, format, signal)
      if (compression === 'none') {
        await writeMigrationChunks(rows, write)
      } else {
        await new Promise<void>((resolve, reject) => {
          pipeline(
            Readable.from(rows, { objectMode: false, highWaterMark: MIGRATION_WORK_CHUNK_BYTES }),
            createZstdCompress(ZSTD_CHECKSUM_OPTIONS),
            async (source) => { await writeMigrationChunks(source as AsyncIterable<Buffer>, write) },
            (error: Error | null | undefined) => {
              if (error instanceof Error) reject(error)
              else resolve()
            },
          )
        })
      }
    }
    signal?.throwIfAborted()
    await handle.sync()
  } catch (error: unknown) {
    failure = error
  }
  try {
    await handle.close()
  } catch (error: unknown) {
    failure = failure === undefined
      ? error
      : new AggregateError([failure, error], `failed to write and close migration stage "${path}"`)
  }
  if (failure !== undefined) {
    const writeError = failure instanceof Error
      ? failure
      : new Error('migration stage write failed with a non-Error rejection', { cause: failure })
    await removeTemporary(path, writeError, internals)
    throw writeError
  }
  return { path, bytes, digest: hash.digest('hex') }
}

/** 删除一个临时文件，但不掩盖使它变为可丢弃的那次操作失败。 */
async function removeTemporary(
  path: string,
  primaryFailure: unknown,
  internals: JsonlGenerationInternals,
): Promise<void> {
  try {
    await internals.fs.rm(path)
  } catch (cleanupFailure: unknown) {
    throw new AggregateError(
      [primaryFailure, cleanupFailure],
      `failed to clean migration temporary "${path}" after an earlier failure`,
    )
  }
}

/** 在目标已被校验为已提交之后删除一个多余的暂存文件。 */
async function removeCommittedTemporary(
  path: string,
  internals: JsonlGenerationInternals,
): Promise<void> {
  try {
    await internals.fs.rm(path)
  } catch {
    // 已校验的目标持有已提交的字节；多余的链接不能把成功变成失败。
  }
}

async function publishCurrentExclusive(
  staged: string,
  currentPath: string,
  internals: JsonlGenerationInternals,
): Promise<boolean> {
  if (internals.platform === 'win32') {
    try {
      await internals.publishNewWin32(staged, currentPath)
      return true
    } catch (error) {
      /* v8 ignore else -- 原生辅助函数的测试负责非冲突的 Win32 失败。 */
      if (isEEXIST(error)) return false
      /* v8 ignore next -- 文件系统错误本身已经完整。 */
      throw error
    }
  }
  try {
    await internals.fs.link(staged, currentPath)
  } catch (error) {
    /* v8 ignore else -- 非冲突的文件系统错误原样向上传播。 */
    if (isEEXIST(error)) return false
    /* v8 ignore next -- 文件系统错误本身已经完整。 */
    throw error
  }
  await syncDirectory(dirname(currentPath), internals)
  return true
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('current-generation validation failed with a non-Error rejection', {
    cause: error,
  })
}

async function inspectExpectedCurrent<T>(
  currentPath: string,
  internals: JsonlGenerationInternals,
  inspect: () => Promise<T>,
): Promise<T> {
  try {
    const expectedName = basename(currentPath)
    const names = await internals.fs.readdir(dirname(currentPath))
    if (!names.includes(expectedName)) {
      const noncanonical = names.find(name => name.toLowerCase() === expectedName.toLowerCase())
      if (noncanonical !== undefined) {
        throw new Error(`target resolves to noncanonical directory entry "${noncanonical}"`)
      }
    }
    const info = await internals.fs.lstat(currentPath)
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`target is a ${info.isSymbolicLink() ? 'symbolic link' : 'non-regular file'}`)
    }
    return await inspect()
  } catch (error: unknown) {
    if (isErrnoException(error)) throw error
    throw new JsonlGenerationTargetConflictError(currentPath, asError(error))
  }
}

function withOverrides(overrides: JsonlGenerationRuntimeOverrides): JsonlGenerationInternals {
  return {
    ...defaultInternals,
    ...overrides,
    fs: { ...defaultFileSystem, ...overrides.fs },
  }
}

async function publishPreparedMigration(
  options: PrepareJsonlMigrationOptions,
  suffix: string,
  artifact: SessionFormatArtifact,
  sourceIdentity: JsonlPhysicalIdentity,
  internals: JsonlGenerationInternals,
): Promise<JsonlPhysicalIdentity> {
  await scheduler.yield()
  const { sourcePath, currentPath, compression, verifyCurrentFile } = options
  const eventCount = artifact.events.length
  let staged = await writeSyncedTemp(currentPath, suffix, compression, artifact, options.format, undefined, internals)
  try {
    const verifiedStage = await verifyCurrentFile(
      staged.path,
      compression,
      artifact.header.id,
      eventCount,
    )
    if (verifiedStage.bytes !== staged.bytes || verifiedStage.digest !== staged.digest) {
      throw new Error('staged session generation changed during verification')
    }
    await internals.barrier('before-source-check', 1)
    await options.validateRelatedSources?.()
    const beforePublish = await internals.fs.stat(sourcePath)
    if (identity(beforePublish) !== identity(sourceIdentity)) {
      throw new JsonlGenerationSourceChangedError(sourcePath)
    }
    const published = await publishCurrentExclusive(staged.path, currentPath, internals)
    if (published && internals.platform === 'win32') staged = { ...staged, path: '' }
    await internals.barrier('after-publication', 1)
    let currentIdentity: JsonlPhysicalIdentity
    if (published) {
      if (staged.path !== '') {
        await removeCommittedTemporary(staged.path, internals)
        staged = { ...staged, path: '' }
      }
      currentIdentity = await internals.fs.stat(currentPath)
    } else {
      const winner = await inspectExpectedCurrent(currentPath, internals, async () => {
        const candidate = await verifyCurrentFile(
          currentPath,
          compression,
          artifact.header.id,
          eventCount,
          staged,
        )
        if (candidate.bytes !== staged.bytes || candidate.digest !== staged.digest) {
          throw new Error('target bytes differ from the migrated generation')
        }
        return candidate
      })
      currentIdentity = winner.identity
      await removeCommittedTemporary(staged.path, internals)
      staged = { ...staged, path: '' }
    }
    return currentIdentity
  } catch (error: unknown) {
    if (staged.path !== '') await removeTemporary(staged.path, error, internals)
    throw error
  }
}

async function prepareMigration(
  options: PrepareJsonlMigrationOptions,
  internals: JsonlGenerationInternals,
): Promise<PreparedJsonlMigration> {
  const { sourcePath, sourceVersion, currentPath, compression, format, signal } = options
  const suffix = assertGenerationPaths(
    sourcePath,
    sourceVersion,
    currentPath,
    format.currentVersion,
    compression,
  )
  if (sourceVersion >= format.currentVersion) {
    throw new Error(`migration preparation requires a historical source, got v${sourceVersion}`)
  }
  const source = await readStableSnapshot(sourcePath, signal, internals.fs)
  let artifact: SessionFormatArtifact
  try {
    artifact = await decodeStreamingMigration(
      source.bytes,
      compression,
      sourceVersion,
      format,
      options.validateHistoricalHeader,
      signal,
    )
  } catch (error: unknown) {
    if (format.isUnsupportedMigrationError?.(error) === true) {
      throw new JsonlGenerationUnsupportedMigrationError(sourceVersion, error)
    }
    throw error
  }
  if (artifact.header.version !== format.currentVersion) {
    throw new Error(`format migration returned v${artifact.header.version}, expected v${format.currentVersion}`)
  }
  await options.validateRelatedSources?.()
  const sourceIdentity = source.identity
  let publication: Promise<JsonlPhysicalIdentity> | undefined
  return {
    sourceIdentity,
    artifact,
    publish() {
      if (publication === undefined) {
        publication = publishPreparedMigration(
          options,
          suffix,
          artifact,
          sourceIdentity,
          internals,
        )
      }
      return publication
    },
  }
}

/**
 * 解码并迁移一个历史代际，但不写入其后继者。
 * @param options - 已解析的源、当前目标、格式适配器与加载取消信号。
 * @returns 当前制品，以及一个幂等的显式发布操作。
 */
export function prepareJsonlMigration(
  options: PrepareJsonlMigrationOptions,
): Promise<PreparedJsonlMigration> {
  return defaultGenerationRuntime.prepare(options)
}

/**
 * 创建一个文件系统与发布依赖均已固定的代际运行时。
 * @param overrides - 确定性的文件系统、平台与竞态依赖。
 * @returns 已绑定的代际操作。
 */
export function createJsonlGenerationRuntime(
  overrides: JsonlGenerationRuntimeOverrides = {},
): JsonlGenerationRuntime {
  const internals = withOverrides(overrides)
  return {
    readStable: (path, signal) => readStableSnapshot(path, signal, internals.fs),
    prepare: options => prepareMigration(options, internals),
    verify: (path, compression, expectedId, expectedEventCount, expectedPrefix) => verifyCurrentGeneration(
      path, compression, expectedId, expectedEventCount, internals.fs, expectedPrefix,
    ),
  }
}

const defaultGenerationRuntime = createJsonlGenerationRuntime()

/**
 * 通过共享的流式解析器读取一个稳定源，不发布任何代际。
 * @param path - 所选的源代际路径。
 * @param version - 由文件名标识的物理源版本。
 * @param compression - 源编码方式。
 * @param format - 编解码器/恢复工厂，与当前代际发布无关。
 * @param signal - 在源读取与解码让出期间被观测的取消信号。
 * @returns 已解码的制品与物理源身份，供之后重新校验。
 * @throws SessionFormatError 物理解码失败时抛出；存储类、取消类与不受支持的迁移错误保留其原有类别。
 */
export async function readDecodedJsonlSource(
  path: string,
  version: number,
  compression: JsonlCompression,
  format: Pick<JsonlGenerationFormatAdapter, 'createRestore'>,
  signal?: AbortSignal,
): Promise<{ artifact: SessionFormatArtifact; identity: JsonlPhysicalIdentity }> {
  const source = await readStableJsonlFile(path, signal)
  let artifact: SessionFormatArtifact
  try {
    artifact = await decodeStreamingMigration(source.bytes, compression, version, format, undefined, signal)
  } catch (error: unknown) {
    if (signal?.aborted || error instanceof SessionFormatError) throw error
    throw new SessionFormatError(String(error), { cause: error })
  }
  return { artifact, identity: source.identity }
}
