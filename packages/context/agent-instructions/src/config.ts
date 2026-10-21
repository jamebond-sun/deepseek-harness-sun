/**
 * 工作区指令发现与渲染的配置归一化。
 *
 * @module @deepseek-ai/dsh-agent-instructions/config
 */

import { relative } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { resolveAgentsHome, resolveDshHome } from '@deepseek-ai/dsh-home-paths'

const DEFAULT_PROJECT_ROOT_MARKERS = ['.git'] as const
const DEFAULT_INSTRUCTION_FILE_CANDIDATES = ['AGENTS.md', 'CLAUDE.md'] as const
const DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES = ['AGENTS.local.md', 'CLAUDE.local.md'] as const
const DEFAULT_MAX_SOURCE_BYTES = 1_048_576
const RESERVED_PATH_SEGMENTS = new Set(['', '.', '..'])

/** 面向用户的、工作区指令加载器配置。 */
export interface Config {
  /** 从当前工作目录向上遍历时，用于标识项目根目录的目录项。 */
  projectRootMarkers?: string[]
  /** 单次渲染基线或动态批次的 UTF-8 字节上限；非正数或非有限值会禁用加载。 */
  maxBytes: number
  /** 从单个指令文件读取的最大 UTF-8 字节数；超出则忽略该文件。 */
  maxSourceBytes?: number
  /**
   * 有序的同目录项目候选；每个存在的文件都会被加载，
   * 同目录内裁剪内容的重复项会折叠到最早的候选上。
   */
  instructionFileCandidates?: string[]
  /**
   * 有序的同目录本地叠加候选，在基础文件之后加载，
   * 沿用相同的按目录裁剪内容去重；为空则禁用叠加层。
   */
  localInstructionFileCandidates?: string[]
}

export const Config: z<Config> = z.object({
  projectRootMarkers: z.array(z.string()).default([...DEFAULT_PROJECT_ROOT_MARKERS]),
  maxBytes: z.number().required(),
  maxSourceBytes: z.number().step(1).min(1).default(DEFAULT_MAX_SOURCE_BYTES),
  instructionFileCandidates: z.array(z.string()).default([...DEFAULT_INSTRUCTION_FILE_CANDIDATES]),
  localInstructionFileCandidates: z.array(z.string()).default([...DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES]),
})

/** 归一化后的指令发现配置。 */
export interface ResolvedDiscoveryConfig {
  dshHome: string
  agentsHome: string
  projectRootMarkers: string[]
  instructionFileCandidates: string[]
  localInstructionFileCandidates: string[]
}

/** 供发现与对账使用的归一化配置。 */
export interface ResolvedConfig extends ResolvedDiscoveryConfig {
  maxBytes: number
  maxSourceBytes: number
}

/**
 * 标识一次基线的发现、优先级与预算语义。
 * @param config - 归一化后的插件配置。
 * @param cwd - 绝对会话工作目录。
 * @param projectRoot - 为当前基线所选的项目根目录。
 * @returns 供恢复时兼容性检查使用的稳定序列化标识。
 */
export function workspaceBaselineIdentity(
  config: ResolvedConfig,
  cwd: string,
  projectRoot: string,
): string {
  return JSON.stringify({
    projectRoot: relative(cwd, projectRoot),
    projectRootMarkers: config.projectRootMarkers,
    maxBytes: config.maxBytes,
    maxSourceBytes: config.maxSourceBytes,
    instructionFileCandidates: config.instructionFileCandidates,
    localInstructionFileCandidates: config.localInstructionFileCandidates,
  })
}

/**
 * 解析行默认值、进程 harness 主目录，以及有效的同目录候选。
 * 未声明的行字段无法覆盖进程主目录。
 * @param config - 面向用户的插件配置。
 * @returns 归一化后的运行时配置。
 */
export function resolveConfig(config: Config): ResolvedConfig {
  return {
    ...resolveDiscoveryConfig({
      ...config.projectRootMarkers === undefined ? {} : { projectRootMarkers: config.projectRootMarkers },
      ...config.instructionFileCandidates === undefined ? {} : { instructionFileCandidates: config.instructionFileCandidates },
      ...config.localInstructionFileCandidates === undefined
        ? {}
        : { localInstructionFileCandidates: config.localInstructionFileCandidates },
    }),
    maxBytes: config.maxBytes,
    maxSourceBytes: config.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES,
  }
}

/**
 * 解析在指令内容被渲染之前所使用的那部分配置。
 *
 * harness 主目录经由进程环境通过 {@link resolveDshHome} 获得；
 * 该行无法将指令加载指向其他 harness 消费者不会共享的第二个根目录。
 * 已解析主目录的拥有者会将它们作为 `dshHome` 与 `agentsHome` 传入，
 * 在此处被归一化，以便发现与对账使用相同的值。
 * @param config - 可选的发现控制项，以及已解析的主目录。
 * @returns 归一化后的主目录、根标记与指令候选。
 */
export function resolveDiscoveryConfig(
  config: Pick<Config, 'projectRootMarkers' | 'instructionFileCandidates' | 'localInstructionFileCandidates'>
    & { dshHome?: string; agentsHome?: string },
): ResolvedDiscoveryConfig {
  return {
    dshHome: resolveDshHome(config.dshHome),
    agentsHome: resolveAgentsHome(config.agentsHome),
    projectRootMarkers: config.projectRootMarkers ?? [...DEFAULT_PROJECT_ROOT_MARKERS],
    instructionFileCandidates: resolveInstructionFileCandidates(
      config.instructionFileCandidates,
      DEFAULT_INSTRUCTION_FILE_CANDIDATES,
    ),
    localInstructionFileCandidates: resolveInstructionFileCandidates(
      config.localInstructionFileCandidates,
      DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES,
    ),
  }
}

/** 解析并过滤指令文件候选，剔除保留路径段与含分隔符的项。 */
function resolveInstructionFileCandidates(candidates: string[] | undefined, fallback: readonly string[]): string[] {
  return (candidates ?? [...fallback]).filter(candidate => (
    !RESERVED_PATH_SEGMENTS.has(candidate) && !/[\\/]/.test(candidate)
  ))
}
