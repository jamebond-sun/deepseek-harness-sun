/**
 * 沙箱化宿主半区与真实运行时之间的注册边界：ParameterSchemaSpec
 * 的归一化与带教学性错误的校验、由标记守卫的 `harness.defineTool` /
 * `harness.registerTool` 对、由 `harness.handle` 调用处理器规范化器、一个运行中插件的 `apply`
 * 所收到的 SANDBOX CONTEXT 门面（替代真实的 `ctx`），以及运行生命周期用以收窄
 * 沙箱返回值形状的插件形态辅助函数。该门面是一道白名单，列出
 * 生命周期安全的动词与已声明服务；框架内部与以上下文形式返回的服务
 * 都被拒绝。
 *
 * VM 领域的模式与规范值被重建为主机对象，而渲染内容与
 * 表现元数据在进入注册表之前要经过形态校验。常见的 JSON-Schema 写法在语义唯一时被
 * 归一化；无效的词汇会在注册期间以教学性错误失败。
 * @module @deepseek-ai/dsh-cordis-host-runner/guard
 */

import { Context } from '@deepseek-ai/cordis'
import type { Plugin } from '@deepseek-ai/cordis'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { assertSupportedJsonSchema, defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

const DYNAMIC_TOOL = Symbol('cordis-host-runner.dynamic-tool')
const SCHEMA_TYPES = new Set<unknown>(['string', 'number', 'integer', 'boolean', 'null', 'object', 'array', 'json'])
const VALID_TYPES = '\'string\' | \'number\' | \'integer\' | \'boolean\' | \'null\' | \'object\' | \'array\' | \'json\''
const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples'] as const

type DynamicToolDefinition = ToolDefinition & { [DYNAMIC_TOOL]: true }
type DynamicToolMarker = { [DYNAMIC_TOOL]?: unknown }

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === null
    || typeof prototype === 'object'
      && Object.getPrototypeOf(prototype) === null
      && hasIntrinsicConstructor(prototype, 'Object')
}

/* jscpd:ignore-start -- 此 VM 边界镜像了会话拥有的、领域安全的固有测试 */
/** 一个领域拥有的固有原型是否由其原生构造器支撑。 */
function hasIntrinsicConstructor(prototype: object, name: 'Array' | 'Object'): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'constructor')
  const constructor: unknown = descriptor?.value
  if (typeof constructor !== 'function') return false
  try {
    return constructor.name === name
      && constructor.prototype === prototype
      && Function.prototype.toString.call(constructor) === `function ${name}() { [native code] }`
  } catch {
    return false
  }
}

/** 一个数组是否使用某一领域的固有 Array 原型，而非某个子类。 */
function hasPlainArrayPrototype(value: unknown[]): boolean {
  const prototype: unknown = Object.getPrototypeOf(value)
  if (!Array.isArray(prototype) || !hasIntrinsicConstructor(prototype, 'Array')) return false
  const objectPrototype: unknown = Object.getPrototypeOf(prototype)
  return typeof objectPrototype === 'object'
    && objectPrototype !== null
    && Object.getPrototypeOf(objectPrototype) === null
    && hasIntrinsicConstructor(objectPrototype, 'Object')
}
/* jscpd:ignore-end */

/** 一个模式列表是否为没有 JSON 不可见修饰的、稠密的固有数组。 */
function isDensePlainArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || !hasPlainArrayPrototype(value) || Reflect.ownKeys(value).length !== value.length + 1) {
    return false
  }
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) return false
  }
  return true
}

/** 拒绝那些声明会从对象枚举中消失的模式记录。 */
function assertSchemaContainerKeys(value: Record<string, unknown>, path: string): void {
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !Object.prototype.propertyIsEnumerable.call(value, key))) {
    throw new Error(`harness.defineTool ${path} must contain only own enumerable string keys`)
  }
}

/** 一个克隆 JSON 值的安装位置。 */
type CloneDestination =
  | { kind: 'root' }
  | { kind: 'array'; target: unknown[]; index: number }
  | { kind: 'object'; target: Record<string, unknown>; key: string }

/** 用于栈安全跨领域 JSON 克隆的延迟工作。 */
type CloneTask =
  | { kind: 'visit'; value: unknown; path: string; destination: CloneDestination }
  | { kind: 'array-item'; source: unknown[]; index: number; path: string; target: unknown[] }
  | { kind: 'leave'; source: object }

