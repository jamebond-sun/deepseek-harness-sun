/**
 * 一个已打开领域的运行时：权威的内存内状态、每个领域唯一的写入链，以及变更事件发射。读取从内存同步进行；
 * 每次写入都在链上排队，先等待后端持久性，再修改内存，最后发射 `domain/changed`——被拒绝的后端写入会保持内存不变
 * （读取与介质之间不产生分歧），且事件携带的值等于发射时内存内的状态，按写入顺序排列。
 * @module @deepseek-ai/dsh-storage-domain/src/domain
 */

import type { Context } from '@deepseek-ai/cordis'
import type { KvUnit } from '@deepseek-ai/dsh-storage'
import { DomainError } from './error.ts'
import type { DomainSpec, DomainGlobalSpec, TableKeyOf, TableValueOf } from './spec.ts'
import type { DomainChanged } from './events.ts'

/** 领域全局单例的句柄。 */
export interface DomainGlobal<G> {
  /**
   * 当前值，从权威的内存内状态同步取得。在首次 `set` 之前为 spec 的 `initial`。
   * @returns 当前全局值。
   */
  get(): G

  /**
   * 持久化地替换该值。在领域的写入链上排队；首个 `set` 正是将全局物化到介质上的动作。
   * @param value - 新值；必须满足 spec 的 schema（此处不再复核——校验发生在持久化读取边界）。
   * @returns 持久化且事件发射后的结算。
   */
  set(value: G): Promise<void>
}

/**
 * 一个已声明表的句柄。记录是纯不可变数据：返回的值是存储对象本身（无防御性拷贝），不得就地修改——应通过 `put`/`update` 替换。
 */
export interface KvTable<K extends string, V> {
  /**
   * 读取一条记录，从内存同步进行。
   * @param key - 记录键。
   * @returns 记录；缺失时为 `undefined`。
   */
  get(key: K): V | undefined

  /**
   * 遍历 `[key, record]` 对的快照迭代器。是快照而非实时视图：迭代在已排队的写入落地期间保持稳定。
   * @returns 键值对迭代器。
   */
  entries(): IterableIterator<[K, V]>

  /**
   * 遍历键的快照迭代器。
   * @returns 键迭代器。
   */
  keys(): IterableIterator<K>

  /** 当前记录数。 */
  readonly size: number

  /**
   * 持久化地插入或覆盖一条记录。
   * @param key - 记录键。
   * @param value - 完整的新记录（非部分合并）。
   * @returns 持久化且事件发射后的结算。
   */
  put(key: K, value: V): Promise<void>

  /**
   * 持久化地删除一条记录。
   * @param key - 记录键。
   * @returns 当记录存在时为 `true`，当本就已缺失时为 `false`（此种情况下无写入、无事件）。
   */
  delete(key: K): Promise<boolean>

  /**
   * 在领域的写入链上执行原子的读-改-写：`fn` 看到的是其排队槽位处的当前值，因此并发更新不会交错。
   * @param key - 记录键；缺失的键以 `missing-key` 拒绝。
   * @param fn - 从当前记录到下一记录的同步纯函数变换。
   * @returns 存储的下一记录。
   */
  update(key: K, fn: (current: V) => V): Promise<V>
}

/** 一个 spec 的全局句柄：声明时为有类型，未声明时为 `never`（不可访问）。 */
export type DomainGlobalHandleOf<S extends DomainSpec> =
  S extends { readonly global: DomainGlobalSpec<infer G> } ? DomainGlobal<G> : never

/** 一个已打开的领域，由其 spec 定型。 */
export interface Domain<S extends DomainSpec> {
  /** 来自 spec 的领域名。 */
  readonly name: string
  /** 全局单例句柄；未声明 `global` 的 spec 没有可用的句柄（`never`）。 */
  readonly global: DomainGlobalHandleOf<S>
  /**
   * 解析一个已声明表的句柄。句柄是稳定的——重复调用返回同一实例。
   * @param name - 已声明的表名。
   * @returns 已定型的表句柄。
   */
  table<N extends keyof S['tables'] & string>(name: N): KvTable<TableKeyOf<S, N>, TableValueOf<S, N>>

