/**
 * 有序系统分区、动态上下文、工具 schema 和提示词变量的注册表。
 *
 * @module @deepseek-ai/dsh-system-prompt
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AnonymousEntries, NamedEntries, ScopedLayers, scopeTarget } from '@deepseek-ai/dsh-scope'
import type { ScopeKey, ScopeLayer, Scoped } from '@deepseek-ai/dsh-scope'
import type { ContextSnapshotSection, ToolSchema } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/cordis' {
  interface Context {
    systemPrompt: SystemPrompt
  }

  interface Events {
    /**
     * 对已组装的分区、上下文、工具和变量进行专家级瀑布。
     * 按作用域过滤的分发（`@deepseek-ai/dsh-scope`）：作用域内的监听器
     * 只接收该作用域的组装。返回值是权威的。
     * 提供的信号只控制这次显式的组装请求，不得保留用于控制后续 turn。
     * 注册的 complete 分区在此瀑布之后恢复，因此监听器无法添加或替换
     * 该作用域的系统提示词。
     * @param assembly - 从注册的提供方构建的可变组装。
     * @param context - 调用方每次组装的上下文。
     * @mode waterfall
     */
    'system-prompt/assemble'(this: Scoped<SystemPrompt>, assembly: PromptAssembly, context: AssembleContext, next: () => Promise<PromptAssembly>): Promise<PromptAssembly>
    /**
     * 在任何提示词提供方变化时发出。此注册表通知不过滤，
     * 因为全局变化影响每个作用域。
     * @mode emit
     */
    'system-prompt/change'(): void
  }
}

/** 单次提示词组装的可合并扩展上下文。 */
export interface AssembleContext {
  /**
   * 其提供方和瀑布监听器参与的作用域。缺席时，
   * 只有全局提供方和无主体的监听器参与。
   */
  scope?: ScopeKey
  /** 请求此组装的 turn 的显式控制信号（如有）。 */
  signal?: AbortSignal
}

/** 系统提示词的一个贡献分区（注册表输入）。 */
export interface PromptSection {
  /** 唯一名称——重复注册会抛出（见 {@link SystemPrompt.section}）。 */
  readonly name: string
  /**
   * 分区按升序拼接。相同顺序时按代码单元名称顺序。
   */
  readonly order: number
  /**
   * 静态文本，或在每次组装时以该次组装的 {@link AssembleContext}
   * 求值的提供方。文本可以引用 `{{variable}}`——除非 `interpolate` 为 false，
   * 它们稍后由 {@link renderPrompt} 插值。
   */
  readonly text: string | ((context: AssembleContext) => string)
  /** 是否插值提示词变量。默认为 true；false 保留字面文本。 */
  readonly interpolate?: boolean
  /**
   * 将此贡献视为完整的系统提示词。组装仍会运行协作瀑布，
   * 使工具、上下文和变量得以解析，然后恢复这个确切分区
   * 作为唯一的提示词分区。多个生效的 complete 分区会使组装失败。
   */
  readonly complete?: boolean
}

/** 物化为持久 user 角色快照的动态模型上下文。 */
export interface PromptContext {
  /** 唯一名称——重复注册会抛出（见 {@link SystemPrompt.context}）。 */
  readonly name: string
  /** 上下文按升序拼接。 */
  readonly order: number
  /** 静态文本，或在组装和接纳刷新时求值的提供方。空文本不贡献任何内容。 */
  readonly text: string | ((context: AssembleContext) => string)
  /** 是否插值提示词变量。默认为 true；false 保留字面文本。 */
  readonly interpolate?: boolean
  /** 当可选运行时上下文被禁用时保留此操作性上下文。 */
  readonly required?: boolean
}

/** 组装的一个分区：文本已解析的 {@link PromptSection}。 */
export interface AssembledSection {
  /** 贡献分区的唯一名称。 */
  name: string
  /** 已解析（但尚未插值）的分区文本。 */
  text: string
  /** 是否插值提示词变量。默认为 true；false 保留字面文本。 */
  interpolate?: boolean
}

/** 一个已解析的动态上下文贡献。 */
export interface AssembledContext {
  /** 贡献上下文的唯一名称。 */
  name: string
  /** 变量插值之前的已解析文本。 */
  text: string
  /** 是否插值提示词变量。默认为 true；false 保留字面文本。 */
  interpolate?: boolean
}

