/**
 * session-projection 能力接缝的服务定义与驱动注册表：可合并扩展的状态与
 * 客户端视图类型表、`ProjectionDefinition` 状态驱动的计算单元契约，以及
 * `ctx.sessionProjections` 注册表——它会在每次已提交会话事件上急切地向前
 * 驱动每个已注册单元。领域主机插件贡献纯折叠与可选的客户端视图；框架
 * 负责订阅、按会话划分的水位缓存与变更通知；载体消费快照读取面与变更流。
 * 双方互不知道对方（能力接缝的三方分离）。设计权威：session-projection
 * RFC（.agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.md）。
 *
 * 整体值事件规则（承重约束）：携带状态的日志事件必须携带变更后的完整状态，
 * 绝不能是裸增量——这让每个单元的转移都极其廉价，且每个被服务的值都能
 * 自描述。
 *
 * @module @deepseek-ai/dsh-session-projection
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { ZodType } from 'zod'
import { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type {
  Session,
  SessionEvent,
  SessionHeader,
  SessionSeqCursor,
} from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionProjections: SessionProjectionRegistry
  }
}

import type { SessionProjectionMap, SessionProjectionStateMap } from './types.ts'

export type { SessionProjectionMap, SessionProjectionStateMap } from './types.ts'

/**
 * 一个领域的状态驱动计算单元：一个纯同步折叠，加上声明与一个可选的
 * 客户端视图——绝不是一个不透明的 getter。框架在每次已提交会话事件上驱动
 * `apply`；领域不持有任何订阅，只拥有计算本身。所有函数都必须是同步的
 * （异步单元会撕裂载体的一致性切面），并且 `state` 必须是纯 JSON
 * （持久化缓存的前提条件）。
 */
export interface ProjectionDefinition<
  K extends keyof SessionProjectionStateMap,
  S extends SessionProjectionStateMap[K] = SessionProjectionStateMap[K],
> {
  /** 本单元拥有的投影键（即它在 `SessionProjectionStateMap` 中的条目）。 */
  key: K
  /** 在校验折叠之前校验被持久化的状态。 */
  stateSchema: ZodType<S>
  /**
   * 空日志及其不可变会话元数据对应的状态。
   * @param header - 被投影会话的不可变元数据。
   * @param inheritedEventCount - 精确的 fork 继承前缀长度。
   * @returns 初始状态。
   */
  init(header: SessionHeader, inheritedEventCount: SessionLogOffset): NoInfer<S>
  /**
   * 纯转移：先前状态 + 一个已提交事件 → 下一状态。对一个事件不感兴趣的
   * 单元必须返回同一个状态引用——未变化的引用（`Object.is`）会带来零下游
   * 工作。
   * @param state - 覆盖所有先前事件的状态。
   * @param event - 下一个已提交会话事件。
   * @returns 下一状态（当该事件不属于本单元时，为同一引用）。
   */
  apply(state: NoInfer<S>, event: SessionEvent): NoInfer<S>
  /** 客户端视图。仅主机单元可省略。 */
  wire?: K extends keyof SessionProjectionMap ? {
    /** 在校验负载离开主机之前校验它。 */
    viewSchema: ZodType<SessionProjectionMap[K]>
    /**
     * 状态 → 线上负载（读取侧投影）。实时驱动保留最近两个原始结果，并用
     * `Object.is` 比较它们；对象型视图必须复用其引用，以抑制在仅内部状态
     * 变化时的发布。
     * @param state - 当前状态。
     * @returns 本单元键对应的完整当前值。
     */
    view(state: NoInfer<S>): SessionProjectionMap[K]
  } : never
  /**
   * 持久化缓存失效版本：只要序列化的状态字段或折叠语义发生变化就应当提升
   * 它，这样来自较旧单元的、持久化的 `(sessionId, key, ver, seq, val)` 行
   * 会被丢弃，而不是被前向应用成垃圾。非负整数。
   */
  stateVersion: number
}

/**
 * 变更流监听器：某个会话某一单元的、按 `Object.is` 改变了的原始 `view`
 * 结果。`value` 是经过 schema 校验的输出；`seq` 是该单元在发出时的水位
 * （即导致这次变更的事件的 seq）。
 */
export type ProjectionChangeListener = (
  session: Session,
  key: Extract<keyof SessionProjectionMap, string>,
  value: unknown,
  seq: SessionSeq,
) => void

