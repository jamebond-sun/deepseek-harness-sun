/** 包管理器操作之后的、已安装的 profile 依赖及其 bundle 激活状态。 */

import { join } from 'node:path'
import { readProfileManifest, resolveBundleDir, writeProfileManifest, type ProfileManifest } from './profile.ts'

/** 共享 bundle 解析器所使用的 profile 目录与安装。 */
export interface ProfilePluginLocation {
  /** 针对 profile 清单失败的诊断前缀。 */
  readonly binName: string
  /** 由 pnpm 管理的 profile 包目录。 */
  readonly profileDir: string
  /** 所属 dsh 安装的绝对 package.json 路径。 */
  readonly installAnchor: string
}

/** 一条在其包管理器键之下的依赖，包括 npm 别名。 */
export interface ProfilePluginDependency {
  /** 在 package.json 与 bundle 列表中使用的依赖键。 */
  readonly name: string
  /** 已安装的版本；当安装元数据不可用时，为依赖 spec。 */
  readonly version: string
  /** 由 bundle 解析器选中的包是否声明了一个补丁。 */
  readonly bundle: boolean
  /** 该依赖是否出现在 profile 的活动 bundle 列表中。 */
  readonly enabled: boolean
}

/** 按清单顺序排列的 profile 清单与依赖。 */
export interface ProfilePluginInventory {
  readonly manifest: ProfileManifest
  readonly dependencies: readonly ProfilePluginDependency[]
}

/** 一次成功的包操作之后，协调 bundle 激活的结果。 */
export interface ProfilePluginReconciliation {
  readonly plugins: ProfilePluginInventory
  /** 新添加的普通依赖，供可选的、调用方拥有的诊断使用。 */
  readonly addedPlainDependencies: readonly string[]
}

/** 不可用的已安装元数据不得阻止列出或移除依赖。 */
function optionalManifest(binName: string, packageDir: string): ProfileManifest | undefined {
  try { return readProfileManifest(binName, packageDir) } catch { return undefined }
}

/** 以与 profile 加载相同的安装优先级来解析激活元数据。 */
function bundleManifest(location: ProfilePluginLocation, name: string): ProfileManifest | undefined {
  let packageDir: string
  try {
    packageDir = resolveBundleDir(location.binName, name, location.installAnchor, location.profileDir)
  } catch {
    // 一个未解析的依赖仍作为一个普通包保持可见。
    return undefined
  }
  return optionalManifest(location.binName, packageDir)
}

/**
 * 在不要求可加载插件代码的前提下，读取已安装的版本与 bundle 声明。
 * 缺失或不可读的已安装元数据会让依赖保持可见，以便修复或移除。
 * @param location - profile 与安装的解析输入。
 * @returns 按 package.json 顺序排列的依赖记录，以及 profile 清单。
 */
export function readProfilePlugins(location: ProfilePluginLocation): ProfilePluginInventory {
  const manifest = readProfileManifest(location.binName, location.profileDir)
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const dependencies = Object.entries(manifest.dependencies ?? {}).map(([name, spec]) => {
    const installed = optionalManifest(location.binName, join(location.profileDir, 'node_modules', name))
    return {
      name,
      version: typeof installed?.version === 'string' ? installed.version : spec,
      bundle: bundleManifest(location, name)?.dsh?.bundle?.patch !== undefined,
      enabled: bundles.includes(name),
    }
  })
  return { manifest, dependencies }
}

/**
 * 在保留所提供 profile 的其它元数据的前提下，写入一个 bundle 列表。
 * @param profileDir - 其 package.json 被更新的目录。
 * @param manifest - 当前的 profile 清单，在适用时于包操作之后读取。
 * @param bundles - 有序的活动 bundle 名称，包括任何模板条目。
 * @returns 已写入的清单。
 */
export function writeProfileBundles(
  profileDir: string, manifest: ProfileManifest, bundles: readonly string[],
): ProfileManifest {
  const updated = { ...manifest, dsh: { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: [...bundles] } } }
  writeProfileManifest(profileDir, updated)
  return updated
}

/**
 * 一次成功的包管理器操作之后，协调已安装的 bundle 声明。
 * 受依赖管理的条目在被移除、或它们的包失去声明时消失；模板条目保留其顺序与重复项。
 * 新的 bundle 依赖会被自动激活。
 * @param options - 位置、pnpm 之前捕获的清单，以及显式禁用的 bundle 是否保持禁用。
 * @returns 更新后的清单，以及供调用方拥有的警告使用的新增普通依赖。
 */
export function reconcileProfilePlugins(options: ProfilePluginLocation & {
  readonly before: ProfilePluginInventory
  readonly preserveDisabled: boolean
}): ProfilePluginReconciliation {
  const after = readProfilePlugins(options)
  const beforeNames = new Set(options.before.dependencies.map(dependency => dependency.name))
  const afterNames = new Set(after.dependencies.map(dependency => dependency.name))
  const bundleNames = new Set(after.dependencies.filter(dependency => dependency.bundle).map(dependency => dependency.name))
  const disabled = new Set(options.preserveDisabled
    ? options.before.dependencies.filter(dependency => dependency.bundle && !dependency.enabled).map(dependency => dependency.name)
    : [])
  const previous = after.manifest.dsh?.profile?.bundles ?? []
  const bundles = previous.filter(name => !(beforeNames.has(name) || afterNames.has(name)) || bundleNames.has(name))
  for (const dependency of after.dependencies) {
    if (dependency.bundle && !disabled.has(dependency.name) && !bundles.includes(dependency.name)) bundles.push(dependency.name)
  }
  const changed = bundles.length !== previous.length || bundles.some((name, index) => name !== previous[index])
  const manifest = changed ? writeProfileBundles(options.profileDir, after.manifest, bundles) : after.manifest
  return {
    plugins: {
      manifest,
      dependencies: after.dependencies.map(dependency => ({ ...dependency, enabled: bundles.includes(dependency.name) })),
    },
    addedPlainDependencies: after.dependencies.filter(dependency => !dependency.bundle && !beforeNames.has(dependency.name))
      .map(dependency => dependency.name),
  }
}
