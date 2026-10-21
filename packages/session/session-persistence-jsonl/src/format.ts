/**
 * JSONL session-persistence 后端的磁盘格式辅助函数：路径净化
 * （{@link SessionId} 是未经校验的带品牌字符串，因此在用于路径之前
 * 必须编码——既不能目录穿越，也不能冲突）、按项目/会话划分的目录布局、
 * 头部行的（反）序列化，以及截断修复偏移的计算。
 *
 * @module dsh-session-persistence-jsonl/format
 */

import { isAbsolute, join } from 'node:path'
import {
  SESSION_FORMAT_VERSION,
  KNOWN_SESSION_EVENT_TYPES,
  SessionLogOffset,
} from '@deepseek-ai/dsh-session'
import type {
  SessionEvent,
  SessionHeader,
  SessionId,
  SessionLogOffset as SessionLogOffsetType,
} from '@deepseek-ai/dsh-session'
import { parseSessionFormatLogFilename, sessionFormatLogFilename, SessionFormatUnsupportedMigrationError } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatRecovery, SessionFormatRestore } from '@deepseek-ai/dsh-session-format'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { assertV4RowAdmission, assertReleasedV4Relationships } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import {
  SessionFormatUnsupportedError,
  sessionFormatVersionRefusal,
  type SessionStorageMetadata,
} from '@deepseek-ai/dsh-session-persistence'

/** 为 JSONL 会话制品选定的物理编码方式。 */
export type JsonlCompression = 'zstd' | 'none'

/**
 * 返回某种物理编码对应的制品后缀。
 * @param compression - 已配置的 JSONL 制品编码方式。
 * @returns Zstandard 为 `.jsonl.zstd`，明文为 `.jsonl`。
 */
export function logSuffix(compression: JsonlCompression): '.jsonl.zstd' | '.jsonl' {
  return `.jsonl${compressionSuffix(compression)}`
}

function compressionSuffix(compression: JsonlCompression): '.zstd' | '' {
  return compression === 'zstd' ? '.zstd' : ''
}

/**
 * 返回某个不可变 Session 格式代际的规范文件名。版本零沿用最初只有后缀的
 * 名字；之后的每个代际都带有小写的数字 `vN` 部分。
 * @param version - 非负且安全的 Session 格式版本。
 * @param compression - 已配置的 JSONL 制品编码方式。
 * @returns 某个 Session 目录内的代际文件名。
 */
export function generationLogFilename(version: number, compression: JsonlCompression): string {
  return `${sessionFormatLogFilename(version)}${compressionSuffix(compression)}`
}

/**
 * 针对选定的物理编码解析一个规范的代际文件名。不规范的名字、临时名字、
 * 大写形式、带前导零以及带版本零标记的名字都不能标识已提交的代际。
 * @param filename - 来自 Session 目录的一个条目。
 * @param compression - 已配置的 JSONL 制品编码方式。
 * @returns 其格式版本；名字不规范时为 `undefined`。
 */
export function parseGenerationLogFilename(
  filename: string,
  compression: JsonlCompression,
): number | undefined {
  const suffix = compressionSuffix(compression)
  if (!filename.endsWith(suffix)) return undefined
  return parseSessionFormatLogFilename(filename.slice(0, filename.length - suffix.length))
}

/**
 * 作为首条 JSONL 记录存储的当前物理头部。精确的继承切点位于最后一个
 * 带标记的 `session/end-seed` 事件上。
 */
interface HeaderLine {
  type: 'session'
  version: number
  id: SessionId
  createdAt: number
  cwd?: string
  parentSession?: SessionId
  isSeeded: boolean
  origin?: 'subagent'
  delegationDepth: number
  agentPreset?: string
}

const HEADER_REQUIRED_KEYS = ['type', 'version', 'id', 'createdAt', 'isSeeded', 'delegationDepth'] as const
const HEADER_OPTIONAL_KEYS = ['cwd', 'parentSession', 'origin', 'agentPreset'] as const
const HEADER_KEYS = new Set<string>([...HEADER_REQUIRED_KEYS, ...HEADER_OPTIONAL_KEYS])

