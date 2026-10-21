/**
 * 智能体技能提供方注册表。
 *
 * 本包承载技能能力接缝中的“服务定义”角色。诸如 `@deepseek-ai/dsh-skill-filesystem`
 * 之类的具体提供方决定技能来自何处；本服务只负责合并各方提供方目录、解析某个名称下的
 * 胜出技能，并把胜出的摘要与定义暴露给消费方。
 *
 * @module @deepseek-ai/dsh-skill
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { NamedEntries, ScopedLayers, scopeChainOf, scopeOf } from '@deepseek-ai/dsh-scope'
import type { ScopeKey, ScopeLayer } from '@deepseek-ai/dsh-scope'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const DEFAULT_COLLECT_CACHE_ENTRIES = 128
const MAX_COLLECT_ATTEMPTS = 2
const RUNTIME_PROVIDER = 'runtime'
const RUNTIME_RANK = 250

/** 随包分发的技能提供方与本地打包根目录所用的标准优先级序号。 */
export const BUNDLED_SKILL_RANK = 600

/**
 * 判断一个字符串是否为合法的 kebab-case 技能名。
 * @param name - 待校验的候选技能名。
 * @returns 该名称是否匹配公开的技能名语法。
 */
export function isSkillName(name: string): boolean {
  return SKILL_NAME.test(name)
}

/** 一项技能贡献的来源分类。该值是对提示词可见的元数据，本身并不构成优先级。 */
export type SkillSource = 'project-dsh' | 'project-agents' | 'runtime' | 'user-dsh' | 'user-agents' | 'custom' | 'bundled' | (string & {})

/** 可选的、由提供方指定的基址；已加载的技能正文据此解析相对资源。 */
export type SkillResourceBase =
  | { readonly kind: 'directory'; readonly path: string }
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'opaque'; readonly description: string }

/** 技能发现类消费方共用的调用控制项。 */
export interface SkillInvocationPolicy {
  /** 面向模型的目录与加载器是否包含该技能。 */
  readonly modelInvocable: boolean
  /** 面向人的命令目录与加载器是否包含该技能。 */
  readonly userInvocable: boolean
}

/** `ctx.skills.list()` 返回的、与调用方式中立的技能元数据。 */
export interface SkillSummary {
  /** 提供方给出的指令文件的绝对路径；虚拟技能没有该字段。 */
  readonly path?: string
  /** 用于寻址该技能的 kebab-case 标识符。 */
  readonly name: string
  /** 发现类消费方展示的简短路由描述。 */
  readonly description: string
  /** 可选的额外路由指引。 */
  readonly whenToUse?: string
  /** 已解析的模型调用与用户调用控制项。 */
  readonly invocation: SkillInvocationPolicy
  /** 产出该胜出技能的发现来源。 */
  readonly source: SkillSource
  /** 持有该技能正文的提供方。 */
  readonly provider: string
  /** 提供方特有的相对资源基址。 */
  readonly resourceBase?: SkillResourceBase
}

