/**
 * `dsh` profile 共享的启动粘合层，包括由 Python 运行时 wheel 打包的 CLI：加载被 gitignore 的
 * `.env`、安装“失败即报错”的 Loader 守卫、解析配置路径（感知快照）、从 Harness home（`~/.dsh`）
 * 加载可选的用户补丁层、将其路径解析器暴露给
 * 配置表达式，并针对叶子 `cordis.yml` 驱动 Cordis Loader，直到整棵树稳定。
 * @module @deepseek-ai/dsh-app-boot
 */

import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import { inspect, parseEnv } from 'node:util'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { Context, type Fiber, type FiberState } from '@deepseek-ai/cordis'
import Loader, { type Entry, type EntryGroup, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import Include, { applyEntryPatches, entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import { dshHomePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { createLaunchEnvironmentSnapshot, type LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
export { readBundlePatches, readProfilePatches, resolveTelemetryPatch, type ProfileContext, type ProfilePnpmInvocation } from './profile-context.ts'
export { sanitizeProfile } from './profile-sanitize.ts'
export { getDshRuntimeVersion, evaluatePluginCompatibility, pluginCompatibilityWarning, type PluginCompatibility } from './plugin-compatibility.ts'
export {
  PROFILE_COMPATIBILITY_FILENAME, readProfileCompatibility, readProfileVersionExemptions,
  setProfileVersionExemption, type ProfileCompatibility,
} from './profile-compatibility.ts'
import { prepareProfilePatches } from './compatibility-preflight.ts'
import { ProfileRuntimeResolution, type RuntimeResolution } from './profile.ts'
import { ResolutionRestartRequired } from './profile-resolution/resolver.ts'
export { prepareProfileEntries, prepareProfilePatches } from './compatibility-preflight.ts'
export { readPluginMeta, resolvePluginResource } from './package-meta.ts'
export { ON_DEMAND_BUNDLES, OFFICIAL_ON_DEMAND_CATALOG, type OfficialBundleCatalogEntry } from './official-bundles.ts'
export { generateConfigSchema, type ConfigSchemaDump, type NativeConfigSchema } from './config-schema/index.ts'
export { createConfigProjector, LOADER_EXPRESSION_SCHEMA, type ConfigProjection } from './config-schema/projector.ts'
export { isNativeConfigSchema } from './config-schema/native.ts'

export {
  readProfilePlugins, reconcileProfilePlugins, writeProfileBundles,
  type ProfilePluginLocation, type ProfilePluginDependency, type ProfilePluginInventory, type ProfilePluginReconciliation,
} from './profile-plugins.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 供 Loader `!!js` 配置表达式使用的 Harness-home 路径解析器。 */
    dshHomePath?: typeof dshHomePath
  }

  interface Events {
    /**
     * Profile 补丁已被协调进正在运行的 Loader 树：每次条目更新都已落定，且没有引入
     * 新的非活动条目。不携带差异；监听器重新读取 Loader 条目。
     * @mode emit
     */
    'app-boot/config-reload'(): void
  }
}

export {
  composeEntries,
  createRuntimeResolution,
  ProfileRuntimeResolution,
  DEFAULT_PROFILE_BUNDLES,
  OPTIONAL_BUNDLES,
  bundlePatchFiles,
  bundlePatchPaths,
  initProfile,
  removeLinkProjections,
  loadProfile,
  loadProfileDirectory,
  PROFILE_PATCH_FILENAME,
  PROFILE_TEMPLATES,
  PROFILES_DIR,
  readProfileManifest,
  reportSkippedBundles,
  resolveBundleDir,
  resolveProfileDir,
  writeProfileManifest,
  type Profile,
  type ProfileLayer,
  type SkippedBundle,
  type ProfileManifest,
  type LinkedRoot,
  type RuntimeResolutionOptions,
  type RuntimeResolutionEntry,
  type RuntimeResolution,
  type ProfileTemplate,
} from './profile.ts'
export {
  PluginPackages,
  type PluginPackage,
  type PluginPackagesConfig,
} from './profile-resolution/service.ts'
export { ResolutionRestartRequired } from './profile-resolution/resolver.ts'

/**
 * 解析待启动的配置。Replay 模式会把同一目录下的 `cordis.yml` 基名替换为
 * `cordis.snapshot.yml`；其它模式均保持原路径。
 * @param configPath - 请求的配置路径（绝对路径，或相对 `cwd`）。
 * @param snapshotMode - bin 的 `$DSH_SNAPSHOT` 取值；仅 `'replay'` 会替换
 *   basename。
 * @param cwd - 相对 `configPath` 所基于的解析基准。
 * @returns 待启动配置的绝对路径。
 */
export function resolveConfigPath(
  configPath: string, snapshotMode: string | undefined, cwd: string = process.cwd(),
): string {
  const absolute = resolve(cwd, configPath)
  if (snapshotMode !== 'replay') return absolute
  const dir = dirname(absolute)
  const replayName = basename(absolute).replace(/cordis\.ya?ml$/, 'cordis.snapshot.yml')
  return resolve(dir, replayName)
}

/**
 * 从 `dir` 加载可选的、被 gitignore 的 `.env`。缺失文件会回退到
 * 进程环境；其它读取失败通过 `warn` 报告。
 * @param binName - warn 行上的诊断前缀。
 * @param dir - 要加载其 `.env` 的目录。
 * @param warn - 单行配置错误的诊断输出目标。
 */
export function loadEnv(
  binName: string, dir: string = process.cwd(),
  warn: (line: string) => void = line => void process.stderr.write(line),
): void {
  try {
    process.loadEnvFile(resolve(dir, '.env'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
      warn(`${binName}: failed to load .env: ${String(error)}\n`)
    }
    // ENOENT（无 .env）无妨 —— 依赖进程环境。
  }
}

/** 任何被发现的文件都不得设置的精确名称。 */
const BOOTSTRAP_NAMES = new Set([
  // 进程启动与模块解析。
  'PATH', 'HOME', 'USERPROFILE', 'SHELL',
  'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS',
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT',
  // 解释器启动钩子。
  'BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS',
  'PERL5OPT', 'PERL5LIB', 'PYTHONSTARTUP', 'PYTHONPATH', 'RUBYOPT', 'RUBYLIB',
  'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS',
  'PYTHONHOME',
  // 版本控制钩子、配置重定向，以及环境命令选择器。
  'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_EXTERNAL_DIFF', 'GIT_PAGER', 'GIT_EDITOR',
  'GIT_ASKPASS', 'SSH_ASKPASS',
  'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_COUNT',
  'EDITOR', 'VISUAL', 'PAGER', 'BROWSER',
  // 网络可达性与信任。
  'DEEPSEEK_BASE_URL', 'DEEPSEEK_SEARCH_BASE_URL',
  'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
  'NODE_TLS_REJECT_UNAUTHORIZED',
])

/** 任何被发现的文件都不得设置的前缀。 */
const BOOTSTRAP_PREFIXES = ['DSH_', 'XDG_', 'DYLD_', 'BASH_FUNC_']

/**
 * Harness-home `.env` 单独可以设置的引导名称。代理会选择每个请求所走的路由，因此
 * 随克隆一起到达的调用方目录文件会持续拒绝它们；home 文件是用户自己的，而 `DSH_HOME`
 * 本身也仅限于引导阶段，所以没有任何 `.env` 能重新定位这项豁免。同一组中的 CA 与 TLS
 * 名称在所有位置都保持被拒绝：它们改变的是被信任的对象，而非流量的去向。
 */
const HOME_LAYER_PROXY_NAMES = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'])

/**
 * 一个变量是否只能来自继承的进程环境，因为它会改变进程、运行时、
 * 版本控制或网络引导。Harness-home 文件另外还允许 {@link HOME_LAYER_PROXY_NAMES}。
 * @param name - 变量名。
 * @returns 当只有继承环境可以提供它时为 true。
 */
function isBootstrapOnly(name: string): boolean {
  const upper = name.toUpperCase()
  return BOOTSTRAP_NAMES.has(upper) || BOOTSTRAP_PREFIXES.some(prefix => upper.startsWith(prefix))
}

/**
 * 解析某个目录的 `.env` 但不应用它，在任何值被具体化之前就拒绝
 * 仅限引导阶段的名称。
 * @param binName - 抛出异常时诊断信息的前缀。
 * @param dir - 要读取其 `.env` 的目录。
 * @param warn - 单行不可读文件诊断的输出目标。
 * @param home - 已解析的 Harness home；当 `dir` 就是它时，接受 {@link HOME_LAYER_PROXY_NAMES}。
 * @returns 解析出的条目；文件缺失或不可读时为 `undefined`。
 * @throws 当文件声明了一个 {@link isBootstrapOnly} 拒绝、且本层不得设置的名称时。
 */
function readEnvLayer(
  binName: string, dir: string, warn: (line: string) => void, home: string,
): { path: string; values: Record<string, string> } | undefined {
  const path = resolve(dir, '.env')
  const isHome = resolve(dir) === home
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
      warn(`${binName}: failed to load .env: ${String(error)}\n`)
    }
    // ENOENT（无 .env）无妨 —— 依赖进程环境。
    return undefined
  }
  // 只解析一次，使校验与具体化使用完全相同的条目。
  const values = parseEnv(content) as Record<string, string>
  for (const name of Object.keys(values)) {
    if (!isBootstrapOnly(name)) continue
    const proxyName = HOME_LAYER_PROXY_NAMES.has(name.toUpperCase())
    if (isHome && proxyName) continue
    // 代理名称拥有其它引导名称所没有的第二条出路，因此其提示信息也据此说明。
    const remedy = proxyName
      ? `export ${name}, or put it in ${resolve(home, '.env')}, which does not travel with a repository`
      : `export ${name} instead of putting it in a .env file`
    throw new Error(
      `${binName}: ${path} sets "${name}", which only the launching environment may set`
      + ' (it decides how this process starts, where its code and instructions load from, or how it'
      + ` reaches the network); ${remedy}`,
    )
  }
  return { path, values }
}

/**
 * 加载产品 CLI 的“继承 > 调用方目录 `.env` > Harness-home
 * `.env`”分层快照。Harness home 在任一文件之前解析；两个文件都在
 * 被应用之前先接受检查，且被接受的值在具体化时不会替换继承值。快照保留了每个值由哪一层提供。
 * @param binName - 诊断信息的前缀。
 * @param cwd - 其 `.env` 作为项目层的调用方目录。
 * @param warn - 单行配置错误诊断的输出目标。
 * @returns 本次运行的冻结环境快照。
 * @throws 当任一文件声明了一个仅限引导阶段的变量时（Harness-home 文件中的
 *   {@link HOME_LAYER_PROXY_NAMES} 除外）。
 */
export function loadLayeredEnv(
  binName: string, cwd: string = process.cwd(),
  warn: (line: string) => void = line => void process.stderr.write(line),
): LaunchEnvironmentSnapshot {
  const home = resolveDshHome()
  const inherited = { ...process.env } as Record<string, string>
  // 先解析两层：被拒绝时不得留下已应用的一个文件。
  const project = readEnvLayer(binName, cwd, warn, home)
  const user = home === resolve(cwd) ? undefined : readEnvLayer(binName, home, warn, home)
  // 应用已检查的值，但不替换更高优先级的名称。
  for (const layer of [project, user]) {
    if (layer === undefined) continue
    for (const [name, value] of Object.entries(layer.values)) {
      if (process.env[name] === undefined) process.env[name] = value
    }
  }
  return createLaunchEnvironmentSnapshot([
    { source: 'process', values: inherited },
    ...project === undefined ? [] : [{ source: 'project-env' as const, path: project.path, values: project.values }],
    ...user === undefined ? [] : [{ source: 'user-env' as const, path: user.path, values: user.values }],
  ])
}

const bootstrapIncludes = new WeakMap<Context, Entry>()

// include 的 YAML 方言（`!!js` 标量会变成表达式节点，由
// Loader 针对每个条目的可注入上下文进行插值），从 include 自身导入，
// 使补丁解析与配置导出永远不会与 include 所挂载的内容脱节。用户补丁层共用它，
// 以便可以引用 `process.env`。
const userPatchesSchema = entryListSchema

/** {@link recomposeProfile} 调用方已完成并需要满足的事项。 */
export interface ProfileRecompositionOptions {
  /** 显式的启用目标，其既有失败也会拒绝本次重组。 */
  readonly requiredIds?: readonly string[]
  /**
   * 在调用方停止其中部分条目之前已经运行的 Loader 条目。每一个不再运行的会重新启动，而
   * 之后失败的每一个都计为一次新的失败。
   */
  readonly running?: readonly Entry[]
}

/** 应用或保留了组合的 {@link recomposeProfile} 的结果。 */
export interface ProfileRecomposition {
  /** 针对未变化的既有非活动条目的诊断。 */
  warnings: string[]
  /** 当运行时解析无法发布一个被移动的包或变更的安装映射时出现。 */
  restartReason?: 'package-moved'
}

/**
 * 从 profile 的完整补丁列表及其运行时解析中重组该 profile。本代不再列出的行会先被移除，且
 * 它们的释放会在其包仍被映射时完成；已安装、可重算的解析的最新一代会被发布；兼容性预检读取已发布的
 * 包；该代被应用到根 Include；已经运行过的条目，以及导入失败的已启用条目，会在更新使它们失去一个
 * 运行中的 fiber 之后启动；并据此判定激活。在应用该代之前发生的失败（包括被解析拒绝、报告 `package-moved`
 * 的发布）会将被移除的行放回原处，重新启动它们，并重新启动那些已运行过的条目。等待某个服务的条目会作为
 * 警告报告，除非它是必需的。补丁通过 `structuredClone` 复制，因此它们不持有任何函数。
 * @param ctx 已启动的根上下文。
 * @param patches 完整的、有序的补丁列表。
 * @param binName 诊断前缀。
 * @param options 调用方已完成并需要满足的事项。
 * @returns 针对未变化的既有非活动条目的诊断，以及被拒绝发布的重启原因。
 * @throws 当根 Include 缺失；最新解析无法读取或发布；准备或
 * Loader 更新被拒绝；或针对新的或变化的失败——一个非活动的必需条目、一个已运行过的失败条目，或
 * 一个释放被拒绝的健康 fiber。
 */
export function recomposeProfile(
  ctx: Context, patches: PatchOptions[], binName: string, options: ProfileRecompositionOptions = {},
): Promise<ProfileRecomposition> {
  return recompose(ctx, patches, binName, options, true)
}

/**
 * 将完整的补丁列表应用到根 Include 并判定激活，保持运行时解析与
 * 导入失败的条目不变。
 * @param ctx 已启动的根上下文。
 * @param patches 完整的、有序的补丁列表。
 * @param binName 诊断前缀。
 * @param requiredIds 显式的启用目标，其既有失败也会拒绝对账。
 * @returns 针对未变化的既有非活动条目的诊断；新的或变化的失败会拒绝。
 */
export async function reconcileProfilePatches(
  ctx: Context, patches: PatchOptions[], binName: string, requiredIds: readonly string[] = [],
): Promise<string[]> {
  return (await recompose(ctx, patches, binName, { requiredIds }, false)).warnings
}

async function recompose(
  ctx: Context, patches: PatchOptions[], binName: string, options: ProfileRecompositionOptions, withResolution: boolean,
): Promise<ProfileRecomposition> {
  const { requiredIds = [], running = [] } = options
  let applying = false
  // 先被停止的行；在应用该代之前发生的失败会将其放回。
  let stopped: StoppedRow[] = []
  try {
    const entry = bootstrapIncludes.get(ctx)
    if (entry === undefined) throw new Error(`${binName}: profile reload requires the root Include entry`)
    // 读取先前的状态不会导入任何东西，因此插件代码不会在下一轮解析发布之前运行。
    const previousFailures = (await inactiveEntries(ctx, false)).map((failure): RecordedFailure => ({
      entry: failure.entry, fiber: failure.entry.fiber, options: JSON.stringify(failure.entry.options),
      // 没有运行中 fiber 的条目尚不存在导入错误；更新之后的判定会读取它。
      diagnostic: failure.entry.fiber?.uid ? reloadDiagnostic(failure) : undefined,
    }))
    // 被移除的条目在其异步释放器完成之前就离开 Loader 存储。
    const previousFibers = [...ctx.loader.entries()].flatMap(row => row.fiber === undefined ? [] : [{
      fiber: row.fiber, failed: row.fiber.state === FIBER_FAILED || row.fiber.state === FIBER_DISPOSED,
    }])
    const { patches: previous = [], ...includeConfig } = entry.options.config as Include.Config
    const current = withResolution ? ctx.get('pluginPackages')?.resolution : undefined
    // 纯数据的解析没有可重新计算的输入。
    const successor = current instanceof ProfileRuntimeResolution ? await current.computeLatestResolution() : undefined
    if (successor !== undefined) {
      // 本代不再列出的行会停止，且它们的释放会在其包仍被映射时完成。
      const listed = rowIds(structuredClone(patches))
      const composed = rowIds(structuredClone(previous))
      // 仅根 Include 树的行；嵌套的 Include 文件拥有自己的 id。
      const tree = entry.subgroup?.tree
      const dropped = [...ctx.loader.entries()]
        .filter(row => row.parent.tree === tree && composed.has(row.options.id) && !listed.has(row.options.id))
      // 被丢弃的组会一并带走它的行。
      const ids = new Set(dropped.map(row => row.options.id))
      const topmost = dropped.filter(row => !ids.has(row.parent.ctx.fiber.entry?.options.id as string))
      // Loader 会标记它停止的行的选项，因此之前所取得的副本正是被恢复的那个。
      stopped = topmost.map(row => ({
        group: row.parent, options: structuredClone(row.options),
        index: row.parent.data.indexOf(row.options),
      }))
      if (topmost.length > 0) {
        const fibers = dropped.flatMap(row => row.fiber === undefined ? [] : [row.fiber])
        for (const row of topmost) {
          // 一个被禁用的行的释放由 Loader 自身负责，因此它不会改写 profile 的配置文件。
          row.options.disabled = true
          row.parent.remove(row.options.id)
        }
        await Promise.allSettled(fibers.map(fiber => fiber.await()))
        await ctx.loader.await()
      }
      try {
        publish(ctx, successor)
      } catch (error) {
        if (!(error instanceof ResolutionRestartRequired)) throw error
        // 该代会等待被拒绝的发布本会改变的那些映射完成。
        return { warnings: [], restartReason: 'package-moved' }
      }
    }
    // 重组会判定启动时所判定的那些行，它们从本 Include 读取的文件解析而来。
    const parentURL = new URL('.', new URL(includeConfig.path, entry.parent.tree.ctx.baseUrl)).href
    const prepared = prepareProfilePatches(ctx, patches, parentURL, binName)
    applying = true
    const retried = [...new Set([...running, ...withResolution ? [...ctx.loader.entries()].filter(importFailed) : []])]
    try {
      await entry.update({ config: { ...includeConfig, patches: prepared } })
    } finally {
      await resume(ctx, retried)
    }
    const results = await Promise.allSettled(previousFibers.map(({ fiber }) => fiber.await()))
    await ctx.loader.await()
    const failures = await inactiveEntries(ctx)
    const introduced = failures.filter((failure) => {
      if (requiredIds.includes(failure.entry.options.id)) return true
      // 等待某个服务的条目会在提供者出现后启动。
      if (failure.outcome.kind === 'pending') return false
      // 在调用方停止它之前已经运行过的条目，即便之前以相同方式失败过，也视为一次新的失败。
      if (running.includes(failure.entry)) return true
      return !previousFailures.some(previous => sameFailure(previous, failure))
    })
    if (introduced.length > 0) throw new Error(activationDiagnostic(binName, introduced, false).trimEnd())
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected' && !previousFibers[index]?.failed) throw result.reason
    }
    ctx.emit('app-boot/config-reload')
    return { warnings: failures.map(reloadDiagnostic) }
  } finally {
    // 在应用该代之前，先被移除的行与调用方停止的条目会重新运行。
    if (!applying && (stopped.length > 0 || running.length > 0)) {
      try {
        // 按原始位置升序排列，可将每一行放回原处。
        for (const { group, options, index } of stopped.toSorted((left, right) => left.index - right.index)) {
          // `create` 会启动该条目但让组的选项列表保持原样；该列表正是下一轮更新用来
          // 移除该行、以及 Include 写回时所对照的内容。
          group.data.splice(index, 0, options)
          await group.create(options)
        }
        await resume(ctx, running)
        // 被恢复的行的 id 与之前运行的那个相同，对 Loader 而言却是一个新的条目。
        const ran = new Set(running.map(row => row.options.id))
        for (const failure of await inactiveEntries(ctx)) {
          if (ran.has(failure.entry.options.id)) ctx.logger.warn(`${binName}: ${reloadDiagnostic(failure)}`)
        }
      } catch (error) {
        // 重组自身的失败即为最终结果。
        ctx.logger.warn(error)
      }
    }
  }
}

