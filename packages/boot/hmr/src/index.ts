/** 序列化后的模块与 profile 配置热重载。 */
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { watchConfig as watchExactConfig } from './watch-config.ts'
import { Context, FiberState, Inject, Service, type Fiber, type Plugin } from '@deepseek-ai/cordis'
import type { Entry, ModuleLoader, ModuleJob, ResolveResult } from '@deepseek-ai/cordis-plugin-loader'
import type { Include } from '@deepseek-ai/cordis-plugin-include'
import { FSWatcher, watch, type ChokidarOptions } from 'chokidar'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import {
  readProfileManifest, readProfilePatches, recomposeProfile, PROFILE_PATCH_FILENAME, type RuntimeResolution,
} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-cmdline'
import { handleError } from './error.ts'
import { PackageManifests } from './package-manifest.ts'
import { ModuleFiles } from './module-files.ts'
import type {} from '@deepseek-ai/cordis-plugin-timer'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import picomatch from 'picomatch'
import z from '@deepseek-ai/schemastery'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 序列化后的插件代码与配置热重载。 */
    hmr: Hmr
  }

  interface Events {
    /** 被监听的文件既没有模块处理器也没有配置处理器。
     * @mode emit
     * @param url 规范化的文件 URL。
     */
    'hmr/change'(url: string): void
    /** 模块替换已完成加载。
     * @mode emit
     * @param reloads 被替换的插件及其模块位置。
     */
    'hmr/reload'(reloads: Map<Plugin, Reload>): void
  }
}

function canonicalPath(filename: string): string {
  // Node 的 ESM 解析器使用 JS 版的 realpath 实现；原生 realpath 对 Windows 短名称
  // 的展开方式不同，会错过它自己的缓存键。
  try { return realpathSync(filename) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = dirname(filename)
    if (parent === filename) throw error
    return resolve(canonicalPath(parent), basename(filename))
  }
}

/** 模块根目录与监听器计时，附带 Chokidar 部署选项。 */
export interface HmrConfig extends ChokidarOptions {
  /** 相对于所属上下文 base URL 解析出的目录。 */
  base?: string
  /** 模块监听根目录；空列表则仅保留显式的配置监听。 */
  root: string[]
  /** 合并模块变更的毫秒数。 */
  debounce: number
  /** 被排除在模块监听之外的 glob 模式。 */
  ignored: string[]
}

/**
 * 从 ModuleJob 递归收集所有模块依赖。
 * 跳过 node: 内建模块与 node_modules，除非设置了 `includeNodeModules`，以便聚焦于用户代码。
 */
async function loadDependencies(job: ModuleJob, ignored = new Set<string>(), includeNodeModules = false) {
  const dependencies = new Set<string>()
  async function traverse(job: ModuleJob) {
    if (ignored.has(job.url) || dependencies.has(job.url)) return
    if (job.url.startsWith('node:') || (!includeNodeModules && job.url.includes('/node_modules/'))) return
    dependencies.add(job.url)
    const children = await linkedJobs(job)
    await Promise.all(children.map(traverse))
  }
  await traverse(job)
  return dependencies
}

/** 替换期间保留的模块位置与运行时。 */
export interface Reload {
  filename: string
  /** 参与本次运行时替换的所有入口模块的原始命名空间与 URL。 */
  modules: ReloadModules
  runtime?: Plugin.Runtime | undefined
}

/** 带有不同命名空间的入口名称；仅当某个名称没有已加载的命名空间时迭代才回退到 undefined。 */
class EntryNamespaces {
  private readonly names = new Map<string, Set<unknown>>()

  constructor(private internal: ModuleLoader, private moduleUrls: ReadonlyMap<unknown, string>) {}

  static getModuleUrls(internal: ModuleLoader): Map<unknown, string> {
    const moduleUrls = new Map<unknown, string>()
    for (const url of internal.loadCache.keys()) {
      const job = internal.loadCache.get(url)
      if (!job?.module) continue
      try {
        moduleUrls.set(job.module.getNamespace(), url)
      } catch (_error) {
        // Node 也会缓存尚未拿到命名空间的未完成 job。
      }
    }
    return moduleUrls
  }

  add(name: string, moduleNamespace: unknown): this {
    const namespaces = this.names.get(name) ?? new Set<unknown>()
    namespaces.add(moduleNamespace)
    this.names.set(name, namespaces)
    return this
  }

  *[Symbol.iterator](): Generator<[name: string, moduleNamespace: unknown]> {
    for (const [name, namespaces] of this.names) {
      for (const moduleNamespace of namespaces) {
        if (moduleNamespace === undefined && namespaces.size > 1) continue
        yield [name, moduleNamespace]
      }
    }
  }

  async resolve(name: string, baseUrl: string, moduleNamespace: unknown): Promise<Pick<ResolveResult, 'url'>> {
    if (moduleNamespace === undefined || name.startsWith('cordis:')) {
      switch (this.internal.version) {
        case 'v1': return await this.internal.resolve(name, baseUrl, {})
        case 'v2': return this.internal.resolveSync(baseUrl, { specifier: name, attributes: {} })
      }
    }
    const url = this.moduleUrls.get(moduleNamespace)
    if (url === undefined) throw new Error(`HMR cannot locate the loaded module for ${name} from ${baseUrl}`)
    return { url }
  }
}

type ReloadFiber = {
  fiber: Fiber
  entry: Fiber['entry']
  config: unknown
  moduleNamespace: unknown
}

type ReloadModule = { filename: string; moduleNamespace: unknown; plugin: Plugin }

/** 属于同一运行时的入口模块，以它们在替换过程中各自的原始命名空间为键。 */
class ReloadModules {
  private readonly modules = new Map<unknown, ReloadModule>()

  static include(reloads: ReadonlyMap<Plugin, Reload>, plugin: Plugin, job: ModuleJob, runtime: Plugin.Runtime | undefined): boolean {
    let info = reloads.get(plugin)
    if (info === undefined && runtime) info = [...reloads.values()].find(info => info.runtime === runtime)
    if (info === undefined) return false
    info.modules.add(job, plugin)
    return true
  }

