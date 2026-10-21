/**
 * 后台任务的服务定义（`ctx.jobs`）。它定义了任务 id 的契约、按会话界定的访问、
 * 生命周期状态、每个任务各自的输出环形缓冲区——一条有界流，模型通过注册表保有的
 * 游标消费它，任意数量的观察者按绝对字节偏移读取它——以及宣告每一次提交的事件流，
 * 而生产者保留自己的执行资源。进程内注册表实现位于 `@deepseek-ai/dsh-jobs-local`。
 * @module @deepseek-ai/dsh-jobs
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { installJobArchiveAdmission } from './archive-admission.ts'
import type { JobEvents, JobId, JobOutputRead, JobRead, JobSpec, JobView } from './types.ts'

export { JobId } from './types.ts'
export type {
  JobAppendOptions,
  JobChannel,
  JobChunk,
  JobEvent,
  JobEventFilter,
  JobEventListener,
  JobEvents,
  JobHandle,
  JobHooks,
  JobKind,
  JobKindMap,
  JobOutcome,
  JobOutputRead,
  JobOutputSource,
  JobRead,
  JobRegisteredData,
  JobSettledData,
  JobSettleCause,
  JobSourceRead,
  JobSpec,
  JobStatus,
  JobToolCall,
  JobView,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    jobs: JobRegistry
  }
}

/**
 * 抽象的后台任务注册表。子类化它、实现抽象成员，并把子类作为插件加载——它会注册为
 * `ctx.jobs`（每个上下文一个实现；加载第二个会抛错，这是 cordis 对重复服务的标准行为）。
 *
 * 实现必须遵守以下语义：
 * - 注册记录比生产者和控制器的 fiber 活得更久。所有者销毁与服务销毁会取消仍在运行的工作，
 *   并等待合规的生产者；抛出错误的销毁取消只强制失败该条记录。这类结算以
 *   `cause: 'teardown'` 宣告，因为所有者即将被销毁的任务已经没有读者了。
 * - 自有任务的访问以所有者的会话 id 为界。id 是可预测的，所以边界在于授权，而非保密。
 * - 结算先到先得：一条终态记录、释放等待者，然后一轮受控的事件投递——即使生产者的
 *   结果迟到也如此。`settled` 事件在每个被释放的等待者之后发出，并报告是否释放过
 *   等待者（`awaited`），这样完成上报方可以跳过那些已被等待调用方取走的结算。
 * - 已结算的记录会一直留在列表中，直到其所有者销毁、服务销毁，或某个调用方显式
 *   {@link remove}——前提是它自己取走了终态且从未把 id 交给别人。
 * - {@link start} 在没有已挂载的任务控制器服务该 spec 的所有者时拒绝开工，因此生产者
 *   无法启动所有者既收不到结果也停不掉的工作。一个注册表服务进程内的每种组合，所以这个
 *   判断——以及 `{ owners: 'scope' }` 下的事件投递——是相对于所有者而非全进程的：从未限定
 *   作用域的上下文注册的服务覆盖所有所有者，而在某个 agent 组合作用域下注册的服务只覆盖
 *   其下组合出的那些 agent。
 * - 每个任务拥有一个输出环形缓冲区。spec 指名的拉取源由注册表泵送，并在结算前再排空一次；
 *   推送式追加则整块落地。模型的消费游标与观察者的绝对偏移读取同样的字节，且互不干扰。
 * - 环形缓冲区的保留是有界的。超过在世上限的追加会丢弃最老的保留字节；游标落在保留窗口
 *   之下的读取者拿到的是有损读取，而不是错误。结算把保留量裁剪到已结算上限并结束该流；
 *   环形缓冲区没有独立的生命周期。
 */
export abstract class JobRegistry extends Service {
  constructor(ctx: Context) {
    // `abstract` 在运行时被擦除，因此组合表里写这个包的名字会注册出一个没有任何方法实现的
    // ctx.jobs，并在距离配置错误很远的地方才失败。改为在加载时就显式失败。
    if (new.target === JobRegistry) {
      throw new Error('@deepseek-ai/dsh-jobs is the abstract job registry seam; load an implementation such as @deepseek-ai/dsh-jobs-local instead')
    }
    super(ctx, 'jobs')
    // 归档准入：Workspace 注册表在隐藏一个 Session 之前会先询问它还有哪些工作在运行；
    // 自有任务在这里为每一种实现作答。
    installJobArchiveAdmission(ctx, this)
  }

