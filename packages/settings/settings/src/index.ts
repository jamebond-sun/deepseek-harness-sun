/** 在 Cordis profile 补丁之上进行 Config schema 投影与表单编辑。 */
import { existsSync } from 'node:fs'
import { readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'yaml'
import { Context, FiberState, Service, resolveConfig, type Fiber } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'
import { interpolate, type Entry } from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-config-editor'
import type {} from '@deepseek-ai/dsh-app-boot'
import { redactSecrets, type RedactedSecret } from './redact.ts'
import { isVolatilePath, plainConfig, projectForm, volatileForm } from './schema.ts'
import type { SettingsNamespace } from './types.ts'

export { redactSecrets } from './redact.ts'
export type { RedactedSecret, RedactedValue } from './redact.ts'
export type { SettingsNamespace } from './types.ts'

/** 单个 Loader 条目的 live Config 字段。 */
export interface SettingsDescriptor {
  ns: SettingsNamespace
  /** 当不存在自定义页面时，UI 是否可以生成页面。 */
  autoGenerate: boolean
  schema: unknown
  value: unknown
  revision: number
  base?: unknown
  user?: unknown
  applies: 'live'
  secrets?: RedactedSecret[]
}

/** 线上读取方始终请求密文脱敏。 */
export interface SettingsDescribeOptions {
  redactSecrets?: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 由 schema 派生的插件配置表单。 */
    settings: SettingsForms
  }
}
/** 拒绝覆盖自表单读取以来已发生变更的配置。 */
export class SettingsConflictError extends Error {
  /** 稳定的机器码，供线上层映射到各自的错误分类。 */
  readonly code = 'SETTINGS_CONFLICT'
  /** 写入所期望的修订号。 */
  readonly expected: number
  /** 该命名空间实际所处的修订号。 */
  readonly actual: number

  /**
   * @param ns - 写入被拒绝的命名空间。
   * @param expected - 调用方发送的修订号。
   * @param actual - 当前存储的修订号。
   */
  constructor(ns: SettingsNamespace, expected: number, actual: number) {
    super(`settings namespace "${ns}" changed since it was read (expected revision ${String(expected)}, now ${String(actual)})`)
    this.name = 'SettingsConflictError'
    this.expected = expected
    this.actual = actual
  }
}

/** 判断值是否为纯数据对象（不是数组、null 或类实例）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * 对某命名空间用户配置节的一次路径寻址编辑。路径变更是为只持有该配置节
 * 不完整视图的调用方而存在的 —— 配置 UI 读取的是已脱敏的描述符，而该描述符
 * 按构造从未收到过 `role('secret')` 字段。这样的调用方可以指明它所指的字段，
 * 而无需重述整个配置节：若用已脱敏的文档重建后整体 `replace`，
 * 会静默删除线上从未返回的每一个密文。
 */
export type SettingsPathOp =
  | { op: 'set'; path: readonly string[]; value: unknown }
  | { op: 'unset'; path: readonly string[] }

/** 将一次路径操作应用到脱钩的配置节上，返回下一个配置节。 */
function applyPathOp(section: Record<string, unknown>, op: SettingsPathOp, schema: z): Record<string, unknown> {
  const edit = (input: unknown, path: readonly string[], node?: z): unknown => {
    const [head, ...rest] = path
    if (head === undefined) return op.op === 'set' ? op.value : undefined
    const value: unknown = input === undefined ? node?.meta.default : input
    if (Array.isArray(value)) {
      if (!/^(0|[1-9][0-9]*)$/.test(head) || (Number(head) > value.length || Number(head) === value.length && (rest.length > 0 || op.op === 'unset'))) {
        throw new TypeError(`Config array index "${head}" is out of range`)
      }
      const result: unknown[] = [...value as unknown[]]
      const index = Number(head)
      if (rest.length === 0 && op.op === 'unset') result.splice(index, 1)
      else result[index] = edit(value[index], rest, node?.inner)
      return result
    }
    const result = isPlainObject(value) ? { ...value } : {}
    const child = edit(Object.hasOwn(result, head) ? result[head] : undefined, rest, node?.dict?.[head] ?? node?.inner)
    if (child === undefined) Reflect.deleteProperty(result, head)
    else Object.defineProperty(result, head, { value: child, enumerable: true, writable: true, configurable: true })
    return result
  }
  const result = edit(section, op.path, schema)
  if (!isPlainObject(result)) throw new TypeError('Config root must be a plain object')
  return result
}