  add(job: ModuleJob, plugin: Plugin): this {
    assert(job.module, `HMR pending module is missing: ${job.url}`)
    const moduleNamespace: unknown = job.module.getNamespace()
    this.modules.set(moduleNamespace, { filename: job.url, moduleNamespace, plugin })
    return this
  }

  async importRemaining(loader: Context['loader'], getOuterStack: () => string[], primary: ReloadModule): Promise<ReloadModules> {
    const replacements = new ReloadModules()
    for (const [originalNamespace, { filename }] of this.modules) {
      if (filename === primary.filename) {
        replacements.modules.set(originalNamespace, primary)
        continue
      }
      const moduleNamespace: unknown = await loader.import(filename, getOuterStack)
      const plugin = loader.unwrapExports(moduleNamespace) as Plugin
      replacements.modules.set(originalNamespace, { filename, moduleNamespace, plugin })
    }
    return replacements
  }

  *getActiveImplementations(ctx: Context, plugin: Plugin, fibers: readonly ReloadFiber[]): Generator<[ReloadFiber, Plugin]> {
    const callbacks = new Set([...this.modules.values()].map(value => ctx.registry.resolve(value.plugin)))
    const implementations = fibers.map((previousFiber) => {
      if (previousFiber.entry === undefined) return [previousFiber, plugin] as const
      const replacement = this.modules.get(previousFiber.moduleNamespace)
      const implementation = replacement ? replacement.plugin : ctx.loader.unwrapExports(previousFiber.moduleNamespace) as Plugin
      callbacks.add(ctx.registry.resolve(implementation))
      return [previousFiber, implementation] as const
    })
    for (const [previousFiber, implementation] of implementations) {
      if (previousFiber.fiber.parent.fiber.uid === null) continue
      if (previousFiber.entry === undefined && callbacks.size > 1) {
        throw new Error('HMR replacement is ambiguous for a plugin instance without a Loader entry')
      }
      yield [previousFiber, implementation]
    }
  }

  updateEntries(loader: Context['loader']): void {
    for (const [originalNamespace, { moduleNamespace }] of this.modules) {
      for (const entry of loader.entries()) {
        if (entry.moduleNamespace === originalNamespace) entry.moduleNamespace = moduleNamespace
      }
    }
  }
}

/** 兼容 Cordis 的模块配置与事件的熱重载服务。 */
@Inject('loader')
@Inject('timer')
class Hmr extends Service {
  /** 兼容 Cordis 的监听器默认值。 */
  static Config: z<HmrConfig> = z.object({
    base: z.string(),
    root: z.array(String).role('table').default(['.']),
    ignored: z.array(String).role('table').default([
      '**/node_modules',
      '**/.*',
      'cache',
      'data',
    ]),
    debounce: z.natural().role('ms').default(100),
  })

  /** 用于解析模块监听根目录的绝对基础目录。 */
  public baseDir: string

  private readonly ownerContext: Context
  private internal: ModuleLoader
  private watcher: FSWatcher | undefined

  /**
   * 来自外部依赖的变更永远会触发整进程重载。
   * 外部依赖是 CLI worker 入口点的依赖树。
   */
  private externals!: Set<string>

  /**
   * 应当重新加载的文件（已被接受的变更）。
   * 包含所有暂存的文件以及它们的依赖方。
   */
  private accepted!: Set<string>

  /**
   * 不应当重新加载的文件。
   * 包含外部依赖，以及所有依赖方都被拒绝的文件。
   */
  private declined!: Set<string>

  /** 等待处理的暂存文件变更 */
  private stashed = new Set<string>()
  private operations: Promise<unknown> = Promise.resolve()
  private readonly executing = new AsyncLocalStorage<boolean>()
  private applicationReady: Promise<boolean> = Promise.resolve(true)
  private closing = false
  private readonly configPaths = new Set<string>()
  private readonly manifests = new PackageManifests()
  private readonly files = new ModuleFiles()
  /** 从进程入口点静态可达的每个模块，包括 node_modules 下的模块；在首次使用时收集。 */
  private hostModules!: () => Promise<Set<string>>

