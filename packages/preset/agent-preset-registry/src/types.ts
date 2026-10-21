/** agent-preset 领域所拥有的、对客户端安全的载荷与事件声明。 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'


/**
 * 客户端视角下读取到的一个已声明预设。
 */
export interface AgentPresetRow {
  /** 稳定标识符；同时也是标签的回退值。 */
  readonly id: string
  /** 未指定预设的会话是否使用本预设进行组合。 */
  readonly isDefault: boolean
  /** 预设发布的显示名。 */
  readonly name?: string
  /** 用一句话说明该预设的用途。 */
  readonly description?: string
  /** 为何该预设无法组合会话；可用时不存在。 */
  readonly broken?: string
}

/** 某次部署当前提供的名册。 */
export interface AgentPresetRoster {
  /** 当前所有声明，包括激活失败的。 */
  readonly presets: readonly AgentPresetRow[]
}

/** 一个预设已声明的组合，渲染后供阅读。 */
export interface AgentPresetDocument {
  /** 该组合所属的预设。 */
  readonly agentPreset: string
  /** 以条目列表 YAML 形式呈现的已声明子插件列表，包含 `!!js` 表达式。 */
  readonly content: string
  /** 预设发布的显示名。 */
  readonly name?: string
  /** 用一句话说明该预设的用途。 */
  readonly description?: string
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** 没有任何声明提供所请求的身份。 */
    'agent-preset/not-found': { readonly agentPreset: string; readonly available: readonly string[] }
    /** 该 id 不可用、已被占用，或其组合无法安装。 */
    'agent-preset/invalid': { readonly agentPreset: string; readonly reason: string }
    /** 会话的对话已开始，因此其组合已固定。 */
    'agent-preset/locked': { readonly sessionId: SessionId; readonly agentPreset: string }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    agentPreset: string | null
  }
  interface SessionProjectionMap {
    /** Session 运行的预设；当部署不组合任何预设时为 null。 */
    agentPreset: string | null
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * 某个会话把另一个 agent 预设提交进了它的持久化日志。
     * 消费方只应失效那些源自该会话组合的状态。
     * @mode emit
     * @param sessionId - 组合发生变化的会话。
     * @param agentPreset - 本次已提交选择所记录的预设。
     */
    'agent-preset/selected'(sessionId: SessionId, agentPreset: string): void
  }
}

export {}
