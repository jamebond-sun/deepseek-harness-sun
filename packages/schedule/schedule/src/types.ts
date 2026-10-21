/**
 * 持久化与面向模型的 Schedule 值类型。
 * @module @deepseek-ai/dsh-schedule
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-session/types'
// 仅类型：Workspace 注册表归档准入的族映射，本插件把 `schedule` 合并进去。
import type {} from '@deepseek-ai/dsh-workspace/types'

/** 稳定的全局唯一提醒标识。 */
export type ScheduleId = Branded<'ScheduleId'>

/** 由正延迟创建的持久化一次性提醒。 */
export interface AfterScheduleRecord {
  /** 全局唯一的任务标识。 */
  readonly id: ScheduleId
  /** 延迟一次性提醒的规则判别式。 */
  readonly kind: 'after'
  /** 必需的已存储任务名；已修剪、非空，且至多 120 个字符。 */
  readonly title: string
  /** 创建时提供的、已修剪的提醒内容。 */
  readonly prompt: string
  /** 创建时接受的正的安全整数延迟。 */
  readonly afterSeconds: number
  /** 四位年份的 RFC 3339 UTC 目标时刻。 */
  readonly scheduledAt: string
}

/** 由绝对时刻创建的持久化一次性提醒。 */
export interface AtScheduleRecord {
  /** 全局唯一的任务标识。 */
  readonly id: ScheduleId
  /** 绝对一次性提醒的规则判别式。 */
  readonly kind: 'at'
  /** 必需的已存储任务名；已修剪、非空，且至多 120 个字符。 */
  readonly title: string
  /** 创建时提供的、已修剪的提醒内容。 */
  readonly prompt: string
  /** 四位年份的 RFC 3339 UTC 目标时刻。 */
  readonly scheduledAt: string
}

/** 与创建时刻或最近一次间隔编辑对齐的持久化固定频率提醒。 */
export interface EveryScheduleRecord {
  /** 全局唯一的任务标识。 */
  readonly id: ScheduleId
  /** 固定频率重复提醒的规则判别式。 */
  readonly kind: 'every'
  /** 必需的已存储任务名；已修剪、非空，且至多 120 个字符。 */
  readonly title: string
  /** 创建时提供的、已修剪的提醒内容。 */
  readonly prompt: string
  /** 固定的安全整数间隔，永不低于一分钟。 */
  readonly everySeconds: number
  /** 活动时与锚点对齐的下一个 occurrence，或停用时的最后一次 occurrence。 */
  readonly scheduledAt: string
}

/** 持久化的每日墙上时钟提醒；时间间隙跳过该日期，重叠时采用较早的时刻。 */
export interface DailyScheduleRecord {
  /** 全局唯一的任务标识。 */
  readonly id: ScheduleId
  /** 每日墙上时钟提醒的规则判别式。 */
  readonly kind: 'daily'
  /** 必需的已存储任务名；已修剪、非空，且至多 120 个字符。 */
  readonly title: string
  /** 创建时提供的、已修剪的提醒内容。 */
  readonly prompt: string
  /** 归一化为 HH:mm:ss.SSS 的本地时间。 */
  readonly time: string
  /** 显式 IANA 时区；等价的定时编辑保留已存储的拼写。 */
  readonly timeZone: string
  /** 活动时已提交的下一个 UTC 时刻，或停用时的最后一次 occurrence。 */
  readonly scheduledAt: string
}

/** 持久化的每周墙上时钟提醒；时间间隙跳过该日期，重叠时采用较早的时刻。 */
export interface WeeklyScheduleRecord {
  /** 全局唯一的任务标识。 */
  readonly id: ScheduleId
  /** 每周墙上时钟提醒的规则判别式。 */
  readonly kind: 'weekly'
  /** 必需的已存储任务名；已修剪、非空，且至多 120 个字符。 */
  readonly title: string
  /** 创建时提供的、已修剪的提醒内容。 */
  readonly prompt: string
  /** 归一化为 HH:mm:ss.SSS 的本地时间。 */
  readonly time: string
  /** 显式的规范 IANA 时区；等价的定时编辑保留已存储的拼写。 */
  readonly timeZone: string
  /** 唯一且升序的 ISO 星期，周一 1 到周日 7。 */
  readonly weekdays: number[]
  /** 活动时已提交的下一个 UTC 时刻，或停用时的最后一次 occurrence。 */
  readonly scheduledAt: string
}

