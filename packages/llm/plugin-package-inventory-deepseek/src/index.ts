/**
 * 官方 DeepSeek 请求中由 Loader 支撑的、处于激活状态的插件包清单。
 * 宿主条目与发起请求的 agent 的固定 preset 在请求时解析；
 * 已安装的依赖项，以及没有 Loader 支撑的包身份的插件 fiber，都会被排除。
 * @module @deepseek-ai/dsh-plugin-package-inventory-deepseek
 */

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, parse } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { EntryTree } from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-app-boot'
import type { DeepSeekPluginPackageIdentity, DeepSeekPluginPackageInventoryExtension } from './types.ts'
import type {} from './types.ts'

export type * from './types.ts'

/** Cordis 插件名。 */
export const name = 'plugin-package-inventory-deepseek'
/** 定位宿主/发起请求的 agent 条目并贡献该字段所需的服务。 */
export const inject = ['agents', 'deepseekLlmApiExtensions', 'loader']

/** 插件包请求贡献配置。 */
export interface Config {
  /** 是否为官方 DeepSeek 请求贡献 `dsh_plugin_packages`。默认为 `true`。 */
  enabled?: boolean
}

/** 已校验的插件包请求贡献配置。 */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
})

interface PackageManifest {
  readonly name?: unknown
  readonly version?: unknown
}

interface ActiveEntry {
  readonly moduleName: string
  readonly baseUrl?: string
  /** 激活本条目的 Loader 路径所使用的裸包基准。 */
  readonly bareBaseUrl?: string
}

/** 将裸包或包子路径说明符解析为包名。 */
function barePackageName(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.includes(':') || isAbsolute(specifier)) return undefined
  const [first = '', second = ''] = specifier.split('/')
  // 激活的 Loader 条目已经通过了模块解析，因此带作用域的裸名具备其包段。
  return first.startsWith('@') ? `${first}/${second}` : first
}

/** 读取一个具名身份，仅当版本是非空字符串时才附带版本。 */
function identityFromManifest(path: string): DeepSeekPluginPackageIdentity | undefined {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as PackageManifest
  if (typeof manifest.name !== 'string' || manifest.name.trim().length === 0) return undefined
  return typeof manifest.version === 'string' && manifest.version.trim().length > 0
    ? { name: manifest.name, version: manifest.version }
    : { name: manifest.name }
}

/** 解析一个裸包，且不要求它导出 `./package.json`。 */
function barePackageManifest(
  packageName: string, anchors: readonly string[], packages: Context['pluginPackages'] | undefined,
): string | undefined {
  for (const anchor of anchors) {
    const pkg = packages?.packageOf(packageName, anchor)
    if (pkg !== undefined) return pkg.manifestPath
    if (packages !== undefined) continue
    for (const searchPath of createRequire(anchor).resolve.paths(packageName) as string[]) {
      const manifest = join(searchPath, packageName, 'package.json')
      if (existsSync(manifest)) return manifest
    }
  }
  return undefined
}

/** 为相对或绝对的插件模块查找最近的宿主清单。 */
function nearestManifest(modulePath: string): string | undefined {
  let current = dirname(modulePath)
  const root = parse(current).root
  while (true) {
    const manifest = join(current, 'package.json')
    if (existsSync(manifest)) return manifest
    if (current === root) return undefined
    current = dirname(current)
  }
}

/** 精确的包身份解析器，带有不可变的进程内清单缓存。 */
class PackageIdentityResolver {
  // TODO: 若进程内的包版本替换成为一种受支持的升级路径，则需要让清单身份失效。
  private readonly cache = new Map<string, DeepSeekPluginPackageIdentity | undefined>()

  constructor(
    private readonly hostBaseUrl: string,
    private readonly packages: Context['pluginPackages'] | undefined,
  ) {}