/** 为无损 JSON 无法表示的值生成人类可读的标签（数字会被就地拒绝）。 */
function describeRejected(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (typeof value === 'object' && value !== null) {
    const proto = Object.getPrototypeOf(value) as { constructor?: { name?: string } } | null
    const name = proto?.constructor?.name
    return name === undefined || name === 'Object' ? 'a non-plain object' : `a ${name}`
  }
  return `a ${typeof value}`
}

/**
 * 在持久化之前以一次遍历完成写入输入的脱钩与校验：只有 JSON 数据
 * （纯对象、数组、字符串、有限数字、布尔值、`null`）可以进入 provider 文档。
 * 仅使用 `structuredClone` 会放行 Date、Map、BigInt 与循环引用，
 * 而 YAML/JSON 存储在重载往返时会静默地把它们扭曲。对象中的 `undefined`
 * 条目会被跳过 —— 与 {@link mergeLayers} 相同的稀疏补丁语义 ——
 * 而数组中的 `undefined` 条目会被拒绝，而不是被强制转换。
 * @param root - 合并之前需要校验的写入输入。
 * @returns 与 JSON 兼容的脱钩副本。
 */
function cloneJsonShaped(root: object): Record<string, unknown> {
  const reject = (label: string, path: string): TypeError => new TypeError(`Config ${path} contains ${label}`)
  if (!isPlainObject(root)) throw reject('a non-plain root', '$')
  const visiting = new WeakSet<object>()
  const clone = (value: unknown, path: string): unknown => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw reject('a non-finite number', path)
      return value
    }
    if (Array.isArray(value)) {
      if (visiting.has(value)) throw reject('a circular reference', path)
      visiting.add(value)
      const entries = value.map((entry, index) => clone(entry, `${path}[${index}]`))
      // 退出时取消标记，使被引用两次但不存在循环的对象得以通过。
      visiting.delete(value)
      return entries
    }
    if (isPlainObject(value)) {
      if (visiting.has(value)) throw reject('a circular reference', path)
      visiting.add(value)
      const out: Record<string, unknown> = {}
      for (const [key, entry] of Object.entries(value)) {
        if (entry === undefined) continue
        Object.defineProperty(out, key, { value: clone(entry, `${path}.${key}`), enumerable: true, configurable: true, writable: true })
      }
      visiting.delete(value)
      return out
    }
    throw reject(describeRejected(value), path)
  }
  return clone(root, '$') as Record<string, unknown>
}

/**
 * 将 `over` 叠加到 `under` 之上：纯对象递归合并，其他所有值（数组也包括在内）
 * 都整体替换下层。`over` 永不携带 `undefined` 条目 —— 配置节来自已解析的文档，
 * 且写入快照会经过 {@link cloneJsonShaped}，后者会剔除这些条目，
 * 使稀疏补丁无法擦除下层已有的键。
 */
function mergeLayers(under: unknown, over: unknown): unknown {
  if (!isPlainObject(under) || !isPlainObject(over)) return over
  const merged: Record<string, unknown> = { ...under }
  for (const [key, value] of Object.entries(over)) {
    Object.defineProperty(merged, key, {
      value: Object.hasOwn(merged, key) ? mergeLayers(merged[key], value) : value,
      enumerable: true, configurable: true, writable: true,
    })
  }
  return merged
}


/** 读取纯对象或数组的某个成员；`own` 将读取限制为自有属性。
 * @param node 候选容器。
 * @param key 成员名。
 * @param own 继承而来的成员是否视为不存在。
 * @returns 该成员；当节点不是容器或缺少该成员时返回 undefined。
 */