/** 在不允许 JSON.stringify 强制转换的前提下，物化领域外无损 JSON；`path` 携带调用方自身的错误前缀。 */
function cloneJson(value: unknown, path: string): unknown {
  const ancestors = new Set<object>()
  let root: unknown
  const assign = (destination: CloneDestination, item: unknown): void => {
    if (destination.kind === 'root') {
      root = item
      return
    }
    if (destination.kind === 'array') {
      destination.target[destination.index] = item
      return
    }
    Object.defineProperty(destination.target, destination.key, {
      value: item,
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  const reject = (at: string): never => {
    // 为可执行的下一步命名，比为规则命名更重要：常见的
    // 原因是某个处理器返回了它上一次调用所产生的任何东西，
    // 而修复办法只是一个关键字。
    throw new Error(`${at} must be lossless JSON data (objects, arrays, strings, numbers, booleans, null) — `
      + 'not a class instance, function, Map/Set, Date, or undefined. Return a plain object built from the '
      + 'values you need, or `return null` when the caller needs no value back.')
  }

  const tasks: CloneTask[] = [{ kind: 'visit', value, path, destination: { kind: 'root' } }]
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    if (task.kind === 'leave') {
      ancestors.delete(task.source)
      continue
    }
    if (task.kind === 'array-item') {
      if (!Object.hasOwn(task.source, task.index)) reject(task.path)
      tasks.push({
        kind: 'visit',
        value: task.source[task.index],
        path: `${task.path}[${task.index}]`,
        destination: { kind: 'array', target: task.target, index: task.index },
      })
      continue
    }

    const current = task.value
    if (current === null || typeof current === 'string' || typeof current === 'boolean') {
      assign(task.destination, current)
      continue
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current) || Object.is(current, -0)) reject(task.path)
      assign(task.destination, current)
      continue
    }
    if (typeof current !== 'object' || ancestors.has(current)) reject(task.path)

    if (Array.isArray(current)) {
      if (!hasPlainArrayPrototype(current) || Reflect.ownKeys(current).length !== current.length + 1) reject(task.path)
      const output: unknown[] = []
      assign(task.destination, output)
      ancestors.add(current)
      tasks.push({ kind: 'leave', source: current })
      for (let index = current.length - 1; index >= 0; index--) {
        tasks.push({ kind: 'array-item', source: current, index, path: task.path, target: output })
      }
      continue
    }
    if (!isPlainRecord(current)) reject(task.path)
    const record = current as Record<string, unknown>
    if (Reflect.ownKeys(record).some(key => typeof key !== 'string' || !Object.prototype.propertyIsEnumerable.call(record, key))) {
      reject(task.path)
    }
    const output: Record<string, unknown> = {}
    assign(task.destination, output)
    ancestors.add(record)
    tasks.push({ kind: 'leave', source: record })
    const entries = Object.entries(record)
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index]
      /* v8 ignore next -- 该循环受捕获到的条目数所限定。 */
      if (entry === undefined) continue
      tasks.push({
        kind: 'visit',
        value: entry[1],
        path: `${task.path}.${entry[0]}`,
        destination: { kind: 'object', target: output, key: entry[0] },
      })
    }
  }
  return root
}

/** 复制并为主机领域物化共享的注解词汇。 */
function copyAnnotations(value: Record<string, unknown>, output: Record<string, unknown>, path: string): void {
  if (Object.hasOwn(value, 'description')) output.description = value.description
  if (Object.hasOwn(value, 'title')) output.title = value.title
  if (Object.hasOwn(value, 'default')) output.default = cloneJson(value.default, `harness.defineTool ${path}.default`)
  if (Object.hasOwn(value, 'examples')) output.examples = cloneJson(value.examples, `harness.defineTool ${path}.examples`)
}

/** 拒绝那些统一 DSL 本会忽略的沙箱模式键。 */
function assertSchemaKeys(value: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  assertSchemaContainerKeys(value, path)
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`harness.defineTool ${path}.${key} is not supported by the unified schema DSL`)
  }
}

/**
 * 将沙箱提供的 `parameters` 值归一化为全新的主机领域
 * ParameterSchemaSpec。原始 JSON-Schema 对象包装保留其开放根
 * 默认值，而直接 DSL 已经是一个隐式的开放属性映射。
 */
