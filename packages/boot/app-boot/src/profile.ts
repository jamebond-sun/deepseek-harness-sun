/**
 * `dsh --profile` 启动器家族的 profile 发现、初始化与补丁层组合。
 *
 * 一个 profile 是位于 `$DSH_HOME/profiles/<name>` 下的目录，包含一个
 * `package.json`（树外插件依赖，以及 profile 清单 `dsh.profile` 与其有序的
 * `bundles` 列表）和一个 `cordis.patch.yml`（用户自己的补丁层，应用于每个
 * bundle 层之后）。bundle 是一些 npm 包，其清单声明
 * `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`（一个文件，或一个有序
 * 的文件列表）；该树的组合方式是：在一个空条目列表之上，按 `dsh.profile.bundles`
 * 的顺序应用每个 bundle 的补丁列表，然后是 profile 自身的补丁，再然后是任意启动器
 * 层（`--patch` 文件与由标志派生的补丁）。
 *
 * 模块解析按构造采用双锚点：一个 bundle 名先从 dsh 安装（启动器自身的包）解析，
 * 再从 profile 目录解析。profile 的 `node_modules` 中由 pnpm 管理的条目优先解析。
 * 运行时解析把由安装与所选 bundle 携带的包提供给 Node 的 ESM 与 CommonJS 解析器。
 * @module @deepseek-ai/dsh-app-boot/profile
 */

