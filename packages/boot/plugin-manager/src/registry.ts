/**
 * 一次包操作所询问的注册表（按先后顺序），以及一次失败尝试无法抵达的注册表。注册表
 * 通过 pnpm 的 `--registry` 来询问；`null` 是 pnpm 自身配置所命名的那一个。本模块也
 * 在浏览器中运行（通过本包的 `./registry` 入口），因此对话框与 Host 遵循同一条规则。
 * @module @deepseek-ai/dsh-plugin-manager/registry
 */

import type { ParsedInstallSpec } from './install-spec.ts'
import type { PluginInstallFailureKind, PluginRegistries, Registry } from './types.ts'

/** npm 自身的注册表：pnpm 在没有任何配置时所命名的那个，也是一份计划据以信任其为公共注册表的那个。 */
export const OFFICIAL_NPM_REGISTRY = 'https://registry.npmjs.org/'

/** 公共 npmmirror 的 URL，由回退配置与公共注册表比较共享。 */
export const NPMMIRROR_REGISTRY = 'https://registry.npmmirror.com/'

/** 一个 http(s) URL，正如 pnpm 的 `--registry` 所接受的那样。 */
export const REGISTRY_URL = /^https?:\/\/\S+$/

/**
 * 将一个注册表 URL 解析为 pnpm 用来比较注册表的形式：小写的 host、末尾斜杠。
 * @param url - 按配置或请求给出的注册表。
 * @returns 归一化后的 URL。
 * @throws 当给定值不是 http(s) URL 时抛出 {Error}。
 */
export function normalizeRegistry(url: string): string {
  let parsed: URL | undefined
  try { parsed = new URL(url) }
  catch { /* 见下文命名：只有 http(s) URL 才是注册表 */ }
  if (parsed === undefined || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    throw new Error(`a registry must be an http(s) URL: ${url}`)
  }
  if (!parsed.pathname.endsWith('/')) parsed.pathname += '/'
  return parsed.href
}

/**
 * 一次操作所询问的注册表，从第一个到最后一个。
 *
 * 已配置的注册表集合是已配置的第一个注册表及其回退项；请求到的注册表若属于该集合，
 * 则被优先询问，否则单独询问，因此私有注册表绝不会回退到公共注册表。pnpm 自身的
 * 注册表（`null`）只有当它命名的那个被确认是公共的（npm 自身的注册表，或已配置的
 * 回退项之一）时才属于该集合；当它命名的是其它任何内容、或未知时，则被单独询问，而
 * 改为询问的公共注册表也绝不会回退到它。pnpm 自身配置已经命名的注册表只被询问一次。
 * @param requested - 调用方的注册表；为 undefined 时沿用已配置的第一个。
 * @param configured - 已配置的第一个注册表、其后的回退项，以及 pnpm 自身配置所命名的那个。
 * @returns 要询问的注册表，按顺序排列；永不为空。
 */
export function registryPlan(requested: Registry | undefined, configured: PluginRegistries): Registry[] {
  const own = configured.resolved === null ? null : normalizeRegistry(configured.resolved)
  const fallbacks = configured.fallbackRegistries.map(normalizeRegistry)
  const ownIsPublic = own !== null && (own === OFFICIAL_NPM_REGISTRY || fallbacks.includes(own))
  // 注册表被比较时所用的形式：一旦 pnpm 自身注册表所命名的 URL 已知，它便代表该 URL。
  const keyOf = (registry: Registry): string | null => registry === null ? own : normalizeRegistry(registry)
  const known: Registry[] = []
  const keys: (string | null)[] = []
  for (const registry of [configured.registry, ...configured.fallbackRegistries]) {
    if (registry === null && !ownIsPublic) continue
    const key = keyOf(registry)
    if (keys.includes(key)) continue
    known.push(registry === null ? null : normalizeRegistry(registry))
    keys.push(key)
  }
  const first = requested === undefined ? configured.registry : requested
  const firstKey = keyOf(first)
  const normalizedFirst = first === null ? null : normalizeRegistry(first)
  // pnpm 自身那个私有或未知的注册表，无论以何种方式被请求，都单独询问。
  if ((first === null || firstKey === own) && !ownIsPublic) return [normalizedFirst]
  if (!keys.includes(firstKey)) return [normalizedFirst]
  return [normalizedFirst, ...known.filter((_registry, index) => keys[index] !== firstKey)]
}

/** 在此之后的失败可由另一个注册表给出不同答案：这一个不可达，或其副本可能已过期。 */
const NEXT_REGISTRY_KINDS: ReadonlySet<PluginInstallFailureKind> = new Set(['network', 'timeout', 'not-found', 'no-matching-version'])

/** pnpm 或 git 输出中报告失败的一行，区别于警告行或进度行。 */
const ERROR_LINE = /ERR_|ERROR|\berror\b|fatal:|Could not resolve|unable to access|ssh:|\bE[A-Z]{4,}\b/

/**
 * 一次失败尝试无法抵达或无法从中得到答案的对象。
 * @param kind - 该尝试的失败方式。
 * @param log - 该尝试打印的内容。
 * @param spec - 该尝试安装的 spec。
 * @returns 对于可由另一个注册表改变的失败返回 `registry`；当某一行错误点名了 git 或
 *   tarball spec 所拉取自的主机（没有任何注册表可以替代它）时返回 `spec-host`；两者都
 *   无法解释时返回 `other`。
 */
export function attributeFailure(kind: PluginInstallFailureKind, log: string, spec: ParsedInstallSpec): 'registry' | 'spec-host' | 'other' {
  if (!NEXT_REGISTRY_KINDS.has(kind)) return 'other'
  const host = spec.kind === 'git' || spec.kind === 'tarball' ? spec.host?.toLowerCase() : undefined
  if (host === undefined) return 'registry'
  const named = log.split('\n').some(line => ERROR_LINE.test(line) && line.toLowerCase().includes(host))
  return named ? 'spec-host' : 'registry'
}
