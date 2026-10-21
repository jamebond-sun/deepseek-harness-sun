/**
 * 任务生产者、注册表与其消费者共用的类型。客户端安全的投影词汇在 `./view.ts`；
 * 服务实现在 `./index.ts`。
 * @module @deepseek-ai/dsh-jobs/types
 */

import type { SessionEventMap, SessionId } from '@deepseek-ai/dsh-session'
import type { JobId } from './brand.ts'
import type { JobChannel, JobChunk, JobKind, JobView } from './view.ts'

export { JobId } from './brand.ts'
export type { JobChannel, JobChunk, JobKind, JobKindMap, JobStatus, JobView } from './view.ts'

/** 创建该任务的工具分发；嵌套调用保留其根调用。 */
export interface JobToolCall {
  /** 确切的那次调用，适用时包含 PTC 子调用。 */
  readonly callId: SessionEventMap['tool/call']['callId']
  /** 拥有本次执行的、由模型请求的根调用。 */
  readonly rootCallId: SessionEventMap['tool/call']['callId']
}

/** 一次自有任务执行的持久身份与注册时间。 */
export interface JobRegisteredData {
  /** 任务控制接受、并保留在 Session 历史中的唯一执行 id。 */
  readonly jobId: JobId
  /** 原始所有者；复制来的历史不会转移执行所有权。 */
  readonly owner: SessionId
  /** 生产者类型。 */
  readonly kind: string
  /** 生产者提供的标签。 */
  readonly label: string
  /** 注册提交时的 Unix 纪元毫秒。 */
  readonly startedAt: number
  /** 当生产者是通过某个工具被调用时，创建它的那次工具调用。 */
  readonly toolCall?: JobToolCall
}

/** 注册表的结算，包括生产者是否报告了终态结果。 */
export interface JobSettledData extends JobRegisteredData {
  /** 注册表提交终态记录时的 Unix 纪元毫秒。 */
  readonly finishedAt: number
  /** 记录的终态结果。 */
  readonly status: JobOutcome['status']
  /** 终止请求的来源，或生产者自行完成。 */
  readonly cause: JobSettleCause
  /** `done` 兑现时为 true；被拒绝或被强制失败时为 false。不证明资源已释放。 */
  readonly producerReported: boolean
  /** 终态原因，适用时包含已记录的 kill 原因。 */
  readonly detail?: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * 仅用于记录的注册事件；不要求模型采集输出。
     * @param data - 执行身份、原始所有者、注册时间以及创建它的工具调用。
     */
    'job/registered': JobRegisteredData
    /**
     * 仅用于记录的终态记录，由与实时控制相同的唯一 jobId 配对。
     * @param data - 注册事实，加上结算时间、结果以及生产者的确认。
     */
    'job/settled': JobSettledData
  }
}

/** 生产者通过 {@link JobHooks.done} 提供的终态结果。 */
export interface JobOutcome {
  /** 任务如何结束：完成（`completed`）、被取消（`killed`）或出错（`failed`）。 */
  status: 'completed' | 'killed' | 'failed'
  /**
   * 渲染进状态行的终态原因（`exit code: 3`、`max-tokens`）。
   * 当任务在带原因的 {@link JobRegistry.kill} 之后以 `killed` 结算时，注册表会追加该原因。
   */
  detail?: string
  /**
   * 对结果是一个值而非流的任务（一个 workflow 渲染出的结果、一个 subagent 的报告）而言的返回值。
   * 流走输出环形缓冲区；这个值由模型下一次 {@link JobRegistry.read} 一次性交出。
   */
  result?: string
}

/** 从某个 {@link JobOutputSource} 的一次增量读取。 */
export interface JobSourceRead {
  /** 自请求偏移以来捕获到的文本（有损时为整个保留下来的尾部）。 */
  text: string
  /** 下次读取续读用的整流偏移。 */
  nextOffset: number
  /** 请求的偏移是否已滑出该源保留的窗口。 */
  lossy: boolean
  /**
   * 当该源当前保存着一份完整流时，持有它的文件的宿主路径。每次读取都会上报，
   * 因此注册表把它当作源的元数据来跟踪：之后某次读取不再带它就意味着文件被撤回。
   */
  spillPath?: string
}