import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { applyEntryPatches, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { DshBundleManifest, DshPackageManifest } from '@deepseek-ai/dsh-package-manifest'
import { evaluatePluginCompatibility, pluginCompatibilityWarning } from './plugin-compatibility.ts'
import { readProfileVersionExemptions } from './profile-compatibility.ts'
import { loadOverlayPatches } from './index.ts'
import { realModuleDirectory } from './profile-resolution/legacy-links.ts'

/** Harness home 之下、容纳所有 profile 的目录。 */
export const PROFILES_DIR = 'profiles'

/** profile 目录内的用户补丁层（在长生命周期界面上热重载）。 */
export const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'

/** 一个已发布 profile 首次打开时使用的、安装所拥有的默认值。 */
export interface ProfileTemplate {
  /** 有序的 bundle 层列表。 */
  bundles: readonly string[]
}

/** profile 读取器所接受的包元数据；本地 profile 无需已发布的身份。 */
export type ProfileManifest = Partial<DshPackageManifest>

/**
 * bundle 所声明的补丁文件，按原样写出：字符串形式的 `patch` 为单个文件，
 * 数组形式则为其按顺序排列的文件。
 * @param bundle - 从 package.json 读取的 bundle 的 `dsh.bundle` 声明。
 * @returns 按应用顺序排列、相对于包的补丁文件路径。
 * @throws 当 `patch` 既不是字符串也不是字符串列表时抛出 {Error}。
 */
export function bundlePatchFiles(bundle: DshBundleManifest): string[] {
  const declared = typeof bundle.patch === 'string' ? [bundle.patch] : bundle.patch
  if (!Array.isArray(declared) || !declared.every(file => typeof file === 'string')) {
    throw new Error('dsh.bundle.patch must be a file path or a list of file paths')
  }
  return declared
}

/**
 * 将一个 bundle 声明解析为其有序的绝对补丁文件路径。
 * @param packageDir - bundle 包的绝对目录。
 * @param bundle - 从 package.json 读取的 bundle 的 `dsh.bundle` 声明。
 * @returns 按应用顺序排列的绝对补丁文件路径。
 * @throws 当 `patch` 既不是字符串也不是字符串列表时抛出 {Error}。
 */
export function bundlePatchPaths(packageDir: string, bundle: DshBundleManifest): string[] {
  return bundlePatchFiles(bundle).map(file => join(packageDir, file))
}

/** profile 的一个已解析 bundle 层。 */
export interface ProfileLayer {
  /** 在 `dsh.profile.bundles` 中列出的、该 bundle 的包名。 */
  packageName: string
  /** 已解析 bundle 包的绝对目录。 */
  packageDir: string
  /** 该 bundle 补丁文件的绝对路径，按应用顺序排列。 */
  patchPaths: readonly string[]
  /** 每个文件已解析的补丁列表，按应用顺序拼接。 */
  patches: PatchOptions[]
}

/** 一个已加载的 profile：已解析的 bundle 层，加上用户自己的补丁层。 */
export interface Profile {
  /** profile 名称（其目录 basename）。 */
  name: string
  /** 绝对的 profile 目录。 */
  dir: string
  /** 按 `dsh.profile.bundles` 顺序排列的 bundle 层。 */
  layers: ProfileLayer[]
  /** profile 自身补丁文件的绝对路径。 */
  patchPath: string
  /** profile 自身的补丁；文件缺失时为空。 */
  patches: PatchOptions[]
  /** 未贡献任何层的、被选中的 bundle，按 `dsh.profile.bundles` 顺序排列，并附原因。 */
  skippedBundles: SkippedBundle[]
}

/** 一个 profile 无法加载、或其自身 DSH 要求未被该 profile 豁免的、被选中的 bundle。 */
export interface SkippedBundle {
  /** 来自 `dsh.profile.bundles` 的、该 bundle 的包名。 */
  packageName: string
  /** 解析、清单、兼容性，或补丁加载的失败原因。 */
  reason: string
}

/**
 * 每个被跳过的 bundle 只打印一次；加载过程从不打印，因此启动器在每次启动时调用一次。
 * @param binName - 诊断前缀。
 * @param profile - 已加载的 profile。
 */
export function reportSkippedBundles(binName: string, profile: Pick<Profile, 'skippedBundles'>): void {
  for (const { packageName, reason } of profile.skippedBundles) {
    process.stderr.write(`${binName}: skipping profile bundle ${JSON.stringify(packageName)}: ${reason}\n`)
  }
}

/** 运行时解析在拦截层提供的一个包。 */
export interface RuntimeResolutionEntry {
  /** 裸包名。 */
  readonly name: string
  /** 由既有依赖遍历选中的包目录。 */
  readonly packageDir: string
  /** 当清单声明了版本时被选中的包版本。 */
  readonly version: string | undefined
  /** 其依赖边选中了此包的清单。 */
  readonly declarer: string
  /** 每个 profile 还是只有活动 profile 接收此条目。 */
  readonly scope: 'installation' | 'profile'
}

/**
 * 一个链接到共享 profiles 树与活动 profile 之外目录的、profile 的 node_modules 条目。
 * `realPath` 之下的导入者使用 Node 真实的祖先链，并在每个 node_modules 位置读取 peer 映射。
 */
export interface LinkedRoot {
  /** profile 的 `node_modules` 条目的包名，包括其 scope。 */
  readonly name: string
  /** 位于共享 profiles 树与活动 profile 之外的真实目录；package.json 可有可无。 */
  readonly realPath: string
}

/** 一次 profile 启动所用的、完整的不可变包表。 */
export interface RuntimeResolution {
  /** 容纳所有 profile 的目录；其 node_modules 是拦截层。 */
  readonly profilesDir: string
  /** 活动 profile 目录，当包含了 profile 作用域条目时。 */
  readonly profileDir: string | undefined
  /** 在 profile 自身 node_modules 中安装的、由 profile 声明的包。 */
  readonly localPackageNames: readonly string[]
  /** 安装作用域条目在前、profile 作用域条目在后，按优先级顺序排列。 */
  readonly entries: readonly RuntimeResolutionEntry[]
  /** 指向外部目录的活动 profile 链接，按名称排序。 */
  readonly linkedRoots: readonly LinkedRoot[]
}

/**
 * 解析 profile 在 Harness home 之下的目录。
 * @param name - profile 名称（`dsh --profile <name>`）。
 * @param home - Harness home；默认为 {@link resolveDshHome}。
 * @returns 绝对的 profile 目录（可能尚不存在）。
 */
export function resolveProfileDir(name: string, home: string = resolveDshHome()): string {
  if (name === '' || name.includes('/') || name.includes('\\') || name === '.' || name === '..'
    // Node 为依赖查找保留了该名称。
    || name === 'node_modules') {
    throw new Error(`dsh: invalid profile name ${JSON.stringify(name)}`)
  }
  return join(home, PROFILES_DIR, name)
}

/** 按名称列出的、首次使用时自动初始化的已发布 profile 模板。 */
export const PROFILE_TEMPLATES: Record<string, ProfileTemplate> = {
  acp: {
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'],
  },
  web: {
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
  },
  headless: {
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
  },
  sdk: {
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'],
  },
  'sdk-minimal': {
    bundles: ['@deepseek-ai/dsh-sdk-minimal'],
  },
}

/** 归一化到已发布模板的、安装所拥有的 bundle 元组。 */
const INSTALLATION_OWNED_PROFILE_TUPLES: Record<string, readonly string[]> = {
  headless: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless'],
}

/**
 * 早期发布所携带、而安装不再提供的 bundle；
 * {@link loadProfileDirectory} 会将它们从 profile 的 bundle 列表中移除。
 */
const RETIRED_BUNDLES: ReadonlySet<string> = new Set([
  // Web 组合自行挂载 Schedule
  // ([升级指南](../../../../docs/upgrade-guide/v0.2.0-rc.2/schedule-bundle-retired/guide.md)).
  '@deepseek-ai/dsh-experimental-schedule-bundle',
])

/** 对于一个没有已发布模板的名称，`dsh plugin` init 所使用的 bundle 列表。 */
export const DEFAULT_PROFILE_BUNDLES: readonly string[] = ['@deepseek-ai/dsh-base']

/**
 * dsh 安装随附、供用户开启的 bundle：每一个都是安装的运行时依赖，且声明了
 * `dsh.bundle.patch`、一个 `icon` 与 `./locale/*.json` 展示元数据，不被任何
 * 已发布模板选中，并由插件管理器以关闭状态提供
 *（[理由](../../../../.agents/notes/implemented/process/2026-09-15-shipped-optional-bundles.md)、
 * [准入](../../../../.agents/notes/implemented/architecture/2026-09-21-experimental-capabilities-as-optional-bundles.md)）。
 */
export const OPTIONAL_BUNDLES: readonly string[] = [
  '@deepseek-ai/dsh-experimental-session-search',
  '@deepseek-ai/dsh-experimental-ralph-bundle',
  '@deepseek-ai/dsh-experimental-terminal-bundle',
  '@deepseek-ai/dsh-experimental-badge-skill-bundle',
  '@deepseek-ai/dsh-experimental-session-titles-bundle',
  '@deepseek-ai/dsh-experimental-agent-team-profile',
  '@deepseek-ai/dsh-experimental-voice-input-bundle',
  '@deepseek-ai/dsh-experimental-cot-translation-bundle',
  '@deepseek-ai/dsh-experimental-auto-review',
  '@deepseek-ai/dsh-experimental-inspector-profile',
  '@deepseek-ai/dsh-experimental-plugin-market-bundle',
  '@deepseek-ai/dsh-experimental-tool-worktree',
]

const PROFILE_PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`

// 提升式链接器为树外插件提供一个扁平的 node_modules，其缺失的 peer（cordis 等）使用
// 运行时解析，因此每个插件共享安装单一 cordis 实例，而非重复的一份。pnpm ≥10
// 从 pnpm-workspace.yaml 读取设置，而非 .npmrc。
const PROFILE_PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

/**
 * 初始化一个 profile 目录：清单、空的用户补丁层，以及树外插件所需的
 * pnpm 设置。已存在的文件绝不会被触碰，因此在一个已初始化的 profile 上重跑是空操作。
 * @param dir - 来自 {@link resolveProfileDir} 的 profile 目录。
 * @param bundles - 初始的 `dsh.profile.bundles` 层列表。
 */
export function initProfile(
  dir: string,
  bundles: readonly string[],
): void {
  mkdirSync(dir, { recursive: true })
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) {
    const manifest: ProfileManifest & { private: boolean } = {
      name: `dsh-profile-${basename(dir)}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [...bundles] } },
    }
    writeFileSync(manifestPath, JSON.stringify(manifest, undefined, 2) + '\n')
  }
  const patchPath = join(dir, PROFILE_PATCH_FILENAME)
  if (!existsSync(patchPath)) writeFileSync(patchPath, PROFILE_PATCH_TEMPLATE)
  const workspacePath = join(dir, 'pnpm-workspace.yaml')
  if (!existsSync(workspacePath)) writeFileSync(workspacePath, PROFILE_PNPM_WORKSPACE)
}

