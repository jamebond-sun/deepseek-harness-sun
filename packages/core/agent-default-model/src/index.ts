/**
 * 未做 session 专属选择时 Agent 的默认模型选择。
 *
 * @module @deepseek-ai/dsh-agent-default-model
 */
import type {} from '@deepseek-ai/dsh-settings'

import type { Volatile } from '@deepseek-ai/cordis'

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-config-editor'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 为未显式指定模型的 Agent 提供的默认模型选择。 */
    agentDefaultModel: AgentDefaultModelConfig
  }
}

/** 由插件配置提供的默认模型选择。 */
export interface Config {
  /** 已注册的 provider 路由。 */
  provider: Volatile<string>
  /** provider 侧的模型 id。 */
  model: Volatile<string>
  /** adapter 侧的推理力度；省略时遵循 provider 默认值。 */
  reasoningEffort: Volatile<string | undefined>
}

/** 将存储的设置映射到面向 Agent 的选择类型。 */
function selection(settings: { provider: string; model: string; reasoningEffort?: string }): ModelSelection {
  return {
    provider: settings.provider,
    model: settings.model,
    ...settings.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(settings.reasoningEffort) },
  }
}

/**
 * 独立于任何 Host 或传输层持有默认模型选择。
 * 每次操作都读取所属 Config 引用。
 */
export class AgentDefaultModelConfig extends Service {
  private saves: Promise<void> = Promise.resolve()

  static Config = z.object({
    provider: z.string().required().volatile(),
    model: z.string().required().volatile(),
    reasoningEffort: z.string().volatile(),
  })

  constructor(private readonly ownerContext: Context, private config: Config) {
    super(ownerContext, 'agentDefaultModel')

    ownerContext.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ownerContext.fiber)) })
  }

  /**
   * 读取当前默认模型选择。
   * @returns 独立的 provider、model 及可选推理力度选择。
   */
  currentSelection(): ModelSelection {
    const reasoningEffort = this.config.reasoningEffort.get()
    return selection({
      provider: this.config.provider.get(), model: this.config.model.get(),
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
    })
  }

  /**
   * 保存完整的默认模型选择。没有配置编辑器的部署保留其组合条目。
   * 保存按提交顺序落盘；一次保存失败只拒绝其调用方，不阻塞后续保存。
   * @param next - 入口点接受的已解析选择。
   * @returns 可选的 profile 写入完成后兑现。
   */
  async saveSelection(next: ModelSelection): Promise<void> {
    const entry = this.ownerContext.fiber.entry
    if (entry === undefined) return
    const editor = this.ctx.get('configEditor')
    if (editor === undefined) return
    const config = {
      provider: next.provider, model: next.model,
      ...next.reasoningEffort === undefined ? {} : { reasoningEffort: String(next.reasoningEffort) },
    }
    const saved = this.saves.then(() => editor.edit(entry, () => config))
    this.saves = saved.catch(() => {})
    await saved
  }
}

export default AgentDefaultModelConfig