/** 注册表用于合并、并在之后加载技能的提供方目录条目。 */
export interface SkillCandidate extends SkillSummary {
  /** 在考虑提供方注册顺序之前，较小的序号会在同名技能中胜出。 */
  readonly rank: number
  /** 由提供方自有的不透明句柄，会回传给 `provider.get()`。 */
  readonly locator: unknown
  /** 从提供方特有的技能 frontmatter 中解析出的可选元数据对象。 */
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** 完整的技能解析定义，包含 `ctx.skills.get()` 所加载的正文。 */
export interface SkillDefinition extends SkillSummary {
  /** 去除各提供方特有元数据之后的 Markdown 指令正文。 */
  readonly content: string
  /** 从 frontmatter 解析出的可选元数据对象。 */
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** `ctx.skills.register()` 接受的运行时技能贡献。 */
export type SkillRegistration = Omit<SkillDefinition, 'invocation' | 'provider'> & {
  /** 调用控制项；省略表示同时允许模型与用户两类入口。 */
  readonly invocation?: SkillInvocationPolicy
  /** 提供方标签；省略则使用注册表自有的运行时提供方。 */
  readonly provider?: string
}

/** 供提供方执行依赖工作目录、可中止的任务时所用的调用方上下文。 */
export interface SkillLookupOptions {
  /** 本次查找所选的工作区。 */
  readonly cwd?: string | undefined
  /** 中止当前调用方的发现或加载工作。 */
  readonly signal?: AbortSignal | undefined
}

/**
 * 注册表读取选项：提供方的查找上下文，再叠加查看作用域。
 * 注册表消费 `scope` 来挑选层；提供方会收到同一个借出的选项对象，
 * 并只从中读取自己的 {@link SkillLookupOptions} 契约。
 */
export interface SkillViewOptions extends SkillLookupOptions {
  /** 查看作用域（发起调用的智能体）；省略时只读取全局层。 */
  readonly scope?: ScopeKey | undefined
}

/**
 * 判断一个技能是否可以展示给模型、并由模型加载。
 * @param skill - 携带已解析调用控制项的技能元数据。
 * @returns 该策略是否允许模型调用。
 */
export function isModelInvocable(skill: Pick<SkillSummary, 'invocation'>): boolean {
  return skill.invocation.modelInvocable
}

/**
 * 判断一个技能是否可以展示给面向人的命令、并由其加载。
 * @param skill - 携带已解析调用控制项的技能元数据。
 * @returns 该策略是否允许用户调用。
 */
export function isUserInvocable(skill: Pick<SkillSummary, 'invocation'>): boolean {
  return skill.invocation.userInvocable
}

/**
 * 用户显式调用技能时所注入的上下文消息的持久化数据源：用户自己写的那句话承载在一条普通的
 * 用户消息上，而渲染后的技能正文随后作为带有本数据源的 `instructions` 形式上下文注入，
 * 这样交互记录的消费方就能依据元数据来呈现该注入，而不必重新解析面向模型的文本。
 */
export interface SkillInvocationSource {
  readonly kind: 'skill-invocation'
  /** 被调用的技能名，在注入的边界处已校验为对用户可调用。 */
  readonly name: string
  /** 被注入的技能正文都是供模型遵循的指令。 */
  readonly form: 'instructions'
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** 由宿主注入的一次用户显式技能调用。 */
    'skill-invocation': SkillInvocationSource
  }
}

/**
 * 为模型渲染一个已加载的技能。该输出由 `skill` 工具的结果与用户显式调用的注入逐字共用，
 * 因此模型在两条路径上看到的都是同一个规范的 `<skill_content>` 形状。名称走转义后的属性；
 * 正文则原样嵌入（技能属于受信任的本地内容，而用户提供的调用文本留在本包裹之外）。
 * @param skill - 待渲染的名称、提供方、可选资源基址与正文。
 * @returns 完整的、面向模型的 `<skill_content>` 区块。
 */
export function renderSkillContent(skill: Pick<SkillDefinition, 'name' | 'provider' | 'resourceBase' | 'content'>): string {
  const resourceHint = renderResourceHint(skill)
  return [
    `<skill_content name="${escapeAttr(skill.name)}">`,
    '<skill_resources>',
    ...resourceHint,
    '</skill_resources>',
    '',
    '<skill_instructions>',
    skill.content,
    '</skill_instructions>',
    '</skill_content>',
  ].join('\n')
}

function renderResourceHint(skill: Pick<SkillDefinition, 'provider' | 'resourceBase'>): string[] {
  const base = skill.resourceBase
  if (base === undefined) {
    return [
      `Resources for this skill are managed by provider "${escapeText(skill.provider)}".`,
      'Load referenced resources only as needed.',
    ]
  }
  switch (base.kind) {
    case 'directory':
      return [
        `Base directory for this skill: ${escapeText(base.path)}`,
        'Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.',
      ]
    case 'url':
      return [
        `Base URL for this skill: ${escapeText(base.url)}`,
        'Resolve relative URLs mentioned by this skill against the base URL before using them. Load referenced resources only as needed.',
      ]
    case 'opaque':
      return [
        `Resources for this skill: ${escapeText(base.description)}`,
        'Load referenced resources only as needed.',
      ]
    /* v8 ignore start -- SkillResourceBase 是封闭联合；未来新增的 kind 必须在此处触发编译失败。 */
    default:
      return assertNever(base, 'SkillResourceBase.kind')
    /* v8 ignore stop */
  }
}

function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}