/** 持久化的 cron 墙上时钟提醒；时间间隙跳过该日期，重叠时采用较早的时刻。 */
export interface CronScheduleRecord {
  /** 全局唯一的任务标识。 */
  readonly id: ScheduleId
  /** 五字段 cron 墙上时钟提醒的规则判别式。 */
  readonly kind: 'cron'
  /** 必需的已存储任务名；已修剪、非空，且至多 120 个字符。 */
  readonly title: string
  /** 创建时提供的、已修剪的提醒内容。 */
  readonly prompt: string
  /** 规范的五字段 cron 表达式：分 时 日 月 周。 */
  readonly expression: string
  /** 显式 IANA 时区；等价的定时编辑保留已存储的拼写。 */
  readonly timeZone: string
  /** 活动时已提交的下一个 UTC 时刻，或停用时的最后一次 occurrence。 */
  readonly scheduledAt: string
}

/** 创建与定时编辑接受的每日本地时间选择器。 */
export interface DailyInput {
  /** 本地 HH:mm:ss 时间，可带一到三位小数。 */
  readonly time: string
  /** 显式的 UTC 或 IANA Area/Location 时区。 */
  readonly time_zone: string
}

/** 创建与定时编辑接受的每周本地时间与星期选择器。 */
export interface WeeklyInput {
  /** 本地 HH:mm:ss 时间，可带一到三位小数。 */
  readonly time: string
  /** 显式的 UTC 或 IANA Area/Location 时区。 */
  readonly time_zone: string
  /** 非空 ISO 星期集合，周一 1 到周日 7，且不重复。 */
  readonly weekdays: number[]
}

/** 创建与定时编辑接受的五字段 cron 选择器。 */
export interface CronInput {
  /** 五字段 Vixie cron 表达式：分 时 日 月 周。 */
  readonly expression: string
  /** 显式的 UTC 或 IANA Area/Location 时区。 */
  readonly time_zone: string
}

/** 创建与定时编辑接受的结构化本地日历输入。 */
export interface LocalAtInput {
  /** 四位年份的 ISO 日历日期。 */
  readonly date: string
  /** 本地墙上时钟时间，可带一到三位毫秒。 */
  readonly time: string
  /** 显式的 UTC 或 IANA Area/Location 时区。 */
  readonly time_zone: string
}

/** 创建与定时编辑接受的绝对选择器。 */
export type AtInput = string | LocalAtInput

/** 一次性任务的变体。 */
export type OneShotScheduleRecord = AfterScheduleRecord | AtScheduleRecord

/** 由版本 1 Session 事件持久化的一次性延迟，不含后来才有的 `title`。 */
export interface LegacyAfterScheduleRecord extends Omit<AfterScheduleRecord, 'title'> {
  /** 已存储的任务名；在名称存在之前写入的事件中没有该字段。 */
  readonly title?: string
}

/** 由版本 1 Session 事件持久化的绝对一次性提醒，不含后来才有的 `title`。 */
export interface LegacyAtScheduleRecord extends Omit<AtScheduleRecord, 'title'> {
  /** 已存储的任务名；在名称存在之前写入的事件中没有该字段。 */
  readonly title?: string
}

/** 由版本 1 Session 事件持久化的固定频率提醒，不含后来才有的 `title`。 */
export interface LegacyEveryScheduleRecord extends Omit<EveryScheduleRecord, 'title'> {
  /** 已存储的任务名；在名称存在之前写入的事件中没有该字段。 */
  readonly title?: string
}