/** 重组在改动任何内容之前所记录到的一个非活动条目。 */
interface RecordedFailure {
  entry: Entry
  fiber: Fiber | undefined
  /** 该条目的选项，以 JSON 表示。 */
  options: string
  /** 重载诊断；导入失败时取 `undefined`，可匹配任意诊断。 */
  diagnostic: string | undefined
}

/** 一个非活动条目是否与之前记录的失败相同：相同的条目、fiber 和选项，且诊断相匹配。 */
function sameFailure(previous: RecordedFailure, failure: InactiveEntry): boolean {
  return previous.entry === failure.entry && previous.fiber === failure.entry.fiber
    && previous.options === JSON.stringify(failure.entry.options)
    && (previous.diagnostic === undefined || previous.diagnostic === reloadDiagnostic(failure))
}

/** 重组在发布之前移除的一行，连同它在组中的位置。 */
interface StoppedRow {
  group: EntryGroup
  options: EntryOptions
  index: number
}

/** 一个补丁列表所插入的行的 id，包含组中各行的 id。 */
function rowIds(patches: readonly PatchOptions[]): Set<string> {
  const ids = new Set<string>()
  const visit = (rows: readonly EntryOptions[]): void => {
    for (const row of rows) {
      ids.add(row.id)
      // 一个组的行保存在它自己的配置中。
      if ((row.group === true || row.name === 'cordis:group') && Array.isArray(row.config)) visit(row.config as EntryOptions[])
    }
  }
  // 补丁警告在该代自身被准备时记录。
  visit(applyEntryPatches([], patches as PatchOptions[], () => {}))
  return ids
}

