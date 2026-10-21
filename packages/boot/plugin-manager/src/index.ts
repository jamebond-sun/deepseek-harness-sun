/** 对当前 profile 的插件与 bundle 的管理，建立在 dsh plugin 的共享操作之上。 */
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { Context } from '@deepseek-ai/cordis'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import z from '@deepseek-ai/schemastery'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { pluginEntryId, readPluginInventory } from '@deepseek-ai/dsh-host-plugin-inventory'
import {
  readPluginMeta, readProfileManifest, resolveBundleDir, loadOverlayPatches, composeEntries,
  readProfilePatches, OPTIONAL_BUNDLES, bundlePatchPaths,
  evaluatePluginCompatibility, readProfileCompatibility, readProfileVersionExemptions,
  setProfileVersionExemption, PROFILE_COMPATIBILITY_FILENAME,
  OFFICIAL_ON_DEMAND_CATALOG, getDshRuntimeVersion, ResolutionRestartRequired,
} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-hmr'
import type { ProfileContext, ProfileManifest } from '@deepseek-ai/dsh-app-boot'
import { bundleManifest, readProfileRegistry, registryArguments, runProfilePnpm, saveManifest, viewProfilePackage } from './operations.ts'
import { classifyInstallFailure } from './install-failure.ts'
import { officialBundleInstallTarget } from './official-install-target.ts'
import { dependencySpec, InvalidInstallSpecError, parseInstallSpec, type ParsedInstallSpec } from './install-spec.ts'
import { attributeFailure, normalizeRegistry, NPMMIRROR_REGISTRY, registryPlan } from './registry.ts'
import { flatten, writePluginEnabled } from './patch.ts'
import { incompatiblePlugin, ManagementFailure } from './failure.ts'
import { approveBuilds, recordPendingBuilds } from './build-approval.ts'
import { checkGithubConnection } from './github-connection.ts'
import type {
  BundleInfo, BundleRowInfo, ChangeResult, InspectOptions, InstallBundleOptions, ManagementError, PackageResult, PluginChange,
  PluginEntryId, PluginInfo, PluginInspectProblem, PluginInstallCancellation, PluginInstallProgress, PluginInstallRequestId,
  PluginRegistries, PluginSpecInspection, Registry,
} from './types.ts'
export type * from './types.ts'
export { classifyInstallFailure, type InstallFailureFacts } from './install-failure.ts'
export { InvalidInstallSpecError, parseInstallSpec, type ParsedInstallSpec } from './install-spec.ts'

/** pnpm 可执行文件、注册表，以及用于诊断、查找与连接检查的各类上限。 */
export interface Config {
  /** pnpm 可执行文件的名称或路径；与 `dsh plugin` 命令一样通过 `PATH` 解析。 */
  pnpmCommand?: string
  /** 保留的包操作诊断的最大字节数。 */
  outputBytes?: number
  /** 等待另一个进程的 profile 包操作的最长时间。 */
  lockWaitMs?: number
  /** 一次检视所运行的注册表查找的上限，以毫秒计。 */
  inspectTimeoutMs?: number
  /** 安装前 GitHub 仓库连接检查的最长持续时间，以毫秒计。 */
  githubConnectionTimeoutMs?: number
  /** 一次被捕获的包运行在管理器终止它之前可以连续不打印内容的最长时间，以毫秒计。 */
  idleTimeoutMs?: number
  /** 查找与安装首先询问的注册表，为一个 http(s) URL；缺省时取 pnpm 自身配置所命名者。 */
  registry?: string
  /**
   * 在前一个不可达或没有该包的副本时，依次询问的注册表，均为 http(s) URL。
   * 本集合与 `registry` 之外的注册表会被单独询问，pnpm 自身配置所命名的那个也是如此，
   * 除非它正是 npm 自身的注册表或其中之一。
   */
  fallbackRegistries?: string[]
}

/** 一个 http(s) URL，正如 pnpm 的 `--registry` 所接受的那样。 */
const REGISTRY_URL = /^https?:\/\/\S+$/

const protectedModules = new Set([
  '@deepseek-ai/dsh-plugin-manager', '@deepseek-ai/cordis-plugin-loader',
  '@deepseek-ai/cordis-plugin-include', '@deepseek-ai/dsh-api-gateway',
  '@deepseek-ai/dsh-host-webserver', '@deepseek-ai/dsh-client-modules',
  '@deepseek-ai/dsh-client-ui-settings-plugin-inventory', '@deepseek-ai/dsh-client-ui-plugin-manager',
  '@deepseek-ai/dsh-host-plugin-inventory', '@deepseek-ai/dsh-typert-registry',
  '@deepseek-ai/dsh-api-remotes', '@deepseek-ai/dsh-api-remote-access',
  '@deepseek-ai/cordis-plugin-timer', '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-host-frontend-static', '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-hmr',
])

/** 一次安装会写入、而失败或取消的安装会恢复的 profile 文件。 */
const RESTORED_FILES = ['package.json', 'pnpm-lock.yaml'] as const

/** pnpm 的颜色转义序列，JSON 回答可能被包裹其中。 */
const ANSI_SEQUENCE = /\x1b\[[0-9;]*m/g

/** 保留所观测到的确切诊断，包括非 Error 的失败。 */
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error) }

/** 一次预期的拒绝保留其错误码；其它任何情况都成为携带确切诊断的操作错误。 */
function managementError(error: unknown): ManagementError {
  if (!(error instanceof ManagementFailure)) return { code: 'operation-error', diagnostic: messageOf(error) }
  return { code: error.code, ...error.incompatible === undefined ? {} : { incompatible: error.incompatible } }
}

/** 调用方停止了一次安装；在抛出此错误之前，其文件已被恢复。 */
class InstallCancelledError extends Error {
  constructor() {
    super('Installation cancelled')
    this.name = 'InstallCancelledError'
  }
}

/** 管理器拥有的、直到其调用结算为止的一次安装。 */
interface InstallControl {
  readonly abort: AbortController
  /** 一旦 pnpm 退出且 bundle 正被选中并加载（此时无法停止），即为 `applying`。 */
  phase: 'installing' | 'applying'
  /** 该活动安装的结果，与正在恢复丢失响应的客户端共享。 */
  result: Promise<ChangeResult | null>
}

/** 清单中属于字符串类型的字段，在清单携带该字段时。 */
function stringField(manifest: object, field: string): string | undefined {
  const value = (manifest as Record<string, unknown>)[field]
  return typeof value === 'string' ? value : undefined
}

