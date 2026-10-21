/**
 * 后台任务能力 seam（`ctx.jobs`）的进程内提供者。它把每个任务——生命周期状态、有界的
 * 输出环形缓冲区以及模型游标——都保存在内存中，并交出全新的投影与块的副本，绝不是活状态。
 *
 * 注册记录比生产者和控制器的 fiber 活得更久。Agent 或服务销毁会取消仍在运行的工作并
 * 等待合规的生产者；抛出错误的销毁取消只强制失败该条记录，并报告可能存在孤儿。
 * @module @deepseek-ai/dsh-jobs-local
 */

import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ScopedLayers, scopeOf } from '@deepseek-ai/dsh-scope'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { JobRegistry, JobId } from '@deepseek-ai/dsh-jobs'
import type {
  JobAppendOptions, JobEvent, JobEvents, JobHandle, JobKind, JobOutcome, JobOutputRead, JobOutputSource,
  JobRead, JobRegisteredData, JobSettleCause, JobSettledData, JobSpec, JobStatus, JobToolCall, JobView,
} from '@deepseek-ai/dsh-jobs'
import { JobEventHub, JobLayer } from './events.ts'
import { startPump } from './pump.ts'
import type { PumpHandle } from './pump.ts'
import { OutputRing } from './ring.ts'

/** 区分有界等待与调用方取消的超时码。 */
export const TASK_WAIT_TIMEOUT = 'TASK_WAIT_TIMEOUT'

/** 单个确切所有者桶中活跃任务的默认最大数量。 */
const DEFAULT_MAX_CONCURRENT_JOBS_PER_OWNER = 10

/** 每个任务在世时的默认环形缓冲区保留量，单位 UTF-8 字节。 */
const DEFAULT_RETAIN_BYTES = 256 * 1024

/** 任务结算后默认保留的环形缓冲区保留量，单位 UTF-8 字节。 */
const DEFAULT_SETTLED_RETAIN_BYTES = 16 * 1024

/** 拉取源的默认轮询间隔，单位毫秒。 */
const DEFAULT_PUMP_POLL_MS = 150

/** 进程内任务注册表的配置。 */
export interface Config {
  /**
   * 每个确切所有者或共享的无主桶中 `running` 加 `stopping` 任务的最大数量；
   * 省略时默认为 10。
   */
  maxConcurrentJobsPerOwner?: number
  /** 每个任务在世时的环形缓冲区保留量，单位 UTF-8 字节；省略时默认为 262144。 */
  retainBytes?: number
  /**
   * 任务结算后保留的环形缓冲区保留量，单位 UTF-8 字节；省略时默认为 16384。
   * 结算会在该上限之外额外保留模型游标尚未消费的每一个字节；随后第一次终态模型读取
   * 会裁剪到该上限。
   */
  settledRetainBytes?: number
  /** 任务拉取源的轮询间隔，单位毫秒；省略时默认为 150。 */
  pumpPollMs?: number
}

/**
 * 生产者写入的、在 {@link JobHandle} 与已注册记录之间共享的状态：启动器调用在提交之前
 * 通过它写入，此后同一个对象在任务的整个生命周期内服务。
 */
interface ProducerState {
  /** 直到结算清空它为止的实时进度行。 */
  progress: string | undefined
  /** 已提交的注册表记录；恰好在启动器调用期间为 undefined。 */
  job: TrackedJob | undefined
}

