/** 选择同一预设版本的 Agent 之间共享的运行时插件树。 */
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { EntryTree, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { prepareProfileEntries } from '@deepseek-ai/dsh-app-boot'
import type { PresetDefinition } from './definition.ts'
import { scopeOf, type ScopeKey } from '@deepseek-ai/dsh-scope'

/** 内存中的 Loader 树；只有 profile 配置编辑器会持久化定义。 */
class PresetTree extends EntryTree {
  constructor(ctx: Context) {
    const owner = ctx.fiber.entry
    const subtree = owner?.subtree
    const subgroup = owner?.subgroup
    super(ctx)
    if (owner !== undefined) {
      if (subtree === undefined) delete owner.subtree
      else owner.subtree = subtree
      if (subgroup === undefined) delete owner.subgroup
      else owner.subgroup = subgroup
    }
  }

  override write(): void {}
}

/** Agent 与作用域读取者共享的一个活动版本。 */
export interface PresetMount {
  /** 该子树所组合自的预设。 */
  readonly presetId: string
  /** 已挂载子树的 fiber。 */
  readonly fiber: Fiber
  /** 其活动行构成本常驻组合的 Loader 条目树。 */
  readonly tree: EntryTree
  /** Agent 所挂载到的常驻作用域键（仅在已拆除的记录中为 undefined）。 */
  readonly key: ScopeKey | undefined
}

/**
 * 判断 `fiber` 是 `root` 本身，还是挂载在其子树内的任意位置。
 *
 * 归属判定基于对象标识。`uid` 看似是更廉价的键，但它是每个注册表各自的计数器，
 * 因此两个不同根中的 fiber 会在 `uid` 上冲突，
 * 一个运行时中的子树就可能被误判为发布了另一个运行时中的服务。
 * @param fiber - 待定位的 fiber。
 * @param root - 用于检测归属的子树根。
 * @returns 当 `fiber` 属于 `root` 的子树时为 true。
 */
function withinFiber(fiber: Fiber, root: Fiber): boolean {
  let current = fiber
  while (true) {
    if (current === root) return true
    const parent = current.parent.fiber
    if (parent === current) return false
    current = parent
  }
}

/**
 * 已挂载子树发布到根 realm 中的服务名。
 *
 * 没有 `isolate` realm 的提供者会把它实现存放在根以该名称对应的 symbol 下，
 * 下面的比较正是这一点；位于 `isolate` realm 内的提供者存放在 realm 私有的
 * symbol 下，因此正确地不出现在这里。
 * @param ctx - 被检查其服务存储的运行时中的任意上下文。
 * @param mount - 已挂载子树的 fiber。
 * @returns 按字典序排列的外泄服务名。
 */
export function leakedServices(ctx: Context, mount: Fiber): string[] {
  const store = ctx.reflect.store
  const rootIsolate = ctx.root[Context.isolate]
  const leaked: string[] = []
  for (const key of Object.getOwnPropertySymbols(store)) {
    const impl = store[key]
    /* v8 ignore next -- cordis 在释放时删除存储槽而非清空它，
       因此自有 symbol 总能解析出值；保留该判断只是因为存储的索引签名是可选的。 */
    if (impl === undefined) continue
    if (!withinFiber(impl.fiber, mount)) continue
    if (rootIsolate[impl.name] === key) leaked.push(impl.name)
  }
  return leaked.sort((left, right) => left.localeCompare(right))
}

/**
 * 读取某个保留预设所拥有的服务实现，包含隔离 realm 中的实现。
 *
 * 归属关系与 {@link leakedServices} 所读取的相同，只是方向相反：
 * 那里列出子树发布到 ROOT realm 中的实现，这里给出该子树在任何位置发布的实现。
 * fiber 归属基于对象标识，原因见 {@link withinFiber}。
 *
 * @param ctx - 被检查其服务存储的运行时中的任意上下文。
 * @param mount - 其子树拥有该服务的保留版本。
 * @param name - 预设各行所解析出的服务名。
 * @returns 该实现；该挂载未提供时返回 undefined。
 */
export function serviceForMount<K extends string & keyof Context>(
  ctx: Context,
  mount: PresetMount,
  name: K,
): Context[K] | undefined {
  const store = ctx.reflect.store
  for (const key of Object.getOwnPropertySymbols(store)) {
    const impl = store[key]
    /* v8 ignore next -- cordis 在释放时删除存储槽而非清空它 */
    if (impl === undefined) continue
    if (impl.name !== name) continue
    if (withinFiber(impl.fiber, mount.fiber)) return impl.value as Context[K]
  }
  return undefined
}

/** 未达到可用状态的行，每行渲染为一条诊断信息。 */
export interface RowAudit {
  /** 从未启动，或导入、激活被拒绝的行。 */
  readonly failed: string[]
  /**
   * 正在等待组合未提供的服务的行。仍在激活中的 Host 提供者
   * 之后会补齐这样的行；只有稳定的 Host 树才能把这种情况
   * 与真正缺失的服务区分开。
   */
  readonly pending: string[]
}

/**
 * 审计已挂载子树的各行。
 *
 * 先等待子树就绪，再报告导入失败、激活失败，
 * 以及等待组合未提供服务的行。
 * @param tree - 已挂载的子树。
 * @returns 失败与等待中的行；当每个已启用的行都可用时，二者均为空。
 */
export async function auditRows(tree: EntryTree): Promise<RowAudit> {
  await tree.await()
  const failed: string[] = []
  const pending: string[] = []
  for (const entry of tree.entries()) {
    if (entry.disabled) continue
    const fiber = entry.fiber
    if (fiber === undefined) {
      failed.push(`${entry.options.id} (${entry.options.name}): never started`)
      continue
    }
    try {
      await fiber.await()
    } catch (error) {
      const detail = mountDetail(error)
      failed.push(`${entry.options.id} (${entry.options.name}): ${detail}`)
      continue
    }
    const missing = Object.keys(fiber.inject).filter(name => fiber.ctx.get(name) === undefined)
    if (missing.length > 0) {
      pending.push(`${entry.options.id} (${entry.options.name}): waiting for ${missing.join(', ')}`)
    }
  }
  return { failed, pending }
}

/**
 * 取 `error` 中那些其自身消息未涵盖的成因。
 *
 * 聚合错误带有各自独立的成员消息。包装错误可以把聚合错误保留为 cause，
 * 却不把那些消息写进自己的文本里。
 * @param error - 需要读取分支的失败对象。
 * @returns 需要渲染在 `error.message` 之下的分支，可能为空。
 */
function detailBranches(error: Error): readonly unknown[] {
  if (error instanceof AggregateError) return error.errors
  return error.cause instanceof AggregateError ? error.cause.errors : []
}

/**
 * 挂载失败的可报告文本。
 *
 * 插件可能以聚合错误拒绝，或把聚合错误包装为 cause。
 * 把其成员消息附在该行诊断之下，让每个失败都可见。
 * @param error - 挂载拒绝时抛出的值。
 * @returns 每个成因占一行的描述。
 */
function mountDetail(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const branches = detailBranches(error)
  if (branches.length === 0) return error.message
  return [
    error.message,
    ...branches.map(branch => `- ${mountDetail(branch).replaceAll('\n', '\n  ')}`),
  ].join('\n')
}

/** 在注册表自身作用域下加载并审计一个版本。
 *
 * 失败的行以及根 realm 服务外泄都会导致挂载被拒绝。等待 Host 服务的行保持挂载：
 * 提供者就绪后它们会自行激活，注册表会在 Host 树稳定后重新审计它们。
 * 在 profile 内部，兼容性策略先决定准入：profile 拒绝其插件的行以禁用状态挂载，
 * 因此审计把它读作有意的未激活，而不是报成导入失败。
 * @param ctx 继承声明方 Loader 解析基址的作用域上下文。
 * @param id 预设身份。
 * @param plugins 已声明的 Cordis 条目列表。
 * @returns 活动树；其销毁由作用域释放负责。
 */
export async function mountPreset(ctx: Context, id: string, plugins: PresetDefinition['plugins']): Promise<PresetMount> {
  if (scopeOf(ctx) === undefined) throw new Error('agent-preset: mounting requires a scope')
  await ctx.fiber.await()
  const tree = new PresetTree(ctx)
  ctx.effect(() => () =>{  tree.root.stop() }, 'agent-preset.tree')
  await tree.root.update(prepareProfileEntries(ctx, plugins as EntryOptions[], ctx.baseUrl))
  const audit = await auditRows(tree)
  const leaked = leakedServices(ctx, ctx.fiber)
  if (audit.failed.length > 0) throw new Error(audit.failed.join('\n'))
  if (leaked.length > 0) throw new Error(`Preset services require isolate realms: ${leaked.join(', ')}`)
  const mount = { presetId: id, fiber: ctx.fiber, tree, key: scopeOf(ctx) }
  return mount
}
