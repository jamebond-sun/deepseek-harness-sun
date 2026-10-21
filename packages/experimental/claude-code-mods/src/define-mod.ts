/**
 * `defineMod`：将一个 Claude Code mod 的 `register(on, options)` 包装为 DSH 插件。
 * 挂载该插件会向桥接服务（`ctx.claudeCodeMods`）注册该 mod；卸载则会移除
 * 该 mod 的钩子、定时器与注册项。Mods 按组合顺序加载，即其链顺序。
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ModDefinition, ModRegister, PluginOptions } from './types.ts'

/** 一个组合可以为某个 mod 设置的选项值：即 `userConfig` 的值类型。 */
export type ModConfig = Record<string, string | number | boolean | string[]>

/** 某个 mod 的插件所声明的内容：插件身份与钩子模块的 `register`。 */
export interface ModSpec {
  /** 插件名称，如 `.claude-plugin/plugin.json` 所命名：字母、数字、`_` 与 `-`。 */
  readonly name: string
  readonly version?: string
  /** 该 mod 所内置的绝对目录，由 `$.plugin.root` 报告。 */
  readonly root?: string
  /** `userConfig` 默认值：当组合未设置任何值时，`register` 所收到的 `options`。 */
  readonly userConfig?: PluginOptions
  readonly register: ModRegister
}

/** 一个被包装为 DSH 插件的 mod；其 config 即该 mod 的 `options`。 */
export interface ModPlugin {
  readonly name: string
  readonly inject: readonly string[]
  readonly Config: z<ModConfig>
  /** 桥接服务与测试套件所加载的、以 `userConfig` 作为 options 的 mod。 */
  readonly definition: ModDefinition
  apply(ctx: Context, config: ModConfig): Promise<() => Promise<void>>
}

const optionValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])

/**
 * 将某个 mod 包装为 DSH 插件。
 * @param spec - 该 mod 的身份、`userConfig` 默认值，以及 `register`。
 * @returns 用于 `cordis.yml` 或 `ctx.plugin` 的插件对象；其 `config` 将 `userConfig`
 *   作为 `register` 的 `options` 进行叠加。
 */
export function defineMod(spec: ModSpec): ModPlugin {
  const userConfig: PluginOptions = Object.freeze({ ...spec.userConfig })
  const definition: ModDefinition = Object.freeze({
    name: spec.name,
    ...spec.version === undefined ? {} : { version: spec.version },
    ...spec.root === undefined ? {} : { root: spec.root },
    options: userConfig,
    register: spec.register,
  })
  return {
    name: `claude-code-mod-${spec.name}`,
    inject: ['claudeCodeMods'],
    Config: z.dict(optionValue).default({}),
    definition,
    // 一个抛出异常的 `register` 会使本插件挂载失败，如同任何配置错误的插件一样；
    // 组合中的其余部分继续。
    // 处置器即返回值，即便插件在 `register` 运行期间被移除，Cordis 也会收集它。
    apply(ctx: Context, config: ModConfig): Promise<() => Promise<void>> {
      return ctx.claudeCodeMods.add({ ...definition, options: Object.freeze({ ...userConfig, ...config }) })
    },
  }
}
