/**
 * 与编译器无关的 TypeGraph 之上的渲染与遍历。发射器使用本模块，而非回溯到
 * TypeScript AST 节点。
 * @module @deepseek-ai/dsh-typert-generator/renderer
 */

import { childTypeNodeIds } from './model.ts'
import type {
  MemberModel,
  ParameterModel,
  SignatureModel,
  SymbolId,
  TypeDeclarationModel,
  TypeGraph,
  TypeNodeId,
  TypeNodeModel,
  TypeParameterModel,
} from './model.ts'

/** 渲染或遍历内部不一致的 TypeGraph 时失败。 */
export class TypeGraphRenderError extends Error {
  override name = 'TypeGraphRenderError'
}

/** 读取并渲染一个不依赖编译器对象的 TypeGraph。 */
export class TypeGraphRenderer {
  private readonly nodes: ReadonlyMap<TypeNodeId, TypeNodeModel>
  private readonly declarations: ReadonlyMap<SymbolId, TypeDeclarationModel>
  private readonly members: ReadonlyMap<string, MemberModel>
  private readonly parameterNames = new Map<string, string>()

  /**
   * 索引一个完整的图。
   * @param graph - 要渲染的、与编译器无关的图。
   */
  constructor(readonly graph: TypeGraph) {
    this.nodes = new Map(graph.nodes.map(node => [node.id, node]))
    this.declarations = new Map(graph.declarations.map(declaration => [declaration.id, declaration]))
    this.members = new Map(graph.declarations.flatMap(declaration => declaration.members.map(member => [member.id, member] as const)))
    for (const declaration of graph.declarations) {
      this.indexParameters(declaration.typeParameters)
      for (const member of declaration.members) {
        if ('signature' in member) this.indexParameters(member.signature.typeParameters)
      }
    }
  }

  /**
   * 解析一个节点 id，或在边损坏时失败。
   * @param id - 图内的类型节点 id。
   * @returns 被引用的节点。
   */
  node(id: TypeNodeId): TypeNodeModel {
    const node = this.nodes.get(id)
    if (node === undefined) throw new TypeGraphRenderError(`type graph references missing node ${id}`)
    return node
  }

  /**
   * 解析一个声明 id，或在边损坏时失败。
   * @param id - workspace 符号 id。
   * @returns 被引用的声明。
   */
  declaration(id: SymbolId): TypeDeclarationModel {
    const declaration = this.declarations.get(id)
    if (declaration === undefined) throw new TypeGraphRenderError(`type graph references missing declaration ${id}`)
    return declaration
  }

  /**
   * 解析一个公共成员 id。
   * @param id - 声明成员 id。
   * @returns 被引用的成员。
   */
  member(id: string): MemberModel {
    const member = this.members.get(id)
    if (member === undefined) throw new TypeGraphRenderError(`type graph references missing member ${id}`)
    return member
  }