  /** 生命周期与输出事件，按订阅过滤。 */
  abstract readonly events: JobEvents

  /**
   * 在启动并以原子方式注册工作之前，做访问预检、校验、所有者清理以及实现自有的准入。
   * 任何预检拒绝都不会留下任务 id 或执行资源。启动器抛出则什么都不注册；它返回之后，
   * 注册不可能失败。
   * @param spec - 任务身份、所有者、输出源以及同步的启动器。
   * @returns 注册表签发的 `<kind>-<short-uuid>` id。
   */
  abstract start(spec: JobSpec): JobId

  /**
   * 按注册顺序列出调用方自有以及无主的任务。
   * @param caller - 读取方会话；省略时只能看到无主任务。
   * @returns 全新的投影。
   */
  abstract list(caller?: SessionId): JobView[]

  /**
   * 投影单个任务，不移动它的游标。对未知或非本方的任务抛出。
   * @param id - 要查找的任务。
   * @param caller - 与所有者比对的读取方会话。
   * @returns 一个全新的投影。
   */
  abstract get(id: JobId, caller?: SessionId): JobView

  /**
   * 从模型游标消费环形缓冲区，并把游标推进到当前总长。结算之后的首次读取还会带上
   * 生产者的结果。对未知或非本方的任务抛出。
   * @param id - 要读取的任务。
   * @param caller - 与所有者比对的读取方会话。
   * @returns 游标之后的块、有损标志、只发放一次的结果，以及读取后的投影。
   */
  abstract read(id: JobId, caller?: SessionId): JobRead

  /**
   * 读取保留下来的环形缓冲区输出，不移动模型游标。可用上一次读取的 `next` 续读；
   * 落在某个保留块内部的偏移会返回整块（其 `at` 可能早于 `from`）。偏移为负或非整数、
   * 任务未知或非本方时抛出。
   * @param id - 要读取的任务。
   * @param from - 起始绝对字节偏移（0 表示保留区的头部）。
   * @param caller - 与所有者比对的读取方会话。
   * @returns 与 `[from, total)` 相交的保留块、续读偏移以及有损标志。
   */
  abstract readAt(id: JobId, from: number, caller?: SessionId): JobOutputRead

  /**
   * 请求取消，然后把任务标记为 stopping。生产者的抛出会向上传播，不改变任务状态。
   * 传入的原因会在任务以 `killed` 结算时并入终态 `detail`。对未知或非本方的任务抛出。
   * @param id - 要取消的任务。
   * @param caller - 与所有者比对的取消方会话。
   * @param reason - 原样转发给生产者的取消原因。
   * @returns 对仍在运行的工作返回 `requested`，否则返回 `already-finished`。
   */
  abstract kill(id: JobId, caller?: SessionId, reason?: string): 'requested' | 'already-finished'

  /**
   * 等待结算或超时，不取消任务。调用方 abort 只在任务仍在运行时才拒绝；结算之后以
   * 终态投影为准。超时非法、任务未知或非本方时拒绝。
   * @param id - 要等待的任务。
   * @param timeoutMs - 正的有限等待上限，单位毫秒。
   * @param caller - 与所有者比对的等待方会话。
   * @param signal - 可选的中止信号，用于取消等待本身。
   * @returns 结算或超时时刻的投影。
   */
  abstract wait(id: JobId, timeoutMs: number, caller?: SessionId, signal?: AbortSignal): Promise<JobView>

  /**
   * 把一个已结算任务的记录从可见集合中移除，并宣告 `removed`。适用于调用方已经通过
   * 自己的 {@link wait} 取走终态、且从未把 id 交给模型的情形，例如 shell 工具的前台调用。
   * 对仍在运行、未知或非本方的任务抛出。
   * @param id - 要丢弃的已结算任务。
   * @param caller - 与所有者比对的移除方会话。
   */
  abstract remove(id: JobId, caller?: SessionId): void

  /**
   * 挂载一个随 effect 作用域生效的控制器，它可以读取并停止任务。它服务其注册上下文的
   * 作用域所覆盖的那些所有者，而 {@link start} 会拒绝没有已挂载控制器服务的所有者。
   * @param name - 诊断用标签；重名之间仍然相互独立。
   * @returns 卸载该控制器的 disposer。
   */
  abstract attachController(name: string): () => void
}

export default JobRegistry