/**
 * 注册表泵入任务输出环形缓冲区的一个拉取源——子进程的 `readFrom` 家族。
 * 注册表掌握节奏，并在结算关闭环形缓冲区之前把每个源最后排空一次，因此生产者
 * 不需要把任何东西折叠进自己的 `done`。
 */
export interface JobOutputSource {
  /** 附在该源产出的每个块上的流标签。 */
  channel?: JobChannel
  /**
   * 读取自 `fromByte` 以来捕获到的全部内容，且不消费它。
   * @param fromByte - 续读用的整流偏移（上一次读取的 `nextOffset`；首次为 0）。
   * @returns 增量文本、下一个偏移、有损标志，以及该源当前保留的溢出文件路径。
   */
  read(fromByte: number): JobSourceRead
}

/** 一次 {@link JobHandle.append} 的选项。 */
export interface JobAppendOptions {
  /** 该块的流标签；对没有区分流生产者的省略。 */
  channel?: JobChannel
  /**
   * 标记上一个块与本块之间生产者侧的字节已丢失，这样观察者可以渲染出这个断点，
   * 而不是一次静默的拼接。
   */
  gapBefore?: true
}

/**
 * 一个已注册任务的生产者接口，交给 {@link JobSpec.run}，在任务的整个生命周期内有效。
 * 所有方法都是同步的。在启动器调用内暂存的写入会被保留，并随注册提交一起变得可见；
 * 结算之后——生产者自己的结果、一次 kill，或注册表强制的销毁结束——写入会被记日志并丢弃
 * 而不是抛出，这样生产者的收尾冲刷不会打断它自己的销毁路径。
 */
export interface JobHandle {
  /** 注册表签发的 id（`<kind>-<short-uuid>`）。 */
  readonly id: JobId
  /**
   * 向输出环形缓冲区追加一个块。偏移按该块的 UTF-8 字节长度推进；空块会被丢弃且
   * 不会唤醒观察者。
   * @param text - 块的文本，与产出完全一致。
   * @param options - 流标签与断点标记。
   */
  append(text: string, options?: JobAppendOptions): void
  /**
   * 替换实时的进度行（`3/10`、当前阶段）。结算会清空它；终态原因走 {@link JobOutcome.detail}。
   * @param line - 新的进度行。
   */
  updateProgress(line: string): void
}

/** 运行时控制与观察生产者工作的钩子。 */
export interface JobHooks {
  /**
   * 请求终止。必须是同步的、幂等的，并最终结算 {@link done}；抛出会向上传播。
   * 可选原因原样转发。
   */
  cancel(reason?: string): void
  /**
   * 在生产者释放其资源之后才兑现，而不仅仅是工作完成时。不得拒绝；运行时会把拒绝转成
   * `failed`。如果销毁期间的取消抛出，运行时可以只强制失败注册表记录，而不声称工作已停止。
   */
  done: Promise<JobOutcome>
}

/**
 * 传给 {@link JobRegistry.start} 的生产者声明。运行时在调用 {@link run} 之前做访问与清理预检；
 * 生产者拥有执行资源，而运行时拥有身份、生命周期状态以及输出环形缓冲区。
 */
export interface JobSpec {
  /** 生产者类型——同时也是 id 的前缀（`bash` 等）。 */
  kind: JobKind
  /** 面向模型的一行标签（命令；委派描述）。 */
  label: string
  /**
   * 所属会话。访问以它为界，且该所有者当前的活体 Agent 必须是此刻注册在该 id 下的那个：
   * 它的销毁会取消并等待该任务。省略所有者会创建一个无主任务，直到服务销毁前对任何调用方开放。
   */
  owner?: SessionId
  /** 创建它的工具调用，保留在持久的生命周期记录中。 */
  toolCall?: JobToolCall
  /**
   * 每条完整的面向模型的完成通知或输出读取的可选 UTF-8 字节上限，含控制器状态元数据。
   * 与环形缓冲区保留无关：它约束的是消费侧的模型界面，从不约束观察者。
   */
  outputLimitBytes?: number
  /**
   * 注册表以自身节奏泵入环形缓冲区的拉取源。自行叙述进度的生产者改用
   * {@link JobHandle.append}；一个任务也可以两者都用。
   */
  output?: readonly JobOutputSource[]
  /**
   * 在预检之后启动工作，并同步返回其钩子。带着任务的生产者接口调用一次；抛出则什么都不
   * 注册（已消耗的序号被跳过），且生产者必须清理任何部分启动的资源。
   * @param job - 签发的 id，加上环形缓冲区追加与进度写入器。
   */
  run(job: JobHandle): JobHooks
}

