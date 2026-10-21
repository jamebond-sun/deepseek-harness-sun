/** 在任何 Cordis 插件加载之前即可读取的、profile 本地的兼容性许可。 */
import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'semver'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { getDshRuntimeVersion } from './plugin-compatibility.ts'

/** 独立的 profile 元数据；包清单与 Cordis 补丁都不承载授予。 */
export const PROFILE_COMPATIBILITY_FILENAME = 'compatibility.json'

/** 已发布与带 scope 的 npm 包名，正如 npm 在清单依赖键中接受它们的形式。 */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

/** 一条已解码的记录是否只接受确切的 DSH 版本。 */
function isVersionList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(version => typeof version === 'string' && isExactPluginVersion(version))
}

/** 测试一条豁免是否命名了一个规范的精确 SemVer，包含构建元数据。
 * @param value 由清单或用户提供的版本。
 * @returns 对于范围、前缀、空白与畸形版本为 false。
 */
export function isExactPluginVersion(value: string): boolean {
  const parsed = parse(value)
  return parsed !== null && value === `${parsed.version}${parsed.build.length === 0 ? '' : `+${parsed.build.join('.')}`}`
}

/** 在不授予的前提下，校验一条显式豁免。
 * @param packageVersion 确切的 npm package-name@version，绝不是一个安装 spec 或范围。
 * @param runtimeVersion 确切的 DSH 版本，包含预发布与构建元数据。
 * @throws 当任一身份不规范时。
 */
export function validatePluginVersionExemption(packageVersion: string, runtimeVersion: string): void {
  const separator = packageVersion.lastIndexOf('@')
  if (separator <= 0 || !PACKAGE_NAME.test(packageVersion.slice(0, separator))
    || !isExactPluginVersion(packageVersion.slice(separator + 1)) || !isExactPluginVersion(runtimeVersion)) {
    throw new Error('Version exemptions require an exact npm package-name@version and an exact DSH runtime version')
  }
}

/** 一个 profile 的兼容性文件当前所授权的内容，以及它的问题所在。 */
export interface ProfileCompatibility {
  /** 已接受的、映射到其被允许 DSH 版本的精确 package-name@version 键。 */
  readonly exemptions: Record<string, string[]>
  /** 人类可读的问题；当每条记录都被接受时为空。 */
  readonly warnings: string[]
  /**
   * 该文件是否不包含任何被本读取器拒绝的内容，从而可被授予或撤销操作重写。
   * 值为 false 意味着写入会丢弃用户必须手工修复的内容。
   */
  readonly rewritable: boolean
}

/** 在不加载插件的前提下，读取该 profile 独立的兼容性文件。
 * 缺失的文件不授权任何内容。不可读或无法解析的文件也不授权任何内容，并且会被报告而非
 * 导致失败，因此一个坏文件绝不会让 profile 无法使用；被拒绝的记录会被跳过，而其余有效
 * 记录仍然适用。
 * @param profileDir 绝对的 profile 目录。
 * @returns 已接受的豁免，加上发现的每一个问题；不会使用清单回退。
 */
export function readProfileCompatibility(profileDir: string): ProfileCompatibility {
  const filename = join(profileDir, PROFILE_COMPATIBILITY_FILENAME)
  const unreadable = (reason: string): ProfileCompatibility =>
    ({ exemptions: {}, warnings: [`${filename} ${reason}; treating the profile as having no exemptions`], rewritable: false })
  let text: string
  try { text = readFileSync(filename, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exemptions: {}, warnings: [], rewritable: true }
    return unreadable(`cannot be read (${String(error)})`)
  }
  let value: unknown
  try { value = JSON.parse(text) }
  catch (error) { return unreadable(`is not valid JSON (${String(error)})`) }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return unreadable('must map exact package@version keys to DSH version lists')
  }
  const exemptions: Record<string, string[]> = {}
  const warnings: string[] = []
  for (const [key, versions] of Object.entries(value as Record<string, unknown>)) {
    const separator = key.lastIndexOf('@')
    if (separator <= 0 || !PACKAGE_NAME.test(key.slice(0, separator)) || !isExactPluginVersion(key.slice(separator + 1))) {
      warnings.push(`${filename}: ${JSON.stringify(key)} is not an exact package-name@version key; the record is ignored`)
      continue
    }
    if (!isVersionList(versions)) {
      warnings.push(`${filename}: ${key} must contain a list of exact DSH versions; the record is ignored`)
      continue
    }
    exemptions[key] = versions
  }
  return { exemptions, warnings, rewritable: warnings.length === 0 }
}

/** 只读取一个 profile 已接受的豁免。
 * @param profileDir 绝对的 profile 目录。
 * @returns 映射到其被允许 DSH 版本的精确 package-name@version 键。
 */
export function readProfileVersionExemptions(profileDir: string): Record<string, string[]> {
  return readProfileCompatibility(profileDir).exemptions
}

/** 在兼容性文件自身的锁之下，持久化一次知情的授予或撤销。
 * @param profileDir profile 目录；不会创建或修改任何包清单。
 * @param packageVersion 确切的清单 package-name@version。
 * @param runtimeVersion 确切的 DSH 版本；授予必须指明当前运行时，撤销可指明历史运行时。
 * @param enabled 是要授予而非撤销。
 * @param acceptRisk 在明确承认可能的崩溃或数据丢失后，授予时必须为 true。
 * @returns 原子写入之后。本操作不会重新加载已存在的插件实例。
 * @throws 当身份无效、缺少同意、运行时过期，或被读取器拒绝的文件（用户必须手工修复，
 * 因为重写它会丢弃其内容）时抛出。
 */
export async function setProfileVersionExemption(
  profileDir: string, packageVersion: string, runtimeVersion: string, enabled: boolean, acceptRisk: boolean,
): Promise<void> {
  validatePluginVersionExemption(packageVersion, runtimeVersion)
  if (enabled && !acceptRisk) {
    throw new Error('Incompatible plugins may cause crashes or data loss. To grant this exact-version exemption, explicitly acknowledge the risk with --accept-risk (acceptRisk: true).')
  }
  const current = getDshRuntimeVersion()
  if (enabled && runtimeVersion !== current) {
    throw new Error(`Cannot approve DSH ${runtimeVersion}: this application runs DSH ${current}. Use --dsh-version ${current}.`)
  }
  await mkdir(profileDir, { recursive: true })
  const filename = join(profileDir, PROFILE_COMPATIBILITY_FILENAME)
  await withFileLock(filename, async () => {
    const current = readProfileCompatibility(profileDir)
    if (!current.rewritable) {
      throw new Error(`${PROFILE_COMPATIBILITY_FILENAME} must be repaired before exemptions change:\n${current.warnings.join('\n')}`)
    }
    const exemptions = current.exemptions
    const versions = exemptions[packageVersion] ?? []
    if (enabled) exemptions[packageVersion] = [...new Set([...versions, runtimeVersion])]
    else {
      const retained = versions.filter(version => version !== runtimeVersion)
      if (retained.length) exemptions[packageVersion] = retained
      else Reflect.deleteProperty(exemptions, packageVersion)
    }
    await writeFileAtomic(filename, JSON.stringify(exemptions, undefined, 2) + '\n', { mode: 0o600 })
  })
}
