/** 持久 Session JSON 边界上被接纳的标量值。 */
export type SessionFormatJsonPrimitive = null | boolean | number | string

/** 持久 Session 边界上被接纳的无损 JSON 值。 */
export type SessionFormatJsonValue =
  | SessionFormatJsonPrimitive
  | readonly SessionFormatJsonValue[]
  | SessionFormatJsonObject

/** 持久 Session 边界上被接纳的无损 JSON 对象。 */
export interface SessionFormatJsonObject {
  readonly [key: string]: SessionFormatJsonValue
}

/** 受支持的历史格式与当前格式共用的逻辑 Session 元数据。 */
export interface SessionFormatHeader extends SessionFormatJsonObject {
  readonly version: number
  readonly id: string
  readonly createdAt: number
  readonly cwd?: string
  readonly parentSession?: string
  readonly isSeeded: boolean
  readonly origin?: 'subagent'
  readonly delegationDepth: number
  readonly agentPreset?: string
}

/** 一个已解码的逻辑 Session 事件。 */
export interface SessionFormatEvent extends SessionFormatJsonObject {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: SessionFormatJsonValue
}

/** 一个已分离的完整逻辑 Session 制品。 */
export interface SessionFormatArtifact {
  readonly header: SessionFormatHeader
  /** 精确的继承前缀长度，仅在读取完事件体后可用。 */
  readonly inheritedEventCount: number
  readonly events: readonly SessionFormatEvent[]
}

/** 一个独立维护的相邻流式迁移。 */
export interface SessionFormatMigration {
  readonly name: string
  readonly fromVersion: number
  readonly toVersion: number
  /** 在无需读取事件体的前提下转换一个头部。 */
  migrateHeader(header: SessionFormatHeader): SessionFormatHeader
  /** 为一个源制品创建有状态的事件体阶段。 */
  createStage(input: SessionFormatMigrationStageInput): SessionFormatMigrationStage
  /** 拒绝相邻目标写入器无法发出的任何头部。 */
  validateTargetHeader(header: SessionFormatHeader): void
}

/** 创建一个相邻事件体阶段时提供的头部与继承切点。 */
export interface SessionFormatMigrationStageInput {
  /** 本相邻边已校验的源元数据。 */
  readonly sourceHeader: SessionFormatHeader
  /** 由本边头部迁移产生的、已校验的目标元数据。 */
  readonly targetHeader: SessionFormatHeader
  /** 以源坐标表示的继承前缀长度；事件体解码完成前为 undefined。 */
  readonly sourceInheritedEventCount: number | undefined
  /** 本边消费的是物理解码输出，还是前一次迁移的已校验输出。 */
  readonly sourceKind: 'decoded' | 'transformed'
}

/** 编译唯一完整迁移链所需的输入。 */
export interface SessionFormatChainOptions {
  readonly currentVersion: number
  readonly migrations: readonly SessionFormatMigration[]
  /** 在无需读取事件体的前提下恢复并校验一个已分离的当前头部。 */
  readonly restoreCurrentHeader: (header: SessionFormatHeader) => SessionFormatHeader
}

/** 纯相邻规划器与流式迁移编译器。 */
export interface SessionFormatChain {
  readonly currentVersion: number
  /** 为一个已解码的源制品编译完整的迁移阶段链。 */
  createStream(
    header: SessionFormatHeader,
    inheritedEventCount: number | undefined,
    context: SessionFormatMigrationContext,
  ): SessionFormatMigrationStream
  /** 仅将一个受支持的头部转换为当前逻辑表示。 */
  migrateHeader(header: SessionFormatHeader): SessionFormatHeader
}

/** 为一次恢复选定的物理行失败策略。 */
export type SessionFormatRecovery = 'strict' | 'recoverable'

/** 某个 Session 版本受支持表示形式的纯物理 JSON 编解码器；既定含义保持稳定。 */
export interface SessionFormatCodec {
  readonly version: number
  /** 将一个物理头部解码为与事件体无关的逻辑元数据。 */
  decodeHeader(value: unknown): SessionFormatHeader
  /** 以显式失败策略创建一个逐行解码器。 */
  createDecoder(headerValue: unknown, recovery: SessionFormatRecovery): SessionFormatArtifactDecoder
}

/** 流式持久化恢复使用的有状态物理行解码器。 */
export interface SessionFormatArtifactDecoder {
  readonly header: SessionFormatHeader
  /** 事件体解码前已知的继承切点；当前格式可在 EOF 处推导它。 */
  readonly headerInheritedEventCount?: number
  /** 解码一个物理行，并同步发出其事件或紧凑 run。 */
  decodeRow(
    rowValue: unknown,
    context: SessionFormatMigrationContext,
  ): void
  /** 完成行校验并返回精确的继承切点。 */
  finish(context: SessionFormatMigrationContext): number
}

