/**
 * Typert Loader 集成：为已挂载的插件包提供自动注册。
 *
 * 当某个 Loader 入口挂载时，本插件解析该入口的 package.json；一个导出了
 * `./typert` 的包会被导入其 host 端，并将其 `TYPERT` 清单注册进 `ctx.typert`，
 * 并在入口卸载时撤回注册。显式的 `packages` 覆盖嵌套在另一个 Loader 入口之后
 * 的插件——它们的 Cordis fiber 不携带可解析的包说明符。从 Loader 入口发现、
 * 却没有该导出的包会被静默跳过；一个显式包或已声明产物若已损坏则会显式失败——
 * 汇总进本插件对既有入口的激活抛出，稳态下则收敛为每个包一条已记录的错误。
 *
 * 扫描按入口名增量进行。每次 Cordis `internal/plugin` 事件都将对应 fiber 的
 * 入口名标记为脏，一个微任务冲刷再将每个脏名与存活的 loader 入口对账；激活
 * 阶段以当前所有入口为初始脏集合。包判定与已导入的清单按包名缓存且永不失效——
 * 插件集合的变更需重启后生效。
 *
 * 手动 `ctx.typert.register()` 仍可用于不使用 `./typert` 产物的贡献
 * （手写传输线 schema、测试、非 Loader 组合）。
 *
 * @module @deepseek-ai/dsh-typert-loader
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-typert-registry'
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry/types'

/** 命名一个包的 host 端 typert 产物的 package.json exports 键。 */
export const TYPERT_HOST_EXPORT = './typert'

/** Cordis 插件名。 */
export const name = 'typert-loader'
/** Services required before registration: the registry this plugin feeds and the Loader it observes. */
export const inject = ['typert', 'loader']

/** 其拥有插件嵌套在另一个 Loader 入口之后的、额外的包产物。 */
export interface Config {
  /** 必须解析并导出 `./typert` 的精确 npm 包名。 */
  packages?: string[]
}

/** 校验显式包名，并默认仅做 Loader 入口发现。 */
export const Config: z<Config> = z.object({
  packages: z.array(z.string().min(1)).default([]),
})

type ResolvedConfig = Required<Config>

interface TypertArtifact {
  packageName: string
  path: string
}

const MEMBER_KINDS = new Set(['property', 'method', 'getter', 'setter', 'call', 'construct', 'index'])

/** 将 `./typert` 导出解析为相对路径，接受字符串与一层条件导出形式。 */
function typertExportOf(pkgName: string, exportsField: unknown): string | undefined {
  if (typeof exportsField !== 'object' || exportsField === null) return undefined
  const target = (exportsField as Record<string, unknown>)[TYPERT_HOST_EXPORT]
  if (target === undefined) return undefined
  if (typeof target === 'string') return target
  if (typeof target === 'object' && target !== null) {
    const fallback = (target as Record<string, unknown>).default
    if (typeof fallback === 'string') return fallback
  }
  throw new Error(`typert-loader: ${pkgName} exports["${TYPERT_HOST_EXPORT}"] must be a string or an object with a string default`)
}

/**
 * Narrow a dynamically imported typert module's `TYPERT` export to a
 * contribution owned by `pkgName`. This is the module/file boundary: the
 * manifest crosses from a build artifact into the typed registry. Dispatch
 * facts and eager projection fields are checked; computed tool projections
 * remain lazy until a consumer requests them. Failures name the package and defect.
 * @param pkgName - the package whose typert face was imported.
 * @param exported - the module's `TYPERT` export.
 * @returns the validated contribution.
 */
