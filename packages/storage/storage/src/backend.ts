/**
 * 存储中枢面向后端的概念词汇：一个后端拥有一种介质（文件树根目录、数据库文件）并对外暴露针对该介质的操作分组。
 * 本模块定义了供后端实现者遵循的规范性契约文本；`tests/contract.ts` 中的共享一致性测试套件会检查每一条规则。
 * @module @deepseek-ai/dsh-storage/src/backend
 */

/** 单元名与表名的允许格式：既可作为文件名安全使用，也可作为无需转义的 SQL 标识符片段。 */
export const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/

/**
 * 一个已注册的后端。一个后端恰好拥有一种介质，并在所有 facet 间共享其生命周期；facet 为可选成员——无法服务某类数据的后端直接省略该成员，解析时则显式失败。
 */
export interface StorageBackend {
  /** 键值操作；当此后端无法服务时缺省不存在。 */
  readonly kv?: KvFacet

  /**
   * 排干所有已打开单元中在途的写入并释放介质。幂等；并发与重复调用会在拆卸完成后统一结算。
   * @returns 介质释放后的结算。
   */
  close(): Promise<void>
}

/** 键值数据形态：整单元快照加上按记录的持久化写入。 */
export interface KvFacet {
  /**
   * 打开一个单元；当介质上尚无任何该单元的痕迹时则创建它（物化可推迟到首次写入，但 {@link KvUnit.loadAll} 必须立即返回空形态）。
   * 介质上已盖有的版本若与 `descriptor.version` 不同，则以 `version-mismatch` 拒绝；介质无法解析为当前单元时以 `malformed-medium` 拒绝。
   * 未关闭即重复打开同一单元名属于调用方错误，同样拒绝。
   * @param descriptor - 待打开单元的静态身份与形态。
   * @returns 已打开的单元。
   */
  open(descriptor: KvUnitDescriptor): Promise<KvUnit>
}

/** 一个 KV 单元的静态身份与形态，由其属主的 spec 投影而来。 */
export interface KvUnitDescriptor {
  /** 单元名；必须与 {@link UNIT_NAME_RE} 匹配。同时作为文件名 / SQL 标识符片段。 */
  readonly name: string
  /** 单元格式版本；首次物化时盖在介质上的非负整数。 */
  readonly version: number
  /** 表名；每个都必须与 {@link UNIT_NAME_RE} 匹配。 */
  readonly tables: readonly string[]
  /** 此单元是否携带全局单例槽位。 */
  readonly hasGlobal: boolean
  /**
   * 介质布局。`single`（默认）将整个单元保存在单一文档中；`per-record` 将每条记录保存在各自独立的文档中，
   * 因此记录体量较大或稀疏的单元在单次写入时不会重写其余记录，且未被接受的版本戳只会丢弃该条记录，而不会拒绝整个单元。
   * 仅服务一种布局的后端将另一种布局的单元视为外部文档。
   */
  readonly layout?: 'single' | 'per-record'
  /**
   * 较旧的单元版本，其已存储记录在声明属主当前的记录 schema 下同样可读（属主对此作出担保——通常通过将旧记录缺失的字段声明为可选）。
   * `per-record` 单元在读取时接受盖有任一枚举版本戳的文档，旧式整单元引导流程会接受盖有其一的遗留文件；写入始终使用 {@link version} 盖戳。
   * `single` 布局的读取仍保持精确版本。
   */
  readonly compatibleVersions?: readonly number[]
}

/**
 * 一个已打开的单元。对本层而言值为不透明 JSON：无 schema、无事件、无领域语义。
 * 单元并不串行化并发写入——写入顺序由调用方负责（领域层为每个单元运行单一的写入链）；单元仅保证每次单一调用在介质上是原子性的，
 * 并在结算后持久（结算后崩溃、再重新打开可观察到该写入）。{@link close} 之后的任何调用均以 `closed` 拒绝。
 */
export interface KvUnit {
  /**
   * 读取完整的当前快照。
   * @returns 以表名为键的各表记录，外加全局单例（从未写入或未声明时为 `null`）。
   */
  loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }>

  /**
   * 持久化地 upsert 一条记录。覆盖语义：已存在的键被替换。
   * @param table - 已声明的表名。
   * @param key - 记录键。在 `per-record` 布局中键成为路径片段，必须与 `[a-zA-Z0-9_-]+` 匹配（不安全的键会被拒绝）；在 `single` 布局中键保持不透明。
   * @param value - 不透明的可 JSON 序列化记录。
   * @returns 持久化后的结算。
   */
  putRecord(table: string, key: string, value: unknown): Promise<void>

  /**
   * 持久化地删除一条记录。幂等：缺失的键为无操作。
   * @param table - 已声明的表名。
   * @param key - 记录键。
   * @returns 持久化后的结算。
   */
  deleteRecord(table: string, key: string): Promise<void>

  /**
   * 将一条记录的已存储文档移出单元的可读集合，保留其字节以供检查而非删除。介质没有可移动的逐记录文档（如 `single` 布局、行存储）的后端省略此成员，
   * 调用方回退到其显式拒绝路径。移动后该键不再存在：随后的 {@link loadAll} 将该键读作缺失，随后的 {@link putRecord} 会重新创建它。
   * @param table - 已声明的表名。
   * @param key - 记录键。
   * @returns 文档被移动到的介质位置（用于诊断）。
   */
  backupRecord?(table: string, key: string): Promise<string>

  /**
   * 持久化地写入全局单例。仅在 descriptor 声明了 `hasGlobal` 时有效。
   * @param value - 不透明的可 JSON 序列化值。
   * @returns 持久化后的结算。
   */
  setGlobal(value: unknown): Promise<void>

  /**
   * 排干本单元在途的写入并释放它。幂等。
   * @returns 单元释放后的结算。
   */
  close(): Promise<void>
}