/** 管理器所读取的 dsh 安装自身清单的字段。 */
interface InstallationManifest {
  dependencies?: Record<string, string>
}

/** 包清单所说明的关于该包的信息：身份、一句话描述，以及它是否为一个 bundle。 */
function inspectionOf(kind: 'registry' | 'path', manifest: object, registry: Registry): Extract<PluginSpecInspection, { status: 'accepted' }> {
  const dsh = (manifest as { dsh?: unknown }).dsh
  const declared = typeof dsh === 'object' && dsh !== null ? dsh as { bundle?: unknown } : undefined
  const bundle = declared !== undefined && typeof declared.bundle === 'object' && declared.bundle !== null
  const name = stringField(manifest, 'name')
  const version = stringField(manifest, 'version')
  const description = stringField(manifest, 'description')
  return {
    status: 'accepted', kind, bundle, registry,
    ...name === undefined ? {} : { name },
    ...version === undefined ? {} : { version },
    ...description === undefined || description === '' ? {} : { description },
  }
}

function refused(problem: PluginInspectProblem, reason: string): PluginSpecInspection {
  return { status: 'refused', problem, reason }
}

/** `pnpm view --json` 在 stdout 上打印的拒绝信息，`{ error: { code, message } }`，作为一行日志；其它情况为空。 */
function printedError(printed: string): string {
  let parsed: unknown
  try { parsed = JSON.parse(printed || 'null') }
  catch { return '' /* 非 JSON：pnpm 未以拒绝形式打印任何内容 */ }
  const error = typeof parsed === 'object' && parsed !== null ? (parsed as { error?: unknown }).error : undefined
  if (typeof error !== 'object' || error === null) return ''
  const { code, message } = error as { code?: unknown; message?: unknown }
  return [code, message].filter((part): part is string => typeof part === 'string').join('  ')
}

/** 应用已保存的 profile 时，向变更结果中报告的内容。 */
type Reload = Pick<ChangeResult, 'warnings' | 'restartReason'>

/** 一个 profile 清单所选中的 bundle。 */
function bundleSelection(manifest: ProfileManifest): readonly string[] {
  return manifest.dsh?.profile?.bundles ?? []
}

/**
 * pnpm 运行之前，一个安装 spec 所命名的包：注册表名称、本地目录清单中的名称，或随此
 * git 或 tarball spec 一起保存的依赖，按插件列表展示的已保存 spec 进行比较。
 * @param spec 安装 spec。
 * @param dependencies profile 已保存的依赖。
 * @param profileDir 已保存的本地路径所相对的 profile 目录。
 * @returns 包名；或当只有安装过程能告知时返回 `undefined`。
 */
function specPackageName(spec: string, dependencies: Readonly<Record<string, string>>, profileDir: string): string | undefined {
  const parsed = parsedForRegistry(spec)
  if (parsed.kind === 'registry') return parsed.name
  if (parsed.kind === 'path') return packageName(parsed.path)
  const specs = parsed.kind === 'tarball' && parsed.path !== undefined ? [spec, `file:${parsed.path}`] : [spec]
  return Object.entries(dependencies).find(([dependency, saved]) => specs.includes(dependencySpec(dependency, saved, profileDir)))?.[0]
}

/** 一个本地目录声明的包名；没有可读清单时返回 `undefined`。 */
function packageName(dir: string): string | undefined {
  try {
    return readProfileManifest('dsh', dir).name
  } catch (_error) {
    // pnpm 自身会报告这个不可读的目录。
    return undefined
  }
}

/** spec 的形式，用于判断一次失败尝试是否来自注册表；解析器所拒绝的形式自身没有主机。 */
function parsedForRegistry(spec: string): ParsedInstallSpec {
  try {
    return parseInstallSpec(spec)
  } catch (error) {
    /* v8 ignore next -- parseInstallSpec 只抛出它自身的拒绝，不会抛出其它 */
    if (!(error instanceof InvalidInstallSpecError)) throw error
    return { kind: 'registry', spec, name: spec }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 对当前 profile 的组合与包进行持久化管理。 */
    pluginManager: PluginManager
  }
}

