/**
 * JSONL 持久化 session-persistence 后端。它把头部与连续事件存放在每个会话
 * 一个目录下的不可变代际文件中，并提供基于句柄的 `SessionPersistence` API：
 * `create`/`open` 返回按会话划分的句柄，且每次读取都校验同一套失败关闭的
 * 存储契约。
 * @module @deepseek-ai/dsh-session-persistence-jsonl
 */

import { Context, type Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  createSessionFormatCatalogWithChildren,
  SessionFormatUnsupportedMigrationError,
  sessionFormatCatalog,
} from '@deepseek-ai/dsh-session-format-catalog'
import { readdirSync, type Dirent } from 'node:fs'
import { open, mkdir, readdir, realpath, link, rm, stat, truncate } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { scheduler } from 'node:timers/promises'
import { createHash, randomBytes } from 'node:crypto'
import pLimit, { type LimitFunction } from 'p-limit'
import {
  SessionPersistence, SessionPersistenceRevision, SessionFormatUnsupportedError,
  SessionPersistenceCorruptionError,
  SessionAlreadyExistsError, SessionPersistenceNotFoundError,
  assertStoredId, materializeCreateHeader, sessionFormatVersionRefusal, validateStoredEvents,
  type SessionAccess, type SessionHandle,
  type SessionHandleReadResult,
  type SessionLocation, type SessionPersistenceCreateOptions,
  type SessionPersistenceListOptions, type SessionPersistenceOpenOptions,
  type SessionPersistenceSnapshot, type SessionPersistenceStatOptions,
  type SessionPersistenceRevision as PersistenceRevision,
} from '@deepseek-ai/dsh-session-persistence'
import { JsonlBackendTracker, JsonlSessionHandle, type StorageHandleState } from './storage.ts'
import { SessionWriteLease } from './lease.ts'
import { SESSION_FORMAT_VERSION, SessionId as makeSessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId, SessionHeader, SessionLogOffset as SessionLogOffsetType } from '@deepseek-ai/dsh-session'
import {
  assertNoRetiredHeaderFields, encodeSegment, eventLines, generationLogFilename, generationLogPath, logPath, logSuffix,
  parseGenerationLogFilename, projectDir, scanLog, sessionDir, SessionLogScanner, toHeaderLine,
  type JsonlCompression,
} from './format.ts'
import {
  compressZstdFrame, createZstdFrameDecoder, decompressZstdFrame, decompressZstdPrefix, scanZstdFrames,
} from './zstd.ts'
import { ensureDurableDirectoryWin32, publishNewFileWin32 } from './win32.ts'
import { verifyCurrentGenerationInWorker } from './migration-verifier.ts'
import { prepareCatalogFacts } from './catalog-migration.ts'
import {
  JsonlGenerationSourceChangedError,
  JsonlGenerationUnsupportedMigrationError,
  prepareJsonlMigration,
  readStableJsonlFile,
  type JsonlGenerationFormatAdapter,
  type JsonlPhysicalIdentity,
  type PreparedJsonlMigration,
} from './generation.ts'

export type { JsonlCompression } from './format.ts'

/**
 * 内部交接复用策略，而非部署配置：一次冷观测与紧随其后的 resume 会复用
 * 同一份已解析日志，因此该备忘只需容纳这两个步骤之间在途的会话。
 */
const COLD_LOG_MEMO_MAX_ENTRIES = 2

const DEFAULT_COMPRESSION: JsonlCompression = 'zstd'
/**
 * 内部调度常量，而非部署配置：在帧边界处的事件循环让出与 `setImmediate`
 * 开销之间取得平衡。单个帧仍然是一次不可分割的同步解码。
 */
const ZSTD_DECODE_YIELD_INTERVAL_MS = 500

/** 断言可独立解码的首帧只含头部记录。 */
function assertZstdHeaderFrame(plaintext: Buffer): void {
  if (plaintext.length === 0 || plaintext.indexOf(0x0A) !== plaintext.length - 1) {
    throw new Error('corrupt Zstandard session log: first frame is not exactly one header line')
  }
}

/** JSONL 制品物理编码方式的加载器 schema。 */
export const JsonlCompressionSchema: z<JsonlCompression> = z.union([
  z.const('zstd'),
  z.const('none'),
]).default(DEFAULT_COMPRESSION)

/** 每个后端在列举时并发进行的文件系统操作默认上限。 */
const DEFAULT_LIST_CONCURRENCY = 3

/** JSONL 后端的根目录、物理编码与列举并发度的插件配置。 */
export interface Config {
  /**
   * 所有会话文件的根目录。必需（无默认值）：若默认为 `process.cwd()`，
   * 则会话文件会随进程 cwd 的变化（bash 调用、子进程）而散落各处。
   * 会话按人类可读的项目目录分组，其下再按会话划分目录。已存在的根目录
   * 必须是可读目录；不存在的根目录会在首次物化时创建。
   */
  root: string
  /** 物理编码方式；默认为带校验和的 Zstandard 帧。 */
  compression?: JsonlCompression
  /**
   * 在本后端所有并发列举（`list()`、根目录编码检查与历史指纹）之间
   * 同时在途的目录、头部与 stat 读取上限。默认为 3。
   */
  listConcurrency?: number
}

/** 与目录所选择的物理代际分类配对的逻辑头部。 */
interface GenerationHeader {
  readonly header: SessionHeader
  readonly formatStatus: NonNullable<SessionPersistenceSnapshot['formatStatus']>
}

/** 其生产者已确立不可变共享的一份已存储事件图。 */
interface FrozenStoredEvents extends SessionHandleReadResult {
  readonly eventState: 'shared-frozen'
}

/** 已准备好的历史日志与已发布的当前日志共用的状态。 */
interface StoredLogBase extends FrozenStoredEvents {
  readonly meta: SessionHeader
  readonly tornTruncateTo: number | undefined
  /** 从被撕裂的末尾帧中恢复出的完整事件；写入路径会持久地重写它们。 */
  readonly recoveredTail: SessionEvent[]
  /** 头部行中存储的精确 fork 继承前缀长度。 */
  readonly inheritedEventCount: SessionLogOffsetType
  readonly revision: PersistenceRevision
}

/** 一个已经持久的、已解码的当前代际。 */
interface CurrentStoredLog extends StoredLogBase {
  readonly status: 'current'
}

/** 一个已迁移的历史代际，保留到某次显式写打开发布它为止。 */
interface PreparedStoredLog extends StoredLogBase {
  readonly status: 'prepared'
  readonly validateRelatedSources: () => Promise<void>
  readonly publication: {
    readonly source: ResolvedJsonlGeneration
    readonly value: PreparedJsonlMigration
  }
}

/** 一个已校验的逻辑日志，要么是持久的当前状态，要么是已准备好的历史状态。 */
type StoredLog = CurrentStoredLog | PreparedStoredLog

/** 深度冻结无环的已存储 JSON；其数组只含带索引的 JSON 值。 */
function freezeStoredEvent(event: SessionEvent): void {
  const pending: object[] = [event]
  while (pending.length > 0) {
    // 非空检查已证明还有待访问的对象。
    // oxlint-disable-next-line typescript/no-non-null-assertion
    const current = pending.pop()!
    Object.freeze(current)
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1) {
        const child: unknown = current[index]
        if (child !== null && typeof child === 'object') pending.push(child)
      }
    } else {
      for (const key in current) {
        const child = (current as Record<string, unknown>)[key]
        if (child !== null && typeof child === 'object') pending.push(child)
      }
    }
  }
}

/** 为一份已解码的事件图确立不可变共享，并报告该状态。 */
function freezeStoredEvents(events: SessionEvent[]): FrozenStoredEvents {
  for (const event of events) freezeStoredEvent(event)
  Object.freeze(events)
  return { eventState: 'shared-frozen', events }
}

/** 从 Session 目录中选出的一个权威的不可变代际。 */
interface ResolvedJsonlGeneration {
  readonly sourcePath: string
  readonly sourceVersion: number
  readonly currentPath: string
}

/** 由后端持有的、被其当前调用方共享的一次历史准备工作。 */
interface MigrationPreparation {
  readonly sourcePath: string
  readonly sourceRevision: PersistenceRevision
  readonly controller: AbortController
  readonly promise: Promise<PreparedStoredLog>
  settled: boolean
  waiters: number
}

/** 构造由 stat 派生的、完整读取与轻量读取共用的尽力而为变更令牌。 */
function fileRevision(identity: JsonlPhysicalIdentity): PersistenceRevision {
  return SessionPersistenceRevision([
    identity.dev,
    identity.ino,
    identity.size,
    identity.mtimeNs,
    identity.ctimeNs,
  ].join(':'))
}

/** 判断一个文件系统错误是否表示缺失；每个非 ENOENT 的失败都必须浮出水面。 */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * 通过后端共享的列举限流器在 `items` 上运行 `task`，并让每次调用都结算。
 * 调用方按输入顺序消费结果，因此无论完成顺序如何，它们报告的第一个失败
 * 都与顺序循环一致。被限流的任务绝不能等待同一个限流器。
 * @param limit - 后端共享的列举限流器。
 * @param items - 按各自顺序排列的输入。
 * @param task - 针对每个项目的操作。
 * @returns 按输入顺序排列的、每个项目一个的结果。
 */
