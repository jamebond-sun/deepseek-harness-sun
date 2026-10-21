/** 面向 Node 默认 ESM 与 CommonJS 加载器的、内存中的 profile 包路由。 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire, isBuiltin } from 'node:module'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { getEnvironmentData, setEnvironmentData } from 'node:worker_threads'
import type { ModuleLoaderV1, ModuleLoaderV2, ResolveResult } from '@deepseek-ai/cordis-plugin-loader'
import { imports as resolvePackageImports, type Package as ResolvePackageManifest } from 'resolve.exports'
import type { RuntimeResolutionEntry, RuntimeResolution } from '../profile.ts'

const WORKER_RESOLUTION_KEY = '@deepseek-ai/dsh-app-boot/profile-resolution'
const EMPTY_ATTRIBUTES: ImportAttributes = Object.freeze({})

interface CommonJsParent {
  filename?: string | null
  parent?: CommonJsParent | null
  paths?: string[]
}

interface CommonJsOptions {
  paths?: string[]
  conditions?: ReadonlySet<string>
}

interface CommonJsModule {
  new(id?: string, parent?: CommonJsParent): CommonJsParent
  _nodeModulePaths(path: string): string[]
  _resolveFilename(
    request: string, parent: CommonJsParent | null | undefined, isMain: boolean, options?: CommonJsOptions,
  ): string
}

interface InternalModules {
  esm: ModuleLoaderV1 | ModuleLoaderV2
  esmDefaultResolve: (
    specifier: string,
    context: { parentURL?: string; conditions?: readonly string[] },
  ) => ResolveResult
  esmConditions: readonly string[]
  cjs: CommonJsModule
  cjsConditions: ReadonlySet<string>
  modern: boolean
}

type EsmResolve = (
  request: string, parent: string | undefined, attributes: ImportAttributes,
) => ResolveResult | Promise<ResolveResult>

/**
 * Node 在一个带作用域的裸请求上继续解析的位置。`native` 保留导入者自身的查找：该链在
 * 拦截层之下得到应答。`interception` 在拦截层、从条目的声明清单作答；`after` 在 entry 缺少的
 * 一个 CommonJS 子路径上，把 Node 的链锚定到拦截层之上。`native-after-interception` 从 `parent`
 * 恢复 Node 的链：对于没有条目的一个名称为拦截层，或在一次 `interception` 子路径未命中之后为其上层。
 */
type ResolutionRoute =
  | { readonly kind: 'interception'; readonly entry: RuntimeResolutionEntry; readonly after: string }
  | { readonly kind: 'native-after-interception'; readonly parent: string }
  | { readonly kind: 'native'; readonly packageDir?: string }

interface ResolutionRouteState {
  readonly route: ResolutionRoute
  packageDir?: string
  esm?: ResolveResult
  cjs?: string
}

interface CommonJsLookup {
  readonly cacheable: boolean
  resolveNative(searchPaths: readonly string[]): string
  resolveEntry(entry: RuntimeResolutionEntry, after: string): string
}

/** 一个拦截层在其导入者祖先链上固定的查找位置。 */
interface LayerPositions {
  /** 带有此前缀的查找路径位于该层之下，并由其物理内容应答。 */
  readonly localPrefix: string
  /** 在层的物理目录处锚定 Node 查找的清单。 */
  readonly nativeAfter: string
  /** 在一次 CommonJS 子路径未命中之后，于层之上锚定 Node 查找的清单。 */
  readonly after: string
}

/**
 * 一个导入者的拦截层。profile 的层是其父级的 node_modules，并应答活动 profile 的每一个条目。
 * 链接式导入者会在每个祖先 node_modules 位置应用当前的 peer 声明，而不记忆所选的路由。
 */
type InterceptionLayer =
  | LayerPositions & { readonly kind: 'profile'; readonly active: boolean }
  | { readonly kind: 'linked' }

interface ParentRoutes {
  readonly parent: string
  readonly layer: InterceptionLayer
  readonly requests: Map<string, ResolutionRouteState>
  selfReferenceName?: string | false | null
}

type ResolutionRoutes = Map<string, ParentRoutes | false>

/** 一个带有其模块所加载真实目录的、已发布的条目。 */
interface CompiledEntry extends RuntimeResolutionEntry {
  readonly realDir: string
}

interface CompiledResolution {
  readonly entries: ReadonlyMap<string, CompiledEntry>
  readonly profilesDir: string
  readonly profileDir: string | undefined
  readonly profilePaths: readonly string[]
  readonly profile: readonly string[]
  readonly installationPaths: readonly string[]
  readonly linkedPaths: readonly string[]
  readonly localPackageNames: ReadonlySet<string>
  readonly esmRoutes: ResolutionRoutes
  readonly cjsRoutes: ResolutionRoutes
}

/** 运行中的进程无法采纳的一个后继解析，例如位于另一个目录中的、被保留的映射；它要等待重启。 */
export class ResolutionRestartRequired extends Error {
  /** @param message 点名被拒绝变更的诊断。 */
  constructor(message: string) {
    super(message)
    this.name = 'ResolutionRestartRequired'
  }
}

