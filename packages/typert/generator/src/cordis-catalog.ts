/**
 * 针对 Cordis 目录、构建于与编译器无关的 Typert 模型之上的投影。本模块拥有
 * Cordis 校验与文本投影机制；调用方提供仓库特定的类型分类与继承数据。
 * @module @deepseek-ai/dsh-typert-generator
 */

import { WorkspaceAnalyzer, WorkspaceCaches } from './analyzer.ts'
import { childTypeNodeIds } from './model.ts'
import { TypeGraphRenderer } from './renderer.ts'
import type {
  FaceModel,
  MemberModel,
  ParameterModel,
  ServiceModel,
  SignatureModel,
  SourceDeclarationModel,
  SourceLocation,
  TypertFace,
  TypeNodeId,
} from './model.ts'

type Mode = 'emit' | 'bail' | 'waterfall' | 'parallel' | 'serial'

/** 为生成签名块准备的围栏信息串（doc-typecheck 跳过它，因为裸签名片段无法独立编译）。 */
const FENCE = 'ts cordis-catalog'

/** 从保留的类型树追加按失败即拒绝处理的签名类型链接违规。 */
function checkTypeLinks(
  where: string,
  names: readonly string[],
  policy: CordisCatalogPolicy,
  violations: string[],
): void {
  for (const name of names) {
    if (Object.hasOwn(policy.linkedTypePages, name)
      || policy.foundationTypeNames.has(name)
      || Object.hasOwn(policy.typeLinkExemptions, name)) continue
    violations.push(
      `${where} references unclassified type '${name}'. Add it to linkedTypePages with its documentation page, `
      + 'to foundationTypeNames if TypeScript or the framework owns it, or to typeLinkExemptions with '
      + 'the non-catalog documentation owner.',
    )
  }
}

/** 为每个未分类的签名类型抛出一条汇总诊断。 */
function reportTypeLinkViolations(gate: string, violations: string[]): void {
  if (violations.length === 0) return
  throw new Error(
    `${gate}: ${violations.length} signature type-link coverage violation(s):\n`
    + violations.map(violation => `  ${violation}`).join('\n'),
  )
}

/** 从 `interface Events` 块中提取的一个 harness 事件。 */
export interface EventEntry {
  /** 限定名，例如 `agent/request`。 */
  name: string
  /** 作用域前缀，例如 `agent`（首个 `/` 之前的部分）。 */
  scope: string
  /** 完整签名文本（已剥离方法签名成员与 JSDoc）。 */
  signature: string
  /** 原始声明 JSDoc，从其所属接口去缩进。 */
  jsDoc: string
  /** 来自 `@mode` 标签的调度模式。 */
  mode: Mode
  /** 描述性散文（JSDoc 去掉 `@mode` 标签后），每段一行。 */
  doc: string
  /** 声明的源指针 `packages/…/file.ts:line`。 */
  source: string
}

/** 一个公共 service 方法，及其附带的源契约。 */
export interface ServiceMethodEntry {
  /** 编译器成员类别；策略提供的方法可省略它。 */
  kind?: 'method' | 'property'
  /** 公共方法签名（已剥离函数体）。 */
  signature: string
  /** 方法的原始 JSDoc，从其所属类去缩进。 */
  jsDoc: string
}

/** 从 `interface Context` 块中提取的一个 harness service。 */
export interface ServiceEntry {
  /** `ctx.<key>` 名，例如 `llm`。 */
  key: string
  /** service 类/接口名，例如 `LlmRuntime`。 */
  type: string
  /** service 类是否为抽象类（一个 seam 接口）。 */
  abstract: boolean
  /** 类级 JSDoc 散文，每段一行。 */
  doc: string
  /** 公共方法（已剥离函数体），按源顺序排列。 */
  methods: ServiceMethodEntry[]
  /** 类声明的源指针。 */
  source: string
}

/** 由目录策略提供的、简明的继承层条目。 */
export interface InheritedEntry {
  /** 被继承事件或 Context 成员组的显示名。 */
  name: string
  /** 渲染进目录的单行描述。 */
  summary: string
  /** 源指针，例如 `vendor/…:line`。 */
  source: string
}

/** 被 Cordis 目录解析与渲染逻辑消费的仓库策略。 */
export interface CordisCatalogPolicy {
  /** 从签名链接到其文档页的类型名。 */
  readonly linkedTypePages: Readonly<Record<string, string>>
  /** 无需仓库文档链接的 TypeScript 或框架类型。 */
  readonly foundationTypeNames: ReadonlySet<string>
  /** 刻意记录于链接数据目录之外文档处的仓库类型。 */
  readonly typeLinkExemptions: Readonly<Record<string, string>>
  /** 包含在面向模型运行时目录、但不在 harness 文档分区中的框架 Service。 */
  readonly runtimeServices?: readonly ServiceEntry[]
  /** 从面向模型运行时目录中省略的 harness Service，因为动态 Plugin 不得调用它们。 */
  readonly runtimeServiceExclusions?: ReadonlySet<string>
  /** 由每个插件继承的、手工整理的框架事件。 */
  readonly inheritedEvents: readonly InheritedEntry[]
  /** 由每个插件继承的、手工整理的框架 Context 成员。 */
  readonly inheritedServices: readonly InheritedEntry[]
  /** 每个运行时类型声明渲染的最大字符数。 */
  readonly runtimeDeclarationMaxChars?: number
}