  /** 把调用方拥有的变更与所有自动重载路径串行化。
   * @param operation 不得与模块或配置替换重叠的工作。
   * @returns 异步工作完成之后的操作结果。
   */
  runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.executing.getStore()) return Promise.reject(new Error('HMR transactions cannot be nested'))
    const task = this.operations.then(async () => {
      if (this.closing) throw new Error('HMR is disposed')
      return this.executing.run(true, operation)
    })
    this.operations = task.catch(() => {})
    return task
  }

  private runReload(operation: () => Promise<void>): Promise<void> {
    return this.runExclusive(async () => {
      if (await this.applicationReady) await operation()
    })
  }

  /** 通过和模块替换相同的队列来监听某个配置路径。
   * @param filename 绝对路径，可能尚不存在。
   * @param refresh 从当前文件重建配置，并等待 Loader 完成。
   * @returns 关闭本次注册并等待其待处理刷新的释放函数。
   */
  async watchConfig(filename: string, refresh: () => Promise<void>): Promise<() => Promise<void>> {
    const paths = [resolve(filename), canonicalPath(filename)]
    if (paths.some(path => this.configPaths.has(path))) throw new Error(`config path already registered: ${filename}`)
    for (const path of paths) this.configPaths.add(path)
    try {
      const dispose = await this.executing.exit(() => watchExactConfig(
        this.ownerContext, filename, this.config, () => this.runReload(refresh), () => this.executing.getStore() === true,
      ))
      return async () => {
        await dispose()
        for (const path of paths) this.configPaths.delete(path)
      }
    } catch (error) {
      for (const path of paths) this.configPaths.delete(path)
      throw error
    }
  }

  constructor(ctx: Context, public config: HmrConfig) {
    super(ctx, 'hmr')
    this.ownerContext = ctx
    if (!this.ctx.loader.internal) {
      throw new Error('--expose-internals is required for HMR service')
    }
    this.internal = this.ctx.loader.internal
    this.baseDir = fileURLToPath(new URL(config.base || '.', ctx.baseUrl))
  }

  /**
   * 某个 URL 对应的已缓存 ES module job。打包后的 worker 加载器不暴露 Node 模块缓存；
   * 原生 Node 即使异步模块钩子运行在独立线程中，也会保留这一缓存。
   */
  private esmJob(url: string): ModuleJob | undefined {
    return this.hasEsmCache() ? this.internal.loadCache.get(url) : undefined
  }

  /** 本线程是否保留了 Node 的 ES 模块缓存；打包后的 worker 加载器不保留任何缓存。 */
  private hasEsmCache(): boolean {
    const cache: unknown = Reflect.get(this.internal, 'loadCache')
    return cache !== undefined
  }

  /** ES 模块缓存是否为某个 URL 持有 job；当本线程不保留 ES 模块缓存时为 `false`。 */
  private esmHas(url: string, type?: string): boolean {
    return this.hasEsmCache() && (type === undefined ? this.internal.loadCache.has(url) : this.internal.loadCache.has(url, type))
  }

  /** ES 模块缓存的键；当本线程不保留 ES 模块缓存时为空。 */
  private esmUrls(): string[] {
    return this.hasEsmCache() ? [...Map.prototype.keys.call(this.internal.loadCache) as Iterable<string>] : []
  }

  /** ES 模块缓存的键，以及作为 URL 的 CommonJS 缓存文件名。 */
  private* loadedUrls(): Generator<string> {
    yield* this.esmUrls()
    for (const filename of Object.keys(commonJsCache())) yield pathToFileURL(filename).href
  }

  /** 进程入口点对应的模块 job（当加载器把它缓存在入口的真实路径下时）。 */
  private mainJob(): ModuleJob | undefined {
    const entry = process.argv[1]
    if (entry === undefined) return undefined
    // 包的 bin 通过链接启动，Node 会把这个模块缓存在其目标路径下。
    return this.esmJob(pathToFileURL(canonicalPath(resolve(entry))).href)
  }

  async* [Service.init](): AsyncGenerator<() => Promise<void>, void, unknown> {
    const mainJob = this.mainJob()
    let host: Promise<Set<string>> | undefined
    this.hostModules = () => host ??= mainJob === undefined ? Promise.resolve(new Set()) : loadDependencies(mainJob, new Set(), true)
    yield async () => {
      this.closing = true
      await this.watcher?.close()
      // 一次配置重载可能会移除它自己的 HMR 条目。
      if (!this.executing.getStore()) await this.operations
      this.manifests.dispose()
    }

    const profile = this.ownerContext.get('profileContext')
    if (profile !== undefined) {
      const ready = this.ownerContext.get('appReady')
      if (ready === undefined) throw new Error('Profile HMR requires application readiness')
      const started = Promise.withResolvers<boolean>()
      this.applicationReady = started.promise
      const unsubscribe = ready.onReady(() => {
        // 随应用一起启动的插件会被记录；稍后加载的模块按修改时间比较。
        try {
          this.files.observe(this.profileModules(profileRoots(profile.dir)))
        } catch (error) {
          // 若没有首次记录，模块会按修改时间与本 HMR 实例的创建时间比较。
          this.ctx.logger.warn(error)
        }
        started.resolve(true)
      })
      yield () => { unsubscribe(); started.resolve(false); return Promise.resolve() }
      const manifestPath = join(profile.dir, 'package.json')
      const patchFiles = [profile.patchPath, join(profile.home, PROFILE_PATCH_FILENAME)]
      let lastInputs: string | undefined
      let lastBundles = JSON.stringify(profile.startedBundles)
      const refresh = async (manifestOnly: boolean): Promise<void> => {
        const bundles = JSON.stringify(readProfileManifest('dsh', profile.dir).dsh?.profile?.bundles ?? [])
        if (manifestOnly && bundles === lastBundles) return
        const inputs = JSON.stringify([bundles, ...patchFiles.map((filename) => {
          try { return readFileSync(filename, 'utf8') }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
            throw error
          }
        })])
        if (inputs === lastInputs) return
        const { warnings, pending, restartReason } = await this.reconcileProfile()
        if (restartReason !== undefined) this.ctx.logger.warn('restart required: %s', restartReason)
        if (pending.length > 0) this.ctx.logger.warn('changed modules keep running their previous code until a restart: %o', pending)
        lastInputs = inputs
        lastBundles = bundles
        for (const diagnostic of warnings) this.ctx.logger.warn(diagnostic)
      }
      for (const filename of patchFiles) await this.watchConfig(filename, () => refresh(false))
      await this.watchConfig(manifestPath, () => refresh(true))
    }

    const { loader } = this.ctx
    const { root, ignored } = this.config
    if (!this.config.base) {
      this.ctx.logger.info('watching %o', root)
    } else {
      this.ctx.logger.info('watching %o in %s', root, this.baseDir)
    }

    const match = picomatch(ignored)
    const watchBaseDir = realpathSync(this.baseDir)

    // 在打开监听器之前收集外部依赖，这样每条就绪之后的变更都会被已经拥有
    // 分类状态的监听器观测到。
    if (mainJob) {
      this.externals = await loadDependencies(mainJob)
    } else {
      this.externals = new Set()
    }

    this.watcher = watch(root, {
      ...this.config,
      cwd: watchBaseDir,
      ignored: path => match(relative(watchBaseDir, path)),
      ignoreInitial: true,
    })

    const changed = new Set<string>()
    const dispatch = this.ctx.debounce(() => {
      void this.runExclusive(async () => {
        if (!await this.applicationReady) return
        const batch = [...changed]
        changed.clear()
        const includes = new Set<Include>()
        let fullReload = false
        for (const path of batch) {
          const filename = canonicalPath(resolve(watchBaseDir, path))
          const configuredFilename = resolve(this.baseDir, path)
          if (this.configPaths.has(filename) || this.configPaths.has(configuredFilename)) continue
          const isManifest = basename(filename) === 'package.json' && !filename.includes(`${sep}node_modules${sep}`)
          if (isManifest) {
            this.manifests.invalidate(filename)
          }
          const url = pathToFileURL(filename).href
          if (this.externals.has(url)) {
            fullReload = true
            continue
          }
          if (this.esmHas(url) || this.esmHas(url, 'json')) {
            this.stashed.add(url)
            continue
          }
          if (isManifest) continue
          const include = [...loader.entries()].map(entry => entry.subtree as Include | undefined)
            .find(tree => tree?.filename === filename || tree?.filename === configuredFilename)
          if (include !== undefined) includes.add(include)
          else this.ctx.emit('hmr/change', url)
        }
        if (!fullReload && includes.size === 0 && this.stashed.size === 0) return
        if (fullReload) {
          loader.exit()
          return
        }
        for (const include of includes) await include.refresh()
        if (this.stashed.size > 0) {
          try { await this.partialReload() } finally { this.stashed.clear() }
        }
        await loader.await()
      }).catch((error: unknown) => { this.ctx.logger.warn(error) })
    }, this.config.debounce)
    this.watcher.on('change', (path) => { changed.add(path); dispatch() })

    const ready = Promise.withResolvers<void>()
    let readyState: 'pending' | 'resolved' | 'rejected' = root.length === 0 ? 'resolved' : 'pending'
    if (root.length === 0) {
      ready.resolve()
    } else {
      this.watcher.once('ready', () => {
        readyState = 'resolved'
        ready.resolve()
      })
    }
    this.watcher.on('error', (error) => {
      if (readyState === 'pending') {
        readyState = 'rejected'
        ready.reject(error)
      } else {
        this.ctx.logger.warn(error)
      }
    })
    await ready.promise
  }

  /** 从模块导入诊断中剔除 HMR 内部栈帧。
   * @returns 被保留下来的外层栈帧。
   */
  getOuterStack: () => string[] = () => []

  /** 从当前 Node 加载器读取直接的模块依赖 URL。
   * @param url 模块 URL。
   * @returns 被链接的模块 URL，或对于一个未缓存模块的空列表。
   */
  async getLinked(url: string): Promise<string[]> {
    const job = this.esmJob(url)
    if (!job) return []
    const linked = await job.linked
    return Array.prototype.map.call(linked, (job: ModuleJob) => job.url) as string[]
  }

  /**
   * 把变更文件分类为已接受（应当重载）与被拒绝（不应当重载）。
   *
   * 一个文件若被直接修改（已暂存），或其任一依赖方已被接受，则被接受。一个文件
   * 若其所有依赖方都被拒绝，或它属于外部依赖，则被拒绝。
   */
  private async analyzeChanges() {
    const pending: string[] = []

    this.accepted = new Set(this.stashed)
    this.declined = new Set(this.externals)

    const isExcluded = (url: string) => url.startsWith('node:') || url.includes('/node_modules/')

    await Promise.all([...this.stashed].map(async (url) => {
      const children = await this.getLinked(url)
      for (const child of children) {
        if (this.accepted.has(child) || this.declined.has(child) || isExcluded(child)) continue
        pending.push(child)
      }
    }))

    while (pending.length) {
      let index = 0, hasUpdate = false
      while (index < pending.length) {
        const url = pending[index] as string
        const children = await this.getLinked(url)
        let isDeclined = true, isAccepted = false
        for (const child of children) {
          if (this.declined.has(child) || isExcluded(child)) continue
          if (this.accepted.has(child)) {
            isAccepted = true
            break
          } else {
            isDeclined = false
            if (!pending.includes(child)) {
              hasUpdate = true
              pending.push(child)
            }
          }
        }
        if (isAccepted || isDeclined) {
          hasUpdate = true
          pending.splice(index, 1)
          if (isAccepted) {
            this.accepted.add(url)
          } else {
            this.declined.add(url)
          }
        } else {
          index++
        }
      }
      if (!hasUpdate) break
    }

    for (const url of pending) {
      this.declined.add(url)
    }
  }

  private async partialReload() {
    await this.analyzeChanges()

    const pending = new Map<ModuleJob, Plugin>()
    const reloads = new Map<Plugin, Reload>()
    const moduleUrls = EntryNamespaces.getModuleUrls(this.internal)

    // 为每个配置树 URL 构建插件名称映射。
    // 插件入口文件被视为原子的重载单元。
    const nameMap = new Map<string, EntryNamespaces>()
    for (const entry of this.ctx.loader.entries()) {
      const baseUrl = entry.parent.tree.ctx.baseUrl
      if (baseUrl === undefined) throw new Error('HMR entry tree has no base URL')
      const names = nameMap.get(baseUrl) ?? new EntryNamespaces(this.internal, moduleUrls)
      names.add(entry.options.name, entry.moduleNamespace)
      nameMap.set(baseUrl, names)
    }

    // 找出每个插件已加载的 URL，并检查它是否需要重载。
    for (const [baseUrl, names] of nameMap) {
      for (const [name, moduleNamespace] of names) {
        try {
          const { url } = await names.resolve(name, baseUrl, moduleNamespace)
          if (this.declined.has(url)) continue
          const job = this.esmJob(url)
          const plugin = this.ctx.loader.unwrapExports(job?.module?.getNamespace()) as Plugin | undefined
          if (!job || !plugin) continue
          pending.set(job, plugin)
          this.declined.add(url)
        } catch (err) {
          this.ctx.logger.warn(err)
        }
      }
    }

    // 检查每个待处理插件的依赖树中是否存在已被接受的文件。
    for (const [job, plugin] of pending) {
      this.declined.delete(job.url)
      const dependencies = [...await loadDependencies(job, this.declined)]
      this.declined.add(job.url)

      if (dependencies.length === 0) {
        pending.delete(job)
        continue
      }
      if (!dependencies.some(dep => this.accepted.has(dep))) continue
      dependencies.forEach(dep => this.accepted.add(dep))

      const runtime = this.ctx.registry.get(plugin)
      if (ReloadModules.include(reloads, plugin, job, runtime)) continue
      reloads.set(plugin, {
        filename: job.url,
        runtime,
        modules: new ReloadModules().add(job, plugin),
      })
    }

    // 被替换运行时的再导出根目录不得保留对其旧模块的绑定。
    for (const [job, plugin] of pending) {
      if (ReloadModules.include(reloads, plugin, job, this.ctx.registry.get(plugin))) this.accepted.add(job.url)
    }

    const rollback = this.evict(this.accepted)

    // 尝试重新导入所有插件入口文件。
    const generations = [...reloads].map(([previous, info]) => ({
      ...info, previous,
      fibers: [...info.runtime?.fibers ?? []].map((fiber) => {
        const entry = fiber.entry?.fiber?.uid === fiber.uid ? fiber.entry : undefined
        const config: unknown = entry === undefined ? fiber._config : entry.options.config
        return { fiber, entry, config, moduleNamespace: entry?.moduleNamespace }
      }),
    }))
    type ReloadAttempt = (typeof generations)[number] & {
      replacement: Plugin
      replacements: ReloadModules
      activated: Fiber[]
    }
    const attempts: ReloadAttempt[] = []
    try {
      for (const generation of generations) {
        const moduleNamespace: unknown = await this.ctx.loader.import(generation.filename, this.getOuterStack)
        const replacement = this.ctx.loader.unwrapExports(moduleNamespace) as Plugin
        const replacements = await generation.modules.importRemaining(this.ctx.loader, this.getOuterStack, {
          filename: generation.filename, moduleNamespace, plugin: replacement,
        })
        attempts.push({ ...generation, replacement, replacements, activated: [] })
      }
    } catch (e) {
      handleError(this.ctx, e)
      rollback()
      throw e
    }

    const reload = async (
      plugin: Plugin,
      fibers: (typeof generations)[number]['fibers'],
      replacements = new ReloadModules(),
      activated: Fiber[] = [],
    ) => {
      for (const [previousFiber, implementation] of replacements.getActiveImplementations(this.ctx, plugin, fibers)) {
        const fiber = previousFiber.fiber.parent.registry.plugin(implementation, previousFiber.config, this.getOuterStack).ctx.fiber
        if (previousFiber.entry !== undefined) {
          fiber.entry = previousFiber.entry
          previousFiber.entry.fiber = fiber
        }
        activated.push(fiber)
      }
      await Promise.all(activated.map(fiber => fiber.await()))
    }

    const removed = new Set<Plugin>()
    try {
      for (const { previous: plugin, replacement, filename, runtime, fibers, replacements, activated } of attempts) {
        if (!runtime) continue
        const path = relative(this.baseDir, fileURLToPath(filename))

        removed.add(plugin)
        try {
          this.ctx.registry.delete(plugin)
          await Promise.all(fibers.map(({ fiber }) => fiber.await()))
        } catch (err) {
          this.ctx.logger.warn('failed to dispose plugin at %C', path)
          this.ctx.logger.warn(err)
        }

        try {
          await reload(replacement, fibers, replacements, activated)
          this.ctx.logger.info('reload plugin at %C', path)
        } catch (err) {
          this.ctx.logger.warn('failed to reload plugin at %C', path)
          this.ctx.logger.warn(err)
          throw err
        }
      }
    } catch (error) {
      // 在替换失败后恢复缓存并重新注册旧插件。
      rollback()
      for (const { previous: plugin, fibers, activated } of attempts) {
        if (!removed.has(plugin)) continue
        try {
          for (const { runtime } of activated) {
            if (runtime && this.ctx.registry.get(runtime.callback) === runtime) {
              const replacementFibers = [...runtime.fibers]
              this.ctx.registry.delete(runtime.callback)
              // 启动失败的错误会在其拆解完成之后仍然保留在 fiber 上。
              await Promise.allSettled(replacementFibers.map(fiber => fiber.await()))
            }
          }
          await reload(plugin, fibers)
        } catch (err) {
          this.ctx.logger.warn(err)
        }
      }
      throw error
    }

    await this.ctx.loader.await()
    for (const { replacements } of attempts) {
      replacements.updateEntries(this.ctx.loader)
    }
    this.ctx.emit('hmr/reload', reloads)
    this.files.refresh(this.accepted)
    this.stashed = new Set()
  }

  /**
   * 从 ES 模块与 CommonJS 缓存中移除模块，使下一次导入重新求值它们的文件。
   *
   * 通过 `import()` 加载的 CommonJS 模块会同时出现在两个缓存中。Node 的 `LoadCache`
   * 把每个 URL 映射到按类型区分的 job，而它自身的 `delete()` 只清除一个类型槽，因此
   * 整个条目要通过 `Map.prototype` 来移除。
   * @returns 恢复被移除的缓存条目。
   */
  private evict(urls: Iterable<string>): () => void {
    const esmBackup = new Map<string, unknown>()
    const cjsBackup = new Map<string, NodeJS.Module>()
    const cache = commonJsCache()
    const list = [...urls]
    // 仅 CommonJS 的文件没有可供恢复的 loadCache 条目。
    const cached = new Set(this.esmUrls())
    for (const url of list) {
      if (cached.has(url)) {
        esmBackup.set(url, Map.prototype.get.call(this.internal.loadCache, url))
        Map.prototype.delete.call(this.internal.loadCache, url)
      }
    }
    for (const filepath of list.filter(url => url.startsWith('file:')).map(url => fileURLToPath(url))) {
      const module = cache[filepath]
      if (module !== undefined) {
        cjsBackup.set(filepath, module)
        Reflect.deleteProperty(cache, filepath)
      }
    }
    return () => {
      for (const [url, job] of esmBackup) Map.prototype.set.call(this.internal.loadCache, url, job)
      for (const [filepath, module] of cjsBackup) cache[filepath] = module
    }
  }

  /** 位于给定 profile 根目录之下的已加载 `file:` 模块。 */
  private profileModules(roots: readonly string[]): string[] {
    return [...this.loadedUrls()].filter((url) => {
      if (!url.startsWith('file:')) return false
      const filename = fileURLToPath(url)
      return roots.some(root => filename.startsWith(root))
    })
  }

  /** 已加载模块之间的静态导入边，跨越 ES 模块链接与 CommonJS 的 `require` 子模块。 */
  private async moduleGraph(): Promise<Map<string, Set<string>>> {
    const importers = new Map<string, Set<string>>()
    const add = (parent: string, child: string) => {
      importers.set(child, (importers.get(child) ?? new Set()).add(parent))
    }
    await Promise.all([...moduleJobs(this.internal)].map(async (job) => {
      for (const child of await linkedJobs(job)) add(job.url, child.url)
    }))
    for (const [filename, module] of Object.entries(commonJsCache())) {
      // 直接写入 `require.cache` 的代码可能存入并非 Node 模块的对象。
      /* v8 ignore next -- Node stores no undefined values in require.cache; the index type admits them */
      const children: unknown = module === undefined ? undefined : Reflect.get(module, 'children')
      if (!Array.isArray(children)) continue
      for (const child of children as NodeJS.Module[]) add(pathToFileURL(filename).href, pathToFileURL(child.filename).href)
    }
    return importers
  }

  /**
   * 规划变更模块的替换，而不做任何实际改动。一个变更模块，若其导入方触及进程入口点
   * 的静态图，或一个没有任何受影响 Loader 入口会启动的插件，会与它的导入方一起保持
   * 加载并处于 pending。其余变更模块，以及每一个导入它们的模块，会被 {@link stopPlanned}
   * 驱逐；它还会让每个变更文件直到其根目录的清单过期，并停止运行受影响插件的
   * Loader 入口。
   * @param stale 发生变更的模块 URL。
   * @param roots 带有末尾分隔符、界定过期清单范围的目录。
   * @returns pending 的模块，以及其余模块的替换方案。
   */
  private async planReplacement(stale: ReadonlySet<string>, roots: readonly string[]): Promise<ReplacementPlan> {
    const importers = await this.moduleGraph()
    const host = await this.hostModules()
    const managed = new Set(this.ctx.loader.entries())
    const plan: ReplacementPlan = {
      pending: [], evicted: new Set(), manifests: new Set(), plugins: new Set(), fibers: new Set(),
    }
    for (const url of stale) {
      const affected = new Set([url])
      for (const module of affected) for (const importer of importers.get(module) ?? []) affected.add(importer)
      const running = [...new Set([...affected].flatMap(module => this.pluginsOf(module)))]
        .flatMap(plugin => [...this.ctx.registry.get(plugin)?.fibers ?? []].map(fiber => ({ plugin, fiber })))
      const affectedFibers = new Set(running.map(({ fiber }) => fiber))
      /** 由其自身 fiber 运行某个受影响插件、并直接或通过其祖先启动本 fiber 的 Loader 入口。 */
      const owner = (fiber: Fiber): Entry | undefined => {
        for (let current = fiber; current.uid !== 0; current = current.parent.fiber) {
          const entry = current.entry
          if (entry?.fiber === current && managed.has(entry) && affectedFibers.has(current)) return entry
        }
        return undefined
      }
      const entries = running.flatMap(({ fiber }) => owner(fiber) ?? [])
      // 在 Loader 入口之外注册的插件没有能够启动其替换体的拥有者。
      const reason = [...affected].some(module => host.has(module)) ? 'host-module'
        : entries.length < running.length ? 'unmanaged-plugin' : undefined
      if (reason !== undefined) {
        plan.pending.push({ url, reason })
        continue
      }
      for (const manifest of packageManifests(url, roots)) plan.manifests.add(manifest)
      for (const module of affected) plan.evicted.add(module)
      for (const { plugin, fiber } of running) {
        plan.plugins.add(plugin)
        plan.fibers.add(fiber)
      }
    }
    return plan
  }

  /**
   * 一个已加载模块导出的插件，从 ES 模块命名空间与 Node 为它缓存的 CommonJS 导出中
   * 读取，且不进行任何求值。
   * @param url 已加载的模块 URL。
   * @returns 被导出的插件。
   */
  private pluginsOf(url: string): Plugin[] {
    const namespace = namespaceOf(this.esmJob(url))
    const required = url.startsWith('file:') ? commonJsCache()[fileURLToPath(url)] : undefined
    const exports: unknown = required?.loaded === true ? required.exports : undefined
    return [namespace, exports].filter(value => value !== undefined).map(value => this.ctx.loader.unwrapExports(value) as Plugin)
  }

  /**
   * 执行一个已规划的替换：让其清单过期、无备份地驱逐其模块，并停止其 Loader 入口，
   * 从而在应用该代时，会在启动它们时导入当前的文件。
   * @param plan 已规划的替换方案。
   */
  private async stopPlanned(plan: ReplacementPlan): Promise<void> {
    for (const manifest of plan.manifests) this.manifests.invalidate(manifest)
    this.evict(plan.evicted)
    // 删除运行时会停止它的 fiber，而不会让 Loader 把那些入口记录为已禁用。
    for (const plugin of plan.plugins) this.ctx.registry.delete(plugin)
    // Cordis 把处置失败包含在 fiber 中，由它记录日志。
    await Promise.allSettled([...plan.fibers].map(fiber => fiber.await()))
  }

  /**
   * 驱逐位于某个重组所丢弃映射的目录之下的已加载模块，并让其包配置过期，使得一个被
   * 禁用或移除、而后又被安装或启用的包会被重新导入。DSH 自身静态图中的模块，以及位于
   * 仍被映射目录之下的模块，保持加载。
   * @param dropped 被丢弃映射的真实目录，带有末尾分隔符。
   * @param kept 仍保留映射的真实目录，带有末尾分隔符。
   */
  private async evictDropped(dropped: readonly string[], kept: ReadonlySet<string>): Promise<void> {
    if (dropped.length === 0) return
    const host = new Set(await this.hostModules())
    const urls = this.profileModules(dropped).filter((url) => {
      const filename = fileURLToPath(url)
      return !host.has(url) && ![...kept].some(dir => filename.startsWith(dir))
    })
    for (const url of urls) for (const manifest of packageManifests(url, dropped)) this.manifests.invalidate(manifest)
    this.evict(urls)
  }

  /** 报告一个失败的替换步骤，并保留调用方的回退结果。 */
  private async contained<T>(step: string, operation: () => T | Promise<T>, fallback: T): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      this.ctx.logger.warn('%s failed; module replacement was not completed', step)
      this.ctx.logger.warn(error)
      return fallback
    }
  }

  /**
   * 从 profile 的清单与补丁文件重组 profile，替换那些位于 profile 目录或其链接包目标
   * 之下、且磁盘上发生变更的已加载文件所对应的运行中插件，并发布其运行时解析结果。
   * 发生变更的模块会被驱逐，运行它们的 Loader 入口会停止；随后 app-boot 的
   * {@link recomposeProfile} 发布该解析、应用该代、用当前文件与配置启动那些已停止的入口、
   * 重新导入导入再次失败的入口，并判定激活。此后，本次重组所丢弃映射之下的模块会被
   * 驱逐，因此一个被移除或取消选择的包在回归时会重新被导入。调用方运行在
   * {@link runExclusive} 内部。
   * @param requiredIds 即使其非活动状态早于本次调用、也要作为失败报告的入口 id。
   * @returns 非活动入口的诊断信息、在重启之后才会加载的变更模块，以及整个 profile 的重启原因。
   * @throws 重组在补丁读取、发布、准备、应用或激活上的失败，包括一个加载或启动失败、
   * 其旧代码不再运行的替换插件。
   */
  async reconcileProfile(requiredIds: readonly string[] = []): Promise<ProfileReconciliation> {
    if (this.executing.getStore() !== true) throw new Error('HMR profile reconciliation must run inside runExclusive')
    const profile = this.ownerContext.get('profileContext')
    if (profile === undefined) throw new Error('HMR profile reconciliation requires profileContext')
    // 本次重组所停止的入口会再次启动；若无法启动则令重组失败。
    const running = [...this.ctx.loader.entries()].filter(entry => entry.fiber?.state === FiberState.ACTIVE)
    // 在包仍位于磁盘上时读取，这样被移除链接的目标能以真实拼写被知晓。
    const mapped = mappedDirectories(this.ownerContext.get('pluginPackages')?.resolution)
    let comparison: ProfileComparison | undefined
    let comparedAt = 0
    let pending: PendingModule[] = []
    try {
      const patches = readProfilePatches('dsh', profile)
      comparedAt = this.files.now()
      // 一次失败的对比会保留每一条记录，因此下一次重组会再次比较相同的模块。
      comparison = await this.contained('comparing loaded modules with disk', () => {
        const roots = profileRoots(profile.dir)
        return Promise.resolve({ roots, ...this.files.compare(this.profileModules(roots)) })
      }, undefined)
      // 变更模块在替换之前保持过期，包括当该代无法被应用时。
      pending = [...comparison?.stale ?? []].map(url => ({ url, reason: 'module-comparison' }))
      const compared = comparison
      const unavailable = !this.hasEsmCache()
      if (!unavailable && compared !== undefined && pending.length > 0) {
        pending = await this.contained('planning module replacement', async () => {
          const plan = await this.planReplacement(compared.stale, compared.roots)
          await this.stopPlanned(plan)
          return plan.pending
        }, pending)
      }
      // 链接或求值失败的模块会被驱逐，这样重组会针对已修正的文件或此后安装的依赖
      // 重试失败的导入。
      await this.contained('expiring failed imports', () => {
        // 没有 ES 模块缓存时，无法得知任何失败的模块。
        if (unavailable) return
        const roots = compared?.roots ?? [realpathSync(profile.dir) + sep]
        // 失败导入之后才安装的依赖，可能位于 Node 记录为“没有清单”的目录中。
        for (const root of roots) this.manifests.invalidate(join(root, 'package.json'))
        // Node 会保留一个链接或求值失败的模块。
        this.evict(this.profileModules(roots).filter((url) => {
          const job = this.esmJob(url)
          return job !== undefined && namespaceOf(job) === undefined
        }))
      }, undefined)
      const result = await recomposeProfile(this.ownerContext.root, patches, 'dsh', { requiredIds, running })
      const restartReason = compared === undefined || unavailable ? 'module-comparison' : result.restartReason
      return { warnings: result.warnings, pending, ...restartReason === undefined ? {} : { restartReason } }
    } finally {
      const recorded = comparison
      await this.contained('evicting dropped packages', () => {
        const kept = mappedDirectories(this.ownerContext.get('pluginPackages')?.resolution)
        return this.evictDropped([...mapped].filter(dir => !kept.has(dir)), kept)
      }, undefined)
      await this.contained('recording loaded module files', () => {
        if (recorded === undefined) return
        // 替换之前读取到的身份，使此后发生的写入仍可被检测到。
        const urls = this.profileModules(recorded.roots)
        this.files.observe(urls, { seen: recorded.seen, retained: new Set(pending.map(({ url }) => url)), at: comparedAt })
      }, undefined)
    }
  }
}