/** 发布一个代，除非它所映射的与已发布的完全一样——那样做只会丢弃包缓存。 */
function publish(ctx: Context, next: RuntimeResolution): void {
  const table = ({ localPackageNames, entries, linkedRoots }: RuntimeResolution): string =>
    JSON.stringify([localPackageNames, entries, linkedRoots])
  const packages = ctx.pluginPackages
  if (table(packages.resolution as RuntimeResolution) !== table(next)) packages.replace(next)
}

/** 运行中的父级之下、已启用却没有 fiber、或保留着失败导入的已释放 fiber 的条目。 */
function importFailed(entry: Entry): boolean {
  return enabledEntry(entry) && entry.parent.ctx.fiber.uid !== null
    && (entry.fiber === undefined || entry.fiber.state === FIBER_DISPOSED)
}

/** 一个条目当前是否已启用；抛出异常的 `disabled` 表达式视为已禁用。 */
function enabledEntry(entry: Entry): boolean {
  try {
    return !entry.disabled
  } catch (_error) {
    // 判定会报告该表达式的失败。
    return false
  }
}

/** 启动 Loader 仍持有、却没有运行中 fiber 的失效条目，然后等待其落定。 */
async function resume(ctx: Context, invalidated: readonly Entry[]): Promise<void> {
  const entries = new Set(ctx.loader.entries())
  // 一个被停止的条目即便选项未变，也会在更新时重新启动；而未变化的 Include 不会更新其行。
  for (const row of invalidated) if (entries.has(row) && !row.fiber?.uid) await row.update({}, false, true)
  await ctx.loader.await()
}

