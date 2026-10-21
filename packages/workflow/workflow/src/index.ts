/**
 * workflow 能力 seam 的服务定义。服务提供者执行编排脚本；仅观察的生命周期
 * 事件绝不暴露运行控制。
 * @module @deepseek-ai/dsh-workflow
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type {
  WorkflowAgentEndInfo,
  WorkflowAgentInfo,
  WorkflowResultInfo,
  WorkflowRunInfo,
} from './types.ts'
import type { WorkflowRun, WorkflowStartRequest } from './runtime-types.ts'

export { WorkflowRunId } from './types.ts'
export type {
  WorkflowAgentEndInfo,
  WorkflowAgentInfo,
  WorkflowAgentOutcome,
  WorkflowMeta,
  WorkflowPhase,
  WorkflowResult,
  WorkflowResultInfo,
  WorkflowRunInfo,
  WorkflowStopReason,
} from './types.ts'
export type { WorkflowRun, WorkflowStartRequest } from './runtime-types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    workflowEngine: WorkflowEngine
  }

  interface Events {
    /**
     * 一次 workflow 运行已启动 —— 脚本的 meta 块已校验，正文即将执行。
     * 与 {@link Events['workflow/end']} 配对。
     * @param info - 运行的身份快照（id + meta）。
     * @mode emit
     */
    'workflow/start'(info: WorkflowRunInfo): void
    /**
     * 脚本进入了一个阶段（一次 `phase(title)` 调用）—— 供观察者进行进度分组；
     * 没有执行语义。
     * @param info - 运行的身份快照。
     * @param title - 阶段标题，原样。
     * @mode emit
     */
    'workflow/phase'(info: WorkflowRunInfo, title: string): void
    /**
     * 脚本发出了一行叙述（一次 `log(message)` 调用）。
     * @param info - 运行的身份快照。
     * @param message - 被记录的消息，原样。
     * @mode emit
     */
    'workflow/log'(info: WorkflowRunInfo, message: string): void
    /**
     * 一个 `agent()` 调用建立了一个已发布的子项运行。由 `agent.seq` 与
     * {@link Events['workflow/agent-end']} 配对。一个从未从 provider 收到
     * 已发布运行的调用，不会发出这一对中的任何一个事件。
     * @param info - 运行的身份快照。
     * @param agent - 调用的序号、标签、阶段，以及子项 id。
     * @mode emit
     */
    'workflow/agent-start'(info: WorkflowRunInfo, agent: WorkflowAgentInfo): void
    /**
     * 一个 `agent()` 调用已结算（干净结果、子项失败，或运行取消）。
     * 由 `agent.seq` 与 {@link Events['workflow/agent-start']} 配对，在每一条
     * 停止路径上对每个已启动的调用恰好一次 —— 在引擎终止路径上，该结束由
     * 引擎合成，结果为 `'cancelled'`。
     * @param info - 运行的身份快照。
     * @param agent - 调用身份及其结果。
     * @mode emit
     */
    'workflow/agent-end'(info: WorkflowRunInfo, agent: WorkflowAgentEndInfo): void
    /**
     * 一次 workflow 运行已结算（任意停止原因）。在
     * {@link WorkflowRun.result} 解析时触发。与
     * {@link Events['workflow/start']} 配对。
     * @param info - 运行的身份快照。
     * @param result - 结果数据（停止原因、错误、代理数量）—— 刻意不含
     *   结果值（见 {@link WorkflowResultInfo}）。
     * @mode emit
     */
    'workflow/end'(info: WorkflowRunInfo, result: WorkflowResultInfo): void
  }
}

/** {@link WorkflowEngine.emitWorkflowEvent} 所分发的全部 `workflow/*` 事件名集合。 */
export type WorkflowEventName =
  | 'workflow/start'
  | 'workflow/phase'
  | 'workflow/log'
  | 'workflow/agent-start'
  | 'workflow/agent-end'
  | 'workflow/end'

