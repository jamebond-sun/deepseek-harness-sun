/**
 * 凭证 seam 的、客户端安全的类型界面：两个键品牌、存储记录联合、
 * 跨越 Remote 线路的引用视图，以及该 seam 的 Cordis 事件声明。仅类型——
 * 无运行时代码，且此处不触及任何仅宿主符号，因此客户端编译面读取的正是
 * 宿主所发出的签名。
 *
 * @module @deepseek-ai/dsh-credentials/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** 对单个凭证的名义引用：一个 POSIX 风格的环境变量名。 */
export type CredentialRef = Branded<'CredentialRef'>

/**
 * 单个已存储凭证记录的名义地址：`<scope>/<id>`，其中 `scope` 是拥有该记录的
 * 插件的注册名，`id` 是该插件自身的寻址单元（一个 LLM 适配器使用其提供方
 * 路由键）。
 *
 * scope 是拥有者而非域名，因为记录的载荷以其拥有者的格式写入：若非如此，
 * 两个提供同一提供方名称的插件会互相读取对方的载荷，而一个已卸载插件
 * 留下的记录也无法与一个活跃记录区分开。其中的 `/` 也使这套文法与
 * {@link CredentialRef} 互不相交，因此两个键空间永远不会冲突。
 */
export type CredentialKey = Branded<'CredentialKey'>

/**
 * harness 自身能理解的凭证：一个 api key、提供方环境变量值，或两者兼有。
 * 任一字段都可缺省——同时不带两者的记录表示其拥有者已确认该路由通过自身的
 * 环境发现进行认证，这与“没有记录”是不同的事实。
 */
export interface ApiKeyRecord {
  /** 判别字段。 */
  readonly kind: 'api-key'
  /** 当此凭证确实为一个 key 时，其为非空的秘密值。 */
  readonly key?: string
  /** 提供方环境变量值，如 `AWS_PROFILE`；名称为 POSIX 标识符。 */
  readonly env?: Readonly<Record<string, string>>
}

/**
 * 一次授权许可的产物，按原样保留给其拥有者。该 seam 从不读取、校验或重塑
 * {@link payload}：它以拥有插件的格式写入，且只有该插件能够解释它。唯一的
 * 约束是它必须能经历一次 JSON 往返。
 */
export interface GrantRecord {
  /** 判别字段。 */
  readonly kind: 'grant'
  /** 由拥有者定义的 JSON 值；对 seam 以及所有其他插件均不透明。 */
  readonly payload: unknown
}

/** 一条持久的凭证记录，按其可被 seam 处置的方式打上标签。 */
export type CredentialRecord = ApiKeyRecord | GrantRecord

/**
 * 单个引用的来源与可写性事实，对配置 UI 安全——绝不含值。该视图没有可供
 * 值寄存的槽位，这正是让整个读取半边能够跨越 Remote 线路的原因。
 */
export interface CredentialInfo {
  /** 当前解析该引用是否会返回一个值。 */
  configured: boolean
  /** 当前提供该值的来源层；未配置时缺省。 */
  source?: string
  /** 当前活跃的提供方能否写入此引用。 */
  writable: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * 对提供方管理的凭证来源的一次已提交变更：一次 `set`、一次 `unset`，
     * 或存储中观测到的外部编辑。环境进程环境的变化不可观测，且从不发出。
     * 监听器失败被包容并记录——无论是同步抛出还是异步拒绝——但不会改变
     * 已提交操作的结果。
     * @param ref - 其存储值发生变更的引用。
     * @mode emit
     */
    'credentials/reference-updated'(ref: CredentialRef): void

    /**
     * 对已存储凭证记录的一次已提交变更：写入的 `modifyRecord`、移除的
     * `deleteRecord`，或存储中观测到的外部编辑。与 `credentials/reference-updated`
     * 分开，是因为两套键文法互不相交——在一个事件上同时收到两者的监听器
     * 无法判断某个主体属于哪个空间。监听器失败的包容方式与
     * `credentials/reference-updated` 相同。
     * @param key - 其存储值发生变更的记录。
     * @mode emit
     */
    'credentials/record-updated'(key: CredentialKey): void
  }
}
