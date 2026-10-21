/**
 * `write` 与 `edit` 工具共享的沙箱提级 API：按次调用的策略解析、被宣示的提级字段，
 * 以及拒绝标记映射 —— 全部把词汇表与"失败即关闭"的批准流程委托给
 * `@deepseek-ai/dsh-sandbox`（也就是 `@deepseek-ai/dsh-tool-bash` 所用的那几块），
 * 因此 bash 与 fs 的提级行为完全一致。每个插件依据 `ctx.fs.sandboxMode`
 * （即"是否挂载了做隔离的后端"这一能力事实）**一次**构建，并由两个修改类工具共享。
 *
 * @module @deepseek-ai/dsh-tool-fs/sandbox
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { ESCALATION_TARGETS, approveEscalation, escalationHintMarker, sandboxDenialMarker, sandboxPermissionsDescription, validateEscalationArgs } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { FsError } from '@deepseek-ai/dsh-fs'

/** 修改类工具可携带的两个提级参数（仅在做隔离的后端下才宣示）。 */
export interface FsEscalationArgs {
  sandbox_permissions?: string
  justification?: string
}

/** 提级参数的模式字段，在挂载了做隔离的后端时被展开进工具的 `parameters`。 */
export interface EscalationSchemaFields {
  sandbox_permissions: { type: 'string'; enum: string[]; description: string }
  justification: { type: 'string'; description: string }
}

/**
 * 文件系统的提级 API：宣示开关、按次调用的策略解析、仅批准一次的更宽模式重试，
 * 以及拒绝标记映射。它是 plugin apply 时刻由 `ctx` 得到的纯产物。
 */
export class FsSandboxController {
  /** 本次组合所宣示的提级目标（未挂载做隔离的后端时为 `[]`）。 */
  readonly escalationModes: readonly SandboxMode[]
  /** 共享的按会话策略解析器，做隔离的后端要求它存在。 */
  private readonly policy: SandboxPolicyService | undefined

  constructor(private readonly ctx: Context) {
    const defaultMode = ctx.fs.sandboxMode
    this.escalationModes = defaultMode === undefined ? [] : ESCALATION_TARGETS
    this.policy = defaultMode === undefined ? undefined : ctx.get('sandboxPolicy')
    if (defaultMode !== undefined && this.policy === undefined) {
      throw new Error('tool-fs: the mounted filesystem confines but ctx.sandboxPolicy is missing')
    }
  }

  /**
   * 修改类工具 `parameters` 里的提级模式字段。仅在挂载了做隔离的后端时调用它
   * （用 {@link escalationModes} 做守卫）；这个 enum 钉住了封闭的目标词汇表，
   * 而严格更宽的检查则在执行时按次调用进行。
   * @returns 两个提级参数的规格说明。
   */
  schemaFields(): EscalationSchemaFields {
    return {
      sandbox_permissions: {
        type: 'string',
        enum: [...this.escalationModes],
        description: sandboxPermissionsDescription('operation'),
      },
      justification: {
        type: 'string',
        description: 'Required with sandbox_permissions: one sentence for the user explaining '
          + 'why this exact file operation needs the wider access. Use the language of the user’s current request.',
      },
    }
  }

  /**
   * 打在本次修改上的策略：一次已批准的提级授权（在任何东西执行之前通过 `ctx.approval`
   * 解析出的、严格更宽的重试），否则是会话的常设模式。重复声明常设模式不需要批准。
   * 工作区根目录是会话原本的目录，缺失时使用部署回退值。先校验提级参数的配对关系。
   * @param toolName - 修改类工具的名称，用于批准审计记录。
   * @param args - 本次调用的提级参数。
   * @param exec - 工具执行上下文（agent、callId、signal）。
   * @returns 要传给修改操作的策略；未做沙箱隔离的后端为 undefined。
   */
  async resolvePolicy(toolName: string, args: FsEscalationArgs, exec: ToolExecution): Promise<SandboxExecutionPolicy | undefined> {
    validateEscalationArgs(args.sandbox_permissions, args.justification)
    const standingPolicy = this.policy?.resolve({ ...exec.agent ? { session: exec.agent.session } : {} })
    if (args.sandbox_permissions === undefined || args.justification === undefined) {
      return standingPolicy
    }
    if (this.escalationModes.length === 0) {
      throw new Error('sandbox_permissions is not available in this composition (no sandboxing filesystem to escalate)')
    }
    const policy = standingPolicy as SandboxExecutionPolicy
    const approvedMode = await approveEscalation(
      { requestedMode: args.sandbox_permissions, justification: args.justification, effectiveMode: policy.mode, subject: 'operation' },
      {
        approver: this.ctx.get('approval'),
        agent: exec.agent,
        callId: exec.callId,
        toolName,
        signal: exec.signal,
      },
    )
    return { ...policy, mode: approvedMode }
  }

  /**
   * 把提供者抛出的错误映射成面向模型的形式：`FS_SANDBOX_DENIED` 变成一个 `FsError`，
   * 其文本是共享的 `[sandbox: …]` 拒绝标记加上同一轮内的提级提示，使策略拒绝读起来与
   * bash 完全一致，**同时**保留结构化的 `FS_SANDBOX_DENIED` 错误码 —— `ToolRuntime`
   * 只对 `HarnessError` 实例填充 `result.error`，因此换成普通 `Error` 会把重试/观察者
   * 所依赖的错误码剥掉。其他错误原样透传。`FS_SANDBOX_DENIED` 只会出现在做隔离的后端下，
   * 而这种后端总会宣示提级字段，所以这里的提示总是适用。
   * @param error - 修改操作抛出的错误。
   * @param policy - 打在本次调用上的策略（在标记里指明模式名）。
   * @returns 要抛出的错误 —— 沙箱拒绝时为带有该标记的 `FsError`，否则为原错误。
   */
  mapError(error: unknown, policy: SandboxExecutionPolicy | undefined): unknown {
    if (!(error instanceof FsError) || error.code !== 'FS_SANDBOX_DENIED') return error
    // FS_SANDBOX_DENIED 只会出现在做隔离的后端下，而它的工具路径总会在修改之前解析出策略。
    const mode = (policy as SandboxExecutionPolicy).mode
    return new FsError(`${sandboxDenialMarker(mode)}\n${escalationHintMarker('operation')}`, 'FS_SANDBOX_DENIED', { cause: error })
  }
}