/** 与磁盘比较过的已加载 profile 模块，以及界定它们的根目录。 */
interface ProfileComparison {
  roots: string[]
  stale: Set<string>
  seen: Map<string, string | undefined>
}

/** 一次替换所驱逐的模块、它令其过期的清单，以及它停止的插件；pending 模块保持加载。 */
interface ReplacementPlan {
  pending: PendingModule[]
  evicted: Set<string>
  manifests: Set<string>
  plugins: Set<Plugin>
  fibers: Set<Fiber>
}

/** {@link Hmr.reconcileProfile} 的结果。 */
export interface ProfileReconciliation {
  /** 遗留为非活动的 Loader 入口的诊断信息。 */
  warnings: string[]
  /** 文件在磁盘上变更、且其旧代码一直运行到重启为止的已加载模块。 */
  pending: PendingModule[]
  /**
   * 为何所有变更都要等待重启：`module-comparison` 表示模块缓存无法被检查或文件无法
   * 被比较，即使没有任何 URL 可知；`package-moved` 表示运行时解析无法发布一个被
   * 移动的包。
   */
  restartReason?: 'module-comparison' | 'package-moved'
}

/** 一个仅在重启之后才会加载的变更模块。 */
export interface PendingModule {
  url: string
  /**
   * `host-module`：进程入口点的静态图导入了它。`unmanaged-plugin`：它被一个运行在
   * 可遍历 Loader 入口之外的插件导入。`module-comparison`：已加载模块无法与磁盘比较。
   */
  reason: 'host-module' | 'unmanaged-plugin' | 'module-comparison'
}

