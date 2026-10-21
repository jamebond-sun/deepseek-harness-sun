/** 从运行中的 Loader 树投影出实时插件 Config 发现结果。 */

import type { Context } from '@deepseek-ai/cordis'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
// 声明 `Context.pluginPackages`，即用于将条目解析到其包目录的 profile 包查找表。
import { createConfigProjector, isNativeConfigSchema, LOADER_EXPRESSION_SCHEMA, type NativeConfigSchema } from '@deepseek-ai/dsh-app-boot'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/**
 * `schema`：运行中的插件声明了一个原生 Schemastery Config。`absent`：插件运行时不带 Config。
 * `unsupported`：其 Config 不是原生 Schemastery 图。`tree`：一个 Loader 载体（`cordis:group`、
 * `cordis:include`），其 `config` 是子条目列表而非插件 Config。`inactive`：该条目
 * 已被禁用、从未被导入，或其实例纤程已被释放，因此不读取 Config。一个 `apply`
 * 失败的插件会保留其实例纤程，并仍会报告其 Config。
 */
type ConfigStatus = 'schema' | 'absent' | 'unsupported' | 'tree' | 'inactive'

interface LiveConfig {
  /** Loader 条目 id，在嵌套 include 树中唯一（`parent:child`）。 */
  id: string
  /** profile 补丁所寻址的树内局部 id。 */
  patchId: string
  name: string
  status: ConfigStatus
  native?: NativeConfigSchema
}

function liveConfig(entry: Entry): LiveConfig {
  const { id, name } = entry.options
  const listed = { id: entry.id, patchId: id, name }
  if (entry.subgroup !== undefined || entry.subtree !== undefined) return { ...listed, status: 'tree' }
  const fiber = entry.fiber
  if (fiber === undefined || fiber.uid === null || entry.disabled) return { ...listed, status: 'inactive' }
  const config: unknown = fiber.runtime?.Config
  if (config === undefined || config === null) return { ...listed, status: 'absent' }
  if (!isNativeConfigSchema(config)) return { ...listed, status: 'unsupported' }
  return { ...listed, status: 'schema', native: config }
}

function listing({ id, patchId, name, status }: LiveConfig): { [key: string]: JsonValue } {
  return { id, patchId, name, status }
}

/** 模型提供的查询字段，在工具 JSON 边界处校验。 */
interface ConfigQuery {
  entry: string | undefined
  name: string | undefined
  offset: number
  limit: number
}

const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100

function parseQuery(input: JsonValue | undefined): ConfigQuery {
  const fields = input !== undefined && input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const text = (key: string): string | undefined => {
    const value = fields[key]
    if (value === undefined) return undefined
    if (typeof value !== 'string' || value === '') throw new Error(`${key} must be a non-empty string`)
    return value
  }
  const offset = fields.offset ?? 0
  const limit = fields.limit ?? DEFAULT_LIMIT
  if (!Number.isInteger(offset) || typeof offset !== 'number' || offset < 0) throw new Error('offset must be a non-negative integer')
  if (!Number.isInteger(limit) || typeof limit !== 'number' || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`limit must be an integer from 1 to ${MAX_LIMIT}`)
  }
  return { entry: text('entry'), name: text('name'), offset, limit }
}

/** 通过 profile 包查找表，解析某条目插件名背后的包目录。 */
function packageDir(ctx: Context, entry: Entry): { packageDir?: string } {
  const baseUrl = entry.parent.tree.ctx.baseUrl
  const dir = baseUrl === undefined ? undefined : ctx.get('pluginPackages')?.packageOf(entry.options.name, baseUrl)?.dir
  return dir === undefined ? {} : { packageDir: dir }
}

/** 投影输出按构造即为 JSON；CLI 的 schema 转储会序列化相同的值。 */
function toJson(value: object): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

/**
 * 从实时 Loader 树回答 `Config.listConfigs` 巡检查询。
 * 未提供 `entry` 时，返回目录的一页：每个条目的 Loader id、patch id、插件名以及 Config
 * 状态，可选按某个精确插件 `name` 过滤，并附带 `total` 与 `nextOffset`（最后一页为 null）。
 * 提供 `entry` 时，返回该条目及其已解析的 `packageDir`（在 profile 包查找表能解析时，
 * 即持有包 README 与已构建 `lib/` 的目录），并将其原生 Config 投影为一份自包含的
 * JSON Schema 2020-12 文档，其 `$defs` 携带共享定义与 `loaderExpression` 定义，外加省略
 * 接受性与投影限制。
 * 校验器与变换回调不会被执行；运行时创建的 Agent 预设树处于 Loader 之外。
 * @param ctx - Host 上下文；当本 profile 由其挂载时，其 `loader` 拥有该条目树。
 * @param input - 模型提供的查询：`entry`（Loader 条目 id），或 `name`、`offset`（默认 0）与 `limit`（1 到 100，默认 25）。
 * @returns 一页目录，或某个条目的状态与投影后的 schema。
 * @throws 当本 Host 未挂载任何 Loader、查询字段格式错误，或条目 id 不匹配任何实时条目时。
 */
export async function queryLiveConfig(ctx: Context, input: JsonValue | undefined): Promise<JsonValue> {
  const loader = ctx.get('loader')
  if (loader === undefined) throw new Error('Config inspection requires the Loader that mounted this profile; this Host was composed without one')
  const query = parseQuery(input)
  const entries = [...loader.entries()].map(liveConfig)
  if (query.entry === undefined) {
    const matching = query.name === undefined ? entries : entries.filter(candidate => candidate.name === query.name)
    const page = matching.slice(query.offset, query.offset + query.limit).map(listing)
    const end = query.offset + page.length
    return { entries: page, total: matching.length, nextOffset: end < matching.length ? end : null }
  }
  const entry = entries.find(candidate => candidate.id === query.entry)
  if (entry === undefined) throw new Error(`unknown entry id ${JSON.stringify(query.entry)}`)
  const listed = { ...listing(entry), ...packageDir(ctx, loader.resolve(query.entry)) }
  if (entry.native === undefined) return listed
  const project = await createConfigProjector()
  const { schema, definitions, acceptsMissing, limitations } = project(entry.native, 'config')
  return toJson({ ...listed, acceptsMissing, limitations, schema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $defs: { ...definitions, loaderExpression: LOADER_EXPRESSION_SCHEMA },
    ...schema,
  } })
}
