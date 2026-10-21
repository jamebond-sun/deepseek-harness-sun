/**
 * 领域数据形式（`ctx.storage.domain`）：基于存储后端的、经过 schema 校验且会发射变更的 KV 领域。
 * 领域层的唯一实现——消费者依赖本包，绝不直接接触后端。Plugin 的 `Config` 使用 schemastery；
 * 领域 spec 内的记录 schema 使用 zod（拆分理由见 `src/spec.ts`）。
 * @module @deepseek-ai/dsh-storage-domain
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { DomainError } from './error.ts'
import { descriptorOf } from './spec.ts'
import type { DomainSpec } from './spec.ts'
import { DomainImpl } from './domain.ts'
import type { Domain } from './domain.ts'

export { DomainError } from './error.ts'
export type { DomainErrorCode, DomainErrorOptions, InvalidRecordDetail } from './error.ts'
export { defineDomain, domainTable, descriptorOf } from './spec.ts'
export type {
  DomainSpec, DomainGlobalSpec, DomainTableSpec,
  TableKeyOf, TableValueOf, GlobalValueOf,
} from './spec.ts'
export type { DomainChanged } from './events.ts'
export type { Domain, DomainGlobal, DomainGlobalHandleOf, KvTable } from './domain.ts'

declare module '@deepseek-ai/dsh-storage' {
  interface StorageForms {
    domain: DomainFacility
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    storageDomain: DomainFacility
  }
}

/** Cordis 插件名称。 */
export const name = 'storage-domain'
/** 在形态可挂载之前，存储中枢必须存在。 */
export const inject = ['storage']

/**
 * 插件配置。哪个后端服务哪个领域在此决定，而非在中枢上全局决定：`backend` 是默认路由，`routes` 对每个领域名覆盖它。
 * 命名了未注册后端的路由在 `open` 时以 `backend-not-found` 显式失败。
 */
export interface Config {
  /** 每个未显式路由的领域所用的默认后端名。必填：不存在普适正确的介质。 */
  backend: string
  /** 逐领域覆盖：领域名 → 后端名。 */
  routes?: Record<string, string>
}

export const Config: z<Config> = z.object({
  backend: z.string().required(),
  routes: z.dict(z.string()).default({}),
})

/**
 * 已挂载的领域设施。在已路由的后端上打开已声明的领域；一个设施实例拥有已打开领域表，并强制每个领域名单一打开。
 */
export class DomainFacility {
  private readonly domains = new Map<string, DomainImpl>()
  /** 由在途或已完成打开保留的名称，以便同一名称的并发打开显式失败。 */
  private readonly reserved = new Set<string>()

