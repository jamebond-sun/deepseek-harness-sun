/**
 * 领域数据形式的变更事件概念词汇。每次持久化写入在后端确认持久性之后发射一个事件，
 * 携带新的快照以及一个操作判别码——绝不携带旧值（做差值的消费者自行保留其先前快照）。
 * 这是后续阶段跨进程变更推送（RPC 帧）的事件源。
 * @module @deepseek-ai/dsh-storage-domain/src/events
 */

/** 一次持久化领域变更共享的位置字段。 */
export interface DomainChangedBase {
  /** 所属领域名。 */
  readonly domain: string
  /** 表名；全局单例写入为 `''`。 */
  readonly table: string
  /** 记录键；全局单例写入为 `''`。 */
  readonly key: string
}

/** 一条记录（或全局单例）被插入或覆盖。 */
export interface DomainChangedPut extends DomainChangedBase {
  readonly operation: 'put'
  /** 新的快照。 */
  readonly value: unknown
}

/** 一条记录被删除；墓碑不携带值。 */
export interface DomainChangedDeleted extends DomainChangedBase {
  readonly operation: 'deleted'
  readonly value?: never
}

/** 一次持久化领域变更；封闭联合——请按 `operation` 分支。 */
export type DomainChanged = DomainChangedPut | DomainChangedDeleted

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * 一条领域记录或全局单例发生变更，每次写入严格地在后端确认持久性之后发射一次。
     * 同一领域的事件按其写入链顺序到达。
     * @param change - 领域、表（`''` 表示全局）、键（`''` 表示全局）、操作判别码，以及在 `put` 时的新快照。
     * @mode emit
     */
    'domain/changed'(change: DomainChanged): void
  }
}