/** 单次组装中可见的工具 schema 及其限制前名称集合。 */
export interface ToolProviderResult {
  /** 此提供方对本次组装贡献的 schema。 */
  readonly schemas: readonly ToolSchema[]
  /** 用于配置验证的限制前名称全集（默认为 `schemas` 的名称）。 */
  readonly knownNames?: readonly string[]
}

/**
 * 可合并扩展的已组装模型输入。分区和上下文在渲染前保持未插值；
 * 工具已处于规范顺序。
 */
export interface PromptAssembly {
  sections: AssembledSection[]
  contexts: AssembledContext[]
  tools: ToolSchema[]
  variables: Record<string, string | undefined>
}

const SECTION_ORDERS = {
  HARNESS_IDENTITY: -1000,
  DEPLOYMENT_PERSONA_PREFIX: 0,
  PLAN_POLICY: 500,
  TEAM_POLICY: 600,
  PTC_ONLY: 800,
  FILE_REFERENCE: 900,
  TOOL_BASH: 1000,
  TOOL_PWSH: 1010,
  TOOL_READ: 1100,
  TOOL_WRITE: 1200,
  TOOL_EDIT: 1300,
  TOOL_GLOB: 1400,
  TOOL_GREP: 1500,
  TOOL_JOBS: 1600,
  TOOL_PTY: 1700,
  TOOL_WEB_SEARCH: 2000,
  TOOL_WEB_FETCH: 2100,
  TOOL_LSP: 2200,
  TOOL_SESSION_QUERY: 2300,
  TOOL_GOAL: 2400,
  TOOL_WORKFLOW: 2600,
  TOOL_RALPH: 2700,
  TOOL_SUBAGENT: 2800,
  TOOL_REPORT: 2900,
  TOOL_COMPUTER_USE: 3000,
  MCP_SERVERS: 3100,
  TOOLS_SDK: 5000,
  DELIVERABLE_FILE_REFERENCES: 9000,
  STRUCTURED_OUTPUT: 9900,
  // 本地路径和端点跟随可复用的指令之后。
  HARNESS_SOURCE: 10000,
  WEB_SURFACE: 10100,
  DEPLOYMENT_PERSONA_SUFFIX: 10200,
} as const

/** 中央分配的提示词分区位置的名称。 */
export type PromptSectionOrderName = keyof typeof SECTION_ORDERS

const CONTEXT_ORDERS = {
  WORKING_DIRECTORY: 100,
  SANDBOX_POLICY: 110,
  APPROVAL_POLICY: 115,
  SUBAGENT_DELEGATION: 120,
  TEAM_IDENTITY: 125,
  // 进程特定的路径和端点不进入缓存的系统提示词。
  HARNESS_SOURCE: 200,
  WEB_SURFACE: 210,
} as const

/** 中央分配的运行时上下文位置的名称。 */
export type PromptContextOrderName = keyof typeof CONTEXT_ORDERS

/**
 * 部署人格前缀的分区名称。导出是因为组合可以替换此槽位——
 * agent 预设用自己的内容遮蔽部署的人格——而双方命名同一个分区
 * 正是替换生效而非重复的原因。
 */
export const PERSONA_PREFIX_SECTION = 'deployment:persona-prefix'

/** 全局与作用域贡献共享的部署人格后缀分区名称。 */
export const PERSONA_SUFFIX_SECTION = 'deployment:persona-suffix'

/** 有效变量名：它们在花括号之间的书写方式。 */
const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/

/** 扫描位置处完整的 `{{...}}` 引用组（之后验证）。 */
const GROUP_AT = /^\{\{([^{}]*)\}\}/

/** {@link Config.toolOrder} 中为未列出工具保留的标记。 */
export const TOOL_ORDER_REST = '<unlisted-tools>'

/**
 * 验证重复名称和必需的 {@link TOOL_ORDER_REST} 标记。
 * 注册名称稍后检查，因为插件尚未加载。
 */