/** 注册表每个任务的可变记录（从不外发——见 {@link LocalJobRegistry.view}）。 */
interface TrackedJob {
  id: JobId
  toolCall: JobToolCall | undefined
  kind: JobKind
  label: string
  outputLimitBytes: number | undefined
  /** 确切的生命周期所有者；会话 id 授权由它派生。 */
  owner: Agent | undefined
  cancel: (reason?: string) => void
  status: JobStatus
  ring: OutputRing
  /** 模型的消费游标；{@link JobRegistry.readAt} 从不移动它。 */
  modelCursor: number
  /** 结算后的第一次读取是否已经交出了 `result`。 */
  resultDelivered: boolean
  /** 生产者共享的进度行与提交绑定。 */
  state: ProducerState
  /** 终态原因；已记录的 kill 原因在结算时并入。 */
  detail: string | undefined
  result: string | undefined
  startedAt: number
  finishedAt: number | undefined
  /** {@link JobRegistry.kill} 记录的原因，并入一次 `killed` 结算的 detail。 */
  killReason: string | undefined
  /** 一旦执行过 kill 或销毁取消就置位；结算把它作为 cause 报告。 */
  settleCause: JobSettleCause | undefined
  /** 终态记录被提交并宣告之后兑现。 */
  settled: Promise<void>
  /** {@link settled} 的 resolver，由第一次有效结算调用。 */
  markSettled: () => void
  /** 在世等待的可移除 resolver；超时/abort 会在任务结算之前注销。 */
  waitResolvers: Set<() => void>
  /** 注册表自有的、覆盖 spec 拉取源的泵，当它指名了源时存在。 */
  pump: PumpHandle | undefined
  /**
   * 每个拉取源在其最近一次读取时上报的溢出文件，按源下标排列；某个源没有保存文件时
   * 对应项为 undefined。它是源的元数据而非每块的元数据，因此能在环形缓冲区淘汰之后
   * 存活，并跟随某个源撤回其文件。
   */
  spillPaths: (string | undefined)[]
}

/** 对三个终态 {@link JobStatus} 值为 true。 */
function isTerminal(status: JobStatus): boolean {
  return status === 'completed' || status === 'killed' || status === 'failed'
}

/**
 * 内存中的 `jobs` 注册表。本实现所遵守的所有权、隔离与生命周期语义，
 * 见 `@deepseek-ai/dsh-jobs` 中的服务定义契约。
 */
export class LocalJobRegistry extends JobRegistry {
  static Config: z<Config> = z.object({
    maxConcurrentJobsPerOwner: z.number()
      .step(1)
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .default(DEFAULT_MAX_CONCURRENT_JOBS_PER_OWNER),
    retainBytes: z.number()
      .step(1)
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .default(DEFAULT_RETAIN_BYTES),
    settledRetainBytes: z.number()
      .step(1)
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .default(DEFAULT_SETTLED_RETAIN_BYTES),
    pumpPollMs: z.number()
      .step(1)
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .default(DEFAULT_PUMP_POLL_MS),
  })

  /** 由 Schemastery 填入默认值的活跃任务上限。 */
  private readonly maxConcurrentJobsPerOwner: number
  /** 由 Schemastery 填入默认值的在世环形缓冲区保留上限。 */
  private readonly retainBytes: number
  /** 由 Schemastery 填入默认值的已结算环形缓冲区保留上限。 */
  private readonly settledRetainBytes: number
  /** 由 Schemastery 填入默认值的拉取源轮询间隔。 */
  private readonly pumpPollMs: number
  private store = new Map<JobId, TrackedJob>()
  /**
   * 按注册它们的作用域分层存放的控制器与作用域订阅，形状与工具注册表一致：一份贡献归档到
   * 其注册上下文的作用域，而一次读取把全局层与所有者的作用域链取并集。
   *
   * 注册表是一个服务进程内所有组合的实例，所以一张扁平的表会以全进程的口径回答一个按
   * 所有者的问题：某个 preset 的任务控制会为一个自身组合没有加载任何控制器的 agent 保持
   * `start()` 开放，而一次结算会触达每个 preset 的通知监听器。分层让这两种读取都变成
   * 相对于所有者的。没有任何东西从某一层派生缓存，所以变更通知是空操作。
   */
  private readonly layers = new ScopedLayers<JobLayer>(() => new JobLayer(), () => {})
  private readonly hub: JobEventHub
  /** 附带了作用域清理的所有者 agent，映射到确切的 disposer。 */
  private ownerCleanups = new Map<Agent, () => Promise<void> | void>()
  /** 被脱离上下文的结算 continuation 与销毁所使用的服务上下文。 */
  private readonly selfCtx: Context