/**
 * 拒绝那些从不属于已发布 Session 头部的策略字段。
 * @param value - 已解析的物理头部候选值。
 * @returns 校验成功时不返回内容。
 */
export function assertNoRetiredHeaderFields(value: unknown): void {
  if (typeof value !== 'object' || value === null) return
  if (Object.hasOwn(value, 'sandboxMode') || Object.hasOwn(value, 'approvalPolicy')) {
    throw new Error('session header uses retired policy baseline fields')
  }
}

/**
 * 从 {@link SessionHeader} 构造头部行对象。
 * @param header - 要序列化的不可变会话元数据。
 * @param inheritedEventCount - 精确的继承前缀长度；对已播种的头部是必需的，
 * 只有未播种的头部才可以省略。
 * @returns 带 `type: 'session'` 标记的行对象，缺失的可选字段被省略（绝不为 null）。
 */
export function toHeaderLine(
  header: SessionHeader,
  inheritedEventCount?: SessionLogOffsetType,
): HeaderLine {
  if (header.isSeeded && inheritedEventCount === undefined) {
    throw new Error('seeded session header requires an inherited event count')
  }
  const cut = SessionLogOffset(inheritedEventCount ?? 0)
  if (!header.isSeeded && cut !== 0) {
    throw new Error('unseeded session header inherited event count must be 0')
  }
  return sessionFormatCatalog.encodeCurrentHeader({
    ...header,
    delegationDepth: header.delegationDepth ?? 0,
  }, cut) as unknown as HeaderLine
}

/**
 * 将一个当前物理头部翻译为逻辑元数据及其切点。
 * @param line - 日志中已通过形状检查的首行（参见 `isHeaderLine` 守卫）。
 * @returns 与精确继承前缀长度配对的逻辑 Session 元数据。
 */
function fromHeaderLine(line: HeaderLine): SessionStorageMetadata {
  return {
    meta: {
      version: SESSION_FORMAT_VERSION,
      id: line.id,
      createdAt: line.createdAt,
      ...line.cwd !== undefined ? { cwd: line.cwd } : {},
      ...line.parentSession !== undefined ? { parentSession: line.parentSession } : {},
      isSeeded: line.isSeeded,
      ...line.origin !== undefined ? { origin: line.origin } : {},
      delegationDepth: line.delegationDepth,
      ...line.agentPreset !== undefined ? { agentPreset: line.agentPreset } : {},
    },
    inheritedEventCount: SessionLogOffset(0),
  }
}

/** 类型守卫：已解析的首行是一个格式良好的会话头部。 */
function isHeaderLine(value: unknown): value is HeaderLine {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value)
    && HEADER_REQUIRED_KEYS.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => HEADER_KEYS.has(key))
    && (value as { type?: unknown }).type === 'session'
    && typeof (value as { version?: unknown }).version === 'number'
    && typeof (value as { id?: unknown }).id === 'string'
    && typeof (value as { createdAt?: unknown }).createdAt === 'number'
    && Number.isSafeInteger((value as { createdAt: number }).createdAt)
    && (value as { createdAt: number }).createdAt >= 0
    && !Object.is((value as { createdAt: number }).createdAt, -0)
    && typeof (value as { delegationDepth?: unknown }).delegationDepth === 'number'
    && Number.isSafeInteger((value as { delegationDepth: number }).delegationDepth)
    && (value as { delegationDepth: number }).delegationDepth >= 0
    && !Object.is((value as { delegationDepth: number }).delegationDepth, -0)
    && ((value as { cwd?: unknown }).cwd === undefined
      || (typeof (value as { cwd?: unknown }).cwd === 'string'
        && isAbsolute((value as { cwd: string }).cwd)))
    && ((value as { parentSession?: unknown }).parentSession === undefined
      || typeof (value as { parentSession?: unknown }).parentSession === 'string')
    && typeof (value as { isSeeded?: unknown }).isSeeded === 'boolean'
    && ((value as { origin?: unknown }).origin === undefined
      || (value as { origin?: unknown }).origin === 'subagent')
    && ((value as { agentPreset?: unknown }).agentPreset === undefined
      || typeof (value as { agentPreset?: unknown }).agentPreset === 'string')
  )
}