/** 每个文本渲染器使用的、完整的模型级 Cordis 投影。 */
export interface CordisCatalogModel {
  readonly events: readonly EventEntry[]
  readonly services: readonly ServiceEntry[]
}

/** 针对一个 Typert 端、仓库特定的 Cordis 校验与投影。 */
export class CordisCatalogProjector {
  private readonly renderer: TypeGraphRenderer

  /**
   * @param face - 包含包业务语义、已分析的 Host 或 Client 端。
   * @param sourceDeclarations - 运行时类型闭包可用的已导出声明。
   * @param policy - 调用方拥有的类型分类与继承 Cordis 数据。
   */
  constructor(
    private readonly face: FaceModel,
    private readonly sourceDeclarations: readonly SourceDeclarationModel[],
    private readonly policy: CordisCatalogPolicy,
  ) {
    this.renderer = new TypeGraphRenderer(face.graph)
  }

  /**
   * 校验并投影 host 模型的 Cordis API。
   * @returns 从 host 模型投影出的、每个已校验的 service 与事件。
   */
  project(): CordisCatalogModel {
    return {
      events: this.collectEvents(),
      services: this.collectServices(),
    }
  }

  /**
   * 渲染由 `tool-cordis` 消费的、面向模型的静态 API。
   * @param model - 来自本投影器的、已校验的 Cordis 目录投影。
   * @returns 面向模型的 TypeScript 目录源。
   */
  renderRuntimeApi(model: CordisCatalogModel): string {
    const services = [...model.services, ...(this.policy.runtimeServices ?? [])]
      .filter(service => !this.policy.runtimeServiceExclusions?.has(service.key))
      .sort((left, right) => left.key.localeCompare(right.key))
    return renderRuntimeApi(
      services,
      model.events,
      this.runtimeTypes(services, model.events),
      this.policy.inheritedServices,
    )
  }

  private collectEvents(): EventEntry[] {
    const entries: EventEntry[] = []
    const violations: string[] = []
    const typeLinkViolations: string[] = []
    for (const packageModel of this.face.packages) {
      for (const event of packageModel.events) {
        const parsed = parseJsDoc(event.jsDoc ?? '')
        if (parsed.deprecated) continue
        const source = pointer(event.location)
        const where = `event '${event.name}' (${source})`
        const node = this.renderer.node(event.signature)
        if (node.kind !== 'function') {
          violations.push(`${where} is not represented by a callable type.`)
          continue
        }
        if (this.face.face === 'host') {
          checkTypeLinks(where, signatureTypeNames(this.renderer, node.signature), this.policy, typeLinkViolations)
        }
        const mode = event.mode
        if (!isMode(mode)) {
          violations.push(`${where} is missing an @mode tag. Add '@mode emit|bail|waterfall|parallel|serial' to its JSDoc (see AGENTS.md).`)
        }
        const last = node.signature.parameters.at(-1)
        const hasNext = last?.name === 'next'
        if (isMode(mode) && hasNext && mode !== 'waterfall') {
          violations.push(`${where} has a trailing 'next' parameter (structurally a waterfall) but is tagged '@mode ${mode}'. Fix the tag or the signature.`)
        }
        if (isMode(mode) && !hasNext && mode === 'waterfall') {
          violations.push(`${where} is tagged '@mode waterfall' but has no trailing 'next' parameter. A waterfall delegates via next().`)
        }
        if (parsed.doc === '') {
          violations.push(`${where} has no description prose. Say what happened / what a listener may do, above the block tags.`)
        }
        checkParams(
          where,
          'event',
          node.signature.parameters,
          parsed.params,
          parameter => parameter.receiver || (hasNext && parameter === last),
          violations,
        )
        if (isMode(mode)) {
          entries.push({
            name: event.name,
            scope: event.name.split('/')[0] ?? event.name,
            signature: event.text,
            jsDoc: event.jsDoc ?? '',
            mode,
            doc: parsed.doc,
            source,
          })
        }
      }
    }
    reportViolations('gen-cordis-catalog', violations)
    reportTypeLinkViolations('gen-cordis-catalog', typeLinkViolations)
    return entries
  }

  /**
   * 本投影描述的 service，每个 `ctx.<key>` 一个：其 Context 合并位于包 `src`
   * 之下一层、且其声明属于同一个包的那些。
   *
   * 接口与类一样有资格，因为一个接口类型的键（`lsp: LspService`）将其 Service
   * 定义——按仓库约定，还有其成员文档——放在接口上；强制要求类会把一个真正
   * 可注入的 service 从每个目录中丢掉。声明可以位于包的任何文件（`types.ts`
   * 是通常的归宿），而来自另一个包的声明不属于本包要记录的对外表面。
   *
   * 一个键在多个包之间可能同时拥有两类候选：`ctx.typert` 由 `type-meta` 中的
   * 可合并扩展接口类型化，并由 `registry` 中的类实现。类胜出——它携带文档、
   * 也是调用方遇到的对象——而先挑选再校验，正是让被丢弃候选的缺失 JSDoc 不会
   * 使门禁失败的原因。
   */
  private renderableServices(): ServiceModel[] {
    const chosen = new Map<string, ServiceModel>()
    for (const packageModel of this.face.packages) {
      for (const service of packageModel.services) {
        const declaration = this.renderer.declaration(service.symbol)
        const owner = /^packages\/[^/]+\/[^/]+\/src\//.exec(service.location.file)?.[0]
        if ((declaration.kind !== 'class' && declaration.kind !== 'interface')
          || owner === undefined
          || (this.face.face === 'host'
            ? !/^packages\/[^/]+\/[^/]+\/src\/[^/]+\.ts$/.test(service.location.file)
            : !/^packages\/[^/]+\/[^/]+\/src\/client\/.+\.tsx?$/.test(service.location.file))
          || !declaration.location.file.startsWith(owner)) continue
        const current = chosen.get(service.key)
        if (current !== undefined && this.renderer.declaration(current.symbol).kind === 'class') continue
        chosen.set(service.key, service)
      }
    }
    return [...chosen.values()]
  }