  /**
   * @param ctx - 领域插件的 Context；已打开领域的 effect 与变更事件附于此。
   * @param config - 已校验的插件配置。
   */
  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
  ) {}

  /**
   * 打开一个已声明的领域。每一步都会使整个调用失败：拒绝一个已经打开的名称（`already-open`）；
   * 解析后端路由（来自中枢的 `backend-not-found` 透传）；要求其 `kv` facet（`facet-unsupported`）；
   * 打开由 spec 投影的单元（后端的 `version-mismatch`/`malformed-medium` 透传）；
   * 针对 spec 的 zod schema 加载并校验每条已存储记录（`invalid-record`，附带出问题的表与键——
   * 除非 spec 声明 `invalidRecords: 'backup-and-skip'` 且单元能移开文档，此时失败记录被备份、记录日志并跳过）；构造领域。
   *
   * 生命周期：调用方拥有返回的句柄并通过 `Domain.close()` 关闭它（通常作为其自身的 `ctx.effect` disposer）——
   * 设施不会将该领域绑定到任何消费者纤程。设施卸载时仍处于打开状态的领域由插件 disposer 关闭。
   * @param spec - 领域声明，通常来自 `defineDomain`。
   * @returns 已打开的领域句柄，由 spec 定型。
   */
  async open<S extends DomainSpec>(spec: S): Promise<Domain<S>> {
    if (this.reserved.has(spec.name)) {
      throw new DomainError('already-open', `domain '${spec.name}' is already open`)
    }
    this.reserved.add(spec.name)
    try {
      const backendName = this.config.routes?.[spec.name] ?? this.config.backend
      const backend = this.ctx.storage.backend.get(backendName)
      if (!backend.kv) {
        throw new DomainError(
          'facet-unsupported',
          `backend '${backendName}' routed for domain '${spec.name}' has no kv facet`,
        )
      }
      const unit = await backend.kv.open(descriptorOf(spec))
      try {
        const snapshot = await unit.loadAll()
        const tables = new Map<string, Map<string, unknown>>()
        for (const [table, tableSpec] of Object.entries(spec.tables)) {
          const records = new Map<string, unknown>()
          for (const [key, raw] of Object.entries(snapshot.tables[table] ?? {})) {
            let parsed: unknown
            try {
              parsed = parseRecord(spec.name, table, key, () => tableSpec.valueSchema.parse(raw))
            } catch (error) {
              // 备份并跳过策略（可丢弃的派生数据）：将记录的文档移开，记录具体失败，并在缺失该记录的情况下打开。
              // 无法移动文档的后端保留显式失败路径。
              if (spec.invalidRecords !== 'backup-and-skip' || unit.backupRecord === undefined) throw error
              const moved = await unit.backupRecord(table, key)
              // parseRecord 总是将 zod 失败作为 cause 包装。
              this.ctx.logger.error(
                `domain '${spec.name}': stored record '${key}' in table '${table}' failed schema validation; `
                + `moved to '${moved}' and treated as absent. Cause: ${String((error as DomainError).cause)}`,
              )
              continue
            }
            records.set(key, parsed)
          }
          tables.set(table, records)
        }
        // null 的已存储全局意为"从未写入"：以 `initial` 提供服务而不物化它——首个 `set` 才会写入。
        const globalSpec = spec.global
        const globalValue = globalSpec === undefined
          ? undefined
          : snapshot.global === null
            ? globalSpec.initial
            : parseRecord(spec.name, '', '', () => globalSpec.schema.parse(snapshot.global))
        // onClosed 钩子严格在拆卸完成之后运行：排干期间落地的写入仍会发射 domain/changed，
        // 名称仅在领域完全关闭后才释放以便重新打开。
        const domain: DomainImpl = new DomainImpl(this.ctx, spec, unit, tables, globalValue, () => {
          this.domains.delete(spec.name)
          this.reserved.delete(spec.name)
        })
        this.domains.set(spec.name, domain)
        // 唯一的类型擦除点：DomainImpl 是未定型的运行时，Domain<S> 是 spec 定型的视图；
        // unknown 跳转之所以必要，是因为此处 S 的条件式全局句柄类型仍未被解析。
        return domain as unknown as Domain<S>
      } catch (error) {
        await unit.close()
        throw error
      }
    } catch (error) {
      // 任何失败都意味着领域从未注册（此后不可能再抛出），因此无条件释放名称保留。
      this.reserved.delete(spec.name)
      throw error
    }
  }

  /**
   * 按名称查找一个已打开的领域，未定型。诊断用途；定型消费者持有 {@link open} 返回的句柄。
   * @param name - 领域名。
   * @returns 已打开的领域运行时；未打开时为 `undefined`。
   */
  get(name: string): DomainImpl | undefined {
    return this.domains.get(name)
  }

  /**
   * 关闭本设施上仍处于打开状态的每个领域。供那些从未自行调用 `Domain.close()` 的消费者使用的卸载路径；
   * 关闭是幂等的，因此对已关闭领域的重复关闭无害。
   * @returns 每个单元释放后的结算。
   */
  async closeAll(): Promise<void> {
    await Promise.all([...this.domains.values()].map(domain => domain.close()))
  }
}

/** 运行一次 zod 解析，将失败翻译为携带位置的 `invalid-record`。 */
function parseRecord<T>(domain: string, table: string, key: string, parse: () => T): T {
  try {
    return parse()
  } catch (error) {
    const slot = table === '' ? 'global' : `record '${key}' in table '${table}'`
    throw new DomainError(
      'invalid-record',
      `domain '${domain}': stored ${slot} does not match its schema`,
      { detail: { table, key }, cause: error },
    )
  }
}

/**
 * 在存储中枢上挂载领域数据形式。
 * @param ctx - 插件 Context。
 * @param config - 已校验的插件配置。
 * @returns 在已可用后端集合激活形态之后的结算。
 */
export function apply(ctx: Context, config: Config): Promise<void> {
  const backendServices = [...new Set([
    config.backend,
    ...Object.values(config.routes ?? {}),
  ])].map(storageBackendServiceKey)

  const fiber = ctx.inject(backendServices, (domainCtx) => {
    const facility = new DomainFacility(domainCtx, config)
    domainCtx.effect(() => {
      const unmount = domainCtx.storage.mount('domain', facility)
      return async () => {
        // 在卸载前先关闭残留：排干中的写入仍会发射 domain/changed。
        await facility.closeAll()
        unmount()
      }
    })
    domainCtx.provide('storageDomain', facility)
  })
  return Promise.resolve(fiber).then(() => {})
}
