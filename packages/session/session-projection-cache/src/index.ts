/**
 * 持久化的投影缓存（`ctx.sessionProjectionCache`）：每个投影单元状态的
 * 持久检查点，在 `session_projcache` 领域上每个会话一条记录（`per-record`
 * 布局——所发布的 json 后端在其根目录下为每个会话存一个文档）。读取与
 * 写入共享同一份连贯状态：领域的在内存表以同步方式服务每次读取，而每次
 * 写入都落在领域的写入链上（先持久，后内存），因此一次读取永远不可能
 * 观察到内存尚未应用的磁盘写入，也不可能观察到磁盘并不持有的内存值。
 * 缓存是一条折叠捷径，而非权威：一行可能过时（其 `seq` 说明有多过时），
 * 但绝不会错误，因此每条写入路径都是失败软化的（一次丢失的写入只会在
 * 下次冷读时多花一次尾部重放），而 `ver` 不匹配会丢弃该行，而非迁移它。
 * 设计权威：session-projection RFC
 * (.agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.md)。
 * @module @deepseek-ai/dsh-session-projection-cache
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type {
  Session,
  SessionEvent,
  SessionHeader,
  SessionId,
} from '@deepseek-ai/dsh-session'
import type {
  ProjectionCheckpoint,
  ProjectionSnapshot,
  SessionProjectionMap,
} from '@deepseek-ai/dsh-session-projection'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { projectionCacheDomainSpec } from './spec.ts'
import type { CheckpointIdentity, CheckpointRecord } from './spec.ts'

/**
 * 仅由一个会话头部所能见证的身份：折叠必定运行于其下的格式代际，以及
 * 用于区分存储在某个会话 id 下的不同生命周期的字段。只读的列举面精确
 * 匹配于此。
 */
type LifecycleIdentity = Omit<CurrentCheckpointIdentity, 'inheritedEventCount'>

/**
 * 由当前缓存代际写入的完整身份：生命周期身份，加上精确的继承切点——
 * 后者只有持有会话或其事件体的调用方才知道。折叠面（水合、检查点写入）
 * 匹配于此。
 */
type CurrentCheckpointIdentity = CheckpointIdentity & {
  formatVersion: number
  isSeeded: boolean
  inheritedEventCount: SessionLogOffset
}

const PREDECESSOR_TITLE_KEY = 'title' as Extract<keyof SessionProjectionMap, string>

export { checkpointIdentity, checkpointRecord, checkpointRow, projectionCacheDomainSpec } from './spec.ts'
export type { CheckpointIdentity, CheckpointRecord } from './spec.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionProjectionCache: SessionProjectionCache
  }
}

/**
 * 插件配置。两个节流触发器都是部署选择，没有普遍正确的取值，因此组合在
 * （cordis.yml）中显式声明；三个强制写入点（会话创建、`turn/end` 与会话
 * 处置）是策略而非可调参数，总会触发。
 */
export interface Config {
  /** 每个会话在强制点之间、足以强制一次持久检查点写入的已提交事件数。 */
  writeEveryEvents: number
  /** 一个脏检查点在强制点之间可能保持未写入的最长时间（毫秒）。 */
  writeIntervalMs: number
}

export const Config: z<Config> = z.object({
  writeEveryEvents: z.natural().min(1).required(),
  writeIntervalMs: z.natural().min(1).required(),
})

/** Per-session write-behind bookkeeping (live sessions only; dropped at retire). */
interface DirtyState {
  /** Committed events since the last durable write. */
  pending: number
  /** Interval trigger armed at the first dirty event after a clean write. */
  timer: ReturnType<typeof setTimeout> | undefined
}

/**
 * The persisted projection cache service. Opens the `session_projcache`
 * domain at init, checkpoints live sessions on a throttled write-behind
 * (count/interval triggers from {@link Config}) plus three mandatory points —
 * session creation, `turn/end`, and session disposal (the live-to-cold
 * moment) — and serves the
 * cached rows for a session header. Every durable write is fail-soft:
 * failures log a warning and the cache self-heals on the next write.
 */
