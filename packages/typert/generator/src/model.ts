/**
 * 与编译器无关的 Typert 分析模型。TypeScript 节点与 checker 对象只是提取输入；
 * 发射器消费此图。
 * @module @deepseek-ai/dsh-typert-generator/model
 */

/** workspace 中彼此独立编译的一端。 */
export type TypertFace = 'host' | 'client'

/** 类型表达式的、图内的稳定标识符。 */
export type TypeNodeId = string

/** 已声明符号的、workspace 的稳定标识符。 */
export type SymbolId = string

/** 普通 TypeScript 源声明中接受的关键字类型。 */
export type KeywordTypeName =
  | 'any'
  | 'bigint'
  | 'boolean'
  | 'never'
  | 'number'
  | 'object'
  | 'string'
  | 'symbol'
  | 'undefined'
  | 'unknown'
  | 'void'

/** TypeScript 类型节点上接受的前缀运算符。 */
export type TypeOperatorName = 'keyof' | 'readonly' | 'unique'

/** 为诊断与源码编辑模式保留的源位置。 */
export interface SourceLocation {
  readonly file: string
  readonly line: number
  readonly column: number
}

/** 一个公共包导出及其解析到的声明。 */
export interface ExportModel {
  readonly subpath: string
  readonly name: string
  readonly symbol: SymbolId
  readonly aliases: readonly string[]
}

/** 一个结构化的 JSDoc 标签，为未知标签保留其原始文本。 */
export interface JsDocTagModel {
  readonly name: string
  readonly argument?: string
  readonly comment?: string
  readonly text: string
}

/** 作为每个带文档模型元素标准组成部分保留的 JSDoc。 */
export interface DocumentationModel {
  readonly description?: string
  readonly summary?: string
  readonly tags: readonly JsDocTagModel[]
  readonly jsDoc?: string
}

/** 一个 Cordis Context 贡献。 */
export interface ServiceModel extends DocumentationModel {
  readonly key: string
  readonly symbol: SymbolId
  readonly export: ExportModel
  readonly members: readonly string[]
  readonly location: SourceLocation
}

/** 一个 Cordis Events 贡献。 */
export interface EventModel extends DocumentationModel {
  readonly name: string
  readonly signature: TypeNodeId
  /** 为字节稳定的源码投影保留的无函数体声明文本。 */
  readonly text: string
  readonly mode?: string
  readonly location: SourceLocation
}

/** 一个显式导出的、引用传递的对象。 */
export interface ObjectModel extends DocumentationModel {
  readonly export: ExportModel
  readonly symbol: SymbolId
  readonly passing: 'reference'
}

/** 一个为 schema 生成而显式选中的值类型。 */
export interface SchemaModel extends DocumentationModel {
  readonly export: ExportModel
  readonly symbol: SymbolId
  readonly type: TypeNodeId
}

/** 为一个生成的 Remote 声明保留的一个公共业务类型导入。 */
export interface RemoteTypeImportModel {
  readonly symbol: SymbolId
  readonly specifier: string
  readonly name: string
}

/** 一个严格的传输线边界，以及命名它所需的公共符号。 */
export interface RemoteBoundaryModel {
  /** 为生成的消费端声明保留的、手写的公共类型。 */
  readonly type: TypeNodeId
  /** 仅用于发射运行时编解码器的、checker 解析出的投影。 */
  readonly codecType: TypeNodeId
  /** 手写的顶层边界是否显式接受 `undefined`。 */
  readonly acceptsUndefined: boolean
  readonly typeSymbol: string
  readonly imports: readonly RemoteTypeImportModel[]
}

/** 一个被投影到 Remote 传输线字段上的、有序的业务参数。 */
export interface InvocationParameterModel {
  readonly name: string
  readonly wire: string
  readonly source: 'json' | 'lookup'
  readonly lookup?: string
  /** 作为可选参数手写，因此消费者可省略该传输线字段。 */
  readonly optional?: true
  readonly boundary: RemoteBoundaryModel
  readonly description?: string
}