/**
 * 某个会话所有已注册客户端可见单元上的一次一致性读取切面。`asOfSeq` 是
 * 共享水位——即每个值所反映的最后一个事件的 seq（空日志为 `-1`）。
 */
export interface ProjectionSnapshot {
  /** 各值所反映的最后一个事件的 seq；空日志为 -1。 */
  asOfSeq: SessionSeqCursor
  /** 每个已注册键对应的完整当前客户端值。 */
  values: Partial<SessionProjectionMap>
}

/**
 * 一个单元的检查点：其内部状态（按单元契约为纯 JSON）、折叠进它的最后一
 * 个事件的 seq，以及生成它的单元 `stateVersion`——即持久化的投影缓存行
 * `(sessionId, key, ver, seq, val)` 去掉两个外层键。一行永远不是权威的，
 * 只是一条折叠捷径：`restore` 会在版本不匹配、或它声明的事件超出已存储
 * 日志末端时丢弃它。
 */
export interface ProjectionCheckpointRow {
  /** 折叠时注册单元的 `stateVersion`。 */
  ver: number
  /** 折叠进 `val` 的最后一个事件的 seq；空日志为 -1。 */
  seq: SessionSeqCursor
  /** 单元的内部状态——按单元契约为纯 JSON。 */
  val: unknown
}

/** 以投影键为索引的检查点行（一个会话的持久化缓存值）。 */
export type ProjectionCheckpoint = Record<string, ProjectionCheckpointRow>

/** 驱动机制所使用的、类型擦除后的单元视图（注册契约已经证明了其带类型形式）。 */
interface ErasedDefinition {
  key: string
  stateSchema: { parse(value: unknown): unknown }
  init(header: SessionHeader, inheritedEventCount: SessionLogOffset): unknown
  apply(state: unknown, event: SessionEvent): unknown
  wire: { viewSchema: { parse(value: unknown): unknown }; view(state: unknown): unknown } | undefined
  stateVersion: number
}

/** 按会话、按单元的各自水位，以及固定的实时驱动视图缓冲。 */
interface UnitCell {
  state: unknown
  /** 通过 `apply` 的最后一个事件的 seq（无论是否变化）。 */
  observedSeq: SessionSeqCursor
  /** `[previousView, currentView]`；undefined 槽位表示没有缓存的比较对象。 */
  readonly views: [unknown, unknown]
}

/**
 * 一次活跃注册：该单元加上其按会话划分的 cell（最后一个注册方释放后整体丢弃）。
 *
 * 之所以需要 `refs`，是因为一个单元定义已经服务于每个会话——cell 以
 * `Session` 为键——而注册方是按会话的：一个 agent preset 会为每个 agent
 * 挂载同一工具包一次，因此同一个 preset 上的 N 个会话会把同一个键注册
 * N 次。如果没有计数，第一个注册方就会拥有 disposer，而它的会话一结束
 * 就会把该投影从所有其它活跃会话上剥离。
 */
interface Registration {
  readonly def: ErasedDefinition
  readonly cells: WeakMap<Session, UnitCell>
  /** 共享本单元的活跃注册方；最后一个退出者移除该键。 */
  refs: number
}

/** 把一个日志偏移转换为它紧邻之前的那个含尾游标。 */
function cursorBefore(offset: SessionLogOffset): SessionSeqCursor {
  return offset === 0 ? -1 : SessionSeq(offset - 1)
}

/**
 * `ctx.sessionProjections`：投影单元表及其驱动。该服务订阅一次
 * `session/event`；每个已提交事件都会经过每个已注册单元的 `apply`（急切
 * 驱动）。一个变化了的状态引用会计算下一个客户端视图；变更流仅在其原始
 * 结果按 `Object.is` 改变时才被通知。cell 是惰性构建的——在某个事件
 * 流过之后才注册的单元，或者比注册表更旧的会话，会在首次触碰（事件或
 * 读取）时，在内存日志上折叠 `init`。注册是一种 effect（disposer 挂在
 * 调用纤程上）：一个被卸载的领域插件的键会从快照中消失，客户端将其读取
 * 为能力缺失。主机读取方要么在其插件 `inject` 中声明 `sessionProjections`，
 * 要么在注册表或所需键缺失时显式失败。贡献方可以通过
 * `ctx.inject(['sessionProjections'], ...)` 保留可选注册。共享一个键的注册方
 * 共享同一个单元并被计数：同一个工具包挂载在 N 个 agent preset 上会注册
 * N 次，该键会存活到最后一个被卸载为止。
 */