export class SessionProjectionCache extends Service {
  static inject = ['storageDomain', 'sessionProjections', 'sessions']

  static Config: z<Config> = Config

  private table?: KvTable<SessionId, CheckpointRecord>
  private readonly dirty = new Map<Session, DirtyState>()

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'sessionProjectionCache')
  }

  /** 打开领域并安装写回监听器。 */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(projectionCacheDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'sessionProjectionCache.domainClose')
    this.table = domain.table('sessions')
    this.installWritePath()
  }

  /**
   * 某个会话的已存储记录，仅当其绑定的日志身份与 `expected` 匹配时才被接受。
   * 会话 id 命名的是一个槽位，而非生命周期：一个被重建的 id，或一个在存活
   * 缓存之下被换掉的持久化存储，绝不能让一条旧记录以来自无关日志的状态作为
   * 种子。从领域的在内存状态同步读取——即每次写入所改动的同一份状态，因此
   * 一次读取绝不可能绕过写入链直达介质。
   * @param id - 被读取记录的会话。
   * @param expected - 调用方持有的日志身份（实时或已存储头部）。
   * @returns 身份匹配的记录，或 `undefined`（缺失或不相关）。
   */
  private recordFor(id: SessionId, expected: CurrentCheckpointIdentity): CheckpointRecord | undefined {
    const record = this.requireTable().get(id)
    if (record === undefined) return undefined
    return identityMatches(record.identity, expected) ? record : undefined
  }

  /**
   * 零 I/O 的列举读取：直接从绑定到调用方生命周期的那条记录的已存储行
   * （仅版本匹配的键）中查看完整值。头部是列举所持有的唯一身份见证，因此
   * 这个面匹配生命周期身份（`formatVersion`、`createdAt`、`cwd`、
   * `isSeeded`），而不匹配继承切点：在同一个格式代际内，切点是在 fork
   * 时刻固定的，因此它区分不出其它字段区分不出的生命周期，而且被查看的值
   * 永远不会作为种子去折叠。该视图与最后一次持久检查点一样过时，但绝不会
   * 错误，也绝不会来自无关的日志。其 `asOfSeq` 是所服务各行中的最低水位：
   * 即已存储记录自身的位置，而头部无法把它与调用方稍后打开的日志关联起来。
   * 因此会话列表把这块标记为已缓存，而客户端让所连接会话产生的每个值都
   * 覆盖它，无论这个数字是多少。
   * @param meta - 被列举会话的头部（身份见证；不读取日志）。
   * @param keys - 调用方受众可能需要的可选投影键。
   * @returns 被查看的块；当在当前会话格式下该生命周期不存在可用行时为
   *   `undefined`。
   */
  cachedSnapshot(
    meta: SessionHeader,
    keys?: readonly Extract<keyof SessionProjectionMap, string>[],
  ): ProjectionSnapshot | undefined {
    const expected = lifecycleIdentityOf(meta)
    const record = this.requireTable().get(meta.id)
    if (record === undefined || !currentLifecycleMatches(record.identity, expected)) return undefined
    return this.viewRecord(record, keys)
  }

  /**
   * Read only a predecessor checkpoint's title as a zero-I/O listing hint.
   *
   * The authoritative Session header supplies the lifecycle identity. A cache
   * checkpoint can lag that log but cannot lead it because writes flush the
   * log first, so a matching predecessor title is a genuine (possibly stale)
   * fact from this Session. The registry still requires the current title
   * projection's row version and schema. No other predecessor projection is
   * exposed: format normalization can change their current meaning, and the
   * {@link cachedSnapshot} / hydration paths continue to reject them.
   * @param meta - authoritative listed Session header.
   * @returns a title-only block at the stored title row's watermark, or
   *   `undefined` when the record is current, newer, unrelated, missing, or
   *   incompatible with the title unit.
   */
  cachedPredecessorTitle(meta: SessionHeader): ProjectionSnapshot | undefined {
    const expected = lifecycleIdentityOf(meta)
    const record = this.requireTable().get(meta.id)
    if (record === undefined || !predecessorIdentityMatches(record.identity, expected)) return undefined
    return this.viewRecord(record, [PREDECESSOR_TITLE_KEY])
  }

  /**
   * 把选中的 wire 行作为一块、绑定到最低的服务水位来查看：即每个被服务值
   * 至少已经折叠经过的 seq。这个数字属于记录自身；某个消费方能否把它与
   * 实时会话的 seq 比较，由服务这块的“面”决定，而非此处。
   */
  private viewRecord(
    record: CheckpointRecord,
    keys?: readonly Extract<keyof SessionProjectionMap, string>[],
  ): ProjectionSnapshot | undefined {
    const values = this.ctx.sessionProjections.viewCheckpoint(record.rows, keys)
    let asOfSeq: ProjectionSnapshot['asOfSeq'] | undefined
    for (const [key, row] of Object.entries(record.rows)) {
      if (!Object.hasOwn(values, key)) continue
      if (asOfSeq === undefined || row.seq < asOfSeq) asOfSeq = row.seq
    }
    return asOfSeq === undefined ? undefined : { asOfSeq, values }
  }

  /**
   * 在不另做一次持久化读取的情况下，为一个已经准备好的会话做投影 cell 的
   * 水合。缓存以匹配的行作为种子；所提供的精确日志把每个单元推进到观测
   * 切面。不写入检查点，因为逻辑观测可能包含尚未持久的恢复事件。
   * @param session - 由持久化层保留的、精确的未发布会话。
   * @param events - 由该观测所代表的精确逻辑事件前缀。
   * @returns 在事件切面上的所有投影值。
   */
  hydratePrepared(
    session: Session,
    events: readonly SessionEvent[],
  ): ProjectionSnapshot {
    const record = this.recordFor(
      session.id,
      identityOf(session.header, session.inheritedEventCount),
    )
    if (record === undefined) {
      return this.ctx.sessionProjections.hydrate(session, {}, events, SessionLogOffset(0))
    }
    try {
      return this.ctx.sessionProjections.hydrate(
        session,
        record.rows,
        events,
        SessionLogOffset(0),
      )
    } catch {
      // 缓存行是可丢弃的派生数据。从精确日志重试，这样过时的 schema 不会
      // 让一个有效的会话变得不可读。
      return this.ctx.sessionProjections.hydrate(session, {}, events, SessionLogOffset(0))
    }
  }

  /**
   * 立即对一个活跃会话做持久检查点（所有强制点都调用这个；测试与载体
   * 也可能调用）。注册表切面在此边界处被快照（状态是实时引用），随后该
   * 会话的记录在领域的写入链上被替换。不是失败软化的——失败软化路径上的
   * 调用方把它包了起来。
   * @param session - 被做检查点的活跃会话。
   * @returns 在持久性与事件发出之后的结算。
   */
  async write(session: Session): Promise<void> {
    const rows = this.ctx.sessionProjections.checkpoint(session)
    this.markClean(session)
    // 持久性屏障：检查点切面已经在上面取得，因此在它之后刷新可以保证
    // 切面内的每个事件都在缓存行落地之前被持久记录——一次崩溃可能让
    // 缓存落后于日志（更长的尾部重放），却绝不会让它领先于日志（从任何
    // 已存储日志都不包含的事件中折叠出的幻影值）。在 detach 时存储条目
    // 已经消失；持久化自身的退役排空覆盖了那条路径，而任何残留的越界
    // 都会被冷读那带锚点的下限捕获。
    if (this.ctx.sessions.get(session.id) === session) await this.ctx.sessions.flush(session)
    await this.put(
      session.id,
      identityOf(session.header, session.inheritedEventCount),
      rows,
    )
  }

  /**
   * 从一个会话的完整日志中冷读其投影。每个单元都从经过身份检查的缓存行
   * 中播种——注册表会跳过对已经折叠过的前缀（即 seq 在该行 `seq` 处或更低
   * 的事件）应用 `apply`——而刷新过的检查点会被写回（失败软化、即发即忘），
   * 因此第一次冷读创建缓存行，之后的冷读从它播种。调用方按 seq 顺序提供
   * 完整的日志：本服务从不咨询持久化层。
   * @param meta - 已存储的会话头部（身份见证）。
   * @param inheritedEventCount - 用于投影初始化与身份的精确继承前缀长度。
   * @param events - 会话的完整日志，按 seq 顺序。
   * @returns 在日志末端的投影切面。
   */
  coldSnapshot(
    meta: SessionHeader,
    inheritedEventCount: SessionLogOffset,
    events: readonly SessionEvent[],
  ): ProjectionSnapshot {
    const identity = identityOf(meta, inheritedEventCount)
    const restored = this.ctx.sessionProjections.restore(
      this.recordFor(meta.id, identity)?.rows ?? {},
      events,
      SessionLogOffset(0),
      meta,
      inheritedEventCount,
    )
    // 刷新该行以便下次冷读从它播种；失败软化且即发即忘——一次失败的写回
    // 只会多花一次尾部重放。
    void this.put(meta.id, identity, restored.checkpoint).catch((error: unknown) => {
      this.ctx.logger.warn(`session projection cache: cold-read write-back for "${meta.id}" failed (cache stays stale): ${String(error)}`)
    })
    return restored.snapshot
  }


  // --- 写回（节流 + 强制点）---

  private installWritePath(): void {
    // 每个已提交事件都会推进脏计数器；turn/end 是一个强制点（大多数读取
    // 想要的持久值就是回合最终的那个），计数/间隔对回合内的流做节流。
    this.ctx.on('session/event', (session: Session, event: SessionEvent) => {
      if (event.type === 'turn/end') {
        void this.flushSoft(session, 'turn/end')
        return
      }
      const state = this.dirty.get(session) ?? { pending: 0, timer: undefined }
      this.dirty.set(session, state)
      state.pending += 1
      if (state.pending >= this.config.writeEveryEvents) {
        void this.flushSoft(session, 'count threshold')
        return
      }
      state.timer ??= setTimeout(() => {
        void this.flushSoft(session, 'interval')
      }, this.config.writeIntervalMs)
    })

    // 创建是第一个强制点：否则一个从不发言的会话（比如一个以祖先标题为
    // 种子的 fork 子会话）只会在 detach 时得到它的第一行——这样一次崩溃，
    // 或是在存储中保持活跃的 fork，都会让源自种子的那些值（标题）在冷列表
    // 上不可读。创建写入会捕获这个源自种子的切面。
    this.ctx.on('session/created', (session: Session) => {
      void this.flushSoft(session, 'create')
    })

    // Detach（实时转冷的时刻）：最后一个强制点。这次写入之后，冷读阶梯
    // 就从缓存服务该会话。flushSoft 的同步前缀会读取并重置脏状态，因此
    // 紧随其后丢弃它（计时器已被 markClean 清除）是安全的。
    this.ctx.on('session/disposed', (session: Session) => {
      void this.flushSoft(session, 'detach')
      this.markClean(session)
      this.dirty.delete(session)
    })

    // 与插件一起（它们的会话比缓存活得久）：清除挂起的计时器并停止接受
    // 新工作。init 中注册的领域关闭 effect 在本 disposer 之后运行，并排空
    // 已经排队的写入，因此一次迟到的刷新绝不可能在处置之后落地（它改为
    // 以 `closed` 拒绝并进入 flushSoft 的警告）。
    this.ctx.effect(() => () => {
      for (const state of this.dirty.values()) {
        if (state.timer !== undefined) clearTimeout(state.timer)
      }
      this.dirty.clear()
    }, 'sessionProjectionCache.timers')
  }

  /**
   * 一次失败软化的持久检查点。按构造，每个调用方都有活要干：节流触发器
   * 只在脏时触发（markClean 随计数器一起清除计时器），而强制点无条件写入。
   */
  private async flushSoft(session: Session, trigger: string): Promise<void> {
    try {
      await this.write(session)
    } catch (error) {
      this.ctx.logger.warn(`session projection cache: ${trigger} write for "${session.id}" failed (cache stays stale): ${String(error)}`)
    }
  }

  /** 重置一个会话的脏记账（它的检查点正在被写入）。 */
  private markClean(session: Session): void {
    const state = this.dirty.get(session)
    if (state === undefined) return
    state.pending = 0
    if (state.timer !== undefined) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
  }

  /** 用一个会话的日志身份以及 `rows` 的一个分离快照，替换其已存储记录。 */
  private async put(id: SessionId, identity: CheckpointIdentity, rows: ProjectionCheckpoint): Promise<void> {
    const detached = snapshotJsonValue(rows)
    if (detached === undefined) {
      throw new TypeError('projection checkpoint is not losslessly JSON-serializable (a unit state violates the plain-JSON contract)')
    }
    await this.requireTable().put(id, { identity, rows: detached as CheckpointRecord['rows'] })
  }

  private requireTable(): KvTable<SessionId, CheckpointRecord> {
    /* v8 ignore next -- Service.init 在服務变得可注入之前就分配了这张表 */
    if (this.table === undefined) throw new Error('session projection cache is not initialized')
    return this.table
  }
}

