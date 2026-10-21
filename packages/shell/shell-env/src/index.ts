/**
 * 与具体工具无关的 shell 环境插件：持有 `ctx.shellEnv` 注册表，登记供面向
 * 模型的 shell 工具（`dsh-tool-bash`、`dsh-tool-pwsh`）使用的、按次执行
 * 且受信任的 `DSH_*` 变量。内置 shell 事实由注册表自身持有，插件则可注册
 * 额外的、可枚举的事实，并随 effect 作用域一并释放。
 *
 * @module @deepseek-ai/dsh-shell-env
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { DSH_ENV_PREFIX } from '@deepseek-ai/dsh-shell'
import type { DshEnvironment, DshEnvironmentKey } from '@deepseek-ai/dsh-shell'
import { DSH_HOME_ENV, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
// 声明 `Context.profileContext`，即内置变量读取的、由启动器提供的 profile。
import type {} from '@deepseek-ai/dsh-app-boot'

declare module '@deepseek-ai/cordis' {
  interface Context {
    shellEnv: ShellEnvRegistry
  }
}

export const name = 'shell-env'
export const inject: string[] = []

/** 插件配置（全部可选——内置事实无需默认值即可解析）。 */
export interface Config {
  /** 以 `DSH_HOME` 暴露的 DeepSeek Harness 主目录；默认为 `$DSH_HOME` 或 `~/.dsh`。 */
  dshHome?: string
}

/** shell-env 插件的运行时配置 schema。 */
export const Config: z<Config> = z.object({
  dshHome: z.string(),
})

/** 单个受管 `DSH_*` 环境变量的模型可见元数据。 */
export interface BashEnvVariable {
  /** 该变量所代表环境事实的简要描述。 */
  description: string
}

/**
 * 插件对每次模型 shell 调用受管环境的一份贡献。声明式的键让归属冲突能在
 * 第一条命令之前就被发现；`resolve` 只计算本次执行可用的值。
 */
export interface BashEnvContributor {
  /** 稳定的贡献者名称，用于诊断与重复检测。 */
  name: string
  /** 该贡献者可能返回的完整 `DSH_*` 键集合。 */
  variables: Readonly<Record<DshEnvironmentKey, BashEnvVariable>>
  /**
   * 为一次工具执行解析该贡献者可用的值。
   * @param execution - 本次 shell 工具执行及其可选的调用方 agent。
   * @returns 仅包含在 {@link variables} 中声明过的键的部分映射。
   */
  resolve(execution: ToolExecution): Readonly<Partial<Record<DshEnvironmentKey, string>>>
}

/** {@link ShellEnvRegistry.list} 返回的可枚举声明。 */
export interface BashEnvVariableInfo extends BashEnvVariable {
  /** 持有该变量的贡献者。 */
  contributor: string
  /** 已声明的 `DSH_*` 环境变量名。 */
  key: DshEnvironmentKey
}

const DSH_SHELL_KEY = `${DSH_ENV_PREFIX}SHELL` as const
const DSH_SESSION_ID_KEY = `${DSH_ENV_PREFIX}SESSION_ID` as const
const DSH_PROFILE_KEY = `${DSH_ENV_PREFIX}PROFILE` as const
const DSH_PROFILE_DIR_KEY = `${DSH_ENV_PREFIX}PROFILE_DIR` as const
const RESERVED_BASH_ENV_KEYS = new Set<DshEnvironmentKey>([
  DSH_HOME_ENV,
  DSH_SHELL_KEY,
  DSH_SESSION_ID_KEY,
  DSH_PROFILE_KEY,
  DSH_PROFILE_DIR_KEY,
])
const BASH_ENV_KEY_SUFFIX = /^[A-Z][A-Z0-9_]*$/

/**
 * 受信任的、按次执行的 `DSH_*` 变量的注册表（`ctx.shellEnv`）。该命名空间
 * 会为每次模型 shell 调用重建：执行器先丢弃进程环境中既有的 `DSH_*` 值，
 * 再注入注册表的当前快照。内置 shell 事实仍由注册表自身持有，插件则可注册
 * 额外的、可枚举的事实，并随 effect 作用域一并释放。
 */
export class ShellEnvRegistry extends Service {
  private readonly contributors = new Map<string, BashEnvContributor>()
  private readonly keyOwners = new Map<DshEnvironmentKey, string>()
  private readonly dshHome: string