export class SessionProjectionRegistry extends Service {
  private readonly registrations = new Map<string, Registration>()
  private readonly listeners = new Set<ProjectionChangeListener>()

  /**
   * 创建并把注册表安装为 `ctx.sessionProjections`。
   * @param ctx - 拥有该服务的 Cordis 上下文。
   */
  constructor(ctx: Context) {
    super(ctx, 'sessionProjections')
    ctx.on('session/created', (session: Session) => {
      if (session.seq !== 0) return
      for (const registration of this.registrations.values()) {
        if (registration.cells.has(session)) continue
        registration.cells.set(session, {
          state: registration.def.init(session.header, session.inheritedEventCount),
          observedSeq: -1,
          views: [undefined, undefined],
        })
      }
    })
    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      this.drive(session, event)
    })
  }

  /**
   * 注册一个领域的单元。该注册是调用上下文纤程上的一种 effect：处置该纤程
   * （或调用返回的 disposer）会从后续驱动与快照中移除该键——以及该单元的
   * 缓存 cell。
   * @param definition - 键、状态 schema、纯单元函数与 stateVersion。
   * @returns 恰好能注销本单元的 disposer。
   */
  register<
    K extends keyof SessionProjectionMap,
    S extends SessionProjectionStateMap[K],
  >(
    definition: Omit<ProjectionDefinition<K, S>, 'wire'> & {
      wire: NonNullable<ProjectionDefinition<K, S>['wire']>
    },
  ): () => void
  /**
   * 注册一个仅主机的单元。其状态被排除在客户端快照之外，但像其它单元一样
   * 始终被做检查点。
   * @param definition - 键、状态 schema、纯单元函数与 stateVersion。
   * @returns 恰好能注销本单元的 disposer。
   */
  register<
    K extends Exclude<keyof SessionProjectionStateMap, keyof SessionProjectionMap>,
    S extends SessionProjectionStateMap[K],
  >(
    definition: Omit<ProjectionDefinition<K, S>, 'wire'>,
  ): () => void
  register<K extends keyof SessionProjectionStateMap, S extends SessionProjectionStateMap[K]>(
    definition: ProjectionDefinition<K, S>,
  ): () => void {
    const wire = definition.wire as {
      viewSchema: ZodType
      view(state: S): unknown
    } | undefined
    const erased: ErasedDefinition = {
      key: definition.key,
      stateSchema: definition.stateSchema,
      init: (header, inheritedEventCount) => definition.init(header, inheritedEventCount),
      apply: (state, event) => definition.apply(state as S, event),
      wire: wire === undefined
        ? undefined
        : { viewSchema: wire.viewSchema, view: state => wire.view(state as S) },
      stateVersion: definition.stateVersion,
    }
    if (!Number.isSafeInteger(definition.stateVersion) || definition.stateVersion < 0) {
      throw new Error(`session projection ${JSON.stringify(definition.key)} stateVersion must be a non-negative integer, got ${String(definition.stateVersion)}`)
    }
    const dispose = this.ctx.effect(function* (this: SessionProjectionRegistry) {
      const key = erased.key
      const existing = this.registrations.get(key)
      if (existing === undefined) {
        this.registrations.set(key, { def: erased, cells: new WeakMap(), refs: 1 })
      } else {
        if (existing.def.stateVersion !== erased.stateVersion) {
          throw new Error(`session projection key ${JSON.stringify(key)} is already registered at stateVersion ${String(existing.def.stateVersion)}; refusing to share it with stateVersion ${String(erased.stateVersion)}`)
        }
        existing.refs += 1
      }
      yield () => {
        const live = this.registrations.get(key)
        /* v8 ignore next -- disposer 每次成功注册只运行一次，因此它计过数的条目仍在这里 */
        if (live === undefined) return
        live.refs -= 1
        if (live.refs === 0) this.registrations.delete(key)
      }
    }.bind(this), 'sessionProjections.register()')
    // oxlint-disable-next-line typescript/no-misused-promises -- 同步清理；保留 Cordis disposer 以便 effect 可以接纳它。
    return dispose
  }

  /**
   * Subscribe to the change feed. The registration is an effect on the
   * calling context's fiber.
   * @param listener - called once per client-visible unit whose raw view changed by `Object.is`, per committed event.
   * @returns the exact disposer that unsubscribes.
   */
  onChanged(listener: ProjectionChangeListener): () => void {
    const dispose = this.ctx.effect(() => {
      this.listeners.add(listener)
      return () => {
        this.listeners.delete(listener)
      }
    }, 'sessionProjections.onChanged()')
    return () => void dispose()
  }

  /**
   * 在会话游标处物化每个已注册单元之后，读取某个单元的当前主机状态。
   * 不产出无关的 wire 视图。返回的值是实时的；调用方不得修改它。
   * @param session - 被读取状态的会话。
   * @param key - 已注册的单元键。
   * @returns 当前状态；当该键未注册时为 `undefined`。
   */
  stateOf<K extends keyof SessionProjectionStateMap>(
    session: Session,
    key: K,
  ): SessionProjectionStateMap[K] | undefined {
    const registration = this.registrations.get(key)
    if (registration === undefined) return undefined
    this.materializeCells(session)
    return this.cellFor(registration, session).state as SessionProjectionStateMap[K]
  }

  /**
   * One consistent cut over every registered client-visible unit for one session, read from
   * the watermark cache (missing cells fold lazily over the in-memory log).
   * Fully synchronous — every value and `asOfSeq` reflect the same log
   * position. Each value passes its unit's `viewSchema` before leaving.
   * @param session - the session whose projection values are read.
   * @param keys - optional client-visible outputs; state materialization remains complete.
   * @returns the snapshot; `values` is empty when no selected client-visible unit is registered.
   */
  snapshot(
    session: Session,
    keys?: readonly Extract<keyof SessionProjectionMap, string>[],
  ): ProjectionSnapshot {
    const values: Record<string, unknown> = {}
    const selected = keys === undefined ? undefined : new Set<string>(keys)
    this.materializeCells(session)
    for (const registration of this.registrations.values()) {
      if (registration.def.wire === undefined) continue
      if (selected !== undefined && !selected.has(registration.def.key)) continue
      const cell = this.cellFor(registration, session)
      values[registration.def.key] = this.viewCell(registration, cell)
    }
    return { asOfSeq: cursorBefore(session.seq), values }
  }

  /**
   * 只读取已经物化的客户端可见 cell，而不折叠历史。这些值可能落后于
   * 实时会话，因此只是提示，而非完整基线。缺失的 cell 被略去。
   * @param session - 被检查缓存 cell 的已挂载会话。
   * @param keys - 可选的 wire 键。
   * @returns 最低的公有缓存切面；当不存在任何 wire cell 时为 `undefined`。
   */
  cachedSnapshot(
    session: Session,
    keys?: readonly Extract<keyof SessionProjectionMap, string>[],
  ): ProjectionSnapshot | undefined {
    const values: Record<string, unknown> = {}
    let asOfSeq: SessionSeqCursor | undefined
    const selected = keys === undefined ? undefined : new Set<string>(keys)
    for (const registration of this.registrations.values()) {
      if (registration.def.wire === undefined) continue
      if (selected !== undefined && !selected.has(registration.def.key)) continue
      const cell = registration.cells.get(session)
      if (cell === undefined) continue
      values[registration.def.key] = this.viewCell(registration, cell)
      if (asOfSeq === undefined || cell.observedSeq < asOfSeq) {
        asOfSeq = cell.observedSeq
      }
    }
    return asOfSeq === undefined ? undefined : { asOfSeq, values }
  }

  /**
   * 某个会话每个已持久化单元的状态级检查点，从水位缓存中读取（缺失的 cell
   * 在内存日志上惰性折叠）。这是持久化投影缓存的写入侧：返回的行即持久化的
   * `(sessionId, key, ver, seq, val)` 行中 `(key → {ver, seq, val})` 那部分。
   * 每个 `val` 都是一个分离的 structured clone——绝不会是实时的 cell 引用：
   * 水位缓存是本注册表的权威可变状态，若调用方拿到实时引用，就可能借此
   * 破坏之后每一个快照与帧（按单元契约为纯 JSON，因此克隆是彻底的）。
   * @param session - 其单元状态被做检查点的会话。
   * @returns 每个已注册键一行。
   */
  checkpoint(session: Session): ProjectionCheckpoint {
    const rows: ProjectionCheckpoint = {}
    for (const registration of this.registrations.values()) {
      const cell = this.cellFor(registration, session)
      rows[registration.def.key] = {
        ver: registration.def.stateVersion,
        seq: cell.observedSeq,
        val: structuredClone(cell.state),
      }
    }
    return rows
  }

  /**
   * {@link restore} 在 `checkpoint` 之上所做的尾部读取必须起始于的、已存储
   * 的 seq：即比最低可用水位低一个事件（一行在其 `ver` 匹配活动单元的
   * `stateVersion` 时可用；缺失或不匹配的行使下限回落到 `0`——该键必须
   * 重折整个日志）。这个“低一个”的锚点是承重设计：尾部读取由此证明了
   * 已存储日志还延伸多远，因此 {@link restore} 能检测出一个收缩到某行水位
   * 之下的日志（崩溃修复式截断），而不是把过时行当作当前值提供——从锚点
   * 读到的空尾部会得到低于每个水位的一个末端，于是 restore 因要求整体
   * 重读而拒绝。
   * @param checkpoint - 一个会话的持久化行（可能过时或为空）。
   * @returns 存储日志后缀读取（`SessionHandle.read`）的偏移；当没有单元
   *   被注册时为 `undefined`（无需读取——{@link restore} 无论如何都会
   *   提供空值）。
   */
  restoreFloor(checkpoint: ProjectionCheckpoint): SessionLogOffset | undefined {
    let floor: number | undefined
    for (const registration of this.registrations.values()) {
      const row = checkpoint[registration.def.key]
      const need = row !== undefined && row.ver === registration.def.stateVersion
        ? Math.max(row.seq + 1, 0)
        : 0
      floor = floor === undefined ? need : Math.min(floor, need)
    }
    return floor === undefined ? undefined : SessionLogOffset(Math.max(floor - 1, 0))
  }

  /**
   * 不做任何日志读取地查看一个检查点的行：对每个已注册的、其行 `ver`
   * 匹配的客户端可见单元，提供经过 schema 校验的已存储状态的、同样经过
   * schema 校验的 `view`；不匹配、畸形或缺失的行会使其键缺席（冷读或列举
   * 消费方将其视为尚不可用，并由更完整的读取路径重折它）。读取阶梯上的
   * 零 I/O 这一档——值与其行一样过时，但绝不会错误。
   * @param checkpoint - 一个会话的持久化行（可能过时或为空）。
   * @param keys - 可选的 wire 键。
   * @returns 每个拥有可用行的键对应的完整值；没有时为空的。
   */
  viewCheckpoint(
    checkpoint: ProjectionCheckpoint,
    keys?: readonly Extract<keyof SessionProjectionMap, string>[],
  ): Partial<SessionProjectionMap> {
    const values: Record<string, unknown> = {}
    const selected = keys === undefined ? undefined : new Set<string>(keys)
    for (const registration of this.registrations.values()) {
      const def = registration.def
      if (def.wire === undefined) continue
      if (selected !== undefined && !selected.has(def.key)) continue
      const row = checkpoint[def.key]
      if (row === undefined || row.ver !== def.stateVersion) continue
      let state: unknown
      try {
        state = def.stateSchema.parse(row.val)
      } catch {
        continue
      }
      values[def.key] = def.wire.viewSchema.parse(def.wire.view(state))
    }
    return values
  }

  /**
   * 冷读：在一段已存储的日志后缀上折叠每个已持久化单元，并在可用时从各自
   * 的检查点行播种——即那一则读取配方（缓存状态 + 前向尾部重放 + `view`）
   * 在没有实时 `Session` 的情况下被应用。请传入处于 `restoreFloor(checkpoint)`
   * 处或其之后的已存储事件（一个 `SessionHandle.read` 切片），并以同一个
   * 下限作为 `baseSeq`；下限“低一个”的锚点让所提供的末端是诚实的，因此
   * 一个收缩的日志会在此处被检测到。一行当且仅当其 `ver` 匹配活动单元的
   * `stateVersion`、它不早于 `baseSeq`（`seq >= baseSeq - 1`）、且它不声明
   * 超出所提供末端（`seq <= endSeq`）的事件时才可用；不可用的行会被丢弃，
   * 其键从 `init` 重折——而这只有在整个日志上才成立，因此 `baseSeq > 0` 时
   * 一个被丢弃的行会抛出（调用方从 seq 0 重新读取，例如在一次崩溃修复式
   * 截断把日志收缩到某行水位之下之后）。
   * @param checkpoint - 一个会话的持久化行（可能过时或为空）。
   * @param events - 满足 `seq >= baseSeq` 的已存储事件，按 seq 顺序。
   * @param baseSeq - `events` 起始的 seq（非空时即其首个事件的 seq）。
   * @param header - 正在被恢复会话的不可变元数据。
   * @param inheritedEventCount - 提供给单元初始化的精确 fork 继承前缀长度。
   * @returns 在所提供日志末端切出的快照（`asOfSeq` 是最后一个所提供事件的
   *   seq，空尾部时为 `baseSeq - 1`），加上在该切面上刷新过的检查点行，
   *   可供持久化写回。
   */
  restore(
    checkpoint: ProjectionCheckpoint,
    events: readonly SessionEvent[],
    baseSeq: SessionLogOffset,
    header: SessionHeader,
    inheritedEventCount: SessionLogOffset,
  ):
  { snapshot: ProjectionSnapshot; checkpoint: ProjectionCheckpoint } {
    const endSeq: SessionSeqCursor = events.at(-1)?.seq ?? cursorBefore(baseSeq)
    const beforeBase = cursorBefore(baseSeq)
    const values: Record<string, unknown> = {}
    const refreshed: ProjectionCheckpoint = {}
    for (const registration of this.registrations.values()) {
      const def = registration.def
      const row = checkpoint[def.key]
      const usable = row !== undefined
        && row.ver === def.stateVersion
        && row.seq >= beforeBase
        && row.seq <= endSeq
      if (!usable && baseSeq > 0) {
        throw new Error(
          `session projection ${JSON.stringify(def.key)} cannot restore from seq ${baseSeq}: `
          + 'its checkpoint row is missing, version-mismatched, or beyond the supplied log end; re-read from seq 0',
        )
      }
      let state = usable
        ? def.stateSchema.parse(row.val)
        : def.init(header, inheritedEventCount)
      const from = usable ? row.seq : beforeBase
      const startIndex = from - baseSeq + 1
      for (let index = startIndex; index < events.length; index++) {
        const event = events[index]
        const expectedSeq = SessionSeq(baseSeq + index)
        if (event === undefined || event.seq !== expectedSeq) {
          throw new Error(`session projection ${JSON.stringify(def.key)} cannot restore across missing seq ${String(expectedSeq)}`)
        }
        state = def.apply(state, event)
      }
      if (def.wire !== undefined) values[def.key] = def.wire.viewSchema.parse(def.wire.view(state))
      refreshed[def.key] = { ver: def.stateVersion, seq: endSeq, val: state }
    }
    return {
      snapshot: { asOfSeq: endSeq, values: values },
      checkpoint: refreshed,
    }
  }

  /**
   * 恢复一个精确的切面，并将其状态安装到所提供的、已准备好的会话上。稍后的
   * 发布会复用这些 cell；普通的实时读取与事件驱动对每个由构造器拥有的
   * 后缀恰好推进一次。
   * @param session - 拥有被恢复日志前缀的、精确的已准备好会话。
   * @param checkpoint - 本会话生命周期的持久化行。
   * @param events - 观测切面上的精确事件。
   * @param baseSeq - 首个所提供事件的序号。
   * @returns 在所提供切面上的所有投影值。
   */
  hydrate(
    session: Session,
    checkpoint: ProjectionCheckpoint,
    events: readonly SessionEvent[],
    baseSeq: SessionLogOffset,
  ): ProjectionSnapshot {
    const endSeq: SessionSeqCursor = events.at(-1)?.seq ?? cursorBefore(baseSeq)
    let complete = true
    for (const registration of this.registrations.values()) {
      const current = registration.cells.get(session)
      if (current?.observedSeq !== endSeq) {
        complete = false
        break
      }
    }
    if (complete) {
      const values: Record<string, unknown> = {}
      for (const registration of this.registrations.values()) {
        if (registration.def.wire === undefined) continue
        const current = registration.cells.get(session) as UnitCell
        values[registration.def.key] = this.viewCell(registration, current)
      }
      return { asOfSeq: endSeq, values }
    }
    const restored = this.restore(
      checkpoint,
      events,
      baseSeq,
      session.header,
      session.inheritedEventCount,
    )
    for (const registration of this.registrations.values()) {
      const row = restored.checkpoint[registration.def.key]
      if (row === undefined) continue
      const current = registration.cells.get(session)
      if (current !== undefined && current.observedSeq > row.seq) continue
      registration.cells.set(session, {
        state: row.val,
        observedSeq: row.seq,
        views: [undefined, undefined],
      })
    }
    return restored.snapshot
  }

  /** 在会话的当前游标处物化每个已注册单元的 cell。 */
  private materializeCells(session: Session): void {
    for (const registration of this.registrations.values()) this.cellFor(registration, session)
  }

  /** 从 init 开始，在 `events` 上折叠一个单元，产生一个以最后被折事件为水位的 cell。 */
  private buildCell(
    def: ErasedDefinition,
    header: SessionHeader,
    inheritedEventCount: SessionLogOffset,
    events: readonly SessionEvent[],
  ): UnitCell {
    let state = def.init(header, inheritedEventCount)
    for (const event of events) state = def.apply(state, event)
    return { state, observedSeq: (events.at(-1)?.seq ?? -1), views: [undefined, undefined] }
  }

  /** 读取（或惰性构建，即折叠整个内存日志）一个单元的 cell。 */
  private cellFor(registration: Registration, session: Session): UnitCell {
    let cell = registration.cells.get(session)
    if (cell === undefined) {
      cell = this.buildCell(
        registration.def,
        session.header,
        session.inheritedEventCount,
        // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
        session.snapshotEvents(),
      )
      registration.cells.set(session, cell)
    } else {
      this.advanceCell(registration.def, cell, session, cursorBefore(session.seq))
    }
    return cell
  }

  /** 让一个已有 cell 经过一段连续的会话前缀而推进。 */
  private advanceCell(
    def: ErasedDefinition,
    cell: UnitCell,
    session: Session,
    throughSeq: SessionSeqCursor,
  ): void {
    if (cell.observedSeq >= throughSeq) return
    for (let seq = cell.observedSeq + 1; seq <= throughSeq; seq++) {
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      const event = session.eventAt(SessionSeq(seq))
      if (event === undefined || event.seq !== seq) {
        throw new Error(`session projection ${JSON.stringify(def.key)} cannot advance across missing seq ${String(seq)}`)
      }
      const next = def.apply(cell.state, event)
      if (!Object.is(next, cell.state)) {
        cell.views[0] = cell.views[1]
        cell.views[1] = undefined
      }
      cell.state = next
      cell.observedSeq = SessionSeq(seq)
    }
  }

  /** 急切驱动：让一个已提交事件经过每个单元；在原始视图引用变化时通知。 */
  private drive(session: Session, event: SessionEvent): void {
    for (const registration of this.registrations.values()) {
      let cell = registration.cells.get(session)
      if (cell !== undefined && cell.observedSeq >= event.seq) continue
      if (cell === undefined) {
        // 流中途的迟到构建：在本事件之前折叠历史（seq = 日志索引，因此前缀
        // 切片是精确的），再走正常的闸门。
        cell = this.buildCell(
          registration.def,
          session.header,
          session.inheritedEventCount,
          // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
          session.snapshotEvents(SessionLogOffset(0), SessionLogOffset(event.seq)),
        )
        registration.cells.set(session, cell)
      } else {
        this.advanceCell(
          registration.def,
          cell,
          session,
          event.seq === 0 ? -1 : SessionSeq(event.seq - 1),
        )
      }
      const previousState = cell.state
      const next = registration.def.apply(previousState, event)
      const changed = !Object.is(next, previousState)
      cell.state = next
      cell.observedSeq = event.seq
      const wire = registration.def.wire
      if (changed && wire !== undefined) {
        const views = cell.views
        views[0] = views[1]
        if (this.listeners.size > 0) {
          views[1] = wire.view(next)
          if (!Object.is(views[0], views[1])) {
            const value = wire.viewSchema.parse(views[1])
            for (const listener of this.listeners) {
              listener(session, registration.def.key as Extract<keyof SessionProjectionMap, string>, value, event.seq)
            }
          }
        } else {
          views[1] = undefined
        }
      }
      // 一个未变化的状态保留其当前视图，作为下一次状态变化时的有效比较值。
    }
  }

  /** 返回一个经过 schema 校验的 wire 值。 */
  private viewCell(registration: Registration, cell: UnitCell): unknown {
    const wire = registration.def.wire
    if (wire === undefined) throw new Error(`session projection ${JSON.stringify(registration.def.key)} has no wire view`)
    return wire.viewSchema.parse(wire.view(cell.state))
  }
}

export default SessionProjectionRegistry