/**
 * 将任意字符串编码为单个安全的路径段，对全部 JS（UTF-16）字符串——包括
 * 孤立代理项——都是单射的。{@link SessionId} 是未经校验的带品牌字符串，
 * 因此该编码会在任何文件系统使用之前中和 `../`、绝对路径、NUL 与分隔符。
 * 安全的码元保持字面形式；其它所有码元，包括 `~`，都变成 `~XXXX`。
 * 以码元为单位操作可以保留孤立代理项，而对 `.` 和 `..` 做特殊处理则可防止
 * 一个整体安全却仍会造成穿越的路径段。
 *
 * @param raw - 待编码的字符串；必须非空（传入 `''` 会抛出）。
 * @returns 转义后的单个路径段，可解码回 `raw`。
 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch
    } else {
      out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
    }
  }
  return out
}

/**
 * 为一个项目路径构造可读的目录键。文件系统分隔符与驱动器分隔符变成 `-`；
 * 不安全的码元使用与会话 id 相同的 `~XXXX` 转义。该键受文件系统组件长度
 * 限制而有界。分隔符替换与截断是有意有损的，遵循常见的人类可导航
 * 项目目录约定。
 * @param cwd - 会话的项目目录。
 * @returns 单个对文件系统安全的项目目录名。
 */