function normalizeParameterSchemaSpec(value: unknown, path = 'parameters'): {
  spec: Record<string, unknown>
  rootAnnotations?: Record<string, unknown>
} {
  if (!isPlainRecord(value)) {
    throw new Error(`harness.defineTool ${path} must be a ParameterSchemaSpec object`)
  }
  if (value.type === 'object') {
    assertSchemaKeys(value, path, ['type', 'properties', 'required', 'additionalProperties', ...ANNOTATION_KEYS])
    if (!isPlainRecord(value.properties)) {
      throw new Error(`harness.defineTool ${path}.properties must be an object of schemas`)
    }
    if (Object.hasOwn(value, 'additionalProperties') && value.additionalProperties !== true) {
      throw new Error(`harness.defineTool ${path}.additionalProperties must be true or omitted because the implicit parameter root is open`)
    }
    if (Object.hasOwn(value, 'required') && value.required === undefined) {
      throw new Error(`harness.defineTool ${path}.required must be an array of declared property names`)
    }
    const required = normalizeRequiredNames(value.required, value.properties, `${path}.required`)
    const rootAnnotations: Record<string, unknown> = {}
    copyAnnotations(value, rootAnnotations, path)
    return {
      spec: normalizePropertyMap(value.properties, path, required, true),
      ...(Object.keys(rootAnnotations).length === 0 ? {} : { rootAnnotations }),
    }
  }
  return { spec: normalizePropertyMap(value, path, new Set(), false) }
}

/** 校验原始的 required 名称，并返回其查找集合。 */
function normalizeRequiredNames(value: unknown, properties: Record<string, unknown>, path: string): Set<string> {
  if (value === undefined) return new Set()
  if (!isDensePlainArray(value)) {
    throw new Error(`harness.defineTool ${path} must be an array of declared property names`)
  }
  const names = new Set<string>()
  for (let index = 0; index < value.length; index++) {
    const name = value[index]
    if (typeof name !== 'string') {
      throw new Error(`harness.defineTool ${path} must be an array of declared property names`)
    }
    names.add(name)
    if (!Object.hasOwn(properties, name)) throw new Error(`harness.defineTool ${path} names undeclared property ${JSON.stringify(name)}`)
  }
  return names
}

/** 仅在一个归一化属性映射根尚未解析时使用的可变持有者。 */
interface NormalizeRoot {
  value?: Record<string, unknown>
}

/** 一个归一化值节点的安装位置。 */
type NormalizeValueDestination =
  | { kind: 'property'; target: Record<string, unknown>; key: string }
  | { kind: 'item'; target: Record<string, unknown> }
  | { kind: 'one-of'; target: Record<string, unknown>[]; index: number }

/** 一个归一化属性映射的安装位置。 */
type NormalizeMapDestination =
  | { kind: 'root'; holder: NormalizeRoot }
  | { kind: 'properties'; target: Record<string, unknown> }

/** 用于栈安全的沙箱模式归一化的延迟工作。 */
type NormalizeTask =
  | {
    kind: 'map'
    entries: Record<string, unknown>
    path: string
    requiredNames: ReadonlySet<string>
    raw: boolean
    destination: NormalizeMapDestination
  }
  | {
    kind: 'value'
    value: unknown
    path: string
    forceRequired: boolean
    raw: boolean
    parameterProperty: boolean
    destination: NormalizeValueDestination
  }
  | { kind: 'leave'; value: object }

/** 在不具 `__proto__` 赋值语义的前提下，安装一个归一化节点。 */
function assignNormalizedValue(destination: NormalizeValueDestination, value: Record<string, unknown>): void {
  if (destination.kind === 'property') {
    Object.defineProperty(destination.target, destination.key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    })
  } else if (destination.kind === 'item') {
    destination.target.items = value
  } else {
    destination.target[destination.index] = value
  }
}

/** 在一个归一化属性映射的根或其所属对象处安装它。 */
function assignNormalizedMap(destination: NormalizeMapDestination, value: Record<string, unknown>): void {
  if (destination.kind === 'root') destination.holder.value = value
  else destination.target.properties = value
}