/**
 * 转义嵌入技能标记内部的、面向模型的文本，使提供方提供的文字无法开启或闭合外层框架标签。
 * @param value - 待嵌入的原始文本。
 * @returns 转义后的文本。
 */
export function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/** 一次目录观测结果，外加发现过程是否在某个稳定的目录修订内完成。 */
export interface SkillCatalogSnapshot {
  /** 本次观测收集到的、已排序且与调用方式中立的摘要。 */
  readonly skills: SkillSummary[]
  /** 每个已注册的提供方是否都在没有并发目录修订的情况下完成。 */
  readonly complete: boolean
}

/** 提供方的候选条目，外加当前发现是否具有权威性。 */
export interface SkillProviderObservation {
  /** 当前提供方发现所得的候选条目。 */
  readonly candidates: readonly SkillCandidate[]
  /** 发现是否已完成，以及这些候选条目是否可以被缓存。 */
  readonly complete: boolean
}

/** 单一技能来源的提供方接口，例如本地目录或某个远程注册表。 */
export interface SkillProvider {
  /** 在 `ctx.skills` 注册表中唯一的提供方名称。 */
  readonly name: string
  /**
   * 列出当前查找上下文下可用的技能候选。提供方插件在 `apply()` 期间同步注册；
   * 远程初始化、鉴权与发现都应在该方法内部 await。实现应在 `options.signal`
   * 中止时迅速落定。
   * @param options - 查找选项；`cwd` 选择对工作区敏感的技能，`signal` 取消工作。
   * @returns 以完整数组的简写形式给出提供方候选，或者当可用候选来自未完成的发现时，
   *   给出一次显式的观测结果。
   */
  readonly list: (options: SkillLookupOptions) => Promise<readonly SkillCandidate[] | SkillProviderObservation>
  /**
   * 为先前列出过的某个候选加载完整的技能正文。
   * @param candidate - 最初由本提供方返回的那个胜出候选。
   * @param options - 查找选项；`cwd` 选择对工作区敏感的技能，`signal` 取消工作。
   * @returns 完整的技能正文；若已无法加载则返回 `undefined`。
   */
  readonly get: (candidate: SkillCandidate, options: SkillLookupOptions) => Promise<SkillDefinition | undefined>
}

/** 由单个提供方借用走的、与注册生命周期绑定的失效通知能力。 */
export interface SkillProviderControl {
  /** 在注册失败时、或当该次确切的提供方注册被释放时中止。 */
  readonly signal: AbortSignal
  /** 令已完成的目录失效并通知消费方；仅当该次确切的注册仍然有效时才生效。 */
  readonly invalidate: () => void
}

/** 技能注册表配置。 */
export interface Config {
  /** 内存中保留的、已完成的 cwd/provider 目录的最大数量。 */
  readonly collectCacheMaxEntries?: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    skills: SkillRegistry
  }

  interface Events {
    /**
     * 某个技能提供方、运行时贡献或由提供方支撑的目录可能已发生变化。这是一条未经过滤的
     * 失效通知；消费方应针对自己的查找选项重新拉取目录。监听器中的失败会被就地收敛，
     * 无法否决注册表的这次变更。
     * @mode emit
     */
    'skills/change'(): void
  }
}

interface IndexedCandidate {
  candidate: SkillCandidate
  provider: SkillProvider
  providerOrder: number
  localOrder: number
  /** 所属层，以便陈旧定义的失效处理能核验产生它的那次注册是否仍然有效。 */
  layer: SkillLayer
}

/** 由某层持有的一个提供方注册。 */
interface RegisteredProvider {
  provider: SkillProvider
  /** 整个服务范围内单调递增的注册序号，用作层内 rank 相同时的次序裁决依据。 */
  order: number
}

interface LayerCollectResult {
  entries: IndexedCandidate[]
  cacheable: boolean
}

interface CollectResult {
  entries: Map<string, IndexedCandidate>
  cacheable: boolean
}

/** 某个作用域对技能注册表的完整贡献。 */
class SkillLayer implements ScopeLayer {
  /** 通过携带本作用域的各上下文完成注册的提供方，按插入顺序排列。 */
  readonly providers: NamedEntries<RegisteredProvider>
  /** 通过携带本作用域的各上下文注册的运行时技能。 */
  readonly runtime = new Map<string, SkillDefinition>()