/** dsh 0.1.5 发布的链接后端将 bundle 携带的包投影到一个 profile 中的目录。 */
const LINK_PROJECTION_DIR = '.dsh-module-fallback'

/**
 * 移除一个链接后端启动留在 profile 中的包投影。
 * 只有 profile 的 `node_modules` 之下、其目标位于
 * `<profile>/.dsh-module-fallback/node_modules` 内的符号链接会被解除链接，随后该目录被移除；
 * pnpm 安装的包以及所有其它符号链接保持不变。没有该目录的 profile 不受影响。
 * @param dir - profile 目录。
 */
export function removeLinkProjections(dir: string): void {
  const owned = join(dir, LINK_PROJECTION_DIR)
  if (!existsSync(owned)) return
  const ownedModules = join(owned, 'node_modules')
  for (const link of symlinksUnder(join(dir, 'node_modules'))) {
    if (pointsInto(link, ownedModules)) unlinkSync(link)
  }
  rmSync(owned, { recursive: true, force: true })
}

/** node_modules 目录下、作为符号链接或 junction 的顶层与带 scope 条目。 */
function symlinksUnder(modules: string): string[] {
  const links: string[] = []
  if (!existsSync(modules)) return links
  for (const entry of readdirSync(modules, { withFileTypes: true })) {
    const path = join(modules, entry.name)
    if (entry.isSymbolicLink()) {
      links.push(path)
    } else if (entry.name.startsWith('@') && entry.isDirectory()) {
      for (const child of readdirSync(path, { withFileTypes: true })) {
        if (child.isSymbolicLink()) links.push(join(path, child.name))
      }
    }
  }
  return links
}

