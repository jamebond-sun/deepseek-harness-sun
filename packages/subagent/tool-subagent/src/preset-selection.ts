/** 一个委托工具的、由部署拥有的预设选择。 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'

/** 一个 spawn 工具的可选默认值与可选模型的预设 id。 */
export interface PresetSelectionConfig {
  /** 默认独立预设；当模型未做选择时，省略则继承父代理。 */
  agentPreset?: string
  /** 向模型暴露 `agent_preset` 的非空允许名单；省略则禁用模型选择。 */
  allowedAgentPresets?: string[] | undefined
}

/** 来自模型/工具 JSON 的、不受信任的预设选择。 */
export interface PresetSelectionRequest {
  readonly agent_preset?: unknown
}

/** 校验已配置的引用，并针对允许名单解析模型输入。 */
export class SubagentPresetSelection {
  private descriptions: string[] = []

  constructor(private readonly config: PresetSelectionConfig) {
    const { agentPreset, allowedAgentPresets } = config
    if (allowedAgentPresets === undefined) return
    if (new Set(allowedAgentPresets).size !== allowedAgentPresets.length) {
      throw new Error('tool-subagent: allowedAgentPresets contains duplicate preset ids')
    }
    if (agentPreset !== undefined && !allowedAgentPresets.includes(agentPreset)) {
      throw new Error('tool-subagent: agentPreset must be included in allowedAgentPresets')
    }
  }

  /** 本工具是否需要预设服务与一个独立组合的提供方。 */
  get configured(): boolean {
    return this.config.agentPreset !== undefined || this.config.allowedAgentPresets !== undefined
  }

  /** 在模型参数中声明的预设 id。 */
  get choices(): readonly string[] | undefined {
    return this.config.allowedAgentPresets
  }

  /** 模型可见的选择指引与已配置预设的描述。 */
  get description(): string {
    const fallback = this.config.agentPreset === undefined
      ? 'Omit to inherit the parent agent\'s current preset.'
      : `Omit to use ${this.config.agentPreset}.`
    return `Agent preset for this child. ${fallback}`
      + (this.descriptions.length === 0 ? '' : ` Available presets: ${this.descriptions.join('; ')}`)
  }

  /**
   * 在发布工具之前读取已配置的预设声明；挂载会校验它们的激活。
   * @param ctx - 包含预设服务的工具组合。
   */
  async validate(ctx: Context): Promise<void> {
    const presets = ctx.get('agentPresets')
    if (presets === undefined) throw new Error('tool-subagent: agent preset selection requires the agent-presets service')
    const ids = new Set([
      ...this.config.agentPreset === undefined ? [] : [this.config.agentPreset],
      ...this.config.allowedAgentPresets ?? [],
    ])
    const descriptions: string[] = []
    for (const id of ids) {
      const preset = await presets.readDocument(id)
      if (this.choices?.includes(id) && preset.description !== undefined) {
        descriptions.push(`${id}: ${preset.description}`)
      }
    }
    this.descriptions = descriptions
  }

  /**
   * 对继承对话历史或缺乏支持的提供方拒收独立选择。
   * @param provider - 当前已注册的委托提供方。
   */
  assertProvider(provider: SubagentProvider): void {
    if (this.configured && (!provider.capabilities.agentPreset || provider.inheritsParentContext)) {
      throw new Error(`tool-subagent: provider "${provider.name}" does not support independent agent preset selection`)
    }
  }

  /**
   * 校验模型输入并应用部署默认值。
   * @param request - 模型提供的工具实参。
   * @returns 选中的预设 id，或省略以继承父代理。
   */
  resolve(request: PresetSelectionRequest): string | undefined {
    const id = request.agent_preset
    if (id === undefined) return this.config.agentPreset
    if (this.choices === undefined) throw new Error('agent_preset selection is disabled for this tool instance')
    if (typeof id !== 'string' || !this.choices.includes(id)) {
      throw new Error(`agent_preset must be one of: ${this.choices.join(', ')}`)
    }
    return id
  }
}