  constructor(scope: ScopeKey | undefined) {
    this.providers = new NamedEntries(name => new Error(scope === undefined
      ? `a skill provider named "${name}" is already registered`
      : `a skill provider named "${name}" is already registered in this scope`))
  }

  /** 本聚合层中的每一张贡献表是否都为空。 */
  isEmpty(): boolean {
    return this.providers.isEmpty() && this.runtime.size === 0
  }
}

/**
 * 分层的技能提供方注册表，沿用工具注册表所确立的“宿主 + 每作用域”形态。一次注册会归档到
 * 其调用上下文所属作用域的那一层（{@link scopeOf}）：宿主行与仓库插件落在全局层，而由某个
 * 智能体预设的常驻组合所挂载的插件，则落在该预设的层。一次读取会把全局层与查看作用域的链路
 * 合并——最近一层中的同名条目直接胜出，而 rank 顺序只在某一层内部裁决同名冲突。它对外暴露
 * 已排序的、与调用方式中立的摘要，并按需加载完整的技能正文。
 */
export class SkillRegistry extends Service {
  static Config: Schema<Config> = z.object({
    collectCacheMaxEntries: z.number().default(DEFAULT_COLLECT_CACHE_ENTRIES),
  })

  private readonly collectCacheMaxEntries: number
  private readonly layers = new ScopedLayers<SkillLayer>(
    scope => new SkillLayer(scope),
    () => { this.invalidateCache() },
  )
  private readonly collectCache = new Map<string, Map<string, IndexedCandidate>>()
  private revision = 0
  private nextProviderOrder = 0
  /** 供缓存键使用的稳定身份；作用域键是不透明的、按身份比较的对象。 */
  private readonly scopeIds = new WeakMap<ScopeKey, number>()
  private nextScopeId = 1

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'skills')
    this.collectCacheMaxEntries = config.collectCacheMaxEntries ?? DEFAULT_COLLECT_CACHE_ENTRIES
    assertPositiveInteger('collectCacheMaxEntries', this.collectCacheMaxEntries)
  }

  /**
   * 在插件 apply 期间同步注册一个借来的同进程提供方，归档到调用上下文所属的那一层：
   * 带作用域的上下文（某个智能体预设的常驻挂载点）只为该作用域注册，未带作用域的上下文
   * 则注册为全局。同一层内的重名与被保留的名称都会抛错；远程初始化应放在 `list()` 中。
   * Fiber 释放时会注销该提供方并令目录缓存失效。
   * @param create - 同步工厂，接收本次注册的生命周期与失效通知控制项。
   * @returns 用于注销该提供方的那个确切的 Cordis effect 释放函数；
   *   组合式 effect 可以直接把它 yield 出去，以保持拆卸顺序。
   */
  registerProvider(create: (control: SkillProviderControl) => SkillProvider): () => void {
    const lifecycle = new AbortController()
    let registration: { layer: SkillLayer; name: string } | undefined
    let provider: SkillProvider
    const control: SkillProviderControl = {
      signal: lifecycle.signal,
      invalidate: () => {
        const active = registration
        if (active !== undefined && active.layer.providers.get(active.name)?.provider === provider) {
          this.invalidateCache()
        }
      },
    }
    try {
      provider = create(control)
      const name = provider.name
      if (name === RUNTIME_PROVIDER) {
        throw new Error(`"${RUNTIME_PROVIDER}" is reserved for runtime skill registrations`)
      }
      const order = this.nextProviderOrder
      this.nextProviderOrder += 1
      return this.layers.effect(
        this.ctx,
        (layer) => {
          const undo = layer.providers.insert(name, { provider, order })
          registration = { layer, name }
          return () => {
            registration = undefined
            undo()
            lifecycle.abort(new Error(`skill provider "${name}" disposed`))
          }
        },
        { label: 'skills.registerProvider()' },
      )
    } catch (error) {
      lifecycle.abort(error)
      throw error
    }
  }

  /**
   * 把一个借来的只读运行时技能注册到调用上下文所属的那一层。在同一层内部，项目条目的
   * 优先级高于运行时条目，运行时条目又高于用户条目。同一层内的同名运行时条目遵循先到先得；
   * 重复条目会记录一条告警，并得到一个空操作的释放函数，以免它移除已胜出的那个。
   * @param skill - 技能定义入参；省略的 invocation 与 provider 字段取默认值。
   * @returns 确切的 Cordis effect 释放函数，保持组合拆卸顺序并令缓存失效。
   */
  register(skill: SkillRegistration): () => void {
    validateRuntimeSkill(skill)
    const scope = scopeOf(this.ctx)
    const existingLayer = scope === undefined ? this.layers.global : this.layers.peek(scope)
    if (existingLayer !== undefined && existingLayer.runtime.has(skill.name)) {
      this.ctx.logger.warn(`runtime skill "${skill.name}" ignored because it is already registered`)
      return () => {}
    }
    const definition: SkillDefinition = {
      ...skill,
      invocation: skill.invocation ?? { modelInvocable: true, userInvocable: true },
      provider: skill.provider ?? RUNTIME_PROVIDER,
    }
    return this.layers.effect(
      this.ctx,
      (layer) => {
        layer.runtime.set(definition.name, definition)
        return () => { layer.runtime.delete(definition.name) }
      },
      { label: 'skills.register()' },
    )
  }

  /**
   * 列出某个工作区下与调用方式中立的技能摘要。消费方在自己的操作边界上应用模型或用户的
   * 调用策略。查找选项与提供方候选在整个发现过程中都是被借出的、只读的同进程值。
   * @param options - 视图选项；`scope` 选择查看方智能体的各层，`cwd` 选择项目根目录，
   *   `signal` 取消发现过程。
   * @returns 全部已排序的胜出摘要。
   */
  async list(options: SkillViewOptions = {}): Promise<SkillSummary[]> {
    return (await this.snapshot(options)).skills
  }

  /**
   * 观测当前与调用方式中立的目录，以及发现过程是否在某个稳定的修订内完成。
   * 未完成的观测从不被缓存，从而让消费方得以保留“最后一次良好状态”，
   * 并在下一次请求边界上重试。
   * @param options - 视图选项；`scope` 选择查看方智能体的各层，`cwd` 选择项目根目录，
   *   `signal` 取消发现过程。
   * @returns 已排序的摘要，外加发现过程的完成状态。
   */
  async snapshot(options: SkillViewOptions = {}): Promise<SkillCatalogSnapshot> {
    const collected = await this.collect(options)
    return {
      skills: [...collected.entries.values()]
        .map(entry => toSummary(entry.candidate))
        .sort(compareSkillSummary),
      complete: collected.cacheable,
    }
  }

  /**
   * 加载并校验胜出的候选，把它在发现阶段获得的不透明定位句柄回传给提供方。选中之后会重新
   * 检查一次取消状态（含缓存命中的情形），并与加载过程竞争，以免某个不配合的提供方挂住调用方。
   * @param name - kebab-case 技能名。
   * @param options - 视图选项；`scope` 选择查看方智能体的各层，
   *   `cwd` 选择对工作区敏感的技能，`signal` 取消工作。
   * @returns 完整的技能（含正文内容），或 `undefined`。
   */
  async get(name: string, options: SkillViewOptions = {}): Promise<SkillDefinition | undefined> {
    if (!isSkillName(name)) return undefined
    const collected = await this.collect(options)
    throwIfAborted(options.signal)
    const match = collected.entries.get(name)
    if (match === undefined) return undefined
    const definition = await waitWithAbort(
      match.provider.get(match.candidate, options),
      options.signal,
    )
    if (definition === undefined) return undefined
    validateDefinition(definition)
    if (definition.name !== match.candidate.name) {
      this.invalidateEntry(match)
      return undefined
    }
    return definition
  }

  private async collect(options: SkillViewOptions): Promise<CollectResult> {
    throwIfAborted(options.signal)
    let attempt = 1
    while (true) {
      const revision = this.revision
      // 链本身是键的一部分，而不是被假定稳定：一次空白会话重组会在不触碰本注册表的情况下
      // 给某个已存在的作用域改换父级，只有把链写进键里，下一次读取才能看到新的预设。
      const key = this.collectCacheKey(options.cwd, scopeChainOf(options.scope), revision)
      const cached = this.collectCache.get(key)
      if (cached !== undefined) return { entries: cached, cacheable: true }

      const result = await this.collectFresh(options)
      throwIfAborted(options.signal)
      if (revision !== this.revision) {
        if (attempt < MAX_COLLECT_ATTEMPTS) {
          attempt += 1
          continue
        }
        return { entries: result.entries, cacheable: false }
      }
      if (result.cacheable) {
        this.collectCache.set(key, result.entries)
        if (this.collectCache.size > this.collectCacheMaxEntries) {
          const oldest = this.collectCache.keys().next() as IteratorYieldResult<string>
          this.collectCache.delete(oldest.value)
        }
      }
      return result
    }
  }

  private async collectFresh(options: SkillViewOptions): Promise<CollectResult> {
    // 先全局层，随后已有的链按“最远祖先在前、确切作用域在最后”的顺序叠加，于是最近一层中的
    // 同名条目会替换更远祖先的那些条目——这正是工具注册表的遮蔽规则。rank 只在某一层内部
    // 裁决同名冲突。
    const layers = [this.layers.global, ...this.layers.chainLayers(options.scope)]
    const merged = new Map<string, IndexedCandidate>()
    let cacheable = true
    for (const layer of layers) {
      const collected = await this.collectLayer(layer, options)
      if (!collected.cacheable) cacheable = false
      for (const entry of collected.entries) merged.set(entry.candidate.name, entry)
    }
    return { entries: merged, cacheable }
  }

  private async collectLayer(layer: SkillLayer, options: SkillLookupOptions): Promise<LayerCollectResult> {
    const collected = await this.listLayerCandidates(layer, options)
    collected.entries.sort(compareIndexedCandidates)
    const seen = new Set<string>()
    const result: IndexedCandidate[] = []
    for (const entry of collected.entries) {
      const skill = entry.candidate
      if (seen.has(skill.name)) {
        this.ctx.logger.warn(`skill "${skill.name}" from ${skill.source} ignored because a higher-priority skill already exists`)
        continue
      }
      seen.add(skill.name)
      result.push(entry)
    }
    return { entries: result, cacheable: collected.cacheable }
  }

  private async listLayerCandidates(layer: SkillLayer, options: SkillLookupOptions): Promise<LayerCollectResult> {
    throwIfAborted(options.signal)
    const candidates: IndexedCandidate[] = []
    let cacheable = true
    let runtimeOrder = 0
    for (const skill of [...layer.runtime.values()].sort((a, b) => compareCodePoints(a.name, b.name))) {
      candidates.push({
        candidate: runtimeCandidate(skill),
        provider: RUNTIME_SKILL_PROVIDER,
        providerOrder: -1,
        localOrder: runtimeOrder,
        layer,
      })
      runtimeOrder += 1
    }
    for (const { provider, order } of [...layer.providers.values()]) {
      let localOrder = 0
      let output: unknown
      try {
        output = await waitWithAbort(provider.list(options), options.signal)
      } catch (error) {
        if (options.signal?.aborted === true) throw toError(options.signal.reason)
        cacheable = false
        this.ctx.logger.warn(`skill provider "${provider.name}" skipped: ${errorMessage(error)}`)
      }
      if (output === undefined) continue
      const observation = normalizeProviderObservation(output, provider.name)
      if (!observation.complete) cacheable = false
      for (const candidate of observation.candidates) {
        validateCandidate(candidate, provider.name)
        candidates.push({ candidate, provider, providerOrder: order, localOrder, layer })
        localOrder += 1
      }
    }
    return { entries: candidates, cacheable }
  }

  private invalidateCache(): void {
    this.revision += 1
    this.collectCache.clear()
    this.notifyChange()
  }

  /** 在加载到陈旧定义之后做失效处理；仅当产生该条目的那次确切注册仍然有效时才执行。 */
  private invalidateEntry(entry: IndexedCandidate): void {
    /* v8 ignore else -- 一次定义加载可能活得比它所选中的那次确切提供方注册更久。 */
    if (entry.layer.providers.get(entry.provider.name)?.provider === entry.provider) this.invalidateCache()
  }

  private scopeId(key: ScopeKey): number {
    let id = this.scopeIds.get(key)
    if (id === undefined) {
      id = this.nextScopeId
      this.nextScopeId += 1
      this.scopeIds.set(key, id)
    }
    return id
  }

  private collectCacheKey(cwd: string | undefined, chain: ScopeKey[], revision: number): string {
    return JSON.stringify({ cwd, scopes: chain.map(key => this.scopeId(key)), revision })
  }

  /** 通知目录的观察者，同时不把它们的刷新工作变成承担性依赖。 */
  private notifyChange(): void {
    for (const callback of this.ctx.events.dispatch('emit', ['skills/change'])) {
      try {
        const returned: unknown = callback()
        void Promise.resolve(returned).catch((error: unknown) => {
          this.ctx.logger.warn(`skills/change listener rejected: ${errorMessage(error)}`)
        })
      } catch (error: unknown) {
        this.ctx.logger.warn(`skills/change listener threw: ${errorMessage(error)}`)
      }
    }
  }
}