/**
 * 冻结的 Session 事件与折叠词汇表；每日规则只属于 Host 存储。
 *
 * 在名称存在之前写入的版本 1 事件不持久化 `title` 成员，因此 `after`、
 * `at` 与 `every` 在没有该成员时也能解码并保持可读。Host 任务记录
 * 要求该成员，且永不持久化缺少它的记录。
 */
export type LegacyScheduleRecord =
  | LegacyAfterScheduleRecord
  | LegacyAtScheduleRecord
  | LegacyEveryScheduleRecord

/** 重复型 Host 任务的变体。 */
export type RecurringScheduleRecord = EveryScheduleRecord | DailyScheduleRecord | WeeklyScheduleRecord | CronScheduleRecord

/** 提醒规则与目标，连同其原始 Session 绑定一起存储。 */
export type ScheduleRecord = OneShotScheduleRecord | RecurringScheduleRecord

/** 持久化的 Session inbox 投递确认，而非模型执行完成。 */
export interface ScheduleDeliveryReceipt {
  /** 已投递 occurrence 的规范 UTC 目标时刻。 */
  readonly scheduledAt: string
  /** 在 Session 持久化确认投递之后采样的规范 UTC 时间。 */
  readonly deliveredAt: string
  /** 已投递消息的标识，同一重复批次中的任务共享它。 */
  readonly messageId: MessageId
}

/** 已保存的 inbox 投递，带有本 Host 记录时不可变的已发送提示。 */
export interface ScheduleDeliveryRecord extends ScheduleDeliveryReceipt {
  /** 为该 occurrence 发送的提示；遗留回执没有该字段。 */
  readonly prompt?: string
}

/** 浏览器安全的、带原始 Session 绑定的保留提醒。 */
export type ScheduleCatalogEntry = ScheduleRecord & {
  /** 该提醒到期时接收它的 Session。 */
  readonly sessionId: SessionId
  /** 已停用的提醒仍然可见，但永不再安排投递。 */
  readonly status: 'active' | 'inactive'
  /** 最近一次已被持久化确认的 inbox 投递（若可用）。 */
  readonly lastDelivery?: ScheduleDeliveryReceipt
}

/** 创建一条持久化的提醒记录。 */
export interface ScheduleCreateChange {
  readonly version: 1
  readonly operation: 'create'
  readonly schedule: LegacyScheduleRecord
}

/** 删除一个当前活动的提醒。 */
export interface ScheduleDeleteChange {
  readonly version: 1
  readonly operation: 'delete'
  readonly id: ScheduleId
}

/** 记录一个活动的一次性提醒已进入持久化派发历史。 */
export interface OneShotScheduleDispatchChange {
  readonly version: 1
  readonly operation: 'dispatch'
  readonly id: ScheduleId
}

/** 记录一次固定频率决策，并直接推进越过错过的 occurrence。 */
export interface EveryScheduleDispatchChange {
  readonly version: 1
  readonly operation: 'dispatch'
  readonly id: ScheduleId
  /** 用于选取最新到期 occurrence 的墙上时钟决策时间。 */
  readonly acceptedAt: string
}

/** 当前规则集所支持的持久化派发结构。 */
export type ScheduleDispatchChange = OneShotScheduleDispatchChange | EveryScheduleDispatchChange

/** 严格的版本 1 持久化 Schedule 变更联合类型。 */
export type ScheduleChange = ScheduleCreateChange | ScheduleDeleteChange | ScheduleDispatchChange

/** 由持久化记录与墙上时钟推导出的当前投递时序状态。 */
export type ScheduleState = 'scheduled' | 'overdue'

/** 由 Host 驱动的投递会在需要时恢复原始 Session。 */
export type ScheduleDeliveryMode = 'host'

/** 一个活动提醒的完整、面向模型的视图。 */
export type ScheduleView = ScheduleRecord & {
  /** 目标是否仍在未来。 */
  readonly state: ScheduleState
  /** 提醒投递永不离开其所属 session。 */
  readonly deliveryMode: ScheduleDeliveryMode
}

/** 针对空的、超长的或未修剪的提醒提示或名称返回的稳定错误。 */
export interface InvalidPromptError {
  readonly code: 'invalid_prompt'
  readonly message: string
}