function settleLimited<T, R>(
  limit: LimitFunction,
  items: readonly T[],
  task: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  return Promise.allSettled(items.map(item => limit(() => task(item))))
}

/**
 * 展开来自 {@link settleLimited} 的结果，按输入顺序重新抛出第一个拒绝。
 * @param outcomes - 按输入顺序排列的结果。
 * @returns 按输入顺序排列的已完成值。
 */
function settledValues<R>(outcomes: readonly PromiseSettledResult<R>[]): R[] {
  return outcomes.map((outcome) => {
    if (outcome.status === 'rejected') throw outcome.reason
    return outcome.value
  })
}

/** 判断一个文件系统持有的失败是否应保留其原始 errno 与路径。 */
function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof (error as NodeJS.ErrnoException | null)?.code === 'string'
}

/** 保留一个 Error 类型的中止原因，并把恶意的非 Error 原因规范化。 */
function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('session migration preparation aborted', { cause: signal.reason })
}

/** 让某个调用方停止等待，而不把取消所有权转移给共享工作。 */
function waitWithAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation
  /* v8 ignore next -- requireStoredLog 在等待之前会立即同步复查该信号。 */
  if (signal.aborted) return Promise.reject(abortError(signal))
  return new Promise<T>((resolve, reject) => {
    const stopWaiting = (): void => {
      reject(abortError(signal))
    }
    signal.addEventListener('abort', stopWaiting, { once: true })
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', stopWaiting)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', stopWaiting)
        /* v8 ignore else -- 准备工作的持有者会在本等待方看到之前规范化每个拒绝。 */
        if (error instanceof Error) {
          reject(error)
        } else {
          reject(new Error('session migration preparation failed', { cause: error }))
        }
      },
    )
  })
}

/**
 * 由插件注册为 `ctx.sessionPersistence` 的 JSONL 后端。会话是惰性物化的：
 * 一个已创建的会话立刻对本进程可见，在其首次 append 或 flush 时落到磁盘，
 * 而若进程在那之前崩溃，它就从未存在过。
 */
class JsonlSessionPersistence extends SessionPersistence {
  /** 用于诊断与 effect 的后端标签；遮蔽 `Service.name`，但不改变服务键。 */
  override readonly name = 'session-persistence-jsonl'

  private root: string
  private compression: JsonlCompression
  /**
   * 在本后端所有并发列举（`list()`、根目录编码检查与历史指纹）之间限制
   * 目录、头部与 stat 的 I/O。已取消列举中排队的任务仍会运行，并在其
   * 信号检查处拒绝。
   */
  private readonly listLimit: LimitFunction
  private rootEncodingCheck: Promise<void> | undefined
  private readonly generationFormat: Omit<JsonlGenerationFormatAdapter, 'createRestore'>
  /**
   * 以会话 id 为键的有界 LRU，缓存已解析且已校验的存储日志，并由 stat 派生
   * 的修订值守卫，这样一次紧接着的冷读交接（先观测再 resume）只需解析
   * 制品一次。某个 id 的每次本地变更都会使其条目失效；外部写入则通过修订
   * 守卫而落空。
   */
  private readonly coldLogMemo = new Map<SessionId, StoredLog>()
  /** 每个所选历史 Session 文件修订对应一个可加入的解码/迁移操作。 */
  private readonly migrationPreparations = new Map<SessionId, MigrationPreparation>()

  constructor(ctx: Context, public config: Config, private readonly tracker: JsonlBackendTracker) {
    super(ctx)
    /* v8 ignore next 5 -- 生成的目录与 Session 源码共享同一个构建期版本持有者。 */
    if (sessionFormatCatalog.currentVersion !== SESSION_FORMAT_VERSION) {
      throw new Error(
        `session-persistence-jsonl: format catalog v${sessionFormatCatalog.currentVersion} `
        + `does not match Session v${SESSION_FORMAT_VERSION}`,
      )
    }
    // 只解析一次，这样之后 process.cwd() 的变化不会把同一个后端拆到多个根目录上。
    this.root = resolve(config.root)
    this.compression = config.compression ?? DEFAULT_COMPRESSION
    this.listLimit = pLimit(config.listConcurrency ?? DEFAULT_LIST_CONCURRENCY)
    this.generationFormat = {
      currentVersion: sessionFormatCatalog.currentVersion,
      encodeHeader: (header, inheritedEventCount) =>
        sessionFormatCatalog.encodeCurrentHeader(header, inheritedEventCount),
      encodeEvent: event => sessionFormatCatalog.encodeCurrentEvent(event),
      isUnsupportedMigrationError: (error): error is SessionFormatUnsupportedMigrationError =>
        error instanceof SessionFormatUnsupportedMigrationError,
    }
    this.assertUsableRoot()
  }

  /**
   * 拒绝诊断钩子：给出绝对目标路径，不触碰文件系统。
   * @param meta - 指明会话及其 cwd 的已存储头部。
   * @returns 制品类型与绝对路径。
   */
  private locate(meta: SessionHeader): SessionLocation {
    return { kind: 'jsonl', path: logPath(this.root, meta.cwd, meta.id, this.compression) }
  }

  // --- SessionPersistence 服务 API ---

  /**
   * 创建一个新的已存储会话并取得其写所有权。该会话立刻对本进程可见；
   * 物理制品在其首次 append 或 flush 时出现。
   * @param header - 要存储的不可变头部；必须能无损 JSON 序列化，
   *   且其 `createdAt` 是非负安全整数。
   * @param options - 可选取消信号。
   * @returns 被持有的写句柄。
   */
  async create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandle> {
    options?.signal?.throwIfAborted()
    const snapshot = materializeCreateHeader(header)
    // 对播种/切点不匹配快速失败，其拒绝信息与头部行编码器在物化时
    // 强制执行的完全一致。
    toHeaderLine(snapshot, options?.inheritedEventCount)
    const inheritedEventCount = SessionLogOffset(options?.inheritedEventCount ?? 0)
    await this.ensureRootEncoding()
    options?.signal?.throwIfAborted()
    if (this.tracker.hasPending(snapshot.id) || await this.findLog(snapshot.id, options?.signal) !== undefined) {
      throw new SessionAlreadyExistsError(snapshot.id)
    }
    options?.signal?.throwIfAborted()
    // 此时还没有锁：物化之前不存在可供另一个进程争用的持久制品，
    // 因此句柄会就在其首批日志字节发布之前获取锁（ensureLease）；
    // 未物化的会话根本不留下任何文件系统痕迹。
    this.tracker.registerCreated(snapshot, inheritedEventCount)
    return this.tracker.adopt(new JsonlSessionHandle(this, snapshot.id, snapshot, 'write', { cursor: 0, materialized: false, inheritedEventCount }))
  }

  /**
   * 以 `read` 或单写者 `write` 打开一个已存在的已存储会话。
   * @param id - 要打开的已存储会话。
   * @param access - `read`（无所有权）或 `write`（进程内原子申领）。
   * @param options - 可选取消信号。
   * @returns 已打开的句柄。
   */
  async open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle> {
    options?.signal?.throwIfAborted()
    await this.ensureRootEncoding()
    options?.signal?.throwIfAborted()
    const pending = this.tracker.pendingOf(id)
    if (access === 'read') {
      if (pending !== undefined) {
        return this.tracker.adopt(new JsonlSessionHandle(this, id, pending.header, 'read', { cursor: 0, materialized: false, inheritedEventCount: pending.inheritedEventCount }))
      }
      let stored: StoredLog
      try {
        stored = await this.requireStoredLog(id, options?.signal)
      } catch (error: unknown) {
        if (!(error instanceof JsonlGenerationSourceChangedError)) throw error
        stored = await this.requireStoredLog(id, options?.signal)
      }
      let state: StorageHandleState
      if (stored.status === 'prepared') {
        state = {
          cursor: 0,
          materialized: true,
          inheritedEventCount: stored.inheritedEventCount,
          primed: stored,
        }
      } else {
        state = {
          cursor: 0,
          materialized: true,
          inheritedEventCount: stored.inheritedEventCount,
        }
      }
      return this.tracker.adopt(new JsonlSessionHandle(this, id, stored.meta, 'read', state))
    }
    // 一个 pending 条目总属于一个活跃的创建者句柄（close 会清除它），
    // 因此下面的申领会把这种情况当作已被占用而拒绝。
    this.tracker.claimWrite(id)
    let lease: SessionWriteLease | undefined
    try {
      const resolved = await this.findLog(id, options?.signal)
      if (resolved === undefined) throw new SessionPersistenceNotFoundError(id)
      lease = await this.acquireLease(id, undefined, dirname(resolved.currentPath))
      const prepared = await this.requireStoredLog(id, options?.signal)
      options?.signal?.throwIfAborted()
      let stored: CurrentStoredLog
      if (prepared.status === 'prepared') {
        stored = await this.publishStoredMigration(id, prepared)
      } else {
        stored = prepared
      }
      options?.signal?.throwIfAborted()
      return this.tracker.adopt(new JsonlSessionHandle(this, id, stored.meta, 'write', {
        cursor: stored.events.length,
        materialized: true,
        tornTruncateTo: stored.tornTruncateTo,
        recoveredTail: stored.recoveredTail,
        inheritedEventCount: stored.inheritedEventCount,
        primed: stored,
      }, lease))
    } catch (error) {
      // 无论内核锁释放结果如何，都要释放进程内的申领，并保留原始诊断：
      // 释放失败只是并入其中，而不是取代它。
      /* v8 ignore next -- 带类型的后端与 fs 都以 Error 拒绝 */
      const failure = error instanceof Error ? error : new Error(String(error))
      let releaseFailure: Error | undefined
      try {
        await lease?.release()
      } catch (raw: unknown) {
        /* v8 ignore next -- 锁释放以 Error 拒绝 */
        releaseFailure = raw instanceof Error ? raw : new Error(String(raw))
      }
      this.tracker.releaseClaim(id)
      if (releaseFailure !== undefined) {
        throw new AggregateError([failure, releaseFailure], `session "${id}": write open failed and its lock release failed`)
      }
      throw failure
    }
  }

