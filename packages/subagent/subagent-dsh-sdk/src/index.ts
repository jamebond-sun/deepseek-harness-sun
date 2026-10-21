/**
 * 进程外 SDK 子代理后端。每个子代理都是自己进程中的一个完整 DeepSeek
 * Harness 运行时 —— 拥有自己的具名 profile 与 patch 组合、session、模型路由
 * 与工具 —— 通过 TypeScript SDK 客户端经由 stdio JSON-RPC 驱动，因此它不共享
 * 任何 Cordis 上下文。它接受 `agentOptions` 中的
 * provider/model/reasoning/maxTokens 子集；其他启动特性仍不受支持。子代理
 * 保留其父代理的 origin 目录，同时在由子代理 service 选定的目录中启动。
 * 本插件只使用具名导出；默认导出会隐藏其 loader 元数据（见
 * `docs/postmortem/0001-acp-default-export-drops-inject.md`）。
 * @module @deepseek-ai/dsh-subagent-dsh-sdk
 */

import type { Context } from '@deepseek-ai/cordis'
import { statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { SubagentCapabilities, SubagentProvider, ResolvedSubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { assertPositiveFinite, NO_START_CAPABILITIES, assertUsableCwd } from '@deepseek-ai/dsh-subagent'
import {
  DEFAULT_DISPOSE_EOF_GRACE_MS,
  DEFAULT_DISPOSE_GRACE_MS,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  sdkConfigurationFailure,
  startSdkRun,
  type SdkRunSpec,
} from './run.ts'

export const name = 'subagent-dsh-sdk'
export const inject = ['subagents']

/** 配置：如何 spawn 并驱动子 SDK 运行时进程。 */
export interface Config {
  /** `ctx.subagents` 上的提供方名称（默认 `dsh-sdk`）。 */
  providerName: string
  /** 显式 dsh CLI 模块，在插件加载时解析并检查；省略则使用 SDK 依赖。 */
  dshBin?: string
  /** 具名子 profile（默认 `sdk`）。 */
  profile: string
  /** 按启动顺序排列的 profile patch 文件，在插件加载时解析并检查。 */
  patches: string[]
  /** 每个嵌套子进程的绝对隔离 Harness home。 */
  dshHome: string
  /** 子运行时初始化所用的提供方路由（默认 `deepseek-official`）。 */
  provider: string
  /** 子运行时初始化所用的模型（默认 `deepseek-v4-flash`）。 */
  model: string
  /** 子运行时的可选按请求输出 token 上限。 */
  maxTokens?: number
  /**
   * 子进程的额外环境变量 —— 例如子运行时自己的 `DEEPSEEK_API_KEY`。
   * 它们被转发到父 env 的凭据清洗副本之上，因此此处显式的 key 能到达
   * 子代理，而环境里的秘密不会隐式泄漏。
   */
  env: Record<string, string>
  /** 处置期间对协议 `shutdown` 交换的界限（ms）。 */
  shutdownTimeoutMs?: number
  /**
   * 处置时子代理由 EOF 驱动的静默宽限期（ms）—— 在父方升级为信号之前，
   * 它刷写持久化并拆解自身嵌套子进程的时间窗。
   */
  disposeEofGraceMs?: number
  /** 终止确认窗口（ms），包括每个平台上的强制退出。 */
  disposeGraceMs?: number
}

export const Config: z<Config> = z.object({
  providerName: z.string().default('dsh-sdk'),
  dshBin: z.string(),
  profile: z.string().default('sdk'),
  patches: z.array(z.string()).default([]),
  dshHome: z.string().required(),
  provider: z.string().default('deepseek-official'),
  model: z.string().default('deepseek-v4-flash'),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  env: z.dict(z.string()).default({}),
  shutdownTimeoutMs: z.number().default(DEFAULT_SHUTDOWN_TIMEOUT_MS),
  disposeEofGraceMs: z.number().default(DEFAULT_DISPOSE_EOF_GRACE_MS),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
})

/** schemastery 应用默认值之后的形状（`dshBin` 与 `maxTokens` 没有默认值）。 */
type ResolvedConfig = Required<Omit<Config, 'maxTokens' | 'dshBin'>> & Pick<Config, 'maxTokens' | 'dshBin'>

/** 针对 harness 启动目录解析一个已配置的运行时文件，并要求它是常规文件。 */
function resolveConfiguredFile(field: string, value: string): string {
  const path = resolve(value)
  try {
    if (statSync(path).isFile()) return path
  } catch {
    // 下面的诊断统一处理缺失、不可访问与非文件路径。
  }
  throw new TypeError(`subagent-dsh-sdk ${field} must name an existing file: ${path}`)
}

/** DSH SDK 可以应用 Agent 路由选项，而其他启动特性仍由子代理自己拥有。 */
const SDK_START_CAPABILITIES: SubagentCapabilities = Object.freeze({
  ...NO_START_CAPABILITIES,
  agentOptions: true,
})

/** 把请求中受支持的路由字段合并覆盖到本提供方实例的默认值之上。 */
function resolveSdkRoute(config: ResolvedConfig, requested: AgentOptions | undefined): Pick<
  SdkRunSpec,
  'provider' | 'model' | 'reasoningEffort' | 'maxTokens'
> {
  const maxTokens = requested?.maxTokens ?? config.maxTokens
  return {
    provider: requested?.provider ?? config.provider,
    model: requested?.model ?? config.model,
    ...requested?.reasoningEffort === undefined ? {} : { reasoningEffort: requested.reasoningEffort },
    ...maxTokens === undefined ? {} : { maxTokens },
  }
}

/**
 * SDK 提供方。它把 Agent 路由选项解析进子运行时的进程级握手；输出模式、
 * 深度与独立预设选择保持不受支持，因为它们的所有权不跨越此进程边界。
 */
class SdkSubagentProvider implements SubagentProvider {
  readonly capabilities = SDK_START_CAPABILITIES
  readonly agentRouteDefaults: Readonly<{ provider: string; model: string }>
  // 上下文契约：进程外的 SDK 子代理全新启动 —— 没有父对话跨越进程边界。
  readonly inheritsParentContext = false

  constructor(readonly name: string, private readonly ctx: Context, private readonly config: ResolvedConfig) {
    this.agentRouteDefaults = Object.freeze({ provider: config.provider, model: config.model })
  }

  start(request: ResolvedSubagentStartRequest) {
    if (request.signal.aborted) {
      throw new Error('subagent request was aborted before the SDK child started')
    }
    let cwd: string
    try {
      cwd = assertUsableCwd('subagent-dsh-sdk', 'child cwd', request.cwd)
    } catch (error: unknown) {
      const failure = sdkConfigurationFailure(error)
      this.ctx.logger.warn(`subagent-dsh-sdk "${this.name}": child start failed: %o`, error)
      throw failure
    }
    const route = resolveSdkRoute(this.config, request.agentOptions)
    const spec: SdkRunSpec = {
      ...this.config.dshBin === undefined ? {} : { dshBin: this.config.dshBin },
      profile: this.config.profile,
      patches: this.config.patches,
      dshHome: this.config.dshHome,
      cwd,
      originCwd: request.parent.session.header.cwd,
      ...route,
      env: this.config.env,
      shutdownTimeoutMs: this.config.shutdownTimeoutMs,
      disposeEofGraceMs: this.config.disposeEofGraceMs,
      disposeGraceMs: this.config.disposeGraceMs,
      onError: (error, stopReason) => {
        // 接缝禁止 `result` 拒绝，因此子代理级别的失败被扁平化为一个
        // 停止原因 —— 在此处保留它，而不是丢失它。
        this.ctx.logger.warn(`subagent-dsh-sdk "${this.name}": child run failed (${stopReason}): ${error.message}`)
      },
    }
    return startSdkRun(request, spec)
  }
}

export function apply(ctx: Context, config: Config): void {
  // schemastery（Config）已经填好了每一个有默认值的字段。
  const resolved = config as ResolvedConfig
  assertPositiveFinite('subagent-dsh-sdk', 'shutdownTimeoutMs', resolved.shutdownTimeoutMs)
  assertPositiveFinite('subagent-dsh-sdk', 'disposeEofGraceMs', resolved.disposeEofGraceMs)
  assertPositiveFinite('subagent-dsh-sdk', 'disposeGraceMs', resolved.disposeGraceMs)
  if (resolved.maxTokens !== undefined && (!Number.isSafeInteger(resolved.maxTokens) || resolved.maxTokens <= 0)) {
    throw new TypeError('subagent-dsh-sdk maxTokens must be a positive safe integer')
  }
  if (!isAbsolute(resolved.dshHome)) throw new TypeError('subagent-dsh-sdk dshHome must be an absolute path')
  const launchPaths: ResolvedConfig = {
    ...resolved,
    patches: resolved.patches.map((path, index) => resolveConfiguredFile(`patches[${String(index)}]`, path)),
    ...resolved.dshBin === undefined ? {} : { dshBin: resolveConfiguredFile('dshBin', resolved.dshBin) },
  }
  ctx.subagents.registerProvider(new SdkSubagentProvider(launchPaths.providerName, ctx, launchPaths))
}