/** 已安装当前格式使用的无状态物理记录编码器。 */
export interface SessionFormatCurrentEncoder {
  /** 为一个当前制品编码物理头部记录。 */
  encodeHeader(header: SessionFormatHeader, inheritedEventCount: number): SessionFormatJsonObject
  /** 将一个当前逻辑事件编码为一条物理记录。 */
  encodeEvent(event: SessionFormatEvent): SessionFormatJsonObject
}

/** 编解码器拥有的紧凑 run，相邻迁移可无需展开直接消费。 */
export interface SessionFormatEventRun {
  readonly runType: string
  readonly firstSeq: number
  readonly eventCount: number
  /** 为没有直接处理器的迁移展开该 run。 */
  expand(): Iterable<SessionFormatEvent>
}

/** 由已编译迁移流拥有的同步输出通道。 */
export interface SessionFormatMigrationContext {
  /** 在返回前将一个已确定事件投递给下一阶段。 */
  emitEvent(event: SessionFormatEvent): void
  /** 在返回前将一个紧凑事件 run 投递给下一阶段。 */
  emitRun(run: SessionFormatEventRun): void
}

/** 流式持久化恢复使用的有状态相邻迁移阶段。 */
export interface SessionFormatMigrationStage {
  /** 继承切点未变化且 EOF 前已知时的目标继承切点。 */
  readonly headerInheritedEventCount?: number
  /** 转换一个源事件，并同步发出每一个已确定的目标项。 */
  transformEvent(
    event: SessionFormatEvent,
    context: SessionFormatMigrationContext,
  ): void
  /** 转换一个紧凑源 run，无需中间的展开数组。 */
  transformRun(
    run: SessionFormatEventRun,
    context: SessionFormatMigrationContext,
  ): void
  /** 发出尾部目标项并返回精确的目标继承切点。 */
  finish(context: SessionFormatMigrationContext): number
}

/** 一条已组合的迁移链，向其持有者发出已确定的当前事件。 */
export interface SessionFormatMigrationStream extends SessionFormatMigrationContext {
  readonly header: SessionFormatHeader
  /** 结算所有迁移阶段并返回精确的当前继承切点。 */
  finish(): number
}

/** 仅看头部的分类结果，永不检查事件行。 */
export type SessionFormatHeaderReadResult =
  | {
    readonly status: 'current' | 'migration-required'
    readonly storedVersion: number
    readonly targetVersion: number
    /** 最新的逻辑头部。精确的继承切点需要读取事件体。 */
    readonly header: SessionFormatHeader
  }
  | {
    readonly status: 'unsupported'
    readonly storedVersion: number
    readonly targetVersion: number
    readonly reason: string
  }
  | {
    readonly status: 'malformed'
    readonly storedVersion?: number
    readonly targetVersion: number
    readonly reason: string
  }

/** 构建静态物理编解码器与迁移目录所需的输入。 */
export interface SessionFormatCatalogOptions extends SessionFormatChainOptions {
  readonly codecs: readonly SessionFormatCodec[]
  /** 恢复并校验一个完整的当前制品。 */
  readonly restoreCurrent: (artifact: SessionFormatArtifact) => SessionFormatArtifact
  /** 编码当前记录，无需物化一个制品规模的记录数组。 */
  readonly currentEncoder: SessionFormatCurrentEncoder
  /** 校验一个独占所有的、已转换的制品，无需复制或冻结它。 */
  readonly restoreTransformedCurrent: (artifact: SessionFormatArtifact) => SessionFormatArtifact
}

/** 一次物理行恢复所应用的策略。 */
export interface SessionFormatRestoreOptions {
  readonly recovery: SessionFormatRecovery
  /**
   * `current` 应用全部已安装的当前格式校验。`transformed` 仅在迁移之后应用
   * 已发布的当前格式校验；当前输入只接受编解码器校验。
   */
  readonly validation: 'transformed' | 'current'
}

/** 构建静态的物理分发与相邻迁移目录。 */
export interface SessionFormatCatalog {
  readonly currentVersion: number
  /** 在无需读取事件行的前提下分类并转换一个头部。 */
  readHeader(headerValue: unknown): SessionFormatHeaderReadResult
  /** 创建一次单趟物理行恢复，得到当前逻辑事件。 */
  createRestore(headerValue: unknown, options: SessionFormatRestoreOptions): SessionFormatRestore
  /** 编码一条当前物理头部记录。 */
  encodeCurrentHeader(header: SessionFormatHeader, inheritedEventCount: number): SessionFormatJsonObject
  /** 编码一条当前物理事件记录。 */
  encodeCurrentEvent(event: SessionFormatEvent): SessionFormatJsonObject
}

/** 一次由调用方持有的物理行恢复，其最终值是一个当前逻辑制品。 */
export interface SessionFormatRestore {
  /** 事件体解码前即可用的当前逻辑头部。 */
  readonly header: SessionFormatHeader
  /** 按文件顺序解码一个物理行。 */
  decodeRow(rowValue: unknown): void
  /** 完成所有解码器与迁移阶段，并返回当前制品。 */
  finish(): SessionFormatArtifact
}