/** 针对缺失、冲突或不受支持的规则选择器返回的稳定错误。 */
export interface InvalidSelectorError {
  readonly code: 'invalid_selector'
  readonly message: string
}

/** 针对非法规则或管理参数返回的稳定错误。 */
export interface InvalidRuleError {
  readonly code: 'invalid_rule'
  readonly message: string
}

/** 针对非法或不受支持的 IANA 时区返回的稳定错误。 */
export interface InvalidTimeZoneError {
  readonly code: 'invalid_time_zone'
  readonly message: string
}

/** 当绝对目标不是严格处于未来时返回的稳定错误。 */
export interface NotFutureError {
  readonly code: 'not_future'
  readonly message: string
}

/** 当计算出的时刻无法用四位 UTC 年份表示时返回的稳定错误。 */
export interface TimeOutOfRangeError {
  readonly code: 'time_out_of_range'
  readonly message: string
}

/** 当固定频率规则的运行频率高于支持范围时返回的稳定错误。 */
export interface FrequencyTooHighError {
  readonly code: 'frequency_too_high'
  readonly message: string
}

/** 当目标 Session 属于 subagent 路由（永不接收提醒投递）时返回的稳定错误。 */
export interface SubagentSessionError {
  readonly code: 'subagent_session'
  readonly message: string
}

/** 不泄露内部异常的稳定兜底错误。 */
export interface InternalScheduleError {
  readonly code: 'internal_error'
  readonly message: string
}

/** 封闭的 v1 Schedule 管理错误联合类型。 */
export type ScheduleToolError =
  | InvalidPromptError
  | InvalidSelectorError
  | InvalidRuleError
  | InvalidTimeZoneError
  | NotFutureError
  | TimeOutOfRangeError
  | FrequencyTooHighError
  | SubagentSessionError
  | InternalScheduleError

/** 规范的 `schedule_create` 值。 */
export type ScheduleCreateValue = ScheduleView | ScheduleToolError

/** 规范的 `schedule_list` 值。 */
export type ScheduleListValue = ScheduleView[] | ScheduleToolError

/** 成功的 `schedule_delete` 值，含不改动状态的未找到结果。 */
export type ScheduleDeleteResult =
  | { readonly id: ScheduleId; readonly deleted: true }
  | { readonly id: ScheduleId; readonly deleted: false; readonly code: 'schedule_not_found' }

/** 规范的 `schedule_delete` 值。 */
export type ScheduleDeleteValue = ScheduleDeleteResult | ScheduleToolError

declare module '@deepseek-ai/dsh-workspace/types' {
  interface SessionActivityKindMap {
    /** 该 session 的一个定时后续任务仍然活动。 */
    schedule: true
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * 带版本的 Schedule 变更。所属包在接受一个候选事件之前，
     * 会先校验完整的 session 局部迁移流。
     */
    'schedule/change': ScheduleChange
  }
}

/** 提醒创建选择器，由模型消费方与 Host 服务共享。 */
export interface ScheduleCreateRequest {
  /** 非空的提醒文本。 */
  prompt: string
  /** 必需的任务名，至多 120 个字符，修剪后非空；用于命名卡片、详情标题与任务列表。 */
  title: string
  /** 以秒为单位的相对一次性延迟。 */
  after_seconds?: number
  /** 绝对的一次性目标。 */
  at?: AtInput
  /** 以秒为单位的固定重复间隔。 */
  every_seconds?: number
  /** 显式 IANA 时区下的每日墙上时钟时间。 */
  daily?: DailyInput
  /** IANA 时区下的每周墙上时钟时间与显式的 ISO 星期集合。 */
  weekly?: WeeklyInput
  /** 在显式 IANA 时区下求值的五字段 cron 表达式。 */
  cron?: CronInput
}

/** 以 Session 为范围的任务列表，不激活 Agent。 */
export interface ScheduleListRequest {
  /** 原始的 Session 绑定。 */
  sessionId: SessionId
}