/** 以显式工作帧归一化一个隐式属性映射及其全部后代。 */
function normalizePropertyMap(
  entries: Record<string, unknown>,
  path: string,
  requiredNames: ReadonlySet<string>,
  raw: boolean,
): Record<string, unknown> {
  const holder: NormalizeRoot = {}
  const ancestors = new Set<object>()
  const tasks: NormalizeTask[] = [{
    kind: 'map',
    entries,
    path,
    requiredNames,
    raw,
    destination: { kind: 'root', holder },
  }]
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    if (task.kind === 'leave') {
      ancestors.delete(task.value)
      continue
    }
    if (task.kind === 'map') {
      if (ancestors.has(task.entries)) throw new Error(`harness.defineTool ${task.path} is circular`)
      assertSchemaContainerKeys(task.entries, task.path)
      ancestors.add(task.entries)
      const spec: Record<string, unknown> = {}
      assignNormalizedMap(task.destination, spec)
      tasks.push({ kind: 'leave', value: task.entries })
      const mapEntries = Object.entries(task.entries)
      for (let index = mapEntries.length - 1; index >= 0; index--) {
        const entry = mapEntries[index]
        /* v8 ignore next -- 该循环受捕获到的条目数所限定。 */
        if (entry === undefined) continue
        tasks.push({
          kind: 'value',
          value: entry[1],
          path: `${task.path}.${entry[0]}`,
          forceRequired: task.requiredNames.has(entry[0]),
          raw: task.raw,
          parameterProperty: true,
          destination: { kind: 'property', target: spec, key: entry[0] },
        })
      }
      continue
    }

    const { value, path } = task
    if (!isPlainRecord(value)) {
      throw new Error(`harness.defineTool ${path} must be a ParameterSchemaSpec property object`)
    }
    assertSchemaContainerKeys(value, path)
    if (ancestors.has(value)) throw new Error(`harness.defineTool ${path} is circular`)
    ancestors.add(value)
    const requiredKey = task.parameterProperty && !task.raw ? ['required'] : []
    if (task.parameterProperty && task.raw && Object.hasOwn(value, 'required') && value.type !== 'object') {
      throw new Error(`harness.defineTool ${path}.required belongs to the containing raw object schema`)
    }
    if (task.parameterProperty && !task.raw && Object.hasOwn(value, 'required') && value.required !== true) {
      throw new Error(`harness.defineTool ${path}.required must be true when present`)
    }
    const prop: Record<string, unknown> = {}
    assignNormalizedValue(task.destination, prop)
    tasks.push({ kind: 'leave', value })
    if (task.forceRequired || value.required === true) prop.required = true
    copyAnnotations(value, prop, path)

    if (Object.hasOwn(value, 'oneOf')) {
      assertSchemaKeys(value, path, ['oneOf', ...requiredKey, ...ANNOTATION_KEYS])
      if (!isDensePlainArray(value.oneOf) || value.oneOf.length < 2) {
        throw new Error(`harness.defineTool ${path}.oneOf must contain at least two schemas`)
      }
      const oneOf: Record<string, unknown>[] = []
      prop.oneOf = oneOf
      for (let index = value.oneOf.length - 1; index >= 0; index--) {
        tasks.push({
          kind: 'value',
          value: value.oneOf[index],
          path: `${path}.oneOf[${index}]`,
          forceRequired: false,
          raw: task.raw,
          parameterProperty: false,
          destination: { kind: 'one-of', target: oneOf, index },
        })
      }
      continue
    }

    if (task.raw && !Object.hasOwn(value, 'type')) {
      assertSchemaKeys(value, path, ANNOTATION_KEYS)
      prop.type = 'json'
      continue
    }
    if (!SCHEMA_TYPES.has(value.type) || task.raw && value.type === 'json') {
      throw new Error(`harness.defineTool ${path} must declare a valid type: ${VALID_TYPES} (got ${JSON.stringify(value.type)})`)
    }
    const type = value.type
    prop.type = type

    switch (type) {
      case 'object': {
        assertSchemaKeys(value, path, ['type', 'properties', 'additionalProperties', ...requiredKey, ...(task.raw ? ['required'] : []), ...ANNOTATION_KEYS])
        if (!task.raw && (!Object.hasOwn(value, 'additionalProperties') || typeof value.additionalProperties !== 'boolean')) {
          throw new Error(`harness.defineTool ${path}.additionalProperties must be explicitly true or false`)
        }
        if (task.raw && Object.hasOwn(value, 'additionalProperties') && typeof value.additionalProperties !== 'boolean') {
          throw new Error(`harness.defineTool ${path}.additionalProperties must be a boolean`)
        }
        if (task.raw && Object.hasOwn(value, 'required') && value.required === undefined) {
          throw new Error(`harness.defineTool ${path}.required must be an array of declared property names`)
        }
        prop.additionalProperties = task.raw ? value.additionalProperties ?? true : value.additionalProperties
        if (Object.hasOwn(value, 'properties')) {
          const properties = value.properties
          if (!isPlainRecord(properties)) throw new Error(`harness.defineTool ${path}.properties must be an object of schemas`)
          const nestedRequired = task.raw
            ? normalizeRequiredNames(value.required, properties, `${path}.required`)
            : new Set<string>()
          tasks.push({
            kind: 'map',
            entries: properties,
            path: `${path}.properties`,
            requiredNames: nestedRequired,
            raw: task.raw,
            destination: { kind: 'properties', target: prop },
          })
        } else if (task.raw && value.required !== undefined) {
          normalizeRequiredNames(value.required, {}, `${path}.required`)
        }
        break
      }
      case 'array':
        assertSchemaKeys(value, path, ['type', 'items', ...requiredKey, ...ANNOTATION_KEYS])
        if (Object.hasOwn(value, 'items')) {
          tasks.push({
            kind: 'value',
            value: value.items,
            path: `${path}.items`,
            forceRequired: false,
            raw: task.raw,
            parameterProperty: false,
            destination: { kind: 'item', target: prop },
          })
        }
        break
      case 'string':
      case 'number':
      case 'integer':
      case 'boolean':
      case 'null':
        assertSchemaKeys(value, path, ['type', 'enum', 'const', ...requiredKey, ...ANNOTATION_KEYS])
        if (Object.hasOwn(value, 'enum')) {
          if (!isDensePlainArray(value.enum) || value.enum.length === 0) {
            throw new Error(`harness.defineTool ${path}.enum must be a non-empty array`)
          }
          prop.enum = cloneJson(value.enum, `harness.defineTool ${path}.enum`)
        }
        if (Object.hasOwn(value, 'const')) prop.const = cloneJson(value.const, `harness.defineTool ${path}.const`)
        break
      case 'json':
        assertSchemaKeys(value, path, ['type', ...requiredKey, ...ANNOTATION_KEYS])
        break
      /* v8 ignore next 2 -- SCHEMA_TYPES 在分发之前收窄了这个封闭 switch。 */
      default:
        throw new Error(`harness.defineTool ${path} must declare a valid type: ${VALID_TYPES}`)
    }
  }
  /* v8 ignore next -- 根映射任务在调度后代之前完成赋值。 */
  return holder.value ?? {}
}