  /**
   * 在一个持久性屏障中刷新每个活跃的写句柄；参见接缝契约。
   * @returns 当调用时处于活跃状态的每个写句柄都刷新完成后 resolve。
   */
  flush(): Promise<void> {
    return this.tracker.flushAll()
  }

  /**
   * 观测一个已存储的会话，不读取其事件日志。
   * @param id - 要观测的已存储会话。
   * @param options - 可选取消信号。
   * @returns 该快照（`sizeBytes` 携带物理制品大小），
   *   或当会话不存在时为 `undefined`。
   */
  async stat(
    id: SessionId,
    options?: SessionPersistenceStatOptions,
  ): Promise<SessionPersistenceSnapshot | undefined> {
    options?.signal?.throwIfAborted()
    await this.ensureRootEncoding()
    options?.signal?.throwIfAborted()
    const pending = this.tracker.pendingOf(id)
    if (pending !== undefined) {
      return { header: pending.header, revision: pending.revision }
    }
    const selected = await this.findLog(id, options?.signal)
    if (selected === undefined) return undefined
    const metadata = await this.readGenerationHeader(selected, id, options?.signal)
    if (metadata === undefined) return undefined
    try {
      const identity = await stat(selected.sourcePath, { bigint: true })
      options?.signal?.throwIfAborted()
      return {
        ...metadata,
        revision: selected.sourceVersion < SESSION_FORMAT_VERSION
          ? SessionPersistenceRevision(`${fileRevision(identity)}:${await this.historicalCorpusRevision(options?.signal)}`)
          : fileRevision(identity),
        sizeBytes: Number(identity.size),
      }
    } catch (error: unknown) {
      options?.signal?.throwIfAborted()
      if (isENOENT(error)) return undefined
      throw error
    }
  }

  /**
   * 列出本进程可见的每个已存储会话：已物化的制品，加上本进程中已创建但
   * 未物化的会话。
   * @param options - 可选取消信号。
   * @returns 每个会话一个快照，不承诺任何顺序。
   */
  async list(options?: SessionPersistenceListOptions): Promise<readonly SessionPersistenceSnapshot[]> {
    const signal = options?.signal
    const snapshots: SessionPersistenceSnapshot[] = []
    const listed = new Set<SessionId>()
    // 在扫描存储之前先快照 pending 条目：一个首次追加落在扫描中途的会话，
    // 因此仍会存在于这份快照中（其制品可能早于该扫描），
    // 这样“创建即可列举”的可见性永不会出现空洞。
    const pending = [...this.tracker.pendingEntries()]
    const artifacts = await this.listArtifacts(signal)
    const corpusRevision = artifacts.some(artifact => artifact.sourceVersion < SESSION_FORMAT_VERSION)
      ? await this.historicalCorpusRevision(signal) : undefined
    const statted = settledValues(await settleLimited(this.listLimit, artifacts, async (artifact) => {
      signal?.throwIfAborted()
      try {
        const identity = await stat(artifact.path, { bigint: true })
        signal?.throwIfAborted()
        return { artifact, identity }
      } catch (error: unknown) {
        signal?.throwIfAborted()
        if (!isENOENT(error)) throw error
        return undefined
      }
    }))
    for (const entry of statted) {
      if (entry === undefined) continue
      const { artifact, identity } = entry
      listed.add(artifact.header.id)
      snapshots.push({
        header: artifact.header,
        formatStatus: artifact.formatStatus,
        revision: artifact.sourceVersion < SESSION_FORMAT_VERSION
          ? SessionPersistenceRevision(`${fileRevision(identity)}:${corpusRevision}`)
          : fileRevision(identity),
        sizeBytes: Number(identity.size),
      })
    }
    for (const [id, entry] of pending) {
      if (!listed.has(id)) snapshots.push({ header: entry.header, revision: entry.revision })
    }
    signal?.throwIfAborted()
    return snapshots
  }

  // --- 面向句柄的存储内部实现（通过下面的句柄类在包内可见）---

  /** 解析并读取一个已存储日志，制品缺失时响亮地拒绝。 */
  private async requireStoredLog(id: SessionId, signal?: AbortSignal): Promise<StoredLog> {
    const selected = await this.findLog(id, signal)
    if (selected === undefined) throw new SessionPersistenceNotFoundError(id)
    if (selected.sourceVersion < SESSION_FORMAT_VERSION) {
      const sourceRevision = fileRevision(await stat(selected.sourcePath, { bigint: true }))
      signal?.throwIfAborted()
      let preparation = this.migrationPreparations.get(id)
      if (preparation === undefined
        || preparation.sourcePath !== selected.sourcePath
        || preparation.sourceRevision !== sourceRevision) {
        const controller = new AbortController()
        const promise = this.loadStoredMigration(id, selected, sourceRevision, controller.signal)
        preparation = {
          sourcePath: selected.sourcePath,
          sourceRevision,
          controller,
          promise,
          settled: false,
          waiters: 0,
        }
        this.migrationPreparations.set(id, preparation)
        const created = preparation
        const release = (): void => {
          created.settled = true
          if (this.migrationPreparations.get(id) === created) {
            this.migrationPreparations.delete(id)
          }
        }
        void promise.then(release, release)
      }
      signal?.throwIfAborted()
      return this.waitForPreparation(id, preparation, signal)
    }
    if (selected.sourceVersion > SESSION_FORMAT_VERSION) {
      const header = await this.readGenerationHeader(selected, id, signal)
      /* v8 ignore else -- 可读的未来头部会在 readGenerationHeader 内部被拒绝。 */
      if (header === undefined) {
        throw new SessionPersistenceCorruptionError(
          `session "${id}": stored log has a malformed header (raw log: ${selected.sourcePath})`,
          { cause: new Error('malformed Session header') },
        )
      }
      /* v8 ignore next -- readGenerationHeader 会拒绝每个未来版本。 */
      throw new SessionFormatUnsupportedError(
        `${sessionFormatVersionRefusal(id, selected.sourceVersion)} (raw log: ${selected.sourcePath})`,
        { kind: 'jsonl', path: selected.sourcePath },
      )
    }
    const probe = fileRevision(await stat(selected.sourcePath, { bigint: true }))
    const memoized = this.coldLogMemo.get(id)
    if (memoized?.status === 'current' && memoized.revision === probe) {
      this.coldLogMemo.delete(id)
      this.coldLogMemo.set(id, memoized)
      return memoized
    }
    const current = await readStableJsonlFile(selected.sourcePath, signal)
    return this.decodeStoredLog(
      selected.sourcePath,
      id,
      current.bytes,
      fileRevision(current.identity),
      signal,
    )
  }

  /** 探测备忘缓存，否则在后端取消控制下解码一个历史代际。 */
  private async loadStoredMigration(
    id: SessionId,
    selected: ResolvedJsonlGeneration,
    sourceRevision: PersistenceRevision,
    signal: AbortSignal,
  ): Promise<PreparedStoredLog> {
    signal.throwIfAborted()
    const memoized = this.coldLogMemo.get(id)
    if (memoized?.status === 'prepared' && memoized.revision === sourceRevision) {
      try {
        await memoized.validateRelatedSources()
      } catch (error: unknown) {
        this.coldLogMemo.delete(id)
        throw this.generationFailure(id, selected, error)
      }
      this.coldLogMemo.delete(id)
      this.coldLogMemo.set(id, memoized)
      return memoized
    }
    return this.prepareStoredMigration(id, selected, signal)
  }

  /** 为某个调用方等待共享的准备工作，并只在最后一个等待者离开之后才中止它。 */
  private async waitForPreparation(
    id: SessionId,
    preparation: MigrationPreparation,
    signal?: AbortSignal,
  ): Promise<PreparedStoredLog> {
    preparation.waiters += 1
    try {
      return await waitWithAbort(preparation.promise, signal)
    } finally {
      preparation.waiters -= 1
      if (preparation.waiters === 0 && !preparation.settled) {
        /* v8 ignore else -- a newer selected source may already own this id's preparation slot. */
        if (this.migrationPreparations.get(id) === preparation) {
          this.migrationPreparations.delete(id)
        }
        preparation.controller.abort()
      }
    }
  }

