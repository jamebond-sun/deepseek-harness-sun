/**
 * 记录每个值由哪个层级提供的、不可变的启动时环境快照。Harness 消费方通过它
 * 而非扁平化的 `process.env` 来解析；启动器仍可为配置表达式与第三方库物化
 * 被接受的值。
 * @module @deepseek-ai/dsh-launch-environment
 */

import type { Context } from '@deepseek-ai/cordis'

/**
 * 一个值由哪个层级提供，从最可信到最不可信：本进程继承的环境、调用方目录的
 * `.env`、Harness home 的 `.env`。
 */
export type LaunchEnvironmentSource = 'process' | 'project-env' | 'user-env'

/** 层级顺序，最可信者在前。 */
const SOURCE_ORDER: readonly LaunchEnvironmentSource[] = ['process', 'project-env', 'user-env']

/** 一个已解析的变量及其来源层级。 */
export interface LaunchEnvironmentEntry {
  /** 层级所提供的值；可能为空，由各所有者自行判断。 */
  value: string
  /** 提供它的层级。 */
  source: LaunchEnvironmentSource
  /** 提供它的那个文件的绝对路径；`process` 时缺席。 */
  path?: string
}

/**
 * 某次启动的冻结环境。通过 {@link createLaunchEnvironmentSnapshot} 构造；之后
 * 没有任何东西变更它，因此后续的 `chdir`、工作区切换或恢复出的会话，都会
 * 观察到消费方在启动时解析的相同值。
 */
export interface LaunchEnvironmentSnapshot {
  /**
   * 跨每个层级解析一个名称，最可信者优先。
   * @param name - 变量名。
   * @returns 胜出的条目，或当没有层级提供时返回 `undefined`。
   */
  get(name: string): LaunchEnvironmentEntry | undefined
  /**
   * 仅从 `sources` 中解析一个名称，保持规范可信顺序；被省略的层级不可达。
   * @param name - 变量名。
   * @param sources - 允许出现的层级，按规范可信顺序排列。
   * @returns 第一个匹配条目，或 `undefined`。
   */
  getFrom(name: string, sources: readonly LaunchEnvironmentSource[]): LaunchEnvironmentEntry | undefined
}

/**
 * 一个变量名据以解析的映射键。Windows 对环境变量名大小写不敏感；其他平台则
 * 不然。
 * @param name - 所书写的变量名。
 * @returns 用于存储与查找的键。
 */
function lookupKey(name: string): string {
  /* v8 ignore next -- 原生 Windows 覆盖会执行折叠分支；POSIX 覆盖精确分支 */
  return process.platform === 'win32' ? name.toUpperCase() : name
}

/** 一个层级的原始内容，即 {@link createLaunchEnvironmentSnapshot} 所接收者。 */
export interface LaunchEnvironmentLayerInput {
  source: LaunchEnvironmentSource
  /** 该层级背后文件的绝对路径；`process` 时省略。 */
  path?: string
  values: Readonly<Record<string, string>>
}

/**
 * 由每个层级的内容构建快照。
 * @param layers - 任意顺序的层级；结果按规范可信顺序搜索它们。
 * @returns 不可变快照。
 */
export function createLaunchEnvironmentSnapshot(layers: readonly LaunchEnvironmentLayerInput[]): LaunchEnvironmentSnapshot {
  // 复制每个层级，以确保后续变更无法改变快照。在 Windows 上折叠名称，使大小写
  // 变体不会分裂优先级；POSIX 保持精确。
  const bySource = new Map<LaunchEnvironmentSource, { path?: string; values: Map<string, string> }>()
  for (const layer of layers) {
    bySource.set(layer.source, {
      ...layer.path === undefined ? {} : { path: layer.path },
      values: new Map(Object.entries(layer.values).map(([name, value]) => [lookupKey(name), value])),
    })
  }
  const getFrom = (name: string, sources: readonly LaunchEnvironmentSource[]): LaunchEnvironmentEntry | undefined => {
    const key = lookupKey(name)
    for (const source of SOURCE_ORDER) {
      if (!sources.includes(source)) continue
      const layer = bySource.get(source)
      const value = layer?.values.get(key)
      if (value === undefined) continue
      return { value, source, ...layer?.path === undefined ? {} : { path: layer.path } }
    }
    return undefined
  }
  return {
    get: name => getFrom(name, SOURCE_ORDER),
    getFrom,
  }
}

/** 启动器在任一配置条目挂载前，用本次运行的快照填充的 Context 槽位。 */
export const DSH_LAUNCH_ENVIRONMENT_KEY = 'launchEnvironment'

/**
 * 返回启动器的快照，或当 host 未提供时，以继承的环境作为唯一层级。
 * @param ctx - 消费方插件的上下文。
 * @returns 据以解析面向用户值的快照。
 */
export function launchEnvironmentOf(ctx: Context): LaunchEnvironmentSnapshot {
  return ctx.get(DSH_LAUNCH_ENVIRONMENT_KEY)
    ?? createLaunchEnvironmentSnapshot([{ source: 'process', values: process.env as Record<string, string> }])
}

/**
 * 从启动时继承的非空 SSH_CONNECTION 或 SSH_TTY 检测 SSH。项目与用户的 `.env`
 * 值永远不会建立起一个 SSH 会话。
 * @param environment - 启动器的环境快照。
 * @returns 继承的进程层是否带有任一 SSH 标记。
 */
export function launchedThroughSsh(environment: LaunchEnvironmentSnapshot): boolean {
  return ['SSH_CONNECTION', 'SSH_TTY'].some((name) => {
    const value = environment.getFrom(name, ['process'])?.value
    return value !== undefined && value !== ''
  })
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 启动器拥有的、本次运行环境的快照；在产品 CLI 未启动的组合中缺席。 */
    launchEnvironment?: LaunchEnvironmentSnapshot
  }
}