function normalizeProviderObservation(output: unknown, providerName: string): SkillProviderObservation {
  if (Array.isArray(output)) {
    return { candidates: output as readonly SkillCandidate[], complete: true }
  }
  if (output === null || typeof output !== 'object') {
    throw invalidProviderObservation(providerName)
  }
  const observation = output as Partial<SkillProviderObservation>
  if (!Array.isArray(observation.candidates) || typeof observation.complete !== 'boolean') {
    throw invalidProviderObservation(providerName)
  }
  return observation as SkillProviderObservation
}

function invalidProviderObservation(providerName: string): TypeError {
  return new TypeError(`skill provider "${providerName}" list() must return an array or { candidates, complete } observation`)
}

const RUNTIME_SKILL_PROVIDER: SkillProvider = {
  name: RUNTIME_PROVIDER,
  /* v8 ignore next -- 运行时技能由注册表直接注入；该提供方只拥有 `get()`。 */
  list() {
    return Promise.resolve([])
  },
  get(candidate) {
    return Promise.resolve(candidate.locator as SkillDefinition)
  },
}

function runtimeCandidate(skill: SkillDefinition): SkillCandidate {
  return {
    name: skill.name,
    description: skill.description,
    ...skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {},
    invocation: skill.invocation,
    source: skill.source,
    provider: skill.provider,
    ...skill.resourceBase !== undefined ? { resourceBase: skill.resourceBase } : {},
    rank: RUNTIME_RANK,
    locator: skill,
    ...skill.path !== undefined ? { path: skill.path } : {},
    ...skill.metadata !== undefined ? { metadata: skill.metadata } : {},
  }
}