export function projectKey(cwd: string): string {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/**
 * 已配置根目录下人类可导航的项目目录。已配置的根目录可以是本地的，
 * 也可以是共享的；这种分组方式并不规定其部署形态。
 * @param root - 后端的会话根目录。
 * @param cwd - 会话的项目目录；`undefined` 会选择 `_no-cwd`。
 * @returns 位于 `root` 之下的项目目录路径。
 */
export function projectDir(root: string, cwd: string | undefined): string {
  if (cwd === undefined) return join(root, '_no-cwd')
  return join(root, projectKey(cwd))
}

/**
 * 由某个会话拥有的目录，可供未来的会话局部制品使用。
 * @param root - 后端的会话根目录。
 * @param cwd - 会话的项目目录。
 * @param id - 会话 id，被编码为单个安全路径段。
 * @returns 位于其项目目录之下的会话目录。
 */
export function sessionDir(root: string, cwd: string | undefined, id: SessionId): string {
  return join(projectDir(root, cwd), encodeSegment(id))
}

/**
 * 构造一个不可变 Session 格式代际的路径。
 * @param root - 后端的会话根目录。
 * @param cwd - 会话的项目目录（`undefined` → `_no-cwd`）。
 * @param id - 会话 id，在用于文件系统之前经 {@link encodeSegment} 做路径编码。
 * @param version - 物理 Session 格式代际。
 * @param compression - 物理制品编码方式及文件名后缀。
 * @returns 所选代际已配置的 JSONL 制品路径。
 */
export function generationLogPath(
  root: string,
  cwd: string | undefined,
  id: SessionId,
  version: number,
  compression: JsonlCompression,
): string {
  return join(sessionDir(root, cwd, id), generationLogFilename(version, compression))
}

/**
 * 构造某个 Session 当前代际的追加目标路径。
 * @param root - 后端的会话根目录。
 * @param cwd - 会话的项目目录（`undefined` → `_no-cwd`）。
 * @param id - 会话 id，在用于文件系统之前经 {@link encodeSegment} 做路径编码。
 * @param compression - 物理制品编码方式及文件名后缀。
 * @returns 当前 Session 格式代际的路径。
 */
export function logPath(
  root: string,
  cwd: string | undefined,
  id: SessionId,
  compression: JsonlCompression,
): string {
  return generationLogPath(root, cwd, id, SESSION_FORMAT_VERSION, compression)
}

/**
 * 将一批当前事件序列化为 JSONL 行（不含结尾换行）。紧凑的 Assistant 流是
 * 嵌套的事件数据；每个事件占一行。
 * @param events - 要序列化的批次，按日志顺序。
 * @returns 该批次的 JSONL 文本；写入者负责添加最后的换行。
 */
export function eventLines(events: readonly SessionEvent[]): string {
  return events.map(eventLine).join('\n')
}

/**
 * 将一个当前事件序列化为一条不含结尾换行的 JSONL 记录。
 * @param event - 要编码的当前事件。
 * @returns 一条物理 JSON 记录。
 */
export function eventLine(event: SessionEvent): string {
  return JSON.stringify(sessionFormatCatalog.encodeCurrentEvent(event as unknown as SessionFormatEvent))
}

interface SessionLogScan {
  meta: SessionHeader
  inheritedEventCount: SessionLogOffsetType
  events: SessionEvent[]
  committedBytes: number
}

/**
 * 在校验当前头部形状或解码任何事件行之前，就拒绝带有本构建不读取的格式版本
 * 的头部：未来的格式根本不必满足本构建的结构性检查，而其用户必须看到
 * “升级 harness”，而绝不是“会话日志已损坏”。
 * @param parsed - 会话制品首行的 JSON 解析结果。
 */
function refuseForeignFormatVersion(parsed: object): void {
  const { version, id } = parsed as { version?: unknown; id?: unknown }
  if (typeof version !== 'number' || version === SESSION_FORMAT_VERSION) return
  throw new SessionFormatUnsupportedError(
    sessionFormatVersionRefusal(typeof id === 'string' ? id : String(id), version),
  )
}

/** 解析一条与事件行分开独立提供的完整头部记录。 */
function parseHeaderRecord(record: Buffer): { readonly meta: SessionHeader; readonly restore: SessionFormatRestore } {
  if (record.length === 0 || record.at(-1) !== 0x0A || record.indexOf(0x0A) !== record.length - 1) {
    throw new Error('empty or header-less session log')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(record.subarray(0, -1).toString('utf8'))
  } catch {
    throw new Error('corrupt session log: header line is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('corrupt session log: first line is not a JSON object')
  }
  refuseForeignFormatVersion(parsed)
  assertNoRetiredHeaderFields(parsed)
  if (!isHeaderLine(parsed)) {
    throw new Error('corrupt session log: first line is not a session header')
  }
  let restore: SessionFormatRestore
  try {
    restore = sessionFormatCatalog.createRestore(parsed, {
      recovery: 'strict',
      validation: 'transformed',
    })
  } catch {
    /* v8 ignore next -- isHeaderLine 与当前编解码器一致；若其收紧，这里仍保留原有分类。 */
    throw new Error('corrupt session log: first line is not a session header')
  }
  return { meta: fromHeaderLine(parsed).meta, restore }
}

/**
 * 在一条独立提供的头部记录之后，增量扫描完整的 JSONL 事件记录。换行查找与
 * 字节偏移都停留在原始缓冲区上；只有完整的记录才被解码为 UTF-8。跨越多次
 * 写入的片段会被复制，因为解码器可能在 `write()` 返回之后复用其输出缓冲区。
 */
export class SessionLogScanner {
  private readonly meta: SessionHeader
  private readonly restore: SessionFormatRestore
  private eventCount = 0
  private fragments: Buffer[] = []
  private fragmentBytes = 0
  private inputBytes: number
  private committedBytes: number
  private eventLine = 0
  private issue: Error | undefined
  private finished = false

  /**
   * 从恰好一条以换行结尾的头部记录创建事件扫描器。
   * @param headerRecord - 完整的首条 JSONL 记录，含其换行符。
   */
  constructor(
    headerRecord: Buffer,
    private readonly recovery: SessionFormatRecovery = 'recoverable',
  ) {
    const parsed = parseHeaderRecord(headerRecord)
    this.meta = parsed.meta
    this.restore = parsed.restore
    this.inputBytes = headerRecord.length
    this.committedBytes = headerRecord.length
  }

  /**
   * 消费下一段原始明文字节，只保留一条不完整的末尾记录。
   * @param chunk - 紧接此前已提供的全部字节之后的字节。
   */
  write(chunk: Buffer): void {
    if (this.finished) throw new Error('cannot write to a finished session log scanner')
    const chunkStart = this.inputBytes
    this.inputBytes += chunk.length
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
      this.consumeEventLine(line, chunkStart + newline + 1)
      lineStart = newline + 1
    }
    if (lineStart < chunk.length) {
      const fragment = Buffer.from(chunk.subarray(lineStart))
      this.fragments.push(fragment)
      this.fragmentBytes += fragment.length
    }
  }

  /**
   * 在追加一个可恢复的撕裂帧前缀之前快照进度。
   * @returns 字节、已提交前缀与已展开事件的游标。
   */
  checkpoint(): {
    inputBytes: number
    committedBytes: number
    eventCount: SessionLogOffsetType
  } {
    return {
      inputBytes: this.inputBytes,
      committedBytes: this.committedBytes,
      eventCount: SessionLogOffset(this.eventCount),
    }
  }

  /**
   * 结束扫描，把末尾没有换行的记录当作撕裂尾部而忽略。
   * @returns 头部、连续的事件前缀，以及安全的截断偏移。
   */
  finish(): SessionLogScan {
    this.finished = true
    const artifact = this.restore.finish()
    assertReleasedV4Relationships(artifact, KNOWN_SESSION_EVENT_TYPES)
    return {
      meta: this.meta,
      inheritedEventCount: SessionLogOffset(artifact.inheritedEventCount),
      events: artifact.events as unknown as SessionEvent[],
      committedBytes: this.committedBytes,
    }
  }

  /** 解码一条完整事件行并更新连续前缀。 */
  private consumeEventLine(line: Buffer, endByte: number): void {
    this.eventLine += 1
    let decoded: unknown
    try {
      decoded = JSON.parse(line.toString('utf8')) as unknown
    } catch {
      const issue = new Error(`corrupt session log: unparsable committed event at line ${this.eventLine}`)
      if (this.recovery === 'strict') throw issue
      this.issue ??= issue
      return
    }

    // 本扫描器只接受当前代际的文件。自有结构性拒绝必须先于其可恢复尾部的
    // 抑制，且不依赖于严格解码器的状态。
    try {
      assertV4RowAdmission(decoded, KNOWN_SESSION_EVENT_TYPES)
    } catch (error: unknown) {
      if (error instanceof SessionFormatUnsupportedMigrationError) throw new SessionFormatUnsupportedError(error.message)
      throw error
    }

    if (this.issue !== undefined) {
      if (typeof decoded === 'object' && decoded !== null
        && (decoded as { type?: unknown }).type === 'turn/end') throw this.issue
      return
    }
    try {
      this.restore.decodeRow(decoded)
    } catch (error: unknown) {
      // 不受支持的当前格式行已在恢复之前被拒绝。
      /* v8 ignore next -- 每个生产环境的 Session 格式解码器都以 Error 拒绝。 */
      const detail = error instanceof Error ? error.message : String(error)
      const issue = new Error(`corrupt session log: invalid committed event at line ${this.eventLine}: ${detail}`, {
        cause: error,
      })
      if (this.recovery === 'strict') throw issue
      this.issue = issue
      if (typeof decoded === 'object' && decoded !== null
        && (decoded as { type?: unknown }).type === 'turn/end') throw issue
      return
    }
    this.eventCount += 1
    this.committedBytes = endByte
  }
}

/**
 * 将完整或撕裂的 JSONL 缓冲区解析为其中被保留的事件前缀。这个兼容性包装
 * 会单独提供首条记录，然后把事件行委托给 {@link SessionLogScanner}。
 *
 * @param buffer - 日志文件的原始字节（头部行在最前）。
 * @returns 头部、被保留的事件前缀，以及可安全追加的字节偏移。
 */
export function scanLog(buffer: Buffer): SessionLogScan {
  const headerEnd = buffer.indexOf(0x0A)
  if (headerEnd === -1) throw new Error('empty or header-less session log')
  const scanner = new SessionLogScanner(buffer.subarray(0, headerEnd + 1))
  scanner.write(buffer.subarray(headerEnd + 1))
  return scanner.finish()
}
