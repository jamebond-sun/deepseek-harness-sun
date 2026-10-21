/** Host 范围内的持久化提醒，以及共享的人类/模型管理面。 */
import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { Context, Service } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionActivity } from '@deepseek-ai/dsh-workspace'
import { ScheduleRuntime } from './runtime.ts'
import { scheduleDomain } from './storage.ts'
import { deliveryHistoryPage } from './delivery-history.ts'
import { resolveScheduleUpdate } from './update.ts'
import {
  foldScheduleEvents, ScheduleInputError, ScheduleLogError, ScheduleId, createAfterScheduleRecord, createAtScheduleRecord,
  createEveryScheduleRecord, createDailyScheduleRecord, createWeeklyScheduleRecord, createCronScheduleRecord,
  scheduleTitle,
} from './domain.ts'
import type {
  DeliveryRetentionBounds, ScheduleCatalogEntry, ScheduleCreateRequest, ScheduleDeleteRequest, ScheduleDeleteResult,
  ScheduleDeliveryHistoryRequest, ScheduleDeliveryHistoryResult, ScheduleListRequest, ScheduleRecord,
  ScheduleUpdateRequest, ScheduleUpdateResult, SubagentSessionError,
} from './types.ts'

export type * from './types.ts'
export { scheduleDomain } from './storage.ts'
export type { ScheduleTask } from './storage.ts'
export type { RecurringOccurrence } from './domain.ts'
export {
  SCHEDULE_CHANGE_VERSION,
  MIN_EVERY_INTERVAL_SECONDS,
  MAX_TITLE_LENGTH,
  REQUIRED_TITLE_MESSAGE,
  ScheduleId,
  ScheduleInputError,
  ScheduleLogError,
  canonicalizeCronExpression,
  createAfterScheduleRecord,
  createAtScheduleRecord,
  createEveryScheduleRecord,
  createDailyScheduleRecord,
  createWeeklyScheduleRecord,
  createCronScheduleRecord,
  decodeScheduleChange,
  decodeScheduleRecord,
  foldScheduleEvents,
  isRecurringScheduleRecord,
  normalizeWeekdays,
  parseCronInput,
  parseWeeklyInput,
  renderReminderFraming,
  renderRecurringReminderBatchFraming,
  resolveEveryOccurrence,
  resolveDailyOccurrence,
  resolveWeeklyOccurrence,
  resolveCronOccurrence,
  resolveRecurringOccurrence,
  scheduleTitle,
  scheduleView,
  weeklyTime,
} from './domain.ts'


declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host 范围内的持久化提醒管理。 */
    schedule: ScheduleService
  }
}

/** Host Schedule domain 的配置。 */
export interface Config {
  /**
   * 每个任务保留的投递历史窗口，以天为单位；省略时默认为 30。
   * 裁剪发生在追加确认的时候，而 `lastDelivery` 始终保留。
   */
  deliveryHistoryDays?: number
  /**
   * 每个任务保留的投递记录数；省略时默认为 200。
   * 该上限与窗口二者取更严格者，最新记录被保留。
   */
  deliveryHistoryRecords?: number
}

/** 当部署未声明保留窗口时应用的投递历史窗口。 */
const DEFAULT_DELIVERY_HISTORY_DAYS = 30

/** 当部署未声明记录上限时应用的投递历史记录上限。 */
const DEFAULT_DELIVERY_HISTORY_RECORDS = 200

/**
 * 共享的管理服务；读取、删除与定时编辑都绝不激活 Session。
 *
 * `sessionPersistence` 是一个加载顺序要求，而非被直接调用的服务：
 * 一次投递只有在 `ctx.sessions.flush()` 报告有 `session/flush` 监听器参与
 * 时才提交；而提供该服务的持久化后端，正是注册该监听器的插件。
 */
export class ScheduleService extends TypertRemoteService {
  static inject = ['agents', 'sessions', 'storageDomain', 'sessionController', 'sessionPersistence']

  static Config: z<Config> = z.object({
    deliveryHistoryDays: z.number().step(1).min(1).max(3650).default(DEFAULT_DELIVERY_HISTORY_DAYS),
    deliveryHistoryRecords: z.number().step(1).min(1).max(10_000).default(DEFAULT_DELIVERY_HISTORY_RECORDS),
  })