/** 把一个头部投影到仅由头部就能见证的那些身份字段上。 */
function lifecycleIdentityOf(header: SessionHeader): LifecycleIdentity {
  return {
    formatVersion: header.version,
    createdAt: header.createdAt,
    ...header.cwd === undefined ? {} : { cwd: header.cwd },
    isSeeded: header.isSeeded,
  }
}

/** 把一个头部及其精确的继承切点投影到完整的折叠身份上。 */
function identityOf(
  header: SessionHeader,
  inheritedEventCount: SessionLogOffset,
): CurrentCheckpointIdentity {
  const cut = SessionLogOffset(inheritedEventCount)
  if (!header.isSeeded && cut !== 0) {
    throw new Error('unseeded projection-cache identity inherited event count must be 0')
  }
  return { ...lifecycleIdentityOf(header), inheritedEventCount: cut }
}

/**
 * Whether a stored record may seed the caller's fold: the current format
 * generation, the same lifecycle, and the same inherited cut. A record folded
 * under another cut encodes that cut in unit states (`schedule`,
 * `subagentCatalog`, `permissions`) and would carry it into the continued
 * fold and the next checkpoint. Absent lineage fields (records admitted via
 * `compatibleVersions` predate them) read as the unseeded lineage: exact for
 * an unseeded caller, while a seeded caller fails the match.
 */
