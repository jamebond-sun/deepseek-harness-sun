/**
 * 领域声明概念词汇。一个 spec 对象是领域身份、布局与记录 schema 的唯一来源：所属包用 {@link defineDomain} 声明一次，
 * 类型面与运行时（校验、descriptor 投影）都从中派生。记录 schema 使用 zod
 * （`z.infer` 避免类型重复，且同样的 schema 后续会投影到 RPC 线上 schema）；插件 `Config` 仍使用 schemastery。
 * @module @deepseek-ai/dsh-storage-domain/src/spec
 */

import type { ZodType } from 'zod'
import { UNIT_NAME_RE, type KvUnitDescriptor } from '@deepseek-ai/dsh-storage'

/** 全局单例声明：schema 外加首次写入前使用的值。 */
export interface DomainGlobalSpec<G> {
  /** 在持久化边界校验已存储的全局值。 */
  readonly schema: ZodType<G>
  /** 介质尚未持有全局值时服务的值；在首个 `set` 之前不写入。 */
  readonly initial: G
}

/**
 * 一个表声明。`K` 是为编译期投影而携带的幽灵键类型（通常为 branded string）；
 * 在介质上键是普通字符串。
 */
export interface DomainTableSpec<K extends string = string, V = unknown> {
  /** 在持久化边界校验每条已存储记录。 */
  readonly valueSchema: ZodType<V>
  /** 键类型的幽灵载体；运行时从不出现。 */
  readonly __key?: K
}

/** 一个领域的静态声明：身份、版本与记录布局。 */
export interface DomainSpec {
  /** 领域名；必须与 `UNIT_NAME_RE` 匹配（同时作为后端单元名）。 */
  readonly name: string
  /** 当前领域格式版本；读取按所选布局强制其约束。 */
  readonly version: number
  /**
   * 后端单元的介质布局：`single`（默认）将整个单元作为一个文档存储；`per-record` 将每条记录作为各自的文档存储，
   * 适用于记录体量大、稀疏或各自可丢弃的单元——投影缓存——并将版本检查限定在每条记录上
   * （未被接受的记录文档被丢弃，而非迁移）。
   */
  readonly layout?: 'single' | 'per-record'
  /**
   * 当前记录 schema 也能接受的较旧领域版本（声明属主对此担保，通常通过将旧记录缺失的字段声明为可选）。
   * `per-record` 后端读取盖有枚举版本戳的文档而非丢弃它们，并接受一个如此盖戳的遗留整单元文件用于一次性引导；
   * 写入始终使用 {@link version} 盖戳。
   */
  readonly compatibleVersions?: readonly number[]
  /**
   * `open` 对一条未通过其 zod schema 的已存储表记录应采取的行为。缺省（默认）时整个 open 以 `invalid-record` 拒绝——
   * 适合权威数据。`'backup-and-skip'` 适用于记录为可丢弃派生数据的领域：后端将记录的文档移开
   * （`KvUnit.backupRecord`），失败连同其 cause 被记录，open 在缺失该记录的情况下继续。
   * 没有 `backupRecord` 的后端（无可移动的逐记录文档）回退到拒绝的默认行为。全局槽位始终拒绝。
   */
  readonly invalidRecords?: 'backup-and-skip'
  /** 可选的全局单例槽位。 */
  readonly global?: DomainGlobalSpec<unknown>
  /** 以表名为键的表声明；每个名称必须与 `UNIT_NAME_RE` 匹配。 */
  readonly tables: Record<string, DomainTableSpec>
}

/** 一个已声明表的键类型，从其幽灵载体恢复。 */
export type TableKeyOf<S extends DomainSpec, N extends keyof S['tables']> =
  S['tables'][N] extends DomainTableSpec<infer K> ? K : never

/** 一个已声明表的值类型。 */
export type TableValueOf<S extends DomainSpec, N extends keyof S['tables']> =
  S['tables'][N] extends DomainTableSpec<string, infer V> ? V : never

/** 一个 spec 的全局值类型；spec 未声明全局时为 `never`。 */
export type GlobalValueOf<S extends DomainSpec> =
  S['global'] extends DomainGlobalSpec<infer G> ? G : never

/**
 * 声明一个表。
 * @param schema - 校验该表每条已存储记录的 zod schema。
 * @returns 由 `K` 定键类型的表声明。
 */
export function domainTable<K extends string, V>(schema: ZodType<V>): DomainTableSpec<K, V> {
  return { valueSchema: schema }
}

/**
 * 固定 spec 字面量类型并校验其字段的身份辅助函数。错误配置在所属包的模块加载时显式失败，早于任何介质被触及：
 * 位于 `UNIT_NAME_RE` 之外的领域名或表名、非非负整数的版本，或接受 `null` 的全局 schema 都会抛出。
 * `null` 拒绝守卫了往返：后端以不透明 JSON 存储全局，用 `null` 作为"从未写入"的哨兵，
 * 因此可空的全局在重新打开时将与缺失的全局无法区分（已存储的 `null` 会静默回退为 `initial`）。
 * @param spec - 领域声明。
 * @returns 同一 spec，收窄为其字面量类型。
 */
export function defineDomain<S extends DomainSpec>(spec: S): S {
  if (!UNIT_NAME_RE.test(spec.name)) {
    throw new Error(`domain name '${spec.name}' must match ${UNIT_NAME_RE}`)
  }
  if (!Number.isInteger(spec.version) || spec.version < 0) {
    throw new Error(`domain '${spec.name}' version must be a non-negative integer, got ${spec.version}`)
  }
  for (const compat of spec.compatibleVersions ?? []) {
    if (!Number.isInteger(compat) || compat < 0 || compat >= spec.version) {
      throw new Error(
        `domain '${spec.name}' compatibleVersions entries must be non-negative integers below version ${spec.version}, got ${compat}`,
      )
    }
  }
  if (spec.layout !== undefined) {
    // 运行时边界：联合类型仅存在于编译期——由配置构建的 spec 可能携带任意值，坏的必须在此显式失败。
    const layout: string = spec.layout
    if (layout !== 'single' && layout !== 'per-record') {
      throw new Error(`domain '${spec.name}' layout must be 'single' or 'per-record', got ${layout}`)
    }
  }
  if (spec.invalidRecords !== undefined) {
    const policy: string = spec.invalidRecords
    if (policy !== 'backup-and-skip') {
      throw new Error(`domain '${spec.name}' invalidRecords must be 'backup-and-skip' when present, got ${policy}`)
    }
  }
  for (const table of Object.keys(spec.tables)) {
    if (!UNIT_NAME_RE.test(table)) {
      throw new Error(`domain '${spec.name}' table name '${table}' must match ${UNIT_NAME_RE}`)
    }
  }
  if (spec.global !== undefined && spec.global.schema.safeParse(null).success) {
    throw new Error(
      `domain '${spec.name}' global schema must not accept null: `
      + 'null is the medium\'s "never written" sentinel, so a stored null could not round-trip',
    )
  }
  return spec
}

/**
 * 将一个 spec 投影到面向后端的单元 descriptor。
 * @param spec - 领域声明。
 * @returns 交给 `KvFacet.open` 的 descriptor。
 */
export function descriptorOf(spec: DomainSpec): KvUnitDescriptor {
  return {
    name: spec.name,
    version: spec.version,
    tables: Object.keys(spec.tables),
    hasGlobal: spec.global !== undefined,
    ...spec.layout === undefined ? {} : { layout: spec.layout },
    ...spec.compatibleVersions === undefined ? {} : { compatibleVersions: spec.compatibleVersions },
  }
}