function validateToolOrder(toolOrder: string[] | undefined): string[] | undefined {
  if (toolOrder === undefined) return undefined
  const seen = new Set<string>()
  for (const name of toolOrder) {
    if (seen.has(name)) throw new Error(`toolOrder lists "${name}" more than once`)
    seen.add(name)
  }
  if (!seen.has(TOOL_ORDER_REST)) {
    throw new Error(`toolOrder must contain the "${TOOL_ORDER_REST}" rest entry (where unlisted tools are inserted)`)
  }
  return toolOrder
}

/**
 * 应用配置的工具顺序，将未列出的工具按字典序插入
 * {@link TOOL_ORDER_REST} 处。未知的配置名称会导致失败；
 * 已知但受限的名称可以缺席。
 */
function orderTools(tools: ToolSchema[], toolOrder: string[] | undefined, knownNames: ReadonlySet<string>): ToolSchema[] {
  const reserved = tools.find(tool => tool.name === TOOL_ORDER_REST)
  if (reserved !== undefined) {
    throw new Error(`tool provider returned reserved tool name "${TOOL_ORDER_REST}" (reserved for toolOrder's rest entry)`)
  }
  if (toolOrder === undefined) return tools.sort(compareToolNames)
  const unknown = toolOrder.filter(name => name !== TOOL_ORDER_REST && !knownNames.has(name))
  if (unknown.length > 0) {
    throw new Error(`toolOrder lists unregistered tool${unknown.length > 1 ? 's' : ''} ${unknown.map(name => `"${name}"`).join(', ')}; known tools: ${[...knownNames].sort().join(', ') || '(none)'}`)
  }
  const listed = new Set(toolOrder)
  const rest = tools.filter(tool => !listed.has(tool.name)).sort(compareToolNames)
  return toolOrder.flatMap(name =>
    name === TOOL_ORDER_REST ? rest : tools.filter(tool => tool.name === name))
}

/** 码元名称比较——与区域设置无关，因此顺序在每台机器上都相同。 */
function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** 按显式位置排序提示词分区，然后确定性地按名称排序。 */
function comparePromptSections(a: PromptSection, b: PromptSection): number {
  return a.order - b.order || compareNames(a.name, b.name)
}

/** 按名称字典序排序工具 schema。 */
function compareToolNames(a: ToolSchema, b: ToolSchema): number {
  return compareNames(a.name, b.name)
}

/** 插件配置：系统提示词中部署编写的片段（契约见 {@link Config.personaPrefix}）。 */
export interface Config {
  /** 在部署人格之前包含固定的 DeepSeek Harness 身份（默认 true）。 */
  includeHarnessIdentity?: boolean
  /** 在模型历史中包含可选的运行时上下文快照（默认 true）；必需上下文仍保留。 */
  includeRuntimeContext?: boolean
  /**
   * 第一方指引之前的部署级人格前缀模板。名为 `deployment:persona-prefix`
   * 的作用域分区会遮蔽它；`{{variable}}` 引用是严格的。
   */
  personaPrefix?: string
  /**
   * 第一方指引之后的人格后缀模板。作用域内的 `deployment:persona-suffix`
   * 分区会遮蔽它；`{{variable}}` 引用是严格的。默认为空。
   */
  personaSuffix?: string
  /**
   * 面向模型的工具名称及其顺序，{@link TOOL_ORDER_REST} 恰好出现一次。
   * 无效字段在加载时失败，未知名称在组装时失败；在某个作用域中被隐藏的
   * 已知名称可以在那里缺席。省略表示字典序。
   */
  toolOrder?: string[]
}

/**
 * 插值严格的 `{{variable}}` 引用，丢弃空分区，并将其余部分
 * 用空行拼接。`interpolate: false` 的分区保留字面文本。
 * 其他分区中格式错误、未知或未定义的引用会抛出；
 * 没有任何后续 `}}` 的孤立 `{{` 是字面散文，且替换后的值
 * 不会被再次扫描。
 * @param assembly - 要渲染其分区和变量的组装。
 * @returns 渲染后的提示词，所有分区都为空时为 `''`。
 */
export function renderPrompt(assembly: PromptAssembly): string {
  return assembly.sections
    .map(section => section.interpolate === false ? section.text : interpolate(section, assembly.variables, 'section'))
    .filter(text => text.length > 0)
    .join('\n\n')
}

