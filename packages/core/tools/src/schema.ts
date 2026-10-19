/** 统一的 JSON 值模式 DSL、推断、编译与类型化工具辅助。@module dsh-tools/schema */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ToolDefinition, ToolExecution, ToolExecutionResult, ToolRunContext, ToolResult } from './index.ts'
import { assertSupportedJsonSchema, isJsonSchemaRecord, isPlainJsonArray, JsonSchemaError, validateJsonSchemaValue } from './json-schema.ts'
import type { JsonSchemaNode, JsonSchemaScalar, ObjectJsonSchema } from './json-schema.ts'
import type { ToolCallView, ToolResultView } from './presentation.ts'

/** 每个面向作者的模式节点共享的注解关键字。 */
export interface ValueSchemaAnnotations {
  /** 投影进 JSON Schema 与生成类型的人类可读描述。 */
  description?: string
  /** 投影进 JSON Schema 的人类可读标题。 */
  title?: string
  /** 不参与校验的 default 注解；必须是无损 JSON 数据。 */
  default?: JsonValue
  /** 不参与校验的 examples 注解；必须是无损 JSON 数据。 */
  examples?: JsonValue
}

/** 具有类型正确字面量约束的字符串值模式。 */
export interface StringValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'string'
  enum?: readonly string[]
  const?: string
}

/** 具有类型正确字面量约束的有限 JSON 数字模式。 */
export interface NumberValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'number'
  enum?: readonly number[]
  const?: number
}

/** 具有类型正确字面量约束的整数模式。 */
export interface IntegerValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'integer'
  enum?: readonly number[]
  const?: number
}

/** 具有类型正确字面量约束的布尔值模式。 */
export interface BooleanValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'boolean'
  enum?: readonly boolean[]
  const?: boolean
}

/** 具有类型正确字面量约束的 null 值模式。 */
export interface NullValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'null'
  enum?: readonly null[]
  const?: null
}

/** 数组值模式；省略 `items` 则接受任何无损 JSON 项。 */
export interface ArrayValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'array'
  items?: ValueSchemaSpec
}

/**
 * 显式对象值模式。开放性是强制的，使嵌套或输出对象绝不会意外获得 JSON
 * Schema 的默认值。
 */
export interface ObjectValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'object'
  properties?: ParameterSchemaSpec
  additionalProperties: boolean
}

/** 仅作者可用的无约束无损 JSON 节点。 */
export interface JsonValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'json'
}

/** 恰好匹配一个的联合模式；至少需要两个分支。 */
export interface OneOfValueSchemaSpec extends ValueSchemaAnnotations {
  oneOf: readonly [ValueSchemaSpec, ValueSchemaSpec, ...ValueSchemaSpec[]]
}

/** 面向作者的模式，用于任何无损 JSON 值根。 */
export type ValueSchemaSpec =
  | StringValueSchemaSpec
  | NumberValueSchemaSpec
  | IntegerValueSchemaSpec
  | BooleanValueSchemaSpec
  | NullValueSchemaSpec
  | ArrayValueSchemaSpec
  | ObjectValueSchemaSpec
  | JsonValueSchemaSpec
  | OneOfValueSchemaSpec

/** 隐式参数根的一个属性，可选地必填。 */
export type ParameterPropertySpec = ValueSchemaSpec & { required?: true }

/**
 * 工具参数模式。该映射本身是隐式的开放对象根；必填性仍是每个属性的
 * `required: true` 注解。
 */
export type ParameterSchemaSpec = {
  [key: string]: ParameterPropertySpec
  [key: symbol]: never
}

/** 隐式参数对象的原始 JSON Schema 投影。 */
export interface ParameterJsonSchema extends ObjectJsonSchema {
  properties: Record<string, JsonSchemaNode>
}

/** 将交叉类型扁平化为一个对象类型，便于阅读悬停提示。 */
type Simplify<T> = { [K in keyof T]: T[K] } & {}

/** 属性映射的字符串键；运行时编译拒绝 symbol 键。 */
type StringKeyOf<S> = Extract<keyof S, string>

/** 属性映射中标记为 `required: true` 的键。 */
type RequiredKeys<S> = {
  [K in StringKeyOf<S>]: S[K] extends { required: true } ? K : never
}[StringKeyOf<S>]