function markDynamicTool(tool: ToolDefinition): DynamicToolDefinition {
  Object.defineProperty(tool, DYNAMIC_TOOL, { value: true })
  return tool as DynamicToolDefinition
}

function assertDynamicTool(tool: unknown): asserts tool is DynamicToolDefinition {
  if (!isPlainRecord(tool) || (tool as DynamicToolMarker)[DYNAMIC_TOOL] !== true) {
    throw new Error('dynamic tool registration must use a tool returned by harness.defineTool(...)')
  }
}

/**
 * 在结构上是一个内容块，在 JSON 往返之后才校验：一个携带字符串 `type`
 * 标签的纯对象。刻意不深入更多——ContentBlock 联合是可合并扩展的
 * （未知的标签必须放行），而每个下游消费者都按 `type` 分发并对未知值直通。
 */
function isContentBlockShape(value: unknown): boolean {
  return isPlainRecord(value) && typeof value.type === 'string'
}

/**
 * 教学性错误会回显多少无效 execute 返回值——一个
 * 巨大的 blob 会烧掉该错误本想挽救的那一轮模型回合。
 */
const RETURN_PREVIEW_LIMIT = 120

/**
 * 为教学性错误准备的、无效 execute 返回值的紧凑 JSON 预览
 * （对无法字符串化的 undefined 情形使用 `String(…)`），截断到
 * {@link RETURN_PREVIEW_LIMIT}。
 */
function describeReturn(value: JsonValue): string {
  // 调用方已经穿过了 cloneJson，因此该值是无损 JSON，
  // 序列化不可能产生 undefined。
  const json = JSON.stringify(value)
  return json.length > RETURN_PREVIEW_LIMIT ? `${json.slice(0, RETURN_PREVIEW_LIMIT)}…` : json
}

/**
 * 校验并为主机领域物化一个沙箱渲染器的内容块。
 */
function assertRenderedContent(value: JsonValue): ContentBlock[] {
  if (Array.isArray(value) && value.every(isContentBlockShape)) {
    return value as unknown as ContentBlock[]
  }
  throw new Error(
    `output.render returned ${describeReturn(value)} — it must return an ARRAY of content blocks:\n`
    + '  ✓ return [{ type: \'text\', text: String(value) }]',
  )
}

/**
 * 交入沙箱的 `harness.defineTool`：真实的 DSL，其中 `parameters` 被归一化为
 * 全新的主机领域 ParameterSchemaSpec（原始对象包装被拆开、required 数组被映射、
 * 显式 DSL 对象开放性被强制），而工具的 `execute` 返回值经由一次 JSON 往返
 * 归一化回主机领域。非 JSON 或形状错误的输出会让该调用失败，而不是
 * 污染会话日志。
 * @param options - 标准的 `defineTool` 选项；`parameters` 可以是 ParameterSchemaSpec DSL 或 JSON-Schema 风格包装。
 * @returns 带有标记的、被 `harness.registerTool`（以及受守卫的 `ctx.tools.register`）所接受的那个定义。
 */