/**
 * 链接到共享 profiles 树与活动 profile 之外的、活动 profile 的 `node_modules` 条目。
 * 缺失的目标与文件不算链接根；无效的链接链保留 Node 的诊断。
 */
function linkedProfileRoots(profile: Profile, profilesDir: string): LinkedRoot[] {
  const modules = join(profile.dir, 'node_modules')
  const links = symlinksUnder(modules)
  if (links.length === 0) return []
  let tree: string
  try {
    tree = realModuleDirectory(profilesDir) + sep
  } catch (error) {
    // 尚未落实的 profiles 树不包含任何链接。
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    tree = resolve(profilesDir) + sep
  }
  const excludedTrees = [tree, realModuleDirectory(profile.dir) + sep]
  const roots: LinkedRoot[] = []
  for (const linkPath of links) {
    let realPath: string
    try {
      realPath = realModuleDirectory(linkPath)
    } catch (error) {
      // 一个悬挂的链接不是 Node 可从 profile 加载的包。
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      continue
    }
    if (excludedTrees.some(prefix => realPath + sep === prefix || realPath.startsWith(prefix))
      || !statSync(realPath).isDirectory()) continue
    roots.push({ name: relative(modules, linkPath).split(sep).join('/'), realPath })
  }
  return roots.sort((left, right) => left.name.localeCompare(right.name))
}

/** 一个符号链接的目标目录是否就是 `root`，或位于其之下。 */
function pointsInto(link: string, root: string): boolean {
  try {
    const target = resolve(dirname(link), readlinkSync(link))
    const parent = realpathSync.native(dirname(target))
    const rootPath = realpathSync.native(root)
    return parent === rootPath || parent.startsWith(rootPath + sep)
  } catch (error) {
    // 父目录已不存在的目标不可能是本次启动所拥有的投影之一。
    /* v8 ignore next 2 -- 非 ENOENT 的 realpath 失败需要宿主文件系统故障 */
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    /* v8 ignore next -- 参见上方的宿主文件系统异常 */
    throw error
  }
}

/** 在遍历依赖图时读取一个包清单。 */
function readPackageManifest(anchor: string): ProfileManifest {
  return JSON.parse(readFileSync(anchor, 'utf8')) as ProfileManifest
}

/** 返回可能被 loader 可见的插件导入的依赖名。 */
function profileDependencyNames(manifest: ProfileManifest): string[] {
  return [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]
}

/** 解析运行时解析器提供给每个 profile 的安装包。 */
function collectInstallationScopePackages(
  installAnchor: string, skippedBundles: ReadonlySet<string>,
): {
  packageNames: ReadonlySet<string>
  packageDirs: ReadonlyMap<string, string>
  declarers: ReadonlyMap<string, string>
  versions: ReadonlyMap<string, string | undefined>
} {
  // 真实的声明路径可防止 node_modules 下的 workspace 符号链接禁用 tsx 路径映射。
  const canonicalAnchor = join(realModuleDirectory(dirname(installAnchor)), basename(installAnchor))
  const appManifest = readPackageManifest(canonicalAnchor)
  const links = new Map<string, string>()
  const declarers = new Map<string, string>()
  const versions = new Map<string, string | undefined>()
  /* v8 ignore next -- 真实的 app 清单始终声明其名称 */
  if (appManifest.name !== undefined) {
    // CLI 从 import.meta.url（已是真实路径）推导安装锚点，Desktop Host 从其运行时目录（非符号链接）推导；
    // 该目录按原样保留，而非在此处规范化。
    links.set(appManifest.name, dirname(installAnchor))
    declarers.set(appManifest.name, canonicalAnchor)
    versions.set(appManifest.name, appManifest.version)
  }
  // 在可解析的依赖图上做 BFS；已访问集合就是链接映射本身
  //（首次解析胜出，与 Node 自身的“最近优先”一致）。
  const queue: { anchor: string; manifest: ProfileManifest }[] = [{ anchor: canonicalAnchor, manifest: appManifest }]
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    // peer 依赖也参与：Service Definition 包（dsh-subprocess、dsh-compaction 等）是其实现的
    // peer，而非普通依赖，但树外插件会直接导入它们。
    /* v8 ignore next -- 真实的 app 清单始终声明依赖 */
    for (const dep of profileDependencyNames(next.manifest)) {
      if (links.has(dep)) continue
      const dir = packageDirFromAnchor(next.anchor, dep)
      // 已声明却未安装的依赖不可能是 loader 可见的插件；跳过它，而非让整个启动失败。
      if (dir === undefined) continue
      const manifestPath = join(realModuleDirectory(dir), 'package.json')
      let manifest: ProfileManifest
      try {
        manifest = skippedBundles.has(dep) ? readProfileManifest('dsh', dir) : readPackageManifest(manifestPath)
      } catch (error) {
        if (!skippedBundles.has(dep)) throw error
        continue
      }
      links.set(dep, dir)
      declarers.set(dep, next.anchor)
      versions.set(dep, manifest.version)
      queue.push({ anchor: manifestPath, manifest })
    }
  }
  return { packageNames: new Set(links.keys()), packageDirs: links, declarers, versions }
}

