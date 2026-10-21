/**
 * 设置值的结构化密文脱敏。`role('secret')` 字段在跨越线上边界之前即被从值中移除；
 * 附带记录会记下每个 schema 声明的密文位置及其当前是否持有值，使配置界面能够
 * 渲染只写输入框，而始终不接收密文本身。
 * @module @deepseek-ai/dsh-settings/redact
 */

import type z from '@deepseek-ai/schemastery'

/**
 * 活动 schemastery 节点的最小结构化视图。只命名脱敏器会遍历的关系，
 * 实例上的其余内容一概忽略。
 */
interface SchemaNode {
  type?: string
  meta?: { role?: unknown }
  /** `object` 的属性，按属性名索引。 */
  dict?: Record<string, SchemaNode>
  /** `dict`/`array` 的元素 schema。 */
  inner?: SchemaNode
  list?: SchemaNode[]
}

/** 已脱敏值中一个由 schema 声明的密文位置。 */
export interface RedactedSecret {
  /** 从配置节根到被移除字段的路径（包含具体的 dict 键与数组下标）。 */
  path: string[]
  /** 该字段在脱敏之前是否持有值。 */
  set: boolean
}

/** 已移除所有 `role('secret')` 字段的值，附带移除记录。 */
export interface RedactedValue {
  /** 输入的脱钩副本，其中密文字段缺失。 */
  value: unknown
  /**
   * 所有可达的密文位置：对象属性一律记录（即使未设置，以便表单知晓该槽位存在），
   * dict 条目与数组项仅在值实际含有时才记录。
   */
  secrets: RedactedSecret[]
}

/** 判断值是否为遍历器可递归进入的纯数据对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function walk(node: SchemaNode | undefined, value: unknown, path: string[], secrets: RedactedSecret[]): unknown {
  if (node === undefined) return value
  if (node.meta?.role === 'secret') {
    secrets.push({ path, set: value !== undefined })
    return undefined
  }
  switch (node.type) {
    case 'object': {
      const properties = node.dict ?? {}
      const source = isRecord(value) ? value : undefined
      const rebuilt: Record<string, unknown> = {}
      if (source !== undefined) {
        for (const [key, entry] of Object.entries(source)) {
          if (key in properties) continue
          rebuilt[key] = entry
        }
      }
      for (const [key, child] of Object.entries(properties)) {
        const stripped = walk(child, source?.[key], [...path, key], secrets)
        if (stripped !== undefined) rebuilt[key] = stripped
      }
      return source === undefined && Object.keys(rebuilt).length === 0 ? value : rebuilt
    }
    case 'dict': {
      if (!isRecord(value)) return value
      const rebuilt: Record<string, unknown> = {}
      for (const [key, entry] of Object.entries(value)) {
        const stripped = walk(node.inner, entry, [...path, key], secrets)
        if (stripped !== undefined) rebuilt[key] = stripped
      }
      return rebuilt
    }
    case 'array': {
      if (!Array.isArray(value)) return value
      return value.map((entry, index) => walk(node.inner, entry, [...path, String(index)], secrets))
    }
    case 'union':
    case 'intersect':
      return (node.list ?? []).reduce((current, child) => walk(child, current, path, secrets), value)
    case 'transform':
      return walk(node.inner, value, path, secrets)
    default:
      return value
  }
}

/**
 * 从值中移除 schema 声明的每一个 `role('secret')` 字段。遍历器会访问每一个 union
 * 分支，保守地移除任一分支声明为密文的字段。输入永不被修改。
 * @param schema - 描述该值的活动 schemastery schema。
 * @param value - 待剥离的值；`undefined` 会产生一条空记录，
 *   但对象属性上的密文槽位仍会被枚举。
 * @returns 已剥离的脱钩值与有序的密文位置。
 */
export function redactSecrets(schema: z<never>, value: unknown): RedactedValue {
  const secrets: RedactedSecret[] = []
  const stripped = walk(schema, value, [], secrets)
  const positions = new Map<string, RedactedSecret>()
  for (const secret of secrets) {
    const key = JSON.stringify(secret.path)
    const previous = positions.get(key)
    positions.set(key, { ...secret, set: secret.set || previous?.set === true })
  }
  return { value: stripped, secrets: [...positions.values()] }
}