  private collectServices(): ServiceEntry[] {
    const entries: ServiceEntry[] = []
    const violations: string[] = []
    const typeLinkViolations: string[] = []
    for (const service of this.renderableServices()) {
      const declaration = this.renderer.declaration(service.symbol)
      const parsedDeclaration = parseJsDoc(declaration.jsDoc ?? '')
      if (parsedDeclaration.deprecated) continue
      const doc = parsedDeclaration.doc
      const source = pointer(declaration.location)
      if (doc === '') {
        violations.push(`service ctx.${service.key} (${source}): ${declaration.kind} ${declaration.name} has no JSDoc.`)
      }
      const methods: ServiceMethodEntry[] = []
      for (const memberId of service.members) {
        const member = this.renderer.member(memberId)
        if (member.name.startsWith('[')) continue
        const parsed = parseJsDoc(member.jsDoc ?? '')
        if (parsed.deprecated) continue
        if (member.kind === 'property') {
          if (member.jsDoc === undefined) continue
          methods.push({ kind: 'property', signature: member.text, jsDoc: member.jsDoc })
          continue
        }
        if (member.kind !== 'method') continue
        const where = `service method ctx.${service.key}.${member.name} (${pointer(member.location)})`
        if (this.face.face === 'host') {
          checkTypeLinks(where, signatureTypeNames(this.renderer, member.signature), this.policy, typeLinkViolations)
        }
        methods.push({ kind: 'method', signature: member.text, jsDoc: member.jsDoc ?? '' })
        if (member.jsDoc === undefined) {
          violations.push(`${where} has no JSDoc.`)
          continue
        }
        if (parsed.doc === '') violations.push(`${where} has no description prose above its block tags.`)
        checkParams(where, 'service', member.signature.parameters, parsed.params,
          parameter => parameter.receiver, violations)
        checkReturns(where, member.signature, parsed.returns, this.renderer, violations)
      }
      entries.push({
        key: service.key,
        type: declaration.name,
        abstract: declaration.abstract,
        doc,
        methods,
        source,
      })
    }
    reportViolations('gen-cordis-catalog', violations)
    reportTypeLinkViolations('gen-cordis-catalog', typeLinkViolations)
    return entries.sort((left, right) => left.key.localeCompare(right.key))
  }

  private runtimeTypes(
    services: readonly ServiceEntry[],
    events: readonly EventEntry[],
  ): { name: string; declaration: string }[] {
    const declarations = new Map<string, string>()
    const ambiguous = new Set<string>()
    const maxDeclarationChars = this.policy.runtimeDeclarationMaxChars ?? DEFAULT_MAX_DECL_CHARS
    for (const declaration of this.sourceDeclarations) {
      if (declaration.face !== this.face.face
        || (!/^packages\/[^/]+\/[^/]+\/src\/.+\.tsx?$/.test(declaration.location.file)
          && !(declaration.kind === 'enum' && /^vendor\/[^/]+\/src\/.+\.ts$/.test(declaration.location.file)))) continue
      if (declarations.has(declaration.name)) {
        ambiguous.add(declaration.name)
        continue
      }
      declarations.set(
        declaration.name,
        declaration.text.length > maxDeclarationChars
          ? `${declaration.text.slice(0, maxDeclarationChars)} /* …truncated — full shape in source */`
          : declaration.text,
      )
    }
    for (const name of ambiguous) declarations.delete(name)
    return referencedTypes([
      ...services.flatMap(service => service.methods.map(method => method.signature)),
      ...events.map(event => event.signature),
    ], declarations)
  }
}

/**
 * 分析 host 工程一次，并同时返回模型与其投影。
 * @param scanRoot - 包含 `tsconfig.host.json` 的 workspace 根。
 * @param policy - 调用方拥有的类型分类与继承 Cordis 数据。
 * @param targetFace - 要投影的 Host 或 Client Typert 端。
 * @returns 配置好的投影器与其已校验的目录模型。
 */
export function projectCordisCatalog(scanRoot: string, policy: CordisCatalogPolicy, targetFace: TypertFace = 'host'): {
  readonly projector: CordisCatalogProjector
  readonly model: CordisCatalogModel
} {
  const caches = new WorkspaceCaches()
  const discovery = new WorkspaceAnalyzer({
    root: scanRoot,
    faces: [targetFace],
    checkDiagnostics: false,
    caches,
  }).discoverPackages()
  const packages = discovery.filter(candidate => candidate.faces.includes(targetFace))
    .map(candidate => candidate.package)
  const workspace = new WorkspaceAnalyzer({
    root: scanRoot,
    faces: [targetFace],
    packages,
    checkDiagnostics: false,
    caches,
  }).analyzeInBatches()
  const face = workspace.faces.find(candidate => candidate.face === targetFace)
  if (face === undefined) throw new Error(`gen-cordis-catalog: Typert produced no ${targetFace} face`)
  const sourceDeclarations = new WorkspaceAnalyzer({
    root: scanRoot,
    faces: [targetFace],
    checkDiagnostics: false,
    caches,
  }).indexSourceDeclarations()
  const projector = new CordisCatalogProjector(face, sourceDeclarations, policy)
  return { projector, model: projector.project() }
}