export function sandboxDefineTool(options: unknown): ToolDefinition {
  if (!isPlainRecord(options)) throw new Error('harness.defineTool options must be an object')
  const normalized = normalizeParameterSchemaSpec(options.parameters)
  if (!isPlainRecord(options.output)) {
    throw new Error('harness.defineTool output must declare { schema, render, presentationMeta? }')
  }
  const output = options.output
  if (typeof output.render !== 'function') throw new Error('harness.defineTool output.render must be a function')
  if (output.presentationMeta !== undefined && typeof output.presentationMeta !== 'function') {
    throw new Error('harness.defineTool output.presentationMeta must be a function when present')
  }
  if (typeof options.execute !== 'function') throw new Error('harness.defineTool execute must be a function')
  const schema = cloneJson(output.schema, 'harness.defineTool output.schema')
  const rawExecute = options.execute as (args: unknown, exec: unknown) => Promise<unknown>
  const rawRender = output.render as (args: unknown, value: unknown) => unknown
  const rawPresentationMeta = output.presentationMeta as ((args: unknown, value: unknown) => unknown) | undefined
  const erasedDefineTool = defineTool as (definition: unknown) => ToolDefinition
  const tool = erasedDefineTool({
    ...options,
    parameters: normalized.spec,
    output: {
      schema,
      render(args: unknown, value: unknown): ContentBlock[] {
        return assertRenderedContent(cloneJson(rawRender(args, value), 'harness.defineTool output.render result') as JsonValue)
      },
      ...rawPresentationMeta !== undefined ? {
        presentationMeta(args: unknown, value: unknown): JsonValue {
          return cloneJson(rawPresentationMeta(args, value), 'harness.defineTool output.presentationMeta result') as JsonValue
        },
      } : {},
    },
    async execute(args: unknown, exec: unknown): Promise<JsonValue> {
      return cloneJson(await rawExecute(args, exec), 'harness.defineTool execute result') as JsonValue
    },
  })
  const parameters = { ...tool.parameters, ...normalized.rootAnnotations }
  assertSupportedJsonSchema(parameters)
  return markDynamicTool({
    ...tool,
    parameters,
  })
}

/**
 * 在沙箱边界处归一化一次 `harness.handle` 注册：方法名必须是一个非空
 * 字符串，处理器必须是一个函数，其返回值经由与工具 `execute` 返回
 * 相同的跨领域 JSON 克隆被主机领域物化（否则一个 VM 领域对象会逃出
 * 连线的纯对象契约）。
 * @param method - 包的浏览器半区通过 `host.call` 调用的处理器名称。
 * @param fn - 接收连线解码后 JSON 参数的沙箱处理器。
 * @returns 已校验的名称与经克隆包裹的处理器。
 */
export function normalizeHandler(method: unknown, fn: unknown): { method: string; handler: (args: unknown) => Promise<unknown> } {
  if (typeof method !== 'string' || method.length === 0) {
    throw new Error('harness.handle(method, fn) needs a non-empty string method name')
  }
  if (typeof fn !== 'function') {
    throw new Error(`harness.handle("${method}") needs a handler function as its second argument`)
  }
  const rawHandler = fn as (args: unknown) => unknown
  return {
    method,
    handler: async (args: unknown): Promise<unknown> =>
      cloneJson(await rawHandler(args), `harness.handle("${method}") result`),
  }
}

/**
 * 交入沙箱的 `harness.registerTool`：在给定的上下文注册表上注册一个
 * 经过标记校验的动态工具。
 * @param ctx - 其 `tools` 服务接收该工具的（受守卫的）上下文。
 * @param tool - 由 {@link sandboxDefineTool} 产生的定义；其它任何东西都会被拒绝。
 * @returns 该注册的注册表释放器。
 */
export function sandboxRegisterTool(ctx: Context, tool: unknown): () => void {
  assertDynamicTool(tool)
  return ctx.tools.register(tool)
}

/**
 * 一个运行中的宿主半区可经由沙箱 `ctx` 门面触及的动词，超出其已注入的
 * 服务范围。`on`/`once` 观察事件，`provide` 向其它包暴露一个服务，
 * 而定时器辅助函数安排工作——每一项都是当包停止时才会展开的纤程效应。
 */
const CTX_VERBS = new Set(['effect', 'on', 'once', 'provide', 'timeout', 'interval', 'setTimeout', 'setInterval', 'throttle', 'debounce'])
const TIMER_VERBS = new Set(['timeout', 'interval', 'setTimeout', 'setInterval', 'throttle', 'debounce'])

/**
 * 工具注册表门面：`register`（经标记守卫）外加只读
 * 元数据（`schemas`，以及返回模式视图而非活跃
 * `ToolDefinition` 的 `get`）。暴露原始定义会把工具的 `execute`
 * 函数交给包代码，使其能直接调用另一个工具并绕过
 * `ToolRuntime.execute`——身份保护、前置策略、单调守卫、
 * 分发环绕、后置策略、最终观察与结果归一化。因此 `get` 返回
 * 与 `schemas()` 相同的 name/description/parameters 视图，且没有任何可调用之物。
 */