function validateCandidate(candidate: SkillCandidate, providerName: string): void {
  if (typeof candidate.name !== 'string') {
    throw new TypeError(`skill provider "${providerName}" returned a non-string skill name`)
  }
  if (!SKILL_NAME.test(candidate.name)) {
    throw new Error(`skill provider "${providerName}" returned invalid skill name "${candidate.name}"`)
  }
  if (typeof candidate.description !== 'string') {
    throw new TypeError(`skill provider "${providerName}" returned skill "${candidate.name}" with a non-string description`)
  }
  if (candidate.description.length === 0) {
    throw new Error(`skill provider "${providerName}" returned skill "${candidate.name}" without a description`)
  }
  validateInvocation(candidate.invocation, `skill provider "${providerName}" returned skill "${candidate.name}"`)
  if (candidate.whenToUse !== undefined && typeof candidate.whenToUse !== 'string') {
    throw new TypeError(`skill provider "${providerName}" returned skill "${candidate.name}" with a non-string whenToUse`)
  }
  if (typeof candidate.source !== 'string') {
    throw new TypeError(`skill provider "${providerName}" returned skill "${candidate.name}" with a non-string source`)
  }
  if (typeof candidate.rank !== 'number' || !Number.isFinite(candidate.rank)) {
    throw new Error(`skill provider "${providerName}" returned skill "${candidate.name}" with an invalid rank`)
  }
  if (typeof candidate.provider !== 'string') {
    throw new TypeError(`skill provider "${providerName}" returned skill "${candidate.name}" with a non-string provider`)
  }
  if (candidate.provider !== providerName) {
    throw new Error(`skill provider "${providerName}" returned skill "${candidate.name}" for provider "${candidate.provider}"`)
  }
  if (candidate.path !== undefined && typeof candidate.path !== 'string') {
    throw new TypeError(`skill provider "${providerName}" returned skill "${candidate.name}" with a non-string path`)
  }
}

