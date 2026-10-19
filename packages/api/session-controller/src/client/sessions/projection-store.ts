/**
 * 通用的每 session 投影值存储（推送模型；见 session-projection
 * 子系统页，docs/subsystems/session-projection.md）：
 * Host 是唯一的计算位置；client 按键持有完成的整值，存于两种行之一。
 * `sequenced` 行（`{ value, seq }`）来自已连接的 Host —— 跟随打开
 * 基线、Session Controller `projection` 帧、Host 为已附接 Session
 * 计算的列表块 —— 并在 sequenced 行之间按 **更高 seq 优先** 合并。
 * `cached` 行（`{ value }`）来自对持久化检查点的一次 Host 视图，
 * 不携带可比较的 seq，并让位于每一次 sequenced 写入。不存在
 * 客户端侧的领域折叠：一个领域以零客户端代码附带投影支持。
 * 每键裸可观察门面供给 `useProjection`（ui-renderer 绑定它们）。
 */
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import type { SessionSeqCursor } from '@deepseek-ai/dsh-session/types'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { Notifier } from './notifier.ts'

// 单一投影类型表，端到端全类型化（Host 单元、wire 块、
// client 存储、React hook）—— 即 Service Definition 包的纯类型出口
// （`/types`，零导入），绝不是包根：包根的 dsh-agent →
// dsh-session 依赖链会把 Host 的 `Context.sessions` 合并拖进
// client 程序（一个程序不得同时持有两侧）。不设第二张客户端侧
// "views" 表（在 .agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.md
// 的备选方案中已被否决）。
export type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'

/**
 * 第五个框架钩子席位（见 session-projection 子系统页，
 * docs/subsystems/session-projection.md）：经由标准套件交付的
 * 按键寻址投影读取器。`undefined` 统一表示能力缺席 —— Host 单元
 * 未挂载，或尚无基线/帧携带过该键。selector 重载镜像 useSession
 * （每键 uSES 绑定；引用稳定性成立，因为键的值引用只在帧或
 * 基线落地时才变化）。
 */
export type UseProjection = {
  <K extends Extract<keyof SessionProjectionMap, string>>(key: K): SessionProjectionMap[K] | undefined
  <K extends Extract<keyof SessionProjectionMap, string>, S>(
    key: K,
    selector: (value: SessionProjectionMap[K] | undefined) => S,
    eq?: (a: S, b: S) => boolean,
  ): S
}

/**
 * 跟随打开投影基线，在此重述，使不含 React 的存储只依赖
 * 类型表，而不是 wire 包的响应词汇。
 */
export interface ProjectionsBaseline {
  /** 一致性切口的 seq（按构造等于窗口尾部 seq）。 */
  asOfSeq: SessionSeqCursor
  /** 按键排列的完整当前值；这里缺席的已注册键表示能力缺席。 */
  values: Readonly<Record<string, unknown>>
}

/**
 * 单个键的行。`sequenced` 行由 Host 在当前连接代际内为该 Session
 * 计算并携带其一致所在的 seq；sequenced 行的 seq 彼此可比较。
 * `cached` 行由一次无 Session 的仅头部列表从持久化投影检查点
 * 视图读取：其来源无法担保其存储的 seq 与 client 稍后打开的日志
 * 可比较，因此不携带 seq，并让位于每一次 sequenced 写入。
 */
type Row =
  | { kind: 'cached'; value: unknown }
  | { kind: 'sequenced'; value: unknown; seq: SessionSeqCursor }

/** 每键通知通道：裸门面加上其批量通知器。 */
interface Channel {
  face: ObservableSnapshot<unknown>
  notifier: Notifier
}

/**
 * 一个 session 的投影值。框架语义，对所有键统一。Sequenced 写入
 * （基线在其切口播种行，推送帧更新一行）在彼此之间比较 seq：
 * 同一 Host 代际内更低或相等的 seq 落败，因此回放的帧不能使值
 * 回退，过期的基线不能覆盖更新的帧。Cached 写入（session
 * 列表的零 I/O 块）只填充尚无 sequenced 行持有的键，且基线在
 * 播种前丢弃每一行 cached 行，不论 seq：已连接的 Session 即真相，
 * cached 值绝不高于它。存储从未见过的键读取为 `undefined`
 * （能力缺席）。门面按键保持身份稳定（按需创建、缓存），
 * 因此 React 侧对每个键恰好绑定一次；存储级通道
 * （`subscribeAny`）服务粗粒度消费方（manager 的列表投影读取
 * `title` 键）。
 */
export class ProjectionValueStore {
  private readonly rows = new Map<string, Row>()
  private readonly channels = new Map<string, Channel>()
  private valuesCache: Readonly<Partial<SessionProjectionMap>> | undefined
  /** 粗粒度任意键通道（没有要重建的快照缓存：读取直接命中行）。 */
  private readonly anyNotifier = new Notifier(() => {})

  /**
   * 按键寻址的裸可观察门面（useProjection 解析路径）。
   * 恒有定义 —— 缺席表示一个 `undefined` 快照，绝不是缺失的
   * 门面，因此组件可以在键携带值之前订阅。
   * @param key - 投影键。
   * @returns 该键的身份稳定门面。
   */
  faceOf(key: string): ObservableSnapshot<unknown> {
    return this.channel(key).face
  }