/**
 * 为关系文档消费者收集所有被建模的事件。
 * @param scanRoot - 包含 `tsconfig.host.json` 的 workspace 根。
 * @param policy - 调用方拥有的 Cordis 目录策略。
 * @returns 所有已校验的事件条目。
 */
export function collectEvents(scanRoot: string, policy: CordisCatalogPolicy): EventEntry[] {
  return [...projectCordisCatalog(scanRoot, policy).model.events]
}

/**
 * 为关系文档消费者收集所有被建模的 service。
 * @param scanRoot - 包含 `tsconfig.host.json` 的 workspace 根。
 * @param policy - 调用方拥有的 Cordis 目录策略。
 * @returns 所有已校验的 service 条目。
 */
export function collectServices(scanRoot: string, policy: CordisCatalogPolicy): ServiceEntry[] {
  return [...projectCordisCatalog(scanRoot, policy).model.services]
}

interface ParsedJsDoc {
  readonly doc: string
  readonly params: ReadonlyMap<string, string>
  readonly returns: string | null
  readonly throws: readonly string[]
  readonly deprecated: boolean
}

function parseJsDoc(raw: string): ParsedJsDoc {
  const lines = raw
    .replace(/^\/\*\*/, '')
    .replace(/\*\/$/, '')
    .split('\n')
    .map(line => line.replace(/^\s*\*?\s?/, '').replace(/\s+$/, ''))
  const blocks: string[] = []
  let paragraph: string[] = []
  let list: string[] = []
  let item: string[] = []
  let inTags = false
  const join = (parts: readonly string[]): string => parts.join(' ').replace(/\s+/g, ' ').trim()
  const flushItem = (): void => {
    if (item.length > 0) list.push(join(item))
    item = []
  }
  const flushList = (): void => {
    flushItem()
    if (list.length > 0) blocks.push(list.join('\n'))
    list = []
  }
  const flushParagraph = (): void => {
    flushList()
    if (paragraph.length > 0) blocks.push(join(paragraph))
    paragraph = []
  }
  for (const line of lines) {
    const tagLine = line.trimStart()
    if (tagLine.startsWith('@')) {
      flushParagraph()
      inTags = true
      continue
    }
    if (inTags) continue
    if (line.trim() === '') {
      flushParagraph()
      continue
    }
    if (/^-\s+/.test(line)) {
      flushItem()
      if (paragraph.length > 0) {
        blocks.push(join(paragraph))
        paragraph = []
      }
      item.push(line)
      continue
    }
    if (item.length > 0) item.push(line)
    else paragraph.push(line)
  }
  flushParagraph()

  const params = new Map<string, string>()
  let returns: string | null = null
  const throws: string[] = []
  let deprecated = false
  let sink: ((text: string) => void) | undefined
  for (const line of lines) {
    if (/^@deprecated(?:\s|$)/.test(line)) {
      deprecated = true
      sink = undefined
      continue
    }
    const param = /^@param\s+(\[?[\w$]+\]?)\s*(?:[-—–]\s*)?(.*)$/.exec(line)
    if (param !== null) {
      const name = (param[1] ?? '').replace(/^\[|\]$/g, '')
      let value = param[2] ?? ''
      params.set(name, value)
      sink = (text) => {
        value = value === '' ? text : `${value} ${text}`
        params.set(name, value)
      }
      continue
    }
    const returnsTag = /^@returns?(?:\s+[-—–]?\s*(.*))?$/.exec(line)
    if (returnsTag !== null) {
      let value = returnsTag[1] ?? ''
      returns = value
      sink = (text) => {
        value = value === '' ? text : `${value} ${text}`
        returns = value
      }
      continue
    }
    const throwsTag = /^@throws?(?:\s+[-—–]?\s*(.*))?$/.exec(line)
    if (throwsTag !== null) {
      let value = throwsTag[1] ?? ''
      throws.push(value)
      const index = throws.length - 1
      sink = (text) => {
        value = value === '' ? text : `${value} ${text}`
        throws[index] = value
      }
      continue
    }
    if (line.startsWith('@') || line.trim() === '') sink = undefined
    else sink?.(line.trim())
  }
  return {
    doc: blocks.join('\n\n').replace(/\{@link\s+([^}]+)\}/g, '$1').trim(),
    params,
    returns,
    throws,
    deprecated,
  }
}

function checkParams(
  where: string,
  apiKind: string,
  parameters: readonly ParameterModel[],
  tags: ReadonlyMap<string, string>,
  isExempt: (parameter: ParameterModel) => boolean,
  violations: string[],
): void {
  for (const parameter of parameters) {
    if (parameter.binding !== 'identifier') {
      violations.push(`${where}: parameter '${parameter.name}' is a binding pattern; the ${apiKind} API needs simple identifier parameters so @param can name them.`)
      continue
    }
    if (isExempt(parameter)) continue
    const description = tags.get(parameter.name)
    if (description === undefined) violations.push(`${where} is missing @param ${parameter.name}.`)
    else if (description.trim() === '') violations.push(`${where}: @param ${parameter.name} has an empty description.`)
  }
  for (const tag of tags.keys()) {
    if (!parameters.some(parameter => parameter.binding === 'identifier' && parameter.name === tag)) {
      violations.push(`${where}: @param ${tag} does not match any parameter (stale tag?).`)
    }
  }
}