/** 推断一个参数属性声明的值，不涉及键的可选性。 */
type InferProperty<P, Depth extends unknown[]> = InferValueAt<P, Depth>

/** 将隐式属性映射推断为必填与可选的对象键。 */
type InferProperties<S, Depth extends unknown[]> = Simplify<
  & { [K in RequiredKeys<S>]: InferProperty<S[K], Depth> }
  & { [K in Exclude<StringKeyOf<S>, RequiredKeys<S>>]?: InferProperty<S[K], Depth> }
>

/** 推断显式对象节点，包括其声明的开放性。 */
type InferObject<S extends { additionalProperties: boolean }, Depth extends unknown[]> =
  S extends { properties: infer P }
    ? S['additionalProperties'] extends true
      ? InferProperties<P, Depth> & Record<string, JsonValue>
      : InferProperties<P, Depth>
    : S['additionalProperties'] extends true
      ? Record<string, JsonValue>
      : Record<string, never>

/** 在宽泛原始类型之前推断标量节点的字面量约束。 */
type InferScalar<S, Fallback> =
  S extends { const: infer C } ? C :
    S extends { enum: readonly (infer E)[] } ? E :
      Fallback

/** 为有界的编译期推断增加一层模式容器层级。 */
type NextInferenceDepth<Depth extends unknown[]> = [unknown, ...Depth]

/** 推断单个节点，不将其递归对照完整的作者联合类型检查。 */
type InferValueAt<S, Depth extends unknown[]> =
  Depth['length'] extends 16 ? JsonValue :
    S extends { type: 'string' } ? InferScalar<S, string> :
      S extends { type: 'number' | 'integer' } ? InferScalar<S, number> :
        S extends { type: 'boolean' } ? InferScalar<S, boolean> :
          S extends { type: 'null' } ? null :
            S extends { type: 'array' }
              ? S extends { items: infer I } ? InferValueAt<I, NextInferenceDepth<Depth>>[] : JsonValue[]
              : S extends { type: 'object'; additionalProperties: boolean }
                ? InferObject<S, NextInferenceDepth<Depth>>
                : S extends { type: 'json' } ? JsonValue :
                  S extends { oneOf: readonly unknown[] }
                    ? InferValueAt<S['oneOf'][number], NextInferenceDepth<Depth>>
                    : never

/**
 * 推断面向作者的值模式接受的 TypeScript 值。精确推断以 16 层容器为上限，
 * 之后回退到 `JsonValue`。
 */
export type InferValue<S> = InferValueAt<S, []>

/** 为隐式参数模式推断 TypeScript 参数对象。 */
export type InferArgs<S> = InferProperties<S, []>

const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples'] as const

/** 通过共享的模式错误类型抛出一个作者模式违规。 */
function authorError(message: string): never {
  throw new JsonSchemaError([message])
}

/** 复制自有注解字段，供原始模式校验方使用。 */
function copyAnnotations(source: Record<string, unknown>, target: JsonSchemaNode): void {
  if (Object.hasOwn(source, 'description')) target.description = source.description as string
  if (Object.hasOwn(source, 'title')) target.title = source.title as string
  if (Object.hasOwn(source, 'default')) target.default = source.default as JsonValue
  if (Object.hasOwn(source, 'examples')) target.examples = source.examples as JsonValue
}

/** 拒绝节点声明词汇表之外的仅作者键。 */
function assertAuthorKeys(source: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  for (const key of Object.keys(source)) {
    if (!allowed.includes(key)) authorError(`${path}.${key} is not supported by the value schema DSL`)
  }
}

/** 一个隐式属性映射的编译形式。 */
interface CompiledPropertyMap {
  properties: Record<string, JsonSchemaNode>
  required?: string[]
}

/** 仅在迭代编译根未解析时使用的可变持有器。 */
interface CompileRoot<T> {
  value?: T
}

/** 编译后值节点的安装位置。 */
type NodeDestination =
  | { kind: 'root'; holder: CompileRoot<JsonSchemaNode> }
  | { kind: 'property'; target: Record<string, JsonSchemaNode>; key: string }
  | { kind: 'item'; target: JsonSchemaNode }
  | { kind: 'one-of'; target: JsonSchemaNode[]; index: number }