/** 一个通过 Typert Gateway 导出的、严格分析的 Host 方法。 */
export interface InvocationModel extends DocumentationModel {
  readonly id: string
  readonly service: string
  readonly namespace: string
  readonly method: string
  readonly implementation?: string
  readonly mode?: 'stream'
  readonly invocation:
    | { readonly kind: 'direct' }
    | {
      readonly kind: 'context'
      readonly context: string
      readonly wire: string
      readonly boundary: RemoteBoundaryModel
    }
  readonly scope?: {
    readonly context: string
    readonly wire: string
  }
  readonly parameters: readonly InvocationParameterModel[]
  /** Client 上行按项的边界，来自 `RemoteStream<Out, In>` 的 `In` 类型实参；当方法不读取时为缺省。 */
  readonly uplink?: {
    readonly boundary: RemoteBoundaryModel
  }
  readonly cancellation?: {
    readonly parameter: 'signal'
  }
  readonly result: RemoteBoundaryModel
  readonly location: SourceLocation
}

/** 在一个包的一个端上发现的业务语义。 */
export interface PackageModel {
  readonly name: string
  readonly root: string
  readonly exports: readonly ExportModel[]
  readonly services: readonly ServiceModel[]
  readonly events: readonly EventModel[]
  readonly objects: readonly ObjectModel[]
  readonly schemas: readonly SchemaModel[]
  readonly invocations: readonly InvocationModel[]
}

/** 独立编译的端之间的一次显式导入/再导出边。 */
export interface CrossFaceLink {
  readonly fromFace: TypertFace
  readonly fromPackage: string
  readonly toFace: TypertFace
  readonly toPackage: string
  readonly subpath: string
  readonly name: string
}

/** 一个独立编译端的完整分析结果。 */
export interface FaceModel {
  readonly face: TypertFace
  readonly packages: readonly PackageModel[]
  readonly graph: TypeGraph
}

/** 完整的 host/client 分析结果。 */
export interface WorkspaceModel {
  readonly faces: readonly FaceModel[]
  readonly crossFaceLinks: readonly CrossFaceLink[]
}

/** 一个顶层手写的类型声明，被索引但不作为图根。 */
export interface SourceDeclarationModel {
  readonly face: TypertFace
  readonly package: string
  readonly name: string
  readonly kind: 'interface' | 'class' | 'alias' | 'enum'
  readonly location: SourceLocation
  readonly text: string
}

/** 在类成员上记录的可见性。 */
export type MemberVisibility = 'public' | 'protected' | 'private'

/** 一个泛型类型参数，保留其求值前的约束/默认值。 */
export interface TypeParameterModel {
  readonly id: string
  readonly name: string
  readonly const: boolean
  readonly constraint?: TypeNodeId
  readonly default?: TypeNodeId
  readonly variance?: 'in' | 'out' | 'in-out'
}

/** 一个函数式参数。 */
export interface ParameterModel {
  readonly name: string
  readonly binding: 'identifier' | 'object' | 'array'
  readonly type: TypeNodeId
  readonly optional: boolean
  readonly rest: boolean
  readonly receiver: boolean
  readonly initializer?: string
}

/** 一个函数/调用/构造签名。 */
export interface SignatureModel {
  readonly typeParameters: readonly TypeParameterModel[]
  readonly parameters: readonly ParameterModel[]
  readonly returns: TypeNodeId
}

/** 类/接口/类型字面量成员的共享标志。 */
export interface MemberBase extends DocumentationModel {
  readonly id: string
  readonly name: string
  /** 当字面量计算键与源文本不同时的 JSON 属性名。 */
  readonly jsonName?: string
  /** 非字面量的计算键；symbol 键从 JSON schema 中擦除。 */
  readonly computed?: 'symbol' | 'dynamic'
  readonly optional: boolean
  readonly readonly: boolean
  readonly async: boolean
  readonly abstract: boolean
  readonly static: boolean
  readonly visibility: MemberVisibility
  readonly location: SourceLocation
  /** 为字节稳定的源码投影保留的无函数体声明文本。 */
  readonly text: string
}

/** 一个属性成员。 */
export interface PropertyMemberModel extends MemberBase {
  readonly kind: 'property'
  readonly type: TypeNodeId
}

