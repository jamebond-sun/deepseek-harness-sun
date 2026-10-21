/**
 * 每个强制沙箱的工具族（`@deepseek-ai/dsh-tool-bash`、`@deepseek-ai/dsh-tool-fs`）
 * 共用的升级词汇与编排：严格更宽的阶梯、参数配对校验、面向模型的拒绝/提示
 * 标记，以及 {@link approveEscalation}——在任何东西执行之前，通过用户批准
 * 通道解析 `sandbox_permissions` 请求的有序失败即关闭序列。统一归属可以避免
 * 两个工具族的批准顺序与逐字错误文本各自漂移。
 *
 * 该通道是一个最小的结构化函数形状（{@link EscalationAsk}），而不是批准服务
 * 类型：工具层持有 agent、调用 id 与工具名，它闭包捕获 `ctx.approval.request(...)`
 * 并把该闭包向下传递，因此本包从不依赖批准包或 agent 包。
 *
 * @module dsh-sandbox/escalation
 */

import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { SandboxMode } from './index.ts'

/**
 * 严格更宽表：有效模式为键的那次调用可以升级到哪些模式。在执行时检查，
 * 绝不固化进工具 schema——schema 的枚举是 {@link ESCALATION_TARGETS}，
 * 因为 schema 是注册表全局的，而有效模式是按调用成立的事实。
 */
export const WIDER_MODES: Record<string, readonly SandboxMode[]> = {
  'read-only': ['workspace-write', 'danger-full-access'],
  'workspace-write': ['danger-full-access'],
}

/**
 * 封闭的升级目标词汇——一次调用可能升级到的所有模式（`read-only` 是下限，
 * 没有东西会升级到它）。只要挂载的能力具有限制性就对外宣告：若把枚举裁剪
 * 为"仅比组合的默认值更宽的模式"，那么一个有效模式低于该默认值的会话就会
 * 陷入无路可走（默认值为 `danger-full-access` 时将宣告不出任何目标，而一个
 * 被切换到更窄模式的会话仍然受限、却没有任何可借力的选项）。
 */
export const ESCALATION_TARGETS: readonly SandboxMode[] = ['workspace-write', 'danger-full-access']

/**
 * 校验工具 schema 无法表达的升级参数配对：`sandbox_permissions` 与
 * `justification` 必须成对出现——没有理由的批准请求，或是不驱动任何东西的
 * 理由，都是畸形的请求——且理由必须是非空的一句话。
 * @param sandboxPermissions - 原始的 `sandbox_permissions` 参数（若提供）。
 * @param justification - 原始的 `justification` 参数（若提供）。
 */
export function validateEscalationArgs(sandboxPermissions: string | undefined, justification: string | undefined): void {
  if (sandboxPermissions !== undefined && justification === undefined) {
    throw new Error('invalid escalation: sandbox_permissions requires a justification')
  }
  if (justification !== undefined && sandboxPermissions === undefined) {
    throw new Error('invalid escalation: justification is only valid together with sandbox_permissions')
  }
  if (justification !== undefined && justification.trim().length === 0) {
    throw new Error('invalid justification: expected a non-empty sentence')
  }
}

/**
 * 面向模型的拒绝标记——两个强制族都教给模型、也都上报的同一套词汇，因此
 * 无论是内核拒绝了 bash 的文件效应，还是文件系统提供者的围栏拒绝了一次
 * 变更，模型都能以完全相同的方式识别出策略拒绝。
 * @param mode - 被拒绝的调用所运行的模式。
 * @returns 标记行，与模型看到的完全一致。
 */
export function sandboxDenialMarker(mode: SandboxMode): string {
  return `[sandbox: file access denied under ${mode} mode]`
}

/**
 * 附着在拒绝之上的同回合升级提示，仅当组合宣告了升级字段时出现——把这一
 * 提醒放在决策点上，使得获准的重试不必依赖模型回忆工具描述。
 * @param subject - 该工具族对被拒绝动作的名词（bash 为 `command`，
 *   文件系统变更为 `operation`）。
 * @returns 提示行，与模型看到的完全一致。
 */
export function escalationHintMarker(subject: string): string {
  return `[sandbox: escalation available — retry this exact ${subject} once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]`
}

/**
 * 面向模型的 `sandbox_permissions` 参数描述，承载了每个强制族的升级规则。
 * @param subject - 该工具族对被拒绝动作的名词（bash 为 `command`，
 *   文件系统变更为 `operation`）。
 * @returns 参数描述，与模型看到的完全一致。
 */
export function sandboxPermissionsDescription(subject: string): string {
  return `The narrowest wider sandbox mode for a one-shot retry of the exact ${subject} the sandbox just denied; the retry asks the user for approval.`
}

/**
 * 一次升级请求的封闭结果词汇——结构上与批准接缝的 `ApprovalOutcome` 完全
 * 相同，因此 `ApprovalService.request` 的返回值可直接赋值，本包无需导入它。
 */