function validateRuntimeSkill(skill: SkillRegistration): void {
  if (!SKILL_NAME.test(skill.name)) throw new Error(`invalid skill name "${skill.name}"`)
  if (skill.description.length === 0) throw new Error(`skill "${skill.name}" requires a description`)
  validateInvocation(skill.invocation, `runtime skill "${skill.name}"`)
}

/** 校验来自提供方自控解析器或远程来源的一条已加载定义。 */
function validateDefinition(skill: SkillDefinition): void {
  const name = skill.name
  const description = skill.description
  const whenToUse = skill.whenToUse
  const invocation = skill.invocation
  const source = skill.source
  const provider = skill.provider
  const content = skill.content
  const path = skill.path
  if (typeof name !== 'string') throw new TypeError('loaded skill name must be a string')
  if (!SKILL_NAME.test(name)) throw new Error(`loaded skill has invalid name "${name}"`)
  if (typeof description !== 'string') throw new TypeError(`loaded skill "${name}" description must be a string`)
  if (description.length === 0) throw new Error(`loaded skill "${name}" requires a description`)
  validateInvocation(invocation, `loaded skill "${name}"`)
  if (whenToUse !== undefined && typeof whenToUse !== 'string') throw new TypeError(`loaded skill "${name}" whenToUse must be a string`)
  if (typeof source !== 'string') throw new TypeError(`loaded skill "${name}" source must be a string`)
  if (typeof provider !== 'string') throw new TypeError(`loaded skill "${name}" provider must be a string`)
  if (typeof content !== 'string') throw new TypeError(`loaded skill "${name}" content must be a string`)
  if (path !== undefined && typeof path !== 'string') throw new TypeError(`loaded skill "${name}" path must be a string`)
}

