/** 通过一次运行时拦截解析出的包元数据。 */

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { PluginLocalizedMeta } from '@deepseek-ai/dsh-package-manifest'
import {
  barePackageName,
  installRuntimeInterception,
  registerWorkerResolution,
  type RuntimeInterception,
} from './resolver.ts'
import { ProfileRuntimeResolution, type RuntimeResolution } from '../profile.ts'
import { readPluginMeta } from '../package-meta.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 针对已配置插件指示符的确定性包查找。 */
    pluginPackages: PluginPackages
  }
}

/** 拥有一个已解析模块的包。 */
export interface PluginPackage {
  /** 清单包名。 */
  name: string
  /** 宣告时的清单版本。 */
  version: string | undefined
  /** 绝对包目录。 */
  dir: string
  /** 绝对 package.json 路径。 */
  manifestPath: string
  /** 由元数据读取器共享的已解析清单。 */
  manifest: Record<string, unknown>
}

/** 由 {@link PluginPackages} 安装并拥有的可选运行时拦截。 */
export interface PluginPackagesConfig {
  /** 完整的包表；省略它则只暴露原生包查找。 */
  resolution?: RuntimeResolution
}

function readPackage(dir: string, fallbackName: string): PluginPackage | undefined {
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) return undefined
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  const name = manifest.name
  const version = manifest.version
  return {
    name: typeof name === 'string' ? name : fallbackName,
    version: typeof version === 'string' ? version : undefined,
    dir,
    manifestPath,
    manifest,
  }
}

/** 在一个 profile 进程中由元数据消费者共享的包查找。 */
export class PluginPackages extends Service {
  private packages = new Map<string, PluginPackage | undefined>()
  private readonly interception: RuntimeInterception | undefined
  private disposeWorkerResolution: (() => void) | undefined
  private current: RuntimeResolution | undefined

  constructor(ctx: Context, config: PluginPackagesConfig = {}) {
    super(ctx, 'pluginPackages')
    if (config.resolution === undefined) return
    this.current = config.resolution
    const interception = installRuntimeInterception(config.resolution)
    this.disposeWorkerResolution = registerWorkerResolution(config.resolution)
    this.interception = interception
    ctx.effect(() => () => {
      this.disposeWorkerResolution?.()
      interception.dispose()
    }, 'profile package resolution')
  }

  /** 已发布的运行时解析；当仅由 Node 解析包时为 `undefined`。 */
  get resolution(): RuntimeResolution | undefined {
    return this.current
  }

  /**
   * 为本进程以及随后创建的 Worker 发布一个完整的后继代。
   * profile 映射与本地包名可在其插件停止后被移除；链接的根也可被移除。保留的 profile 映射
   * 可以改变其声明者与版本，但不能改变其归一化目录或作用域；安装映射必须保持不变。发布不会
   * 卸载模块或清空 Node 缓存。
   * @param successor - 完全构造好、被 {@link RuntimeInterception.replace} 接受的那一代。
   */
  replace(successor: RuntimeResolution): void {
    if (this.interception === undefined) throw new Error('plugin-packages: runtime resolution is not installed')
    this.interception.replace(successor)
    this.current = successor
    this.packages = new Map()
    this.disposeWorkerResolution?.()
    this.disposeWorkerResolution = registerWorkerResolution(successor)
  }

  /**
   * 发布由已安装解析通过 {@link replace} 计算出的最新代。包内容与已加载的模块不会被重新加载。
   * @throws 当未安装任何解析、它是普通数据而非 {@link ProfileRuntimeResolution}、读取最新文件
   * 失败，或后继代被拒绝时抛出。一个没有 profile 的计算结果解析也可以刷新。
   */
  async refresh(): Promise<void> {
    if (!(this.current instanceof ProfileRuntimeResolution)) {
      throw new Error('plugin-packages: the installed runtime resolution cannot be recomputed')
    }
    this.replace(await this.current.computeLatestResolution())
  }

  /**
   * 在不要求包导出的前提下，定位一个由指示符命名的包。
   * @param specifier - 其包拥有所请求模块的模块指示符。
   * @param parentURL - 适用其 Node 查找顺序的 URL。
   * @returns 已解析的包；当没有任何包拥有该请求时为 undefined。
   */
  packageOf(specifier: string, parentURL: string): PluginPackage | undefined {
    const name = barePackageName(specifier)
    if (name === undefined) return undefined
    const dir = this.interception === undefined
      ? packageDirFromParent(name, parentURL)
      : this.interception.packageDir(name, parentURL)
    if (dir === undefined) return undefined
    const key = JSON.stringify({ dir, name })
    if (!this.packages.has(key)) this.packages.set(key, readPackage(dir, name))
    return this.packages.get(key)
  }

  /**
   * 在不加载或激活目标插件的前提下，读取展示元数据。
   * @param specifier - 已配置的包模块，包括包子路径。
   * @param parentURL - 所属 Loader 树的解析基址。
   * @returns 本地展示元数据或其诊断；对于非包请求或缺失的元数据为 undefined。
   */
  metaOf(specifier: string, parentURL: string): PluginLocalizedMeta | undefined {
    return readPluginMeta(specifier, parentURL)
  }
}

function packageDirFromParent(name: string, parentURL: string): string | undefined {
  for (const searchPath of createRequire(parentURL).resolve.paths(name) as string[]) {
    const candidate = join(searchPath, name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}