/** Node 的 `kErrored` 模块状态，在所有受支持的 Node 版本中取值相同。 */
const MODULE_ERRORED = 5

/** 一个已缓存模块 job 的命名空间；当它没有命名空间，或其求值抛错时为 `undefined`。 */
function namespaceOf(job: ModuleJob | undefined): unknown {
  if (job?.module === undefined) return undefined
  // 一个求值抛错的模块会保留一个绑定从未被初始化的命名空间。与 HMR 读取的其它加载器
  // 内部接口一样，`getStatus()` 在每一个受支持的 Node 版本中都存在于 ModuleWrap 上。
  const status: unknown = Reflect.apply(Reflect.get(job.module, 'getStatus') as () => number, job.module, [])
  if (status === MODULE_ERRORED) return undefined
  try {
    return job.module.getNamespace()
  /* v8 ignore start -- a cached module still linking in a concurrent import has no namespace yet; tests cannot hold an import there */
  } catch (_error) {
    // 尚未被实例化的模块不会导出任何运行中的插件。
    return undefined
  }
  /* v8 ignore stop */
}

/**
 * 一个模块 job 所链接到的 job。Node 24+ 可能把它们暴露为一个数组；Node 22 会保留一个
 * 链接被拒绝的失败导入的 job，而这样的 job 不贡献任何链接。
 */