function sandboxTools(ctx: Context): Record<string, unknown> {
  // 透过包自身的 scope 解析读与写。
  return {
    register: (tool: unknown): (() => void) => sandboxRegisterTool(ctx, tool),
    schemas: () => ctx.tools.schemas(scopeOf(ctx)),
    get: (name: string) => ctx.tools.schemas(scopeOf(ctx)).find(schema => schema.name === name),
  }
}

/**
 * 拒绝任何返回了 cordis `Context` 的注入服务。Harness
 * 服务返回数据，从不返回上下文；一个本身就是上下文的值会是一把
 * 全新、未受守卫的、指回运行时的把手——正是门面
 * 旨在堵住的那类逃逸——因此它响亮地失败，而不是抵达沙箱代码。
 */
// 与浏览器半区的守卫成对，原因与下方的 ctx 门面相同：这条规则是
// “服务绝不能把 Context 交给沙箱代码”，而每个半区都必须针对
// 其自身那一面的 Context 类做测试。把这条规则搬进一个共享包，会把一个
// 安全不变量移出执行它的两个半区，那是一个设计决策，而非重复修复。
/* jscpd:ignore-start */
function denyContext(value: unknown, service: string, reportFailure: (error: Error) => void): unknown {
  if (value instanceof Context) {
    return rejectGuard(reportFailure,
      `service "${service}" returned a cordis Context, which the sandbox does not expose. `
      + 'Operate through your own plugin ctx (ctx.on / ctx.provide / ctx.tools.register) '
      + 'and the services you inject — never another context.',
    )
  }
  return value
}

/**
 * 包裹一个注入的服务，使其方法转发到真实实例，但
 * 它们的返回值会穿过 {@link denyContext}。非函数成员
 * （纯数据）原样穿过；返回的 Promise 在 resolve 时受守卫。
 */
function guardedService(service: object, name: string, reportFailure: (error: Error) => void): unknown {
  return new Proxy(service, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target)
      if (typeof value !== 'function') return denyContext(value, name, reportFailure)
      return (...args: unknown[]): unknown => {
        const result: unknown = Reflect.apply(value, target, args)
        if (result instanceof Promise) return result.then(v => denyContext(v, name, reportFailure))
        return denyContext(result, name, reportFailure)
      }
    },
  })
}
/* jscpd:ignore-end */

/**
 * 一个插件在 `inject` 中声明的服务名，作为查找集合。无论
 * 插件使用哪种声明风格——`inject: ['bash', 'tools']` 数组或
 * `{ required, optional }` 对象形式——cordis 都会在 `apply` 运行之前把它
 * 解析为一个以名称为键的映射挂在纤程上（`{ bash: null, tools: null }`），
 * 因此这道闸门只需读取该映射的键。一个宿主半区只能触及它
 * 所声明的服务——正是这一点让 cordis 能在某个已声明提供者
 * 消失时把它停驻。
 */
function declaredInjects(ctx: Context): Set<string> {
  return new Set(Object.keys(ctx.fiber.inject))
}

/**
 * 用于运行宿主半区的白名单上下文：生命周期安全的动词、受守卫的
 * 工具、可选的 `ctx.get()` 查找，以及已声明服务的属性访问。
 * 框架内部管线被拒绝，且服务方法不能返回 Context。
 */
