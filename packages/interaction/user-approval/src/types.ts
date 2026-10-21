/**
 * 与传输格式无关的审批标识符与结果词汇表，不含 cordis/service 依赖，因此浏览器侧的
 * 类型链条无需加载本包的 Context 增强即可使用它们。
 * @module @deepseek-ai/dsh-user-approval/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent/types'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'

/**
 * 把一条 `approval/asked` 审计事件与它的 `approval/decided` 配对。
 * 由服务签发（每次 {@link ApprovalService.request} 调用铸造一个新 id）。
 */
export type ApprovalRequestId = Branded<'ApprovalRequestId'>

/**
 * 给字符串标上 {@link ApprovalRequestId} brand。
 * @param id - 要打 brand 的原始 id 字符串。
 * @returns 带上该 brand 的原字符串。
 */
export function ApprovalRequestId(id: string): ApprovalRequestId {
  return id as ApprovalRequestId
}

/**
 * 封闭的审批结果集合：一次性放行、明确拒绝、请求被撤回，或没有可用的回答方。
 * 调用方在遇到 `unavailable` 时按失败关闭处理。
 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * 有一个审批问题被交给回答方链 —— 仅落日志的审计事件（与 `hook/*` 类似；
     * 不是可见面事件，不携带 `surfaceOp`）。`id` 把它与必定紧随其后的
     * `approval/decided` 配对；`toolName` 是该问题所针对的工具，`callId` 是提问方
     * 持有时的那个精确工具调用，`reason` 是提问方给出的、给人看的解释
     * （例如某个 hook 的权限判定理由）。
     */
    'approval/asked': {
      id: ApprovalRequestId
      toolName: string
      callId?: ToolCallId
      reason?: string
    }
    /**
     * 此前某条 `approval/asked`（同一个 `id`）的结果 —— 仅落日志的审计事件。
     * 每次提问恰好有一条，在结果已知时追加：一个决策、一次取消，或者失败关闭的
     * `'unavailable'`。
     */
    'approval/decided': {
      id: ApprovalRequestId
      outcome: ApprovalOutcome
    }
  }
}

/** 为审批回答方 waterfall 声明的、Client 安全的载荷。 */
export interface ApprovalRequestEvent {
  /** 在传输过程中被投影到对应 Client Context 的 agent 身份。 */
  readonly agent: Agent
  /** 其操作需要被裁决的工具。 */
  readonly toolName: string
  /** 正在被裁决的那个精确工具调用，若存在的话。 */
  readonly callId?: ToolCallId
  /** 提问方给出的人类可读理由。 */
  readonly reason?: string
  /** 仅用于本地化呈现；永不持久化到审批审计事件里。 */
  readonly displayReason?: { readonly en: string; readonly [locale: string]: string }
  /** 该待处理请求的取消生命周期。 */
  readonly signal?: AbortSignal
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * 请各已组合的回答方给出一个裁决。返回一个结果即认领该请求，调用 `next()`
     * 即向下委派。作用域过滤分派（`@deepseek-ai/dsh-scope`）：agent 作用域的监听器
     * 只收到该 agent 的请求。
     * @param req - 待处理的审批请求。
     * @mode waterfall
     */
    'approval/request'(
      this: Scoped<Agent>,
      req: ApprovalRequestEvent,
      next: () => Promise<ApprovalOutcome>,
    ): Promise<ApprovalOutcome>
  }
}