async function linkedJobs(job: ModuleJob): Promise<ModuleJob[]> {
  /* v8 ignore next -- CI coverage runs Node 24+, which drops failed jobs from the cache */
  const linked = await Promise.resolve(job.linked).catch((_error: unknown) => [])
  // Node 22 may return a null-prototype array without methods or an iterator.
  return Array.from(linked)
}

/** 兼容 Node 的 CommonJS 缓存；打包后的 worker 实现 require 时不暴露这一缓存。 */
function commonJsCache(): NodeJS.Dict<NodeJS.Module> {
  // Node 的类型声明每个 `require` 都带有该缓存。
  const cache: unknown = Reflect.get(createRequire(import.meta.url), 'cache')
  return (cache ?? {}) as NodeJS.Dict<NodeJS.Module>
}

/** 加载器缓存中的每一个模块 job；Node 的 `LoadCache` 把每个 URL 映射到按类型区分的 job。 */
function* moduleJobs(internal: ModuleLoader): Generator<ModuleJob> {
  for (const value of Map.prototype.values.call(internal.loadCache) as Iterable<Partial<Record<string, ModuleJob>>>) {
    yield* Object.values(value).filter(job => job !== undefined)
  }
}

/**
 * 一个运行时解析的 profile 映射与链接根目录所在的目录，以它们存在的每一种真实拼写
 * 给出，每个都带有末尾分隔符。
 * @param resolution 已发布的解析结果（若有）。
 * @returns 这些目录；没有解析结果时为空。
 */