  /** 解析一个 Loader 条目所属的包；对于非包的松散模块则为缺失。 */
  resolve({ moduleName, baseUrl, bareBaseUrl }: ActiveEntry): DeepSeekPluginPackageIdentity | undefined {
    /* v8 ignore next -- Loader 条目树会继承一个 base URL；该回退用于直接嵌入方。 */
    const treeBase = baseUrl ?? this.hostBaseUrl
    const anchors = [...new Set([bareBaseUrl ?? treeBase, treeBase, this.hostBaseUrl, import.meta.url])]
    const key = `${anchors.join('\u0000')}\u0000${moduleName}`
    if (this.cache.has(key)) return this.cache.get(key)

    const packageName = barePackageName(moduleName)
    let manifest: string | undefined
    if (packageName !== undefined) {
      manifest = barePackageManifest(packageName, anchors, this.packages)
      if (manifest === undefined) {
        throw new Error(`plugin-package-inventory-deepseek: cannot resolve active package ${JSON.stringify(packageName)}`)
      }
    } else if (!moduleName.startsWith('cordis:')) {
      const moduleUrl = isAbsolute(moduleName)
        ? pathToFileURL(moduleName)
        : new URL(moduleName, treeBase)
      if (moduleUrl.protocol === 'file:') manifest = nearestManifest(fileURLToPath(moduleUrl))
    }
    const identity = manifest === undefined ? undefined : identityFromManifest(manifest)
    this.cache.set(key, identity)
    return identity
  }
}

/** 从一个 Loader 树中产出处于激活状态的非结构性条目。 */
function activeEntries(tree: EntryTree): ActiveEntry[] {
  return [...tree.entries()]
    .filter(entry => !entry.options.group
      && !entry.disabled
      && entry.fiber?.state === FiberState.ACTIVE)
    .map(entry => ({
      moduleName: entry.options.name,
      ...entry.parent.tree.ctx.baseUrl === undefined ? {} : { baseUrl: entry.parent.tree.ctx.baseUrl },
    }))
}

/** 与宿主的 ICU 数据与区域设置无关的稳定文本顺序。 */
function compareWireText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** 为一次请求收集激活包中可用的身份。 */
function collectActivePluginPackages(
  ctx: Context,
  resolver: PackageIdentityResolver,
  hostBaseUrl: string,
  unreadable: Set<string>,
  sessionId?: string,
): DeepSeekPluginPackageIdentity[] {
  const entries = activeEntries(ctx.loader)
  const presets = ctx.get('agentPresets')
  if (sessionId !== undefined && presets !== undefined) {
    const agent = ctx.agents.get(brandString<SessionId>(sessionId))
    if (agent !== undefined) {
      for (const composition of presets.inspectCompositions(agent.ctx)) {
        entries.push(...composition.modules.map(({ useHostBase, ...entry }) => ({
          ...entry,
          ...useHostBase ? { bareBaseUrl: hostBaseUrl } : {},
        })))
      }
    }
  }
  const unique = new Map<string, DeepSeekPluginPackageIdentity>()
  for (const activeEntry of entries) {
    let identity: DeepSeekPluginPackageIdentity | undefined
    try {
      identity = resolver.resolve(activeEntry)
    } catch (error) {
      if (!unreadable.has(activeEntry.moduleName)) {
        unreadable.add(activeEntry.moduleName)
        ctx.logger.warn('plugin-package-inventory-deepseek: omitting unreadable package identity for %s: %o', activeEntry.moduleName, error)
      }
      continue
    }
    if (identity === undefined) continue
    unique.set(`${identity.name}\u0000${identity.version ?? ''}`, identity)
  }
  return [...unique.values()].sort((left, right) => (
    compareWireText(left.name, right.name) || compareWireText(left.version ?? '', right.version ?? '')
  ))
}

/**
 * 在启用时注册完整的 `dsh_plugin_packages` 请求贡献。
 * @param ctx - 携带 Loader 条目元数据与 DeepSeek 请求扩展注册表的插件上下文。
 * @param config - 已校验的、默认开启的配置。
 */
export function apply(ctx: Context, config: Config): void {
  if (config.enabled === false) return
  const hostBaseUrl = ctx.baseUrl ?? import.meta.url
  const resolver = new PackageIdentityResolver(hostBaseUrl, ctx.get('pluginPackages'))
  // 不可读的身份会在每次请求时重新解析；每个模块只记录一次日志。
  const unreadable = new Set<string>()
  ctx.deepseekLlmApiExtensions.register('dsh_plugin_packages', {
    prepare: (request) => {
      const value: DeepSeekPluginPackageInventoryExtension = {
        version: 1,
        packages: collectActivePluginPackages(ctx, resolver, hostBaseUrl, unreadable, request.sessionId),
      }
      return { value }
    },
  })
}
