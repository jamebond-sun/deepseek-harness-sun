/**
 * 线路安全的授权类型，不含 cordis/service 导入，以便浏览器类型链能够在无需
 * 加载本包 Context 增强的情况下消费它们。
 * @module @deepseek-ai/dsh-authorization/types
 */

import type { CredentialKey } from '@deepseek-ai/dsh-credentials/types'

/** 一个流程获取其凭证的一种方式，以其所提供流程命名。 */
export interface AuthorizationMethod {
  /** 由流程拥有的标识符，调用方选定此方法时回显。 */
  id: string
  /** 面向用户的、用于选择器的标签。 */
  label: string
}

/** 一个运行中的流程向正在观察它的对象所做的报告。绝不包含秘密。 */
export interface AuthorizationNotice {
  /** 正在发生什么，或人类接下来必须做什么。 */
  message: string
  /** 人类为了继续而必须打开的页面。 */
  url?: string
  /** 人类必须在那个页面上输入的一个短代码。 */
  code?: string
}

/** 一个 `select` 提示所提供的一个选项。 */
export interface AuthorizationPromptOption {
  /** 选定此选项时返回的值。 */
  id: string
  /** 面向用户的标签。 */
  label: string
  /** 由能力型界面渲染的可选额外上下文。 */
  description?: string
}

/**
 * 一个流程在继续之前必须得到回答的问题。`secret` 与 `text` 仅在呈现上不同——
 * 界面将其遮掩并排除在日志之外——而 `select` 以所选选项的 `id` 作答。
 */
export type AuthorizationPrompt = {
  /**
   * 仅撤回这一个提示，而让流程继续运行。一个将输入代码与浏览器回调竞速的流程
   * 会在此处中止落败的提示；整个授权则改由请求的 signal 来取消。
   */
  signal?: AbortSignal
} & ({
  kind: 'text'
  message: string
  placeholder?: string
} | {
  kind: 'secret'
  message: string
  placeholder?: string
} | {
  kind: 'select'
  message: string
  options: readonly AuthorizationPromptOption[]
})

/** 一次授权尝试如何结束，以其自身调用方所见为准。 */
export type AuthorizationStatus = 'authorized' | 'cancelled'

/**
 * 一次尝试如何结束，以旁观者所见为准。失败以抛出的错误而非结果到达其调用方，
 * 因此 `failed` 只存在于此——在事件流上，一个没有发起该尝试的观察者没有其他
 * 办法区分“被拒绝”与“出故障”。
 */
export type AuthorizationSettlement = AuthorizationStatus | 'failed'

/** 一次 `begin()` 尝试的结果。 */
export interface AuthorizationOutcome {
  /** 记录被提交并被观测到后为 `authorized`；当人类或调用方撤回时为 `cancelled`。 */
  status: AuthorizationStatus
}

/** 一个已注册流程在界面中所呈现的样子：它所授权的内容，以及它是否正忙。 */
export interface AuthorizationEntry {
  /** 此流程所写入的凭证记录。 */
  key: CredentialKey
  /** 正被授权内容的、面向用户的名称。 */
  label: string
  /** 此流程所提供的方法，按偏好程度从高到低。 */
  methods: readonly AuthorizationMethod[]
  /** 当前是否正有针对此键的尝试在运行。 */
  inFlight: boolean
}