/**
 * 加载一个可选的补丁列表文件：一个顶层的 YAML 数组，包含 Loader 补丁
 * 条目（`@deepseek-ai/cordis-plugin-include` 的 `PatchOptions`）：定位到 id 的配置
 * 覆盖与 `insert` 列表，并允许 `!!js` 表达式。缺失的
 * 文件表示“无层级”；不可读、不可解析或非数组的文件会抛出异常——
 * 一个存在却无法应用的补丁文件属于配置错误，必须在启动时就
 * 大声失败，绝不能悄无声息地跳过。
 * @param binName - 抛出异常时诊断信息的前缀。
 * @param file - 补丁文件的绝对路径。
 * @returns 解析出的补丁；文件不存在时为 `undefined`。
 */
export function loadOptionalPatches(binName: string, file: string): PatchOptions[] | undefined {
  let content: string
  try {
    content = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined
    throw new Error(`${binName}: failed to read patches ${file}: ${String(error)}`)
  }
  return parsePatchList(binName, file, content, 'patches')
}

/**
 * 加载一个必需的覆盖补丁列表：bundle 的 `cordis.patch.yml` 或
 * `--patch <path>` 覆盖层。文件格式与 {@link loadOptionalPatches} 相同，
 * 但缺失文件会抛出异常，因为调用方明确指定了此文件——它的缺失
 * 属于配置错误，而非“无覆盖层”。
 * @param binName - 抛出异常时诊断信息的前缀。
 * @param file - 覆盖文件的绝对路径。
 * @returns 解析出的补丁列表。
 */
export function loadOverlayPatches(binName: string, file: string): PatchOptions[] {
  let content: string
  try {
    content = readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error(`${binName}: failed to read overlay ${file}: ${String(error)}`)
  }
  return parsePatchList(binName, file, content, 'overlay')
}

/** 将被插入的文件系统路径转换为文件 URL，将相对路径锚定在补丁旁边；断言名称保持原样。 */
function anchorInsertedPluginNames(patches: PatchOptions[], file: string): PatchOptions[] {
  const base = dirname(resolve(file))
  const visit = (entry: EntryOptions): void => {
    if (typeof entry.name === 'string' && (isAbsolute(entry.name) || entry.name.startsWith('./') || entry.name.startsWith('../'))) {
      entry.name = pathToFileURL(resolve(base, entry.name)).href
    }
    if (entry.group && Array.isArray(entry.config)) entry.config.forEach(visit)
  }
  for (const patch of patches) patch.insert?.forEach(visit)
  return patches
}
/**
 * 解析一个 Loader 补丁列表：一个顶层的 YAML 数组，包含
 * `@deepseek-ai/cordis-plugin-include` 的 `PatchOptions`（定位到 id 的配置覆盖与
 * `insert` 列表，允许 `!!js` 表达式）。任何无效的字段或值都会抛出，
 * 因为一份根本无法应用的补丁文件属于配置错误；而
 * 目标行缺失的单个补丁仍作为逐条目的 Loader 警告存在，因此
 * 一份跨多个界面共用的覆盖层不必匹配每一棵树。
 * @param binName - 抛出异常时诊断信息的前缀。
 * @param file - 源路径，在错误中以引号包裹。
 * @param content - 文件的文本内容。
 * @param label - 在错误中如何称呼此列表（`patches`、`overlay`）。
 * @returns 解析出的补丁列表。
 */