/** {@link createRuntimeResolution} 的输入。 */
export interface RuntimeResolutionOptions {
  /** 运行中的 dsh 安装的绝对 package.json 路径。 */
  installAnchor: string
  /** 已加载的 profile，其选中的 bundle 可能携带 profile 本地插件。 */
  profile?: Profile
  /** Harness home；默认为 {@link resolveDshHome}。 */
  home?: string
}

/**
 * 在不写入模块解析文件的前提下计算运行时解析。
 * @param options - 安装锚点、可选的已加载 profile，以及 Harness home。
 * @returns 完整的、不可变的运行时解析。
 */
export async function createRuntimeResolution(
  options: RuntimeResolutionOptions,
): Promise<ProfileRuntimeResolution> {
  const { installAnchor, profile, home = resolveDshHome() } = options
  const profilesDir = join(home, PROFILES_DIR)
  const manifest = readOptionalProfileManifest(profile)
  const { packageNames, packageDirs, declarers, versions } = collectInstallationScopePackages(
    installAnchor, new Set(profile?.skippedBundles.map(skipped => skipped.packageName)),
  )
  const profileDeclarers = new Map<string, string>()
  const profileVersions = new Map<string, string | undefined>()
  const localPackageNames = profile === undefined ? [] : installedProfilePackageNames(profile, manifest)
  const profilePackages: ReadonlyMap<string, string> = profile === undefined
    ? new Map<string, string>()
    : collectProfileScopePackages(profile, packageNames, profileDeclarers, profileVersions)
  const linkedRoots = profile === undefined ? [] : linkedProfileRoots(profile, profilesDir)
  // 该 Promise 返回类型属于未稳定前的 API；构造不含任何异步步骤。
  return await Promise.resolve(new ProfileRuntimeResolution({ installAnchor, profileDir: profile?.dir, home }, {
    profilesDir,
    profileDir: profile?.dir,
    localPackageNames: Object.freeze(localPackageNames),
    linkedRoots: Object.freeze(linkedRoots.map(root => Object.freeze(root))),
    entries: Object.freeze([
      ...[...packageDirs].map(([name, packageDir]) => Object.freeze({
        name, packageDir, version: versions.get(name),
        declarer: declarers.get(name) as string, scope: 'installation' as const,
      })),
      ...[...profilePackages].map(([name, packageDir]) => Object.freeze({
        name, packageDir, version: profileVersions.get(name),
        declarer: profileDeclarers.get(name) as string, scope: 'profile' as const,
      })),
    ]),
  }))
}

/** 一个 {@link ProfileRuntimeResolution} 用以计算其后继代所复用的输入。 */
interface ResolutionSource {
  installAnchor: string
  home: string
  profileDir: string | undefined
}

/**
 * 一个会记住其计算所依据输入的运行时解析。Worker 环境数据只携带其字段；
 * 输入对计算出它的线程保持私有。
 */
export class ProfileRuntimeResolution implements RuntimeResolution {
  readonly profilesDir: string
  readonly profileDir: string | undefined
  readonly localPackageNames: readonly string[]
  readonly entries: readonly RuntimeResolutionEntry[]
  readonly linkedRoots: readonly LinkedRoot[]
  readonly #source: ResolutionSource

  /**
   * @param source - {@link createRuntimeResolution} 的输入，由 {@link computeLatestResolution} 复用。
   * @param table - 计算得到的包表。
   */
  constructor(source: ResolutionSource, table: RuntimeResolution) {
    this.#source = source
    this.profilesDir = table.profilesDir
    this.profileDir = table.profileDir
    this.localPackageNames = table.localPackageNames
    this.entries = table.entries
    this.linkedRoots = table.linkedRoots
    Object.freeze(this)
  }