/** 一个方法成员。 */
export interface MethodMemberModel extends MemberBase {
  readonly kind: 'method'
  readonly signature: SignatureModel
}

/** 一个 getter 或 setter 成员。 */
export interface AccessorMemberModel extends MemberBase {
  readonly kind: 'getter' | 'setter'
  readonly signature: SignatureModel
}

/** 接口或类型字面量中的一个调用/构造/索引签名。 */
export interface SignatureMemberModel extends MemberBase {
  readonly kind: 'call' | 'construct' | 'index'
  readonly signature: SignatureModel
}

/** 一个声明或对象字面量成员。 */
export type MemberModel =
  | PropertyMemberModel
  | MethodMemberModel
  | AccessorMemberModel
  | SignatureMemberModel

/** 一个枚举成员，保留其开发者手写的初始化器。 */
export interface EnumMemberModel extends DocumentationModel {
  readonly name: string
  readonly initializer?: string
  readonly location: SourceLocation
}

/** 一个合并接口声明的一处手写部分。 */
export interface TypeDeclarationPartModel extends DocumentationModel {
  readonly package: string
  readonly location: SourceLocation
  readonly typeParameters: readonly TypeParameterModel[]
  readonly extends: readonly TypeNodeId[]
  readonly members: readonly string[]
}

/** 一个已声明的接口、类或别名。 */
export interface TypeDeclarationModel extends DocumentationModel {
  readonly id: SymbolId
  readonly package: string
  readonly name: string
  readonly kind: 'interface' | 'class' | 'alias' | 'enum'
  readonly abstract: boolean
  readonly exported: boolean
  readonly location: SourceLocation
  /** 与类型树一同保留的、规范的、无函数体声明文本。 */
  readonly text: string
  readonly typeParameters: readonly TypeParameterModel[]
  readonly extends: readonly TypeNodeId[]
  readonly implements: readonly TypeNodeId[]
  readonly members: readonly MemberModel[]
  readonly parts?: readonly TypeDeclarationPartModel[]
  readonly type?: TypeNodeId
  readonly enumMembers?: readonly EnumMemberModel[]
}

/** 一个具名类型引用的目标。 */
export type TypeTargetModel =
  | { readonly kind: 'declaration'; readonly symbol: SymbolId }
  | { readonly kind: 'type-parameter'; readonly parameter: string }
  | {
    readonly kind: 'cross-face'
    readonly face: TypertFace
    readonly package: string
    readonly subpath: string
    readonly name: string
  }
  | {
    readonly kind: 'external'
    readonly module: string
    readonly subpath: string
    readonly name: string
  }
  | { readonly kind: 'standard'; readonly name: string }

/** 一个元组元素，保留其标签与可选/rest 修饰符。 */
export interface TupleElementModel {
  readonly name?: string
  readonly type: TypeNodeId
  readonly optional: boolean
  readonly rest: boolean
}

/** 一个模板字面量插值。 */
export interface TemplateSpanModel {
  readonly type: TypeNodeId
  readonly text: string
}