  /** 解码一个历史代际，但不发布其后继者。 */
  private async prepareStoredMigration(
    id: SessionId,
    selected: ResolvedJsonlGeneration,
    signal: AbortSignal,
  ): Promise<PreparedStoredLog> {
    let prepared: Awaited<ReturnType<typeof prepareJsonlMigration>>
    let validateRelatedSources: () => Promise<void>
    try {
      const children = async () => (await this.listArtifacts(signal))
        .filter(source => source.header.origin === 'subagent' && source.header.parentSession === id)
      const sources = await children()
      const related = await prepareCatalogFacts(id, sources, this.compression, signal)
      for (const failure of related.failures) {
        this.ctx.logger.warn(`${this.name}: session "${id}" catalog retained a child with unknown descriptor (raw log: ${failure.path}): ${String(failure.error)}`)
      }
      const membership = sources.map(source => source.path).sort()
      validateRelatedSources = async () => {
        const current = (await children()).map(source => source.path).sort()
        const before = new Set(membership)
        const after = new Set(current)
        const changed = current.find(path => !before.has(path)) ?? membership.find(path => !after.has(path))
        if (changed !== undefined) throw new JsonlGenerationSourceChangedError(changed)
        await related.validate()
      }
      prepared = await prepareJsonlMigration({
        sourcePath: selected.sourcePath,
        sourceVersion: selected.sourceVersion,
        currentPath: selected.currentPath,
        compression: this.compression,
        format: {
          ...this.generationFormat,
          createRestore: header => createSessionFormatCatalogWithChildren(related.facts).createRestore(header, {
            recovery: 'recoverable', validation: 'transformed',
          }),
        },
        validateRelatedSources,
        verifyCurrentFile: verifyCurrentGenerationInWorker,
        validateHistoricalHeader: headerValue => this.validateSourceIdentity(
          selected,
          headerValue,
          id,
          signal,
        ),
        signal,
      })
    } catch (error: unknown) {
      throw this.generationFailure(id, selected, error)
    }
    const meta = this.currentHeader(prepared.artifact.header)
    assertStoredId(id, meta)
    const events = prepared.artifact.events as SessionEvent[]
    validateStoredEvents(meta, events, { kind: 'jsonl', path: selected.sourcePath })
    const stored: PreparedStoredLog = {
      status: 'prepared',
      validateRelatedSources,
      meta,
      ...freezeStoredEvents(events),
      tornTruncateTo: undefined,
      recoveredTail: [],
      inheritedEventCount: SessionLogOffset(prepared.artifact.inheritedEventCount),
      revision: fileRevision(prepared.sourceIdentity),
      publication: { source: selected, value: prepared },
    }
    this.memoizeStoredLog(id, stored)
    return stored
  }

  /** 在授予写访问之前发布一个已准备好的历史日志。 */
  private async publishStoredMigration(id: SessionId, stored: PreparedStoredLog): Promise<CurrentStoredLog> {
    const migration = stored.publication
    let identity: JsonlPhysicalIdentity
    try {
      identity = await migration.value.publish()
    } catch (error: unknown) {
      /* v8 ignore else -- 一次更新的准备工作可能已经替换了这个陈旧缓存条目。 */
      if (this.coldLogMemo.get(id) === stored) this.coldLogMemo.delete(id)
      throw this.generationFailure(id, migration.source, error)
    }
    const published: CurrentStoredLog = {
      status: 'current',
      meta: stored.meta,
      eventState: stored.eventState,
      events: stored.events,
      tornTruncateTo: stored.tornTruncateTo,
      recoveredTail: stored.recoveredTail,
      inheritedEventCount: stored.inheritedEventCount,
      revision: fileRevision(identity),
    }
    this.memoizeStoredLog(id, published)
    return published
  }

  /** 把代际层的失败翻译为持久化接缝的错误词表。 */
  private generationFailure(
    id: SessionId,
    selected: ResolvedJsonlGeneration,
    error: unknown,
  ): Error {
    if (error instanceof JsonlGenerationUnsupportedMigrationError) {
      return new SessionFormatUnsupportedError(
        `${error.message}; source v${error.fromVersion} artifact remains unchanged (raw log: ${selected.sourcePath})`,
        { kind: 'jsonl', path: selected.sourcePath },
      )
    }
    if (error instanceof JsonlGenerationSourceChangedError) return error
    if (error instanceof SessionFormatUnsupportedError
      || error instanceof SessionPersistenceCorruptionError
      || isErrnoException(error)
      || error instanceof DOMException && error.name === 'AbortError') return error
    return new SessionPersistenceCorruptionError(
      `session "${id}": stored log is corrupt: ${String(error)} (raw log: ${selected.sourcePath})`,
      { cause: error },
    )
  }

  /**
   * 读取、解析并校验一个已存储日志，作为当前逻辑前缀。
   * @param path - 要读取的制品文件。
   * @param expectedId - 该制品必须携带的会话身份。
   * @param signal - 可选取消信号，用于 stat/读取/解码工作。
   * @returns 已校验的存储日志，附带任何撕裂尾部截断点。
   */
  async readStoredLog(path: string, expectedId: SessionId, signal?: AbortSignal): Promise<CurrentStoredLog> {
    signal?.throwIfAborted()
    const probe = fileRevision(await stat(path, { bigint: true }))
    const memoized = this.coldLogMemo.get(expectedId)
    if (memoized?.status === 'current' && memoized.revision === probe) {
      this.coldLogMemo.delete(expectedId)
      this.coldLogMemo.set(expectedId, memoized)
      return memoized
    }
    const { bytes, identity } = await readStableJsonlFile(path, signal)
    return this.decodeStoredLog(path, expectedId, bytes, fileRevision(identity), signal)
  }

  /** 解码并备忘一个已经稳定的当前物理快照。 */
  private async decodeStoredLog(
    path: string,
    expectedId: SessionId,
    buffer: Buffer,
    revision: PersistenceRevision,
    signal?: AbortSignal,
  ): Promise<CurrentStoredLog> {
    let parsed: {
      meta: SessionHeader
      inheritedEventCount: SessionLogOffsetType
      events: SessionEvent[]
      tornTruncateTo: number | undefined
      recoveredTail: SessionEvent[]
    }
    try {
      if (this.compression === 'zstd') {
        parsed = await this.readZstdPrefix(buffer, signal)
      } else {
        signal?.throwIfAborted()
        const { meta, inheritedEventCount, events, committedBytes } = scanLog(buffer)
        signal?.throwIfAborted()
        parsed = {
          meta,
          inheritedEventCount,
          events,
          tornTruncateTo: committedBytes < buffer.byteLength ? committedBytes : undefined,
          // 被撕裂的原始尾部是一行不完整的 JSONL；其中没有可供恢复的完整记录。
          recoveredTail: [],
        }
      }
    } catch (error: unknown) {
      signal?.throwIfAborted()
      // 解析期的格式拒绝先于任何 SessionHeader 出现，因此要附上本次读取实际
      // 拒绝的那个制品；其它所有解析失败都是解码器无法解释的已提交字节——
      // 即损坏，按接缝的稳定错误词表进行分类。
      if (error instanceof SessionFormatUnsupportedError) {
        throw new SessionFormatUnsupportedError(`${error.message} (raw log: ${path})`, { kind: 'jsonl', path })
      }
      throw new SessionPersistenceCorruptionError(`session "${expectedId}": stored log is corrupt: ${String(error)} (raw log: ${path})`, { cause: error })
    }
    signal?.throwIfAborted()
    await this.assertStoredIdentity(path, SESSION_FORMAT_VERSION, parsed.meta, expectedId, signal)
    signal?.throwIfAborted()
    assertStoredId(expectedId, parsed.meta)
    const location = this.locate(parsed.meta)
    validateStoredEvents(parsed.meta, parsed.events, location)
    const { events, ...rest } = parsed
    const stored: CurrentStoredLog = {
      status: 'current',
      ...rest,
      ...freezeStoredEvents(events),
      revision,
    }
    this.memoizeStoredLog(expectedId, stored)
    return stored
  }

  /** 把一份已解析的日志插入有界的交接缓存。 */
  private memoizeStoredLog(id: SessionId, stored: StoredLog): void {
    this.coldLogMemo.delete(id)
    this.coldLogMemo.set(id, stored)
    for (const oldest of this.coldLogMemo.keys()) {
      if (this.coldLogMemo.size <= COLD_LOG_MEMO_MAX_ENTRIES) break
      this.coldLogMemo.delete(oldest)
    }
  }