/**
 * 渲染完整的动态上下文快照，保留字面贡献。
 * @param assembly - 要渲染其上下文和变量的组装。
 * @returns 当前完整快照，没有活跃上下文时为 `''`。
 */
export function renderContextSnapshot(assembly: PromptAssembly): string {
  return joinContextSections(renderContextSections(assembly))
}

/**
 * 面向模型的快照文本，基于已渲染的分区列表。
 *
 * 还需要分区的调用方只渲染一次并在此拼接，
 * 使请求不会对每个上下文插值两次。
 * @param sections - 来自 {@link renderContextSections} 的分区。
 * @returns 当前完整快照，没有活跃上下文时为 `''`。
 */
export function joinContextSections(sections: readonly ContextSnapshotSection[]): string {
  const body = sections.map(section => section.text).join('\n\n')
  if (body.length === 0) return ''
  return `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${body}`
}

/**
 * 同一快照，保留为它组装自的具名贡献。
 *
 * {@link renderContextSnapshot} 为模型拼接这些内容；呈现快照的消费方
 * 用它们把每个部分归属到贡献它的子系统，而无需重新拆分拼接后的散文。
 * `interpolate: false` 的贡献保留字面文本，而不是解析提示词变量。
 * @param assembly - 要渲染其上下文和变量的组装。
 * @returns 每个渲染为非空文本的贡献上下文一条条目。
 */
export function renderContextSections(assembly: PromptAssembly): ContextSnapshotSection[] {
  return assembly.contexts
    .map(context => ({
      name: context.name,
      text: context.interpolate === false ? context.text : interpolate(context, assembly.variables, 'context'),
    }))
    .filter(section => section.text.length > 0)
}

/** 插值单个分区或上下文，并将诊断归属到其所属输入。 */
function interpolate(
  input: AssembledSection | AssembledContext,
  variables: Record<string, string | undefined>,
  kind: 'section' | 'context',
): string {
  const text = input.text
  let result = ''
  let last = 0
  for (let open = text.indexOf('{{'); open >= 0; open = text.indexOf('{{', last)) {
    const group = GROUP_AT.exec(text.slice(open))
    if (group === null) {
      // 后续存在闭合花括号使其格式错误；否则它是字面散文。
      if (text.indexOf('}}', open + 2) >= 0) {
        throw new Error(`malformed prompt variable reference at "${text.slice(open, open + 16)}…" in ${kind} "${input.name}" (references are complete simple {{name}} groups)`)
      }
      result += text.slice(last, open + 2)
      last = open + 2
      continue
    }
    // `{{}}` 产生空名称，并走格式错误引用的路径。
    const name = group[0].slice(2, -2)
    if (!VARIABLE_NAME.test(name)) {
      throw new Error(`malformed prompt variable reference "{{${name}}}" in ${kind} "${input.name}" (variable names match ${String(VARIABLE_NAME)})`)
    }
    // 不要通过 Object.prototype 解析未注册的名称。
    if (!Object.hasOwn(variables, name)) {
      const known = Object.keys(variables)
      throw new Error(`unknown prompt variable "{{${name}}}" in ${kind} "${input.name}"; registered variables: ${known.length > 0 ? known.join(', ') : '(none)'}`)
    }
    const value = variables[name]
    if (value === undefined) {
      throw new Error(`prompt variable "{{${name}}}" has no value for this assembly (${kind} "${input.name}")`)
    }
    result += text.slice(last, open) + value
    last = open + group[0].length
  }
  return result + text.slice(last)
}

/** 解析单个已注册的运行时事实，而不组装分区或工具。 */
function resolveContext(entry: PromptContext, context: AssembleContext): AssembledContext {
  return {
    name: entry.name,
    text: typeof entry.text === 'function' ? entry.text(context) : entry.text,
    ...entry.interpolate !== undefined ? { interpolate: entry.interpolate } : {},
  }
}

/** 存储在提示词层中的一个工具 schema 提供方。 */
type ToolProvider = (context: AssembleContext) => ToolProviderResult

/** 存储在提示词层中的一个提示词变量提供方。 */
type VariableProvider = (context: AssembleContext) => string | undefined