  constructor(ctx: Context, config: Config) {
    super(ctx)
    // Schemastery 在构造服务之前完成校验并填入默认值。
    const resolved = config as Required<Config>
    this.maxConcurrentJobsPerOwner = resolved.maxConcurrentJobsPerOwner
    this.retainBytes = resolved.retainBytes
    this.settledRetainBytes = resolved.settledRetainBytes
    this.pumpPollMs = resolved.pumpPollMs
    this.selfCtx = ctx
    this.hub = new JobEventHub(this.layers, (message) => { ctx.logger.warn(message) })
    ctx.effect(() => () => this.disposeAll(), 'jobs teardown')
  }

  /**
   * 绑定到访问方上下文的事件流：一个订阅是那个上下文的 effect，而 `{ owners: 'scope' }`
   * 指名的就是它的作用域。
   */
  get events(): JobEvents {
    const registrar = this.ctx
    return {
      subscribe: (filter, listener) => this.hub.subscribe(registrar, filter, listener),
    }
  }

  start(spec: JobSpec): JobId {
    const owner = this.resolveOwner(spec.owner)
    if (!this.servesOwner(owner)) {
      throw new Error('background jobs unavailable: no job controller serves this agent (load @deepseek-ai/dsh-tool-jobs in its composition)')
    }
    if (spec.kind.length === 0) throw new Error('invalid job kind: expected a non-empty string')
    if (spec.label.length === 0) throw new Error('invalid job label: expected a non-empty string')
    if (spec.outputLimitBytes !== undefined
      && (!Number.isSafeInteger(spec.outputLimitBytes) || spec.outputLimitBytes <= 0)) {
      throw new Error(`invalid outputLimitBytes: expected a positive safe integer, got ${JSON.stringify(spec.outputLimitBytes)}`)
    }
    if (owner !== undefined) this.ensureOwnerCleanup(owner)

    const active = this.activeJobCount(owner)
    if (active >= this.maxConcurrentJobsPerOwner) {
      throw new Error(
        `background job limit reached for this owner (limit: ${this.maxConcurrentJobsPerOwner}); use job_kill to stop an unneeded job, wait for it to finish, then retry`,
      )
    }

    // 生产者使用与控制端及持久生命周期记录相同的短 UUID 身份。
    // 当本注册表仍持有先前的一个 id 时，重试一次冲突。
    let id: JobId
    do {
      id = JobId(`${spec.kind}-${randomUUID().replaceAll('-', '').slice(0, 16)}`)
    } while (this.store.has(id))
    const toolCall = spec.toolCall === undefined ? undefined : { ...spec.toolCall }
    const ring = new OutputRing()
    const state: ProducerState = { progress: undefined, job: undefined }
    const handle: JobHandle = {
      id,
      append: (text, options) => { this.appendRing(state, ring, text, options, 'producer') },
      updateProgress: (line) => { this.updateProgress(state, line) },
    }
    const hooks = spec.run(handle)

    let markSettled!: () => void
    const settled = new Promise<void>((resolve) => { markSettled = resolve })
    const job: TrackedJob = {
      id,
      toolCall,
      kind: spec.kind,
      label: spec.label,
      outputLimitBytes: spec.outputLimitBytes,
      owner,
      cancel: hooks.cancel.bind(hooks),
      status: 'running',
      ring,
      modelCursor: 0,
      resultDelivered: false,
      state,
      detail: undefined,
      result: undefined,
      startedAt: Date.now(),
      finishedAt: undefined,
      killReason: undefined,
      settleCause: undefined,
      settled,
      markSettled,
      waitResolvers: new Set(),
      pump: undefined,
      spillPaths: [],
    }
    // 绑定共享的生产者状态就是提交：在启动器内暂存的写入已经在环形缓冲区和 `state` 里，
    // 而之后的每次 handle 调用都会到达已注册的记录，以做终态检查与发信号。
    state.job = job
    this.store.set(id, job)
    this.recordSessionEvent(job)
    // 注册已完成，且从此处起不可能失败，所以可见集合确实发生了变化。宣告先于泵，因为泵会
    // 同步排空它的源一次，而那次排空可能追加并宣告输出：一个任务的第一个事件总是 `registered`。
    this.emit({ type: 'registered', job: this.view(job) }, owner)

    // 生产者的结算或注册表强制的结算会结束泵；泵的最后一次排空随后在本注册表裁剪
    // 环形缓冲区之前落地。
    const producerDone = hooks.done.then(
      outcome => ({ outcome, producerReported: true }),
      (error: unknown): { outcome: JobOutcome; producerReported: boolean } => {
        // 隔离一次生产者契约违例（`done` 被拒绝），这样清理与等待者不会挂住。
        this.selfCtx.logger.warn(`jobs: job ${job.id} producer done promise rejected (producer contract violation): ${String(error)}`)
        return { outcome: { status: 'failed', detail: String(error) }, producerReported: false }
      },
    )
    if (spec.output !== undefined && spec.output.length > 0) {
      job.pump = startPump(
        spec.output.map(source => this.guardSource(job, source)),
        {
          append: (text, options) => { this.appendRing(state, ring, text, options, 'pump') },
          spill: (index, path) => { job.spillPaths[index] = path },
        },
        this.pumpPollMs,
        Promise.race([producerDone, settled]),
      )
    }
    void producerDone.then(async ({ outcome, producerReported }) => {
      if (job.pump !== undefined) await job.pump.done
      this.settle(job, outcome, job.settleCause ?? 'producer', producerReported)
    })
    return id
  }