export function validateTypertManifest(pkgName: string, exported: unknown): TypertContribution {
  if (typeof exported !== 'object' || exported === null) {
    throw new Error(`typert-loader: ${pkgName} exports "${TYPERT_HOST_EXPORT}" but its module has no TYPERT manifest object`)
  }
  const manifest = exported as Record<string, unknown>
  if (manifest.package !== pkgName) {
    throw new Error(
      `typert-loader: ${pkgName} TYPERT manifest names package ${JSON.stringify(manifest.package)} — the manifest must be owned by the package that exports it`,
    )
  }
  if (manifest.face !== 'host') {
    throw new Error(`typert-loader: ${pkgName} exports "${TYPERT_HOST_EXPORT}" but TYPERT.face is not "host"`)
  }
  if (!Array.isArray(manifest.schemas)) {
    throw new Error(`typert-loader: ${pkgName} TYPERT.schemas must be an array`)
  }
  for (const value of manifest.schemas as unknown[]) {
    if (typeof value !== 'object' || value === null) {
      throw new Error(`typert-loader: ${pkgName} TYPERT.schemas contains a non-object schema`)
    }
    const schema = value as Record<string, unknown>
    requireString(pkgName, schema, 'name', 'schema')
    if (typeof schema.create !== 'function') {
      throw new Error(`typert-loader: ${pkgName} TYPERT schema "${schema.name as string}" has no create() factory`)
    }
  }
  const model = requireObject(pkgName, manifest.model, 'TYPERT.model')
  const services = requireArray(pkgName, model.services, 'TYPERT.model.services')
  const events = requireArray(pkgName, model.events, 'TYPERT.model.events')
  const objects = requireArray(pkgName, model.objects, 'TYPERT.model.objects')
  for (const value of services) {
    const service = requireObject(pkgName, value, 'service')
    requireDocumentation(pkgName, service, 'service')
    requireString(pkgName, service, 'key', 'service')
    requireString(pkgName, service, 'exportName', 'service')
    requireMembers(pkgName, service.members, `service "${service.key as string}"`)
    requireTypes(pkgName, service.types, `service "${service.key as string}"`)
  }
  for (const value of events) {
    const event = requireObject(pkgName, value, 'event')
    requireDocumentation(pkgName, event, 'event')
    requireString(pkgName, event, 'name', 'event')
    requireString(pkgName, event, 'signature', `event "${event.name as string}"`)
    if (event.mode !== undefined && typeof event.mode !== 'string') {
      throw new Error(`typert-loader: ${pkgName} event "${event.name as string}" mode must be a string`)
    }
  }
  for (const value of objects) {
    const object = requireObject(pkgName, value, 'object')
    requireDocumentation(pkgName, object, 'object')
    requireString(pkgName, object, 'name', 'object')
    requireString(pkgName, object, 'exportName', 'object')
    requireMembers(pkgName, object.members, `object "${object.name as string}"`)
    requireTypes(pkgName, object.types, `object "${object.name as string}"`)
  }
  for (const value of requireArray(pkgName, manifest.invocations, 'TYPERT.invocations')) {
    requireInvocation(pkgName, value)
  }
  return manifest as unknown as TypertContribution
}

function requireObject(pkgName: string, value: unknown, subject: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`typert-loader: ${pkgName} ${subject} must be an object`)
  }
  return value as Record<string, unknown>
}

function requireArray(pkgName: string, value: unknown, subject: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`typert-loader: ${pkgName} ${subject} must be an array`)
  return value
}

function requireString(pkgName: string, value: Record<string, unknown>, key: string, subject: string): void {
  if (typeof value[key] !== 'string' || value[key].length === 0) {
    throw new Error(`typert-loader: ${pkgName} ${subject} has a missing or empty ${key}`)
  }
}

function requireOptionalString(pkgName: string, value: Record<string, unknown>, key: string, subject: string): void {
  if (value[key] !== undefined && typeof value[key] !== 'string') {
    throw new Error(`typert-loader: ${pkgName} ${subject}.${key} must be a string`)
  }
}

function requireDocumentation(pkgName: string, value: Record<string, unknown>, subject: string): void {
  requireArray(pkgName, value.tags, `${subject}.tags`)
  for (const key of ['description', 'summary', 'jsDoc'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') {
      throw new Error(`typert-loader: ${pkgName} ${subject}.${key} must be a string`)
    }
  }
}

function requireMembers(pkgName: string, value: unknown, subject: string): void {
  for (const item of requireArray(pkgName, value, `${subject}.members`)) {
    const member = requireObject(pkgName, item, `${subject} member`)
    requireString(pkgName, member, 'name', `${subject} member`)
    requireString(pkgName, member, 'signature', `${subject} member`)
    if (typeof member.kind !== 'string' || !MEMBER_KINDS.has(member.kind)) {
      throw new Error(`typert-loader: ${pkgName} ${subject} member "${member.name as string}" has invalid kind`)
    }
  }
}

function requireTypes(pkgName: string, value: unknown, subject: string): void {
  for (const item of requireArray(pkgName, value, `${subject}.types`)) {
    const type = requireObject(pkgName, item, `${subject} type`)
    requireString(pkgName, type, 'name', `${subject} type`)
    requireString(pkgName, type, 'declaration', `${subject} type`)
  }
}