export type EscalationOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/**
 * {@link approveEscalation} 所需的最小批准请求形状——结构上就是批准接缝的
 * `ApprovalService`，对 agent 类型 `A` 与调用 id 类型 `C` 泛型化，使本包
 * 可以通过 `ctx.approval` 解析升级而不导入批准包或 agent 包（工具层会把
 * `A`/`C` 推断为它自己的 `Agent`/`ToolCallId`）。
 */
export interface EscalationApprover<A = object, C = string> {
  /**
   * 请求人工批准一次动作，解析为一个封闭结果。
   * @param req - 审计请求，带有可选的本地化 displayReason 与展示期生存信号。
   * @returns 人工的决定，作为封闭的 {@link EscalationOutcome}。
   */
  request(req: {
    agent: A
    toolName: string
    callId: C
    reason: string
    displayReason?: { readonly en: string; readonly [locale: string]: string }
    signal?: AbortSignal
  }): Promise<EscalationOutcome>
}

/**
 * 一个发起升级的工具交给 {@link approveEscalation} 的批准要素：批准请求者
 * （`ctx.approval`，未组合批准能力时为 `undefined`）、发起调用的 agent
 * （无 agent 的执行为 `undefined`），以及本次调用的标识。工具层持有全部
 * 这些要素；本包只做判断。
 */
export interface EscalationApproval<A = object, C = string> {
  /** 批准请求者（`ctx.approval`），未组合批准能力时为 `undefined`。 */
  approver: EscalationApprover<A, C> | undefined
  /** 发起调用的 agent；无 agent 的执行为 `undefined`（失败即关闭）。 */
  agent: A | undefined
  /** 批准提示所附着的工具调用 id。 */
  callId: C
  /** 记录在批准请求上的工具名。 */
  toolName: string
  /** 批准请求所搭载的工具执行中止信号（若存在）。 */
  signal?: AbortSignal
}

/** 一次升级请求，即 {@link approveEscalation} 所判断的对象。 */
export interface EscalationRequest {
  /** 请求的目标模式（对外宣告时被 schema 固定为 {@link ESCALATION_TARGETS}）。 */
  requestedMode: string
  /** 模型给出的一句话理由，在审计理由中原样展示给用户。 */
  justification: string
  /** 本次调用的有效模式（会话覆盖 ?? 组合默认值）；重复它无需批准。 */
  effectiveMode: SandboxMode
  /** 面向用户文本中该工具族对被升级动作的名词（bash 为 `command`，fs 为 `operation`）。 */
  subject: string
}

/**
 * 在执行之前解析一次沙箱权限请求。重复本次调用的有效模式时直接返回它，
 * 无需批准。严格更宽的模式需要批准，且只适用于本次调用。更窄或不受支持的
 * 目标、缺少批准服务或 agent 却要放宽、以及非授予类的结果，都会在执行前
 * 抛出错误。
 * @param request - 待判断的升级请求（见 {@link EscalationRequest}）。
 * @param approval - 工具所持有的批准要素（见 {@link EscalationApproval}）。
 * @returns 获准的模式，由提出请求的这一次调用消费。
 */
export async function approveEscalation<A, C>(request: EscalationRequest, approval: EscalationApproval<A, C>): Promise<SandboxMode> {
  const { requestedMode: mode, effectiveMode, justification, subject } = request
  if (mode === effectiveMode) return effectiveMode
  // 严格放宽是针对本次调用有效模式的执行时检查——刻意不作为 schema 约束
  // （枚举是封闭的目标词汇；有效模式是按调用成立的事实）。
  if (!(WIDER_MODES[effectiveMode] ?? []).includes(mode as SandboxMode)) {
    throw new Error(`sandbox escalation to "${mode}" is not strictly wider than this call's current "${effectiveMode}" mode`)
  }
  if (approval.approver === undefined) {
    throw new Error(`sandbox escalation to "${mode}" requires approval, but no approval service is composed`)
  }
  if (approval.agent === undefined) {
    throw new Error(`sandbox escalation to "${mode}" requires approval, but the call has no agent to route it through`)
  }
  // 自足于审计线索：approval/asked 会保存这一理由，且目标模式本身属于
  // 该次授予身份的一部分。
  const outcome = await approval.approver.request({
    agent: approval.agent,
    toolName: approval.toolName,
    callId: approval.callId,
    reason: `escalate sandbox to ${mode}: ${justification}`,
    displayReason: {
      en: `Allow this operation with ${mode} permissions: ${justification}`,
      zh: `允许本次操作使用 ${mode} 权限：${justification}`,
    },
    ...approval.signal ? { signal: approval.signal } : {},
  })
  switch (outcome) {
    // schema 枚举已把 `mode` 固定到封闭的目标词汇；上面的检查已证明它
    // 严格更宽。
    case 'allowed-once': return mode as SandboxMode
    case 'rejected': throw new Error(`the user rejected escalating this ${subject} to "${mode}"; it stays denied, so stop and explain instead of working around it`)
    case 'cancelled': throw new Error(`approval for escalating to "${mode}" was cancelled`)
    case 'unavailable': throw new Error(`sandbox escalation to "${mode}" requires approval, but no approval channel is available`)
    default: return assertNever(outcome, 'EscalationOutcome')
  }
}
