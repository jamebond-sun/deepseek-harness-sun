/** 客户端安全的配置表单视图与变更通知。 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** 单个 profile 插件条目的名义 id。 */
export type SettingsNamespace = Branded<'SettingsNamespace'>

/** 已脱敏的命名空间值中一个由 schema 声明的密文槽位。 */
export interface SettingsSecretView {
  /** 从配置节根到被移除字段的路径。 */
  path: string[]
  /** 该槽位当前是否持有值；值本身永不随行传输。 */
  set: boolean
}

/**
 * 单个 profile 插件条目的线上视图，始终在 `redactSecrets` 下读取。JSON 值字段采用
 * `JsonValue` 而非描述符的 `unknown`，因为 Remote 边界不接受无约束数据。
 */
export interface SettingsNamespaceView {
  /** 未为该实例注册自定义页面时，是否自动生成页面。 */
  autoGenerate: boolean
  /** 命名空间键（`llm-deepseek`、`llm-pi-ai` 等）。 */
  ns: string
  /** 序列化的 schemastery schema 信封（`schema.toJSON()`）；用 `new Schema(json)` 复原。 */
  schema: JsonValue
  /** 已脱敏的解析值（schema 默认值 → 组合基底层 → 用户层）。 */
  value: JsonValue
  /** 已脱敏的组合基底层，默认值已解析。 */
  base?: JsonValue
  /** 已脱敏的原始用户配置节（若存在）；字段在此出现即表示已被用户覆盖。 */
  user?: JsonValue
  /** 所有者应用变更的时机。 */
  applies: 'live'
  /** 所有由 schema 声明的密文槽位及其配置状态。 */
  secrets: SettingsSecretView[]
  /**
   * 读取该视图时原始条目配置的单调修订号。写入时将其作为 `expectedRevision` 回传，
   * 以便拒绝过期的编辑器，而不是静默覆盖并发变更。
   */
  revision: number
}

/**
 * 一次远程设置写入所携带的路径寻址编辑。`set` 在路径处写入值并创建中间对象；
 * `unset` 将其移除。空路径寻址配置节根。
 */
export type SettingsPathOpView =
  | { op: 'set'; path: string[]; value: JsonValue }
  | { op: 'unset'; path: string[] }

/** 所有 profile 插件条目，以及配置页面围绕其渲染的部署事实。 */
export interface SettingsDescribeValue {
  /** profile 是否接受写入；`false` 会禁用所有写入控件。 */
  writable: boolean
  /** 配置编辑器是否拥有本地文档，但不暴露其 Host 路径。 */
  hasDocument: boolean
  /** 每个 profile 插件条目一个视图。 */
  namespaces: SettingsNamespaceView[]
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * 某个 profile 条目的表单值、可用性或页面策略发生变化。
     * 表单客户端需重新读取其 schema、解析值与修订号。
     * @param ns profile 条目 id。
     * @param revision 该条目的新修订号。
     * @mode emit
     */
    'settings/document-updated'(ns: SettingsNamespace, revision: number): void
  }
}