function mappedDirectories(resolution: RuntimeResolution | undefined): Set<string> {
  const directories = new Set<string>()
  if (resolution === undefined) return directories
  const dirs = [...resolution.entries.filter(entry => entry.scope === 'profile').map(entry => entry.packageDir),
    ...resolution.linkedRoots.map(root => root.realPath)]
  for (const dir of dirs) for (const spelling of existsSync(dir) ? realSpellings(dir) : [dir]) directories.add(spelling + sep)
  return directories
}

/**
 * 一个已存在路径的 JavaScript 与原生真实路径。打包后的 worker 文件系统没有原生的
 * realpath。
 * @param path 已存在的路径。
 * @returns 这些不同的拼写。
 */
function realSpellings(path: string): string[] {
  const native: unknown = Reflect.get(realpathSync, 'native')
  return [realpathSync(path), ...typeof native === 'function' ? [String(Reflect.apply(native, realpathSync, [path]))] : []]
}

/**
 * profile 及其链接包所指向目标的真实目录，每个都带有末尾分隔符。每一种都以两种
 * 真实路径拼写出现：Node 的模块缓存使用 JavaScript 版本，运行时解析使用原生版本，
 * 而在 Windows 上它们因 8.3 短名称而不同。
 */
function profileRoots(dir: string): string[] {
  const real = realpathSync(dir)
  const modules = join(real, 'node_modules')
  const names = existsSync(modules) ? readdirSync(modules) : []
  const packages = names.flatMap(name => name.startsWith('@')
    ? readdirSync(join(modules, name)).map(child => join(modules, name, child))
    : [join(modules, name)])
  const linked = packages.filter(path => lstatSync(path).isSymbolicLink() && existsSync(path))
  return [...new Set([dir, ...linked].flatMap(path => realSpellings(path)).map(root => root + sep))]
}

/** 从模块文件所在目录一直到包含它的 profile 根目录或链接包目标的每一个 `package.json`。 */
function packageManifests(url: string, roots: readonly string[]): string[] {
  const manifests: string[] = []
  const contains = (directory: string) => roots.some(root => (directory + sep).startsWith(root))
  for (let directory = dirname(fileURLToPath(url)); contains(directory); directory = dirname(directory)) {
    const candidate = join(directory, 'package.json')
    if (existsSync(candidate)) manifests.push(candidate)
  }
  return manifests
}

namespace Hmr {
  /** 兼容 Cordis 的配置类型。 */
  export type Config = HmrConfig


}

export default Hmr
