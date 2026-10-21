/**
 * DeepSeek Harness 用户数据的共享文件系统路径辅助工具。
 *
 * @module @deepseek-ai/dsh-home-paths
 */

import { opendir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

/** 操作系统主目录下默认 DeepSeek Harness home 的目录名。 */
export const DSH_HOME_DIR_NAME = '.dsh'

/** 默认 DeepSeek Harness home 的稳定、面向用户的显示形式。 */
export const DEFAULT_DSH_HOME_DISPLAY = `~/${DSH_HOME_DIR_NAME}`

/** 覆盖默认 DeepSeek Harness home 的环境变量。 */
export const DSH_HOME_ENV = 'DSH_HOME'

/** 操作系统主目录下默认共享 agent 配置根的目录名。 */
export const AGENTS_HOME_DIR_NAME = '.agents'

/** 默认共享 agent 配置根的稳定、面向用户的显示形式。 */
export const DEFAULT_AGENTS_HOME_DISPLAY = `~/${AGENTS_HOME_DIR_NAME}`

/** 覆盖默认共享 agent 配置根的环境变量。 */
export const AGENTS_HOME_ENV = 'DSH_AGENTS_HOME'

/**
 * 为原生文件系统监视器提供一个路径的唯一规范拼写，即使其最终组成部分
 * 尚不存在。最深层的已存在祖先通过 {@link realpath} 解析；当某个后缀缺失
 * 时，在恢复该后缀之前，也会先证明该祖先是一个可枚举目录。这能防止
 * Windows 将作为父目录的普通文件当作普通的缺失，并防止短名称别名与原生
 * 监视器后端发出的长路径混在一起。
 * @param path - 监视目标或根，相对于当前目录解析。
 * @returns 现有祖先被规范化后的目标。
 * @throws 当祖先遍历遇到除缺失以外的错误，或缺失后缀的现有祖先不是可枚举目录时。
 */
export async function canonicalizeWatchPath(path: string): Promise<string> {
  let current = resolve(path)
  const missing: string[] = []
  while (true) {
    try {
      const canonical = await realpath(current)
      if (missing.length > 0) {
        // Windows 以文件作为父目录的探测会报告 ENOENT。打开已解析的祖先
        // 可保留跨平台的目录要求。
        const directory = await opendir(canonical)
        await directory.close()
      }
      return join(canonical, ...missing.reverse())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(current)
      /* v8 ignore next -- 文件系统根必然存在，因此遍历会在该守卫前就解析完成 */
      if (parent === current) throw error
      missing.push(basename(current))
      current = parent
    }
  }
}

/**
 * 使用 Node 的平台路径规则解析默认的 DeepSeek Harness home。
 * @returns 绝对路径形式的默认 harness home。
 */
export function defaultDshHome(): string {
  return join(homedir(), DSH_HOME_DIR_NAME)
}

/**
 * 使用 Node 的平台路径规则解析默认的共享 agent 配置根。
 * @returns 绝对路径形式的默认共享 agent 配置根。
 */
export function defaultAgentsHome(): string {
  return join(homedir(), AGENTS_HOME_DIR_NAME)
}

/**
 * 根据操作系统主目录展开受支持的波浪号前缀。
 * @param path - 可能以 `~`、`~/`、`~\` 开头的配置路径。
 * @returns 展开后的路径，或当不存在受支持前缀时的原值。
 */
export function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * 由显式路径、环境覆盖和默认值三者中解析一个用户数据根。
 * @param configured - 显式路径，优先级最高。
 * @param env - 待读取的环境映射。
 * @param envName - 覆盖默认值的环境变量。
 * @param fallback - 默认根，当显式路径与环境均未提供时使用。
 * @returns 规范化后的绝对根。
 */
function resolveRoot(
  configured: string | undefined,
  env: Record<string, string | undefined>,
  envName: string,
  fallback: () => string,
): string {
  const fromEnv = env[envName]
  const selected = configured ?? (fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : fallback())
  return resolve(expandHomePath(selected))
}

/**
 * 以符号形式标注一个已解析的用户数据根，用于面向用户的显示。
 * @param resolvedRoot - 匹配解析器返回的绝対路径。
 * @param defaultRoot - 其符号标签适用于匹配的默认绝对根。
 * @param defaultLabel - 默认根的符号标签。
 * @param envName - 用于标注任何其他根的环境变量名。
 * @returns 符号标签。
 */
function rootDisplay(resolvedRoot: string, defaultRoot: string, defaultLabel: string, envName: string): string {
  return resolvedRoot === resolve(defaultRoot) ? defaultLabel : `$${envName}`
}

/**
 * 解析单根的 DeepSeek Harness home。
 *
 * 优先级由高到低：显式配置路径、`$DSH_HOME`，然后 `~/.dsh`。harness 将所有
 * 用户数据置于一个根之下。为空或仅含空白的 `$DSH_HOME` 视为未设置，因此
 * 一个空白覆盖永远不会将 home 解析为当前工作目录。
 * @param configured - 显式 harness home 覆盖，优先级最高。
 * @param env - 用于读取 `DSH_HOME` 的环境映射。
 * @returns 规范化后的绝对 harness home 路径。
 */
export function resolveDshHome(configured?: string, env: Record<string, string | undefined> = process.env): string {
  return resolveRoot(configured, env, DSH_HOME_ENV, defaultDshHome)
}

/**
 * 解析共享 agent 配置根。
 *
 * 优先级由高到低：显式配置路径、`$DSH_AGENTS_HOME`，然后 `~/.agents`。该
 * 根持有与其他 agent 工具共享的配置，因此它独立于 DeepSeek Harness home。
 * 为空或仅含空白的 `$DSH_AGENTS_HOME` 视为未设置，因此一个空白覆盖永远
 * 不会将该根解析为当前工作目录。
 * @param configured - 显式共享根覆盖，优先级最高。
 * @param env - 用于读取 `DSH_AGENTS_HOME` 的环境映射。
 * @returns 规范化后的绝对共享 agent 配置根。
 */
export function resolveAgentsHome(configured?: string, env: Record<string, string | undefined> = process.env): string {
  return resolveRoot(configured, env, AGENTS_HOME_ENV, defaultAgentsHome)
}

/**
 * 将路径段拼接至已解析的 DeepSeek Harness home。
 * @param segments - 追加到 Harness home 之后的路径段；空列表返回 home 本身。
 * @returns 规范化后的绝对拼接路径。
 */
export function dshHomePath(...segments: string[]): string {
  return join(resolveDshHome(), ...segments)
}

/**
 * 将路径段拼接至已解析 Harness home 的 `cache` 目录（不创建它）；无参数时返回该目录本身。
 * @param optionsOrSegment - 显式 home 覆盖，或第一个路径段；省略时使用默认 home 解析。
 * @param segments - 首个子项之后的额外路径段（若有）。
 * @returns 规范化后的绝对缓存路径。
 */
export function dshCachePath(optionsOrSegment: { dshHome?: string } | string = {}, ...segments: string[]): string {
  if (typeof optionsOrSegment === 'string') return dshHomePath('cache', optionsOrSegment, ...segments)
  return join(resolveDshHome(optionsOrSegment.dshHome), 'cache', ...segments)
}

/**
 * 以符号形式描述一个已解析的 harness home，用于面向用户的显示。
 *
 * 它从不返回绝对机器路径：默认 home 标注为 `~/.dsh`，任何已配置的 home
 * 标注为 `$DSH_HOME`。
 * @param resolvedHome - {@link resolveDshHome} 返回的绝対路径。
 * @returns 默认 home 为 `~/.dsh`，否则为 `$DSH_HOME`。
 */
export function dshHomeDisplay(resolvedHome: string): string {
  return rootDisplay(resolvedHome, defaultDshHome(), DEFAULT_DSH_HOME_DISPLAY, DSH_HOME_ENV)
}

/**
 * 以符号形式描述一个已解析的共享 agent 配置根，用于面向用户的显示。
 *
 * 它从不返回绝对机器路径：默认根标注为 `~/.agents`，任何已配置的根标注为
 * `$DSH_AGENTS_HOME`。
 * @param resolvedHome - {@link resolveAgentsHome} 返回的绝対路径。
 * @returns 默认根为 `~/.agents`，否则为 `$DSH_AGENTS_HOME`。
 */
export function agentsHomeDisplay(resolvedHome: string): string {
  return rootDisplay(resolvedHome, defaultAgentsHome(), DEFAULT_AGENTS_HOME_DISPLAY, AGENTS_HOME_ENV)
}