function member(node: unknown, key: string, own = false): unknown {
  if (!(isPlainObject(node) || Array.isArray(node)) || (own && !Object.hasOwn(node, key))) return undefined
  const value: unknown = Reflect.get(node, key)
  return value
}

/** 已移除的 `settings.yaml` 配置节所对应的条目 id，其归属条目另有一个 id。 */
const LEGACY_SECTION_ENTRIES: Record<string, string> = {
  'ui-developer-tools': 'ui-settings',
  'ui-onboarding': 'ui-settings-general',
  /* v8 ignore next -- 基础 bundle 为每个平台组合一个 shell 执行器 */
  shell: process.platform === 'win32' ? 'pwsh-sandbox' : 'bash-sandbox',
}

/** 仅解析继承层；当必填字段只能由 profile 提供时，则保留其原始值。
 * @param runtime 持有 Config schema 的插件运行时。
 * @param inherited 位于 profile 覆盖之下的插值配置。
 * @returns profile 覆盖所依托的值。
 */
function inheritedConfig(runtime: Fiber['runtime'] & object, inherited: unknown): unknown {
  try {
    return resolveConfig(runtime, inherited)
  } catch (_error) {
    // profile 覆盖提供了继承层所缺少的字段；表单将这些字段的原始值作为基底展示。
    return inherited
  }
}

/** 将 Config schema 投影为表单，并持有可选的实例级 UI 策略。 */
export class SettingsForms extends Service {
  static inject = ['configEditor', 'profileContext']
  private revisions = new Map<string, { raw: string | undefined; revision: number; ns: SettingsNamespace; autoGenerate: boolean }>()
  private closed = false
  private scheduled = false
  private readonly presentations = new Map<Fiber, { auto?: boolean }>()

  constructor(private readonly ownerContext: Context) {
    super(ownerContext, 'settings')
    const ctx = ownerContext
    ctx.effect(() => () => { this.closed = true })
    ctx.on('app-boot/config-reload', () => { this.invalidate() })
    void ctx.root.loader.await().then(() => this.importLegacyDocument()).catch((error: unknown) => { ctx.logger.error(error) })
  }

  /** 在 Loader 稳定所有条目之后，将已移除的 `settings.yaml` 的各个配置节迁入当前 profile。
   * 文档在首次写入之前即被重命名，因此部分导入不会重复执行；被运行中的组合拒绝的
   * 配置节会被记录日志，并只保留在重命名后的文件中。 */
  private async importLegacyDocument(): Promise<void> {
    const profile = this.ownerContext.profileContext
    const path = join(profile.home, 'settings.yaml')
    if (!existsSync(path)) return
    const imported = `${path}.imported`
    await rename(path, imported)
    const sections = parse(await readFile(imported, 'utf8')) as Record<string, object> | null
    for (const [section, values] of Object.entries(sections ?? {})) {
      const ns = LEGACY_SECTION_ENTRIES[section] ?? section
      try {
        await this.update(ns, values)
      } catch (error) {
        this.ownerContext.logger.warn('settings: section %s of %s was not imported into entry %s', section, imported, ns)
        this.ownerContext.logger.warn(error)
      }
    }
    this.ownerContext.logger.info('settings: imported %s into profile %s', imported, profile.name)
  }

  /** 注册调用方插件实例的页面策略，而不改动其 Config。
   * @param presentation 该实例的自动页面策略；`auto` 默认为 true。
   * @param owner 策略所属的插件实例；默认为调用方 fiber。
   * @returns 释放函数；请将其注册到调用方插件的 effects 中。
   * @throws 若该实例已注册过策略。
   */
  configure(presentation: { auto?: boolean }, owner: Fiber = this.ctx.fiber): () => void {
    const fiber = owner
    if (this.presentations.has(fiber)) throw new Error('Settings presentation is already configured for this plugin instance')
    const policy = { ...presentation }
    this.presentations.set(fiber, policy)
    this.invalidate()
    return () => {
      if (this.presentations.get(fiber) !== policy) return
      this.presentations.delete(fiber)
      this.invalidate()
    }
  }