function sandboxContext(ctx: Context, reportFailure: (error: Error) => void): Context {
  const tools = sandboxTools(ctx)
  const declared = declaredInjects(ctx)
  // 框架成员，还是未声明的服务——区分两者，从而
  // 错误信息能教给正确的修复方式（在 inject 中声明，vs 它被扣留）。
  const denyRead = (prop: string): never => {
    if (ctx.get(prop) !== undefined) {
      return rejectGuard(reportFailure,
        `service "${prop}" is not injected. Declare it: inject: ['${prop}', …] on your plugin, `
        + 'so cordis parks this dynamic package if the provider later goes away.',
      )
    }
    return rejectGuard(reportFailure,
      `sandbox ctx does not expose "${prop}". Available: ctx.tools.register / ctx.on / ctx.provide / `
      + 'the timer helpers after injecting timer, and any service you declared in inject. '
      + 'Framework internals (root, fiber, registry, extend, plugin, …) are withheld by design.',
    )
  }
  // `get` 是可选的查找；属性访问需要一份声明。`tools`
  // 是两面路径上都属于门面自身的 API。
  const readService = (name: string, requireDeclaration: boolean): unknown => {
    if (name === 'tools') return tools
    if (requireDeclaration && !declared.has(name)) return denyRead(name)
    const service = denyContext(ctx.get(name), name, reportFailure)
    if (service === null || (typeof service !== 'object' && typeof service !== 'function')) return service
    return guardedService(service, name, reportFailure)
  }
  const get = (name: string): unknown => readService(name, false)
  // 浏览器半区在其自身的 Context 之上构建同一道门面
  // （`@deepseek-ai/dsh-cordis-client-runner`，其 CTX_VERBS 把这一份命名为它的
  // 孪生），而“同一性”正是关键：包作者在两半区上面对的是同一份契约。把它们
  // 合并起来并不现实——两个半区在各自独立的程序中编译，其中 `Context` 合并的是
  // 不同的服务键——因此这里的重复是被显式声明的，而非藏在某个配置例外之后。
  /* jscpd:ignore-start */
  return new Proxy({}, {
    get(_target, prop) {
      if (prop === 'tools') return tools
      if (prop === 'get') return get
      if (typeof prop !== 'string') return undefined
      // 惰性动词转发器——仅在被调用时才读取 `ctx[verb]`。定时器混入
      // 还需要在 Cordis 解析它们之前先有 Service 声明。
      if (CTX_VERBS.has(prop)) {
        return (...args: unknown[]): unknown => {
          if (TIMER_VERBS.has(prop) && !declared.has('timer')) return denyRead('timer')
          const method = ctx[prop as keyof Context]
          return Reflect.apply(method as (...a: unknown[]) => unknown, ctx, args)
        }
      }
      return readService(prop, true)
    },
    // 门面不是真实的 ctx；应当阻断写入，而不是让包代码
    // 把状态暂存到一个一次性对象上、还以为它已持久化。
    set(_target, prop) {
      return rejectGuard(reportFailure, `sandbox ctx is read-only; cannot assign "${String(prop)}"`)
    },
    // `in` 反映可达性：门面 API，加上已声明的服务
    // （无论当前是否存活）。它不做解析/包裹——不会抛错。
    has: (_target, prop) => prop === 'tools' || prop === 'get'
      || (typeof prop === 'string'
        && ((CTX_VERBS.has(prop) && (!TIMER_VERBS.has(prop) || declared.has('timer'))) || declared.has(prop))),
  }) as Context
  /* jscpd:ignore-end */
}

/**
 * 把一个任意的沙箱返回值收窄为一个可运行的 cordis 插件：一个
 * 函数，或一个带有 `apply` 函数的对象。（裸函数会命中第一个分支，
 * 因此对象分支永远不会见到 `Function.prototype.apply`。）
 * @param value - 宿主半区返回的任何东西。
 * @returns 该值能否经由 `ctx.plugin` 启动。
 */
export function isPlugin(value: unknown): value is Plugin {
  if (typeof value === 'function') return true
  return typeof value === 'object' && value !== null
    && typeof (value as { apply?: unknown }).apply === 'function'
}

/**
 * 包裹一个插件，使其 `apply` 收到沙箱上下文，同时保留注入元数据。
 * @param plugin - 宿主半区返回的插件。
 * @param reportFailure - 向所属 Agent 报告一次守卫拒绝。
 * @returns 一个等效的插件，其 `apply` 见到的是沙箱上下文门面。
 */
export function guardedPlugin(plugin: Plugin, reportFailure: (error: Error) => void): Plugin {
  if (typeof plugin === 'function') {
    const functionPlugin = plugin as (ctx: Context, config?: unknown) => unknown
    return {
      name: pluginName(plugin),
      apply(ctx: Context, config?: unknown) {
        return functionPlugin(sandboxContext(ctx, reportFailure), config)
      },
    }
  }
  const objectPlugin = plugin as { apply(ctx: Context, config?: unknown): unknown }
  return {
    ...plugin,
    apply(ctx: Context, config?: unknown) {
      return objectPlugin.apply(sandboxContext(ctx, reportFailure), config)
    },
  }
}

function rejectGuard(reportFailure: (error: Error) => void, message: string): never {
  const error = new Error(message)
  reportFailure(error)
  throw error
}

/**
 * 一个运行中插件的展示名：其 `name` 属性，否则匿名。
 * @param plugin - 宿主半区返回的插件。
 * @returns 用于运行结果与 inspect 输出的、人类可读的名称。
 */
export function pluginName(plugin: Plugin): string {
  const named = (plugin as { name?: unknown }).name
  if (typeof named === 'string' && named.length > 0) return named
  return '<anonymous>'
}
