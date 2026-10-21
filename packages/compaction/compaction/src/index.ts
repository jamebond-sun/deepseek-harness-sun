/**
 * 压缩服务定义（`ctx.compaction`）：各提供方通过继承
 * {@link CompactionEngine} 来决定何时压缩并用一个摘要节点替换某段历史区间。
 * 该接口必然依赖 session 与 LLM 的词汇；依赖规则记录在
 * [压缩参考文档](../README.md#understand-the-implementation) 中。
 * @module @deepseek-ai/dsh-compaction
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import type { CompactionResult } from './types.ts'
import type { CompactionCheckpointSource } from './checkpoint.ts'

export type { CompactionResult } from './types.ts'
export { CompactionId } from './brand.ts'
export { toolPairingBalancedAfter, toolPairingBalancedBefore } from './tool-pairing.ts'
// 检查点来源的构造函数与断言声明在无 cordis 依赖的
// `./checkpoint` 叶模块中，以便客户端与连线程序无需本根模块的
// Context 合并即可引用它们；而根模块仍是两者的宿主侧入口。
export { compactCheckpointSource, isCompactCheckpointSource } from './checkpoint.ts'
export type { CompactionCheckpointSource } from './checkpoint.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'compact-checkpoint': CompactionCheckpointSource
  }
}

/** 自动策略请求某个后端考虑执行压缩的原因。 */
export type CompactionTrigger = 'pressure' | 'context-overflow'

/** 针对显式空闲会话压缩请求的预期失败类别。 */
export type ManualCompactionErrorCode =
  | 'busy'
  | 'cancelled'
  | 'changed'
  | 'summary'
  | 'commit'
  | 'persistence'

/**
 * 适用于直接人工命令结果的预期手动压缩失败。
 * 共享的持久锁进入断言也可能从自动压缩路径抛出 `busy` 子类型。
 */
export class ManualCompactionError extends Error {
  override readonly name = 'ManualCompactionError'

  /**
   * 创建一个已分类的压缩失败。
   * @param code - 稳定的失败类别；`busy` 可能源自任意压缩进入路径。
   * @param message - 由后端保留作为 Error 消息的诊断信息。
   * @param options - 可选的原始失败。
   */
  constructor(
    readonly code: ManualCompactionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

/** 压缩所需的最小代理上下文，且不依赖 agent 包。 */
export interface CompactionAgentContext {
  session: Session
  options: { provider?: string; model?: string }
}

/**
 * 序列化显式空闲会话压缩、以避让驱动轮次所需的代理能力。
 * 持久化的 `compaction/start` 标记另会排除其他压缩事务。
 */
export interface ManualCompactAgentContext extends CompactionAgentContext {
  /**
   * 仅在代理空闲时运行一个非轮次的维护操作，并暂缓后续唤醒输入直到其完成。
   * @param task - 需保留其完成或被拒绝状态的操作，并带有代理自有的取消信号。
   * @throws 当代理已处于活动状态时同步抛出。
   * @returns 该任务的 Promise。
   */
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    compaction: CompactionEngine
  }
  interface Events {
    /**
     * 通过同步记录对其所选输入的持久化变更，来恢复一个失败的摘要请求。
     * 仅在进行到某一步之后才返回 true；提供方会在重试前重新派生并重新计价该选择。
     * 当失败无法恢复时调用 next()。所作决定在后续的摘要失败或取消后仍保留。
     * @param payload.session - 包含所选输入的会话。
     * @param payload.sourceEventSeqs - 按请求顺序排列的所选消息事件。
     * @param payload.error - 摘要器抛出的失败。
     * @param payload.signal - 可选的压缩取消信号。
     * @param next - 委托给下一个恢复监听器。
     * @mode waterfall
     */
    'compaction/summary-error'(payload: { session: Session; sourceEventSeqs: readonly SessionSeq[]; error: unknown; signal?: AbortSignal }, next: () => boolean): boolean
  }
}

/**
 * 抽象压缩服务。各实现拥有触发策略、保留策略与摘要逻辑，
 * 并可消费一个独立的计量服务。一次成功的运行会把所选表层区间替换为一个摘要节点，
 * 并阻止对同一会话的并发压缩。替换用户消息使用带事务标识的
 * {@link compactCheckpointSource}，以便消费者独立于后端识别和关联它。
 * 每个上下文加载一个实现，作为 `ctx.compaction`。
 */
export abstract class CompactionEngine extends Service {
  constructor(ctx: Context) {
    super(ctx, 'compaction')
  }