function requireInvocation(pkgName: string, value: unknown): void {
  const invocation = requireObject(pkgName, value, 'invocation')
  for (const key of ['id', 'service', 'namespace', 'method'] as const) {
    requireString(pkgName, invocation, key, 'invocation')
  }
  const id = invocation.id as string
  requireOptionalString(pkgName, invocation, 'description', `invocation "${id}"`)
  if (invocation.mode !== undefined && invocation.mode !== 'stream') {
    throw new Error(`typert-loader: ${pkgName} invocation "${id}" mode must be "stream" when present`)
  }
  const receiver = requireObject(pkgName, invocation.invocation, `invocation "${id}" receiver`)
  if (receiver.kind === 'context') {
    requireString(pkgName, receiver, 'context', `invocation "${id}" Context receiver`)
    requireString(pkgName, receiver, 'wire', `invocation "${id}" Context receiver`)
    requireStrictCodec(pkgName, receiver.codec, `invocation "${id}" Context codec`)
  } else if (receiver.kind !== 'direct') {
    throw new Error(`typert-loader: ${pkgName} invocation "${id}" receiver kind must be "direct" or "context"`)
  }
  const wires = new Set<string>()
  const parameters = new Map<string, Record<string, unknown>>()
  let lookupCount = 0
  for (const valueParameter of requireArray(pkgName, invocation.parameters, `invocation "${id}" parameters`)) {
    const parameter = requireObject(pkgName, valueParameter, `invocation "${id}" parameter`)
    requireString(pkgName, parameter, 'name', `invocation "${id}" parameter`)
    requireString(pkgName, parameter, 'wire', `invocation "${id}" parameter`)
    requireOptionalString(pkgName, parameter, 'description', `invocation "${id}" parameter`)
    const wire = parameter.wire as string
    if (wires.has(wire)) {
      throw new Error(`typert-loader: ${pkgName} invocation "${id}" repeats wire field "${wire}"`)
    }
    wires.add(wire)
    if (parameter.source === 'lookup') {
      lookupCount += 1
      requireString(pkgName, parameter, 'lookup', `invocation "${id}" lookup parameter`)
    } else if (parameter.source === 'json') {
      if (parameter.lookup !== undefined) {
        throw new Error(`typert-loader: ${pkgName} invocation "${id}" JSON parameter declares a lookup`)
      }
    } else {
      throw new Error(`typert-loader: ${pkgName} invocation "${id}" parameter source must be "json" or "lookup"`)
    }
    parameters.set(wire, parameter)
    requireStrictCodec(pkgName, parameter.codec, `invocation "${id}" parameter codec`)
    if (parameter.strictCodec !== undefined) requireStrictCodec(pkgName, parameter.strictCodec, `invocation "${id}" strict input codec`)
  }
  if (invocation.cancellation !== undefined) {
    const cancellation = requireObject(pkgName, invocation.cancellation, `invocation "${id}" cancellation`)
    if (cancellation.parameter !== 'signal') {
      throw new Error(`typert-loader: ${pkgName} invocation "${id}" cancellation parameter must be "signal"`)
    }
  }
  if (invocation.scope !== undefined) {
    if (receiver.kind !== 'direct') {
      throw new Error(`typert-loader: ${pkgName} invocation "${id}" Context receiver cannot declare a direct scope projection`)
    }
    const scope = requireObject(pkgName, invocation.scope, `invocation "${id}" scope`)
    requireString(pkgName, scope, 'context', `invocation "${id}" scope`)
    requireString(pkgName, scope, 'wire', `invocation "${id}" scope`)
    const parameter = parameters.get(scope.wire as string)
    if (lookupCount !== 1 || parameter?.source !== 'lookup' || parameter.lookup !== scope.context) {
      throw new Error(
        `typert-loader: ${pkgName} invocation "${id}" scope wire "${scope.wire as string}" must select its only lookup parameter`,
      )
    }
  }
  if (receiver.kind === 'context' && wires.has(receiver.wire as string)) {
    throw new Error(`typert-loader: ${pkgName} invocation "${id}" repeats Context wire field "${receiver.wire as string}"`)
  }
  requireStrictCodec(pkgName, invocation.result, `invocation "${id}" result codec`)
  if (invocation.input !== undefined || invocation.invoke !== undefined) {
    if (receiver.kind !== 'direct') {
      throw new Error(`typert-loader: ${pkgName} invocation "${id}" input/invoke require a direct receiver`)
    }
    if (typeof invocation.input !== 'function') {
      throw new Error(`typert-loader: ${pkgName} invocation "${id}" has no input() selector`)
    }
    if (typeof invocation.invoke !== 'function') {
      throw new Error(`typert-loader: ${pkgName} invocation "${id}" has no invoke() function`)
    }
  }
  if (invocation.sourceLocation !== undefined) {
    const location = requireObject(pkgName, invocation.sourceLocation, `invocation "${id}" sourceLocation`)
    requireString(pkgName, location, 'file', `invocation "${id}" sourceLocation`)
    for (const key of ['line', 'column'] as const) {
      if (!Number.isInteger(location[key]) || (location[key] as number) < 1) {
        throw new Error(`typert-loader: ${pkgName} invocation "${id}" sourceLocation.${key} must be a positive integer`)
      }
    }
  }
}