/** 在其原始 Session 绑定内标识一个任务的删除请求。 */
export interface ScheduleDeleteRequest extends ScheduleListRequest {
  /** 待移除的任务。 */
  id: ScheduleId
}

/** 仅定时的编辑；它可以选择与已存储记录不同的重复类型，而一次性目标使用绝对的 `at`。 */
export type ScheduleTimingChange =
  | { readonly kind: 'at'; readonly at: AtInput }
  | { readonly kind: 'every'; readonly every_seconds: number }
  | { readonly kind: 'daily'; readonly daily: DailyInput }
  | { readonly kind: 'weekly'; readonly weekly: WeeklyInput }
  | { readonly kind: 'cron'; readonly cron: CronInput }

/** 一次比较并更新请求所携带的替换任务名与指令。 */
export interface ScheduleUpdateContent {
  /** 至多 120 个字符的任务名，修剪后非空；省略时保留已存储的名称。 */
  readonly title?: string
  /** 提醒指令，修剪后非空；省略时保留已存储的指令。 */
  readonly prompt?: string
}

/** 原始 Session 绑定内的比较并更新请求。 */
export interface ScheduleUpdateRequest extends ScheduleDeleteRequest, ScheduleUpdateContent {
  /** 开始编辑时观测到的完整记录，含已提交的目标。 */
  readonly expected: ScheduleRecord
  /** 新的定时；其类型可能与已存储记录的类型不同，省略时保留已提交的目标。 */
  readonly change?: ScheduleTimingChange
}

/** 不改动状态的比较并更新结果：未知、已停用，或自读取后已变更。 */
export interface ScheduleUpdateMiss {
  readonly id: ScheduleId
  readonly updated: false
  readonly code: 'schedule_not_found' | 'schedule_ended' | 'schedule_conflict'
}

/** 成功的当前记录、不改动状态的查找/冲突失败，或非法的名称/指令/定时。 */
export type ScheduleUpdateResult =
  | { readonly id: ScheduleId; readonly updated: boolean; readonly record: ScheduleRecord }
  | ScheduleUpdateMiss
  | ScheduleToolError

/** 规范的 `schedule_update` 值：作为视图的已提交记录，或不改动状态的查找/冲突结果。 */
export type ScheduleUpdateValue = ScheduleView | ScheduleUpdateMiss | ScheduleToolError

/** 在一个 Session 绑定内、显式限定范围的已保存投递查询。 */
export interface ScheduleDeliveryHistoryRequest extends ScheduleDeleteRequest {
  /** 必需的页大小安全整数，范围 1 到 100。 */
  limit: number
  /** 上一页中最旧条目的消息标识；不包含在本页中。 */
  before?: MessageId
}

/** 追加某个任务的投递回执时应用的配置上限。 */
export interface DeliveryRetentionBounds {
  /** 以天为单位的保留窗口，从正在追加的确认往回度量。 */
  readonly days: number
  /** 每个任务最多保留的记录数；最新的被保留。 */
  readonly records: number
}

/** 由新到旧的已保存投递，或不改动状态的任务/游标查找失败。 */
export type ScheduleDeliveryHistoryResult =
  | {
    readonly id: ScheduleId
    readonly records: ScheduleDeliveryRecord[]
    /** 更早的投递记录是否可能不可用；缺失的回执永不被重建。 */
    readonly earlierRecordsUnavailable: boolean
    /** 仅在某次追加删除了已保存记录之后为 true；缺少遗留证据时为 false。 */
    readonly earlierRecordsPruned: boolean
    /** 当前的 Host 保留配置，投递写入方同样使用它。 */
    readonly retention: DeliveryRetentionBounds
    /** 返回的最旧消息标识，仅当仍有更旧的已保存记录时出现。 */
    readonly nextBefore?: MessageId
  }
  | { readonly id: ScheduleId; readonly code: 'schedule_not_found' | 'delivery_cursor_not_found' }

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** 持久化任务集合已变更；客户端需重新获取全局任务与 Session 活动目录。
     * @mode emit
     */
    'schedule/changed'(): void
  }
}