  /**
   * 针对某个显式触发条件考虑自动压缩。压力策略使用最新的持久化路由请求，
   * 而上下文溢出策略即使低于常规阈值也可能强制进行一次有意义的平衡缩减。
   * 当没有任何可安全压缩的区间时返回 `null`。单个过大的保留单元或请求信封
   * 无法通过表层压缩修复。
   *
   * @param agent - 拥有会话表层与路由选项的代理上下文。
   * @param trigger - 常规压力或经提供方确认的上下文溢出。
   * @param signal - 取消信号；基于模型的实现必须转发它。
   * @returns 压缩结果，若无需压缩则为 `null`。
   */
  abstract compactIfNeeded(
    agent: CompactionAgentContext,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null>

  /**
   * 显式压缩有用的历史，即使低于自动压力阈值也进行。
   * 各实现会在任何异步工作之前同步启动一个空闲任务，先在不执行无效写入的前提下
   * 选择一段有用区间，然后在摘要前追加一个独立的 `compaction/start`。
   * 该持久化标记即为压缩锁，直到一次 `compaction/end` 尝试为止。后续唤醒的
   * 提示仍按 FIFO 顺序被接受，并仅在可选的持久化检查点与空闲任务结算之后才开始。
   * 摘要运行期间注入的上下文可能落在标记对之间；只有所选区间必须保持稳定。
   *
   * @param agent - 其持久化历史应被压缩的空闲代理。
   * @param signal - 限定于本次压缩请求的取消信号。
   * @param sourceCommandId - 发起本次手动压缩的命令标识。
   * @returns 压缩结果，当不存在安全的可用区间时为 `null`。
   * @throws {@link ManualCompactionError}，对应预期的 busy、代理取消、
   * 区间变更、摘要/缩减、提交阶段或持久化失败；被中止的请求保留其确切的中止原因。
   * 失败的尝试仍会在日志中可见。
   */
  abstract compactNow(
    agent: ManualCompactAgentContext,
    signal: AbortSignal,
    sourceCommandId?: CommandId,
  ): Promise<CompactionResult | null>

  /**
   * 强制将一段表层节点压缩为单个摘要节点。
   * `start` 与 `end` 按表层位置（而非数字 seq 顺序）命名一个包含区间；
   * 替换可能使可见 seq 不再单调。两侧边缘必须保持平衡，以使助手工具调用
   * 仍与其结果配对。基于模型的实现会转发取消信号，并拒绝处于活动、缺失、
   * 反转或不平衡的区间。目标会话为 `agent.session`。其替换用户消息必须使用
   * 带事务 `CompactionId` 的 {@link compactCheckpointSource}。
   * 边缘检查请使用 {@link toolPairingBalancedBefore} 与 {@link toolPairingBalancedAfter}。
   *
   * @param start - 首个表层 seq，包含。
   * @param end - 末个表层 seq，包含。
   * @param agent - 其会话被修改、其路由选项引导摘要的上下文。
   * @param signal - 可选的取消信号；基于模型的实现必须转发它。
   * @throws 当压缩处于活动状态，或区间缺失、反转或不平衡时。
   * @returns 追加的事件 seq、摘要、被替换区间以及 token 计量信息。
   */
  abstract compactRegion(
    start: SessionSeq,
    end: SessionSeq,
    agent: CompactionAgentContext,
    signal?: AbortSignal,
  ): Promise<CompactionResult>
}

export default CompactionEngine