/** 单个全局或作用域层拥有的全部提示词注册。 */
class PromptLayer implements ScopeLayer {
  readonly sections: NamedEntries<PromptSection>
  readonly contexts: NamedEntries<PromptContext>
  readonly runtimeContextSuppressors = new AnonymousEntries<true>()
  readonly toolProviders = new AnonymousEntries<ToolProvider>()
  readonly variables: NamedEntries<VariableProvider>

  /**
   * 创建一个提示词层，其诊断特定于其所有权作用域。
   * @param scope - 作用域所有者，全局注册为 `undefined`。
   */
  constructor(scope: ScopeKey | undefined) {
    this.sections = new NamedEntries(name => new Error(scope === undefined
      ? `prompt section "${name}" is already registered (for a per-agent override, register through that agent's \`agent.ctx\` instead)`
      : `prompt section "${name}" is already registered in this scope`))
    this.contexts = new NamedEntries(name => new Error(scope === undefined
      ? `prompt context "${name}" is already registered (for a per-agent override, register through that agent's \`agent.ctx\` instead)`
      : `prompt context "${name}" is already registered in this scope`))
    this.variables = new NamedEntries(name => new Error(scope === undefined
      ? `prompt variable "${name}" is already registered (for a per-agent value, register through that agent's \`agent.ctx\` instead)`
      : `prompt variable "${name}" is already registered in this scope`))
  }

  /** @returns 此层是否不拥有任何提示词注册。 */
  isEmpty(): boolean {
    return this.sections.isEmpty()
      && this.contexts.isEmpty()
      && this.runtimeContextSuppressors.isEmpty()
      && this.toolProviders.isEmpty()
      && this.variables.isEmpty()
  }
}

/** 在每个模型步骤之前组装提示词输入的注册表服务。 */
export class SystemPrompt extends Service {
  static Config: z<Config> = z.object({
    includeHarnessIdentity: z.boolean().default(true),
    includeRuntimeContext: z.boolean().default(true),
    personaPrefix: z.string().default(''),
    personaSuffix: z.string().default(''),
    // 保留省略状态，因为显式的空顺序缺少 rest 标记。
    toolOrder: z.array(z.string()).default(undefined as unknown as string[]),
  })