/** 管理 profile 文件并应用其声明的重新加载生命周期。 */
export class PluginManager extends TypertRemoteService {
  static inject = ['loader', 'profileContext']
  static Config: z<Config> = z.object({
    pnpmCommand: z.string().default('pnpm'),
    outputBytes: z.number().step(1).min(1).default(16384),
    lockWaitMs: z.number().step(1).min(0).default(120000),
    inspectTimeoutMs: z.number().step(1).min(1000).default(20000),
    githubConnectionTimeoutMs: z.number().step(1).min(1000).default(5000),
    idleTimeoutMs: z.number().step(1).min(1000).default(600000),
    registry: z.string().pattern(REGISTRY_URL),
    fallbackRegistries: z.array(z.string().pattern(REGISTRY_URL)).default([NPMMIRROR_REGISTRY]),
  })
  /** 即便管理 bundle 的文件变得不可读，它们仍受保护。 */
  private readonly managementBundles = new Set<string>()
  /**
   * 本进程内，每个包最后一次由本管理器安装的来源注册表。pnpm 会针对其默认注册表校验
   * lockfile 的 tarball URL，除非它们属于某个具名注册表，因此后续的移除要再次指明它。
   */
  private readonly installedFrom = new Map<string, Registry>()
  private readonly ownerEntryId: string | undefined
  private readonly packageOperations = new Set<Promise<unknown>>()
  private readonly profile: ProfileContext
  private readonly outputBytes: number
  private readonly lockWaitMs: number
  private readonly inspectTimeoutMs: number
  private readonly githubConnectionTimeoutMs: number
  private readonly idleTimeoutMs: number
  private readonly pnpmCommand: string
  private readonly configuredRegistries: Omit<PluginRegistries, 'resolved'>
  private readonly ownerContext: Context
  private readonly abort = new AbortController()
  /** 按请求 id 索引的安装，从它们的调用直到结算为止。 */
  private readonly installs = new Map<PluginInstallRequestId, InstallControl>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'pluginManager')
    this.ownerEntryId = ctx.fiber.entry?.id
    this.ownerContext = ctx
    this.profile = ctx.profileContext
    for (const name of this.profile.startedBundles) this.protectsManager(name)
    this.outputBytes = (config as Required<Config>).outputBytes
    this.lockWaitMs = (config as Required<Config>).lockWaitMs
    this.inspectTimeoutMs = (config as Required<Config>).inspectTimeoutMs
    this.githubConnectionTimeoutMs = (config as Required<Config>).githubConnectionTimeoutMs
    this.idleTimeoutMs = (config as Required<Config>).idleTimeoutMs
    this.pnpmCommand = (config as Required<Config>).pnpmCommand
    this.configuredRegistries = {
      registry: config.registry === undefined ? null : normalizeRegistry(config.registry),
      fallbackRegistries: (config as Required<Config>).fallbackRegistries.map(normalizeRegistry),
    }
    ctx.effect(() => async () => {
      this.abort.abort()
      await Promise.allSettled([...this.packageOperations])
    }, 'plugin-manager: package cancellation')
  }

  /** 读取本 profile 中保存的确切插件版本豁免。
   * @returns 已接受的 package-name@version 键及其可运行的运行时版本，以及读取器拒绝的
   * 任何记录或文件问题（调用方应报告它而非直接失败）。
   */
  @Remote
  listVersionExemptions(): { exemptions: Record<string, string[]>; warnings: string[] } {
    const { exemptions, warnings } = readProfileCompatibility(this.profile.dir)
    return { exemptions, warnings }
  }

  /** 授予或撤销一个确切的插件/运行时豁免，并重新评估运行中的插件。
   * @param packageVersion 确切的清单包名后跟 @ 与其版本；绝不是一个安装 spec 或别名。
   * @param runtimeVersion 授予时确切的当前 DSH 版本；撤销时可指明先前的运行时。
   * @param enabled 是要授予而非撤销该豁免。
   * @param acceptRisk 在用户接受可能的崩溃与数据丢失后，授予时必须为 true。
   * @returns 保存与运行时结果。仅启动型 profile 需要重启。
   */
  @Remote
  setVersionExemption(packageVersion: string, runtimeVersion: string, enabled: boolean, acceptRisk?: boolean): Promise<ChangeResult> {
    return this.change(result => this.configure(async () => {
      await setProfileVersionExemption(this.profile.dir, packageVersion, runtimeVersion, enabled, acceptRisk === true)
      Object.assign(result, await this.reload())
    }), { stage: 'enable', target: packageVersion, enabled }, 'bundle')
  }

  /** 读取当前插件，包括某行无法通过 profile 补丁修改的原因。
   * @returns 带有持久化补丁目标的当前运行时条目。
   */
  @Remote
  async listPlugins(): Promise<PluginInfo[]> {
    const rows = flatten(composeEntries([readProfilePatches('dsh', this.profile)]))
    const snapshot = await readPluginInventory(this.ctx)
    return snapshot.entries.map((entry) => {
      const actual = [...this.ctx.loader.entries()].find(row => row.id === entry.entryId)
      const candidates = rows.filter(row => row.id === actual?.options.id)
      const candidate = candidates[0]
      if (protectedModules.has(entry.moduleName) || entry.entryId === this.ownerEntryId) {
        return { ...entry, readOnlyReason: 'management-required' as const }
      }
      if (candidate === undefined || candidates.length > 1 || candidate.name !== entry.moduleName
        || actual?.parent.tree.ctx.fiber.entry?.id !== 'include') {
        return { ...entry, readOnlyReason: 'unaddressable' as const }
      }
      return { ...entry, patchId: candidate.id }
    })
  }

  /** 读取已安装的、由安装提供的，以及离线的 Official 目录 bundle，外加被选中的非 bundle 名称。
   * 一个没有 bundle 补丁的依赖，仅在其被选中期间，作为 `not-bundle` 问题列出。
   * @returns 包版本、清单描述、profile 依赖的可安装 spec、行、可选的展示元数据、
   * 激活选择、安装是否提供该 bundle，以及可移除性。
   */
  @Remote
  listBundles(): Promise<BundleInfo[]> {
    const manifest = readProfileManifest('dsh', this.profile.dir)
    const exemptions = readProfileVersionExemptions(this.profile.dir)
    const selected = bundleSelection(manifest)
    const recorded = manifest.dependencies ?? {}
    const dependencies = Object.keys(recorded)
    const installation = JSON.parse(readFileSync(this.profile.installAnchor, 'utf8')) as InstallationManifest
    const catalog = new Map(OFFICIAL_ON_DEMAND_CATALOG.map(entry => [entry.packageName, entry]))
    const names = [...new Set([...selected, ...dependencies, ...Object.keys(installation.dependencies ?? {}), ...catalog.keys()])]
    const bundles: BundleInfo[] = []
    const runtimeVersion = getDshRuntimeVersion()
    for (const name of names) {
      const installed = dependencies.includes(name)
      const optional = OPTIONAL_BUNDLES.includes(name)
      const enabled = selected.includes(name)
      const shipped = Object.hasOwn(installation.dependencies ?? {}, name)
      const offered = catalog.get(name)
      const official = optional || offered !== undefined
      let target: Pick<BundleInfo, 'installTarget'> = {}
      let targetError: ManagementError | undefined
      if (offered !== undefined) {
        try { target = { installTarget: officialBundleInstallTarget(name, this.profile.installAnchor, runtimeVersion) } }
        catch (error) { targetError = managementError(error) }
      }
      const catalogMeta = offered === undefined ? {} : { meta: offered.meta }
      if (offered !== undefined && !installed && !shipped) {
        bundles.push({ name, official, availability: 'missing', ...catalogMeta, ...target, enabled, installed, optional,
          removable: enabled, rows: [], overrides: [],
          ...targetError !== undefined ? { error: targetError } : enabled ? { error: { code: 'not-bundle' } } : {} })
        continue
      }
      // 即便 profile 也声明了它们的名称，由安装拥有的副本仍受保护。
      const owned = installed && !shipped
      const removable = owned || (enabled && !installed && !shipped)
      const sourceOf = (packageName?: string): { source?: string } =>
        owned ? { source: dependencySpec(name, recorded[name] as string, this.profile.dir, packageName) } : {}
      const readOnlyReason = this.protectsManager(name) ? 'management-required' as const : undefined
      let availability: BundleInfo['availability'] = 'missing'
      let version: string | undefined
      try {
        const info = bundleManifest(name, this.profile.dir, this.profile.installAnchor)
        availability = shipped ? 'installation' : 'profile'
        if (info === undefined) {
          if (enabled || offered !== undefined) bundles.push({ name, official, availability, ...catalogMeta, ...target,
            ...sourceOf(), enabled, installed, optional, removable: removable && readOnlyReason === undefined,
            ...(readOnlyReason === undefined ? {} : { readOnlyReason }), error: targetError ?? { code: 'not-bundle' }, rows: [], overrides: [] })
          continue
        }
        version = info.version
        const compatibility = evaluatePluginCompatibility(info, exemptions)
        if (compatibility !== undefined && !compatibility.exempted) throw new ManagementFailure('incompatible-version', [incompatiblePlugin(compatibility)])
        const dir = resolveBundleDir('dsh', name, this.profile.installAnchor, this.profile.dir)
        const meta = offered?.meta ?? readPluginMeta(info.name ?? name, pathToFileURL(join(dir, 'package.json')).href)
        bundles.push({ name, official, availability, ...target, ...(version === undefined ? {} : { version }),
          ...(info.description === undefined || info.description === '' ? {} : { description: info.description }),
          ...meta === undefined ? {} : { meta },
          ...sourceOf(info.name), enabled, installed, optional, removable: removable && readOnlyReason === undefined,
          ...(readOnlyReason === undefined ? {} : { readOnlyReason }),
          ...this.declaredRows(name, info),
          ...targetError === undefined ? {} : { error: targetError } })
      } catch (error) {
        if (enabled || installed || optional || offered !== undefined) {
          bundles.push({ name, official, availability, ...catalogMeta, ...target, ...(version === undefined ? {} : { version }),
            ...sourceOf(), enabled, installed, optional, removable: removable && readOnlyReason === undefined,
            ...(readOnlyReason === undefined ? {} : { readOnlyReason }),
            error: targetError ?? managementError(error), rows: [], overrides: [] })
        }
      }
    }
    return Promise.resolve(bundles)
  }

  /** 读取本管理器所询问的注册表：已配置的第一个、其顺序排在其后的回退项，以及 pnpm 自身配置所命名者。
   * @returns 处于 pnpm 比较形式中的注册表；null 为 pnpm 自身配置所命名者，`resolved` 为 pnpm 当下读取到的值。
   */
  @Remote
  async registries(): Promise<PluginRegistries> {
    return {
      ...this.configuredRegistries, fallbackRegistries: [...this.configuredRegistries.fallbackRegistries],
      resolved: await readProfileRegistry(this.profile.dir, {
        ...this.profile.packageManager ?? { command: this.pnpmCommand }, timeoutMs: this.inspectTimeoutMs,
      }),
    }
  }

  /** 在安装之前读取一个 spec 所命名的对象。
   * @param spec 一个包 spec：注册表名称、绝对路径、git 地址，或 tarball。
   * @param options 首先询问的注册表。
   * @param signal 提前结束一次注册表查找。
   * @returns 该 spec 所命名的包，或它被拒绝的原因。
   */
  @Remote
  async inspect(spec: string, options?: InspectOptions, signal?: AbortSignal): Promise<PluginSpecInspection> {
    let parsed
    try {
      parsed = parseInstallSpec(spec)
    } catch (error) {
      /* v8 ignore next 2 -- parseInstallSpec 只抛出它自身的拒绝，不会抛出其它 */
      if (!(error instanceof InvalidInstallSpecError)) throw error
      return refused('invalid-spec', error.reason)
    }
    const manifest = readProfileManifest('dsh', this.profile.dir)
    const installation = JSON.parse(readFileSync(this.profile.installAnchor, 'utf8')) as InstallationManifest
    const known = new Set([
      ...bundleSelection(manifest), ...Object.keys(manifest.dependencies ?? {}), ...Object.keys(installation.dependencies ?? {}),
    ])
    const plan = registryPlan(options?.registry, await this.registries())
    const registry = plan[0] as Registry
    switch (parsed.kind) {
      case 'git': return { status: 'accepted', kind: 'git', bundle: null, registry, host: parsed.host }
      case 'tarball':
        if (parsed.path !== undefined && !existsSync(parsed.path)) return refused('not-a-package', 'the tarball does not exist')
        return { status: 'accepted', kind: 'tarball', bundle: null, registry, ...parsed.host === undefined ? {} : { host: parsed.host } }
      case 'path': {
        if (!existsSync(parsed.path)) return refused('not-a-package', 'the path does not exist')
        let read: object
        try {
          read = JSON.parse(await readFile(join(parsed.path, 'package.json'), 'utf8')) as object
        } catch (error) {
          return refused('not-a-package', `no readable package.json at the path: ${messageOf(error)}`)
        }
        const inspection = inspectionOf('path', read, registry)
        if (inspection.name === undefined) return refused('not-a-package', 'the package.json names no package')
        if (known.has(inspection.name)) return refused('already-installed', `${inspection.name} is already installed`)
        if (!inspection.bundle) return refused('not-a-bundle', `${inspection.name} declares no dsh.bundle`)
        return inspection
      }
      case 'registry': {
        if (known.has(parsed.name)) return refused('already-installed', `${parsed.name} is already installed`)
        const registries: Registry[] = []
        const refusedBy = (problem: PluginInspectProblem, reason: string): PluginSpecInspection =>
          ({ status: 'refused', problem, reason, registries })
        for (const current of plan) {
          registries.push(current)
          const view = await viewProfilePackage(this.profile.dir, spec.trim(), {
            ...this.profile.packageManager ?? { command: this.pnpmCommand },
            timeoutMs: this.inspectTimeoutMs, ...signal === undefined ? {} : { signal }, registry: current,
          })
          const printed = view.stdout.replace(ANSI_SEQUENCE, '').trim()
          if (view.exitCode !== 0 || view.cause !== undefined || view.timedOut) {
            // pnpm 在 stdout 上以 `{ error: { code, message } }` 形式打印拒绝信息，stderr 上则无内容。
            const log = [view.stderr.trim(), printedError(printed), view.cause === undefined ? '' : messageOf(view.cause)].filter(Boolean).join('\n')
            const kind = classifyInstallFailure({ log, timedOut: view.timedOut, ...view.cause === undefined ? {} : { cause: view.cause } })
            // 调用方放弃的查找不会被带入下一个注册表。
            if (registries.length < plan.length && signal?.aborted !== true && attributeFailure(kind, log, parsed) === 'registry') continue
            const reason = view.timedOut ? `pnpm view timed out after ${String(this.inspectTimeoutMs)}ms` : log || printed || `pnpm view exited with ${String(view.exitCode)}`
            if (kind === 'not-found' || kind === 'no-matching-version') return refusedBy('not-found', reason)
            if (kind === 'network' || kind === 'timeout') return refusedBy('network', reason)
            return refusedBy('unknown', reason)
          }
          let answer: unknown
          try {
            answer = JSON.parse(printed || 'null')
          } catch (error) {
            return refusedBy('unknown', `unreadable pnpm view output: ${messageOf(error)}`)
          }
          // 一个范围对每个匹配版本各回答一个对象，最旧的在前。
          const latest: unknown = Array.isArray(answer) ? answer.at(-1) : answer
          if (typeof latest !== 'object' || latest === null) return refusedBy('unknown', 'pnpm view answered no package')
          const inspection = inspectionOf('registry', latest, current)
          const named = inspection.name === undefined ? { ...inspection, name: parsed.name } : inspection
          if (!named.bundle) return refusedBy('not-a-bundle', `${named.name} declares no dsh.bundle`)
          return named
        }
        /* v8 ignore next -- 计划永远不会为空：每次尝试都会返回或继续到下一次 */
        throw new Error('no registry was asked')
      }
    }
  }

  /** 持久化一个插件条目的期望启用状态，并在运行中的 profile 上应用它。
   * @param id listPlugins 返回的 Loader 条目身份。
   * @param enabled 该插件是否应当运行。
   * @returns 保存与运行时结果，包括更高优先级的覆盖。
   */
  @Remote
  setPluginEnabled(id: PluginEntryId, enabled: boolean): Promise<ChangeResult> {
    return this.change(result => this.configure(async () => {
      const row = (await this.listPlugins()).find(item => item.entryId === id)
      if (row === undefined) throw new ManagementFailure('unknown-plugin')
      if (row.readOnlyReason !== undefined) throw new ManagementFailure(row.readOnlyReason)
      await writePluginEnabled(this.profile, row.patchId, row.moduleName, enabled)
      Object.assign(result, await this.reload(enabled ? [row.patchId] : []))
      const current = (await this.listPlugins()).find(item => item.entryId === id)
      return current?.enabled !== enabled && this.ownerContext.get('hmr') !== undefined ? 'overridden' : undefined
    }), { stage: 'enable', target: id, enabled }, 'plugin')
  }

  /** 在保留已安装依赖的同时，选中或移除一个 bundle 层。
   * @param name bundle 包名。
   * @param enabled 该 bundle 是否贡献其补丁层。
   * @returns 持久化与运行时结果。
   */
  @Remote
  setBundleEnabled(name: string, enabled: boolean): Promise<ChangeResult> {
    return this.change(result => this.configure(async () => {
      await this.selectBundle(name, enabled)
      Object.assign(result, enabled ? await this.publishAndReload(this.bundleRows(name).map(row => row.id)) : await this.reload())
    }), { stage: 'enable', target: name, enabled }, 'bundle')
  }

  /**
   * 使用与 dsh plugin 相同的 pnpm 实现来安装一个包。GitHub 仓库在 pnpm 启动之前会获得一次
   * 受 githubConnectionTimeoutMs 约束的连接检查；只有网络失败或超时才会中止安装，而
   * 鉴权与传输回退由 pnpm 负责。一次失败、被取消，或添加了不带 bundle 补丁的包的运行，会
   * 将 `package.json` 与 `pnpm-lock.yaml` 恢复如初；已下载的文件可以保留。
   * @param spec 一个包 spec，包括相对于调用目录的本地路径。
   * @param options 是否激活已安装的 bundle（默认 true）、取消操作所指名的请求 id、
   * 要允许的待决构建脚本、是否保存确切依赖，以及首先询问的注册表。
   * @returns 包管理器诊断、所询问的注册表，以及观测到的激活结果。
   */
  @Remote
  installBundle(spec: string, options?: InstallBundleOptions): Promise<ChangeResult> {
    const requestId = options?.requestId
    const control: InstallControl = { abort: new AbortController(), phase: 'installing', result: Promise.resolve(null) }
    const stopped = (): boolean => control.abort.signal.aborted || this.abort.signal.aborted
    if (requestId !== undefined) this.installs.set(requestId, control)
    const announce = (phase: PluginInstallProgress['phase'], attempt?: PluginInstallProgress['attempt']): void => {
      if (requestId !== undefined) this.ownerContext.emit('plugin-manager/install-state', { requestId, phase, ...attempt === undefined ? {} : { attempt } })
    }
    const result = this.change(async (result) => {
      if (spec.trim() === '' || spec.startsWith('-')) throw new ManagementFailure('invalid-spec')
      if (stopped()) throw new InstallCancelledError()
      const before = readProfileManifest('dsh', this.profile.dir).dependencies ?? {}
      // 在 HMR 下，已安装的包会在另一个版本安装之前被移除，因此其插件先停止。
      const known = specPackageName(spec, before, this.profile.dir)
      if (this.ownerContext.get('hmr') !== undefined && known !== undefined && Object.hasOwn(before, known)) {
        throw new ManagementFailure('already-installed')
      }
      if (options?.approvedBuilds !== undefined) {
        await approveBuilds(this.profile.dir, options.approvedBuilds)
        result.approvedBuilds = options.approvedBuilds
      }
      const files = await this.readRestoredFiles()
      let name: string
      let version: string | undefined
      try {
        result.registries = []
        const connection = checkGithubConnection(parsedForRegistry(spec), this.profile.dir, {
          timeoutMs: this.githubConnectionTimeoutMs, outputBytes: this.outputBytes,
          signal: AbortSignal.any([this.abort.signal, control.abort.signal]),
          ...this.profile.packageManager?.env === undefined ? {} : { env: this.profile.packageManager.env },
        })
        this.packageOperations.add(connection)
        let connectionFailure: PackageResult | undefined
        try { connectionFailure = await connection }
        finally { this.packageOperations.delete(connection) }
        if (stopped()) throw new InstallCancelledError()
        if (connectionFailure?.kind === 'network' || connectionFailure?.kind === 'timeout') {
          result.packageResult = connectionFailure
          result.failedAt = 'spec-host'
          throw new Error(connectionFailure.output)
        }
        // 最后一次运行属于结果的；所询问的注册表无论结果如何都保持列出。
        const plan = registryPlan(options?.registry, await this.registries())
        let run: PackageResult | undefined
        let used: Registry = null
        for (const [index, registry] of plan.entries()) {
          if (index > 0) await this.restoreFiles(files)
          // 在文件回退期间发生的停止，或在首次运行之前发生的停止，不会以已失效的信号启动任何运行。
          if (stopped()) throw new InstallCancelledError()
          result.registries.push(registry)
          used = registry
          announce('installing', { registry, index: index + 1, total: plan.length })
          run = await this.runPnpm(['add', spec, ...options?.saveExact === true ? ['--save-exact'] : [], ...registryArguments(registry)], control.abort.signal, requestId)
          result.packageResult = run
          if (stopped()) throw new InstallCancelledError()
          // 兼容性拒绝是包自身的回答，因此不会去询问其它注册表。
          if (run.incompatible !== undefined) throw new ManagementFailure('incompatible-version', run.incompatible)
          // 被本管理器终止的运行不算成功，即便 pnpm 捕获了信号并以 0 退出。
          if (run.exitCode === 0 && run.timedOut !== true) break
          /* v8 ignore next 2 -- runPnpm 会把每一个未被它上报的运行都归类为成功 */
          if (run.kind === undefined) break
          // 最后一次失败的运行所无法抵达的对象；一次成功运行的后续运行无话可说。
          delete result.failedAt
          // 被本管理器终止的运行根本没从注册表得到任何回答，因此没有任何注册表可解释它。
          if (run.timedOut === true) break
          const failedAt = attributeFailure(run.kind, run.output, parsedForRegistry(spec))
          if (failedAt !== 'other') result.failedAt = failedAt
          if (failedAt !== 'registry' || index === plan.length - 1) break
        }
        /* v8 ignore next -- 计划永远不会为空，因此一次运行总是已经落定 */
        if (run === undefined) throw new Error('no registry was asked')
        // 被终止的运行报告不出可用的退出状态，因此其文件与 bundle 都不被信任。
        const succeeded = run.exitCode === 0 && run.timedOut !== true
        if (succeeded) delete result.failedAt
        if (!succeeded) {
          // pnpm-workspace.yaml 不会被恢复，因此它留下的未决项、或报告为被忽略的项，被提供给用户批准。
          try { result.pendingBuilds = await recordPendingBuilds(this.profile.dir, run.output) }
          catch (error) {
            this.ownerContext.logger.warn('Could not read pending build approvals after pnpm failed', error)
          }
          throw new Error(run.output)
        }
        const after = readProfileManifest('dsh', this.profile.dir).dependencies ?? {}
        const installed = Object.keys(after).filter(name => before[name] !== after[name])
        // 在没有 HMR 的情况下，重复安装可能让保存的依赖保持原样。
        if (installed.length === 0) {
          const local = specPackageName(spec, after, this.profile.dir)
          if (local !== undefined && Object.hasOwn(after, local)) installed.push(local)
        }
        const target = installed[0]
        if (installed.length !== 1 || target === undefined) throw new ManagementFailure('ambiguous-install')
        name = target
        const dir = resolveBundleDir('dsh', name, this.profile.installAnchor, this.profile.dir)
        const manifest = bundleManifest(name, this.profile.dir, this.profile.installAnchor)
        if (manifest?.dsh?.bundle === undefined) throw new ManagementFailure('not-bundle')
        const compatibility = evaluatePluginCompatibility(manifest, readProfileVersionExemptions(this.profile.dir))
        if (compatibility !== undefined && !compatibility.exempted) throw new ManagementFailure('incompatible-version', [incompatiblePlugin(compatibility)])
        for (const file of bundlePatchPaths(dir, manifest.dsh.bundle)) loadOverlayPatches('dsh', file)
        version = manifest.version
        this.installedFrom.set(name, used)
      } catch (error) {
        // 至此 pnpm 已经退出，因此它重写的文件会如初回退。
        await this.restoreFiles(files)
        throw error
      }
      control.phase = 'applying'
      announce('applying')
      result.bundle = name
      if (version !== undefined) result.version = version
      result.target = name
      result.stage = 'enable'
      return this.configure(async () => {
        if (options?.enabled !== false) await this.selectBundle(name, true)
        // 在没有 HMR 的情况下，被替换包的插件会一直运行，直到结果已经报告的重启为止。
        if (Object.hasOwn(before, name) && this.ownerContext.get('hmr') === undefined) return
        // 一个被选中的 bundle 自身的行必须启动。
        const selected = bundleSelection(readProfileManifest('dsh', this.profile.dir)).includes(name)
        Object.assign(result, await this.publishAndReload(selected ? this.bundleRows(name).map(row => row.id) : []))
      })
    }, { stage: 'install', target: spec, enabled: options?.enabled !== false }, 'install')
    control.result = result
    return result.finally(() => { if (requestId !== undefined) this.installs.delete(requestId) })
  }

  /** 在不取消的前提下，恢复一次活动安装的结果。
   * @param requestId 安装启动时所提供的 id。
   * @returns 安装结算后的结果；若没有该 id 的活动请求，则为 null。
   * 已完成的结果不会被保留；null 既不表示成功也不表示取消。
   */
  @Remote
  async waitForInstall(requestId: PluginInstallRequestId): Promise<ChangeResult | null> {
    return this.installs.get(requestId)?.result ?? null
  }

  /** 停止本管理器拥有的一次安装，并等待其文件恢复。
   * @param requestId 该安装启动时所使用的 id。
   * @returns 一旦 Git 检查或 pnpm 退出且文件被恢复，即为 `cancelled`；一旦 bundle 正被
   * 应用时，即为 `too-late`；对于任何其它 id，则为 `not-running`。
   */
  @Remote
  async cancelInstall(requestId: PluginInstallRequestId): Promise<PluginInstallCancellation> {
    const control = this.installs.get(requestId)
    if (control === undefined) return { status: 'not-running' }
    if (control.phase === 'applying') return { status: 'too-late' }
    this.ownerContext.emit('plugin-manager/install-state', { requestId, phase: 'cancelling' })
    control.abort.abort()
    /* v8 ignore next -- change() 把每个失败都折叠进其结果；只有锁或释放错误会拒绝 */
    await control.result.then(() => undefined, () => undefined)
    return { status: 'cancelled' }
  }

  /** 通过 dsh plugin 的 pnpm 路径卸载并移除一个 profile 拥有的 bundle 依赖；一个没有被
   * 任何依赖持有的被选中名称，只会取消选中。
   * @param name 已安装的依赖或被选中的 bundle 名称。
   * @returns 移除诊断与剩余的 profile 状态。
   */
  @Remote
  removeBundle(name: string): Promise<ChangeResult> {
    return this.change(async (result) => {
      const installed = await this.configure(async () => {
        const bundle = (await this.listBundles()).find(item => item.name === name)
        if (bundle === undefined || !bundle.removable) throw new ManagementFailure('not-removable')
        if (this.ownerContext.get('hmr') === undefined && (this.profile.startedBundles.includes(name)
          || (bundle.error === undefined && this.bundleRows(name).some(row => [...this.ctx.loader.entries()]
            .some(entry => entry.options.id === row.id && entry.fiber !== undefined))))) {
          throw new ManagementFailure('stop-profile')
        }
        const contributions = bundle.error === undefined ? this.bundleRows(name) : []
        if (bundle.enabled) {
          await this.selectBundle(name, false)
          Object.assign(result, await this.reload())
        }
        if ([...this.ctx.loader.entries()].some(entry => entry.fiber?.uid != null
          && contributions.some(row => row.id === entry.options.id && row.name === entry.options.name))) {
          throw new ManagementFailure('bundle-in-use')
        }
        return bundle.installed
      })
      if (!installed) return
      // `pnpm remove` 不接受 `--registry` 选项；通用配置标志设置相同的设置。在本进程启动
      // 之前安装的包，会以其安装首先询问的注册表来移除。
      const registry = this.installedFrom.has(name) ? this.installedFrom.get(name) : this.configuredRegistries.registry
      result.packageResult = await this.runPnpm(['remove', name, ...typeof registry === 'string' ? [`--config.registry=${registry}`] : []])
      if (result.packageResult.exitCode !== 0 || result.packageResult.timedOut === true) {
        throw new Error(result.packageResult.output)
      }
      this.installedFrom.delete(name)
      Object.assign(result, await this.configure(() => this.publishAndReload()))
    }, { stage: 'remove', target: name }, 'remove')
  }

  /** 一个 bundle 的补丁所插入的行，以及它修改的已有行；不可读的补丁会抛出。 */
  private declaredRows(name: string, info: ProfileManifest): Pick<BundleInfo, 'rows' | 'overrides'> {
    const bundle = info.dsh?.bundle
    /* v8 ignore next -- bundleManifest 只应答声明了补丁的清单 */
    if (bundle === undefined) return { rows: [], overrides: [] }
    const dir = resolveBundleDir('dsh', name, this.profile.installAnchor, this.profile.dir)
    const patches: PatchOptions[] = bundlePatchPaths(dir, bundle).flatMap(file => loadOverlayPatches('dsh', file))
    // 每个行 id 对应一个条目：Loader 为某个 id 始终保留单个条目，以最后声明它的层为准。
    const live = new Map<string, { entryId: PluginEntryId; baseUrl: string | undefined }>()
    for (const entry of this.ctx.loader.entries()) {
      /* v8 ignore next -- Loader 会在每个条目被列出之前赋予其 id */
      if (typeof entry.options.id === 'string') live.set(entry.options.id, {
        entryId: pluginEntryId(entry.id), baseUrl: entry.parent.tree.ctx.baseUrl,
      })
    }
    const rows: BundleRowInfo[] = []
    const packages = this.ctx.get('pluginPackages')
    for (const row of flatten(composeEntries([patches.filter(item => item.insert !== undefined)]))) {
      // 组行是不带插件清单条目的容器；它们的子项携带开关。
      if (typeof row.id !== 'string' || typeof row.name !== 'string' || row.group === true) continue
      const active = live.get(row.id)
      const entryId = active?.entryId
      const base = active?.baseUrl ?? pathToFileURL(join(dir, 'package.json')).href
      const meta = packages?.metaOf(row.name, base)
      rows.push({ rowId: row.id, moduleName: row.name,
        ...entryId === undefined ? {} : { entryId }, ...meta === undefined ? {} : { meta } })
    }
    const declared = new Set(rows.map(row => row.rowId))
    const overrides = [...new Set(patches.flatMap(item =>
      item.insert === undefined && typeof item.id === 'string' && !declared.has(item.id) ? [item.id] : []))]
    return { rows, overrides }
  }

  /** 在 profile 中运行一条 pnpm 命令，将其输出作为 install-log 分块流式传出。 */
  private async runPnpm(
    args: readonly string[], signal?: AbortSignal, requestId?: PluginInstallRequestId,
  ): Promise<PackageResult> {
    const jobId = randomUUID()
    const argv = ['pnpm', ...args]
    const cwd = this.profile.dir
    const identity = requestId === undefined ? {} : { requestId }
    const task = runProfilePnpm({ ...this.profile, profile: this.profile.name }, args, {
      execution: 'service', ...this.profile.packageManager ?? { command: this.pnpmCommand },
      signal: signal === undefined ? this.abort.signal : AbortSignal.any([this.abort.signal, signal]),
      outputBytes: this.outputBytes, activateNewBundles: false, idleTimeoutMs: this.idleTimeoutMs,
      lookupTimeoutMs: this.inspectTimeoutMs,
      onOutput: (text, stream) => {
        this.ownerContext.emit('plugin-manager/install-log', { ...identity, jobId, argv, cwd, stream, text })
      },
    })
    this.packageOperations.add(task)
    try {
      const result = await task
      this.ownerContext.emit('plugin-manager/install-log', {
        ...identity, jobId, argv, cwd, stream: 'stdout', text: '', exitCode: signal?.aborted === true ? null : result.exitCode,
      })
      // 一个已终止的运行会保留它自身的种类，即便 pnpm 截获了信号并以退出码 0 退出。
      if (result.exitCode === 0 && result.timedOut !== true) return result
      return {
        ...result,
        kind: classifyInstallFailure({ log: result.output, ...result.timedOut === true ? { timedOut: true } : {} }),
      }
    } catch (error) {
      this.ownerContext.emit('plugin-manager/install-log', { ...identity, jobId, argv, cwd, stream: 'stderr', text: messageOf(error), exitCode: null })
      throw error
    } finally {
      this.packageOperations.delete(task)
    }
  }

  /** 一次安装可能重写的 profile 文件，按当前状态读取；缺失文件读作 undefined。 */
  private async readRestoredFiles(): Promise<Map<string, string | undefined>> {
    const files = new Map<string, string | undefined>()
    for (const name of RESTORED_FILES) {
      const path = join(this.profile.dir, name)
      files.set(path, existsSync(path) ? await readFile(path, 'utf8') : undefined)
    }
    return files
  }

  /** 将 profile 文件放回原位；运行到此处时 pnpm 已退出。 */
  private async restoreFiles(files: Map<string, string | undefined>): Promise<void> {
    for (const [path, content] of files) {
      if (content === undefined) await rm(path, { force: true })
      else await writeFileAtomic(path, content, { mode: 0o600 })
    }
  }

  private async selectBundle(name: string, enabled: boolean): Promise<void> {
    const manifest = readProfileManifest('dsh', this.profile.dir)
    const previous = bundleSelection(manifest)
    if (enabled || !previous.includes(name)) {
      const metadata = bundleManifest(name, this.profile.dir, this.profile.installAnchor)
      if (metadata === undefined) throw new ManagementFailure('not-bundle')
      if (enabled) {
        const compatibility = evaluatePluginCompatibility(metadata, readProfileVersionExemptions(this.profile.dir))
        if (compatibility !== undefined && !compatibility.exempted) throw new ManagementFailure('incompatible-version', [incompatiblePlugin(compatibility)])
        this.bundleRows(name)
      }
    }
    if (!enabled && previous.includes(name)) {
      if (this.protectsManager(name)) throw new ManagementFailure('management-required')
    }
    const bundles = enabled ? [...previous, ...previous.includes(name) ? [] : [name]] : previous.filter(item => item !== name)
    if (JSON.stringify(previous) === JSON.stringify(bundles)) return
    manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } }
    await saveManifest(this.profile.dir, manifest)
    if (enabled) this.protectsManager(name)
  }

  private bundleRows(name: string): EntryOptions[] {
    const info = bundleManifest(name, this.profile.dir, this.profile.installAnchor)
    if (info?.dsh?.bundle === undefined) return []
    const dir = resolveBundleDir('dsh', name, this.profile.installAnchor, this.profile.dir)
    return flatten(composeEntries([bundlePatchPaths(dir, info.dsh.bundle).flatMap(file => loadOverlayPatches('dsh', file))]))
  }

  private protectsManager(name: string): boolean {
    if (this.managementBundles.has(name)) return true
    let rows: EntryOptions[]
    try { rows = this.bundleRows(name) } catch (_error) {
      // 不可读的 bundle 不贡献任何新行；listBundles 会报告它们的诊断。
      return false
    }
    const protectedBundle = rows.some(row => protectedModules.has(row.name) || `include:${row.id}` === this.ownerEntryId)
    if (protectedBundle) this.managementBundles.add(name)
    return protectedBundle
  }

  private configure<T>(operation: () => Promise<T>): Promise<T> {
    const hmr = this.ownerContext.get('hmr')
    const apply = () => { this.abort.signal.throwIfAborted(); return operation() }
    return hmr === undefined ? apply() : hmr.runExclusive(apply)
  }

  /**
   * 在没有 HMR 的情况下发布 profile 的运行时解析，除非一个被取消选中的启动 bundle 仍在
   * 运行并需要当前表。需要重启的发布会等待结果已经报告的那个重启。
   */
  private async refreshPackages(): Promise<void> {
    const selected = bundleSelection(readProfileManifest('dsh', this.profile.dir))
    if (this.profile.startedBundles.some(name => !selected.includes(name))) return
    try {
      const packages = this.ownerContext.get('pluginPackages')
      // 一个被丢弃映射的 bundle 并未在运行：上方的守卫会在某个被取消选中的启动 bundle 运行时保留该表。
      if (packages?.resolution !== undefined) await packages.refresh()
    } catch (error) {
      if (!(error instanceof ResolutionRestartRequired)) throw error
    }
  }

  /**
   * 应用一个包的变更：在没有 HMR 的情况下，在确保安全时发布运行时解析，然后 {@link reload}。
   * @param requiredIds 必须启动的条目 id。
   * @returns 重新加载的结果。
   */
  private async publishAndReload(requiredIds: readonly string[] = []): Promise<Reload> {
    if (this.ownerContext.get('hmr') === undefined) await this.refreshPackages()
    return this.reload(requiredIds)
  }

  /**
   * 应用已保存的 profile；在 HMR 下会实时重新组合，包括运行时解析。
   * @param requiredIds 必须启动的条目 id。
   * @returns 关于原本就已非活动条目的警告，以及该变更（若会）为何要等待重启的原因。
   */
  private async reload(requiredIds: readonly string[] = []): Promise<Reload> {
    const hmr = this.ownerContext.get('hmr')
    if (hmr === undefined) {
      // 仅启动型 profile 在重启时重新组合；已保存的补丁仍须组合。
      composeEntries([readProfilePatches('dsh', this.profile)])
      return { warnings: [] }
    }
    const { warnings, pending, restartReason } = await hmr.reconcileProfile(requiredIds)
    const restart = restartReason ?? pending[0]?.reason
    return restart === undefined ? { warnings } : { warnings, restartReason: restart }
  }

  private async change(
    operation: (result: ChangeResult) => Promise<ChangeResult['application'] | void>,
    request: Pick<ChangeResult, 'stage' | 'target' | 'enabled'>,
    reason: PluginChange['reason'],
  ): Promise<ChangeResult> {
    return withFileLock(join(this.profile.dir, 'package.json'), async () => {
      this.abort.signal.throwIfAborted()
      const before = this.diskState()
      const result: ChangeResult = { ...request, changed: false,
        ...this.ownerContext.get('hmr') !== undefined ? { application: 'applied' } : { application: 'restart-required', restartReason: 'no-hmr' } }
      try {
        const outcome = await operation(result)
        if (outcome !== undefined) result.application = outcome
        // 等待重启的重新加载会让变更被保存但未被应用。
        else if (result.application === 'applied' && result.restartReason !== undefined) result.application = 'restart-required'
      } catch (error) {
        if (error instanceof InstallCancelledError) {
          result.application = 'cancelled'
        } else {
          result.application = 'failed'
          result.error = managementError(error)
        }
      }
      if (result.application !== 'restart-required') delete result.restartReason
      result.changed = before !== this.diskState()
      this.ownerContext.emit('plugin-manager/changed', { reason })
      return result
    }, { waitMs: this.lockWaitMs })
  }

  private diskState(): string {
    return ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml', PROFILE_COMPATIBILITY_FILENAME].map((file) => {
      try { return readFileSync(join(this.profile.dir, file), 'utf8') }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
        throw error
      }
    }).join('\0')
  }
}

export default PluginManager