/** 编译后属性映射的安装位置。 */
type PropertyMapDestination =
  | { kind: 'root'; holder: CompileRoot<CompiledPropertyMap> }
  | { kind: 'object'; target: JsonSchemaNode }

/** 栈安全的作者模式编译的延迟工作。 */
type CompileTask =
  | { kind: 'value'; input: unknown; path: string; allowRequired: boolean; destination: NodeDestination }
  | { kind: 'property-map'; input: unknown; path: string; destination: PropertyMapDestination }
  | {
    kind: 'property'
    property: unknown
    path: string
    key: string
    properties: Record<string, JsonSchemaNode>
    required: string[]
  }
  | {
    kind: 'property-map-tail'
    compiled: CompiledPropertyMap
    required: string[]
    destination: PropertyMapDestination
  }
  | { kind: 'leave'; input: object }

/** 安装编译后的节点，避免赋予 `__proto__` 赋值语义。 */
function assignCompiledNode(destination: NodeDestination, node: JsonSchemaNode): void {
  switch (destination.kind) {
    case 'root':
      destination.holder.value = node
      break
    case 'property':
      Object.defineProperty(destination.target, destination.key, {
        value: node,
        enumerable: true,
        configurable: true,
        writable: true,
      })
      break
    case 'item':
      destination.target.items = node
      break
    case 'one-of':
      destination.target[destination.index] = node
      break
  }
}

/** 在根或包含对象节点处安装编译后的属性映射。 */
function assignCompiledPropertyMap(destination: PropertyMapDestination, compiled: CompiledPropertyMap): void {
  if (destination.kind === 'root') {
    destination.holder.value = compiled
  } else {
    destination.target.properties = compiled.properties
  }
}