/**
 * 机器可路由的致命 workflow 失败：解析/meta/参数/schema 错误、
 * 资源限额、子代理基础设施失败、不可序列化的边界值，以及取消。一个普通的
 * 子项失败会将其条目解析为 `null`，不属于这些致命码之一。
 */
export type WorkflowErrorCode =
  | 'SCRIPT_PARSE'
  | 'META_INVALID'
  | 'INVALID_ARGUMENT'
  | 'UNSUPPORTED_OPTION'
  | 'UNSUPPORTED_SCHEMA'
  | 'AGENT_CAP'
  | 'ITEM_CAP'
  | 'AGENT_START'
  | 'AGENT_RESULT'
  | 'RESULT_UNSERIALIZABLE'
  | 'CANCELLED'

/**
 * 针对 workflow-seam 失败的带类型错误。继承自 {@link HarnessError}，因此
 * `code` 是机器可路由的分类。`fatal` 驱动组合子纪律：`parallel()`/`pipeline()`
 * 重抛一个致命错误（拼错的选项或触发的限额必须响亮地杀死脚本），而将逐条目的
 * `null` 留给子项运行失败与普通的阶段内脚本错误。每一个 {@link WorkflowErrorCode}
 * 都是致命的；该标志的存在是为了让这一区别在每个 catch 处显式可见，而非隐含。
 */
export class WorkflowError extends HarnessError {
  /** 组合子是否必须传播此错误，而非将条目置为 null。 */
  readonly fatal: boolean

  constructor(message: string, code: WorkflowErrorCode, options?: ErrorOptions & { fatal?: boolean }) {
    super(message, code, options)
    this.name = 'WorkflowError'
    this.fatal = options?.fatal ?? true
  }
}

/**
 * 组合子是否必须重抛 `error`，而非将条目映射为 `null`。
 * @param error - 任意被抛出的值；致命性由宿主 `instanceof` 判断（从一个脚本 realm 中无法伪造）。
 * @returns 当且仅当 `error` 是一个 `fatal` 标志被置位的 {@link WorkflowError} 时为 true。
 */
export function isFatalWorkflowError(error: unknown): boolean {
  return error instanceof WorkflowError && error.fatal
}

/**
 * workflow 服务定义契约。无效的请求在发布前抛出；一个活跃运行是属主拥有的，
 * 其 `result` 永不 reject，且释放会等待脚本与子项清理。生命周期监听器
 * 的失败被隔离，且 `workflow/end` 在结果结算时恰好触发一次。
 */
export abstract class WorkflowEngine extends Service {
  constructor(ctx: Context) {
    super(ctx, 'workflowEngine')
  }

  /**
   * 解析并执行一个 workflow 脚本。
   * @param request - 脚本、其 `args`、父代理，以及可选的取消信号。
   * @returns 活跃的运行；其 `result` 在脚本结算时解析。
   */
  abstract start(request: WorkflowStartRequest): WorkflowRun

  /**
   * 在隔离并记录每个监听器失败的同时，发出一个生命周期事件。
   * @param name - 要分发的 `workflow/*` 事件。
   * @param args - 事件的载荷，与其声明的签名一致。
   */
  protected emitWorkflowEvent(name: WorkflowEventName, ...args: unknown[]): void {
    for (const callback of this.ctx.events.dispatch('emit', [name, ...args])) {
      try {
        const returned: unknown = (callback as (...payload: unknown[]) => unknown)(...args)
        void Promise.resolve(returned).catch((error: unknown) => {
          this.ctx.logger.warn(`workflow: ${name} listener rejected: ${renderListenerError(error)}`)
        })
      } catch (error: unknown) {
        this.ctx.logger.warn(`workflow: ${name} listener threw: ${renderListenerError(error)}`)
      }
    }
  }
}

/**
 * 在不违反监听器隔离的前提下渲染任意被抛出的值。
 * @param error - 任意被抛出的值。
 * @returns `String(error)`，或当连强制转换都会抛出时的一个固定标签。
 */
function renderListenerError(error: unknown): string {
  try {
    return String(error)
  } catch {
    // 强制转换本身也可能抛出。
    return '[unrenderable thrown value]'
  }
}

export default WorkflowEngine