/** 一个 Node 隔离体中的活跃拦截。 */
export interface RuntimeInterception {
  /**
   * 在不要求其一处导出物的前提下定位一个裸包。
   * 一个包子路径会选中其包目录，而不解析或校验所请求的文件。
   * @param specifier - 裸包或包子路径指示符。
   * @param parentURL - 适用其查找顺序的文件 URL。
   * @returns 选中的包目录；当不存在时为 undefined。
   */
  packageDir(specifier: string, parentURL: string): string | undefined
  /**
   * 以原子方式发布一个完整的后继代与全新的缓存。profile 作用域映射、本地名称与链接根可以被移除；
   * 被移除的根停止拦截未被覆盖的目录。一个被保留的 profile 映射可在其归一化目录与作用域保持不变时
   * 改变其版本与声明者，正如一个包就地升级时那样。既有的模块与 Node 缓存保持完好：调用方只在某包
   * 的插件停止之后才移除它，并另行替换就地升级包的已加载模块。一个先前发布的链接名可能指向另一个真实
   * 目录；调用方要先停止其先前目标的插件，正如移除并重新安装该包时所做的那样。
   * @param successor - 完全构造好、保留了安装映射的那一代。
   * @throws 当 profile 作用域改变时抛出；而当被保留的 profile 映射的真实目录或作用域、或安装的版本或
   * 声明者改变时，或一条安装映射被移除时，或一个新的本地名称覆盖了一条既有映射时，抛出 `ResolutionRestartRequired`。
   */
  replace(successor: RuntimeResolution): void
  /** 恢复原生的解析器方法。拦截按逆序释放。 */
  dispose(): void
}

/**
 * 在不分配路径段的前提下，将一个裸请求拆分为其包名。
 * @param request - 待分类的模块指示符。
 * @returns 裸包名；对于非包请求为 undefined。
 */
export function barePackageName(request: string): string | undefined {
  if (!request || request[0] === '.' || request[0] === '/' || request[0] === '\\'
    || request[0] === '#' || request.includes(':') || isBuiltin(request)) return
  const first = request.indexOf('/')
  if (request[0] !== '@') return first < 0 ? request : request.slice(0, first)
  if (first < 0) return
  const second = request.indexOf('/', first + 1)
  return second < 0 ? request : request.slice(0, second)
}

/** 一个现存目录的 JavaScript 与原生真实路径；对不再存在的目录则为空。 */
function realSpellings(path: string): string[] {
  try {
    // 打包后的 worker 的文件系统没有原生 realpath。
    const native: unknown = Reflect.get(realpathSync, 'native')
    return [realpathSync(path), ...typeof native === 'function' ? [String(Reflect.apply(native, realpathSync, [path]))] : []]
  } catch (_error) {
    // 一个已移除的前置目录只保留其被记录的拼写。
    return []
  }
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    // 运行时解析可能在该目录被落实之前就点名一个 profile 作用域。
    return resolve(path)
  }
}

function prefixes(path: string): readonly string[] {
  const configured = resolve(path) + sep
  const canonical = canonicalPath(path) + sep
  return canonical === configured ? [configured] : [configured, canonical]
}

function compileResolution(resolution: RuntimeResolution): CompiledResolution {
  return {
    entries: new Map(resolution.entries.map(entry => [entry.name, { ...entry, realDir: canonicalPath(entry.packageDir) }])),
    profilesDir: resolution.profilesDir,
    profileDir: resolution.profileDir,
    profilePaths: prefixes(resolution.profilesDir),
    profile: resolution.profileDir === undefined ? [] : prefixes(resolution.profileDir),
    installationPaths: [...new Set(resolution.entries
      .filter(entry => entry.scope === 'installation')
      .flatMap(entry => prefixes(entry.packageDir)))],
    linkedPaths: resolution.linkedRoots.flatMap(root => prefixes(root.realPath)),
    localPackageNames: new Set(resolution.localPackageNames),
    esmRoutes: new Map(),
    cjsRoutes: new Map(),
  }
}

/**
 * 一个 profile 的拦截层是 `<profileParent>/node_modules`：一个条目在其中占用自己的名称，因此它的
 * 子路径未命中会在其上方继续，而一个没有条目的名称会在它那里继续。
 */
function computeProfileLayer(dir: string, active: boolean): InterceptionLayer {
  const profileParent = dirname(dir)
  return {
    kind: 'profile', active,
    localPrefix: dir + sep,
    nativeAfter: join(profileParent, 'package.json'),
    after: join(dirname(profileParent), 'package.json'),
  }
}

/** 一个模块路径的拦截层：来自其在 profiles 树内的 profile 目录，或它的链接根。 */
function findInterceptionLayer(path: string, resolution: CompiledResolution): InterceptionLayer | undefined {
  const treeRoot = resolution.profilePaths.find(prefix => path.startsWith(prefix))
  const activeProfile = resolution.profile.find(prefix => path.startsWith(prefix))
  const dir = treeRoot !== undefined ? profileChild(path, treeRoot) : activeProfile?.slice(0, -1)
  if (dir !== undefined) return computeProfileLayer(dir, activeProfile !== undefined)
  if (!startsWithin(path, resolution.linkedPaths)) return undefined
  if (startsWithin(path, resolution.installationPaths)) return undefined
  return { kind: 'linked' }
}

/** 一个目录当前清单列为 peer 的包名；一个不可读的清单不列出任何名称。 */
function readPeerNames(directory: string): ReadonlySet<string> {
  try {
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
      peerDependencies?: unknown
    }
    const peers = manifest.peerDependencies
    return new Set(peers !== null && typeof peers === 'object' ? Object.keys(peers) : [])
  } catch (_error) {
    // Node 在解析该包自身的导入时会自行报告不可读或无效的清单。
    return new Set()
  }
}

function startsWithin(path: string, roots: readonly string[]): boolean {
  for (const root of roots) {
    if (path.startsWith(root)) return true
  }
  return false
}

/**
 * 拥有 profiles 树内某个模块的 profile 目录：树根之下的第一个路径段。
 * @param path - `treePrefix` 之下的模块路径。
 * @param treePrefix - 带有尾部分隔符的 profiles 目录。
 * @returns 不带尾部分隔符的 profile 目录。
 */
function profileChild(path: string, treePrefix: string): string {
  const rest = path.slice(treePrefix.length)
  const end = rest.indexOf(sep)
  return treePrefix + (end < 0 ? rest : rest.slice(0, end))
}