  /**
   * 解析某个会话当前代际的日志路径。
   * @param id - 要定位的已存储会话。
   * @param signal - 可选取消信号，用于目录扫描。
   * @returns 当前制品路径；当只存在历史代际时为 `undefined`。
   */
  async resolveCurrentLog(id: SessionId, signal?: AbortSignal): Promise<string | undefined> {
    await this.ensureRootEncoding()
    signal?.throwIfAborted()
    const selected = await this.findLog(id, signal)
    if (selected === undefined) return undefined
    if (selected.sourceVersion === SESSION_FORMAT_VERSION) return selected.sourcePath
    if (selected.sourceVersion < SESSION_FORMAT_VERSION) return undefined
    const reason = sessionFormatVersionRefusal(id, selected.sourceVersion)
    throw new SessionFormatUnsupportedError(
      `${reason} (raw log: ${selected.sourcePath})`,
      { kind: 'jsonl', path: selected.sourcePath },
    )
  }

  /**
   * 持久地追加一个已校验的批次；在首次写入时惰性物化。
   * @param header - 会话的已存储头部。
   * @param events - 已校验的连续批次，按 seq 顺序。
   * @param isMaterialized - 该会话是否已有持久制品。
   * @param inheritedEventCount - 写入正在物化的头部行中的精确 fork 继承前缀长度。
   */
  async persistBatch(
    header: SessionHeader,
    events: readonly SessionEvent[],
    isMaterialized: boolean,
    inheritedEventCount: SessionLogOffsetType,
  ): Promise<void> {
    this.coldLogMemo.delete(header.id)
    await this.ensureRootEncoding()
    if (isMaterialized) {
      await this.appendLines(header, events)
    } else {
      await this.materialize(header, inheritedEventCount, events)
      this.tracker.materialized(header.id)
    }
  }

  /**
   * 为一个显式要求持久的空会话物化只含头部的制品。
   * @param header - 会话的已存储头部。
   * @param inheritedEventCount - 写入头部行中的精确 fork 继承前缀长度。
   */
  async persistHeader(header: SessionHeader, inheritedEventCount: SessionLogOffsetType): Promise<void> {
    this.coldLogMemo.delete(header.id)
    await this.ensureRootEncoding()
    await this.materialize(header, inheritedEventCount, [])
    this.tracker.materialized(header.id)
  }

  /**
   * 在本会话首次新追加之前，持久地截断被撕裂的物理尾部。
   * @param header - 会话的已存储头部。
   * @param truncateTo - 制品被截断到的字节偏移。
   */
  async truncateTornTail(header: SessionHeader, truncateTo: number): Promise<void> {
    this.coldLogMemo.delete(header.id)
    await this.repair(header, truncateTo)
    this.ctx.logger.warn(`${this.name}: session "${header.id}" recovered from a torn tail; incomplete tail bytes were discarded`)
  }

  /**
   * 本进程是否仍在跟踪一个已创建但未物化的会话。
   * @param id - 要检测的会话。
   * @returns pending 条目存在时为 true。
   */
  hasPendingSession(id: SessionId): boolean {
    return this.tracker.hasPending(id)
  }

  /**
   * 在关闭时释放某个句柄的后端记账信息。
   * @param handle - 正在关闭的句柄。
   * @param materialized - 该会话是否到达了持久存储。
   */
  releaseHandle(handle: JsonlSessionHandle, materialized: boolean): void {
    this.tracker.release(handle, materialized)
  }

  /**
   * 获取会话目录的内核写锁；内核会持有它，直到句柄的 close 释放描述符，
   * 包括进程死亡的情形。
   * @param id - 该锁所守护的会话。
   * @param cwd - 头部中的 cwd，用于为一个新会话派生目录。
   * @param dir - 已知时，某个已存在制品已解析出的目录。
   * @returns 已持有的锁。
   */
  private acquireLease(id: SessionId, cwd: string | undefined, dir = sessionDir(this.root, cwd, id)): Promise<SessionWriteLease> {
    return SessionWriteLease.acquire(dir, id)
  }

  /**
   * 为一个正在物化的已创建会话获取跨进程写锁，由其句柄在首批日志字节
   * 发布之前立即调用。
   * @param header - 会话的已存储头部（其 cwd 派生出目录）。
   * @returns 已持有的锁。
   */
  async acquireWriteLease(header: SessionHeader): Promise<SessionWriteLease> {
    // 在锁的 mkdir 发布会话目录之前拒绝相反编码的制品——
    // 这是该目录还可能不存在的最后时刻。
    await this.rejectOppositeArtifact(header.cwd, header.id)
    return this.acquireLease(header.id, header.cwd)
  }

  /** 解码完整帧，并从被撕裂的末尾帧中保留完整的 JSONL 记录。 */
  private async readZstdPrefix(
    buffer: Buffer,
    signal?: AbortSignal,
  ): Promise<{
    meta: SessionHeader
    inheritedEventCount: SessionLogOffsetType
    events: SessionEvent[]
    tornTruncateTo: number | undefined
    recoveredTail: SessionEvent[]
  }> {
    signal?.throwIfAborted()
    const { frames, tornStart } = scanZstdFrames(buffer)
    signal?.throwIfAborted()
    if (frames.length === 0) throw new Error('empty or header-less Zstandard session log')

    const decoder = createZstdFrameDecoder()
    let yieldDeadline = performance.now() + ZSTD_DECODE_YIELD_INTERVAL_MS
    try {
      const decodedFrames = decoder.decode(buffer, frames)
      signal?.throwIfAborted()
      const headerFrame = decodedFrames.next()
      signal?.throwIfAborted()
      /* v8 ignore next -- 非空的机构化帧列表会让解码器产出其第一帧或抛出。 */
      if (headerFrame.done) throw new Error('empty or header-less Zstandard session log')
      assertZstdHeaderFrame(headerFrame.value)
      const scanner = new SessionLogScanner(headerFrame.value)

      let remainingFrames = frames.length - 1
      for (const plaintext of decodedFrames) {
        signal?.throwIfAborted()
        scanner.write(plaintext)
        remainingFrames -= 1
        if (remainingFrames > 0 && performance.now() >= yieldDeadline) {
          await scheduler.yield()
          signal?.throwIfAborted()
          yieldDeadline = performance.now() + ZSTD_DECODE_YIELD_INTERVAL_MS
        }
      }
      signal?.throwIfAborted()
      const complete = scanner.checkpoint()
      if (complete.committedBytes !== complete.inputBytes) {
        throw new Error('corrupt Zstandard session log: complete frame contains a torn JSONL record')
      }
      if (tornStart === undefined) {
        const prefix = scanner.finish()
        return {
          meta: prefix.meta,
          inheritedEventCount: prefix.inheritedEventCount,
          events: prefix.events,
          tornTruncateTo: undefined,
          recoveredTail: [],
        }
      }
      // 末尾撕裂帧的那次追加从未 resolve，但已刷入其中的完整 JSONL 记录
      // 是真实的已发出事件：恢复它们，并让写入路径截断撕裂字节、
      // 持久地重写它们。
      let recoveredPlaintext: Buffer = Buffer.alloc(0)
      try {
        signal?.throwIfAborted()
        recoveredPlaintext = await decompressZstdPrefix(buffer.subarray(tornStart))
      } catch {
        /* v8 ignore next -- 解码失败叠加并发中止取决于时序 */
        if (signal?.aborted) signal.throwIfAborted()
        // 结构上不完整的末尾帧可能还没等 Node 的解码器产出任何明文就结束；
        // 之前完整的那些帧仍然可恢复。
      }
      signal?.throwIfAborted()
      scanner.write(recoveredPlaintext)
      const prefix = scanner.finish()
      return {
        meta: prefix.meta,
        inheritedEventCount: prefix.inheritedEventCount,
        events: prefix.events,
        tornTruncateTo: tornStart,
        recoveredTail: prefix.events.slice(complete.eventCount),
      }
    } catch (error) {
      /* v8 ignore next -- 解码失败叠加并发中止取决于时序 */
      if (signal?.aborted) signal.throwIfAborted()
      throw error
    } finally {
      decoder.close()
    }
  }

  /** 枚举已选中的物理代际，不解释其头部或事件体。 */
  private async listGenerations(signal?: AbortSignal): Promise<ResolvedJsonlGeneration[]> {
    const selected = await this.mapSessionDirectories((dir) => {
      signal?.throwIfAborted()
      return this.resolveGenerationInDirectory(dir, signal)
    }, signal)
    return selected.filter(source => source !== undefined)
  }

  /**
   * 通过共享的列举限流器把 `task` 应用到每个 Session 目录。结果与首个失败
   * 都遵循“先项目后目录”的顺序；某个项目列举失败时，遍历会在它之前那些
   * 项目的目录之后终止。
   * @param task - 针对每个目录的操作；不得等待列举限流器。
   * @param signal - 可选取消信号，用于目录列举。
   * @returns 按遍历顺序排列的、每个目录的结果。
   */
  private async mapSessionDirectories<R>(
    task: (dir: string) => Promise<R>,
    signal?: AbortSignal,
  ): Promise<R[]> {
    const limit = this.listLimit
    // 根目录读取与其它所有列举读取共享同一个上限。
    const projectDirs = await limit(() => this.listProjectDirs(signal))
    const projects = await settleLimited(limit, projectDirs, project => this.listSessionDirs(project, signal))
    const dirs: string[] = []
    let projectFailure: PromiseRejectedResult | undefined
    for (const outcome of projects) {
      if (outcome.status === 'rejected') {
        projectFailure = outcome
        break
      }
      // 逐个追加：把一个大项目展开为调用实参会超出引擎的实参个数上限。
      for (const dir of outcome.value) dirs.push(dir)
    }
    const results = settledValues(await settleLimited(limit, dirs, task))
    if (projectFailure !== undefined) throw projectFailure.reason
    return results
  }