function identityMatches(stored: CheckpointIdentity, expected: CurrentCheckpointIdentity): boolean {
  return currentLifecycleMatches(stored, expected)
    && (stored.inheritedEventCount ?? 0) === expected.inheritedEventCount
}

/**
 * 一条已存储记录是否曾在当前会话格式下、从调用方的生命周期折叠而来。缺失
 * 的格式代际无法证明折叠语义，因此永远不匹配。这是仅持有头部的读取方
 * 能够检查的全部身份，也是一次视图所需的全部身份。
 */
function currentLifecycleMatches(stored: CheckpointIdentity, expected: LifecycleIdentity): boolean {
  return stored.formatVersion === expected.formatVersion
    && lifecycleIdentityMatches(stored, expected)
}

/** 把一条前身缓存记录匹配到权威的、被列举的生命周期。 */
function predecessorIdentityMatches(
  stored: CheckpointIdentity,
  expected: LifecycleIdentity,
): boolean {
  const predecessor = stored.formatVersion === undefined
    || stored.formatVersion < expected.formatVersion
  return predecessor && lifecycleIdentityMatches(stored, expected)
}

/** 匹配那些用于区分一个会话生命周期、且与格式无关的字段。 */
function lifecycleIdentityMatches(
  stored: CheckpointIdentity,
  expected: LifecycleIdentity,
): boolean {
  return stored.createdAt === expected.createdAt
    && stored.cwd === expected.cwd
    && (stored.isSeeded ?? false) === expected.isSeeded
}

export default SessionProjectionCache