  private invalidate(): void {
    if (this.scheduled || this.closed) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      if (this.closed || this.ownerContext.fiber.state !== FiberState.ACTIVE) return
      try { this.describe() } catch (error) { this.ownerContext.logger.error(error) }
    })
  }

  /** 当前 profile 是否接受表单编辑。 */
  get writable(): boolean { return true }
  /** 原生配置编辑器所展示的当前 profile 补丁。 */
  get documentPath(): string { return this.ownerContext.configEditor.documentPath }
  /** 定位用于原生编辑的 profile 补丁。
   * @returns 已存在的 profile 补丁路径。
   */
  prepareDocument(): Promise<string> { return Promise.resolve(this.documentPath) }

  /** 读取活动插件的 schema 及其 live 值。
   * @param options 远程调用方所需的脱敏选项。
   * @returns 以唯一 profile 条目 id 为键的表单。
   */
  describe(options?: SettingsDescribeOptions): SettingsDescriptor[] {
    const active = new Set<string>()
    const descriptors = this.ownerContext.configEditor.configuration().flatMap(({ entry, inherited, override }) => {
      const schema = this.schema(entry)
      if (schema === undefined || entry.fiber === undefined
        || entry.fiber.runtime === null || entry.fiber.state !== FiberState.ACTIVE) return []
      const form = volatileForm(schema)
      if (form === undefined) return []
      active.add(entry.id)
      const raw = JSON.stringify([entry.fiber.uid, schema.toJSON(), entry.options.config ?? {}])
      const autoGenerate = this.presentations.get(entry.fiber)?.auto ?? true
      const previous = this.revisions.get(entry.id)
      const revision = previous === undefined ? 0 : previous.revision + Number(previous.raw !== raw)
      this.revisions.set(entry.id, { raw, revision, ns: entry.options.id as SettingsNamespace, autoGenerate })
      if (previous?.raw !== raw || previous.autoGenerate !== autoGenerate) {
        this.ownerContext.emit('settings/document-updated', entry.options.id as SettingsNamespace, revision)
      }
      const value = projectForm(form, plainConfig(entry.fiber.config))
      const resolved: unknown = interpolate(entry.fiber.ctx, inherited)
      const base = projectForm(form, plainConfig(inheritedConfig(entry.fiber.runtime, resolved)))
      const user = projectForm(form, override)
      const redacted = redactSecrets(form as z<never>, value)
      return [{
        autoGenerate,
        ns: entry.options.id as SettingsNamespace, schema: form.toJSON(), revision, applies: 'live' as const,
        value: options?.redactSecrets ? redacted.value : value,
        base: options?.redactSecrets ? redactSecrets(form as z<never>, base).value : base,
        user: options?.redactSecrets ? redactSecrets(form as z<never>, user).value : user,
        ...options?.redactSecrets ? { secrets: redacted.secrets } : {},
      }]
    })
    for (const [id, previous] of this.revisions) {
      if (active.has(id) || previous.raw === undefined) continue
      const revision = previous.revision + 1
      this.revisions.set(id, { ...previous, raw: undefined, revision })
      this.ownerContext.emit('settings/document-updated', previous.ns, revision)
    }
    return descriptors
  }

  /** 将可编辑字段合并进某条目的 config。
   * @param ns profile 条目 id。
   * @param patch 待合并的字段。
   * @param expectedRevision describe 返回的修订号。
   */
  async update(ns: string, patch: object, expectedRevision?: number): Promise<void> {
    const input = cloneJsonShaped(patch)
    await this.write(ns, current => mergeLayers(current, input) as Record<string, unknown>, expectedRevision)
  }

  /** 重置所有 live 字段，再写入所提供的字段；普通 config 予以保留。
   * @param ns profile 条目 id。
   * @param section 完整的表单值。
   * @param expectedRevision describe 返回的修订号。
   */
  async replace(ns: string, section: object, expectedRevision?: number): Promise<void> {
    const input = cloneJsonShaped(section)
    await this.write(ns, (_current, base) => mergeLayers(base, input) as Record<string, unknown>, expectedRevision)
  }

  /** 应用字段编辑而无需重述已脱敏的密文；取消设置某个数组下标会移除该元素。
   * @param ns profile 条目 id。
   * @param ops 有序的表单编辑。
   * @param expectedRevision describe 返回的修订号。
   */
  async mutate(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void> {
    await this.write(ns, (current, base, schema) => ops.reduce((value, op) => {
      if (op.op === 'set') return applyPathOp(value, op, schema)
      const parent = op.path.slice(0, -1).reduce<unknown>((node, key) => member(node, key), value)
      if (Array.isArray(parent)) return applyPathOp(value, op, schema)
      const inherited = op.path.reduce<unknown>((node, key) => member(node, key, true), base)
      return applyPathOp(value, inherited === undefined ? op : { op: 'set', path: op.path, value: inherited }, schema)
    }, current), expectedRevision, ops.map(op => op.path))
  }

  private async write(
    ns: string,
    change: (current: Record<string, unknown>, base: Record<string, unknown>, schema: z) => Record<string, unknown>,
    expected?: number, paths: readonly (readonly string[])[] = [],
  ): Promise<void> {
    const entry = this.ownerContext.configEditor.entries().find(row => row.options.id === ns)
    const schema = entry === undefined ? undefined : this.schema(entry)
    if (entry === undefined || schema === undefined) throw new Error(`No configurable plugin entry "${ns}"`)
    const form = volatileForm(schema)
    if (form === undefined) throw new Error(`Plugin entry "${ns}" has no volatile fields`)
    for (const path of paths) {
      if (path.length && !isVolatilePath(schema, path)) throw new Error(`Config field "${path.join('.')}" is not volatile`)
    }
    await this.ownerContext.configEditor.edit(entry, (raw, inherited) => {
      const descriptor = this.describe().find(row => row.ns === ns)
      if (descriptor === undefined) throw new Error(`Plugin entry "${ns}" is no longer configurable`)
      if (expected !== undefined && descriptor.revision !== expected) {
        throw new SettingsConflictError(ns as SettingsNamespace, expected, descriptor.revision)
      }
      const current = projectForm(form, raw) as Record<string, unknown>
      const base = projectForm(form, inherited) as Record<string, unknown>
      const next = cloneJsonShaped(change(current, base, schema))
      const validatePaths = (value: Record<string, unknown>, node: z, path: string[] = []): void => {
        for (const [key, child] of Object.entries(value)) {
          const target = [...path, key]
          if (isVolatilePath(schema, target)) continue
          const fields = node.dict as Record<string, z>
          const field = Object.hasOwn(fields, key) ? fields[key] : undefined
          if (isPlainObject(child) && field !== undefined) validatePaths(child, field, target)
          else throw new Error(`Config field "${target.join('.')}" is not volatile`)
        }
      }
      validatePaths(next, form)
      const strip = (value: Record<string, unknown>, node: z, path: string[] = []): Record<string, unknown> => {
        if (isVolatilePath(schema, path)) return {}
        const result = { ...value }
        for (const [key, field] of Object.entries(node.dict as Record<string, z>)) {
          const target = [...path, key]
          if (isVolatilePath(schema, target)) Reflect.deleteProperty(result, key)
          else if (isPlainObject(result[key])) result[key] = strip(result[key], field, target)
        }
        return result
      }
      return mergeLayers(strip(raw, form), next) as Record<string, unknown>
    })
    this.describe()
  }

  private schema(entry: Entry): z | undefined {
    const schema = entry.fiber?.runtime?.Config
    return schema !== undefined && 'toJSON' in schema ? schema as z : undefined
  }
}

export default SettingsForms