  /** 历史逻辑事件依赖于整个语料，包括那些头部不可读的成员。 */
  private async historicalCorpusRevision(signal?: AbortSignal): Promise<string> {
    const paths = (await this.listGenerations(signal)).map(source => source.sourcePath).sort()
    const entries = settledValues(await settleLimited(this.listLimit, paths, async (path) => {
      signal?.throwIfAborted()
      try {
        return { path, revision: fileRevision(await stat(path, { bigint: true })) }
      } catch (error: unknown) {
        if (!isENOENT(error)) throw error
        return { path, revision: 'missing' }
      }
    }))
    const hash = createHash('sha256')
    for (const { path, revision } of entries) hash.update(JSON.stringify([path, revision]))
    signal?.throwIfAborted()
    return hash.digest('hex')
  }

  private async listArtifacts(
    signal?: AbortSignal,
  ): Promise<Array<GenerationHeader & { path: string; sourceVersion: number }>> {
    signal?.throwIfAborted()
    await this.ensureRootEncoding()
    signal?.throwIfAborted()
    const generations = await this.listGenerations(signal)
    const headers = await settleLimited(this.listLimit, generations, async (selected) => {
      signal?.throwIfAborted()
      try {
        return { selected, metadata: await this.readGenerationHeader(selected, undefined, signal) }
      } catch (error: unknown) {
        if (error instanceof SessionFormatUnsupportedError || error instanceof SessionPersistenceCorruptionError) {
          return { selected, metadata: undefined }
        }
        throw error
      }
    })
    const artifacts: Array<GenerationHeader & { path: string; sourceVersion: number }> = []
    const ids = new Set<SessionId>()
    for (const outcome of headers) {
      if (outcome.status === 'rejected') throw outcome.reason
      const { selected, metadata } = outcome.value
      if (metadata === undefined) continue
      if (ids.has(metadata.header.id)) {
        throw new Error(`duplicate JSONL session id "${metadata.header.id}" appears in multiple project directories`)
      }
      ids.add(metadata.header.id)
      artifacts.push({ ...metadata, path: selected.sourcePath, sourceVersion: selected.sourceVersion })
    }
    signal?.throwIfAborted()
    return artifacts
  }

  /** 读取并翻译一个已选代际的头部，不检查其事件体。 */
  private async readGenerationHeader(
    selected: ResolvedJsonlGeneration,
    expectedId?: SessionId,
    signal?: AbortSignal,
  ): Promise<GenerationHeader | undefined> {
    let first: string | undefined
    try {
      first = this.compression === 'zstd'
        ? await this.readFirstZstdLine(selected.sourcePath, signal)
        : await this.readFirstLine(selected.sourcePath, signal)
    } catch (error: unknown) {
      signal?.throwIfAborted()
      if (isENOENT(error)) return undefined
      throw error
    }
    signal?.throwIfAborted()
    if (first === undefined) return undefined
    let value: unknown
    try {
      value = JSON.parse(first)
    } catch {
      return undefined
    }
    assertNoRetiredHeaderFields(value)
    const result = sessionFormatCatalog.readHeader(value)
    if ('storedVersion' in result && result.storedVersion !== selected.sourceVersion) {
      throw new Error(
        `session generation filename identifies v${selected.sourceVersion}, `
        + `but its header identifies v${result.storedVersion}`,
      )
    }
    if (result.status === 'unsupported') {
      const physicalId = String((value as { id?: unknown }).id)
      let reason = result.reason
      /* v8 ignore else -- 已发布的历史头部迁移在物理解码之后无法拒绝。 */
      if (result.storedVersion > SESSION_FORMAT_VERSION) {
        reason = sessionFormatVersionRefusal(physicalId, result.storedVersion)
      }
      throw new SessionFormatUnsupportedError(
        `${reason} (raw log: ${selected.sourcePath})`,
        { kind: 'jsonl', path: selected.sourcePath },
      )
    }
    if (result.status === 'malformed') return undefined
    const header = this.currentHeader(result.header)
    await this.assertStoredIdentity(
      selected.sourcePath,
      selected.sourceVersion,
      header,
      expectedId,
      signal,
    )
    return {
      header,
      formatStatus: result.status,
    }
  }