function parsePatchList(
  binName: string, file: string, content: string, label: string,
): PatchOptions[] {
  let parsed: unknown
  try {
    parsed = yaml.load(content, { schema: userPatchesSchema })
  } catch (error) {
    throw new Error(`${binName}: failed to parse ${label} ${file}: ${String(error)}`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${binName}: ${label} ${file} must be a top-level YAML array of loader patch entries`)
  }
  parsed.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`${binName}: ${label} entry ${index + 1} in ${file} must be a mapping (a loader patch entry)`)
    }
  })
  return anchorInsertedPluginNames(parsed as PatchOptions[], file)
}

/** 一份覆盖补丁列表，源标签会打印在导出注释中。 */
export interface ConfigDumpLayer {
  /** 在导出注释中显示的源名称（文件名或路径）。 */
  label: string
  /** 该层的补丁，来自 {@link loadOverlayPatches} / {@link loadOptionalPatches}。 */
  patches: PatchOptions[]
}

/**
 * 组合已配置的条目列表：用 include 的条目列表方言解析基础配置文件，再通过 include 自身的
 * 补丁算法（`applyEntryPatches`）将每一层的补丁作为一份扁平化的
 * 列表应用——这与 `boot()` 发起的调用相同，因此即便是补丁可见性的边界情况（后一层
 * 针对由普通配置替换引入的组子节点，而单次遍历的 id 索引永远看不到它）也能以完全相同的方式组合——
 * 然后将结果以同一种方言渲染为 YAML（`!!js` 表达式逐字打印，不求值）。行的准入是
 * 后续阶段：兼容性策略拒绝的插件行仍出现在此处，而被拒绝的 bundle 则不贡献任何层。
 *
 * 来自同一文件与补丁层的每一段连续行，前面都会有一行 `# ==` 注释，
 * 标明贡献这些行的文件以及修补过它们的各层，从而
 * 输出始终保持为可加载的 YAML 文档，同时显示哪个段落来自哪个文件。文件与补丁标签
 * 衍生于单次调用的前缀快照（基础 + 层 1..k），按位置做差：补丁算法
 * 只就地重写行或追加行，因此顶层索引可跨快照标识同一行，而
 * 其新增会改变该行的层（配置替换、禁用、组插入）会被列为已修补它。
 *
 * 未匹配到任何行的补丁会通过 `warn`，连同其层标签一并报告，
 * 与 Loader 启动时的警告相呼应。较早层的补丁在包含它们的每个快照中
 * 都看到相同的前置状态，因此每个快照的警告列表都延伸前一个列表，而新增的尾部
 * 属于被添加的层。
 * @param binName - 读取/解析错误时的诊断前缀。
 * @param absoluteConfigPath - `boot()` 本应包含的基础配置文件。
 * @param layers - 按应用顺序排列的覆盖层（后者优先）。
 * @param warn - 被跳过补丁诊断的输出目标；默认为 stderr。
 * @returns 组合后的条目列表，渲染为带
 * 源注释分隔符的 YAML 文档。
 */
export function renderConfigDump(
  binName: string,
  absoluteConfigPath: string,
  layers: ConfigDumpLayer[],
  warn: (line: string) => void = line => void process.stderr.write(`${line}\n`),
): string {
  let content: string
  try {
    content = readFileSync(absoluteConfigPath, 'utf8')
  } catch (error) {
    throw new Error(`${binName}: failed to read config ${absoluteConfigPath}: ${String(error)}`)
  }
  let parsed: unknown
  try {
    parsed = yaml.load(content, { schema: entryListSchema })
  } catch (error) {
    throw new Error(`${binName}: failed to parse config ${absoluteConfigPath}: ${String(error)}`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${binName}: config ${absoluteConfigPath} must be a top-level YAML array of entries`)
  }
  const baseLabel = basename(absoluteConfigPath)
  // YAML 解析产生无类型行；include 在挂载时校验每个条目，
  // 而导出会原样打印文件所持有的内容，因此这里的 `EntryOptions`
  // 是对 `boot()` 本应包含的同名文件的结构性信任。
  const base = parsed as Parameters<typeof applyEntryPatches>[0]
  // snapshot_k = 层 1..k 扁平化后的一次应用，使用 boot 为该前缀传入的
  // 完全相同参数。snapshot_N 即已挂载的组合。
  // 补丁在每次调用时都被克隆：applyEntryPatches 会分离条目
  // 列表，但会以引用方式从补丁列表推入 `insert` 行，因此
  // 跨快照调用共享补丁对象会把较后快照的变更泄漏进较早快照的结果。
  const snapshot = (count: number, warnings: string[]): ReturnType<typeof applyEntryPatches> => {
    const flattened = structuredClone(layers.slice(0, count).flatMap(layer => layer.patches))
    return applyEntryPatches(base, flattened, (message: string, ...args: unknown[]) => {
      // include 通过 cordis 的 printf 风格记录器（`%C` = 代码）记录日志；而
      // 导出没有记录器，因此以内联方式替换为普通的一行。
      let index = 0
      warnings.push(message.replace(/%C/g, () => JSON.stringify(args[index++])))
    })
  }
  let previous = base
  let previousWarnings: string[] = []
  const entryOrigins: { origin: string; patchedBy: string[] }[] = base.map(() => ({ origin: baseLabel, patchedBy: [] }))
  let composed = base
  for (let count = 1; count <= layers.length; count += 1) {
    const layer = layers[count - 1]
    /* v8 ignore next -- count 遍历 1..length，因此该槽位必然存在 */
    if (layer === undefined) continue
    const warnings: string[] = []
    composed = snapshot(count, warnings)
    for (const line of warnings.slice(previousWarnings.length)) {
      warn(`${binName}: [${layer.label}] ${line}`)
    }
    const before = previous.map(entry => JSON.stringify(entry))
    for (let index = 0; index < composed.length; index += 1) {
      if (index >= before.length) entryOrigins.push({ origin: layer.label, patchedBy: [] })
      else if (JSON.stringify(composed[index]) !== before[index]) entryOrigins[index]?.patchedBy.push(layer.label)
    }
    previous = composed
    previousWarnings = warnings
  }
  return groupedDump(composed, entryOrigins)
}

/** 将组合后的行渲染为按连续段分组、每段带一条源与补丁注释的形式。 */
function groupedDump(
  composed: readonly unknown[],
  entryOrigins: readonly { origin: string; patchedBy: string[] }[],
): string {
  const lines: string[] = []
  let currentLabel: string | undefined
  let group: unknown[] = []
  const flush = (): void => {
    if (currentLabel === undefined || group.length === 0) return
    lines.push(`# == ${currentLabel}`)
    lines.push(yaml.dump(group, { schema: entryListSchema, noRefs: true }).trimEnd())
    group = []
  }
  for (let index = 0; index < composed.length; index += 1) {
    const record = entryOrigins[index]
    /* v8 ignore next -- 该数组按构造与 composed 索引对齐 */
    if (record === undefined) continue
    const label = record.patchedBy.length === 0
      ? record.origin
      : `${record.origin}, patched by ${record.patchedBy.join(', ')}`
    if (label !== currentLabel) {
      flush()
      currentLabel = label
    }
    group.push(composed[index])
  }
  flush()
  return lines.join('\n') + '\n'
}

/**
 * 挂载并记住 app 启动与用户补丁层 HMR 所使用的精确根 Include 条目。
 * @param ctx - 携带已初始化 Loader 服务的上下文。
 * @param absoluteConfigPath - 绝对的 YAML 或 JSON 配置路径。
 * @param patches - 初始的 app 与用户补丁，按顺序应用。
 * @param bareModuleBaseUrl - 裸包名可选的已安装宿主基址；
 * 相对名继续在配置文件旁边解析。
 * @param binName - 被兼容性策略拒绝的 profile 插件的诊断前缀；默认为 `dsh`。
 * @returns 创建的根 Include 条目；当某个界面在
 * 条目创建进行中销毁了整棵树（一并带走 Loader 服务）时，为 `undefined`。
 */
export async function mountRootInclude(
  ctx: Context,
  absoluteConfigPath: string,
  patches: readonly PatchOptions[] = [],
  bareModuleBaseUrl?: string,
  binName = 'dsh',
): Promise<Entry | undefined> {
  ctx.loader.builtins.include = bareModuleBaseUrl === undefined
    ? Include
    : class HostResolvedRootInclude extends Include {
      override import(name: string, getOuterStack?: () => string[]): unknown {
        const specifier = isAbsolute(name) ? pathToFileURL(name).href : name
        if (name.startsWith('.') || name.startsWith('cordis:')) return super.import(specifier, getOuterStack)
        const internal = this.ctx.loader.internal
        /* v8 ignore next -- 内部加载器由 Node 提供；此分支为没有它的假想嵌入者保留了
           原始诊断。 */
        if (internal === undefined) return super.import(specifier, getOuterStack)
        return internal.import(specifier, bareModuleBaseUrl, {})
      }
    }
  // 与之并列的 `cordis:group`：组合正是通过一行 group 为某个提供方及其消费方共同
  // 赋予一个 `isolate` 域，而位于本工作区之外的 agent
  // preset 无法通过名称解析 `@deepseek-ai/cordis-plugin-group`。
  // 两个内建插件都通过环境模块管线加载，因此都不
  // 依赖被包含树自身的说明符解析。
  ctx.loader.builtins.group = Group
  // 固定的 id：引导 include 是 app 粘合层而非配置行，其
  // id 会出现在 Loader 失败链中——随机 id 会让启动
  // 诊断在不同运行间（以及快照夹具中）不稳定。
  // 启动器自身的副本在此准备：兼容性决策必须在根 Include
  // 导入任何内容之前做出，且它们不会改变任何 profile 补丁层、清单或 bundle 列表。
  const prepared = prepareProfilePatches(ctx, [...patches], pathToFileURL(dirname(absoluteConfigPath)).href + '/', binName)
  const includeConfig: Include.Config = {
    path: pathToFileURL(absoluteConfigPath).href,
    ...prepared.length > 0 ? { patches: prepared } : {},
  }
  const rootInclude: EntryOptions = {
    id: 'include',
    name: 'cordis:include',
    config: includeConfig,
  }
  const includeId = await ctx.loader.create(rootInclude)
  const loader = ctx.get('loader')
  if (loader === undefined) return undefined
  const entry = loader.resolve(includeId)
  bootstrapIncludes.set(ctx, entry)
  return entry
}

/** {@link installFailLoud} 转为致命退出的两个进程事件。 */
export type FailLoudEvent = 'unhandledRejection' | 'uncaughtException'

/**
 * {@link installFailLoud} 所需的 `process` 切片——可注入，从而测试
 * 能在不向真实进程注册（或退出）的情况下演练该处理器。
 */
export interface FailLoudProcess {
  on(event: FailLoudEvent, handler: (err: unknown) => void): unknown
  off(event: FailLoudEvent, handler: (err: unknown) => void): unknown
  stderr: { write(chunk: string): unknown }
  /**
   * 终止进程。调用方将其视为运行的终点，正如
   * `process.exit` 那样；一个会返回的假实现让调用方继续，而这
   * 只有测试才会观察到。
   */
  exit(code: number): void
}

// Loader rc.5 会在 fiber 失败后派生并丢弃一个被拒绝的 promise。需将
// 已折叠进启动诊断的确切原因，通过下一次
// 进程拒绝检查点保持可见，以便进程守卫能够合并它们。
const assembledActivationRejections = new Map<unknown, number>()

function retainAssembledRejection(reason: unknown): void {
  assembledActivationRejections.set(reason, (assembledActivationRejections.get(reason) ?? 0) + 1)
}

function releaseAssembledRejection(reason: unknown): void {
  const count = assembledActivationRejections.get(reason)
  if (count === undefined || count === 1) {
    assembledActivationRejections.delete(reason)
  } else {
    assembledActivationRejections.set(reason, count - 1)
  }
}

async function observeLoaderRejectionCheckpoint(reasons: readonly unknown[]): Promise<void> {
  for (const reason of reasons) retainAssembledRejection(reason)
  try {
    await new Promise<void>(resolve => setImmediate(resolve))
  } finally {
    for (const reason of reasons) releaseAssembledRejection(reason)
  }
}

/**
 * {@link installFailLoud} 在无论如何都退出之前，等待其 `release` 钩子的时长。
 * 卡住的释放器只能推迟致命退出，绝不能取消它。
 */
export const FAIL_LOUD_RELEASE_TIMEOUT_MS = 2_000

/**
 * 在启动前安装，以将进程中任意时刻发生的未处理拒绝或未捕获异常，
 * 转化为一条带标签的 stderr 诊断与
 * `exit(1)`。已被 {@link auditStartupEntries} 纳入的拒绝会在其进程检查点期间
 * 被忽略；其余所有拒绝与所有未捕获异常依然致命。在发生任一情况后，控制流
 * 都不会回到失败的操作：只有抛出点才知道哪部分状态是完好的，而
 * 在更新中途抛出的监听器（流的 `'data'` 处理器、半应用的
 * 注册表写入）若被恢复，会留下悄然错误的结果。
 * 事件循环只在 release 钩子落定或超时之前持续运行。
 * 为 ACP 保留，stdout 不被触碰；返回的函数会移除这两个处理器。
 *
 * 诊断采用 `util.inspect(err)` 而非 `err.stack`：一个 `node:fs` 错误的
 * `code`、`syscall`、`path` 以及任意 `cause` 链都是可枚举属性，
 * 而堆栈行会省略它们，它们却正是崩溃报告所需。一旦
 * 安装了处理器，Node 自身便不再打印任何内容，因此这一行
 * 就成了失败的唯一记录。
 *
 * Loader 并发挂载条目，因此当用户界面持有终端时，一个同级条目可能
 * 已经拒绝。直接从处理器退出，会把原始模式、带括号粘贴与键盘协议
 * 遗留在用户的 shell 上，并让一个在途的终端查询应答作为
 * 字面文本落到下一个提示符处。`release` 是终端拥有者交还终端的机会；它在
 * {@link FAIL_LOUD_RELEASE_TIMEOUT_MS} 之下被等待，其
 * 计时器始终保持被引用，因此一个永不落定的释放器无法让 Node 进入
 * 空事件循环并以退出码 0 而非失败收场。
 *
 * 诊断在 release 之前写入，从而挂起或失败的释放器
 * 无法吞掉原因。处理器在 release 运行期间保持安装——
 * 移除它会让第二次并发拒绝变成未捕获并终止进程，在拆除中途
 * 恰好把本要恢复的终端状态抛在一边——因此用一个闩锁保留首次拒绝作为
 * 上报的那一个，并让后续拒绝（包括 release 自身的）落到待定的退出上。
 * @param binName - 致命失败行上的诊断前缀。
 * @param proc - 要注册的进程切片；测试会注入一个假实现。
 * @param release - 退出前等待的可选拆除，由
 *   持有终端的界面用于恢复终端。其自身失败被吞掉，因为待定的致命退出已拥有该结果。
 * @returns 移除这两个处理器的卸载器。
 */
export function installFailLoud(
  binName: string,
  proc: FailLoudProcess = process,
  release?: () => Promise<void> | void,
): () => void {
  let exiting = false
  const report = (err: unknown, label: string): void => {
    // 一个正在进行的 release 已经拥有该退出。吞掉后续失败
    // （包括拆除自身的失败），而不是在真实失败之上再上报一次失败，
    // 或让 Node 在终端恢复之前就终止进程。
    if (exiting) return
    exiting = true
    proc.stderr.write(`${binName}: ${label}: ${inspect(err, { depth: 4, maxArrayLength: 50 })}\n`)
    if (release === undefined) {
      proc.exit(1)
      return
    }
    void (async () => {
      // 必然已赋值：超时 promise 的执行器在竞速构造期间、第一个 await 之前同步运行。
      let timer!: ReturnType<typeof setTimeout>
      try {
        await Promise.race([
          (async () => release())(),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, FAIL_LOUD_RELEASE_TIMEOUT_MS)
          }),
        ])
      } catch {
        // 终端的 release 失败了；下方致命退出才是
        // 要紧的结果，且在它之后不会再有任何报告器运行。
      }
      clearTimeout(timer)
      proc.exit(1)
    })()
  }
  const onRejection = (err: unknown): void => {
    if (assembledActivationRejections.has(err)) return
    // 标签保持稳定：Web profile 期望输出 e2e 测试会匹配它。
    report(err, 'fatal load failure')
  }
  const onException = (err: unknown): void => { report(err, 'fatal uncaught exception') }
  const uninstall = (): void => {
    proc.off('unhandledRejection', onRejection)
    proc.off('uncaughtException', onException)
  }
  proc.on('unhandledRejection', onRejection)
  proc.on('uncaughtException', onException)
  return uninstall
}

/**
 * 取值镜像，因为 Cordis 的 const enum 没有可供导入的运行时对象。
 * 请与 `packages/client/web/src/loader-status.ts` 保持对齐。
 */
const FIBER_PENDING = 0 as FiberState.PENDING
const FIBER_ACTIVE = 2 as FiberState.ACTIVE
const FIBER_FAILED = 3 as FiberState.FAILED
const FIBER_DISPOSED = 4 as FiberState.DISPOSED

/**
 * 其存在即界定一个可用 DSH 应用的条目 id。
 *
 * 该列表是全局的，而非 profile 元数据。缺失或被禁用的 id 不会
 * 影响启动；一个已列出的、处于启用状态的条目必须激活。该列表覆盖
 * 共享的 Agent 执行、应用端点，以及 Web 引导/传输。
 */
const requiredStartupEntryIds = new Set<string>([
  'agent-loop',
  'webserver',
  'web-runtime',
  'modules',
  'connection',
  'headless-runner',
  'acp',
  'sdk-jsonrpc-server',
])

/** 对每个错误一次性渲染插件堆栈、嵌套原因与聚合成员失败。 */
function formatActivationError(error: unknown, stacks = true): string {
  const details: string[] = []
  const seen = new Set<Error>()
  function visit(value: unknown): void {
    if (!(value instanceof Error)) {
      details.push(String(value))
      return
    }
    if (seen.has(value)) return
    seen.add(value)
    details.push(stacks ? value.stack ?? value.message : String(value))
    if (value.cause !== undefined) visit(value.cause)
    if (value instanceof AggregateError) value.errors.forEach(visit)
  }
  visit(error)
  return details.join('\n')
}

interface InactiveEntry {
  /** 用于识别引导 Include 与必需 id 的 Loader 条目。 */
  entry: Entry
  /** 激活错误与缺失的服务在展示时保持区分。 */
  outcome: { kind: 'failed'; error: unknown; phase?: string }
    | { kind: 'pending'; missing: string[] }
}

/** 不保留其 Context 或 Fiber 的非活动插件元数据。 */
interface StartupEntryDiagnostic {
  id: string
  module: string
  required: boolean
  fiberState: FiberState | undefined
  outcome: InactiveEntry['outcome']
}

/** 启动警告或错误的参数，包含没有 Fiber 的导入错误。 */
interface StartupLogRecord {
  ts: number
  name: string
  type: string
  args: readonly unknown[]
}

/** 启动审计失败，带有不可枚举的元数据，且以原始失败作为其 cause。 */
export class StartupError extends Error {
  /** 根配置与启动日志，由 boot 在释放之后附加。 */
  startup?: { configurationPath: string; messages: readonly StartupLogRecord[] }

  /**
   * @param message - 简洁的终端诊断。
   * @param entries - 非活动插件元数据与原始失败值。
   */
  constructor(message: string, readonly entries: readonly StartupEntryDiagnostic[]) {
    const failures = entries.flatMap(({ outcome }) => outcome.kind === 'failed' ? [outcome.error] : [])
    super(message, failures.length > 0 ? { cause: new AggregateError(failures, 'Plugin activation failures') } : undefined)
    Object.defineProperties(this, {
      entries: { enumerable: false },
      startup: { enumerable: false },
    })
  }
}

/** 导入某个条目模块当前抛出的错误；对于此前失败的模块，Node 会从其缓存中返回它。 */
async function importFailure(entry: Entry): Promise<unknown> {
  try {
    await entry.parent.tree.import(entry.options.name)
    return undefined
  } catch (error) {
    return error
  }
}

/**
 * 收集 Loader 激活失败与禁用表达式错误。失败的
 * fiber 会被等待以恢复其记录的拒绝原因，并通过下一次进程拒绝检查点
 * 合并重复的 Loader 通知。导入失败的条目会报告其当前导入所抛出的错误；
 * 若没有 `importNow`，则不会导入任何内容，该条目会报告一次导入失败，但不含导入错误。
 */
async function inactiveEntries(ctx: Context, importNow = true): Promise<InactiveEntry[]> {
  const failures: InactiveEntry[] = []
  const rejectionReasons: unknown[] = []
  for (const entry of ctx.loader.entries()) {
    try {
      if (entry.disabled) continue
    } catch (error) {
      failures.push({ entry, outcome: { kind: 'failed', error, phase: 'disabled expression failed' } })
      continue
    }
    const fiber = entry.fiber
    // 导入失败的条目没有 fiber，或保留其上次激活时已释放的 fiber。
    if (fiber === undefined || fiber.state === FIBER_DISPOSED) {
      const error = importNow ? await importFailure(entry) : undefined
      failures.push({ entry, outcome: error === undefined
        ? { kind: 'failed', error: fiber === undefined ? 'failed to import' : `fiber state ${String(fiber.state)}` }
        : { kind: 'failed', error, phase: 'failed to import' } })
      continue
    }
    const state = fiber.state
    if (state === FIBER_ACTIVE) continue
    if (state === FIBER_FAILED) {
      try {
        await fiber.await()
      } catch (error) {
        rejectionReasons.push(error)
        failures.push({ entry, outcome: { kind: 'failed', error } })
      }
      continue
    }
    if (state === FIBER_PENDING) {
      const missing = Object.keys(fiber.inject).filter(service => fiber.ctx.get(service) === undefined)
      failures.push({
        entry,
        outcome: { kind: 'pending', missing },
      })
    } else {
      failures.push({ entry, outcome: { kind: 'failed', error: `fiber state ${String(state)}` } })
    }
  }
  if (rejectionReasons.length > 0) await observeLoaderRejectionCheckpoint(rejectionReasons)
  return failures
}

/** 渲染一个失败插件的原始错误与激活阶段。 */
function failureDetail(outcome: Extract<InactiveEntry['outcome'], { kind: 'failed' }>, stacks = true): string {
  return `${outcome.phase === undefined ? '' : `${outcome.phase}: `}${formatActivationError(outcome.error, stacks)}`
}

/** 渲染仅针对可选项的警告，不改变启动策略。 */
function activationDiagnostic(
  binName: string,
  failures: readonly InactiveEntry[],
  stacks = true,
): string {
  const noun = failures.length === 1 ? 'entry' : 'entries'
  return `${binName}: warning: ${String(failures.length)} ${noun} did not activate\n${failures.map(failure => inactiveDiagnostic(failure, stacks)).join('\n')}\n`
}

/** 逐条目的重载文本，会经由 Web UI 与 agent 被人阅读，因此不带堆栈帧、只携带错误消息。 */
function reloadDiagnostic(failure: InactiveEntry): string {
  return inactiveDiagnostic(failure, false)
}

/** 用于重载比较与可选警告的、稳定的逐条目文本。 */
function inactiveDiagnostic({ entry, outcome }: InactiveEntry, stacks = true): string {
  const detail = outcome.kind === 'failed' ? failureDetail(outcome, stacks)
    : `pending (waiting for ${outcome.missing.length === 1 ? 'service' : 'services'}: ${outcome.missing.join(', ') || 'unknown'})`
  return `${entry.options.id} (${entry.options.name}): ${detail}`
}

/** 将启动失败与等待中的服务分组，并标记每一个必需条目。 */
function startupDiagnostic(binName: string, failures: readonly InactiveEntry[], required: ReadonlySet<Entry>): string {
  const lines = [`${binName}: startup failed: ${String(required.size)} required ${required.size === 1 ? 'plugin' : 'plugins'} did not activate`]
  const failed = failures.flatMap(({ entry, outcome }) => outcome.kind === 'failed' ? [{ entry, outcome }] : [])
  const pending = failures.flatMap(({ entry, outcome }) => outcome.kind === 'pending' ? [{ entry, outcome }] : [])
  pending.sort((left, right) => Number(required.has(right.entry)) - Number(required.has(left.entry)))
  const label = (entry: Entry): string => `${entry.options.id}${required.has(entry) ? ' (required)' : ''}`
  if (failed.length > 0) {
    lines.push('', `Failed plugins (${String(failed.length)}):`)
    for (const { entry, outcome } of failed) {
      lines.push(`  ${label(entry)}`, `    Package: ${entry.options.name}`)
      lines.push(...failureDetail(outcome).split('\n').map(line => `    ${line}`))
    }
  }
  if (pending.length > 0) {
    const width = Math.max('Plugin'.length, ...pending.map(({ entry }) => label(entry).length)) + 2
    lines.push('', `Plugins waiting for services (${String(pending.length)}):`, `  ${'Plugin'.padEnd(width)}Missing services`)
    for (const { entry, outcome } of pending) {
      lines.push(`  ${label(entry).padEnd(width)}${outcome.missing.join(', ') || 'unknown'}`)
    }
  }
  return lines.join('\n')
}

/**
 * 将 DSH 启动策略应用到已落定的 Loader 树。
 *
 * 来自全局必需列表的非活动条目会拒绝启动。其它
 * 非活动条目会加入该失败诊断，或在没有任何必需条目失败、且成功
 * 的同级条目继续运行的情况下，产生一条警告。
 * 树中缺失的必需 id，以及被禁用的必需条目，都会被忽略。
 * 抛出异常的禁用表达式属于条目失败，而非被禁用的条目。
 * 引导 Include 必须激活，从而不可读或无效的根配置会是致命的。
 * @param ctx - 已落定、待审计 Loader 条目的上下文。
 * @param binName - 启动诊断上的前缀。
 * @param warn - 可选条目警告的输出目标。
 * @returns 在可选警告之后，若必需的启动检查通过。
 * @throws 当引导 Include 或某个必需条目处于非活动状态、或其禁用表达式抛出异常时抛出
 *   {@link StartupError}；其消息也包含可选失败。
 */
export async function auditStartupEntries(
  ctx: Context,
  binName: string,
  warn: (line: string) => void = line => void process.stderr.write(line),
): Promise<void> {
  const failures = await inactiveEntries(ctx)
  const required = new Set(failures.filter(({ entry }) => entry === bootstrapIncludes.get(ctx)
    || requiredStartupEntryIds.has(entry.options.id)).map(({ entry }) => entry))
  if (required.size > 0) {
    throw new StartupError(startupDiagnostic(binName, failures, required), failures.map(({ entry, outcome }) => ({
      id: entry.options.id, module: entry.options.name, required: required.has(entry), fiberState: entry.fiber?.state, outcome,
    })))
  }
  if (failures.length > 0) warn(activationDiagnostic(binName, failures))
}

/**
 * 针对 `absoluteConfigPath` 启动 Loader，并仅在整棵树
 * 落定之后返回。相对条目名在配置目录处解析；
 * 裸包名默认在那儿解析，或在封闭打包运行时的显式
 * `bareModuleBaseUrl` 处解析。引导 include
 * 被静态导入并作为 `cordis:include` 内建插件挂载，通过
 * 环境模块管线（vite/tsx/纯 ESM）加载。包的构建
 * 内嵌了 Include 却让 Loader 保持外部，因此构建出的 include 树与
 * 宿主共享同一个 Loader peer。Loader 的落定会排空条目工作，而不会
 * 拒绝整棵树。最后一次 {@link auditStartupEntries} 调用会拒绝
 * 全局必需列表中的失败，并就已失败的、缺失的与等待中的
 * 条目发出警告，同时成功的同级条目保持活跃。后续的未处理
 * 拒绝仍由 {@link installFailLoud} 覆盖。构建出的二进制需要 Loader 的原生
 * 辅助函数来解析裸插件说明符；相对说明符则不需要。
 * @param binName - 加载失败错误的诊断前缀。
 * @param absoluteConfigPath - 要包含的配置文件；必须已经是绝对路径
 * （参见 {@link resolveConfigPath}）。
 * @param patches - 应用于被包含树之上的可选覆盖补丁
 * （参见 {@link loadOptionalPatches}）；空列表则不挂载任何补丁。
 * @param prepare - 在 Loader 安装之后、任何配置树条目挂载之前运行的
 * 可选宿主设置。
 * @param bareModuleBaseUrl - 裸包名可选的已安装宿主基址；
 * 当宿主（而非配置项目）拥有完整插件集时使用它。
 * @returns 初始启动审计之后的根上下文；或一旦某个界面在启动仍在进行中时
 * 销毁了这棵树，立即返回。
 * @throws 针对非活动必需条目抛出 {@link StartupError}，其消息包含所有非活动插件；
 * 否则在释放部分上下文之后抛出一个带标签的错误——若 `prepare` 在任何配置树
 * 条目挂载之前抛出，则为 `host preparation failed`，之后则为
 * `plugin tree failed to load`。循环 cause 会终止诊断遍历，而不会替换原始 cause。
 */
export async function boot(
  binName: string,
  absoluteConfigPath: string,
  patches?: PatchOptions[],
  prepare?: (ctx: Context) => Promise<void> | void,
  bareModuleBaseUrl?: string,
): Promise<Context> {
  const ctx = new Context()
  const startupLogs: StartupLogRecord[] = []
  // 收集器必须比根上下文的释放更长寿，以保留异步清理错误。
  const diagnostics = new Context()
  diagnostics.logger = ctx.logger
  diagnostics.logger.exporter({
    levels: { default: 2 },
    export: ({ ts, name, type, args }) => {
      if (type === 'warn' || type === 'error') startupLogs.push({ ts, name, type, args })
    },
  })
  // 两个失败标签：`prepare` 在任何配置树条目挂载之前运行，
  // 因此其失败属于宿主设置，而非插件树。
  let stage = 'host preparation failed'
  try {
    ctx.baseUrl = pathToFileURL(dirname(absoluteConfigPath)).href + '/'
    ctx.provide('dshHomePath', dshHomePath)
    // Fiber.update() 会丢弃重启 promise。在 waterfall 返回之前
    // 观察它；激活审计仍会报告失败的 fiber。
    ctx.on('internal/update', (_config, _noSave, next: () => unknown) => {
      void Promise.resolve(next()).catch((error: unknown) => { ctx.logger.error(error) })
    }, { global: true, prepend: true })
    await ctx.plugin(Loader)
    await prepare?.(ctx)
    stage = 'plugin tree failed to load'
    await mountRootInclude(ctx, absoluteConfigPath, patches, bareModuleBaseUrl, binName)
    // 某个界面可能在启动仍在进行、最后一个条目落定之前，就结束并销毁整棵树。Loader 服务会随之
    // 而去，而激活审计描述的是一棵存活的树——在此之后读取 `ctx.loader`
    // 会针对一个“恰好按要求退出”的应用抛出 TypeError。落定之后、审计这棵树之前需重新检查。
    await ctx.get('loader')?.await()
    if (ctx.get('loader') === undefined) return ctx
    await auditStartupEntries(ctx, binName)
    return ctx
  } catch (cause) {
    // 根 fiber 的释放包含每个观察者的清理失败（Cordis
    // fiber.ts 加固），而重复调用会返回已落定的单次结果，
    // 因此这次 await 不会拒绝并替换 `cause`。
    await ctx.fiber.dispose()
    if (cause instanceof StartupError) {
      cause.startup = { configurationPath: absoluteConfigPath, messages: startupLogs }
      throw cause
    }
    const detail = cause instanceof Error ? cause.message : String(cause)
    // 一个包装器可能携带一条激活错误，其原始堆栈标明了失败的插件。
    let deepest: unknown = cause
    const seen = new Set<Error>()
    while (deepest instanceof Error && !seen.has(deepest) && deepest.cause !== undefined) {
      seen.add(deepest)
      deepest = deepest.cause
    }
    const stack = deepest instanceof AggregateError
      ? `\n${deepest.stack ?? deepest.message}\n${deepest.errors.map(error => formatActivationError(error)).join('\n')}`
      : deepest instanceof Error && deepest !== cause ? `\n${deepest.stack ?? deepest.message}` : ''
    throw new Error(`${binName}: ${stage}: ${detail}${stack}`, { cause })
  } finally {
    await diagnostics.fiber.dispose()
  }
}