function requireSchemaProjection(pkgName: string, value: Record<string, unknown>, subject: string): void {
  if (typeof value.create !== 'function') {
    throw new Error(`typert-loader: ${pkgName} ${subject} has no create() factory`)
  }
  // 检查提供的数据，但不调用工厂缓存的投影 getter。
  const fields = Object.getOwnPropertyDescriptors(value)
  for (const key of ['description', 'jsonSchemaError']) {
    const field: unknown = fields[key]?.value
    if (field !== undefined && typeof field !== 'string') {
      throw new Error(`typert-loader: ${pkgName} ${subject}.${key} must be a string`)
    }
  }
  const schema: unknown = fields.jsonSchema?.value
  if (schema !== undefined) requireObject(pkgName, schema, `${subject}.jsonSchema`)
}

function requireStrictCodec(pkgName: string, value: unknown, subject: string): void {
  const codec = requireObject(pkgName, value, subject)
  if (codec.mode !== 'strict') {
    throw new Error(`typert-loader: ${pkgName} ${subject} must use a strict codec`)
  }
  requireString(pkgName, codec, 'typeSymbol', subject)
  for (const method of ['decode', 'encode']) {
    if (codec[method] !== undefined && typeof codec[method] !== 'function') {
      throw new Error(`typert-loader: ${pkgName} ${subject} ${method} must be a function`)
    }
  }
  requireSchemaProjection(pkgName, codec, subject)
}