function toSummary(skill: SkillDefinition | SkillCandidate): SkillSummary {
  const { name, description, whenToUse, invocation, source, provider, resourceBase } = skill
  return {
    name,
    ...skill.path === undefined ? {} : { path: skill.path },
    description,
    ...whenToUse !== undefined ? { whenToUse } : {},
    invocation,
    source,
    provider,
    ...resourceBase !== undefined ? { resourceBase } : {},
  }
}

function validateInvocation(invocation: unknown, subject: string): void {
  if (invocation === undefined) return
  if (typeof invocation !== 'object' || invocation === null || Array.isArray(invocation)) {
    throw new TypeError(`${subject} with a non-object invocation policy`)
  }
  const policy = invocation as Record<string, unknown>
  if (typeof policy.modelInvocable !== 'boolean') {
    throw new TypeError(`${subject} with a non-boolean invocation.modelInvocable`)
  }
  if (typeof policy.userInvocable !== 'boolean') {
    throw new TypeError(`${subject} with a non-boolean invocation.userInvocable`)
  }
}

function compareSkillSummary(left: SkillSummary, right: SkillSummary): number {
  return compareCodePoints(left.name, right.name)
}

function compareCodePoints(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function compareIndexedCandidates(left: IndexedCandidate, right: IndexedCandidate): number {
  return left.candidate.rank - right.candidate.rank
    || left.providerOrder - right.providerOrder
    || left.localOrder - right.localOrder
}

function assertPositiveInteger(name: string, value: number, minimum = 1): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`skill: ${name} must be an integer greater than or equal to ${minimum}`)
  }
}

function waitWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  throwIfAborted(signal)
  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort)
    }
    const onAbort = (): void => {
      cleanup()
      reject(toError(signal.reason))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        cleanup()
        reject(toError(error))
      },
    )
  })
}

/** 为一次已中止的查找抛出一个完备的 Error。 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw toError(signal.reason)
}

/** 把一个任意的中止原因或提供方失败规整成 Error，且不依赖其强制转换行为。 */
function toError(error: unknown): Error {
  try {
    if (error instanceof Error) return error
  } catch {
    // 恶意代理可能在 instanceof 期间抛出异常；落到下面那步总能给出结果的渲染上。
  }
  return new Error(errorMessage(error))
}

/** 渲染一个任意的提供方失败，且不让强制转换逃出收敛范围。 */
function errorMessage(error: unknown): string {
  try {
    return String(error)
  } catch {
    return '[unrenderable thrown value]'
  }
}

export default SkillRegistry