  list(caller?: SessionId): JobView[] {
    return [...this.store.values()]
      .filter(job => job.owner === undefined || job.owner.id === caller)
      .map(job => this.view(job))
  }

  get(id: JobId, caller?: SessionId): JobView {
    return this.view(this.expect(id, caller))
  }

  read(id: JobId, caller?: SessionId): JobRead {
    return this.readJob(this.expect(id, caller))
  }

  readAt(id: JobId, from: number, caller?: SessionId): JobOutputRead {
    const job = this.expect(id, caller)
    if (!Number.isSafeInteger(from) || from < 0) {
      throw new Error(`invalid output read offset: expected a non-negative safe integer, got ${JSON.stringify(from)}`)
    }
    return job.ring.readFrom(from)
  }

  kill(id: JobId, caller?: SessionId, reason?: string): 'requested' | 'already-finished' {
    return this.killJob(this.expect(id, caller), reason)
  }

  async wait(id: JobId, timeoutMs: number, caller?: SessionId, signal?: AbortSignal): Promise<JobView> {
    return this.waitJob(this.expect(id, caller), timeoutMs, signal)
  }

  remove(id: JobId, caller?: SessionId): void {
    const job = this.expect(id, caller)
    if (!isTerminal(job.status)) throw new Error(`job ${id} is still ${job.status}; kill it and wait for settlement before removing it`)
    this.drop([job])
  }

  attachController(name: string): () => void {
    // 每次调用一个令牌，使重复的标签仍能各自独立卸载。
    const token = Symbol(name)
    return this.layers.effect(
      this.ctx,
      layer => layer.controllers.append(token),
      { label: 'jobs.attachController()' },
    )
  }