  /**
   * 从同一个安装、profile 目录与 Harness home 计算最新的一代，从磁盘重新读取 profile 的清单、
   * bundle 选择与已安装包，且不保留合成层。在没有 profile 目录时，只重新计算安装包。本实例不变。
   * @returns 面向最新一代的新解析。
   */
  computeLatestResolution(): Promise<ProfileRuntimeResolution> {
    const { installAnchor, home, profileDir } = this.#source
    return createRuntimeResolution({
      installAnchor, home,
      ...profileDir === undefined ? {} : { profile: loadProfileDirectory('dsh', profileDir, installAnchor) },
    })
  }
}

/** 直接调用方使用的合成 profile 可能没有磁盘上的清单。 */
function readOptionalProfileManifest(profile: Profile | undefined): ProfileManifest | undefined {
  if (profile === undefined) return undefined
  try {
    return readPackageManifest(join(profile.dir, 'package.json'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** 返回 Node 在 profile 回退之前解析的、已安装的直接依赖。 */
function installedProfilePackageNames(profile: Profile, manifest: ProfileManifest | undefined): string[] {
  if (manifest === undefined) return []
  return profileDependencyNames(manifest)
    .filter(name => existsSync(join(profile.dir, 'node_modules', name, 'package.json')))
}

/** 为每个依赖名收集第一个可解析的包目录。 */
function dependencyClosure(
  anchors: readonly string[], reserved: ReadonlySet<string>,
  declarers?: Map<string, string>,
  versions?: Map<string, string | undefined>,
): Map<string, string> {
  const links = new Map<string, string>()
  const visited = new Set(reserved)
  for (const anchor of anchors) {
    const canonicalAnchor = join(realModuleDirectory(dirname(anchor)), basename(anchor))
    const manifest = readPackageManifest(canonicalAnchor)
    /* v8 ignore next -- 可安装的包清单始终声明其名称 */
    if (manifest.name === undefined) continue
    if (!visited.has(manifest.name)) {
      visited.add(manifest.name)
      links.set(manifest.name, dirname(canonicalAnchor))
      declarers?.set(manifest.name, canonicalAnchor)
      versions?.set(manifest.name, manifest.version)
    }
    const queue: { anchor: string; manifest: ProfileManifest }[] = [{ anchor: canonicalAnchor, manifest }]
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      // Service Provider 包通常会把 Service Definition 作为 peer 暴露。
      /* v8 ignore next -- 可安装的包清单始终声明依赖或 peer */
      for (const dep of profileDependencyNames(next.manifest)) {
        if (visited.has(dep)) continue
        const dir = packageDirFromAnchor(next.anchor, dep)
        // 已声明却未安装的依赖不可能是 loader 可见的。
        if (dir === undefined) continue
        visited.add(dep)
        links.set(dep, dir)
        declarers?.set(dep, next.anchor)
        const manifestPath = join(realModuleDirectory(dir), 'package.json')
        const dependencyManifest = readPackageManifest(manifestPath)
        versions?.set(dep, dependencyManifest.version)
        queue.push({ anchor: manifestPath, manifest: dependencyManifest })
      }
    }
  }
  return links
}

/** 收集该 profile 所选 bundle 携带、而安装并不提供的包。 */
function collectProfileScopePackages(
  profile: Profile, installationPackageNames: ReadonlySet<string>,
  declarers?: Map<string, string>,
  versions?: Map<string, string | undefined>,
): Map<string, string> {
  const bundleAnchors = profile.layers
    .filter(layer => !installationPackageNames.has(layer.packageName))
    .map(layer => join(layer.packageDir, 'package.json'))
  const bundleLinks = dependencyClosure(bundleAnchors, installationPackageNames, declarers, versions)
  for (const layer of profile.layers) bundleLinks.delete(layer.packageName)
  return bundleLinks
}

/**
 * 读取一个 profile 的清单。
 * @param binName - 抛出错误上的诊断前缀。
 * @param dir - profile 目录。
 * @returns 解析后的清单。
 */
export function readProfileManifest(binName: string, dir: string): ProfileManifest {
  const path = join(dir, 'package.json')
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`${binName}: failed to read profile manifest ${path}: ${String(error)}`)
  }
  // 下述字段检查在信任解析类型之前先校验文件数据。
  const parsed = JSON.parse(raw) as ProfileManifest | null
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${binName}: profile manifest ${path} must hold a JSON object`)
  }
  return parsed
}

/**
 * 将 profile 的清单写回（2 空格 JSON，末尾换行）。
 * @param dir - profile 目录。
 * @param manifest - 要持久化保存的清单值。
 */
export function writeProfileManifest(dir: string, manifest: ProfileManifest): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, undefined, 2) + '\n')
}

/** 返回两个 bundle 列表是否拥有相同顺序的相同值。 */
function sameBundles(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/** 返回替换了 `dsh.profile.bundles` 的 `manifest`，同时保留所有其它字段。 */
function withBundles(manifest: ProfileManifest, bundles: readonly string[]): ProfileManifest {
  return {
    ...manifest,
    dsh: {
      ...manifest.dsh,
      profile: {
        ...manifest.dsh?.profile,
        bundles: [...bundles],
      },
    },
  }
}

/**
 * 将一个确切的、安装所拥有的 bundle 元组归一化到其已发布模板，
 * 同时保留所有其它清单字段。其它 bundle 列表保持不变。
 */
function normalizeShippedProfile(name: string, dir: string, manifest: ProfileManifest): ProfileManifest {
  const installationOwned = INSTALLATION_OWNED_PROFILE_TUPLES[name]
  const template = PROFILE_TEMPLATES[name]
  const bundles = manifest.dsh?.profile?.bundles
  if (template === undefined || bundles === undefined) return manifest
  const isRetiredTuple = installationOwned !== undefined && sameBundles(bundles, installationOwned)
  if (!isRetiredTuple) return manifest
  const normalized = withBundles(manifest, template.bundles)
  writeProfileManifest(dir, normalized)
  return normalized
}

/**
 * 从 profile 的 bundle 列表中移除 {@link RETIRED_BUNDLES}，仅当其列出了一个时才将清单写回。
 */
function dropRetiredBundles(dir: string, manifest: ProfileManifest): ProfileManifest {
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const kept = bundles.filter(bundle => !RETIRED_BUNDLES.has(bundle))
  if (kept.length === bundles.length) return manifest
  const normalized = withBundles(manifest, kept)
  writeProfileManifest(dir, normalized)
  return normalized
}

/**
 * 从一个锚点解析一个包的根目录，而不依赖该包导出 `./package.json`（`require.resolve` 需要它）：
 * 探查 require 解析路径，寻找持有该具名清单的目录。这正是 Node 自身的 node_modules 查找顺序，
 * 因此结果与 Loader 从同一锚点导入时所得到的一致，且 `existsSync` 会跟随 pnpm 隔离式布局所用的符号链接。
 */
function packageDirFromAnchor(anchor: string, packageName: string): string | undefined {
  // resolve.paths 只对内置模块返回 null，而没有任何 bundle 名是内置模块。
  /* v8 ignore next */
  for (const searchPath of createRequire(anchor).resolve.paths(packageName) ?? []) {
    const candidate = join(searchPath, packageName)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

/**
 * 解析一个 bundle 包的目录：先是安装锚点，然后是 profile 目录。这种“安装优先”的顺序是一项约定，
 * 即 `@deepseek-ai/dsh-base`（以及每一个其它内置 bundle）始终来自与运行中 dsh 相同的安装，
 * 而非 profile 本地的副本。解析并不要求该包导出 `./package.json`。
 * @param binName - 抛出错误上的诊断前缀。
 * @param packageName - 来自 `dsh.profile.bundles` 的 bundle 包名。
 * @param installAnchor - dsh app 包内部某个文件的绝对路径（即其 package.json）。
 * @param profileDir - profile 目录（第二个锚点）。
 * @returns 该 bundle 包的绝对目录。
 */
export function resolveBundleDir(
  binName: string, packageName: string, installAnchor: string, profileDir: string,
): string {
  for (const anchor of [installAnchor, join(profileDir, 'package.json')]) {
    const dir = packageDirFromAnchor(anchor, packageName)
    if (dir !== undefined) return dir
  }
  throw new Error(
    `${binName}: cannot resolve profile bundle ${JSON.stringify(packageName)} from the dsh installation or ${profileDir}; `
    + `run 'dsh plugin --profile ${basename(profileDir)} install' if its dependency is not installed`,
  )
}

/**
 * 加载一个已初始化的 profile 目录，而不通过共享的 Harness home 去解析它。这由“应用所拥有”的
 * profile 使用，其包项目与生命周期属于该应用。
 * 退役的 bundle 首先从存储的 bundle 列表中移除，并在其列出了一个时重写清单。不可读的 bundle，
 * 以及其自身 dsh 要求未被该 profile 豁免的 bundle，会被跳过而不改动清单，并列入 `skippedBundles`；
 * 不会打印任何内容。
 * @param binName - 抛出错误上的诊断前缀。
 * @param dir - 绝对的 profile 包目录。
 * @param installAnchor - 所属 dsh app 的 package.json 的绝对路径。
 * @param options - `userLayer: false` 跳过读取 `cordis.patch.yml`。
 * @returns 成功加载的 bundle 层与可选的用户补丁层。
 */
export function loadProfileDirectory(
  binName: string,
  dir: string,
  installAnchor: string,
  options: { userLayer?: boolean } = {},
): Profile {
  const manifest = dropRetiredBundles(dir, readProfileManifest(binName, dir))
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const layers: ProfileLayer[] = []
  const skippedBundles: SkippedBundle[] = []
  const exemptions = bundles.length === 0 ? {} : readProfileVersionExemptions(dir)
  for (const packageName of bundles) {
    try {
      const packageDir = resolveBundleDir(binName, packageName, installAnchor, dir)
      const bundleManifest = readProfileManifest(binName, packageDir)
      const bundle = bundleManifest.dsh?.bundle
      if (bundle === undefined) {
        throw new Error(`${binName}: profile bundle ${JSON.stringify(packageName)} declares no dsh.bundle in its package.json`)
      }
      // bundle 不是插件行，因此行准入绝不会读取其自身的 dsh 要求。
      const issue = evaluatePluginCompatibility(bundleManifest, exemptions)
      if (issue !== undefined && !issue.exempted) throw new Error(pluginCompatibilityWarning(issue))
      const patchPaths = bundlePatchPaths(packageDir, bundle)
      const patches = patchPaths.flatMap(patchPath => loadOverlayPatches(binName, patchPath))
      layers.push({ packageName, packageDir, patchPaths, patches })
    } catch (error) {
      skippedBundles.push({ packageName, reason: String(error) })
    }
  }
  const patchPath = join(dir, PROFILE_PATCH_FILENAME)
  const patches = options.userLayer !== false && existsSync(patchPath)
    ? loadOverlayPatches(binName, patchPath)
    : []
  return { name: basename(dir), dir, layers, patchPath, patches, skippedBundles }
}

/**
 * 加载一个 profile：将每一个 `dsh.profile.bundles` 条目解析到其补丁层，并解析 profile 自身的补丁文件。
 * 不可读或不兼容的 bundle 会被跳过并列入 `skippedBundles`；profile 清单与用户补丁错误仍会抛出。
 * @param binName - 抛出错误上的诊断前缀。
 * @param name - profile 名称。
 * @param installAnchor - dsh app 的 package.json 的绝对路径（第一个解析锚点）。
 * @param home - Harness home；默认为 {@link resolveDshHome}。
 * @param options - `userLayer: false` 跳过读取 `cordis.patch.yml`，从而使一个
 * 只消费 bundle 的消费者（`--dump-default-config`、一项恢复诊断）不会因坏掉的用户层而失败。
 * @returns 加载后的 profile（当跳过用户层时 `patches` 为空）。
 */
export function loadProfile(
  binName: string, name: string, installAnchor: string, home: string = resolveDshHome(),
  options: { userLayer?: boolean } = {},
): Profile {
  const dir = resolveProfileDir(name, home)
  if (!existsSync(join(dir, 'package.json'))) {
    const template = PROFILE_TEMPLATES[name]
    if (template === undefined) {
      throw new Error(
        `${binName}: profile ${JSON.stringify(name)} does not exist; create it with 'dsh plugin --profile ${name} add <package>'`,
      )
    }
    initProfile(dir, template.bundles)
  }
  removeLinkProjections(dir)
  normalizeShippedProfile(name, dir, readProfileManifest(binName, dir))
  return loadProfileDirectory(binName, dir, installAnchor, options)
}

/**
 * 将补丁层组合到空根之上的有效条目列表——这正是启动 include 所做的那一次
 * `applyEntryPatches` 调用，因此标志派生与配置 dump 看到的正好就是被挂载的内容。
 * @param layers - 按应用顺序排列的补丁列表。
 * @param warn - 被跳过补丁诊断的接收处；默认为静默（启动会重复它们）。
 * @returns 组合后的条目列表。
 */
export function composeEntries(
  layers: readonly PatchOptions[][], warn: (message: string) => void = () => {},
): EntryOptions[] {
  return applyEntryPatches([], structuredClone(layers.flat()), (message: string, ...args: unknown[]) => {
    let index = 0
    warn(message.replace(/%C/g, () => JSON.stringify(args[index++])))
  })
}