/**
 * 在激活期间扫描当前的 Loader 入口，随后在本插件生命周期内跟踪入口的
 * 挂载与卸载。
 * @param ctx - 携带 `typert` 与 `loader` 的插件上下文。
 * @param config - 除 Loader 入口外的显式包产物。
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  // 解析锚点：配置树的 baseUrl（即 cordis.yml 目录，其 package 将每个组合的
  // 插件声明为依赖）。本包自身的 URL 会错过 pnpm 隔离 node_modules 下的兄弟包。
  if (ctx.baseUrl === undefined) {
    throw new Error('typert-loader: ctx.baseUrl is unset — the loader needs the config-tree anchor to resolve plugin packages')
  }
  const baseUrl = ctx.baseUrl
  const require = createRequire(baseUrl)
  const configured = new Set((config as ResolvedConfig).packages)

  // 按入口名登记的贡献；释放器撤回该入口的注册。
  const registered = new Map<string, () => Promise<void>>()
  // 按入口名进行的、在途的导入/注册任务。
  const pending = new Map<string, Promise<void>>()
  // 按包名的产物路径。否定判定（无法解析的说明符——
  // 未配置的 loader 内置项与子路径行——或无 typert 导出）被缓存为 null 且
  // 永不失效：插件集合的变更需重启后生效。
  const artifactPath = new Map<string, TypertArtifact | null>()
  // 按包名缓存的、已导入并校验的清单（每个包每个进程仅导入一次）。
  const manifests = new Map<string, Promise<TypertContribution>>()
  const dirty = new Set<string>()
  let flushQueued = false
  let active = true
  ctx.effect(function* () {
    yield () => {
      active = false
      dirty.clear()
    }
  }, 'typert loader lifetime')

  const resolveArtifact = (pkgName: string): TypertArtifact | null => {
    const cached = artifactPath.get(pkgName)
    if (cached !== undefined) return cached
    const firstSlash = pkgName.indexOf('/')
    if (firstSlash >= 0 && (pkgName[0] !== '@' || pkgName.indexOf('/', firstSlash + 1) >= 0)) {
      if (configured.has(pkgName)) {
        throw new Error(
          `typert-loader: configured package "${pkgName}" cannot be resolved from the config tree — add it to the composition package dependencies or remove it from packages`,
        )
      }
      artifactPath.set(pkgName, null)
      return null
    }
    let pkgPath: string
    let pkg: Record<string, unknown> | undefined
    try {
      const packages = ctx.get('pluginPackages')
      const resolvedPackage = packages?.packageOf(pkgName, baseUrl)
      if (packages !== undefined && resolvedPackage === undefined) throw new Error('package is absent from the active resolver')
      pkgPath = resolvedPackage === undefined
        ? require.resolve(`${pkgName}/package.json`)
        : resolvedPackage.manifestPath
      pkg = resolvedPackage?.manifest
    } catch (cause) {
      if (configured.has(pkgName)) {
        throw new Error(
          `typert-loader: configured package "${pkgName}" cannot be resolved from the config tree — add it to the composition package dependencies or remove it from packages`,
          { cause },
        )
      }
      // 不是可解析的包根：loader 内置项（cordis:include）与子路径入口落到这里——
      // 永久不是 typert 贡献者。
      artifactPath.set(pkgName, null)
      return null
    }
    pkg ??= JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>
    const manifestName = typeof pkg.name === 'string' ? pkg.name : pkgName
    const rel = typertExportOf(manifestName, pkg.exports)
    if (rel === undefined && configured.has(pkgName)) {
      throw new Error(`typert-loader: configured package "${pkgName}" does not export "${TYPERT_HOST_EXPORT}"`)
    }
    const resolved = rel === undefined ? null : { packageName: manifestName, path: join(dirname(pkgPath), rel) }
    artifactPath.set(pkgName, resolved)
    return resolved
  }

  const loadManifest = (pkgName: string, path: string): Promise<TypertContribution> => {
    let loading = manifests.get(pkgName)
    if (loading === undefined) {
      loading = import(pathToFileURL(path).href).then(
        (mod: Record<string, unknown>) => validateTypertManifest(pkgName, mod.TYPERT),
        (cause: unknown) => {
          throw new Error(
            `typert-loader: ${pkgName} exports "${TYPERT_HOST_EXPORT}" but importing ${path} failed: ${String(cause)}`,
          )
        },
      )
      manifests.set(pkgName, loading)
    }
    return loading
  }

  const qualifies = (entryName: string): boolean => {
    if (configured.has(entryName)) return true
    for (const entry of ctx.loader.entries()) {
      if (entry.options.name === entryName && entry.fiber !== undefined && !entry.disabled) return true
    }
    return false
  }

  /** Reconcile one entry name against the live loader entries; a mount returns its async task. */
  const processOne = (entryName: string): Promise<void> | undefined => {
    if (!qualifies(entryName)) {
      const dispose = registered.get(entryName)
      if (dispose !== undefined) {
        registered.delete(entryName)
        return dispose()
      }
      return undefined
    }
    if (registered.has(entryName) || pending.has(entryName)) return undefined
    const artifact = resolveArtifact(entryName)
    if (artifact === null) return undefined
    const task = loadManifest(artifact.packageName, artifact.path).then((manifest) => {
      // 入口可能在导入进行期间已卸载（或已重新注册）。
      if (!active || !qualifies(entryName) || registered.has(entryName)) return
      registered.set(entryName, ctx.typert.register(manifest))
    })
    pending.set(entryName, task)
    // 双臂式 settle：裸 .finally() 会制造第二个未被处理的拒绝。
    const settle = (): void => { pending.delete(entryName) }
    void task.then(settle, settle)
    return task
  }

  const flush = (onError: (error: Error) => void): Promise<void>[] => {
    const tasks: Promise<void>[] = []
    for (const entryName of [...dirty]) {
      dirty.delete(entryName)
      try {
        const task = processOne(entryName)
        if (task !== undefined) tasks.push(task.catch((error: unknown) => { onError(toError(error)) }))
      } catch (error) {
        // 稳态：一个损坏的包绝不能毒化其他包；激活阶段会将这些
        // 汇总为一次显式抛出。
        onError(toError(error))
      }
    }
    return tasks
  }

  // 在播种前订阅，以便激活中途到达的入口落入同一脏集合（Set 的幂等性使重叠无害）。
  // 无入口的 fiber 是子插件或手动挂载——绝不可能是 loader 行；O(1) 丢弃。
  ctx.on('internal/plugin', (fiber) => {
    const entryName = fiber.entry?.options.name
    if (entryName === undefined) return
    dirty.add(entryName)
    if (flushQueued) return
    flushQueued = true
    queueMicrotask(() => {
      flushQueued = false
      if (!active) return
      for (const task of flush((err) => { ctx.logger.error(err) })) void task
    })
  })

  // 激活阶段：初始扫描就是针对当前入口的增量路径；已加载入口中某个畸形的
  // typert 贡献者会被汇总为一次显式抛出（导致 Loader fiber 失败；启动扫描会报告它）。
  for (const packageName of configured) dirty.add(packageName)
  for (const entry of ctx.loader.entries()) dirty.add(entry.options.name)
  const failures: Error[] = []
  await Promise.all(flush((err) => { failures.push(err) }))
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `typert-loader: ${String(failures.length)} typert contributor(s) failed to register:\n${failures.map(e => `  - ${e.message}`).join('\n')}`,
    )
  }
}

/** 将任意导入或清单失败规整为一个 Error。 */
function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