  private readonly layers = new ScopedLayers(
    scope => new PromptLayer(scope),
    () => { this.ctx.emit('system-prompt/change') },
  )
  private readonly toolOrder: string[] | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx, 'systemPrompt')
    this.toolOrder = validateToolOrder(config.toolOrder)
    // 使 harness 拥有的开场白独立于所选的循环插件。
    if (config.includeHarnessIdentity ?? true) {
      this.section({
        name: 'harness:identity',
        order: this.getSectionOrder('HARNESS_IDENTITY'),
        text: 'You are an AI agent powered by DeepSeek Harness.',
      })
    }
    this.section({
      name: PERSONA_PREFIX_SECTION,
      order: this.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
      // 回退值收窄可选的输入类型；schema 已为其提供默认值。
      text: config.personaPrefix ?? '',
    })
    this.section({
      name: PERSONA_SUFFIX_SECTION,
      order: this.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
      text: config.personaSuffix ?? '',
    })
    if (!(config.includeRuntimeContext ?? true)) this.suppressRuntimeContext()
  }

  /**
   * 在调用上下文的作用域中注册一个有序提示词分区。作用域分区会遮蔽
   * 同名的全局分区；同一层内的重复和非有限顺序会抛出。
   * 注册和释放都会发出 `system-prompt/change`。
   * @param section - 要注册的分区。
   * @returns 确切的 Cordis effect disposer。
   */
  section(section: PromptSection): () => void {
    if (!Number.isFinite(section.order)) {
      throw new TypeError(`prompt section "${section.name}" order must be a finite number`)
    }
    return this.layers.effect(
      this.ctx,
      layer => layer.sections.insert(section.name, section),
      { label: 'systemPrompt.section()' },
    )
  }

  /**
   * 解析仓库提示词分区的中央拥有的位置。
   * @param name - 稳定的分区位置名称。
   * @returns 该分区的数值排序顺序。
   */
  getSectionOrder(name: PromptSectionOrderName): number {
    return SECTION_ORDERS[name]
  }

  /**
   * 解析仓库运行时上下文的中央拥有的位置。
   * @param name - 稳定的上下文位置名称。
   * @returns 该上下文的数值排序顺序。
   */
  getContextOrder(name: PromptContextOrderName): number {
    return CONTEXT_ORDERS[name]
  }

  /**
   * 在调用上下文的作用域中注册有序的动态上下文。作用域条目会遮蔽
   * 同名的全局条目。
   * @param context - 要注册的上下文贡献。
   * @returns 确切的 Cordis effect disposer。
   */
  context(context: PromptContext): () => void {
    if (!Number.isFinite(context.order)) {
      throw new TypeError(`prompt context "${context.name}" order must be a finite number`)
    }
    return this.layers.effect(
      this.ctx,
      layer => layer.contexts.insert(context.name, context),
      { label: 'systemPrompt.context()' },
    )
  }

  /**
   * 在调用上下文的作用域中抑制可选的动态运行时上下文贡献，
   * 而不改变拥有或实施这些事实的服务。多个抑制器仍可独立释放。
   * @returns 确切的 Cordis effect disposer。
   */
  suppressRuntimeContext(): () => void {
    return this.layers.effect(
      this.ctx,
      layer => layer.runtimeContextSuppressors.append(true),
      { label: 'systemPrompt.suppressRuntimeContext()' },
    )
  }

  /**
   * 在调用上下文的作用域中注册一个工具 schema 提供方。全局提供方和
   * 匹配的作用域提供方都会贡献；返回保留的 {@link TOOL_ORDER_REST}
   * 名称会使组装失败。
   * @param provider - 以其上下文为每次组装求值。
   * @returns 确切的 Cordis effect disposer。
   */
  tools(provider: (context: AssembleContext) => ToolProviderResult): () => void {
    return this.layers.effect(
      this.ctx,
      layer => layer.toolProviders.append(provider),
      { label: 'systemPrompt.tools()' },
    )
  }

  /**
   * 在调用上下文的作用域中注册一个提示词变量。作用域值会遮蔽全局值；
   * 无效或重复的名称会抛出。提供方可以返回 `undefined`，
   * 但之后渲染引用该值的分区会失败。
   * @param name - `[a-z][a-z0-9_]*` 引用名称。
   * @param provider - 为每次组装求值。
   * @returns 确切的 Cordis effect disposer。
   */
  variable(name: string, provider: (context: AssembleContext) => string | undefined): () => void {
    if (!VARIABLE_NAME.test(name)) {
      throw new Error(`invalid prompt variable name "${name}" (must match ${String(VARIABLE_NAME)})`)
    }
    return this.layers.effect(
      this.ctx,
      layer => layer.variables.insert(name, provider),
      { label: 'systemPrompt.variable()' },
    )
  }

  /**
   * 刷新已接纳的注册运行时事实以供请求接纳。仅由组装瀑布添加的
   * 上下文保留其已接纳的值。当前的抑制会移除可选上下文，
   * 缺失的必需注册按注册表顺序恢复。分区、工具和插值变量
   * 保留已接纳的组装；它们的提供方和瀑布不会重跑。
   * @param assembly - 此作用域和步骤的已接纳组装。
   * @param context - 相同作用域和当前插件定义的组装字段。
   * @returns 带有当前运行时上下文提供方文本的已接纳组装。
   */
  refreshContext(assembly: PromptAssembly, context: AssembleContext = {}): PromptAssembly {
    const providers = this.layers.merge(context.scope, layer => layer.contexts)
    const suppressed = !this.layers.global.runtimeContextSuppressors.isEmpty()
      || this.layers.chainLayers(context.scope).some(layer => !layer.runtimeContextSuppressors.isEmpty())
    const required = new Map([...providers].filter(([, entry]) => entry.required === true))
    const contexts: AssembledContext[] = []
    for (const accepted of assembly.contexts) {
      const provider = providers.get(accepted.name)
      required.delete(accepted.name)
      if (suppressed && provider?.required !== true) continue
      contexts.push(provider === undefined ? accepted : resolveContext(provider, context))
    }
    for (const provider of required.values()) {
      const index = contexts.findIndex((entry) => {
        const next = providers.get(entry.name)
        return next !== undefined && next.order > provider.order
      })
      contexts.splice(index < 0 ? contexts.length : index, 0, resolveContext(provider, context))
    }
    return { ...assembly, contexts }
  }

  /**
   * 组装全局与作用域提供方、分离工具参数、应用规范顺序，
   * 然后运行组装瀑布。作用域分区和变量会遮蔽全局内容。
   * 返回的瀑布值是权威的，例外是生效的 complete 分区之后
   * 会恢复为唯一的提示词分区。
   * @param context - 可选的作用域和插件定义的组装字段。
   * @returns 瀑布后并强制执行了任何 complete 提示词的组装。
   */
  // 将配置失败保持在声明的异步错误路径上。
  async assemble(context: AssembleContext = {}): Promise<PromptAssembly> {
    const scope = context.scope
    const scopeLayers = this.layers.chainLayers(scope)
    const runtimeContextSuppressed = !this.layers.global.runtimeContextSuppressors.isEmpty()
      || scopeLayers.some(layer => !layer.runtimeContextSuppressors.isEmpty())
    // 作用域变量遮蔽全局值。
    const variables: Record<string, string | undefined> = {}
    for (const [name, provider] of this.layers.global.variables.entries()) {
      variables[name] = provider(context)
    }
    // 作用域链变量，最远优先，使最近的作用域赢得名称。
    for (const layer of scopeLayers) {
      for (const [name, provider] of layer.variables.entries()) {
        variables[name] = provider(context)
      }
    }
    // 作用域分区在确定性顺序排序之前遮蔽全局分区。
    const sectionByName = this.layers.merge(scope, layer => layer.sections)
    const contextByName = this.layers.merge(scope, layer => layer.contexts)
    // 在收集可见 schema 的同时对照限制前名称验证顺序。
    const providers = [
      ...this.layers.global.toolProviders.values(),
      ...scopeLayers.flatMap(layer => [...layer.toolProviders.values()]),
    ]
    const collected: ToolSchema[] = []
    const knownNames = new Set<string>()
    for (const provider of providers) {
      const result = provider(context)
      const schemas = result.schemas.map(({ name, description, parameters, deferLoading }): ToolSchema => ({
        name,
        description,
        parameters: structuredClone(parameters),
        ...deferLoading === true ? { deferLoading } : {},
      }))
      const acceptedKnownNames = result.knownNames ?? schemas.map(tool => tool.name)
      collected.push(...schemas)
      for (const name of acceptedKnownNames) knownNames.add(name)
    }
    const sectionDefinitions = [...sectionByName.values()].sort(comparePromptSections)
    const completeSections = sectionDefinitions.filter(section => section.complete === true)
    if (completeSections.length > 1) {
      throw new Error(`multiple complete prompt sections are active: ${completeSections.map(section => JSON.stringify(section.name)).join(', ')}`)
    }
    let completeSection: AssembledSection | undefined
    const sections = sectionDefinitions
      .map((section) => {
        const assembled = {
          name: section.name,
          text: typeof section.text === 'function' ? section.text(context) : section.text,
          ...section.interpolate !== undefined ? { interpolate: section.interpolate } : {},
        }
        if (section.complete === true) completeSection = { ...assembled }
        return assembled
      })
    const assembly: PromptAssembly = {
      sections,
      contexts: [...contextByName.values()]
        .filter(entry => !runtimeContextSuppressed || entry.required === true)
        .sort((a, b) => a.order - b.order)
        .map(entry => resolveContext(entry, context)),
      tools: orderTools(collected, this.toolOrder, knownNames),
      variables,
    }
    const transformed = await this.ctx.waterfall(
      scopeTarget(this, scope), 'system-prompt/assemble', assembly, context,
      () => Promise.resolve(assembly),
    )
    if (completeSection === undefined && !runtimeContextSuppressed) return transformed
    const requiredContexts = new Set([...contextByName.values()].filter(entry => entry.required === true).map(entry => entry.name))
    return {
      ...transformed,
      sections: completeSection === undefined ? transformed.sections : [completeSection],
      contexts: runtimeContextSuppressed ? transformed.contexts.filter(entry => requiredContexts.has(entry.name)) : transformed.contexts,
    }
  }
}

export default SystemPrompt