/** 执行作者模式编译任务图，不使用递归下降。 */
function runSchemaCompiler(initial: CompileTask): void {
  const seen = new Set<object>()
  const tasks: CompileTask[] = [initial]
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    if (task.kind === 'leave') {
      seen.delete(task.input)
      continue
    }
    if (task.kind === 'property-map-tail') {
      if (task.required.length > 0) {
        task.compiled.required = task.required
        if (task.destination.kind === 'object') task.destination.target.required = task.required
      }
      continue
    }
    if (task.kind === 'property') {
      if (!isJsonSchemaRecord(task.property)) authorError(`${task.path} must be a value schema object`)
      if (Object.hasOwn(task.property, 'required') && task.property.required !== true) {
        authorError(`${task.path}.required must be true when present`)
      }
      if (Object.hasOwn(task.property, 'required') && task.property.required === true) task.required.push(task.key)
      tasks.push({
        kind: 'value',
        input: task.property,
        path: task.path,
        allowRequired: true,
        destination: { kind: 'property', target: task.properties, key: task.key },
      })
      continue
    }
    if (task.kind === 'property-map') {
      if (!isJsonSchemaRecord(task.input)) authorError(`${task.path} must be an object of value schemas`)
      if (seen.has(task.input)) authorError(`${task.path} is circular`)
      seen.add(task.input)
      const compiled: CompiledPropertyMap = { properties: {} }
      const required: string[] = []
      assignCompiledPropertyMap(task.destination, compiled)
      tasks.push({ kind: 'leave', input: task.input })
      tasks.push({ kind: 'property-map-tail', compiled, required, destination: task.destination })
      const entries = Object.entries(task.input)
      for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index]
        /* v8 ignore next -- the loop is bounded by the captured entry count. */
        if (entry === undefined) continue
        tasks.push({
          kind: 'property',
          property: entry[1],
          path: `${task.path}.${entry[0]}`,
          key: entry[0],
          properties: compiled.properties,
          required,
        })
      }
      continue
    }

    const { input, path } = task
    if (!isJsonSchemaRecord(input)) authorError(`${path} must be a value schema object`)
    if (seen.has(input)) authorError(`${path} is circular`)
    seen.add(input)
    const authorKeys = [...ANNOTATION_KEYS, ...(task.allowRequired ? ['required'] : [])]
    const node: JsonSchemaNode = {}
    assignCompiledNode(task.destination, node)
    tasks.push({ kind: 'leave', input })

    if (Object.hasOwn(input, 'oneOf')) {
      assertAuthorKeys(input, path, [...authorKeys, 'oneOf', 'type'])
      if (Object.hasOwn(input, 'type')) authorError(`${path} cannot declare both type and oneOf`)
      if (!isPlainJsonArray(input.oneOf)) authorError(`${path}.oneOf must be an array of at least two value schemas`)
      const branches: JsonSchemaNode[] = []
      node.oneOf = branches
      copyAnnotations(input, node)
      for (let index = input.oneOf.length - 1; index >= 0; index--) {
        tasks.push({
          kind: 'value',
          input: input.oneOf[index],
          path: `${path}.oneOf[${index}]`,
          allowRequired: false,
          destination: { kind: 'one-of', target: branches, index },
        })
      }
      continue
    }

    const inputType = Object.hasOwn(input, 'type') ? input.type : undefined
    switch (inputType) {
      case 'json':
        assertAuthorKeys(input, path, [...authorKeys, 'type'])
        copyAnnotations(input, node)
        break
      case 'object':
        assertAuthorKeys(input, path, [...authorKeys, 'type', 'properties', 'additionalProperties'])
        if (!Object.hasOwn(input, 'additionalProperties') || typeof input.additionalProperties !== 'boolean') {
          authorError(`${path}.additionalProperties must be explicitly true or false`)
        }
        node.type = 'object'
        copyAnnotations(input, node)
        node.additionalProperties = input.additionalProperties
        if (Object.hasOwn(input, 'properties')) {
          tasks.push({
            kind: 'property-map',
            input: input.properties,
            path: `${path}.properties`,
            destination: { kind: 'object', target: node },
          })
        }
        break
      case 'array':
        assertAuthorKeys(input, path, [...authorKeys, 'type', 'items'])
        node.type = 'array'
        copyAnnotations(input, node)
        if (Object.hasOwn(input, 'items')) {
          tasks.push({
            kind: 'value',
            input: input.items,
            path: `${path}.items`,
            allowRequired: false,
            destination: { kind: 'item', target: node },
          })
        }
        break
      case 'string':
      case 'number':
      case 'integer':
      case 'boolean':
      case 'null':
        assertAuthorKeys(input, path, [...authorKeys, 'type', 'enum', 'const'])
        node.type = inputType
        copyAnnotations(input, node)
        if (Object.hasOwn(input, 'enum')) {
          if (!isPlainJsonArray(input.enum)) authorError(`${path}.enum must be a non-empty array of scalar values`)
          node.enum = Array.from(input.enum, entry => entry as JsonSchemaScalar)
        }
        if (Object.hasOwn(input, 'const')) node.const = input.const as JsonSchemaScalar
        break
      default:
        authorError(`${path}.type must be string/number/integer/boolean/null/array/object/json, or use oneOf`)
    }
  }
}

/** 编译一个隐式属性映射，收集每个属性的必填性。 */
function compilePropertyMap(input: unknown, path: string): CompiledPropertyMap {
  const holder: CompileRoot<CompiledPropertyMap> = {}
  runSchemaCompiler({ kind: 'property-map', input, path, destination: { kind: 'root', holder } })
  /* v8 ignore next -- the root task assigns before scheduling any descendants. */
  return holder.value ?? authorError(`${path} did not compile`)
}

/** 编译一个作者节点，不应用任何消费方根约束。 */
function compileValueSchema(input: unknown, path: string): JsonSchemaNode {
  const holder: CompileRoot<JsonSchemaNode> = {}
  runSchemaCompiler({ kind: 'value', input, path, allowRequired: false, destination: { kind: 'root', holder } })
  /* v8 ignore next -- the root task assigns before scheduling any descendants. */
  return holder.value ?? authorError(`${path} did not compile`)
}

/**
 * 将一个面向作者的值模式编译为受强制的原始 JSON Schema 子集。仅作者的
 * `json` 节点变为仅注解的模式。
 * @param spec - 用于任何 JSON 值根的模式。
 * @returns 断言后的原始模式投影。
 */
export function valueSchemaSpecToJsonSchema(spec: ValueSchemaSpec): JsonSchemaNode {
  const schema = compileValueSchema(spec, 'schema')
  assertSupportedJsonSchema(schema)
  return schema
}

