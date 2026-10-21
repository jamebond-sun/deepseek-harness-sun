/**
 * 作为可组合行存在的、per-agent 的 persona。
 *
 * `dsh-system-prompt` 把全局 persona 作为自身配置持有，并无条件注册该段落——
 * 因此本行**仅限作用域内使用**。挂载在 agent 预设内部时，它会为那一个会话
 * 遮蔽部署级 persona，正像 `dsh-subagent` 安装的 per-child persona 那样；
 * 全局挂载则会与注册表的自身注册冲突并显式报错。
 *
 * 正是这一约束造就了本行。agent 预设无法挂载提示词注册表本身，
 * 因此若没有属于自己的行，预设只能改变 agent 的工具，却永远无法改变它的身份。
 * @module @deepseek-ai/dsh-persona
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { PERSONA_PREFIX_SECTION, PERSONA_SUFFIX_SECTION } from '@deepseek-ai/dsh-system-prompt'

export { PERSONA_PREFIX_SECTION, PERSONA_SUFFIX_SECTION }

/** Cordis 插件名。 */
export const name = 'persona'

/** 本行所贡献到的提示词注册表。 */
export const inject = ['systemPrompt']

/** 插件配置：本组合所贡献的 persona 文本。 */
export interface Config {
  /**
   * 渲染为 `deployment:persona-prefix` 段落的 persona 文本。这是一个模板：
   * 完整的 `{{…}}` 分组会严格按已注册的提示词变量插值。
   * 文本为空时渲染阶段丢弃该段落，与注册表行为一致。
   */
  prefix: string
  /**
   * 渲染在第一方指引之后的 persona 后缀模板。省略或为空的文本
   * 会把部署级后缀遮蔽掉；插值同样严格。
   */
  suffix?: string
  /** 让 prefix 成为完整的系统提示词，抑制后缀及所有其他段落。 */
  complete?: boolean
  /** 抑制该 persona 所属 agent 作用域内的动态运行时上下文快照。 */
  includeRuntimeContext?: boolean
}

/** persona 行的运行时 schema。 */
export const Config: z<Config> = z.object({
  prefix: z.string().required(),
  suffix: z.string().default(''),
  complete: z.boolean().default(false),
  includeRuntimeContext: z.boolean().default(true),
})

/**
 * 为挂载上下文所在的作用域注册 persona 前缀与后缀段落。
 * @param ctx - agent 作用域上下文；未限定作用域的上下文会与提示词注册表
 * 自身的 persona 注册冲突并被拒绝。
 * @param config - 前缀、后缀以及完整提示词策略。
 */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.systemPrompt.section({
    name: PERSONA_PREFIX_SECTION,
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
    text: config.prefix,
    ...(config.complete ? { complete: true } : {}),
  }), 'persona.section()')
  ctx.effect(() => ctx.systemPrompt.section({
    name: PERSONA_SUFFIX_SECTION,
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
    text: config.suffix ?? '',
  }), 'persona.suffix()')
  if (!(config.includeRuntimeContext ?? true)) ctx.systemPrompt.suppressRuntimeContext()
}
