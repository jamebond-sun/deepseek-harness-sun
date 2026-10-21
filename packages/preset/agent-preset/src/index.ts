/** 普通 Cordis 组合中的一条声明式预设行。 */
import { Context, Service } from '@deepseek-ai/cordis'
import { EntryGroup } from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'

/** 提交给预设注册表的定义。 */
export type Config = PresetDefinition

/** 注册子插件配置，但不持有使用旧版本的 Agent。 */
export default class AgentPreset {
  static inject = ['agentPresets']
  /** 保留子表达式，直到其所属插件自行激活。 */
  static readonly [EntryGroup.key] = true
  static Config: z<Config> = z.object({
    id: z.string().required(),
    name: z.string(),
    description: z.string(),
    order: z.number(),
    // Cordis 负责各自插件的 schema；注册表只校验条目结构。
    plugins: z.array(z.any()).required(),
  }) as z<Config>

  constructor(private readonly ctx: Context, private readonly config: Config) {}

  async* [Service.init]() {
    yield await this.ctx.agentPresets.register(this.config)
  }
}