  /**
   * 把一个 spec 的所有者会话解析到它的活体 Agent。带所有者的注册需要 agent 注册表，
   * 且该会话此刻必须有一个活体实例：正是那个实例的销毁会取消并丢弃该任务。
   */
  private resolveOwner(session: SessionId | undefined): Agent | undefined {
    if (session === undefined) return undefined
    const agents = this.selfCtx.get('agents')
    if (agents === undefined) {
      throw new Error('background job ownership requires the agent registry (load @deepseek-ai/dsh-agent)')
    }
    const owner = agents.get(session)
    if (owner === undefined) {
      throw new Error(`session "${session}" has no live agent (background job owner must be live)`)
    }
    return owner
  }

  /**
   * 一个已挂载的任务控制器能否收取并停止 `owner` 拥有的工作。全局层持有每一个从不限定
   * 作用域的上下文挂载的控制器——宿主组合自己的控制端——因此服务所有所有者；一个带作用域的
   * 控制器只服务其下组合出的那些 agent。
   * @param owner - 任务的所有者；无主工作为 undefined。
   * @returns 是否存在某个可达的控制器服务该所有者。
   */
  private servesOwner(owner?: Agent): boolean {
    if (!this.layers.global.controllers.isEmpty()) return true
    return this.layers.chainLayers(owner === undefined ? undefined : scopeOf(owner.ctx))
      .some(layer => !layer.controllers.isEmpty())
  }

  /** 统计某个确切所有者或共享的无主桶的权威活跃记录数。 */
  private activeJobCount(owner: Agent | undefined): number {
    let count = 0
    for (const job of this.store.values()) {
      if (job.owner === owner && (job.status === 'running' || job.status === 'stopping')) count += 1
    }
    return count
  }

  /** 查找一个任务并强制校验调用方的访问权。 */
  private expect(id: JobId, caller?: SessionId): TrackedJob {
    const job = this.store.get(id)
    if (job === undefined) throw new Error(`unknown job ${id}`)
    this.assertAccess(job, caller)
    return job
  }

  /**
   * 隔离栅栏：一个带所有者的任务只对其会话 id 匹配的调用方可达（`!== undefined` 语义
   * ——无主任务是开放的，而没有调用方的视图永远无法匹配一个带所有者的任务）。
   */
  private assertAccess(job: TrackedJob, caller: SessionId | undefined): void {
    if (job.owner !== undefined && job.owner.id !== caller) {
      throw new Error(`job ${job.id} belongs to another session`)
    }
  }

  /** 从可变记录投影出一个全新的只读视图。 */
  private view(job: TrackedJob): JobView {
    const owner = job.owner?.id
    const spillPaths = [...new Set(job.spillPaths.filter((path): path is string => path !== undefined))]
    return {
      id: job.id,
      kind: job.kind,
      label: job.label,
      ...owner !== undefined ? { owner } : {},
      ...job.outputLimitBytes !== undefined ? { outputLimitBytes: job.outputLimitBytes } : {},
      status: job.status,
      ...job.state.progress !== undefined ? { progress: job.state.progress } : {},
      ...job.detail !== undefined ? { detail: job.detail } : {},
      startedAt: job.startedAt,
      ...job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {},
      output: {
        total: job.ring.total,
        earliest: job.ring.earliest,
        ...spillPaths.length > 0 ? { spillPaths } : {},
      },
    }
  }

  private emit(event: JobEvent, owner: Agent | undefined): void {
    this.hub.emit(event, owner)
  }

  /** 在活订阅者或完成等待者作出反应之前发布已提交的事实。 */
  private recordSessionEvent(
    job: TrackedJob,
    settlement?: Pick<JobSettledData, 'finishedAt' | 'status' | 'cause' | 'producerReported' | 'detail'>,
  ): void {
    const owner = job.owner
    if (owner === undefined) return
    const session = owner.session
    const data: JobRegisteredData = {
      jobId: job.id, owner: owner.id,
      kind: job.kind, label: job.label, startedAt: job.startedAt,
      ...job.toolCall !== undefined ? { toolCall: job.toolCall } : {},
    }
    try {
      if (settlement === undefined) session.append('job/registered', data)
      else session.append('job/settled', { ...data, ...settlement })
    } catch (error: unknown) {
      // 记录失败不会让已启动的工作变成孤儿，也不会阻止等待者被释放。
      this.selfCtx.logger.warn(`jobs: failed to record lifecycle for ${job.id}: ${String(error)}`)
    }
  }

