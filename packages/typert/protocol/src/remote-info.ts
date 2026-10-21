/** 使用调用方提供的 Zod 惰性组装生成的 Remote 定义；不引入运行时导入。 */

import type { z } from 'zod'
import type {
  InvocationDescriptor,
  TypertClientRemote,
  TypertRemoteCodecSpec,
  TypertRemoteInfo,
  TypertRemoteInputOptions,
  TypertRemoteMethod,
  TypertRemoteParameterSpec,
  TypertRemoteSpec,
  TypertRemoteValue,
} from './types.ts'

type Method = TypertRemoteMethod<object, unknown> | TypertRemoteMethod<object, unknown, 'stream', unknown>
type Parameter = TypertRemoteParameterSpec & { readonly wire: string }
type Index = Pick<TypertRemoteInfo, 'descriptors' | 'methods'>

/**
 * 为每个端点保留一份生成的定义，而无需构造解析器或投影。
 * 类实例在首次访问时构建其共享的描述符/方法索引；输入 schema 与
 * JSON Schema 投影仅在被请求时缓存。
 * @param spec - 编译器产出的方法事实与 Zod 工厂。
 * @param zod - 生成产物用于具名输入解析器的 Zod 运行时。
 * @returns 一个惰性的、可挂载的 info 实例，无注册或传输副作用。
 */
export function createTypertRemoteInfo(spec: TypertRemoteSpec, zod: typeof z): TypertRemoteInfo {
  return new RemoteInfo(spec, zod)
}

class RemoteInfo implements TypertRemoteInfo {
  private index?: Index

  constructor(private readonly spec: TypertRemoteSpec, private readonly zod: typeof z) {}

  get package(): string { return this.spec.package }
  get descriptors(): readonly InvocationDescriptor[] { return this.resolve().descriptors }
  get methods(): TypertRemoteInfo['methods'] { return this.resolve().methods }

  private resolve(): Index {
    if (this.index !== undefined) return this.index
    const zod = this.zod
    const descriptors: InvocationDescriptor[] = []
    const methods = Object.create(null) as Record<string, Method>
    for (const [endpoint, definition] of Object.entries(this.spec.methods)) {
      const separator = endpoint.indexOf('/')
      const namespace = endpoint.slice(0, separator)
      const method = endpoint.slice(separator + 1)
      const parameters = definition.parameters.map(parameter => ({ ...parameter, wire: parameter.wire ?? parameter.name }))
      const descriptor = {
        ...definition,
        id: `${this.spec.package}#${endpoint}`,
        namespace,
        method,
        parameters,
        result: definition.result.description === undefined ? definition.result : new ResultValue(definition.result),
      }
      if (definition.invocation.kind === 'direct') {
        const inputs: [NamedInput?, NamedInput?] = []
        const direct = Object.assign(descriptor, {
          input(options?: TypertRemoteInputOptions) {
            const strict = options?.strict === true
            return inputs[strict ? 1 : 0] ??= new NamedInput(parameters, strict, zod)
          },
          invoke(remote: TypertClientRemote, input: object, signal?: AbortSignal) {
            const named = input as Readonly<Record<string, unknown>>
            const values = parameters.map(parameter => named[parameter.wire])
            if (definition.cancellation !== undefined) values.push(signal)
            // 命名空间访问保留了 Gateway 的挂载检查与限定接收方策略。
            const receiver = Reflect.get(remote, namespace) as object
            const call = Reflect.get(receiver, method) as (...args: unknown[]) => ReturnType<Method['invoke']>
            return call.apply(receiver, values)
          },
        })
        // 生成的命名空间返回类型由同一描述符的 mode 选定。
        methods[endpoint] = direct as Method
      }
      descriptors.push(descriptor)
    }
    return this.index = { descriptors, methods }
  }
}

/**
 * 将一个 Registry 描述符收窄为其生成的直连方法能力。
 * @param descriptor - 一个存活的描述符，可能包含源码回退或仅 Context 接收方。
 * @returns 是否具备生成的具名输入与直连调用能力。
 */
export function isTypertRemoteMethod(descriptor: InvocationDescriptor): descriptor is Method {
  return descriptor.invocation.kind === 'direct' && descriptor.result.mode === 'strict'
    && 'input' in descriptor && typeof descriptor.input === 'function'
    && 'invoke' in descriptor && typeof descriptor.invoke === 'function'
}

function optional(parameter: Parameter): boolean {
  return parameter.source === 'json' && parameter.acceptsUndefined === true
}

class NamedInput implements TypertRemoteValue<object> {
  private schema?: z.ZodType<object>
  private projection?: Pick<TypertRemoteValue, 'jsonSchema' | 'jsonSchemaError'>

  constructor(
    private readonly parameters: readonly Parameter[],
    private readonly strict: boolean,
    private readonly zod: typeof z,
  ) {}

  private codec(parameter: Parameter): TypertRemoteCodecSpec {
    return this.strict ? parameter.strictCodec : parameter.codec
  }

  readonly create = (): z.ZodType<object> => this.schema ??= this.zod.strictObject(Object.fromEntries(this.parameters.map((parameter) => {
    const value = this.codec(parameter).create()
    return [parameter.wire, optional(parameter) ? value.optional() : value.nonoptional()]
  })))

  get jsonSchema(): TypertRemoteValue['jsonSchema'] { return this.project().jsonSchema }
  get jsonSchemaError(): string | undefined { return this.project().jsonSchemaError }

  private project(): NonNullable<NamedInput['projection']> {
    if (this.projection !== undefined) return this.projection
    const unavailable = this.parameters.find(parameter => this.codec(parameter).jsonSchema === undefined)
    if (unavailable !== undefined) {
      return this.projection = { jsonSchemaError: this.codec(unavailable).jsonSchemaError ?? `No JSON Schema for parameter ${unavailable.wire}` }
    }
    return this.projection = {
      jsonSchema: {
        type: 'object',
        properties: Object.fromEntries(this.parameters.map(parameter => [parameter.wire, {
          ...this.codec(parameter).jsonSchema,
          ...(parameter.description === undefined ? {} : { description: parameter.description }),
        }])),
        required: this.parameters.filter(parameter => !optional(parameter)).map(parameter => parameter.wire),
        additionalProperties: false,
      },
    }
  }
}

class ResultValue implements TypertRemoteCodecSpec {
  private projection?: { readonly value: TypertRemoteValue['jsonSchema'] }

  constructor(private readonly spec: TypertRemoteCodecSpec) {}

  get mode(): 'strict' { return this.spec.mode }
  get typeSymbol(): string { return this.spec.typeSymbol }
  get create(): TypertRemoteCodecSpec['create'] { return this.spec.create }
  get decode(): TypertRemoteCodecSpec['decode'] { return this.spec.decode }
  get encode(): TypertRemoteCodecSpec['encode'] { return this.spec.encode }
  get description(): string | undefined { return this.spec.description }
  get jsonSchemaError(): string | undefined { return this.spec.jsonSchemaError }
  get jsonSchema(): TypertRemoteValue['jsonSchema'] {
    if (this.projection === undefined) {
      const schema = this.spec.jsonSchema
      this.projection = { value: schema === undefined ? undefined : { ...schema, description: this.spec.description } }
    }
    return this.projection.value
  }
}