function checkReturns(
  where: string,
  signature: SignatureModel,
  returns: string | null,
  renderer: TypeGraphRenderer,
  violations: string[],
): void {
  const type = renderer.renderType(signature.returns)
  if (type === 'void' || type === 'Promise<void>') return
  if (returns === null) violations.push(`${where} is missing @returns (return type: ${type}).`)
  else if (returns.trim() === '') violations.push(`${where}: @returns has an empty description.`)
}

function reportViolations(gate: string, violations: readonly string[]): void {
  if (violations.length === 0) return
  throw new Error(
    `${gate}: ${String(violations.length)} JSDoc completeness violation(s) (see AGENTS.md):\n`
    + violations.map(violation => `  ${violation}`).join('\n'),
  )
}

function pointer(location: SourceLocation): string {
  return `${location.file}:${String(location.line)}`
}

function isMode(mode: string | undefined): mode is Mode {
  return mode === 'emit' || mode === 'bail' || mode === 'waterfall' || mode === 'parallel' || mode === 'serial'
}

function signatureTypeNames(renderer: TypeGraphRenderer, signature: SignatureModel): string[] {
  const names = new Set<string>()
  const visited = new Set<TypeNodeId>()
  const visitSignature = (current: SignatureModel): void => {
    for (const parameter of current.typeParameters) {
      if (parameter.constraint !== undefined) visit(parameter.constraint)
      if (parameter.default !== undefined) visit(parameter.default)
    }
    for (const parameter of current.parameters) visit(parameter.type)
    visit(current.returns)
  }
  const visitMember = (member: MemberModel): void => {
    if (member.kind === 'property') visit(member.type)
    else visitSignature(member.signature)
  }
  const visit = (id: TypeNodeId): void => {
    if (visited.has(id)) return
    visited.add(id)
    const node = renderer.node(id)
    if (node.kind === 'reference' && node.target.kind !== 'type-parameter') names.add(node.name)
    if (node.kind === 'type-query') names.add(node.expression)
    for (const child of childTypeNodeIds(node)) visit(child)
    if (node.kind === 'object') for (const member of node.members) visitMember(member)
    if (node.kind === 'function' || node.kind === 'constructor') visitSignature(node.signature)
  }
  visitSignature(signature)
  return [...names].sort()
}

/** 长于此长度的声明会渲染为截断的桩。 */
const DEFAULT_MAX_DECL_CHARS = 1_500