  /**
   * 从模型游标消费环形缓冲区；结果搭在结算之后的第一次读取上。终态读取正是已结算的流
   * 降到已结算上限的时点：结算为它保留了每一个未消费的字节。
   */
  private readJob(job: TrackedJob): JobRead {
    const read = job.ring.readFrom(job.modelCursor)
    job.modelCursor = job.ring.total
    const result = isTerminal(job.status) && !job.resultDelivered ? job.result : undefined
    if (result !== undefined) job.resultDelivered = true
    if (isTerminal(job.status)) job.ring.trim(this.settledRetainBytes)
    return {
      chunks: read.chunks,
      lossy: read.lossy,
      ...result !== undefined ? { result } : {},
      job: this.view(job),
    }
  }

  private killJob(job: TrackedJob, reason?: string): 'requested' | 'already-finished' {
    if (isTerminal(job.status)) return 'already-finished'
    // 先取消，这样抛出时生命周期状态保持不变。
    job.cancel(reason)
    job.status = 'stopping'
    // 有意让最后一个写入者胜出：detail 报告的是最新的 kill 意图。
    if (reason !== undefined) job.killReason = reason
    job.settleCause = 'kill'
    this.emit({ type: 'stopping', job: this.view(job) }, job.owner)
    return 'requested'
  }

