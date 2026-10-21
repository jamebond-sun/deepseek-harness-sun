/** 从插件 Config schema 派生可编辑表单与纯值。 */
import { redactSecrets } from './redact.ts'
import z from '@deepseek-ai/schemastery'
import { isVolatile } from '@deepseek-ai/cosmokit'

/** 从配置快照中移除运行时引用。
 * @param value 解析后的 Config 输出。
 * @returns 适合脱敏与表单使用的脱钩普通值。
 */
export function plainConfig(value: unknown): unknown {
  if (isVolatile(value)) return plainConfig(value.get())
  if (Array.isArray(value)) return value.map(plainConfig)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plainConfig(child)]))
  }
  return value
}

function plainSchema(schema: z): z {
  const result = new z(schema.toJSON())
  const walk = (node: z): void => {
    delete node.meta.volatile
    if (node.meta.role === 'secret') { delete node.meta.default; delete node.meta.required }
    else if (node.meta.default !== undefined) node.meta.default = redactSecrets(node as z<never>, node.meta.default).value
    for (const child of Object.values(node.dict ?? {})) walk(child)
    if (node.inner) walk(node.inner)
    for (const child of node.list ?? []) walk(child)
  }
  walk(result)
  return result
}

/** 选出其最近的 volatile 祖先使其无需重新挂载即可编辑的字段。
 * @param schema 插件的 Config schema。
 * @returns 纯表单 schema；当没有任何字段是 live 时返回 undefined。
 */
export function volatileForm(schema: z): z | undefined {
  if (schema.meta.volatile) return plainSchema(schema)
  if (schema.type === 'object') {
    const dict = Object.fromEntries(Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
      const field = volatileForm(child)
      return field === undefined ? [] : [[key, field]]
    }))
    return Object.keys(dict).length === 0 ? undefined : z.object(dict)
  }
  return undefined
}

/** 判断原始配置节点是否为未求值的 `!!js` 表达式；此类节点整体保留，而非逐字段投影。 */
function isExpression(value: object): boolean {
  return Object.keys(value).length === 1 && typeof Reflect.get(value, '__jsExpr') === 'string'
}

/** 只投影 schema 声明的字段，排除普通配置。
 * @param schema 已过滤的表单 schema。
 * @param value 纯原始配置或已解析配置。
 * @returns 该表单可见的字段。
 */
export function projectForm(schema: z, value: unknown): unknown {
  if (schema.type === 'object' && value !== null && typeof value === 'object' && !isExpression(value)) {
    return Object.fromEntries(Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
      const field: unknown = Reflect.get(value, key)
      return field === undefined ? [] : [[key, projectForm(child, field)]]
    }))
  }
  return value
}

/** 检查字段路径是否位于已声明的 volatile 节点之下。
 * @param schema 完整的插件 Config schema。
 * @param path 表单编辑所寻址的字段路径。
 * @returns 该路径是否可热编辑。
 */
export function isVolatilePath(schema: z, path: readonly string[]): boolean {
  if (schema.meta.volatile) return true
  const [key, ...rest] = path
  const child = key === undefined ? undefined : schema.dict?.[key]
  return child !== undefined && isVolatilePath(child, rest)
}
