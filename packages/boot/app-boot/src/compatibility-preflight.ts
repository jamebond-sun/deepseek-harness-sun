/** 位于 DSH 拥有的组合入口处的兼容性检查；无需 Loader 插桩。 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, extname, isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { applyEntryPatches, entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { load } from 'js-yaml'
import { resolvePluginResource } from './package-meta.ts'
import { barePackageName } from './profile-resolution/resolver.ts'
import type {} from './profile-resolution/service.ts'
import type {} from './profile-context.ts'
import { evaluatePluginCompatibility, pluginCompatibilityWarning } from './plugin-compatibility.ts'
import { readProfileCompatibility } from './profile-compatibility.ts'

function readManifest(filename: string): object {
  return JSON.parse(readFileSync(filename, 'utf8')) as object
}

/** 通过 profile 的日志记录器，渲染一个 Include 本会报告的补丁措辞。 */
function patchWarning(ctx: Context): (message: string, ...args: unknown[]) => void {
  return (message, ...args) => {
    let index = 0
    ctx.logger.warn(message.replace(/%C/g, () => JSON.stringify(args[index++])))
  }
}

function manifestOf(ctx: Context, name: string, parentURL: string): object | undefined {
  if (name.startsWith('cordis:')) return undefined
  const specifier = name.startsWith('#') ? resolvePluginResource(name, parentURL) : name
  const packages = ctx.get('pluginPackages')
  const pkg = packages?.packageOf(specifier, parentURL)
  if (pkg !== undefined) return readManifest(pkg.manifestPath)
  const bare = barePackageName(specifier)
  if (bare !== undefined && packages === undefined) {
    // 没有包服务的嵌入器会像 `packageDirFromParent` 那样回退到 Node 自身的查找。
    for (const path of createRequire(parentURL).resolve.paths(bare) as string[]) {
      const filename = join(path, bare, 'package.json')
      if (existsSync(filename)) return readManifest(filename)
    }
  }
  if (!isAbsolute(specifier) && !specifier.startsWith('.') && !specifier.startsWith('file:')) return undefined
  const url = isAbsolute(specifier) ? pathToFileURL(specifier) : new URL(specifier, parentURL)
  let dir: string
  try { dir = dirname(realpathSync(fileURLToPath(url))) }
  catch (error) {
    // 本 profile 无法解析的一行是 Loader 要报告的导入失败，而非一个兼容性判定。
    if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(String((error as NodeJS.ErrnoException).code))) return undefined
    throw error
  }
  while (true) {
    try { return readManifest(join(dir, 'package.json')) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(dir)
      if (parent === dir) return undefined
      dir = parent
    }
  }
}

/** 在所属的 DSH 调用方将这些行传给 Loader 之前，准备 profile 或预设行。
 * 只有兼容性冲突才会拒绝一行：清单无法被解析的条目保留 Loader 自身的导入失败。一条被拒绝的
 * 普通行获得 `disabled`；一个触及被拒绝插件的原生 Include 会作为一个整体被拒绝，因为它的文件
 * 永远不会被重写。
 * @param ctx 携带启动器拥有的 profile 事实的上下文；非 profile 上下文保留它们的行。
 * @param entries 补丁组合之后的完整有效条目列表。
 * @param parentURL 将要导入这些行的树的解析基址。
 * @param binName 针对被拒绝行的诊断前缀；默认为 `dsh`。
 * @returns 不兼容条目被拒绝的分离行；只读取一次 profile 兼容性文件。
 * @throws 当兼容性权限畸形，或 profile 组合缺少解析基址时抛出。
 */
export function prepareProfileEntries(
  ctx: Context, entries: readonly EntryOptions[], parentURL: string | undefined, binName = 'dsh',
): EntryOptions[] {
  // 准入在组合树挂载之前运行，因此尚不存在插件拥有的日志记录导出器；组合阶段的诊断像
  // profile 启动器的跳过 bundle 报告那样被输出到 stderr。
  return preflight(ctx, entries, parentURL, (row, reason) => {
    // 预设行可省略 id，而 bundle 行的名称是其已解析的模块 URL。
    const label = typeof row.id === 'string' ? `row ${JSON.stringify(row.id)}` : row.name
    process.stderr.write(`${binName}: disabling profile plugin ${label}: ${reason}\n`)
  }).rows
}

/** 每个被拒绝行被调用一次的拒绝报告器。 */
type DenialReporter = (row: EntryOptions, reason: string) => void