  /**
   * 关闭此领域：立即拒绝新的写入，排干已排队的写入（其事件仍会发射），释放后端单元，随后释放领域名以便稍后重新打开。
   * 幂等——重复调用共享同一次拆卸。消费者拥有此调用（通常作为其自身的 `ctx.effect` disposer）；
   * 设施会在卸载时关闭任何仍处于打开状态的领域。
   * @returns 单元释放后的结算。
   */
  close(): Promise<void>
}

/** 内部边界：将表句柄交给其领域拥有的写入机制。 */
interface TableHost {
  readonly domainName: string
  readonly unit: KvUnit
  /** 在领域唯一的写入链上排队一个任务。 */
  enqueue<T>(job: () => Promise<T>): Promise<T>
  /** 领域完全关闭后置位，此时新写入会被拒绝（排干期间读取仍有效）。 */
  assertReadable(): void
  /** 为一次已持久落地的写入发射 `domain/changed`。 */
  emitChanged(change: DomainChanged): void
}

const noop = () => {}

/**
 * 位于 {@link Domain} 接口背后的唯一领域实现。设施从一个已校验的 `loadAll` 快照构造它，并将其擦除为
 * `Domain<S>`；本包之外没有任何代码会构造一个。
 */
export class DomainImpl {
  /** 来自 spec 的领域名。 */
  readonly name: string

  private readonly tables = new Map<string, KvTableImpl<string, unknown>>()
  private globalValue: unknown
  private readonly globalHandle?: DomainGlobal<unknown>

  /** 写入链的尾部；每个环节都会结算（拒绝由调用方的分片观察到）。 */
  private chain: Promise<void> = Promise.resolve()
  /** 在 close 开始时置位：新的写入被拒绝，已排队的写入继续排干。 */
  private disposing = false
  /** 在 close 完成时置位（链已排干、单元已关闭）：此后读取会被拒绝。 */
  private closed = false
  private disposal?: Promise<void>

  /**
   * @param ctx - 承载 `domain/changed` 发射的 Context。
   * @param spec - 领域声明。
   * @param unit - 已打开的后端单元；此实例拥有其生命周期。
   * @param records - 来自单元 `loadAll` 的已校验记录，每个已声明表一项（含空映射）——设施按 spec 构建它，因此条目集合即表集合。
   * @param globalValue - 已校验的已存储全局值；介质上没有时则为 spec 的 `initial`；spec 未声明全局时为 `undefined`。
   * @param onClosed - 拆卸完成后运行一次的设施钩子；释放领域名以便稍后打开。
   */
  constructor(
    private readonly ctx: Context,
    spec: DomainSpec,
    private readonly unit: KvUnit,
    records: Map<string, Map<string, unknown>>,
    globalValue: unknown,
    private readonly onClosed: () => void,
  ) {
    this.name = spec.name
    const host: TableHost = {
      domainName: spec.name,
      unit,
      enqueue: job => this.enqueue(job),
      assertReadable: () => { this.assertReadable() },
      emitChanged: (change) => { this.emitChanged(change) },
    }
    for (const [table, tableRecords] of records) {
      this.tables.set(table, new KvTableImpl(host, table, tableRecords))
    }
    if (spec.global !== undefined) {
      this.globalValue = globalValue
      this.globalHandle = {
        get: () => {
          this.assertReadable()
          return this.globalValue
        },
        set: value => this.enqueue(async () => {
          await this.unit.setGlobal(value)
          this.globalValue = value
          this.emitChanged({ domain: this.name, table: '', key: '', operation: 'put', value })
        }),
      }
    }
  }

  /** 全局单例句柄；在未声明全局的 spec 上访问它属于调用方错误并抛出。 */
  get global(): DomainGlobal<unknown> {
    if (this.globalHandle === undefined) {
      throw new Error(`domain '${this.name}' declares no global`)
    }
    return this.globalHandle
  }