  private async waitJob(job: TrackedJob, timeoutMs: number, signal?: AbortSignal): Promise<JobView> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`invalid wait timeout: expected a positive number of milliseconds, got ${JSON.stringify(timeoutMs)}`)
    }
    if (!isTerminal(job.status)) {
      if (signal?.aborted) throw new Error('wait aborted')
      // 带作用域的 deadline 把一次成功的等待超时与调用方取消区分开来，
      // 并在每次退出时清掉它的定时器。
      using d = deadline(signal, timeoutMs, TASK_WAIT_TIMEOUT)
      await new Promise<void>((resolve, reject) => {
        const onSettled = (): void => {
          job.waitResolvers.delete(onSettled)
          d.signal.removeEventListener('abort', onAbort)
          resolve()
        }
        const onAbort = (): void => {
          job.waitResolvers.delete(onSettled)
          // 已结算的任务无法到达这里：结算在宣告之前释放每一个等待者，而每个被释放的
          // 等待者在同一个同步区间内摘掉这个监听器，因此任何对结算作出反应的东西都不可能
          // 中止一个该结算已经欠下的等待。
          if (timeoutOf(d.signal, TASK_WAIT_TIMEOUT) !== undefined) {
            resolve()
          } else {
            reject(new Error('wait aborted'))
          }
        }
        job.waitResolvers.add(onSettled)
        d.signal.addEventListener('abort', onAbort, { once: true })
      })
    }
    return this.view(job)
  }

  /**
   * 向环形缓冲区追加一个块。针对已结算任务的生产者块会被记日志并丢弃；注册表自己的泵在
   * 结算（一次强制结算可能先于生产者的结算）之后静默排空。在启动器调用内暂存的块会被
   * 保留，且不通知任何观察者——注册提交会发布它。
   */
  private appendRing(
    state: ProducerState,
    ring: OutputRing,
    text: string,
    options: JobAppendOptions | undefined,
    writer: 'producer' | 'pump',
  ): void {
    const job = state.job
    if (job !== undefined && isTerminal(job.status)) {
      if (writer === 'producer') this.selfCtx.logger.warn(`jobs: append to settled job ${job.id} dropped`)
      return
    }
    if (!ring.append(text, options, this.retainBytes)) return
    if (job !== undefined) this.emitOutput(job)
  }

  /**
   * 隔离一个失败的拉取源：第一次抛出被记日志，此后该源读起来就像已耗尽，于是任务带着
   * 环形缓冲区里已有的内容跑到它自己的结算，而不是卡死在一次泵故障上。
   */
  private guardSource(job: TrackedJob, source: JobOutputSource): JobOutputSource {
    let failed = false
    return {
      ...source.channel !== undefined ? { channel: source.channel } : {},
      read: (fromByte) => {
        if (failed) return { text: '', nextOffset: fromByte, lossy: false }
        try {
          return source.read(fromByte)
        } catch (error: unknown) {
          failed = true
          this.selfCtx.logger.warn(`jobs: output source for ${job.id} failed; its stream stops here: ${String(error)}`)
          return { text: '', nextOffset: fromByte, lossy: false }
        }
      },
    }
  }

  /** 宣告某个任务的环形缓冲区前进了（追加或结算）。 */
  private emitOutput(job: TrackedJob): void {
    const owner = job.owner?.id
    this.emit({ type: 'output', id: job.id, ...owner !== undefined ? { owner } : {}, total: job.ring.total }, job.owner)
  }

  /**
   * 通过生产者接口替换实时进度行；针对已结算任务的写入会被记日志并丢弃。在启动器调用内
   * 暂存的写入会作为已注册投影的初值，且不通知任何观察者。
   */
  private updateProgress(state: ProducerState, line: string): void {
    const job = state.job
    if (job !== undefined && isTerminal(job.status)) {
      this.selfCtx.logger.warn(`jobs: progress update on settled job ${job.id} dropped`)
      return
    }
    state.progress = line
    if (job !== undefined) this.emit({ type: 'progress', job: this.view(job) }, job.owner)
  }

  /**
   * 记录第一个终态结果，释放等待者，然后宣告这次结算。先到先得使销毁期的强制失败能够
   * 顶住迟到的生产者结算。settled 事件跟随每一个被释放的等待者，并报告是否释放过：已超时
   * 或被中止的等待早已离开该集合，所以只有仍被欠着投影的等待才算数。
   */
  private settle(job: TrackedJob, outcome: JobOutcome, cause: JobSettleCause, producerReported: boolean): void {
    if (isTerminal(job.status)) return
    job.status = outcome.status
    // 一次 killed 结算在其 detail 中带上已记录的 kill 原因：生产者事实在前
    // （`signal: SIGTERM; cancelled by the user`）。一个跑赢了它的 kill 请求的任务
    // （结算为 `completed`/`failed`）只保留生产者的 detail——原因描述的是一次从未落地的 kill。
    if (outcome.status === 'killed' && job.killReason !== undefined) {
      job.detail = outcome.detail !== undefined
        ? `${outcome.detail}; ${job.killReason}`
        : job.killReason
    } else if (outcome.detail !== undefined) {
      job.detail = outcome.detail
    }
    job.state.progress = undefined
    job.result = outcome.result
    job.finishedAt = Date.now()
    this.recordSessionEvent(job, {
      finishedAt: job.finishedAt, status: outcome.status, cause, producerReported,
      ...job.detail !== undefined ? { detail: job.detail } : {},
    })
    // 结算结束这条流：在任何观察者读到终态投影之前就裁剪到已结算上限，但绝不裁到模型
    // 游标尚未消费的字节之下。一个在第一次模型读取之前就结束的任务，会一直保留在世上限
    // 所保留的一切，直到那次读取发生。
    job.ring.trim(Math.max(this.settledRetainBytes, job.ring.total - job.modelCursor))
    const waitResolvers = [...job.waitResolvers]
    job.waitResolvers.clear()
    for (const resolveWait of waitResolvers) resolveWait()
    job.markSettled()
    this.emit({ type: 'settled', job: this.view(job), cause, awaited: waitResolvers.length > 0 }, job.owner)
    // 环形缓冲区的流随结算结束；信号跟随已提交的结算，这样被它唤醒的观察者读到的就是终态。
    this.emitOutput(job)
  }

  /**
   * 通过确切所有者的作用域挂载一个被 await 的清理。它能在生产者重载之后存活，并汇入
   * agent 的静默；保留下来的 disposer 让服务销毁能够卸载这个跨 fiber 的 effect。
   */
  private ensureOwnerCleanup(owner: Agent): void {
    if (this.ownerCleanups.has(owner)) return
    // 只在挂载成功之后记录；正在销毁的作用域会拒绝新的 effect。
    const detach = owner.ctx.effect(() => async () => {
      this.ownerCleanups.delete(owner)
      await this.disposeOwned(owner)
    }, 'jobs.ownerCleanup()')
    this.ownerCleanups.set(owner, detach)
  }

  /** 取消、等待终态记录，并丢弃某一个确切 agent 生命周期拥有的全部任务。 */
  private async disposeOwned(owner: Agent): Promise<void> {
    const owned = [...this.store.values()].filter(job => job.owner === owner)
    this.cancelForTeardown(owned, 'owner disposed')
    await Promise.all(owned.map(job => job.settled))
    this.drop(owned)
  }

  /** 丢弃已结算的记录并宣告每次移除——这是唯一一种不体现在每任务记录上的可见集合变化。 */
  private drop(jobs: readonly TrackedJob[]): void {
    for (const job of jobs) {
      this.store.delete(job.id)
      this.emit({ type: 'removed', job: this.view(job) }, job.owner)
    }
  }

  /**
   * 取消在世的任务，等待结算，丢弃每条记录，并卸载所有者的 effect。抛出的取消被强制失败，
   * 以避免销毁期死锁。
   */
  private async disposeAll(): Promise<void> {
    const all = [...this.store.values()]
    this.cancelForTeardown(all, 'jobs service disposed')
    await Promise.all(all.map(job => job.settled))
    // 挂载在本服务之外的订阅者——任务控制器的行流从它自己的上下文注册——在这里仍然可达。
    // 不做这些移除，它会在注册表重载之后继续保留它最后收到的那些行。
    this.drop(all)
    // 在共享存储静默之后卸载跨 fiber 的所有者 effect。
    const ownerCleanups = [...this.ownerCleanups.values()]
    this.ownerCleanups.clear()
    await Promise.all(ownerCleanups.map(cleanup => Promise.resolve(cleanup())))
  }

  /**
   * 在销毁期间逐个隔离地取消任务。抛出的取消会强制失败该记录并报告可能存在孤儿；一个
   * 返回了却没有结算的取消，与一次缓慢的停止无从区分，可能拖住流程。
   */
  private cancelForTeardown(jobs: TrackedJob[], reason: string): void {
    for (const job of jobs) {
      if (isTerminal(job.status)) continue
      // 从此处起，无论什么来结算这个任务，它的所有者或服务都正在被销毁：结算宣告
      // `teardown`，这样完成上报方就不会去寻址一个已经不存在的读者。
      job.settleCause = 'teardown'
      try {
        job.cancel(reason)
        job.status = 'stopping'
        // 销毁要等到生产者释放之后才走到结算，而一次缓慢的停止会推迟它；在这里宣告这个
        // 转换，正是让观察者不会在那一整段窗口里都显示 `running` 的原因。
        this.emit({ type: 'stopping', job: this.view(job) }, job.owner)
      } catch (error: unknown) {
        const detail = `cancel threw during teardown; work may be orphaned: ${String(error)}`
        this.selfCtx.logger.warn(`jobs: cancel of ${job.id} threw during teardown; job record forced failed and work may be orphaned: ${String(error)}`)
        this.settle(job, { status: 'failed', detail }, 'teardown', false)
      }
    }
  }
}

export default LocalJobRegistry