/** 消费型 {@link JobRegistry.read} 返回的输出与读后状态。 */
export interface JobRead {
  /** 自模型游标以来追加的环形缓冲区块，按偏移顺序；包含所有通道。 */
  chunks: readonly JobChunk[]
  /** 游标是否落到了最老的保留字节之下，即 `chunks` 之前是否有字节缺失。 */
  lossy: boolean
  /** 生产者的 {@link JobOutcome.result}，只在结算后的首次读取时交出。 */
  result?: string
  /** 读取时刻的任务状态。 */
  job: JobView
}

/** 一次非消费型 {@link JobRegistry.readAt} 的结果。 */
export interface JobOutputRead {
  /** 与 `[from, total)` 相交的保留块，按偏移顺序。 */
  chunks: readonly JobChunk[]
  /**
   * 续读偏移——环形缓冲区当前的 `total`。它总是块边界：追加整块落地，裁剪只会推进块的起点，
   * 而消费者正是在这一假设下拼接 `chunks`，所以提供方若给出半个块就会静默地重复文本。
   */
  next: number
  /** `from` 是否落到了最老的保留字节之下，即 `chunks` 之前是否有字节缺失。 */
  lossy: boolean
}

/**
 * 一个任务为什么结算：它的生产者自己结束（`producer`）、一次 {@link JobRegistry.kill}
 * 抢先发生（`kill`），或所有者/服务销毁取消了它（`teardown`）——后者的所有者已经没有读者了。
 */
export type JobSettleCause = 'producer' | 'kill' | 'teardown'

/**
 * 一个生命周期或输出事件。生命周期事件携带任务在所宣告的提交之后的投影；`output`
 * 只携带 id 与新的总长，这样观察者可以据自己的游标安排一次 {@link JobRegistry.readAt}，
 * 而注册表从不推送载荷。
 */
export type JobEvent =
  | {
    /** 注册提交、进度行变更、stopping 转换，或从可见集合中被移除。 */
    readonly type: 'registered' | 'progress' | 'stopping' | 'removed'
    readonly job: JobView
  }
  | {
    readonly type: 'settled'
    readonly job: JobView
    readonly cause: JobSettleCause
    /**
     * 本次结算是否释放了一个在世的 {@link JobRegistry.wait}。那个等待者的调用方会把终态
     * 投影当作自己的结果拿到，所以完成上报方把已被等待的结算视为已投递，只上报未被等待的那些。
     * 在结算之前就已超时或被中止的等待不算数。
     */
    readonly awaited: boolean
  }
  | {
    readonly type: 'output'
    readonly id: JobId
    /** 所属会话；无主任务没有。 */
    readonly owner?: SessionId
    /** 追加之后（或结算时，即流结束时）环形缓冲区的总长。 */
    readonly total: number
  }

/**
 * 一个订阅能听到谁。`{ owner }` 投递该会话的任务加上每一个无主任务（即该会话能看到的集合）。
 * `{ owners: 'scope' }` 投递订阅上下文之下组合出的那些所有者——一个注册表服务进程内的每种
 * 组合，挂载在某个 preset 下的订阅不应听到另一个 preset 的 agent。`{ owners: 'all' }` 投递一切。
 */
export type JobEventFilter =
  | { readonly owner: SessionId }
  | { readonly owners: 'all' | 'scope' }

/** 事件回调；由注册表做隔离，从不被 await。 */
export type JobEventListener = (event: JobEvent) => void

/** 注册表的事件流。 */
export interface JobEvents {
  /**
   * 注册一个随 effect 作用域生效的监听器。事件在所宣告的提交之后同步派发；一个任务的
   * 第一个事件是 `registered`，而 `settled` 事件在释放每个等待者之后发出。服务销毁之后
   * 不会再有监听器运行。
   * @param filter - 投递哪些所有者的事件。
   * @param listener - 接收每个匹配的事件。
   * @returns 注销该监听器的 disposer。
   */
  subscribe(filter: JobEventFilter, listener: JobEventListener): () => void
}