  /** 与追加确认的运行时共享的、已解析的保留上限。 */
  private readonly retention: DeliveryRetentionBounds
  private readonly ready: Promise<Domain<typeof scheduleDomain>>
  private readonly initialized: PromiseLike<unknown>
  private chain: Promise<unknown> = Promise.resolve()
  private runtime: ScheduleRuntime | undefined
  private stopping = false

  /**
   * @param ctx - 持有存储、派发与 Session 恢复能力的 Host 服务。
   * @param config - 已校验的投递历史保留配置。
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'schedule')
    this.retention = {
      days: config.deliveryHistoryDays ?? DEFAULT_DELIVERY_HISTORY_DAYS,
      records: config.deliveryHistoryRecords ?? DEFAULT_DELIVERY_HISTORY_RECORDS,
    }
    this.ready = ctx.storageDomain.open(scheduleDomain).then(async (domain) => {
      for (const [key, task] of domain.table('tasks').entries()) {
        if (key !== task.record.id) {
          // 键不匹配才是可操作的失败；一个 reject 的 close 不应取代它。
          try {
            await domain.close()
          } catch (error: unknown) {
            ctx.logger.warn(`schedule: closing the domain after a key mismatch failed: ${String(error)}`)
          }
          throw new Error(`schedule: stored task key "${key}" differs from record id "${task.record.id}"`)
        }
      }
      return domain
    })
    this.initialized = ctx.effect(async () => {
      const domain = await this.ready
      let cleanup: () => Promise<void>
      try {
        cleanup = ctx.effect(() => async () => {
          this.stopping = true
          await this.runtime?.dispose()
          await this.chain // 链中的失败在已返回给调用方之后仍保留在此。
          await domain.close()
        })
      } catch (error) {
        this.stopping = true
        await domain.close()
        throw error
      }
      const tasks = domain.table('tasks')
      this.runtime = new ScheduleRuntime(ctx,
        () => [...tasks.entries()].map(([, task]) => task),
        work => this.serialize(work),
        async (task) => {
          await tasks.put(task.record.id, task)
          this.emitChanged()
        },
        this.retention)
      this.runtime.requestDrive()
      return cleanup
    })
    ctx.on('session/created', (session) => {
      // 历史 Schedule 事件仍可读，但不会填充 Host 任务。
      // 抛出的 `session/created` 监听器会回滚该 attach，因此一段不可读的
      // 遗留流必须在此告警，而不是阻塞 Session 创建。
      let activeLegacy = 0
      try {
        // oxlint-disable-next-line typescript/no-deprecated -- 针对遗留 Schedule 历史的显式告警。
        activeLegacy = foldScheduleEvents(session.ownEvents()).active.length
      } catch (error: unknown) {
        /* v8 ignore next -- foldScheduleEvents 会把每个被拒绝的流都归一化为 ScheduleLogError。 */
        if (!(error instanceof ScheduleLogError)) throw error
        ctx.logger.warn(`schedule: Session "${session.id}" historical events could not be read (${error.message}); the legacy reminder is ignored.`)
        return
      }
      if (activeLegacy > 0) {
        ctx.logger.warn(`schedule: Session "${session.id}" contains legacy reminders; recreate active reminders with schedule_create.`)
      }
    }, { global: true })
    // Host 任务的存活时间长于其 Session 的 Agent，因此归档准入读取的是
    // 已存储的行，而不是一个活动的运行时：一个提醒仍处于待发状态的空闲
    // Session 会拒绝归档，而一次归档停止会删除这些行，而不是让它们投递到
    // 一个已关闭的 Session 中。
    ctx.effect(() => {
      const activity = ctx.on('workspace/session-activity', async ({ sessionId }, next) => {
        const active = await this.list({ sessionId })
        const rest = await next()
        if (active.length === 0) return rest
        const own: SessionActivity = {
          kind: 'schedule',
          items: active.map(record => ({ id: record.id, label: record.title })),
        }
        return [own, ...rest]
      })
      const stop = ctx.on('workspace/session-stop', async ({ sessionId }) => {
        await this.stopSessionTasks(sessionId)
      })
      return () => {
        stop()
        activity()
      }
    }, 'schedule.archiveAdmission()')
  }

  async [Service.init](): Promise<void> {
    await this.initialized
  }

  /**
   * 创建一个绑定到调用方所选 Session 的提醒，而不激活它。
   *
   * 请求必须提供名称；缺失、修剪后为空或超长的名称会以 `invalid_prompt`
   * 被拒绝，而不是从提示推导出一个名称。被委派子级拥有的 Session 会以
   * `subagent_session` 被拒绝，因为投递永远无法触达它：所谓子级，就是
   * 其委派深度大于零的那个。记录基于请求加入串行化队列之前读取的时钟
   * 构建，因此一个排在较长操作后面的创建保留其请求时刻的锚点，并可能在
   * 队列执行到它时已经到期。
   * @param sessionId - 接收该提醒的原始 Session。
   * @param request - 已校验的工具选择器、必需的名称与提醒内容。
   * @param signal - 可选的取消信号，在持久化开始前（包括 FIFO 等待之后）被检查。
   * @returns 已持久化存储的 schedule。取消不会回滚一个进行中的写入。
   */
  async create(sessionId: SessionId, request: ScheduleCreateRequest, signal?: AbortSignal): Promise<ScheduleRecord> {
    if (Number(request.at !== undefined) + Number(request.after_seconds !== undefined)
      + Number(request.every_seconds !== undefined) + Number(request.daily !== undefined)
      + Number(request.weekly !== undefined) + Number(request.cron !== undefined) > 1) {
      throw new ScheduleInputError('invalid_selector', 'Exactly one reminder selector is required.')
    }
    const title = scheduleTitle(request.title)
    const id = ScheduleId(`schedule-${randomUUID()}`)
    const now = Date.now()
    let record: ScheduleRecord
    if (request.at !== undefined) {
      record = createAtScheduleRecord(id, request.prompt, request.at, now, title)
    }
    else if (request.after_seconds !== undefined) {
      record = createAfterScheduleRecord(id, request.prompt, request.after_seconds, now, title)
    }
    else if (request.every_seconds !== undefined) {
      record = createEveryScheduleRecord(id, request.prompt, request.every_seconds, now, title)
    }
    else if (request.daily !== undefined) record = createDailyScheduleRecord(id, request.prompt, request.daily, now, title)
    else if (request.weekly !== undefined) record = createWeeklyScheduleRecord(id, request.prompt, request.weekly, now, title)
    else if (request.cron !== undefined) record = createCronScheduleRecord(id, request.prompt, request.cron, now, title)
    else throw new ScheduleInputError('invalid_selector', 'Exactly one reminder selector is required.')
    return this.serialize(async () => {
      const refusal = this.reminderTargetRefusal(sessionId)
      if (refusal !== undefined) throw new ScheduleInputError('subagent_session', refusal.message)
      const domain = await this.getDomain()
      signal?.throwIfAborted()
      await domain.table('tasks').put(id, {
        sessionId, record, status: 'active', deliveryHistory: { records: [], earlierRecordsUnavailable: false },
      })
      this.emitChanged()
      this.runtime?.requestDrive()
      return record
    })
  }

  /**
   * 读取所选 Session 的活动任务，而不恢复其 Agent。
   * @param request - 请求任务列表的 Session。
   * @returns 按存储顺序排列的持久化提醒。
   */
  @Remote('list')
  async list(request: ScheduleListRequest): Promise<ScheduleRecord[]> {
    const domain = await this.getDomain()
    return [...domain.table('tasks').entries()]
      .filter(([, task]) => task.sessionId === request.sessionId && task.status === 'active')
      .map(([, task]) => task.record)
  }

  /**
   * 读取所有活动与非活动的 Host 提醒，连同其原始 Session 绑定。
   * 已删除的提醒没有对应行，因此不会出现在这里。
   * 不激活 Session，也不读取 Session 历史。
   * @returns 按 scheduledAt 升序、再按 id 字典序排列的提醒。
   */
  @Remote('catalog')
  async catalog(): Promise<ScheduleCatalogEntry[]> {
    const domain = await this.getDomain()
    return [...domain.table('tasks').entries()]
      .map(([, task]) => ({
        ...task.record, sessionId: task.sessionId, status: task.status,
        ...(task.lastDelivery === undefined ? {} : { lastDelivery: task.lastDelivery }),
      }))
      .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt) || a.id.localeCompare(b.id))
  }

  /**
   * 读取已保存的 inbox 投递，而不激活或读取原始 Session。
   * 任务自身的行提供了它的绑定，因此其记录通过这次查找仍可读。
   * @param request - Session 绑定、任务标识、显式上限与可选的排他消息游标。
   * @returns 按追加顺序由新到旧的投递，或任务/游标查找失败。
   * @throws 当 limit 不是 1 到 100 的安全整数时抛出 ScheduleInputError。
   */
  @Remote('history')
  async history(request: ScheduleDeliveryHistoryRequest): Promise<ScheduleDeliveryHistoryResult> {
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100) {
      throw new ScheduleInputError('invalid_rule', 'Delivery history limit must be a safe integer from 1 through 100.')
    }
    const task = (await this.getDomain()).table('tasks').get(request.id)
    if (task === undefined || task.sessionId !== request.sessionId) {
      return { id: request.id, code: 'schedule_not_found' }
    }
    return deliveryHistoryPage(task, request, this.retention)
  }

  /**
   * 删除所选 Session 下的一个任务，已排队消息保持原样。
   *
   * 该行被移除：任务不再安排投递，从 `list` 与 `catalog` 中消失，其已保存的
   * 投递记录也随之移除。绑定到被委派子级所拥有 Session 的任务仍然可删除，
   * 尽管创建与定时编辑会拒绝该绑定，因此在那条规则出现之前存储的任务
   * 依然可移除。
   * @param request - Session 与精确的任务标识。
   * @param signal - 可选的取消信号，在持久化开始前（包括 FIFO 等待之后）被检查。
   * @returns 该 Session 是否拥有一个被删除的任务。取消不会回滚一个进行中的写入。
   */
  @Remote('delete')
  async delete(request: ScheduleDeleteRequest, signal?: AbortSignal): Promise<ScheduleDeleteResult> {
    return this.serialize<ScheduleDeleteResult>(async () => {
      const tasks = (await this.getDomain()).table('tasks')
      signal?.throwIfAborted()
      const current = tasks.get(request.id)
      if (current === undefined || current.sessionId !== request.sessionId) {
        return { id: request.id, deleted: false, code: 'schedule_not_found' }
      }
      await tasks.delete(request.id)
      this.emitChanged()
      this.runtime?.requestDrive()
      return { id: request.id, deleted: true }
    })
  }

  /**
   * 在原始 Session 绑定内更新一个活动任务的名称、指令与定时，
   * 而不激活该 Session，也不改动已保存的投递记录。
   *
   * 每个提供的字段替换其已存储的值；省略的字段保持不变。仅修改名称或指令
   * 不会重置已提交的目标。被委派子级所拥有的 Session 返回不改动状态的
   * `subagent_session` 结果，因此一次编辑无法重新武装一个绑定到投递永远
   * 触达不到之 Session 的任务，而 Web 编辑器可以通过它本就渲染的普通
   * 结果来解释这次拒绝。
   * @param request - 任务绑定、完整观测记录，以及定时、名称与指令的任意组合。
   * @param signal - 在 domain 就绪与 FIFO 等待之后、持久化开始前检查的取消信号。
   * @returns 已提交的记录、空操作时的未变更记录，或不改动状态的输入/查找/冲突/拒绝结果。
   * 存储与生命周期失败会 reject；写入开始之后的取消不会回滚它。
   */
  @Remote('update')
  async update(request: ScheduleUpdateRequest, signal?: AbortSignal): Promise<ScheduleUpdateResult> {
    return this.serialize<ScheduleUpdateResult>(async () => {
      const refusal = this.reminderTargetRefusal(request.sessionId)
      if (refusal !== undefined) return refusal
      const tasks = (await this.getDomain()).table('tasks')
      signal?.throwIfAborted()
      const current = tasks.get(request.id)
      if (current === undefined || current.sessionId !== request.sessionId) {
        return { id: request.id, updated: false, code: 'schedule_not_found' }
      }
      if (current.status === 'inactive') return { id: request.id, updated: false, code: 'schedule_ended' }
      const result = resolveScheduleUpdate(current.record, request.expected, request.change, Date.now(), request)
      if (!('record' in result) || !result.updated) return result
      await tasks.put(request.id, { ...current, record: result.record })
      this.emitChanged()
      this.runtime?.requestDrive()
      return result
    })
  }

  /**
   * 派发一次提交后的 `schedule/changed` 通知，其中吞掉同步的监听器失败：
   * 每个调用点都只在其持久化任务写入落盘之后才发出，因此一个抛出的监听器
   * 既不能让调用方 reject，也不能跳过随后的 `requestDrive()`。
   */
  private emitChanged(): void {
    try {
      this.ctx.emit('schedule/changed')
    } catch (error: unknown) {
      // 只吞掉同步观察者异常：emit 会内联派发监听器，
      // 而 try 中没有别的东西在运行。该事件是通知，不是事务参与者。
      this.ctx.logger.warn(`schedule: schedule/changed listener failed: ${String(error)}`)
    }
  }

  private async getDomain(): Promise<Domain<typeof scheduleDomain>> {
    await this.initialized
    return this.ready
  }

  /**
   * 拒绝一个投递永远触达不到、因为被委派子级所拥有的 Session。
   *
   * 投递通过 `ctx.sessionController.resolveAgent` 解析绑定的 Session，
   * 而它会拒绝被委派子级的活动 Agent；针对此类 Session 的存储任务会永久
   * 处于逾期状态，并在每次 drive 时重试。两个可以武装投递的操作都在这里
   * 读取同一事实，而不是各自重述它：所谓被委派子级，就是其
   * {@link delegationDepthOf} 大于零的那个 —— 正是委派上限本身所强制执行的
   * 记账口径，它通过持久化头在冷恢复中存活。
   * @param sessionId - 任务将要绑定到的 Session。
   * @returns 针对被委派子级 Session 的稳定拒绝，或当该 Session 合规时返回 undefined。
   */
  private reminderTargetRefusal(sessionId: SessionId): SubagentSessionError | undefined {
    const agent = this.ctx.agents.get(sessionId)
    if (agent === undefined || delegationDepthOf(agent) === 0) return undefined
    return {
      code: 'subagent_session',
      message: 'This Session belongs to subagent routing, which never receives reminder delivery.',
    }
  }

  /**
   * 在工具所使用的队列内，移除为某个 Session 存储的每一个活动任务。
   *
   * 在同一个队列槽位中枚举并删除，正是让一次归档停止排在一个写入仍在
   * 进行中的创建之后的原因：若停止在队列之外读取该表，就可能漏掉创建
   * 正要提交的那一行，从而留下一个已武装的提醒。从这里重新进入公开的
   * `delete()` 会在这个队列上死锁，因此直接删除这些行。
   * @param sessionId - 其活动 Host 任务必须停止的 Session。
   */
  private async stopSessionTasks(sessionId: SessionId): Promise<void> {
    await this.serialize(async () => {
      const tasks = (await this.getDomain()).table('tasks')
      const active = [...tasks.entries()]
        .filter(([, task]) => task.sessionId === sessionId && task.status === 'active')
        .map(([, task]) => task.record.id)
      if (active.length === 0) return
      // 一次写入一行：domain 表没有批量删除，且每一行各自持久化，
      // 因此中途失败会让已经删除的行保持已提交。观察者会在失败到达
      // 调用方之前先听到该变更，而调用方仍会收到失败。
      let removed = false
      let failure: Error | undefined
      for (const id of active) {
        try {
          await tasks.delete(id)
          removed = true
        } catch (error: unknown) {
          // 每一行都会尝试：归档已经落地，因此这次停止跳过的一行会
          // 在一个运行时随后拒绝其模型步骤的 Session 中保持武装。
          // 一个不携带 Error 的 rejection 原因同样必须上报失败，
          // 因此在保留第一个之前先把它包装起来。
          failure ??= error instanceof Error ? error : new Error(`schedule stop failed: ${String(error)}`)
        }
      }
      if (removed) {
        this.emitChanged()
        this.runtime?.requestDrive()
      }
      if (failure !== undefined) throw failure
    })
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    if (this.stopping) return Promise.reject(new Error('Schedule service is stopping'))
    const pending = this.chain.then(work)
    this.chain = pending.catch(() => undefined) // 在调用方收到失败之后保持 FIFO 推进。
    return pending
  }
}

export default ScheduleService