  /**
   * 创建并安装 `ctx.shellEnv` 服务。
   * @param ctx - 持有该服务及其注册项的 Cordis context。
   * @param config - 内置变量的主目录配置。
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'shellEnv')
    this.dshHome = resolveDshHome(config.dshHome)
  }

  /**
   * 注册一个环境贡献者。名称与键必须唯一；内置键被保留。该注册会随调用方
   * 插件的 fiber 一同释放。
   * @param contributor - 已声明的键归属与按次执行的解析器。
   * @returns 用于注销该贡献的 disposer。
   */
  register(contributor: BashEnvContributor): () => void {
    const dispose = this.ctx.effect(function* (this: ShellEnvRegistry) {
      if (contributor.name.trim().length === 0) {
        throw new Error('bash env contributor name must be non-empty')
      }
      if (this.contributors.has(contributor.name)) {
        throw new Error(`bash env contributor "${contributor.name}" is already registered`)
      }

      const variables = Object.entries(contributor.variables) as [DshEnvironmentKey, BashEnvVariable][]
      for (const [key, variable] of variables) {
        if (!key.startsWith(DSH_ENV_PREFIX)
          || !BASH_ENV_KEY_SUFFIX.test(key.slice(DSH_ENV_PREFIX.length))) {
          throw new Error(`bash env contributor "${contributor.name}" declared invalid key "${key}"`)
        }
        if (RESERVED_BASH_ENV_KEYS.has(key)) {
          throw new Error(`bash env contributor "${contributor.name}" cannot own reserved key "${key}"`)
        }
        if (variable.description.trim().length === 0) {
          throw new Error(`bash env contributor "${contributor.name}" must describe "${key}"`)
        }
        const owner = this.keyOwners.get(key)
        if (owner !== undefined) {
          throw new Error(`bash env key "${key}" is already owned by contributor "${owner}"; contributor "${contributor.name}" cannot also own it`)
        }
      }

      this.contributors.set(contributor.name, contributor)
      for (const [key] of variables) this.keyOwners.set(key, contributor.name)
      yield () => {
        this.contributors.delete(contributor.name)
        for (const [key] of variables) this.keyOwners.delete(key)
      }
    }.bind(this), 'bashEnv.register()')
    return () => void dispose()
  }

  /**
   * 为一次 shell 工具执行构建受信任的 `DSH_*` 快照。
   * @param execution - 当前的工具执行。
   * @returns 包含内置变量与当前贡献项的不可变环境覆盖层。
   */
  collect(execution: ToolExecution): DshEnvironment {
    const values: Record<DshEnvironmentKey, string> = {
      [DSH_HOME_ENV]: this.dshHome,
      [DSH_SHELL_KEY]: '1',
    }
    if (execution.agent !== undefined) {
      values[DSH_SESSION_ID_KEY] = execution.agent.session.header.id
    }
    const profile = this.ctx.get('profileContext')
    if (profile !== undefined) {
      values[DSH_PROFILE_KEY] = profile.name
      values[DSH_PROFILE_DIR_KEY] = profile.dir
    }

    for (const contributor of [...this.contributors.values()].sort((left, right) => left.name.localeCompare(right.name))) {
      const resolved = contributor.resolve(execution)
      for (const [rawKey, value] of Object.entries(resolved)) {
        const key = rawKey as DshEnvironmentKey
        if (!Object.hasOwn(contributor.variables, key)) {
          throw new Error(`bash env contributor "${contributor.name}" returned undeclared key "${key}"`)
        }
        if (typeof value !== 'string') {
          throw new Error(`bash env contributor "${contributor.name}" returned a non-string value for "${key}"`)
        }
        values[key] = value
      }
    }

    return Object.freeze(Object.fromEntries(Object.entries(values).sort(([left], [right]) => left.localeCompare(right))))
  }

  // TODO(bash-env-list-builtins): 在诊断、提示词或 UI 代码把 list() 当作
  // 详尽的环境目录之前，先纳入注册表自有的内置变量。
  /**
   * 枚举插件贡献的变量，而不执行它们的解析器。
   * @returns 按环境变量名排序的声明。
   */
  list(): BashEnvVariableInfo[] {
    return [...this.contributors.values()]
      .flatMap(contributor => Object.entries(contributor.variables).map(([key, variable]) => ({
        contributor: contributor.name,
        description: variable.description,
        key: key as DshEnvironmentKey,
      })))
      .sort((left, right) => left.key.localeCompare(right.key))
  }
}

/**
 * 加载 shell-env 插件：注册 `ctx.shellEnv` 注册表服务。
 * @param ctx - 持有该服务及其注册项的 Cordis context。
 * @param config - 内置变量的主目录配置。
 */
export function apply(ctx: Context, config: Config = {}): void {
  new ShellEnvRegistry(ctx, config)
}
