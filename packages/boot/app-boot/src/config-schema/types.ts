/** 免引导配置检查所用的 JSON Schema 输出与原生图输入。 */

/** JSON Schema 2020-12，包含标准校验器可能忽略的注解。 */
export type ConfigJsonSchema = boolean | ConfigJsonSchemaObject

/** 对象形式的 JSON Schema；词汇扩展是注解，而非可执行的校验器。 */
export interface ConfigJsonSchemaObject {
  [keyword: string]: unknown
  $schema?: string
  $ref?: string
  $defs?: Record<string, ConfigJsonSchema>
  type?: string | string[]
  properties?: Record<string, ConfigJsonSchema>
  required?: string[]
  items?: ConfigJsonSchema
  prefixItems?: ConfigJsonSchema[]
  additionalProperties?: ConfigJsonSchema
  propertyNames?: ConfigJsonSchema
  anyOf?: ConfigJsonSchema[]
  allOf?: ConfigJsonSchema[]
  not?: ConfigJsonSchema
  if?: ConfigJsonSchema
  then?: ConfigJsonSchema
  default?: unknown
  description?: string
}

/** 收集或投影诊断，不含独立收集的 config 值。 */
export interface ConfigSchemaDiagnostic {
  level: 'warning' | 'error'
  /** 适用时在发现的条目树中的结构位置。 */
  path?: string
  message: string
}

/** 一条声明的条目及其生成的 Config 引用；include 路径描述发现过程，而非根 JSON 指针。 */
export interface ConfigSchemaEntry {
  path: string
  id?: string
  /** 畸形行没有字面插件名时省略。 */
  name?: string
  status: 'schema' | 'partial' | 'absent' | 'unsupported' | 'error'
  configRef?: string
  /** 原生 Loader 载体，其 config 不会作为普通插件 config 进行插值。 */
  tree?: 'group' | 'include'
}

/** 组合后的条目列表的 JSON Schema；`$defs.patchList` 描述 profile 覆盖层。 */
export interface ConfigSchemaDump extends ConfigJsonSchemaObject {
  $schema: 'https://json-schema.org/draft/2020-12/schema'
  $defs: Record<string, ConfigJsonSchema>
  'x-cordis': {
    profile: string
    /** 存在错误诊断、partial/unsupported/error 条目或插件名 schema 有歧义时为 false；包含已禁用的声明。 */
    complete: boolean
    entries: ConfigSchemaEntry[]
    diagnostics: ConfigSchemaDiagnostic[]
    patchSchema: '#/$defs/patchList'
  }
}

/** 已检查身份标记后的原生 Schemastery 图协议。 */
export interface NativeConfigSchema {
  type: string
  meta: {
    role?: string
    extra?: unknown
    hidden?: boolean
    disabled?: boolean
    collapse?: boolean
    link?: string
    comment?: string
    badges?: { text: string; type: string }[]
    required?: boolean
    volatile?: boolean
    default?: unknown
    min?: number
    max?: number
    step?: number
    pattern?: { source: string; flags?: string }
    description?: string | Record<string, string>
    loose?: boolean
  }
  dict?: Record<string, NativeConfigSchema>
  inner?: NativeConfigSchema
  sKey?: NativeConfigSchema
  list?: NativeConfigSchema[]
  value?: unknown
  builder?: unknown
}

/** 仅在构建 JSON Schema 文档时使用的已收集声明。 */
export interface CollectedConfigEntry extends ConfigSchemaEntry {
  native?: NativeConfigSchema
}