  /**
   * 解析一个已声明表的句柄；未声明的名称属于调用方错误并抛出。
   * @param name - 已声明的表名。
   * @returns 稳定的表句柄。
   */
  table(name: string): KvTable<string, unknown> {
    const table = this.tables.get(name)
    if (table === undefined) {
      throw new Error(`domain '${this.name}' declares no table '${name}'`)
    }
    return table
  }

  /**
   * 关闭此领域：立即拒绝新的写入，排干已排队的写入（其事件仍会发射），关闭单元，随后通过设施钩子释放名称。
   * 幂等——重复调用共享同一次拆卸。
   * @returns 单元释放后的结算。
   */
  close(): Promise<void> {
    this.disposal ??= this.runClose()
    return this.disposal
  }

  private async runClose(): Promise<void> {
    this.disposing = true
    // 链环节永不拒绝（每个都通过 then(noop, noop) 结算），因此此 await 是纯粹的排干屏障。
    await this.chain
    await this.unit.close()
    this.closed = true
    this.onClosed()
  }

  /**
   * 分发一次持久化之后的变更通知，吞掉观察者失败：写入已经提交（介质与内存都持有新状态），
   * 因此抛出的监听器不得回退地拒绝它。
   */
  private emitChanged(change: DomainChanged): void {
    try {
      this.ctx.emit('domain/changed', change)
    } catch (error) {
      // 仅吞掉同步观察者异常：emit 内联分派监听器，try 内不运行任何其他内容。事件是通知，而非事务参与者——
      // 提交点已经过去，因此包含（附带日志的）遏制是唯一正确的结果。
      this.ctx.logger.warn(`domain '${this.name}': domain/changed listener failed: ${String(error)}`)
    }
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    if (this.disposing) {
      return Promise.reject(new DomainError('closed', `domain '${this.name}' is closed`))
    }
    const result = this.chain.then(job)
    this.chain = result.then(noop, noop)
    return result
  }

  private assertReadable(): void {
    if (this.closed) {
      throw new DomainError('closed', `domain '${this.name}' is closed`)
    }
  }
}

/** 绑定到一个内存内记录映射及其领域写入链的表句柄。 */
class KvTableImpl<K extends string, V> implements KvTable<K, V> {
  constructor(
    private readonly host: TableHost,
    private readonly tableName: string,
    private readonly records: Map<string, unknown>,
  ) {}

  get(key: K): V | undefined {
    this.host.assertReadable()
    return this.records.get(key) as V | undefined
  }

  entries(): IterableIterator<[K, V]> {
    this.host.assertReadable()
    return ([...this.records.entries()] as [K, V][])[Symbol.iterator]()
  }

  keys(): IterableIterator<K> {
    this.host.assertReadable()
    return ([...this.records.keys()] as K[])[Symbol.iterator]()
  }

  get size(): number {
    this.host.assertReadable()
    return this.records.size
  }

  put(key: K, value: V): Promise<void> {
    return this.host.enqueue(async () => {
      await this.host.unit.putRecord(this.tableName, key, value)
      this.records.set(key, value)
      this.emitPut(key, value)
    })
  }

  delete(key: K): Promise<boolean> {
    return this.host.enqueue(async () => {
      // 存在性在此任务的链槽处决定，而非在调用时：此前排队的同一键 put 会让本删除观察到它。
      if (!this.records.has(key)) return false
      await this.host.unit.deleteRecord(this.tableName, key)
      this.records.delete(key)
      this.host.emitChanged({
        domain: this.host.domainName,
        table: this.tableName,
        key,
        operation: 'deleted',
      })
      return true
    })
  }

  update(key: K, fn: (current: V) => V): Promise<V> {
    return this.host.enqueue(async () => {
      if (!this.records.has(key)) {
        throw new DomainError(
          'missing-key',
          `domain '${this.host.domainName}' table '${this.tableName}' has no record '${key}' to update`,
        )
      }
      const next = fn(this.records.get(key) as V)
      await this.host.unit.putRecord(this.tableName, key, next)
      this.records.set(key, next)
      this.emitPut(key, next)
      return next
    })
  }

  private emitPut(key: K, value: V): void {
    this.host.emitChanged({
      domain: this.host.domainName,
      table: this.tableName,
      key,
      operation: 'put',
      value,
    })
  }
}