/** 与编译器无关的 TypeScript 类型表达式。 */
export type TypeNodeModel = (
  | { readonly id: TypeNodeId; readonly kind: 'keyword'; readonly name: KeywordTypeName }
  | { readonly id: TypeNodeId; readonly kind: 'literal'; readonly value: string | number | bigint | boolean | null; readonly text: string }
  | { readonly id: TypeNodeId; readonly kind: 'parenthesized'; readonly type: TypeNodeId }
  | { readonly id: TypeNodeId; readonly kind: 'reference'; readonly name: string; readonly target: TypeTargetModel; readonly arguments: readonly TypeNodeId[] }
  | { readonly id: TypeNodeId; readonly kind: 'union' | 'intersection'; readonly types: readonly TypeNodeId[] }
  | { readonly id: TypeNodeId; readonly kind: 'array'; readonly element: TypeNodeId }
  | { readonly id: TypeNodeId; readonly kind: 'tuple'; readonly elements: readonly TupleElementModel[] }
  | { readonly id: TypeNodeId; readonly kind: 'object'; readonly members: readonly MemberModel[] }
  | { readonly id: TypeNodeId; readonly kind: 'function'; readonly signature: SignatureModel }
  | { readonly id: TypeNodeId; readonly kind: 'constructor'; readonly abstract: boolean; readonly signature: SignatureModel }
  | { readonly id: TypeNodeId; readonly kind: 'indexed-access'; readonly object: TypeNodeId; readonly index: TypeNodeId }
  | { readonly id: TypeNodeId; readonly kind: 'operator'; readonly operator: TypeOperatorName; readonly type: TypeNodeId }
  | { readonly id: TypeNodeId; readonly kind: 'conditional'; readonly check: TypeNodeId; readonly extends: TypeNodeId; readonly whenTrue: TypeNodeId; readonly whenFalse: TypeNodeId }
  | { readonly id: TypeNodeId; readonly kind: 'infer'; readonly parameter: TypeParameterModel }
  | {
    readonly id: TypeNodeId
    readonly kind: 'mapped'
    readonly parameter: TypeParameterModel
    readonly nameType?: TypeNodeId
    readonly value?: TypeNodeId
    readonly readonly: 'add' | 'remove' | 'preserve'
    readonly optional: 'add' | 'remove' | 'preserve'
  }
  | { readonly id: TypeNodeId; readonly kind: 'template-literal'; readonly head: string; readonly spans: readonly TemplateSpanModel[] }
  | { readonly id: TypeNodeId; readonly kind: 'type-query'; readonly expression: string; readonly arguments: readonly TypeNodeId[] }
  | {
    readonly id: TypeNodeId
    readonly kind: 'import-type'
    readonly module: string
    readonly qualifier?: string
    readonly arguments: readonly TypeNodeId[]
    readonly typeof: boolean
    readonly attributes?: string
    readonly target?: TypeTargetModel
  }
  | { readonly id: TypeNodeId; readonly kind: 'predicate'; readonly asserts: boolean; readonly parameter: string; readonly type?: TypeNodeId }
  | { readonly id: TypeNodeId; readonly kind: 'this' }
) & {
  /** 规范的无损 JsonValue，在不使用递归工具 schema 引用的前提下表示。 */
  readonly json?: true
}

/**
 * 返回一个节点所拥有的、直接指向的类型表达式边。
 * @param node - 待检查、与编译器无关的类型节点。
 * @returns 其直接子类型节点的、图内的 id。
 */
export function childTypeNodeIds(node: TypeNodeModel): TypeNodeId[] {
  switch (node.kind) {
    case 'parenthesized':
    case 'operator': return [node.type]
    case 'reference': return [...node.arguments]
    case 'union':
    case 'intersection': return [...node.types]
    case 'array': return [node.element]
    case 'tuple': return node.elements.map(element => element.type)
    case 'indexed-access': return [node.object, node.index]
    case 'conditional': return [node.check, node.extends, node.whenTrue, node.whenFalse]
    case 'mapped': return [
      ...(node.parameter.constraint === undefined ? [] : [node.parameter.constraint]),
      ...(node.parameter.default === undefined ? [] : [node.parameter.default]),
      ...(node.nameType === undefined ? [] : [node.nameType]),
      ...(node.value === undefined ? [] : [node.value]),
    ]
    case 'template-literal': return node.spans.map(span => span.type)
    case 'type-query':
    case 'import-type': return [...node.arguments]
    case 'predicate': return node.type === undefined ? [] : [node.type]
    case 'infer': return [
      ...(node.parameter.constraint === undefined ? [] : [node.parameter.constraint]),
      ...(node.parameter.default === undefined ? [] : [node.parameter.default]),
    ]
    case 'keyword':
    case 'literal':
    case 'object':
    case 'function':
    case 'constructor':
    case 'this': return []
    default: return assertNever(node)
  }
}

/** 一个端所拥有的类型声明与表达式。 */
export interface TypeGraph {
  readonly declarations: readonly TypeDeclarationModel[]
  readonly nodes: readonly TypeNodeModel[]
}

function assertNever(value: never): never {
  throw new Error(`unsupported model variant ${JSON.stringify(value)}`)
}