/**
 * 将隐式的开放参数对象编译为原始 JSON Schema。
 * @param spec - 每个属性的参数定义。
 * @returns 以对象为根的原始模式，没有隐式根开放性覆盖。
 */
export function parameterSchemaSpecToJsonSchema(spec: ParameterSchemaSpec): ParameterJsonSchema {
  const compiled = compilePropertyMap(spec, 'parameters')
  const schema: ParameterJsonSchema = {
    type: 'object',
    properties: compiled.properties,
    ...(compiled.required === undefined ? {} : { required: compiled.required }),
  }
  assertSupportedJsonSchema(schema)
  return schema
}

/** 类型化工具收到的无效模型生成参数。 */
export class ToolArgsError extends HarnessError {
  /** 按模式遍历顺序排列的各个违规。 */
  readonly violations: string[]

  constructor(violations: string[]) {
    super(`invalid arguments: ${violations.join('; ')}`, 'INVALID_ARGS')
    this.name = 'ToolArgsError'
    this.violations = violations
  }
}

/**
 * 针对隐式参数模式校验模型生成的参数。
 * @param spec - 声明的参数模式。
 * @param args - 候选参数，无论其格式多糟。
 * @returns 带路径限定的违规；为空表示有效。
 */
export function validateArgs(spec: ParameterSchemaSpec, args: unknown): string[] {
  return validateJsonSchemaValue(parameterSchemaSpecToJsonSchema(spec), args, '')
}

/** {@link defineTool} 的选项。 */
export interface DefineToolOptions<S extends ParameterSchemaSpec, O extends ValueSchemaSpec> {
  /** 工具名（必须唯一）。 */
  readonly name: string
  /** 发送给模型的人类可读描述。 */
  readonly description: string
  /** 每个属性的参数模式，编译为隐式开放对象根。 */
  readonly parameters: S
  /** 规范输出模式，加上纯 Native 与展示投影。 */
  readonly output: {
    /** 对每个成功的主体或策略替换值强制执行的模式。 */
    readonly schema: O
    /** 对一个已验证规范值的纯 Native/模型渲染。 */
    render(args: InferArgs<S>, value: InferValue<NoInfer<O>>): ContentBlock[]
    /** 面向原生与嵌套调用的纯可重放展示元数据。 */
    presentationMeta?(args: InferArgs<S>, value: InferValue<NoInfer<O>>): JsonValue
  }
  /** 请求延迟加载工具定义；见 {@link @deepseek-ai/dsh-llm#ToolSchema.deferLoading}. */
  readonly deferLoading?: true
  /** 可选的正数协作式超时预算（毫秒）。 */
  readonly timeoutMs?: number
  /**
   * 用于兄弟重叠的纯分类器。
   * @param args - 类型化的已验证参数。
   * @returns 该调用是否可加入并行组。
   */
  isConcurrencySafe?(args: InferArgs<S>): boolean
  /**
   * 在参数校验后执行工具。
   * @param args - 类型化的已验证参数。
   * @param exec - 执行身份、调用方、取消与嵌套数据。
   * @returns `output.schema` 声明的规范值。
   */
  execute(args: InferArgs<S>, exec: ToolRunContext): Promise<InferValue<NoInfer<O>>>
  /**
   * 在结果策略之前安装执行阶段准备的内容。
   * @param exec - 不可变的执行身份与参数。
   * @param result - 进入执行后阶段的规范化结果。
   * @returns 替换内容；返回 undefined 表示保留原内容。
   */
  projectContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined
  /**
   * 对每个规范化结果可选的最后一公里内容变换。与 `execute` 不同，参数保持
   * `unknown`，因为无效输入失败也会到达此回调。见
   * {@link ToolDefinition.finalizeContent}。
   * @param exec - 不可变的执行身份与参数。
   * @param result - 物化前的完整规范化结果。
   * @returns 替换内容；返回 `undefined` 表示保留原内容。
   */
  finalizeContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined
  /**
   * 纯的待处理状态呈现器。
   * @param args - 类型化的已验证参数。
   * @returns 工具拥有的渲染意图；通用卡片返回 `undefined`。
   */
  presentCall?(args: InferArgs<S>): ToolCallView | undefined
  /**
   * 纯的完成状态呈现器。
   * @param args - 类型化的已验证参数。
   * @param result - 最终面向模型的工具结果。
   * @returns 工具拥有的渲染意图；通用卡片返回 `undefined`。
   */
  presentResult?(args: InferArgs<S>, result: ToolResult): ToolResultView | undefined
}

