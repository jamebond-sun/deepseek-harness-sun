/**
 * `ctx.shell` 能力缝的服务定义，覆盖前台命令与后台进程句柄。作业 id、
 * 归属、轮询与通知属于 `@deepseek-ai/dsh-jobs`，以保持执行器独立于会话。
 * @module @deepseek-ai/dsh-shell
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { ShellExecRequest, ShellExecSpec, ShellExecution } from './types.ts'

export { DSH_ENV_PREFIX } from './types.ts'
export type {
  ShellExecRequest,
  ShellExecSpec,
  ShellExecution,
  ShellExpiryPolicy,
  ShellProcess,
  ShellProcessRead,
  ShellProcessStatus,
  ShellRunResult,
  ShellSandboxInfo,
  CollectedOutput,
  DshEnvironment,
  DshEnvironmentKey,
} from './types.ts'
export { parseExitStatus } from './render.ts'
export type { ParsedExitStatus } from './render.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    shell: ShellExecutor
  }
}

/**
 * 抽象的 shell 执行服务。子类化它、实现抽象方法，并把子类作为插件加载——
 * 它会注册为 `ctx.shell`（每个 context 一个实现；加载第二个会抛出，
 * 这是 cordis 对重复服务的标准行为）。
 *
 * {@link execute} 在准备阶段之后以进程句柄兑现。“前台”取决于调用方等待
 * 的是什么，而非 spawn 本身——等待 {@link ShellExecution.result} 的调用方
 * 是在前台运行命令；保留句柄的调用方则是在后台运行。只想等待一段时间的
 * 调用方可以用 `onExpiry: 'none'` 运行命令并自行限制等待；调用方停止等待后
 * 句柄仍然有效。
 *
 * 实现必须遵循以下语义：
 * - {@link ShellExecution.result} 仅在基础设施故障时拒绝。非零退出、超时
 *   终止与中止终止都会以描述性结果兑现：包含首因 `timedOut`/`aborted`
 *   分类与规约 `timeoutMs` 的回写。
 * - 句柄在准备阶段之后发布。`done` 在进程关闭时落定且永不拒绝；spawn
 *   失败以 `killed` 落定并把错误留在读取路径上，而 `result()` 则以拒绝
 *   形式承载同一失败。
 * - `onExpiry: 'none'` 不设期限；`'kill'` 在到期时终止。准备阶段超时会
 *   返回一个已落定、无任何输出的超时句柄。
 * - {@link ShellProcess.readOutput} 是增量的：连续读取不会重复输出。
 *   有损读取会上报截断与可用的溢出文件。
 * - 仍在运行的进程会在其所属 composition 拆除时被终止并等待。对
 *   subprocess 能力缝而言，这一边界是 `ctx.subprocess` 的 disposal，
 *   因此进程可以存活于仅重载执行器的场景。
 */
export abstract class ShellExecutor extends Service {
  constructor(ctx: Context) {
    super(ctx, 'shell')
  }

  /**
   * 该执行器默认施加的沙箱模式；不隔离命令时为 `undefined`。
   * @returns 已配置的默认沙箱模式（若支持）。
   */
  get sandboxMode(): SandboxMode | undefined {
    return undefined
  }

  /**
   * 在执行前对请求施加由实现自身持有的默认值与上限。
   * @param request - 调用方的请求；省略的字段取本实现的默认值，
   *   设有上限的字段被收敛到上限。
   * @returns 交给 {@link execute} 的完全确定规约。
   */
  abstract resolve(request: ShellExecRequest): ShellExecSpec

  /**
   * 在解析出的期限下准备并 spawn 命令。
   * @param spec - 来自 {@link resolve} 的已解析规约，绝不能是原始请求。
   * @returns 已准备好的句柄，包含其结果投影；准备阶段超时会得到一个
   *   已落定且无输出的句柄。
   * @throws 准备阶段失败，或在进程发布之前调用方取消。
   */
  abstract execute(spec: ShellExecSpec): Promise<ShellExecution>
}

export default ShellExecutor