  /**
   * 从保留的源结构渲染一个类型表达式。
   * @param id - 类型节点 id。
   * @param references - 可选的、用于声明引用的生成名。
   * @returns TypeScript 类型文本。
   */
  renderType(id: TypeNodeId, references?: ReadonlyMap<SymbolId, string>): string {
    const node = this.node(id)
    switch (node.kind) {
      case 'keyword': return node.name
      case 'literal': return node.text
      case 'parenthesized': return `(${this.renderType(node.type, references)})`
      case 'reference': {
        const name = node.target.kind === 'type-parameter'
          ? this.parameterNames.get(node.target.parameter) ?? node.name
          : node.target.kind === 'declaration'
            ? references?.get(node.target.symbol) ?? node.name
            : node.name
        return node.arguments.length === 0
          ? name
          : `${name}<${node.arguments.map(argument => this.renderType(argument, references)).join(', ')}>`
      }
      case 'union': return node.types.map(type => this.renderType(type, references)).join(' | ')
      case 'intersection': return node.types.map(type => this.renderType(type, references)).join(' & ')
      case 'array': {
        const element = this.renderType(node.element, references)
        const wrapped = needsArrayParentheses(this.node(node.element)) ? `(${element})` : element
        return `${wrapped}[]`
      }
      case 'tuple': {
        const elements = node.elements.map((element) => {
          const type = this.renderType(element.type, references)
          if (element.name !== undefined) {
            return `${element.rest ? '...' : ''}${element.name}${element.optional ? '?' : ''}: ${type}`
          }
          return `${element.rest ? '...' : ''}${type}${element.optional ? '?' : ''}`
        })
        return `[${elements.join(', ')}]`
      }
      case 'object': return this.renderObject(node.members, references)
      case 'function': return `${this.renderSignatureHead(node.signature, references)} => ${this.renderType(node.signature.returns, references)}`
      case 'constructor': return `${node.abstract ? 'abstract ' : ''}new ${this.renderSignatureHead(node.signature, references)} => ${this.renderType(node.signature.returns, references)}`
      case 'indexed-access': return `${this.renderType(node.object, references)}[${this.renderType(node.index, references)}]`
      case 'operator': return `${node.operator} ${this.renderType(node.type, references)}`
      case 'conditional': {
        return `${this.renderType(node.check, references)} extends ${this.renderType(node.extends, references)} ? ${this.renderType(node.whenTrue, references)} : ${this.renderType(node.whenFalse, references)}`
      }
      case 'infer': return `infer ${this.renderTypeParameter(node.parameter, false, references)}`
      case 'mapped': {
        const readonly = node.readonly === 'preserve' ? '' : node.readonly === 'remove' ? '-readonly ' : 'readonly '
        const optional = node.optional === 'preserve' ? '' : node.optional === 'remove' ? '-?' : '?'
        if (node.parameter.constraint === undefined) {
          throw new TypeGraphRenderError(`mapped type parameter ${node.parameter.name} has no constraint`)
        }
        const parameter = `${node.parameter.name} in ${this.renderType(node.parameter.constraint, references)}`
        const nameType = node.nameType === undefined ? '' : ` as ${this.renderType(node.nameType, references)}`
        const value = node.value === undefined ? 'unknown' : this.renderType(node.value, references)
        return `{ ${readonly}[${parameter}${nameType}]${optional}: ${value} }`
      }
      case 'template-literal': {
        const spans = node.spans.map(span => `\${${this.renderType(span.type, references)}}${escapeTemplate(span.text)}`).join('')
        return `\`${escapeTemplate(node.head)}${spans}\``
      }
      case 'type-query': {
        const argumentsText = node.arguments.length === 0
          ? ''
          : `<${node.arguments.map(argument => this.renderType(argument, references)).join(', ')}>`
        return `typeof ${node.expression}${argumentsText}`
      }
      case 'import-type': {
        const attributes = node.attributes === undefined ? '' : `, ${node.attributes}`
        const imported = `import(${quote(node.module)}${attributes})${node.qualifier === undefined ? '' : `.${node.qualifier}`}`
        const argumentsText = node.arguments.length === 0
          ? ''
          : `<${node.arguments.map(argument => this.renderType(argument, references)).join(', ')}>`
        return `${node.typeof ? 'typeof ' : ''}${imported}${argumentsText}`
      }
      case 'predicate': {
        const assertion = node.asserts ? 'asserts ' : ''
        return node.type === undefined
          ? `${assertion}${node.parameter}`
          : `${assertion}${node.parameter} is ${this.renderType(node.type, references)}`
      }
      case 'this': return 'this'
      default: return assertNever(node)
    }
  }

  /**
   * 渲染一个无名的可调用签名。
   * @param signature - 被建模的签名。
   * @param references - 可选的、用于声明引用的生成名。
   * @returns 参数列表与返回类型。
   */
  renderSignature(signature: SignatureModel, references?: ReadonlyMap<SymbolId, string>): string {
    return `${this.renderSignatureHead(signature, references)}: ${this.renderType(signature.returns, references)}`
  }