  /** 把格式目录的字符串身份转换为当前带品牌的 Session 元数据。 */
  private currentHeader(header: {
    readonly version: number
    readonly id: string
    readonly createdAt: number
    readonly cwd?: string
    readonly parentSession?: string
    readonly isSeeded: boolean
    readonly origin?: 'subagent'
    readonly delegationDepth: number
    readonly agentPreset?: string
  }): SessionHeader {
    /* v8 ignore next 3 -- 可读的目录结果会被恢复到其所配置的当前版本。 */
    if (header.version !== SESSION_FORMAT_VERSION) {
      throw new Error(`format catalog returned non-current logical header v${header.version}`)
    }
    return {
      version: SESSION_FORMAT_VERSION,
      id: makeSessionId(header.id),
      createdAt: header.createdAt,
      ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
      ...(header.parentSession === undefined
        ? {}
        : { parentSession: makeSessionId(header.parentSession) }),
      isSeeded: header.isSeeded,
      ...(header.origin === undefined ? {} : { origin: header.origin }),
      delegationDepth: header.delegationDepth,
      ...(header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset }),
    }
  }

  // --- 物化 / 追加 / 修复（文件机制）---

  /** 原子地写入头部行 + 首批事件（临时写入、fsync、发布）。 */
  private async materialize(
    meta: SessionHeader,
    inheritedEventCount: SessionLogOffsetType,
    events: readonly SessionEvent[],
  ): Promise<void> {
    const project = projectDir(this.root, meta.cwd)
    const dir = sessionDir(this.root, meta.cwd, meta.id)
    const finalPath = logPath(this.root, meta.cwd, meta.id, this.compression)
    await this.rejectOppositeArtifact(meta.cwd, meta.id)
    const content = await this.encodeMaterialization(meta, inheritedEventCount, events)
    /* v8 ignore next -- 原生 Windows 覆盖会测到这个平台分发；Linux 覆盖对应的 POSIX 分支 */
    if (process.platform === 'win32') {
      await this.materializeWin32(project, dir, finalPath, meta.id, content)
    } else {
      await this.materializePosix(project, dir, finalPath, meta.id, content)
    }
  }

  /* v8 ignore start -- Windows 使用 Win32 的持久发布路径；POSIX 覆盖负责测这个对应分支。 */
  private async materializePosix(
    project: string,
    dir: string,
    finalPath: string,
    id: SessionId,
    content: Buffer | string,
  ): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await this.syncDirPosix(dirname(this.root))
    await mkdir(project, { recursive: true, mode: 0o700 })
    await this.syncDirPosix(this.root)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await this.syncDirPosix(project)
    await this.rejectExistingLog(finalPath, id)
    const tmp = await this.writeSyncedTempFile(finalPath, content)
    // 通过 link()+unlink() 发布，而不是 rename()：若最终路径已存在，
    // link 会以 EEXIST 失败，因此两个并发物化同一 id 的进程不会互相覆盖。
    // rename() 则会静默覆盖。
    let linked = false
    try {
      await link(tmp, finalPath)
      linked = true
    } finally {
      // 失败时删除一个未发布的临时文件。发布之后，把清理推迟到目录项
      // 变持久之后，这样清理不会拒绝一个活跃的日志。
      /* v8 ignore next -- link 失败是上面已守卫的 TOCTOU/IO 竞态；测试中不可达 */
      if (!linked) await rm(tmp, { force: true })
    }
    // link() 已成功——日志已发布。fsync 该目录，使新的目录项能在掉电后
    // 存活：在父目录的元数据被同步之前，新链接不具备崩溃持久性。
    await this.syncDirPosix(dir)
    // 尽力而为的临时文件清理：日志已发布且持久，因此删除多余临时硬链接失败
    // 绝不能让这次追加拒绝。只吞掉 rm 的失败；此处没有其它要紧的操作。
    try {
      await rm(tmp, { force: true })
    } catch {
      /* v8 ignore next -- 多余的临时链接；发布已持久，rm 失败是一条不可达的 IO 边界 */
    }
  }
  /* v8 ignore stop */

  /* v8 ignore start -- 原生 Windows 覆盖会测到这条集成路径 */
  private async materializeWin32(
    project: string,
    dir: string,
    finalPath: string,
    id: SessionId,
    content: Buffer | string,
  ): Promise<void> {
    await ensureDurableDirectoryWin32(this.root)
    await ensureDurableDirectoryWin32(project)
    await ensureDurableDirectoryWin32(dir)
    await this.rejectExistingLog(finalPath, id)
    const tmp = await this.writeSyncedTempFile(finalPath, content)
    try {
      await publishNewFileWin32(tmp, finalPath)
    } catch (error) {
      await rm(tmp, { force: true })
      throw error
    }
  }
  /* v8 ignore stop */

  private async rejectExistingLog(finalPath: string, id: SessionId): Promise<void> {
    // 绝不覆盖一个已存在的已提交日志：materialize 是后端认为是新会话的
    // 首次写入。此处存在文件意味着磁盘上有另一个会话共用该 id——
    // 要响亮地拒绝。（create 已守卫创建路径，因此这里实际上是
    // 不可达的 TOCTOU 防御。）
    /* v8 ignore next 3 -- create 在 materialize 之前就守卫了冲突；这里是一道 TOCTOU 兜底 */
    if (await this.resolveGenerationInDirectory(dirname(finalPath)) !== undefined) {
      throw new Error(`refusing to materialize "${id}": a log already exists on disk (open it instead)`)
    }
  }

  private async writeSyncedTempFile(finalPath: string, content: Buffer | string): Promise<string> {
    const tmp = `${finalPath}.${randomBytes(6).toString('hex')}.tmp`
    const handle = await open(tmp, 'wx', 0o600)
    try {
      await handle.writeFile(content)
      await handle.sync()
    } finally {
      await handle.close()
    }
    return tmp
  }

  /** 编码头部与首批事件，不合并二者的帧边界。 */
  private async encodeMaterialization(
    meta: SessionHeader,
    inheritedEventCount: SessionLogOffsetType,
    events: readonly SessionEvent[],
  ): Promise<Buffer | string> {
    const header = JSON.stringify(toHeaderLine(meta, meta.isSeeded ? inheritedEventCount : undefined)) + '\n'
    if (events.length === 0) {
      return this.compression === 'none' ? header : compressZstdFrame(header)
    }
    const body = eventLines(events) + '\n'
    if (this.compression === 'none') return header + body
    const headerFrame = await compressZstdFrame(header)
    const eventFrame = await compressZstdFrame(body)
    return Buffer.concat([headerFrame, eventFrame])
  }

  /** 以已配置的物理表示编码一个持久追加批次。 */
  private async encodeEventBatch(events: readonly SessionEvent[]): Promise<Buffer | string> {
    const body = eventLines(events) + '\n'
    return this.compression === 'zstd' ? compressZstdFrame(body) : body
  }

  /** fsync 一个 POSIX 目录，使刚创建/重命名的条目具备崩溃持久性。 */
  /* v8 ignore start -- Windows 使用直写式命名空间操作；POSIX 覆盖负责测目录 fsync。 */
  private async syncDirPosix(dir: string): Promise<void> {
    const handle = await open(dir, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
  /* v8 ignore stop */

  /**
   * 追加并 fsync 事件行。发生部分写入或同步失败时，在重新抛出之前恢复
   * 先前的大小，因为未变化的游标会重试该批次；留下部分字节会造成
   * 重复的序号。
   */
  private async appendLines(meta: SessionHeader, events: readonly SessionEvent[]): Promise<void> {
    const content = await this.encodeEventBatch(events)
    const path = logPath(this.root, meta.cwd, meta.id, this.compression)
    const handle = await open(path, 'a')
    let closed = false
    const closeAppendHandle = async (): Promise<void> => {
      if (closed) return
      closed = true
      await handle.close()
    }

    try {
      const { size: before } = await handle.stat()
      try {
        await handle.writeFile(content)
        await handle.sync()
      } catch (error) {
        try {
          await closeAppendHandle()
          await this.rollbackAppend(path, before)
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], `failed to roll back append to "${path}"`)
        }
        throw error
      }
    } finally {
      await closeAppendHandle()
    }
  }

  private async rollbackAppend(path: string, size: number): Promise<void> {
    const handle = await open(path, 'r+')
    try {
      await handle.truncate(size)
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  /** 把日志文件截断到 `offset` 字节并 fsync（丢弃崩溃尾部）。 */
  private async repair(meta: SessionHeader, offset: number): Promise<void> {
    const path = logPath(this.root, meta.cwd, meta.id, this.compression)
    await truncate(path, offset)
    const handle = await open(path, 'r+')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  // --- 发现辅助函数 ---

  /**
   * 读取某个文件首个以换行结尾的行，不加载整个文件。当文件为空或没有
   * 完整的首行时返回 undefined。以有界块读取，因此一个巨大的日志
   * 只需付出读取头部的代价。
   */
  private async readFirstLine(path: string, signal?: AbortSignal): Promise<string | undefined> {
    signal?.throwIfAborted()
    const handle = await open(path, 'r')
    try {
      signal?.throwIfAborted()
      const chunks: Buffer[] = []
      const buf = Buffer.alloc(8192)
      for (;;) {
        signal?.throwIfAborted()
        const { bytesRead } = await handle.read(buf, 0, buf.length, null)
        signal?.throwIfAborted()
        if (bytesRead === 0) return undefined // 遇到 EOF 但没有换行 → 没有完整的行
        const slice = buf.subarray(0, bytesRead)
        const nl = slice.indexOf(0x0a)
        if (nl !== -1) {
          chunks.push(slice.subarray(0, nl))
          signal?.throwIfAborted()
          return Buffer.concat(chunks).toString('utf8')
        }
        chunks.push(Buffer.from(slice))
      }
    } finally {
      await handle.close()
    }
  }

  /** 只读取头部帧；压缩失败按损坏拒绝，而 I/O 与取消则向上传播。 */
  private async readFirstZstdLine(path: string, signal?: AbortSignal): Promise<string | undefined> {
    signal?.throwIfAborted()
    const handle = await open(path, 'r')
    try {
      signal?.throwIfAborted()
      let content = Buffer.alloc(0)
      const chunk = Buffer.alloc(8192)
      for (;;) {
        signal?.throwIfAborted()
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
        signal?.throwIfAborted()
        if (bytesRead === 0) return undefined
        signal?.throwIfAborted()
        content = Buffer.concat([content, chunk.subarray(0, bytesRead)])
        signal?.throwIfAborted()
        try {
          const first = scanZstdFrames(content, 1).frames[0]
          if (first === undefined) continue
          const plaintext = await decompressZstdFrame(content.subarray(first.start, first.end))
          signal?.throwIfAborted()
          assertZstdHeaderFrame(plaintext)
          return plaintext.subarray(0, -1).toString('utf8')
        } catch (error) {
          /* v8 ignore next -- 解码失败叠加并发中止取决于时序 */
          if (signal?.aborted) signal.throwIfAborted()
          throw new SessionPersistenceCorruptionError(
            `corrupt Zstandard session log: header frame failed validation: ${String(error)} (raw log: ${path})`,
            { cause: error },
          )
        }
      }
    } finally {
      await handle.close()
    }
  }

  /** 在某个 Session 目录中选择数值最高的规范代际。 */
  private async resolveGenerationInDirectory(
    dir: string,
    signal?: AbortSignal,
  ): Promise<ResolvedJsonlGeneration | undefined> {
    signal?.throwIfAborted()
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error: unknown) {
      if (isENOENT(error)) return undefined
      throw error
    }
    signal?.throwIfAborted()
    const generations: Array<{ readonly path: string; readonly version: number }> = []
    const opposite: string[] = []
    for (const entry of entries) {
      const version = parseGenerationLogFilename(entry.name, this.compression)
      if (version !== undefined) {
        generations.push({ path: join(dir, entry.name), version })
        continue
      }
      if (parseGenerationLogFilename(entry.name, this.oppositeCompression()) !== undefined) {
        opposite.push(join(dir, entry.name))
      }
    }
    if (opposite.length > 0) throw this.encodingMismatch(opposite[0] as string)
    const latest = generations.sort((left, right) => right.version - left.version)[0]
    if (latest === undefined) return undefined
    return {
      sourcePath: latest.path,
      sourceVersion: latest.version,
      currentPath: join(
        dir,
        generationLogFilename(sessionFormatCatalog.currentVersion, this.compression),
      ),
    }
  }

  /** 跨项目目录查找某个 id 对应的唯一权威代际。 */
  private async findLog(id: SessionId, signal?: AbortSignal): Promise<ResolvedJsonlGeneration | undefined> {
    const matches: ResolvedJsonlGeneration[] = []
    for (const project of await this.listProjectDirs(signal)) {
      signal?.throwIfAborted()
      await this.rejectLegacyFlatArtifact(project, id, signal)
      signal?.throwIfAborted()
      const dir = join(project, encodeSegment(id))
      const selected = await this.resolveGenerationInDirectory(dir, signal)
      if (selected !== undefined) matches.push(selected)
    }
    if (matches.length > 1) {
      throw new Error(`duplicate JSONL session id "${id}" appears in multiple project directories`)
    }
    signal?.throwIfAborted()
    return matches[0]
  }

  /** 要求一个已配置的根目录（若存在）是可读目录。 */
  private assertUsableRoot(): void {
    try {
      readdirSync(this.root)
    } catch (error) {
      if (isENOENT(error)) return
      throw error
    }
  }

  /** 拒绝不能标识所选物理日志的元数据。 */
  private async assertStoredIdentity(
    path: string,
    storedVersion: number,
    meta: SessionHeader,
    expectedId?: SessionId,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted()
    if (expectedId !== undefined && meta.id !== expectedId) {
      throw new Error(`corrupt session log "${path}": requested id "${expectedId}" does not match header id "${meta.id}"`)
    }
    let expectedPath: string
    try {
      expectedPath = generationLogPath(
        this.root,
        meta.cwd,
        meta.id,
        storedVersion,
        this.compression,
      )
    } catch (error) {
      throw new Error(`corrupt session log "${path}": header id cannot name a storage path`, { cause: error })
    }
    if (path !== expectedPath && !await this.sameFile(path, expectedPath, signal)) {
      throw new Error(`corrupt session log "${path}": header id "${meta.id}" and cwd identify "${expectedPath}"`)
    }
    signal?.throwIfAborted()
  }

  /** 对照所选源路径校验一个受支持的历史头部。 */
  private validateSourceIdentity(
    selected: ResolvedJsonlGeneration,
    headerValue: Readonly<Record<string, unknown>>,
    expectedId: SessionId,
    signal?: AbortSignal,
  ): void | Promise<void> {
    const result = sessionFormatCatalog.readHeader(headerValue)
    if (result.status !== 'current' && result.status !== 'migration-required') return
    return this.assertStoredIdentity(
      selected.sourcePath,
      selected.sourceVersion,
      this.currentHeader(result.header),
      expectedId,
      signal,
    )
  }

  /**
   * 判断两种路径写法是否解析到同一个物理文件。这在大小写不敏感的文件系统上
   * 接纳大小写别名，同时不会削弱大小写敏感存储上的身份检查。
   */
  private async sameFile(path: string, expectedPath: string, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted()
    try {
      const [actual, expected] = await Promise.all([realpath(path), realpath(expectedPath)])
      signal?.throwIfAborted()
      return actual === expected
    } catch (error) {
      signal?.throwIfAborted()
      /* v8 ignore else -- 非 ENOENT 的 realpath 失败需要外部的权限或 I/O 故障 */
      if (isENOENT(error)) return false
      /* v8 ignore next -- 非 ENOENT 的 realpath 失败是外部 I/O 故障，原样向上传播 */
      throw error
    }
  }

  /** 已配置根目录下人类可读的项目目录。 */
  private async listProjectDirs(signal?: AbortSignal): Promise<string[]> {
    try {
      signal?.throwIfAborted()
      const entries = await readdir(this.root, { withFileTypes: true })
      signal?.throwIfAborted()
      return entries.filter(e => e.isDirectory()).map(e => join(this.root, e.name))
    } catch (error) {
      // 只有根目录不存在才意味着没有会话；其它所有 I/O 失败都要重新抛出。
      if (isENOENT(error)) return []
      throw error
    }
  }

  /** 列出会话拥有的目录，并拒绝已废弃的扁平文件布局。 */
  private async listSessionDirs(project: string, signal?: AbortSignal): Promise<string[]> {
    signal?.throwIfAborted()
    const entries = await readdir(project, { withFileTypes: true })
    signal?.throwIfAborted()
    const legacy = entries.find(entry =>
      entry.isFile() && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.zstd')))
    if (legacy !== undefined) throw this.legacyLayout(join(project, legacy.name))
    return entries.filter(entry => entry.isDirectory()).map(entry => join(project, entry.name))
  }

  /** 拒绝一个已属于另一种物理编码方式的根目录。 */
  private ensureRootEncoding(): Promise<void> {
    this.rootEncodingCheck ??= this.checkRootEncoding()
    return this.rootEncodingCheck
  }

  private async checkRootEncoding(): Promise<void> {
    await this.mapSessionDirectories(async (dir) => {
      const incompatible = await this.findOppositeGenerationInDirectory(dir)
      if (incompatible !== undefined) throw this.encodingMismatch(incompatible)
    })
  }

  private async rejectLegacyFlatArtifact(
    project: string,
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted()
    const encoded = encodeSegment(id)
    for (const compression of ['zstd', 'none'] as const) {
      const path = join(project, encoded + logSuffix(compression))
      const artifactExists = await this.exists(path)
      signal?.throwIfAborted()
      if (artifactExists) throw this.legacyLayout(path)
    }
  }

  private async rejectOppositeArtifact(cwd: string | undefined, id: SessionId): Promise<void> {
    const path = await this.findOppositeGenerationInDirectory(sessionDir(this.root, cwd, id))
    if (path !== undefined) throw this.encodingMismatch(path)
  }

  /** 返回以另一种已配置后缀编码的、数值最高的规范代际。 */
  private async findOppositeGenerationInDirectory(dir: string): Promise<string | undefined> {
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error: unknown) {
      if (isENOENT(error)) return undefined
      throw error
    }
    const generations: Array<{ readonly name: string; readonly version: number }> = []
    for (const entry of entries) {
      const version = parseGenerationLogFilename(entry.name, this.oppositeCompression())
      if (version !== undefined) generations.push({ name: entry.name, version })
    }
    const latest = generations.sort((left, right) => right.version - left.version)[0]
    return latest === undefined ? undefined : join(dir, latest.name)
  }

  private oppositeCompression(): JsonlCompression {
    return this.compression === 'zstd' ? 'none' : 'zstd'
  }

  private encodingMismatch(path: string): Error {
    return new Error(
      `session artifact ${JSON.stringify(path)} uses ${logSuffix(this.oppositeCompression())}, `
      + `but this backend is configured for compression ${JSON.stringify(this.compression)}; `
      + 'use a separate root or select the matching compression mode',
    )
  }

  private legacyLayout(path: string): Error {
    return new Error(
      `session artifact ${JSON.stringify(path)} uses the unsupported flat-file layout; `
      + 'use a separate root or move it into a project/session directory before loading',
    )
  }

  private async exists(path: string): Promise<boolean> {
    try {
      const handle = await open(path, 'r')
      await handle.close()
      return true
    } catch (error) {
      // 只有 ENOENT 表示不存在。权限/I/O 错误必须浮出水面，而不能让加载
      // 或冲突检查在“假缺失”的前提下继续。
      /* v8 ignore else -- Windows 把文件型父路径报告为 ENOENT；POSIX 覆盖直接的 ENOTDIR。 */
      if (isENOENT(error)) {
        // 对于 `普通文件/子路径`，Windows 报告 ENOENT 而非 ENOTDIR，因此只有
        // 它会校验直接父路径，以便把被阻塞的会话目录仍视为存储故障。
        // POSIX 的 open 在此之前就已报告 ENOTDIR，在那里多一次 stat
        // 只会让每次探测多花一个系统调用。
        /* v8 ignore next -- 原生 Windows 覆盖会测到这个平台分发；POSIX 由 open 报告 ENOTDIR */
        if (process.platform === 'win32') await this.assertLogParentAllowsAbsence(path)
        return false
      }
      /* v8 ignore next -- Windows 在上面从 ENOENT 修复 ENOTDIR；POSIX 覆盖直接的 ENOTDIR。 */
      throw error
    }
  }

  /* v8 ignore start -- 原生 Windows 覆盖会测到这个修复；POSIX 的 open 在此之前已报告 ENOTDIR。 */
  private async assertLogParentAllowsAbsence(path: string): Promise<void> {
    try {
      const parent = dirname(path)
      const info = await stat(parent)
      if (info.isDirectory()) return
      const error = new Error(`ENOTDIR: parent path exists but is not a directory: ${parent}`) as NodeJS.ErrnoException
      error.code = 'ENOTDIR'
      error.path = parent
      throw error
    } catch (error) {
      if (isENOENT(error)) return
      throw error
    }
  }
  /* v8 ignore stop */
}

/** JSONL 持久化插件标签。 */
export const name = 'session-persistence-jsonl'

/** 后端的根目录、物理编码与列举并发度的加载器 schema。 */
export const Config: z<Config> = z.object({
  root: z.string().required(),
  compression: JsonlCompressionSchema,
  listConcurrency: z.natural().min(1).default(DEFAULT_LIST_CONCURRENCY),
})

/**
 * 挂载持久化，并在移除本提供方所触发的消费方卸载期间保留实时路由与句柄。
 * 消费方必须在自己的注入作用域内拥有清理逻辑；并发的根处置没有顺序保证。
 * @param ctx - 所属的插件上下文。
 * @param config - 存储根目录、物理编码与列举并发度。
 * @returns 当服务就绪时 resolve。
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  let service!: Fiber
  // 保持这个生成器同步，这样 thenable 形式的 disposer 会以函数形式注册，而不会被 await。
  ctx.effect(function* () {
    const tracker = new JsonlBackendTracker(name)
    yield tracker.install(ctx)
    service = ctx.plugin({
      name: 'session-persistence-jsonl-service',
      apply(serviceCtx: Context) {
        new JsonlSessionPersistence(serviceCtx, config, tracker)
      },
    })
    yield service.dispose
  }, 'session-persistence-jsonl resources')
  await service.await()
}
