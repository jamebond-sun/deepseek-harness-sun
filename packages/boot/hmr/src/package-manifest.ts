/** 为清单发生变更的包目录使 Node 缓存的包配置失效。 */
import { isUtf8 } from 'node:buffer'
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire, isBuiltin } from 'node:module'
import { basename, dirname, join, sep, toNamespacedPath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Node 解析器消费的包字段；exports 和 imports 保存 JSON 值。 */
interface PackageConfig {
  name?: string
  main?: string
  type: string
  exports?: unknown
  imports?: unknown
}

/** 原生 modules 绑定返回的序列化字段：name、main、type、imports、exports、清单路径。 */
type PackageTuple = [string | undefined, string | undefined, string, string | undefined, string | undefined, string]

/**
 * `internalBinding('modules')` 中通过 Node 原生缓存读取包配置的方法。Node 的
 * 包读取器、CommonJS 加载器以及 ESM 解析器和格式检测在每次调用时都会查找它们。
 */
interface PackageBinding {
  readPackageJSON(this: void, path: string, isEsm?: boolean, base?: string, specifier?: string): PackageTuple | undefined
  getPackageScopeConfig(this: void, url: string): PackageTuple | string
  getPackageType(this: void, url: string): string | undefined
}

/**
 * `internal/modules/package_json_reader` 的导出，它维护自己的最近清单缓存；CommonJS 加载器
 * 通过模块对象调用它，因此它是绑定中最近清单查找的唯一调用方。
 */
interface PackageReader {
  getNearestParentPackageJSON(this: void, path: string): { data: PackageConfig; exists: boolean; path: string } | undefined
}

/** Node 的 ESM 解析缓存：一个从父 URL 到由其解析出的序列化请求键的 Map。 */
interface ResolveCacheClass {
  prototype: { get: (this: Map<string, unknown>, key: string, parent: string) => unknown }
}

interface CommonJsModule {
  _pathCache: Record<string, string>
  _resolveFilename(request: string, parent: NodeJS.Module | null | undefined, isMain?: boolean): string
  _load(request: string, parent: NodeJS.Module | null | undefined, isMain?: boolean, ...options: unknown[]): unknown
}

interface NativeAccess {
  binding: PackageBinding
  reader: PackageReader
  ResolveCache: ResolveCacheClass
  cjs: CommonJsModule
  esmLoader: { resolveSync(...args: unknown[]): unknown }
}

/** 快照自身的方法；每个释放函数仅在其替换体仍被安装时才恢复原方法。 */
function createReplaceHelper<T extends { [K in keyof T]: (...args: never[]) => unknown }>(target: T) {
  const rawImpl = { ...target }
  return {
    rawImpl,
    replaceMethod<K extends keyof T>(key: K, replacement: T[K]): () => void {
      target[key] = replacement
      return () => { if (target[key] === replacement) target[key] = rawImpl[key] }
    },
  }
}

/** 与被 vendored 的 Loader 中 `requireInternal` 相同的查找：先尝试 `--expose-internals`，再退回到内建 addon。 */
function requireInternal(id: string): unknown {
  const require = createRequire(import.meta.url)
  if (process.execArgv.includes('--expose-internals')) {
    try {
      return require(id)
    } catch (_error) {
      // 某些内部模块（如 internal/bootstrap/realm）在 --expose-internals 下仍保持私有。
    }
  }
  try {
    return (require('node-addon-require-builtin') as { requireBuiltin(id: string): unknown }).requireBuiltin(id)
  } catch (_error) {
    // 没有该 addon 时，由调用方报告缺失的接口。
  }
}

function loadNodeInternals(): NativeAccess {
  const realm = requireInternal('internal/bootstrap/realm') as { internalBinding(id: 'modules'): PackageBinding }
  const esm = requireInternal('internal/modules/esm/loader') as {
    getOrInitializeCascadedLoader(): NativeAccess['esmLoader']
  }
  return {
    binding: realm.internalBinding('modules'),
    reader: requireInternal('internal/modules/package_json_reader') as PackageReader,
    ResolveCache: (requireInternal('internal/modules/esm/module_map') as { ResolveCache: ResolveCacheClass }).ResolveCache,
    cjs: (requireInternal('internal/modules/cjs/loader') as { Module: CommonJsModule }).Module,
    esmLoader: esm.getOrInitializeCascadedLoader(),
  }
}

/**
 * 通过原型观察一次查找来读取 ESM 加载器的解析缓存。
 * 原型方法在本函数返回之前会被恢复。
 */
function captureEsmResolveCache(native: NativeAccess, parentURL: string): Map<string, unknown> | undefined {
  const prototype = native.ResolveCache.prototype
  const original = prototype.get
  const seen = new Set<Map<string, unknown>>()
  prototype.get = function (this: Map<string, unknown>, key: string, parent: string): unknown {
    seen.add(this)
    return Reflect.apply(original, this, [key, parent])
  }
  try {
    const loader = native.esmLoader
    /* v8 ignore else -- CI coverage runs the Node 24 loader; the Node 22 matrix exercises the v1 signature */
    if ('getOrCreateModuleJob' in loader) loader.resolveSync(parentURL, { specifier: 'node:path', attributes: {} })
    else loader.resolveSync('node:path', parentURL, {})
  } finally {
    prototype.get = original
  }
  return [...seen][0]
}

interface Configuration {
  data: PackageConfig
  serialized: PackageTuple
}

interface ImportContext {
  base: string
  specifier: string | undefined
}

/** 清单从磁盘读取而非从 Node 原生缓存读取的包目录。 */
export class PackageManifests {
  private readonly directories = new Set<string>()
  private readonly configurations = new Map<string, Configuration | undefined>()
  /** 每次查找所抵达目录的真实目录；通过链接消费的调用方用其链接路径命名一个包。 */
  private readonly realDirectories = new Map<string, string>()
  private native: NativeAccess | undefined
  private rawBinding!: PackageBinding
  private rawReader!: PackageReader
  private rawCommonJs!: Pick<CommonJsModule, '_load'>
  private readonly restorers: Array<() => void> = []

  /**
   * 让某个包目录的缓存配置过期。已加载的模块保持已求值状态；后续的解析与格式检查
   * 会读取磁盘上的清单。
   * @param manifest - 发生变更的 `package.json` 的绝对路径。
   */
  invalidate(manifest: string): void {
    const native = this.installPackageHooks()
    const directory = dirname(manifest)
    this.directories.add(directory)
    this.configurations.clear()
    this.realDirectories.clear()
    // 一个包的入口可能解析到其目录之外；缓存键不会记录它们所查阅过的清单。
    for (const key of Object.keys(native.cjs._pathCache)) Reflect.deleteProperty(native.cjs._pathCache, key)
    const directoryURL = pathToFileURL(directory).href + '/'
    const cache = captureEsmResolveCache(native, directoryURL)
    /* v8 ignore else -- asynchronous loader hooks own a separate cache; loader-thread invalidation is deferred */
    if (cache !== undefined) Map.prototype.clear.call(cache)
  }

  /** 恢复本实例安装过的每一个被替换的 Node 方法。 */
  dispose(): void {
    for (const restore of this.restorers.splice(0).reverse()) restore()
    this.native = undefined
    this.realDirectories.clear()
  }

  private isPathWithinDirectory(path: string, directory: string): boolean {
    return path === directory || path.startsWith(join(directory, sep))
  }

  private isPathInInvalidatedDirectory(path: string): boolean {
    const parent = dirname(path)
    let real = this.realDirectories.get(parent)
    if (real === undefined) {
      try { real = realpathSync(parent) } catch (_error) {
        // 缺失的目录保留其配置拼写；它没有任何可以通过链接读取的清单。
        real = parent
      }
      this.realDirectories.set(parent, real)
    }
    const target = join(real, basename(path))
    for (const directory of this.directories) if (this.isPathWithinDirectory(target, directory)) return true
    return false
  }

  private isUrlInInvalidatedDirectory(url: string): boolean {
    try { return this.isPathInInvalidatedDirectory(fileURLToPath(url)) } catch (_error) {
      // 只有 file URL 才能命名一个已失效的包目录。
      return false
    }
  }

  private installPackageHooks(): NativeAccess {
    if (this.native !== undefined) return this.native
    const native = loadNodeInternals()
    this.native = native
    const binding = createReplaceHelper(native.binding)
    const reader = createReplaceHelper(native.reader)
    const commonJs = createReplaceHelper<Pick<CommonJsModule, '_load'>>(native.cjs)
    this.rawBinding = binding.rawImpl
    this.rawReader = reader.rawImpl
    this.rawCommonJs = commonJs.rawImpl
    this.restorers.push(
      binding.replaceMethod('readPackageJSON', this.hookBindingReadPackageJSON.bind(this)),
      binding.replaceMethod('getPackageScopeConfig', this.hookBindingGetPackageScopeConfig.bind(this)),
      binding.replaceMethod('getPackageType', this.hookBindingGetPackageType.bind(this)),
      reader.replaceMethod('getNearestParentPackageJSON', this.hookReaderGetNearestParentPackageJSON.bind(this)),
      commonJs.replaceMethod('_load', this.hookCommonJsLoad.bind(this)),
    )
    return native
  }

  private hookCommonJsLoad(...[request, parent, isMain, ...options]: Parameters<CommonJsModule['_load']>) {
    const native = this.installPackageHooks()
    // 绝对文件名会绕过 Node 私有的请求缓存，同时不会驱逐已求值的模块。
    const filename = request.startsWith('node:') || isBuiltin(request)
      ? request : native.cjs._resolveFilename(request, parent, isMain)
    return this.rawCommonJs._load.call(native.cjs, filename, parent, isMain, ...options)
  }

  private hookBindingReadPackageJSON(path: string, isEsm?: boolean, base?: string, specifier?: string) {
    return this.isPathInInvalidatedDirectory(path)
      ? this.readCachedPackageConfig(
        path,
        isEsm && base !== undefined ? { base, specifier } : undefined,
      )?.serialized
      : this.rawBinding.readPackageJSON(path, isEsm, base, specifier)
  }

  private hookBindingGetPackageScopeConfig(url: string) {
    if (!this.isUrlInInvalidatedDirectory(url)) return this.rawBinding.getPackageScopeConfig(url)
    const found = this.findNearestPackageConfig(fileURLToPath(url), true)
    if (typeof found === 'string') return this.rawBinding.getPackageScopeConfig(pathToFileURL(found).href)
    return found.configuration?.serialized ?? found.path
  }

  private hookBindingGetPackageType(url: string) {
    if (!this.isUrlInInvalidatedDirectory(url)) return this.rawBinding.getPackageType(url)
    const found = this.findNearestPackageConfig(fileURLToPath(url), true)
    return typeof found === 'string'
      ? this.rawBinding.getPackageType(pathToFileURL(found).href)
      : found.configuration?.data.type
  }

  private hookReaderGetNearestParentPackageJSON(path: string) {
    if (!this.isPathInInvalidatedDirectory(path)) return this.rawReader.getNearestParentPackageJSON(path)
    const found = this.findNearestPackageConfig(path, false)
    if (typeof found === 'string') return this.rawReader.getNearestParentPackageJSON(found)
    // 在没有清单处停止的查找，保留正在运行的 Node 版本自身给出的“缺失”结果。
    if (found.configuration === undefined) return this.rawReader.getNearestParentPackageJSON(path)
    return { data: found.configuration.data, exists: true, path: found.path }
  }

  private readCachedPackageConfig(path: string, context?: ImportContext): Configuration | undefined {
    if (!this.configurations.has(path)) this.configurations.set(path, this.readPackageConfigFromDisk(path, context))
    return this.configurations.get(path)
  }

  /** 字符串命名失效目录之外的第一个清单；由 Node 代为回答。 */
  private findNearestPackageConfig(path: string, includeRoot: boolean): { path: string; configuration?: Configuration } | string {
    let directory = dirname(path)
    while (true) {
      const manifest = join(directory, 'package.json')
      const parent = dirname(directory)
      if (basename(directory) === 'node_modules' || (!includeRoot && parent === directory)) return { path: manifest }
      if (!this.isPathInInvalidatedDirectory(manifest)) return manifest
      const configuration = this.readCachedPackageConfig(manifest)
      if (configuration !== undefined) return { path: toNamespacedPath(manifest), configuration }
      /* v8 ignore next -- root-scope queries run in an isolated child to contain non-termination */
      if (parent === directory) return { path: manifest }
      directory = parent
    }
  }

  /** @param context - 仅用于报告无效包配置的可选 ESM 导入细节。 */
  private readPackageConfigFromDisk(path: string, context?: ImportContext): Configuration | undefined {
    let bytes: Buffer
    try { bytes = readFileSync(path) } catch (_error) {
      // Node 将缺失的清单报告为“不存在”的配置。
      return undefined
    }
    const throwInvalidPackageConfig = (): never => {
      // 原生读取器抛出一个仅携带此错误码的普通 Error。
      const base = context?.base
      const importing = base === undefined ? ''
        : ` while importing "${context?.specifier}" from ${base.startsWith('file:') ? fileURLToPath(base) : base}`
      throw Object.assign(new Error(`Invalid package config ${toNamespacedPath(path)}${importing}.`), { code: 'ERR_INVALID_PACKAGE_CONFIG' })
    }
    if (!isUtf8(bytes)) return throwInvalidPackageConfig()
    const source = bytes.toString('utf8')
    let parsed: unknown
    try { parsed = JSON.parse(source.charCodeAt(0) === 0xfeff ? source.slice(1) : source) } catch (_error) {
      return throwInvalidPackageConfig()
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return throwInvalidPackageConfig()
    const fields = parsed as Record<string, unknown>
    if (fields.name !== undefined && typeof fields.name !== 'string') return throwInvalidPackageConfig()
    if (fields.type !== undefined && typeof fields.type !== 'string') return throwInvalidPackageConfig()
    for (const key of ['name', 'type', 'exports', 'imports']) {
      const value = fields[key]
      if (typeof value === 'string' && !value.isWellFormed()) return throwInvalidPackageConfig()
    }
    const normalizePackageJsonField = (value: unknown): unknown =>
      value !== null && (typeof value === 'string' || typeof value === 'object') ? value : undefined
    const data: PackageConfig = {
      ...typeof fields.name === 'string' ? { name: fields.name } : {},
      ...typeof fields.main === 'string' && fields.main.isWellFormed() ? { main: fields.main } : {},
      type: fields.type === 'module' || fields.type === 'commonjs' ? fields.type : 'none',
      exports: normalizePackageJsonField(fields.exports),
      imports: normalizePackageJsonField(fields.imports),
    }
    const serializePackageJsonField = (value: unknown): string | undefined =>
      value === undefined ? undefined : typeof value === 'string' ? value : JSON.stringify(value)
    return {
      data,
      serialized: [
        data.name,
        data.main,
        data.type,
        serializePackageJsonField(data.imports),
        serializePackageJsonField(data.exports),
        toNamespacedPath(path),
      ],
    }
  }
}
