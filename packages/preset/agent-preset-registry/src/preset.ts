import type { Volatile } from '@deepseek-ai/cordis'
/** 公开的预设名册与选择配置。 */
/** 一个已声明的预设及其当前的激活失败（若有）。 */
export interface AgentPreset {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly order?: number
  readonly broken?: string
}

/** 注册表的选择策略。 */
export interface Config {
  /** 调用方省略预设时的部署默认值。 */
  default: string
  /** 用户选择的默认值；通过设置编辑。 */
  selectedDefault: Volatile<string | undefined>
}
