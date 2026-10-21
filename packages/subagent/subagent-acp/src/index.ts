/**
 * 进程外 ACP 子代理后端。每个子代理拥有自己的进程、session、模型与工具，
 * 因此它不共享任何 Cordis 上下文，也不声明任何由父代理强制的启动能力；
 * 子代理 service 提供所捕获的子工作目录。本插件只使用具名导出；默认导出会
 * 隐藏其 loader 元数据（见 `docs/postmortem/0001-acp-default-export-drops-inject.md`）。
 * @module @deepseek-ai/dsh-subagent-acp
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  ResolvedSubagentStartRequest,
  SubagentCapabilities,
  SubagentProvider,
} from '@deepseek-ai/dsh-subagent'
import { assertUsableCwd } from '@deepseek-ai/dsh-subagent'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { acpConfigurationFailure, type AcpRunSpec, DEFAULT_DISPOSE_EOF_GRACE_MS, DEFAULT_DISPOSE_GRACE_MS, type PermissionPolicy, startAcpRun } from './run.ts'

export const name = 'subagent-acp'
export const inject = ['subagents', 'subprocess']

/** 配置：如何 spawn 并驱动子 ACP agent 进程。 */
export interface Config {
  /** `ctx.subagents` 上的提供方名称（默认 `acp`）。 */
  providerName: string
  /** 为每次运行 spawn 的可执行文件（子 ACP agent）。 */
  command: string
  /** 传给 {@link command} 的实参。 */
  args: string[]
  /**
   * 如何自动应答子代理的 `session/request_permission` 提示：
   * `reject`（默认 —— 拒绝每个提示）或 `allow`（通过第一个 `allow_once`
   * 或 `allow_always` 选项批准）。不会把任何提示呈现给人类。
   */
  permission: PermissionPolicy
  /**
   * 子进程的额外环境变量 —— 例如子 harness 自己的 `DEEPSEEK_API_KEY`。
   * 它们被叠加在父 env 的凭据清洗副本之上，因此此处显式的 key 能到达
   * 子代理，而环境里的秘密不会隐式泄漏。
   */
  env: Record<string, string>
  /**
   * 处置时子代理由 EOF 驱动的静默宽限期（ms）—— 在父方升级为信号之前，
   * 它刷写持久化并拆解自身嵌套子进程的时间窗。不得超过
   * `MAX_TIMER_DELAY_MS`。
   */
  disposeEofGraceMs?: number
  /** 失败观测与终止升级的宽限（ms）；不得超过 `MAX_TIMER_DELAY_MS`。 */
  disposeGraceMs?: number
}

export const Config: z<Config> = z.object({
  providerName: z.string().default('acp'),
  command: z.string().required(),
  args: z.array(z.string()).default([]),
  permission: z.union(['allow', 'reject'] as const).default('reject'),
  env: z.dict(z.string()).default({}),
  disposeEofGraceMs: z.number().default(DEFAULT_DISPOSE_EOF_GRACE_MS),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
})

/** 一个进程宽限必须适配每一个观测或终止子代理的 Node 定时器。 */
function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`subagent-acp: ${name} must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}

type ResolvedConfig = Required<Config>

/**
 * ACP 提供方。不声明任何启动期能力：一个进程外的子代理无法兑现
 * `agentOptions`/`agentPreset`/`outputSchema`/`maxDepth`。
 * service 会在执行开始之前拒绝任何需要它们的请求。
 */
class AcpProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = {
    agentOptions: false,
    agentPreset: false,
    outputSchema: false,
    depthLimit: false,
  }
  // 上下文契约：进程外的 ACP 子代理全新启动 —— 没有父对话跨越进程边界。
  readonly inheritsParentContext = false

  constructor(readonly name: string, private readonly ctx: Context, private readonly config: ResolvedConfig) {}

  start(request: ResolvedSubagentStartRequest) {
    if (request.signal.aborted) {
      throw new Error('subagent request was aborted before the ACP child started')
    }
    let cwd: string
    try {
      cwd = assertUsableCwd('subagent-acp', 'child cwd', request.cwd)
    } catch (error: unknown) {
      const failure = acpConfigurationFailure(error)
      this.ctx.logger.warn(`subagent-acp "${this.name}": child start failed: %o`, error)
      throw failure
    }
    const spec: AcpRunSpec = {
      command: this.config.command,
      args: this.config.args,
      cwd,
      permission: this.config.permission,
      env: this.config.env,
      disposeEofGraceMs: this.config.disposeEofGraceMs,
      disposeGraceMs: this.config.disposeGraceMs,
      spawn: spec => this.ctx.subprocess.spawn(spec),
      onError: (error, stopReason) => {
        // 接缝禁止 `result` 拒绝，因此子代理级别的失败被扁平化为一个
        // 停止原因 —— 在此处保留它，而不是丢失它。
        this.ctx.logger.warn(`subagent-acp "${this.name}": child run failed (${stopReason}): ${error.message}`)
      },
    }
    return startAcpRun(request, spec)
  }
}

export function apply(ctx: Context, config: Config): void {
  // schemastery（Config）已经填好了每一个有默认值的字段。
  const resolved = config as ResolvedConfig
  assertPositiveFinite('disposeEofGraceMs', resolved.disposeEofGraceMs)
  assertPositiveFinite('disposeGraceMs', resolved.disposeGraceMs)
  ctx.subagents.registerProvider(new AcpProvider(resolved.providerName, ctx, resolved))
}