  /**
   * 将一个类/接口成员渲染为无函数体的声明。
   * @param member - 被建模的成员。
   * @param sourceModifiers - 保留仅源可见的修饰符用于反射文本。
   * @param references - 可选的、用于声明引用的生成名。
   * @returns 单行 TypeScript 成员文本。
   */
  renderMember(member: MemberModel, sourceModifiers = false, references?: ReadonlyMap<SymbolId, string>): string {
    if (sourceModifiers) return member.text
    const name = renderPropertyName(member.name)
    const optional = member.optional ? '?' : ''
    const readonly = member.readonly ? 'readonly ' : ''
    const abstract = member.abstract ? 'abstract ' : ''
    switch (member.kind) {
      case 'property': return `${abstract}${readonly}${name}${optional}: ${this.renderType(member.type, references)}`
      case 'method': return `${abstract}${name}${optional}${this.renderSignature(member.signature, references)}`
      case 'getter': return `${abstract}get ${name}()${this.renderReturn(member.signature, references)}`
      case 'setter': return `${abstract}set ${name}${this.renderSignatureHead(member.signature, references)}`
      case 'call': return this.renderSignature(member.signature, references)
      case 'construct': return `new ${this.renderSignature(member.signature, references)}`
      case 'index': {
        const parameters = member.signature.parameters.map(parameter => this.renderParameter(parameter, references)).join(', ')
        return `${readonly}[${parameters}]: ${this.renderType(member.signature.returns, references)}`
      }
      default: return assertNever(member)
    }
  }

  /**
   * 渲染一个无名声明的声明，不含 JSDoc。
   * @param id - 声明符号 id。
   * @returns 导出的 TypeScript 声明文本。
   */
  renderDeclaration(id: SymbolId): string {
    const declaration = this.declaration(id)
    const parameters = this.renderTypeParameters(declaration.typeParameters)
    if (declaration.kind === 'enum') {
      const members = declaration.enumMembers?.map(member =>
        `    ${renderPropertyName(member.name)}${member.initializer === undefined ? '' : ` = ${member.initializer}`},`) ?? []
      return [`export enum ${declaration.name} {`, ...members, '}'].join('\n')
    }
    if (declaration.kind === 'alias') {
      if (declaration.type === undefined) throw new TypeGraphRenderError(`alias ${id} has no type node`)
      return `export type ${declaration.name}${parameters} = ${this.renderType(declaration.type)};`
    }
    const extendsTypes = declaration.extends.map(type => this.renderType(type))
    const implementsTypes = declaration.implements.map(type => this.renderType(type))
    const heritage = [
      extendsTypes.length === 0 ? '' : ` extends ${extendsTypes.join(', ')}`,
      implementsTypes.length === 0 ? '' : ` implements ${implementsTypes.join(', ')}`,
    ].join('')
    const prefix = declaration.kind === 'class' && declaration.abstract ? 'abstract ' : ''
    const members = declaration.members.map(member => `    ${this.renderMember(member)};`)
    return [`export ${prefix}${declaration.kind} ${declaration.name}${parameters}${heritage} {`, ...members, '}'].join('\n')
  }

  /**
   * 找到成员所引用的、传递闭包的声明。
   * @param memberIds - 业务 API 成员 id。
   * @returns 按图顺序排列的声明，不隐式排除任何根。
   */
  declarationClosureForMembers(memberIds: readonly string[]): TypeDeclarationModel[] {
    return this.declarationClosure(memberIds, [])
  }

  /**
   * 找到类型根所引用的、传递闭包的声明。
   * @param typeIds - 图类型根。
   * @returns 按图顺序排列的声明。
   */
  declarationClosureForTypes(typeIds: readonly TypeNodeId[]): TypeDeclarationModel[] {
    return this.declarationClosure([], typeIds)
  }

  private declarationClosure(
    memberIds: readonly string[],
    typeIds: readonly TypeNodeId[],
  ): TypeDeclarationModel[] {
    const found = new Set<SymbolId>()
    const visiting = new Set<SymbolId>()
    const visitNode = (id: TypeNodeId): void => {
      const node = this.node(id)
      if (node.kind === 'reference' && node.target.kind === 'declaration') visitDeclaration(node.target.symbol)
      if (node.kind === 'import-type' && node.target?.kind === 'declaration') visitDeclaration(node.target.symbol)
      for (const child of childTypeNodeIds(node)) visitNode(child)
      for (const signature of nodeSignatures(node)) visitSignature(signature)
      if (node.kind === 'object') for (const member of node.members) visitMember(member)
    }
    const visitSignature = (signature: SignatureModel): void => {
      for (const parameter of signature.typeParameters) {
        if (parameter.constraint !== undefined) visitNode(parameter.constraint)
        if (parameter.default !== undefined) visitNode(parameter.default)
      }
      for (const parameter of signature.parameters) visitNode(parameter.type)
      visitNode(signature.returns)
    }
    const visitMember = (member: MemberModel): void => {
      if (member.kind === 'property') visitNode(member.type)
      else visitSignature(member.signature)
    }
    const visitDeclaration = (id: SymbolId): void => {
      if (found.has(id) || visiting.has(id)) return
      visiting.add(id)
      const declaration = this.declaration(id)
      for (const parameter of declaration.typeParameters) {
        if (parameter.constraint !== undefined) visitNode(parameter.constraint)
        if (parameter.default !== undefined) visitNode(parameter.default)
      }
      for (const type of [...declaration.extends, ...declaration.implements]) visitNode(type)
      if (declaration.type !== undefined) visitNode(declaration.type)
      for (const member of declaration.members) visitMember(member)
      visiting.delete(id)
      found.add(id)
    }
    for (const id of memberIds) visitMember(this.member(id))
    for (const id of typeIds) visitNode(id)
    return this.graph.declarations.filter(declaration => found.has(declaration.id))
  }