function preflight(
  ctx: Context, entries: readonly EntryOptions[], parentURL: string | undefined, report: DenialReporter,
) {
  const rows = structuredClone(entries) as EntryOptions[]
  const profile = ctx.get('profileContext')
  if (profile === undefined) return { rows, blocked: false }
  if (parentURL === undefined) throw new Error('Profile compatibility preflight requires a resolution base')
  // 一份受损的权限文件不授权任何内容，但它不得阻止 profile 启动。
  const { exemptions, warnings } = readProfileCompatibility(profile.dir)
  for (const warning of warnings) process.stderr.write(`${warning}\n`)
  const includes = new Set<string>()
  /** 只有兼容性冲突才会拒绝一行；任何其它失败都保留 Loader 自身的诊断。 */
  const denial = (row: EntryOptions, base: string): string | undefined => {
    try {
      const manifest = manifestOf(ctx, row.name, base)
      if (manifest === undefined) return undefined
      const issue = evaluatePluginCompatibility(manifest, exemptions)
      return issue === undefined || issue.exempted ? undefined : pluginCompatibilityWarning(issue)
    } catch (error) {
      // 无法被读取或校验的要求元数据会被拒绝，而非被悄悄接纳。
      /* v8 ignore next -- 这里使用的每个读取器与解析器都以 Error 拒绝。 */
      const detail = error instanceof Error ? error.message : String(error)
      return `its declared dsh requirements cannot be validated: ${detail}`
    }
  }
  const deny = (row: EntryOptions, reason: string): void => {
    row.disabled = true
    if (row.group) row.group = false
    report(row, reason)
  }
  const check = (rows: EntryOptions[], base: string): boolean => {
    let blocked = false
    for (const row of rows) {
      if (row.disabled === true && !row.group) continue
      const conflict = denial(row, base)
      if (conflict !== undefined) {
        deny(row, conflict)
        blocked = true
        continue
      }
      // 使一行成为另一棵树载体的，是 `group` 标记而非模块名。
      if ((row.group === true || row.name === 'cordis:group' || row.name === '@deepseek-ai/cordis-plugin-group')
        && Array.isArray(row.config) && check(row.config as EntryOptions[], base)) blocked = true
      if (row.name !== 'cordis:include' && row.name !== '@deepseek-ai/cordis-plugin-include') continue
      const reached = includedConflicts(row, base)
      if (reached !== undefined) {
        deny(row, reached)
        blocked = true
      }
    }
    return blocked
  }
  /** 一个原生 Include 是否触及一个被拒绝的插件；不可读者没有兼容性意见。 */
  const includedConflicts = (row: EntryOptions, base: string): string | undefined => {
    const config = row.config as { path?: unknown; patches?: PatchOptions[]; initial?: EntryOptions[] } | undefined
    if (typeof config?.path !== 'string' || !['.yml', '.yaml', '.json'].includes(extname(config.path))) {
      // 一个动态的 Include 由 Include 插件自身解析；本次遍历无法判定它的行。
      return undefined
    }
    const requested = isAbsolute(config.path) ? config.path : fileURLToPath(new URL(config.path, base))
    const filename = existsSync(requested) ? realpathSync(requested) : requested
    if (includes.has(filename)) return undefined
    includes.add(filename)
    try {
      let data: unknown
      try { data = load(readFileSync(filename, 'utf8'), { schema: entryListSchema }) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || config.initial === undefined) return undefined
        data = config.initial
      }
      if (!Array.isArray(data)) return undefined
      const children = applyEntryPatches(data as EntryOptions[], config.patches, patchWarning(ctx))
      return check(children, pathToFileURL(filename).href)
        ? `its included file ${filename} reaches an incompatible plugin, and that file is never rewritten`
        : undefined
    } finally {
      includes.delete(filename)
    }
  }
  return { rows, blocked: check(rows, parentURL) }
}

/** 将兼容性策略应用到 profile 空根之上的完整补丁组合。
 * 调用方传入 profile 的每一层补丁，因为本函数针对那个空根返回一条插入补丁：一个非空的
 * 根配置会按 id 丢失调用方的覆盖补丁。
 * @param ctx 由启动器准备好的 profile 上下文。
 * @param patches 原始的、有序的 profile 补丁；它们保持不变。
 * @param parentURL 根 Include 的解析基址。
 * @param binName 针对被拒绝行的诊断前缀；默认为 `dsh`。
 * @returns 针对 profile 的一条已准备好的插入补丁，或针对非 profile 调用方的原始补丁。
 */
export function prepareProfilePatches(
  ctx: Context, patches: PatchOptions[], parentURL: string, binName = 'dsh',
): PatchOptions[] {
  if (ctx.get('profileContext') === undefined) return patches
  const entries = applyEntryPatches([], patches, patchWarning(ctx))
  const rows = prepareProfileEntries(ctx, entries, parentURL, binName)
  return rows.length === 0 ? [] : [{ insert: rows }]
}