function nativePackageDir(parent: string, name: string): string | undefined {
  for (const searchPath of createRequire(parent).resolve.paths(name) as string[]) {
    const candidate = join(searchPath, name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

function localPackageCandidate(searchPath: string, name: string, flavor: 'esm' | 'cjs'): string | undefined {
  const candidate = join(searchPath, name)
  const stat = statSync(candidate, { throwIfNoEntry: false })
  const found = flavor === 'esm'
    ? stat?.isDirectory() === true
    : stat !== undefined
      || ['.js', '.json', '.node'].some(extension => existsSync(candidate + extension))
  return found ? candidate : undefined
}

function selfReferenceName(parent: string): string | false | null {
  let current = dirname(parent)
  while (true) {
    const manifestPath = join(current, 'package.json')
    if (existsSync(manifestPath)) {
      let manifest: Record<string, unknown>
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
      } catch (_error) {
        // 只有 Node 决定该请求是否消费一个无效的包清单。
        return null
      }
      return typeof manifest.name === 'string' && manifest.exports != null
        ? manifest.name
        : false
    }
    /* v8 ignore next -- 带作用域的模块请求通常会在 node_modules 之前找到其拥有者清单。 */
    if (basename(current) === 'node_modules') return false
    const next = dirname(current)
    if (next === current) return false
    current = next
  }
}

function packageImportsTarget(
  parent: string, request: string, conditions: Iterable<string>,
): { specifier: string; parentURL: string } | undefined {
  let current = dirname(parent)
  while (true) {
    const manifestPath = join(current, 'package.json')
    if (existsSync(manifestPath)) {
      let manifest: ResolvePackageManifest
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ResolvePackageManifest
      } catch (_error) {
        // 原生解析器保留无效的包目标与清单诊断。
        /* v8 ignore next -- 原生解析在无效作用域清单之后不可能报告 MODULE_NOT_FOUND */
        return undefined
      }
      try {
        const target = resolvePackageImports(manifest, request, {
          conditions: [...conditions],
          unsafe: true,
        })?.[0]
        return target !== undefined && barePackageName(target) !== undefined
          ? { specifier: target, parentURL: pathToFileURL(manifestPath).href }
          : undefined
      } catch (_error) {
        // 原生解析器保留缺失的映射与不匹配条件的诊断。
        /* v8 ignore next -- 原生解析在选择有效映射之前不可能报告 MODULE_NOT_FOUND */
        return undefined
      }
    }
    if (basename(current) === 'node_modules') return undefined
    const next = dirname(current)
    /* v8 ignore next -- MODULE_NOT_FOUND 的包导入目标始终拥有其所属包作用域 */
    if (next === current) return undefined
    current = next
  }
}

function packageSearchPaths(
  entry: RuntimeResolutionEntry, request: string, cjs: CommonJsModule,
): string[] {
  const name = barePackageName(request)
  /* v8 ignore next -- 拦截路由只为裸包请求而创建 */
  if (name === undefined) return cjs._nodeModulePaths(dirname(entry.declarer))
  const suffix = sep + name.split('/').join(sep)
  return entry.packageDir.endsWith(suffix)
    ? [entry.packageDir.slice(0, -suffix.length)]
    : cjs._nodeModulePaths(dirname(entry.declarer))
}

function localCandidateOwnsResolution(candidate: string, resolved: string, request: string, name: string): boolean {
  if (startsWithin(resolved, prefixes(candidate))) return true
  if (sameResolution(candidate, resolved)) return true
  if (['.js', '.json', '.node'].some(extension => sameResolution(candidate + extension, resolved))) return true
  /* v8 ignore next -- 有界的原生查找只能经由其根目录的遗留 main 逃出候选 */
  if (request !== name) return false
  try {
    const manifest = JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8')) as Record<string, unknown>
    /* v8 ignore next -- 包目录之外的有界原生查找需要遗留 main */
    if (typeof manifest.main !== 'string') return false
    const main = createRequire(join(candidate, 'package.json')).resolve(resolve(candidate, manifest.main))
    return sameResolution(main, resolved)
  } catch (_error) {
    // 原生解析已经负责畸形清单与缺失的遗留条目。
    /* v8 ignore next -- 此辅助函数只在相同的原生解析成功之后运行 */
    return false
  }
}

function isUnselectedPackageMiss(error: unknown): boolean {
  const failure = error as NodeJS.ErrnoException & { path?: unknown }
  return failure.code === 'MODULE_NOT_FOUND' && failure.path === undefined
}

function sameResolution(left: string, right: string): boolean {
  if (left === right) return true
  return canonicalPath(left) === canonicalPath(right)
}

/** 一个目录在给定形式、以及其 JavaScript 与原生真实路径下的形式，每种都带尾部分隔符。 */
function spellings(dir: string): string[] {
  const result = new Set([dir + sep])
  for (const real of realSpellings(dir)) result.add(real + sep)
  return [...result]
}

/**
 * 已移动包的先前真实目录，每一个都映射到当前的那个。Node 会保留它解析所经过的每个链接的
 * 真实路径且从不刷新它，因此一次经过某个现已指向他处的链接的查找，仍会选中 Node 最初所见
 * 目标之下的一个文件；而 {@link MovedDirectories.relocate} 会改为选中当前目标之下的同一文件。
 */
class MovedDirectories {
  /** 先前目录到当前目录，两者都带尾部分隔符。 */
  private readonly targets = new Map<string, string>()

  /**
   * 记录一个包从一个目录移动到另一个目录。先前目录的每一种拼写都通向当前的那个。一个被更早的
   * 移动带向先前目录的目录，现在也带向当前的那个，因为 Node 仍会选中最早目标之下的文件。
   * @param from 先前的真实目录。
   * @param to 当前的真实目录。
   */
  record(from: string, to: string): void {
    const previous = spellings(from)
    const current = to + sep
    for (const [key, value] of this.targets) {
      if (previous.includes(value)) this.targets.set(key, current)
    }
    for (const key of previous) this.targets.set(key, current)
  }

  /**
   * 遗忘那些再次成为当前的先前目录（以任意拼写），以及通向自身的记录。
   * @param current 已发布解析所映射的真实目录。
   */
  forget(current: readonly string[]): void {
    const active = new Set<string>()
    for (const dir of current) for (const spelling of spellings(dir)) active.add(spelling)
    for (const [key, value] of [...this.targets]) {
      if (active.has(key) || key === value) this.targets.delete(key)
    }
  }

  /**
   * 当一个文件位于某先前目录之下、且被该目录之外的一个导入者选中时，返回其在当前目录之下
   * 存在的同一文件。位于先前目录之内的导入者保留其自身包的文件。最内层的先前目录说了算。
   * @param filename 被选中的文件。
   * @param parent 导入者路径。
   * @returns 要加载的文件。
   */
  relocate(filename: string, parent: string | undefined): string {
    let from = ''
    for (const dir of this.targets.keys()) {
      if (filename.startsWith(dir) && dir.length > from.length) from = dir
    }
    if (from === '' || parent?.startsWith(from) === true) return filename
    const relocated = (this.targets.get(from) as string) + filename.slice(from.length)
    return existsSync(relocated) ? relocated : filename
  }
}

/** 指向不可变运行时解析的一个可变指针。 */
class ResolutionRouter {
  private current: CompiledResolution
  private linkedTargets: Map<string, string>
  private readonly moved = new MovedDirectories()

  constructor(resolution: RuntimeResolution, private readonly nodeModulePaths: (directory: string) => string[]) {
    this.current = compileResolution(resolution)
    this.linkedTargets = new Map(resolution.linkedRoots.map(root => [root.name, root.realPath]))
  }

  replace(successor: RuntimeResolution): void {
    const entries = new Map(successor.entries.map(entry => [entry.name, entry]))
    if (successor.profilesDir !== this.current.profilesDir
      || successor.profileDir !== this.current.profileDir) {
      throw new Error('profile resolution: a successor cannot change its profile scope')
    }
    const rejected: string[] = []
    const moves: [string, string][] = []
    for (const [name, current] of this.current.entries) {
      const next = entries.get(name)
      if (next === undefined && current.scope === 'profile') continue
      if (next !== undefined && current.scope === 'profile' && next.scope === 'profile') {
        // 比较的是真实目录：当目标改变时，一个链接仍保持自己的路径。
        if (current.realDir === canonicalPath(next.packageDir)) continue
        rejected.push(`profile resolution: replacing ${JSON.stringify(name)} requires a process restart`)
        continue
      }
      if (next === undefined
        || !sameResolution(current.packageDir, next.packageDir)
        || (current.scope === 'installation' && !sameResolution(current.declarer, next.declarer))
        || (current.scope === 'installation' && current.version !== next.version)
        || current.scope !== next.scope) {
        rejected.push(`profile resolution: replacing ${JSON.stringify(name)} requires a process restart`)
      }
    }
    const localPackageNames = new Set(successor.localPackageNames)
    for (const name of localPackageNames) {
      if (!this.current.localPackageNames.has(name) && this.current.entries.has(name)) {
        rejected.push(`profile resolution: overriding ${JSON.stringify(name)} locally requires a process restart`)
      }
    }
    // 指向他处、或被作为目录再次安装的链接名，会移动其包。链接与映射都已消失的名称仍被记录，
    // 因此重新以该名称出现的包会与它的上一个目标比较。
    const targets = new Map(this.linkedTargets)
    for (const [name, previous] of this.linkedTargets) {
      const root = successor.linkedRoots.find(candidate => candidate.name === name)
      const entry = entries.get(name)
      const target = root?.realPath ?? (entry?.scope === 'profile' ? canonicalPath(entry.packageDir) : undefined)
      if (target === undefined || sameResolution(previous, target)) continue
      moves.push([previous, target])
      targets.set(name, target)
    }
    if (rejected.length > 0) throw new ResolutionRestartRequired(rejected.join('; '))
    const next = compileResolution(successor)
    for (const { name, realPath } of successor.linkedRoots) targets.set(name, realPath)
    this.linkedTargets = targets
    for (const [from, to] of moves) this.moved.record(from, to)
    const current: string[] = []
    for (const entry of next.entries.values()) current.push(entry.realDir)
    for (const root of successor.linkedRoots) current.push(root.realPath)
    this.moved.forget(current)
    this.current = next
  }

  /**
   * 应加载的文件，而非 Node 自那以后经过一个已移动链接所选择的那个；参见 {@link MovedDirectories}。
   * @param filename 被选中的文件。
   * @param parent 导入者路径。
   * @returns 要加载的文件。
   */
  relocate(filename: string, parent: string | undefined): string {
    return this.moved.relocate(filename, parent)
  }

  /** 一个模块路径是否拥有一个拦截层：它位于 profiles 树、活动 profile，或某个链接根之中。 */
  hasInterceptionLayerForPath(path: string): boolean {
    return findInterceptionLayer(path, this.current) !== undefined
  }

  /** 一个导入者 URL 是否带作用域；结果会与该导入者的路由一起被记忆。 */
  hasInterceptionLayerForUrl(parentURL: string): boolean {
    return this.getOrCreateParentRoutesForUrl(parentURL) !== false
  }

  private createParentRoutes(parent: string, resolution: CompiledResolution): ParentRoutes | undefined {
    const layer = findInterceptionLayer(parent, resolution)
    return layer === undefined ? undefined : { parent, layer, requests: new Map() }
  }

  private getOrCreateParentRoutesForUrl(parentURL: string): ParentRoutes | false {
    const resolution = this.current
    let parentRoutes = resolution.esmRoutes.get(parentURL)
    if (parentRoutes !== undefined) return parentRoutes
    let parent: string | undefined
    try {
      parent = fileURLToPath(parentURL)
    } catch {
      // 只有文件 URL 才可能在 profile 树或链接根目录内部。
      parent = undefined
    }
    parentRoutes = parent === undefined ? false : this.createParentRoutes(parent, resolution) ?? false
    resolution.esmRoutes.set(parentURL, parentRoutes)
    return parentRoutes
  }

  private routeScoped(
    request: string,
    parentRoutes: ParentRoutes,
    resolution: CompiledResolution,
    flavor: 'esm' | 'cjs',
    cjs?: CommonJsLookup,
  ): ResolutionRouteState | undefined {
    const { parent, layer, requests } = parentRoutes
    const memo = layer.kind === 'profile' && (cjs === undefined || cjs.cacheable)
    const name = barePackageName(request)
    if (name === undefined) return undefined

    if (parentRoutes.selfReferenceName === undefined || !memo) {
      parentRoutes.selfReferenceName = selfReferenceName(parent)
    }
    if (parentRoutes.selfReferenceName === name || parentRoutes.selfReferenceName === null) {
      const state = { route: { kind: 'native' as const } }
      if (memo) requests.set(request, state)
      return state
    }

    if (layer.kind === 'linked') return this.routeLinked(request, name, parent, resolution, flavor, cjs)

    const target = resolution.entries.get(name)
    const candidates: string[] = []
    const localSearchPaths: string[] = []
    for (const searchPath of createRequire(parent).resolve.paths(name) as string[]) {
      if (!searchPath.startsWith(layer.localPrefix)) break
      localSearchPaths.push(searchPath)
      const candidate = localPackageCandidate(searchPath, name, flavor)
      if (candidate !== undefined) candidates.push(candidate)
    }
    if (candidates.length > 0) {
      if (cjs !== undefined) {
        try {
          const resolved = cjs.resolveNative(localSearchPaths)
          const selected = candidates.find(candidate => (
            localCandidateOwnsResolution(candidate, resolved, request, name)
          ))
          if (selected !== undefined) {
            const state = {
              route: { kind: 'native' as const, packageDir: selected },
              packageDir: selected,
              cjs: resolved,
            }
            if (memo) requests.set(request, state)
            return state
          }
        } catch (error) {
          if (!isUnselectedPackageMiss(error)) throw error
        }
      } else {
        const selected = candidates[0] as string
        const state = {
          route: { kind: 'native' as const, packageDir: selected },
          packageDir: selected,
        }
        requests.set(request, state)
        return state
      }
    }

    const route: ResolutionRoute = target !== undefined
      && (target.scope === 'installation' || layer.active)
      ? { kind: 'interception', entry: target, after: layer.after }
      : { kind: 'native-after-interception', parent: layer.nativeAfter }
    const state: ResolutionRouteState = { route }
    if (route.kind === 'interception' && memo) requests.set(request, state)
    return state
  }

  private routeLinked(
    request: string, name: string, parent: string, resolution: CompiledResolution,
    flavor: 'esm' | 'cjs', cjs: CommonJsLookup | undefined,
  ): ResolutionRouteState {
    const target = resolution.entries.get(name)
    if (target === undefined) return { route: { kind: 'native' } }
    const ancestors = this.nodeModulePaths(dirname(parent))
    const ancestorSet = new Set(ancestors)
    const searchPaths = flavor === 'esm' ? ancestors : createRequire(parent).resolve.paths(name) as string[]
    for (const searchPath of searchPaths) {
      const directory = dirname(searchPath)
      if (ancestorSet.has(searchPath) && readPeerNames(directory).has(name)) {
        const route: ResolutionRoute = { kind: 'interception', entry: target, after: join(dirname(directory), 'package.json') }
        if (cjs === undefined) return { route }
        try {
          const resolved = cjs.resolveEntry(target, route.after)
          if (localCandidateOwnsResolution(target.packageDir, resolved, request, name)) {
            return { route, packageDir: target.packageDir, cjs: resolved }
          }
        } catch (error) {
          if (!isUnselectedPackageMiss(error)) throw error
        }
        // 即使所提供的包中缺少遗留的 CommonJS 子路径，该位置仍被占用。
        continue
      }
      const candidate = localPackageCandidate(searchPath, name, flavor)
      if (candidate === undefined) continue
      if (cjs === undefined) return { route: { kind: 'native', packageDir: candidate }, packageDir: candidate }
      try {
        const resolved = cjs.resolveNative([searchPath])
        if (localCandidateOwnsResolution(candidate, resolved, request, name)) {
          return { route: { kind: 'native', packageDir: candidate }, packageDir: candidate, cjs: resolved }
        }
      } catch (error) {
        if (!isUnselectedPackageMiss(error)) throw error
      }
    }
    // 一次已穷尽的 CommonJS 查找不得在被占用的同级位置上重试物理副本。
    return cjs === undefined ? { route: { kind: 'native' } } : { route: { kind: 'native' }, cjs: cjs.resolveNative([]) }
  }

  private routeLocalPackage(
    request: string, parentRoutes: ParentRoutes, resolution: CompiledResolution,
  ): ResolutionRouteState | undefined {
    const name = barePackageName(request)
    const { layer } = parentRoutes
    if (name === undefined || layer.kind !== 'profile' || !layer.active || !resolution.localPackageNames.has(name)) return undefined
    const state = { route: { kind: 'native' as const } }
    parentRoutes.requests.set(request, state)
    return state
  }

  routeUrl(request: string, parentURL: string): ResolutionRouteState | undefined {
    const resolution = this.current
    const parentRoutes = this.getOrCreateParentRoutesForUrl(parentURL)
    if (parentRoutes === false) return undefined
    const cached = parentRoutes.requests.get(request)
    if (cached !== undefined) return cached
    const local = this.routeLocalPackage(request, parentRoutes, resolution)
    if (local !== undefined) return local
    return this.routeScoped(request, parentRoutes, resolution, 'esm')
  }

  routePath(
    request: string, parent: string, cjs: CommonJsLookup,
  ): ResolutionRouteState | undefined {
    const resolution = this.current
    let parentRoutes = resolution.cjsRoutes.get(parent)
    if (parentRoutes === false) return undefined
    const cached = cjs.cacheable ? parentRoutes?.requests.get(request) : undefined
    if (cached !== undefined) return cached
    if (parentRoutes === undefined) {
      parentRoutes = this.createParentRoutes(parent, resolution) ?? false
      resolution.cjsRoutes.set(parent, parentRoutes)
      if (parentRoutes === false) return undefined
    }
    return this.routeScoped(request, parentRoutes, resolution, 'cjs', cjs)
  }

  packageDir(specifier: string, parentURL: string): string | undefined {
    const name = barePackageName(specifier)
    if (name === undefined) return undefined
    const state = this.routeUrl(name, parentURL)
    if (state?.route.kind === 'interception') return state.route.entry.packageDir
    if (state?.packageDir !== undefined) return state.packageDir
    let parent: string
    try {
      parent = state?.route.kind === 'native-after-interception' ? state.route.parent : fileURLToPath(parentURL)
    } catch {
      return undefined
    }
    const found = nativePackageDir(parent, name)
    if (state !== undefined && found !== undefined) state.packageDir = found
    return found
  }
}

function internalModules(): InternalModules {
  const require = createRequire(import.meta.url)
  const addon = require('node-addon-require-builtin') as { requireBuiltin(moduleId: string): unknown }
  const esmModule = addon.requireBuiltin('internal/modules/esm/loader') as {
    getOrInitializeCascadedLoader(): ModuleLoaderV1 | ModuleLoaderV2
  }
  const cjsModule = addon.requireBuiltin('internal/modules/cjs/loader') as { Module: CommonJsModule }
  const cjsHelpers = addon.requireBuiltin('internal/modules/helpers') as {
    getCjsConditions(): ReadonlySet<string>
  }
  const esmUtils = addon.requireBuiltin('internal/modules/esm/utils') as {
    getDefaultConditions(): readonly string[]
  }
  const esmResolve = addon.requireBuiltin('internal/modules/esm/resolve') as {
    defaultResolve(
      specifier: string,
      context: { parentURL?: string; conditions?: readonly string[] },
    ): ResolveResult
  }
  const esm = esmModule.getOrInitializeCascadedLoader()
  const modern = 'getOrCreateModuleJob' in esm
  /* v8 ignore start -- 受支持的 Node 22/24/26 矩阵会校验每个可用的 Internal 接口 */
  if (typeof esm.resolveSync !== 'function'
    || typeof Reflect.get(esm, modern ? 'getOrCreateModuleJob' : 'getModuleJobForImport') !== 'function'
    || (!modern && typeof Reflect.get(esm, 'resolve') !== 'function')
    || typeof cjsModule.Module._resolveFilename !== 'function'
    || typeof cjsHelpers.getCjsConditions !== 'function'
    || typeof esmUtils.getDefaultConditions !== 'function'
    || typeof esmResolve.defaultResolve !== 'function') {
    throw new Error('profile resolution: unsupported Node module loader')
  }
  /* v8 ignore stop */
  return {
    esm,
    esmDefaultResolve: (specifier, context) => esmResolve.defaultResolve(specifier, context),
    esmConditions: esmUtils.getDefaultConditions(),
    cjs: cjsModule.Module,
    cjsConditions: cjsHelpers.getCjsConditions(),
    modern,
  }
}

/**
 * 替换解析器错误消息及其在堆栈中的相同文本。
 * Node 的模块钩子线程会序列化错误，并将堆栈访问器作为只读可配置的数据属性返回，
 * 因此被拒绝的堆栈赋值会重新定义该属性的值。
 * @param error - 要就地更新的解析器错误。
 * @param message - 替换后的消息。
 */
function replaceErrorMessage(error: Error, message: string): void {
  const { message: originalMessage, stack } = error
  error.message = message
  /* v8 ignore next -- Node 的解析器错误始终带有堆栈 */
  if (stack === undefined) return
  const replaced = stack.replace(originalMessage, message)
  if (!Reflect.set(error, 'stack', replaced)) Object.defineProperty(error, 'stack', { value: replaced })
}

function throwWithImporter(error: unknown, routedParent: string, parent: string): never {
  const code = (error as NodeJS.ErrnoException).code
  if (error instanceof Error && (code === 'ERR_MODULE_NOT_FOUND' || code === 'ERR_PACKAGE_PATH_NOT_EXPORTED')) {
    const routedPath = fileURLToPath(routedParent)
    const parentPath = fileURLToPath(parent)
    replaceErrorMessage(error, error.message.replaceAll(routedParent, parent).replaceAll(routedPath, parentPath))
  }
  throw error
}

function throwWithoutCjsAnchor(error: unknown, anchor: string): never {
  const resolved = error as NodeJS.ErrnoException & { requireStack?: string[] }
  const requireStack = resolved.requireStack
  if (error instanceof Error
    && resolved.code === 'MODULE_NOT_FOUND'
    && requireStack?.[0] !== undefined
    && sameResolution(requireStack[0], anchor)) {
    const originalMessage = error.message
    const originalBlock = `\nRequire stack:\n${requireStack.map(path => `- ${path}`).join('\n')}`
    const remaining = requireStack.slice(1)
    /* v8 ignore next -- 路由调用始终保留原始导入模块 */
    const replacement = remaining.length === 0
      ? ''
      : `\nRequire stack:\n${remaining.map(path => `- ${path}`).join('\n')}`
    error.message = originalMessage.replace(originalBlock, replacement)
    resolved.requireStack = remaining
    const stack = error.stack
    /* v8 ignore next -- Node 的解析器错误始终带有堆栈 */
    if (stack !== undefined) error.stack = stack.replace(originalMessage, error.message)
  }
  throw error
}

/**
 * 将一份运行时解析安装为 Node 默认 ESM 与 CommonJS 解析器上的拦截层。
 * @param resolution - 完整的包表与 profile 作用域。
 * @returns 一个发布后继或恢复原生方法的拦截层。
 */
export function installRuntimeInterception(
  resolution: RuntimeResolution,
): RuntimeInterception {
  const { esm, esmDefaultResolve, esmConditions, cjs, cjsConditions, modern } = internalModules()
  const router = new ResolutionRouter(resolution, directory => cjs._nodeModulePaths(directory))
  let delegatedEsm: { parent: string | undefined; request: string } | undefined

  const adaptEsm = (native: EsmResolve): EsmResolve => {
    const adapted: EsmResolve = (request, parent, attributes) => {
      const delegated = delegatedEsm
      /* v8 ignore next -- 重入需要一个独立的同步 Node 钩子；受支持的启动不安装任何钩子 */
      if (delegated !== undefined && delegated.parent === parent && delegated.request === request) {
        return native(request, parent, attributes)
      }
      if (parent === undefined || !router.hasInterceptionLayerForUrl(parent)) return native(request, parent, attributes)
      const state = router.routeUrl(request, parent)
      if (state === undefined) {
        const target = request[0] === '#'
          ? packageImportsTarget(fileURLToPath(parent), request, esmConditions)
          : undefined
        if (target === undefined) return native(request, parent, attributes)
        const restoreImporter = (error: unknown): never => throwWithImporter(error, target.parentURL, parent)
        let expected: ResolveResult | Promise<ResolveResult>
        try {
          expected = adapted(target.specifier, target.parentURL, attributes)
          /* v8 ignore next -- Node 24+ 同步解析；Node 22 矩阵覆盖了其 Promise 结果 */
          if (expected instanceof Promise) expected = expected.catch(restoreImporter)
        } catch (error) {
          return restoreImporter(error)
        }
        return expected
      }
      const cacheable = attributes === EMPTY_ATTRIBUTES || Object.keys(attributes).length === 0
      if (cacheable && state.esm !== undefined) return state.esm
      const route = state.route
      if (route.kind === 'native') {
        const result = native(request, parent, attributes)
        if (cacheable && !(result instanceof Promise)) state.esm = result
        return result
      }
      const routedParent = pathToFileURL(route.kind === 'interception' ? route.entry.declarer : route.parent).href
      const previous = delegatedEsm
      delegatedEsm = { parent: routedParent, request }
      const restoreImporter = (error: unknown): never => throwWithImporter(error, routedParent, parent)
      try {
        let result: ResolveResult | Promise<ResolveResult>
        try {
          result = native(request, routedParent, attributes)
        } catch (error) {
          return restoreImporter(error)
        }
        /* v8 ignore next -- Node 24+ 同步解析；Node 22 矩阵覆盖了其 Promise 结果 */
        if (result instanceof Promise) return result.catch(restoreImporter)
        if (cacheable) state.esm = result
        return result
      } finally {
        delegatedEsm = previous
      }
    }
    // Node 在真实路径上的最后一步（无论是路由请求还是原生请求）可能会跟随它先前解析出的一个链接。
    const relocate = (result: ResolveResult, parent: string | undefined): ResolveResult => {
      if (!result.url.startsWith('file:')) return result
      const url = new URL(result.url)
      const filename = fileURLToPath(url)
      const relocated = router.relocate(filename, parent?.startsWith('file:') === true ? fileURLToPath(parent) : undefined)
      if (relocated === filename) return result
      url.pathname = pathToFileURL(relocated).pathname
      return { ...result, url: url.href }
    }
    return (request, parent, attributes) => {
      const result = adapted(request, parent, attributes)
      /* v8 ignore next -- Node 24+ 同步解析；Node 22 矩阵覆盖了其 Promise 结果 */
      return result instanceof Promise ? result.then(resolved => relocate(resolved, parent)) : relocate(result, parent)
    }
  }

  let restoreEsm: () => void
  /* v8 ignore else -- CI 覆盖率运行 Node 24 v2；Node 22 矩阵覆盖了 v1 适配器 */
  if (modern) {
    const loader = esm as ModuleLoaderV2
    const original = Reflect.get(loader, 'resolveSync')
    const resolveRequest = adaptEsm((request, parent, attributes) => original.call(
      loader, parent as string, { specifier: request, attributes },
    ))
    // Node 24.12+ 会在 request 之后添加 skipSyncHooks。它的存在标志着
    // 外层调用已选定路由的钩子委派。
    const wrapped = (parent: string, request: { specifier: string; attributes?: ImportAttributes }, ...rest: unknown[]): ResolveResult => (
      rest.length
        ? Reflect.apply(original, loader, [parent, request, ...rest]) as ResolveResult
        : resolveRequest(request.specifier, parent, request.attributes ?? EMPTY_ATTRIBUTES) as ResolveResult
    )
    loader.resolveSync = wrapped
    restoreEsm = () => {
      /* v8 ignore else -- 拦截层以与安装相反的顺序释放 */
      if (loader.resolveSync === wrapped) loader.resolveSync = original
    }
  } else {
    const loader = esm as ModuleLoaderV1
    const original = Reflect.get(loader, 'resolve')
    const originalSync = Reflect.get(loader, 'resolveSync')
    const resolveRequest = adaptEsm((request, parent, attributes) => original.call(loader, request, parent as string, attributes))
    const resolveRequestSync = adaptEsm((request, parent, attributes) => originalSync.call(loader, request, parent as string, attributes))
    const wrapped = (request: string, parent: string, attributes: ImportAttributes = EMPTY_ATTRIBUTES): Promise<ResolveResult> => (
      resolveRequest(request, parent, attributes) as Promise<ResolveResult>
    )
    const wrappedSync = (request: string, parent: string, attributes: ImportAttributes = EMPTY_ATTRIBUTES): ResolveResult => (
      resolveRequestSync(request, parent, attributes) as ResolveResult
    )
    loader.resolve = wrapped
    loader.resolveSync = wrappedSync
    restoreEsm = () => {
      if (loader.resolve === wrapped) loader.resolve = original
      if (loader.resolveSync === wrappedSync) loader.resolveSync = originalSync
    }
  }

  const originalFilename = Reflect.get(cjs, '_resolveFilename')
  let delegatedCjs = 0
  const resolveRoutedCjs = (
    request: string, routed: Exclude<ResolutionRoute, { kind: 'native' }>,
    parent: CommonJsParent, main: boolean, options?: CommonJsOptions,
  ): string => {
    const anchor = routed.kind === 'interception' ? routed.entry.declarer : routed.parent
    const synthetic = new cjs(anchor)
    // 延迟的父级赋值保留了 Node 的 require 堆栈，而不会将这个路由锚点发布到 parent.children 中。
    synthetic.parent = parent
    synthetic.filename = anchor
    synthetic.paths = routed.kind === 'interception'
      ? packageSearchPaths(routed.entry, request, cjs)
      : cjs._nodeModulePaths(dirname(anchor))
    try {
      return originalFilename.call(cjs, request, synthetic, main, options)
    } catch (error) {
      return throwWithoutCjsAnchor(error, anchor)
    }
  }
  const resolveNativeCjs = (
    request: string, searchPaths: readonly string[], parent: CommonJsParent,
    parentFilename: string, main: boolean, conditions: ReadonlySet<string> | undefined,
  ): string => {
    const synthetic = new cjs(parentFilename)
    if (parent.parent !== undefined) synthetic.parent = parent.parent
    synthetic.filename = parentFilename
    synthetic.paths = [...searchPaths]
    const options = conditions === undefined ? undefined : { conditions }
    return originalFilename.call(cjs, request, synthetic, main, options)
  }
  const resolvePackageImportCjs = (
    target: { specifier: string; parentURL: string }, conditions: Iterable<string>,
  ): string => {
    const state = router.routeUrl(target.specifier, target.parentURL)
    const resolveFrom = (parentURL: string): string => fileURLToPath(esmDefaultResolve(
      target.specifier, { parentURL, conditions: [...conditions] },
    ).url)
    /* v8 ignore next -- 目标清单已在已建立的 profile 作用域内找到 */
    if (state === undefined) return resolveFrom(target.parentURL)
    if (state.route.kind === 'native') return resolveFrom(target.parentURL)
    const route = state.route
    if (route.kind === 'native-after-interception') return resolveFrom(pathToFileURL(route.parent).href)
    return resolveFrom(pathToFileURL(route.entry.declarer).href)
  }
  const wrappedFilename: CommonJsModule['_resolveFilename'] = (request, parent, main, options) => {
    if (delegatedCjs || !parent?.filename || options?.paths !== undefined) {
      return originalFilename.call(cjs, request, parent, main, options)
    }
    const parentFilename = parent.filename
    const cacheable = options?.conditions === undefined
    const routedOptions = options?.conditions === undefined ? undefined : { conditions: options.conditions }
    const state = router.routePath(request, parentFilename, {
      cacheable,
      resolveNative: searchPaths => resolveNativeCjs(request, searchPaths, parent, parentFilename, main, options?.conditions),
      resolveEntry: (entry, after) => {
        delegatedCjs++
        try {
          return resolveRoutedCjs(request, { kind: 'interception', entry, after }, parent, main, routedOptions)
        } finally {
          delegatedCjs--
        }
      },
    })
    if (state === undefined) {
      const scoped = router.hasInterceptionLayerForPath(parentFilename)
      const conditions = options?.conditions ?? cjsConditions
      const target = request[0] === '#' && scoped
        ? packageImportsTarget(parentFilename, request, conditions)
        : undefined
      if (target === undefined) return originalFilename.call(cjs, request, parent, main, options)
      return resolvePackageImportCjs(target, conditions)
    }
    if (state.cjs !== undefined) return state.cjs
    const route = state.route
    if (route.kind === 'native') {
      const result = originalFilename.call(cjs, request, parent, main, options)
      if (cacheable) state.cjs = result
      return result
    }
    delegatedCjs++
    try {
      let expected: string
      try {
        expected = resolveRoutedCjs(request, route, parent, main, routedOptions)
      } catch (error) {
        if (route.kind !== 'interception' || !isUnselectedPackageMiss(error)) throw error
        expected = resolveRoutedCjs(
          request, { kind: 'native-after-interception', parent: route.after }, parent, main, routedOptions,
        )
      }
      if (cacheable) state.cjs = expected
      return expected
    } finally {
      delegatedCjs--
    }
  }
  const relocatedFilename: CommonJsModule['_resolveFilename'] = (request, parent, main, options) => {
    const filename = wrappedFilename(request, parent, main, options)
    return isAbsolute(filename) ? router.relocate(filename, parent?.filename ?? undefined) : filename
  }
  cjs._resolveFilename = relocatedFilename

  return {
    packageDir(specifier, parentURL) {
      return router.packageDir(specifier, parentURL)
    },
    replace(next) { router.replace(next) },
    dispose() {
      /* v8 ignore else -- 拦截层以与安装相反的顺序释放 */
      if (cjs._resolveFilename === relocatedFilename) cjs._resolveFilename = originalFilename
      restoreEsm()
    },
  }
}

/**
 * 为 Harness 拥有的 Worker 发布一份运行时解析。
 * @param resolution - 完整的包表与 profile 作用域。
 * @returns 一个恢复先前线程环境数据的释放器。
 */
export function registerWorkerResolution(
  resolution: RuntimeResolution,
): () => void {
  const previous = getEnvironmentData(WORKER_RESOLUTION_KEY)
  setEnvironmentData(WORKER_RESOLUTION_KEY, { resolution })
  return () => { setEnvironmentData(WORKER_RESOLUTION_KEY, previous) }
}