/**
 * 定义第一方工具，参数类型自动推断并执行严格校验。仅重放路径使用的呈现器
 * 做软校验，对过期的已记录参数回退到通用渲染。
 * @param options - 类型化定义，可选的最终化器与呈现器。
 * @returns 注册表就绪的定义。
 */
export function defineTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(
  options: DefineToolOptions<S, O>,
): ToolDefinition {
  // 对象字面量方法不使用 `this`；保留引用是安全的。
  // oxlint-disable-next-line typescript/unbound-method
  const userExecute = options.execute
  // oxlint-disable-next-line typescript/unbound-method
  const userFinalizeContent = options.finalizeContent
  // oxlint-disable-next-line typescript/unbound-method
  const userProjectContent = options.projectContent
  // oxlint-disable-next-line typescript/unbound-method
  const userRender = options.output.render
  // oxlint-disable-next-line typescript/unbound-method
  const userPresentationMeta = options.output.presentationMeta
  // oxlint-disable-next-line typescript/unbound-method
  const userPresentCall = options.presentCall
  // oxlint-disable-next-line typescript/unbound-method
  const userPresentResult = options.presentResult
  // oxlint-disable-next-line typescript/unbound-method
  const userIsConcurrencySafe = options.isConcurrencySafe
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error(`defineTool(${options.name}): timeoutMs must be a positive finite number`)
  }
  const parameters = parameterSchemaSpecToJsonSchema(options.parameters)
  const outputSchema = valueSchemaSpecToJsonSchema(options.output.schema)
  const validate = (args: unknown): string[] => validateJsonSchemaValue(parameters, args, '')
  const tool: ToolDefinition = {
    name: options.name,
    description: options.description,
    parameters: parameters as unknown as Record<string, unknown>,
    output: {
      schema: outputSchema,
      render(args: unknown, value: JsonValue): ContentBlock[] {
        return userRender(args as InferArgs<S>, value as InferValue<NoInfer<O>>)
      },
      ...userPresentationMeta !== undefined ? {
        presentationMeta(args: unknown, value: JsonValue): JsonValue {
          return userPresentationMeta(args as InferArgs<S>, value as InferValue<NoInfer<O>>)
        },
      } : {},
    },
    ...(options.deferLoading === true ? { deferLoading: options.deferLoading } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    async execute(args: unknown, exec: ToolRunContext): Promise<JsonValue> {
      const violations = validate(args)
      if (violations.length > 0) throw new ToolArgsError(violations)
      return userExecute(args as InferArgs<S>, exec) as Promise<JsonValue>
    },
  }
  if (userProjectContent) {
    tool.projectContent = (exec, result) => userProjectContent(exec, result)
  }
  if (userFinalizeContent) {
    tool.finalizeContent = (exec, result) => userFinalizeContent(exec, result)
  }
  // 展示仅用于显示，并可能在任意已记录参数的重放上运行（可能来自旧模式），
  // 因此绝不能抛出：任何不匹配都做软校验并回退到 `undefined`（通用 UI
  // 展示），而不是执行路径抛出的硬性 `ToolArgsError`。
  if (userPresentCall) {
    tool.presentCall = (args: unknown): ToolCallView | undefined => {
      if (validate(args).length > 0) return undefined
      return userPresentCall(args as InferArgs<S>)
    }
  }
  if (userPresentResult) {
    tool.presentResult = (args: unknown, result: ToolResult): ToolResultView | undefined => {
      if (validate(args).length > 0) return undefined
      return userPresentResult(args as InferArgs<S>, result)
    }
  }
  if (userIsConcurrencySafe) {
    tool.isConcurrencySafe = (args: unknown): boolean => {
      if (validate(args).length > 0) return false
      return userIsConcurrencySafe(args as InferArgs<S>)
    }
  }
  return tool
}