  private renderSignatureHead(signature: SignatureModel, references?: ReadonlyMap<SymbolId, string>): string {
    return `${this.renderTypeParameters(signature.typeParameters, references)}(${signature.parameters.map(parameter => this.renderParameter(parameter, references)).join(', ')})`
  }

  private renderReturn(signature: SignatureModel, references?: ReadonlyMap<SymbolId, string>): string {
    return `: ${this.renderType(signature.returns, references)}`
  }

  private renderParameter(parameter: ParameterModel, references?: ReadonlyMap<SymbolId, string>): string {
    const name = parameter.binding === 'identifier' ? renderPropertyName(parameter.name) : parameter.name
    const optional = parameter.initializer === undefined && parameter.optional && !parameter.rest ? '?' : ''
    const initializer = parameter.initializer === undefined ? '' : ` = ${parameter.initializer}`
    return `${parameter.rest ? '...' : ''}${name}${optional}: ${this.renderType(parameter.type, references)}${initializer}`
  }

  private renderTypeParameters(parameters: readonly TypeParameterModel[], references?: ReadonlyMap<SymbolId, string>): string {
    return parameters.length === 0
      ? ''
      : `<${parameters.map(parameter => this.renderTypeParameter(parameter, true, references)).join(', ')}>`
  }

  private renderTypeParameter(
    parameter: TypeParameterModel,
    includeDefault: boolean,
    references?: ReadonlyMap<SymbolId, string>,
  ): string {
    const variance = parameter.variance === undefined ? '' : `${parameter.variance === 'in-out' ? 'in out' : parameter.variance} `
    const constModifier = parameter.const ? 'const ' : ''
    const constraint = parameter.constraint === undefined ? '' : ` extends ${this.renderType(parameter.constraint, references)}`
    const fallback = !includeDefault || parameter.default === undefined ? '' : ` = ${this.renderType(parameter.default, references)}`
    return `${constModifier}${variance}${parameter.name}${constraint}${fallback}`
  }

  private renderObject(members: readonly MemberModel[], references?: ReadonlyMap<SymbolId, string>): string {
    if (members.length === 0) return '{}'
    return `{ ${members.map(member => `${this.renderMember(member, false, references)};`).join(' ')} }`
  }

  private indexParameters(parameters: readonly TypeParameterModel[]): void {
    for (const parameter of parameters) this.parameterNames.set(parameter.id, parameter.name)
  }
}

function nodeSignatures(node: TypeNodeModel): SignatureModel[] {
  return node.kind === 'function' || node.kind === 'constructor' ? [node.signature] : []
}

function needsArrayParentheses(node: TypeNodeModel): boolean {
  return node.kind === 'union' || node.kind === 'intersection' || node.kind === 'function' || node.kind === 'constructor' || node.kind === 'conditional'
}

function renderPropertyName(name: string): string {
  if (name.startsWith('[') && name.endsWith(']')) return name
  if (/^(?:[$A-Z_a-z][$\w]*|\d+)$/u.test(name)) return name
  return quote(name)
}

function quote(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n')}'`
}

function escapeTemplate(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('`', '\\`').replaceAll('${', '\\${')
}

function assertNever(value: never): never {
  throw new TypeGraphRenderError(`unsupported model variant ${JSON.stringify(value)}`)
}
