/** 在不导入插件代码的前提下，评估插件的 dsh 要求（`engines.dsh`，否则 dsh peer）。 */

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import semver from 'semver'

/** 未满足的 dsh 要求，以及确切的插件/运行时豁免判定。 */
export interface PluginCompatibility {
  name: string
  version: string
  runtimeVersion: string
  /** 只有运行中 dsh 版本不满足的要求：`engines.dsh`，或 dsh peer 包名。 */
  requirements: Record<string, string>
  exempted: boolean
}

function objectOf(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function runtimeVersionOf(value: unknown): string {
  if (typeof value !== 'string' || semver.valid(value) === null) {
    throw new Error(`Invalid dsh runtime version: ${JSON.stringify(value)}; expected a semantic version`)
  }
  return value
}

function identityField(manifest: Record<string, unknown>, field: 'name' | 'version'): string {
  const value = Object.hasOwn(manifest, field) ? manifest[field] : undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Plugin manifest ${field} must be a non-empty string when dsh requirements are unmet`)
  }
  return value
}

/**
 * 在源码安装与打包安装两种情况下读取本 app-boot 包的版本。
 * @returns 经过校验的运行时语义版本，保留其确切拼写。
 * @throws 当 package.json 无法读取，或其版本缺失或无效时。
 */
export function getDshRuntimeVersion(): string {
  // 可执行文件的虚拟文件系统拦截字符串路径，而非 URL 参数。
  const filename = fileURLToPath(new URL('../package.json', import.meta.url))
  const manifest = objectOf(JSON.parse(fs.readFileSync(filename, 'utf8')), 'app-boot package.json')
  return runtimeVersionOf(Object.hasOwn(manifest, 'version') ? manifest.version : undefined)
}

function satisfies(runtimeVersion: string, range: string): boolean {
  return range.trim() !== '' && semver.satisfies(runtimeVersion, range, { includePrerelease: true })
}

function unmetRequirements(fields: Record<string, unknown>, runtimeVersion: string): Record<string, string> {
  const engines = Object.hasOwn(fields, 'engines') ? objectOf(fields.engines, 'Plugin manifest engines') : {}
  if (Object.hasOwn(engines, 'dsh')) {
    const range = engines.dsh
    if (typeof range !== 'string') throw new Error('Plugin manifest engines.dsh must be a string')
    return satisfies(runtimeVersion, range) ? {} : { 'engines.dsh': range }
  }
  if (!Object.hasOwn(fields, 'peerDependencies')) return {}
  const dependencies = objectOf(fields.peerDependencies, 'Plugin manifest peerDependencies')
  const unmet: Record<string, string> = {}
  for (const [name, range] of Object.entries(dependencies)) {
    if (typeof range !== 'string') {
      throw new Error(`Plugin manifest peerDependencies[${JSON.stringify(name)}] must be a string`)
    }
    if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
    const requirement = ['workspace:^', 'workspace:~', 'workspace:*'].includes(range) ? runtimeVersion : range
    if (!satisfies(runtimeVersion, requirement)) unmet[name] = range
  }
  return unmet
}

/**
 * 检查插件的 dsh 要求是否满足运行时。自身的 `engines.dsh` 范围单独决定，并忽略 peerDependencies；
 * 否则每一个 @deepseek-ai/dsh 或 @deepseek-ai/dsh-* peer 都必须匹配。预发布版本参与范围匹配。
 * 仅就 peer 而言，workspace:^、workspace:~ 与 workspace:* 指代当前运行时；其它空的或无效的范围，
 * 包括任何 workspace: `engines.dsh`，都视为未满足。
 * @param manifest - 已解析的插件 package.json；被继承的字段会被忽略。
 * @param exemptions - 映射到确切运行时版本的、确切的插件 name@version 键。
 * @param runtimeVersion - 运行中的 dsh 版本，默认取本 app-boot 包。
 * @returns 未满足的要求与豁免状态；当每条要求都满足时为 undefined。
 * @throws 当清单的 engines 或 peer 字段畸形、运行时版本无效，或在失配时缺失身份时抛出。
 */
export function evaluatePluginCompatibility(
  manifest: object,
  exemptions: Readonly<Record<string, readonly string[]>> = {},
  runtimeVersion = getDshRuntimeVersion(),
): PluginCompatibility | undefined {
  runtimeVersionOf(runtimeVersion)
  const fields = objectOf(manifest, 'Plugin manifest')
  const requirements = unmetRequirements(fields, runtimeVersion)
  if (Object.keys(requirements).length === 0) return undefined
  const name = identityField(fields, 'name')
  const version = identityField(fields, 'version')
  const key = `${name}@${version}`
  const exemptedVersions = Object.hasOwn(exemptions, key) ? exemptions[key] : undefined
  const exempted = exemptedVersions?.includes(runtimeVersion) === true
  return { name, version, runtimeVersion, requirements, exempted }
}

/**
 * 描述未满足的要求、其风险，以及确切版本的补救办法。
 * 拥有自身授予机制或区域设置的界面会自行渲染结构化结果。
 * @param issue - 不兼容的插件/运行时结果，包括被豁免的不匹配。
 * @returns 一条用于日志与 stderr 的英文诊断。
 */
export function pluginCompatibilityWarning(issue: PluginCompatibility): string {
  const key = `${issue.name}@${issue.version}`
  return `Plugin ${key} is incompatible with dsh ${issue.runtimeVersion}: requirements ${JSON.stringify(issue.requirements)}. `
    + 'Running it may cause crashes or data loss. '
    + 'Update the plugin or install a plugin version compatible with this dsh runtime. '
    + `To accept this risk explicitly, grant the exact-version exemption for ${key} on dsh ${issue.runtimeVersion} with \`dsh plugin allow-version\` or the plugin manager, then retry the installation or restart dsh. `
    + `Exact-version exemption: ${issue.exempted ? 'active' : 'not active'}.`
}