/** 将一个值渲染为带单引号的 TypeScript 字面量。 */
function quote(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n')}'`
}

/** 渲染一个紧凑的 TypeScript 字符串数组字面量。 */
function quoteList(values: readonly string[]): string {
  return `[${values.map(quote).join(', ')}]`
}

/** 将结构化的参数文档渲染为紧凑的 TypeScript 字面量。 */
function renderParameters(parameters: ReadonlyMap<string, string>): string {
  const values = [...parameters].map(([name, description]) => (
    `{ name: ${quote(name)}, description: ${quote(description)} }`
  ))
  return `[${values.join(', ')}]`
}

/** 解析并排序由种子文本引用的、词边界限定的传递类型闭包。 */
function referencedTypes(
  seeds: readonly string[],
  declarations: ReadonlyMap<string, string>,
): { name: string; declaration: string }[] {
  const included = new Map<string, string>()
  let frontier = [...seeds]
  while (frontier.length > 0) {
    const next: string[] = []
    for (const [name, declaration] of declarations) {
      if (included.has(name)) continue
      const pattern = new RegExp(`\\b${name}\\b`)
      if (frontier.some(text => pattern.test(text))) {
        included.set(name, declaration)
        next.push(declaration)
      }
    }
    frontier = next
  }
  return [...included]
    .map(([name, declaration]) => ({ name, declaration }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

function firstSentence(doc: string): string {
  const line = doc.split('\n', 1)[0] ?? ''
  const match = /^(.*?[.!?])(?:\s|$)/.exec(line)
  return (match?.[1] ?? line).trim()
}

/** 渲染字节兼容的、面向模型的 API 目录。 */
function renderRuntimeApi(
  services: readonly ServiceEntry[],
  events: readonly EventEntry[],
  types: readonly { name: string; declaration: string }[],
  inheritedServices: readonly InheritedEntry[],
): string {
  const lines: string[] = [
    '/**',
    ' * Generated by scripts/gen-cordis-api.ts — do not edit by hand; run',
    ' * `pnpm run gen-cordis-api` to regenerate (freshness-gated by',
    ' * `pnpm run verify-cordis-api` in doc-sync).',
    ' *',
    ' * The machine-readable cordis API catalog `cordis_inspect` serves to the',
    ' * model: harness services (summary + structured public method contracts),',
    ' * harness events (mode + structured listener contracts), and the inherited `ctx` API. Produced by',
    ' * the same AST walk as docs/cordis-catalog, so this data and the rendered',
    ' * docs cannot diverge.',
    ' *',
    ' * @module @deepseek-ai/dsh-tool-cordis/api-catalog',
    ' */',
    '',
    '/* jscpd:ignore-start */',
    '/** One named parameter in a Service method or Event listener. */',
    'export interface ApiParameter {',
    '  /** Parameter name from the exact signature. */',
    '  name: string',
    '  /** Source-owned parameter contract. */',
    '  description: string',
    '}',
    '',
    '/** One public service member and its source-owned contract. */',
    'export interface ServiceApiMethod {',
    '  /** Public method signature with its body stripped. */',
    '  signature: string',
    '  /** Method purpose and behavior. */',
    '  description: string',
    '  /** Named parameters in signature order. */',
    '  parameters: readonly ApiParameter[]',
    '  /** Non-void result contract when documented. */',
    '  returns?: string',
    '  /** Documented failure conditions. */',
    '  throws?: readonly string[]',
    '}',
    '',
    '/** One harness `ctx.<key>` service and its public methods. */',
    'export interface ServiceApiEntry {',
    '  /** The `ctx.<key>` name, e.g. `tools`. */',
    '  key: string',
    '  /** First sentence of the service class JSDoc. */',
    '  summary: string',
    '  /** Complete service description. */',
    '  description: string',
    '  /** Public methods, bodies stripped, in source order. */',
    '  methods: readonly ServiceApiMethod[]',
    '}',
    '',
    '/** One harness event: its dispatch mode, exact signature, and listener contract. */',
    'export interface EventApiEntry {',
    '  /** The scoped event name, e.g. `agent/status`. */',
    '  name: string',
    '  /** The dispatch mode from the declaration\'s `@mode` tag. */',
    '  mode: string',
    '  /** The exact listener signature, whitespace-normalized. */',
    '  signature: string',
    '  /** First sentence of the event JSDoc. */',
    '  summary: string',
    '  /** Complete event description. */',
    '  description: string',
    '  /** Named listener parameters in signature order. */',
    '  parameters: readonly ApiParameter[]',
    '}',
    '',
    '/** One inherited (cordis core + loader/hmr/timer) `ctx` member group with its summary. */',
    'export interface InheritedApiEntry {',
    '  /** The `ctx` member name(s), e.g. `ctx.on / ctx.once`. */',
    '  name: string',
    '  /** One-line summary of what the member does. */',
    '  summary: string',
    '}',
    '',
    '/** One named type declaration referenced by a Service or Event signature. */',
    'export interface TypeApiEntry {',
    '  /** The exported type/interface name, e.g. `ShellRunResult`. */',
    '  name: string',
    '  /** The full declaration text, comments stripped. */',
    '  declaration: string',
    '}',
    '',
    '/** Every harness `ctx.<key>` service, sorted by key. */',
    'export const SERVICE_API: readonly ServiceApiEntry[] = [',
  ]
  for (const service of services) {
    lines.push('  {')
    lines.push(`    key: ${quote(service.key)},`)
    lines.push(`    summary: ${quote(firstSentence(service.doc))},`)
    lines.push(`    description: ${quote(service.doc)},`)
    if (service.methods.length === 0) {
      lines.push('    methods: [],')
    } else {
      lines.push('    methods: [')
      for (const method of service.methods) {
        const contract = parseJsDoc(method.jsDoc)
        lines.push('      {')
        lines.push(`        signature: ${quote(method.signature)},`)
        lines.push(`        description: ${quote(contract.doc)},`)
        lines.push(`        parameters: ${renderParameters(contract.params)},`)
        if (contract.returns !== null) lines.push(`        returns: ${quote(contract.returns)},`)
        if (contract.throws.length > 0) lines.push(`        throws: ${quoteList(contract.throws)},`)
        lines.push('      },')
      }
      lines.push('    ],')
    }
    lines.push('  },')
  }
  lines.push(
    ']',
    '',
    '/** Every harness event, sorted by name. */',
    'export const EVENT_API: readonly EventApiEntry[] = [',
  )
  for (const event of [...events].sort((left, right) => left.name.localeCompare(right.name))) {
    const contract = parseJsDoc(event.jsDoc)
    lines.push('  {')
    lines.push(`    name: ${quote(event.name)},`)
    lines.push(`    mode: ${quote(event.mode)},`)
    lines.push(`    signature: ${quote(event.signature)},`)
    lines.push(`    summary: ${quote(firstSentence(event.doc))},`)
    lines.push(`    description: ${quote(event.doc)},`)
    lines.push(`    parameters: ${renderParameters(contract.params)},`)
    lines.push('  },')
  }
  lines.push(
    ']',
    '',
    '/** Shapes of every exported type the Service and Event signatures reference (transitively), sorted by name. */',
    'export const TYPE_API: readonly TypeApiEntry[] = [',
  )
  for (const type of types) {
    lines.push('  {')
    lines.push(`    name: ${quote(type.name)},`)
    lines.push(`    declaration: ${quote(type.declaration)},`)
    lines.push('  },')
  }
  lines.push(
    ']',
    '',
    '/** The inherited `ctx` API (cordis core + loader/hmr/timer), in curated order. */',
    'export const INHERITED_CTX_API: readonly InheritedApiEntry[] = [',
  )
  for (const inherited of inheritedServices) {
    lines.push(`  { name: ${quote(inherited.name)}, summary: ${quote(inherited.summary)} },`)
  }
  lines.push(
    ']',
    '',
    'function referencedTypeClosure(seeds: readonly string[]): TypeApiEntry[] {',
    '  const included = new Set<string>()',
    '  let frontier = [...seeds]',
    '  while (frontier.length > 0) {',
    '    const next: string[] = []',
    '    for (const entry of TYPE_API) {',
    '      if (included.has(entry.name)) continue',
    '      const pattern = new RegExp(`\\\\b${entry.name}\\\\b`)',
    '      if (!frontier.some(text => pattern.test(text))) continue',
    '      included.add(entry.name)',
    '      next.push(entry.declaration)',
    '    }',
    '    frontier = next',
    '  }',
    '  return TYPE_API.filter(entry => included.has(entry.name))',
    '}',
    '',
    'function contextProperty(key: string): string {',
    '  return /^[A-Za-z_$][\\w$]*$/.test(key) ? `ctx.${key}` : `ctx[${JSON.stringify(key)}]`',
    '}',
    '',
    '/**',
    ' * Project the Service Catalog as a compact directory or one exact coding contract.',
    ' * @param key - exact Service key; omit it to list all Services and method signatures.',
    ' * @param services - platform-specific visible Service entries.',
    ' * @returns compact navigation data or one detailed Service with its referenced type closure.',
    ' */',
    'export function queryServiceApi(key?: string, services: readonly ServiceApiEntry[] = SERVICE_API): object {',
    '  if (key === undefined) {',
    '    return {',
    "      mode: 'catalog',",
    '      services: services.map(service => ({',
    '        key: service.key,',
    '        description: service.summary,',
    '        methods: service.methods.map(method => ({ signature: method.signature })),',
    '      })),',
    '    }',
    '  }',
    '  const service = services.find(candidate => candidate.key === key)',
    '  if (service === undefined) throw new Error(`no catalogued Service named "${key}"`)',
    '  return {',
    "    mode: 'service',",
    '    service: {',
    '      key: service.key,',
    '      description: service.description,',
    '      access: {',
    '        optional: { expression: `ctx.get(${JSON.stringify(service.key)})`, requiresUndefinedCheck: true },',
    '        hardDependency: { inject: [service.key], expression: contextProperty(service.key) },',
    '      },',
    '      methods: service.methods,',
    '    },',
    '    referencedTypes: referencedTypeClosure(service.methods.map(method => method.signature)),',
    '  }',
    '}',
    '',
    '/**',
    ' * Project the Event Catalog as a compact directory or one exact listener contract.',
    ' * @param name - exact Event name; omit it to list all Events and listener signatures.',
    ' * @param events - platform-specific visible Event entries.',
    ' * @returns compact navigation data or one detailed Event with its referenced type closure.',
    ' */',
    'export function queryEventApi(name?: string, events: readonly EventApiEntry[] = EVENT_API): object {',
    '  if (name === undefined) {',
    '    return {',
    "      mode: 'catalog',",
    '      events: events.map(event => ({',
    '        name: event.name,',
    '        description: event.summary,',
    '        mode: event.mode,',
    '        signature: event.signature,',
    '      })),',
    '    }',
    '  }',
    '  const event = events.find(candidate => candidate.name === name)',
    '  if (event === undefined) throw new Error(`no catalogued Event named "${name}"`)',
    '  return {',
    "    mode: 'event',",
    '    event: {',
    '      name: event.name,',
    '      description: event.description,',
    '      mode: event.mode,',
    '      signature: event.signature,',
    '      parameters: event.parameters,',
    '    },',
    '    referencedTypes: referencedTypeClosure([event.signature]),',
    '  }',
    '}',
    '/* jscpd:ignore-end */',
    '',
  )
  return lines.join('\n')
}
/** 区域起始分隔符；被注入的内容位于这对标记之间，而页面拥有其之外的一切。 */
export const REGION_BEGIN = '<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->'
/** 与 {@link REGION_BEGIN} 相匹配的区域结束分隔符。 */
export const REGION_END = '<!-- END GENERATED cordis-surface -->'

/**
 * 渲染相对于某个子系统页、某个签名的跨链接 “Types:” 行，若无适用者则为 ''。
 * 一个主页面就是正在渲染页面的类型，会链接成读者已经处在的、无片段的自链接，
 * 因此改为丢弃它。
 */
function typeLinks(signature: string, onPage: string, linkedTypePages: Readonly<Record<string, string>>): string {
  const seen = new Set<string>()
  for (const name of Object.keys(linkedTypePages)) {
    if (new RegExp(`\\b${name}\\b`).test(signature)) seen.add(name)
  }
  const links = [...seen].sort()
    .filter(name => linkedTypePages[name] !== onPage)
    .map(name => `[${name}](${linkedTypePages[name]})`)
  if (links.length === 0) return ''
  return `Types: ${links.join(' · ')}`
}

/**
 * GitHub 的标题 slug 算法（小写；除字母、数字、空格、连字符外全部丢弃；空格变为连字符）。
 * 区域标题带有反引号与长破折号，VitePress 对它们的 slug 化方式不同，因此每个生成的
 * 标题前都带有一个显式 `<a id>`，承载此 slug——即历史上的扁平目录锚点——使
 * `#ctx<key>--<class>` 片段在 GitHub 与已发布站点上解析一致。
 */
function githubSlug(heading: string): string {
  return heading.toLowerCase().replace(/[^\p{L}\p{N} -]/gu, '').replaceAll(' ', '-')
}

/** 在某个生成标题之前发出的、显式锚点行。 */
function anchorFor(headingText: string): string[] {
  return [`<a id="${githubSlug(headingText)}"></a>`, '']
}

/** 将一个子系统 `file:line` 源指针渲染为仅指向文件的链接。 */
function sourceLink(source: string): string {
  const file = source.split(':')[0]
  return `[\`${file}\`](../../${file})`
}

/** 将一个 harness 事件条目渲染到其所属页面，嵌套在其作用域标题之下。 */
function renderEvent(e: EventEntry, onPage: string, linkedTypePages: Readonly<Record<string, string>>): string[] {
  const out = [...anchorFor(`${e.name} — ${e.mode}`), `#### \`${e.name}\` — ${e.mode}`, '']
  if (e.doc) out.push(e.doc, '')
  out.push('```' + FENCE, e.jsDoc, e.signature, '```', '')
  const links = typeLinks(e.signature, onPage, linkedTypePages)
  if (links) out.push(links, '')
  out.push(`Source: ${sourceLink(e.source)}`, '')
  return out
}

/** 将一个 harness service 条目渲染到其所属页面。 */
function renderService(s: ServiceEntry, onPage: string, linkedTypePages: Readonly<Record<string, string>>): string[] {
  const kind = s.abstract ? ' (abstract seam)' : ''
  const out = [...anchorFor(`ctx.${s.key} — ${s.type}${kind}`), `### \`ctx.${s.key}\` — \`${s.type}\`${kind}`, '']
  if (s.doc) out.push(s.doc, '')
  const methods = s.methods.filter(member => member.kind !== 'property')
  if (methods.length) {
    const declarations = methods.flatMap((method, index) => [
      ...(index > 0 ? [''] : []),
      method.jsDoc,
      method.signature,
    ])
    out.push('```' + FENCE, ...declarations, '```', '')
    const links = typeLinks(methods.map(method => method.signature).join('\n'), onPage, linkedTypePages)
    if (links) out.push(links, '')
  }
  out.push(`Source: ${sourceLink(s.source)}`, '')
  return out
}

/** 共享的生成文件横幅注释。 */
const BANNER = [
  '<!-- Generated by scripts/gen-cordis-catalog.ts — do not edit by hand.',
  '     Run `pnpm run gen-cordis-catalog` to regenerate. -->',
  '',
]

/** 共享的 GENERATED + 新鲜度门禁 + 围栏提示段落。 */
const GATE_NOTICE = 'This file is GENERATED from source (`scripts/gen-cordis-catalog.ts`) and verified fresh by `pnpm run verify-cordis-catalog` (part of `doc-sync`) — do not edit it by hand. Signature blocks use a `ts cordis-catalog` fence and include the original source JSDoc immediately before each event or service method. doc-typecheck skips these bare declaration fragments; type names in a signature link to the page that documents them.'

/**
 * 渲染某个页面的生成 Cordis API 区域：映射到该页的 service，然后是映射到它的事件
 * 作用域，包含标记。给定已排序的输入，纯函数且确定；相同的字节落在配对的两侧。
 * @param page - 所属的 `docs/subsystems/` 页基名，例如 `core.md`。
 * @param services - 映射到本页的已校验 service。
 * @param events - 作用域映射到本页的已校验事件。
 * @param policy - 由调用方提供的类型链接。
 * @returns 完整的、标记定界的区域文本。
 */
export function renderPageRegion(page: string, services: ServiceEntry[], events: EventEntry[], policy: CordisCatalogPolicy): string {
  const lines: string[] = [
    REGION_BEGIN,
    '',
    '<a id="cordis-surface"></a>',
    '',
    '## Cordis API',
    '',
    'Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).',
    '',
  ]
  for (const s of services) lines.push(...renderService(s, page, policy.linkedTypePages))
  const scopes = [...new Set(events.map(e => e.scope))].sort()
  for (const scope of scopes) {
    lines.push(...anchorFor(`${scope}/* events`), `### \`${scope}/*\` events`, '')
    for (const e of events.filter(x => x.scope === scope).sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(...renderEvent(e, page, policy.linkedTypePages))
    }
  }
  while (lines.at(-1) === '') lines.pop()
  lines.push(REGION_END)
  return lines.join('\n')
}

/**
 * 将继承（固定 vendor）层渲染为它自己的生成页面。
 * @param policy - 由调用方提供的继承事件与 service。
 * @returns 完整的生成 Markdown 文档。
 */
export function renderInheritedPage(policy: CordisCatalogPolicy): string {
  const lines: string[] = [
    ...BANNER,
    '# Inherited Cordis API',
    '',
    'The framework `ctx` members and events every plugin sees beyond the harness tier — pinned vendor source ([vendoring policy](../../vendor/README.md)), summarized tersely so the harness pages stay focused on repository-owned vocabulary. Detailed Context, Fiber, Registry, and Service APIs are generated in [context.md](context.md), [fiber.md](fiber.md), [registry.md](registry.md), and [service.md](service.md); the event-dispatch methods in [events.md](events.md).',
    '',
    GATE_NOTICE,
    '',
    '## Inherited `ctx` members (cordis core + loader/hmr/timer)',
    '',
  ]
  for (const s of policy.inheritedServices) {
    lines.push(`- \`${s.name}\` — ${s.summary} ([\`${s.source}\`](../../${s.source.split(':')[0]}))`)
  }
  lines.push(
    '',
    '## Inherited events (cordis core + loader/hmr/timer)',
    '',
  )
  for (const e of policy.inheritedEvents) {
    lines.push(`- \`${e.name}\` — ${e.summary} ([\`${e.source}\`](../../${e.source.split(':')[0]}))`)
  }
  lines.push('')
  return lines.join('\n')
}