  /**
   * 一个键的当前完整值（擦除类型的框架读取；带类型的读取经过
   * `useProjection` 的映射查找）。
   * @param key - 投影键。
   * @returns 该值，或在键缺席期间返回 undefined。
   */
  get(key: string): unknown {
    return this.rows.get(key)?.value
  }

  /**
   * 在不订阅或不复制值的情况下读取被接纳的 Host 水位线。
   * @param key - 投影键。
   * @returns 当前序列，或对缺席与 cached 值返回 undefined。
   */
  seqOf(key: string): SessionSeqCursor | undefined {
    const row = this.rows.get(key)
    return row?.kind === 'sequenced' ? row.seq : undefined
  }

  /**
   * 把每个当前投影值读取为一个引用稳定的快照。
   * @returns 同一个冻结值映射，直到某行变化。
   */
  values(): Readonly<Partial<SessionProjectionMap>> {
    if (this.valuesCache === undefined) {
      this.valuesCache = Object.freeze(Object.fromEntries(
        [...this.rows].map(([key, row]) => [key, row.value]),
      ))
    }
    return this.valuesCache
  }

  /**
   * 订阅任意键的变更（按微任务批量）—— manager 的列表
   * 重建通道。
   * @param listener - 变更回调。
   * @returns 取消订阅函数。
   */
  subscribeAny(listener: () => void): () => void {
    return this.anyNotifier.subscribe(listener)
  }

  /**
   * 应用来自 Session 控制流的一个完成值。
   * @param key - 投影键。
   * @param value - Host 单元计算的完整值。
   * @param seq - 该单元在发出时的水位线。
   */
  apply(key: string, value: unknown, seq: SessionSeqCursor): void {
    const row = this.rows.get(key)
    // sequenced 行之间更高 seq 优先；回放与过期帧被丢弃。
    // cached 行没有可比较的 seq，总是让位。
    if (row?.kind === 'sequenced' && seq <= row.seq) return
    this.rows.set(key, { kind: 'sequenced', value, seq })
    this.changed(key)
  }

  /**
   * 从标注为 `cached` 的 Host 块填充键：对持久化检查点的一次
   * 零 I/O 视图。cached 值只落在不存在 sequenced 行的键上：
   * 已连接的 Session 已经为此类键作答，而列表对持久化检查点的
   * 视图不可能比它更新。
   * @param values - 从持久化检查点视图读取的按键排列的完整值。
   */
  applyCached(values: Readonly<Record<string, unknown>>): void {
    for (const key of Object.keys(values)) {
      if (this.rows.get(key)?.kind === 'sequenced') continue
      this.rows.set(key, { kind: 'cached', value: values[key] })
      this.changed(key)
    }
  }

  /**
   * 从历史尾页的 projections 块播种。每一行 cached 行都先被
   * 丢弃，不论 seq：该块来自已连接的 Session，从持久化检查点
   * 视图读取的值绝不高于它。随后每个携带的键都按与帧相同的
   * seq 规则落地，块省略的键在切口处即能力缺席 —— 其行被清除，
   * 除非某个更新的帧已取代该切口（过期基线既不能覆盖也不能
   * 清除更新的 sequenced 值）。
   * @param baseline - 响应的 projections 块。
   */
  seed(baseline: ProjectionsBaseline): void {
    for (const [key, row] of this.rows) {
      if (row.kind !== 'cached') continue
      this.rows.delete(key)
      this.changed(key)
    }
    // 擦除类型的遍历：框架跨越开放的键空间；每键类型
    // 在消费方重新建立（useProjection 的映射查找）。
    const values = baseline.values as Record<string, unknown>
    for (const key of Object.keys(values)) this.apply(key, values[key], baseline.asOfSeq)
    for (const [key, row] of this.rows) {
      if (Object.hasOwn(values, key)) continue
      // 上面已删除每一行 cached 行；这里的 kind 测试只是收窄
      // 类型，使 `row.seq` 可读。
      if (row.kind === 'sequenced' && row.seq > baseline.asOfSeq) continue
      this.rows.delete(key)
      this.changed(key)
    }
  }

  /** 丢弃一个 Host 代际的值与水位线，同时保留已订阅的门面。 */
  clear(): void {
    for (const key of this.rows.keys()) {
      this.rows.delete(key)
      this.changed(key)
    }
  }

  private changed(key: string): void {
    this.valuesCache = undefined
    this.channels.get(key)?.notifier.markDirty()
    this.anyNotifier.markDirty()
  }

  private channel(key: string): Channel {
    let channel = this.channels.get(key)
    if (channel === undefined) {
      // 通知器只做批量（没有要重建的快照缓存：门面直接读行）。
      const notifier = new Notifier(() => {})
      channel = {
        notifier,
        face: {
          getSnapshot: () => this.rows.get(key)?.value,
          subscribe: listener => notifier.subscribe(listener),
        },
      }
      this.channels.set(key, channel)
    }
    return channel
  }
}
