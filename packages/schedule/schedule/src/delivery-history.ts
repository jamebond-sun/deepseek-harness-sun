/** 已保存投递记录的解读，以及不读取 Session 的、基于标识的分页。 */
import type { ScheduleTask } from './storage.ts'
import type { DeliveryRetentionBounds, ScheduleDeliveryHistoryRequest, ScheduleDeliveryHistoryResult, ScheduleDeliveryReceipt } from './types.ts'

/** 一天的毫秒数，即保留窗口所采用的单位。 */
const DAY_MS = 86_400_000

/**
 * 读取保留的历史；缺失历史时只暴露实际的遗留回执。
 * @param task - 不可变的已存储任务。
 * @returns 由旧到新的保留投递记录，且不改动存储。
 */
function deliveryHistoryOf(task: ScheduleTask): NonNullable<ScheduleTask['deliveryHistory']> {
  return task.deliveryHistory ?? {
    records: task.lastDelivery === undefined ? [] : [task.lastDelivery],
    earlierRecordsUnavailable: true,
  }
}

/**
 * 为同一次任务写入准备一条真实的 inbox 确认，与它的状态和目标一起写入。
 * 裁剪到配置的窗口与记录上限就在这里完成，因为这是唯一的写入路径：
 * domain 每次写入发布一整个单元文档，所以无界的数组会随着每一次确认
 * 不断撑大该文档。读取路径不声明自己的上限，因为超出 schema 限制的
 * 整单元文档会拒绝打开。
 * @param task - 提供不可变已发送提示与保留历史的任务。
 * @param receipt - Session 刷新成功后获得的确认。
 * @param bounds - 为追加历史所配置的保留窗口与记录上限。
 * @returns 回执与保留历史；调用方仅在任务持久化之后才发布它们。
 */
export function appendDelivery(
  task: ScheduleTask,
  receipt: ScheduleDeliveryReceipt,
  bounds: DeliveryRetentionBounds,
): Required<Pick<ScheduleTask, 'lastDelivery' | 'deliveryHistory'>> {
  const history = deliveryHistoryOf(task)
  const appended = [...history.records, { ...receipt, prompt: task.record.prompt }]
  const floor = Date.parse(receipt.deliveredAt) - bounds.days * DAY_MS
  const retained = appended
    .filter(record => Date.parse(record.deliveredAt) >= floor)
    .slice(-bounds.records)
  return {
    lastDelivery: receipt,
    deliveryHistory: {
      records: retained,
      earlierRecordsUnavailable: history.earlierRecordsUnavailable || retained.length !== appended.length,
      earlierRecordsPruned: history.earlierRecordsPruned === true || retained.length !== appended.length,
    },
  }
}

/**
 * 按追加顺序读取一页由新到旧的记录，与墙上时钟顺序无关。
 * @param task - 已针对所请求的 Session 绑定校验过的任务。
 * @param request - 已校验的显式页大小与可选的排他消息游标。
 * @param retention - 与投递写入方共享的当前配置上限。
 * @returns 复制出的投递记录，或游标未找到的结果。
 */
export function deliveryHistoryPage(
  task: ScheduleTask, request: ScheduleDeliveryHistoryRequest, retention: DeliveryRetentionBounds,
): ScheduleDeliveryHistoryResult {
  const history = deliveryHistoryOf(task)
  const end = request.before === undefined
    ? history.records.length
    : history.records.findIndex(record => record.messageId === request.before)
  if (end === -1) return { id: request.id, code: 'delivery_cursor_not_found' }
  const start = Math.max(0, end - request.limit)
  const records = history.records.slice(start, end).reverse().map(({ prompt, ...receipt }) => ({
    ...receipt, ...(prompt === undefined ? {} : { prompt }),
  }))
  const oldest = records.at(-1)
  return {
    id: request.id, records, earlierRecordsUnavailable: history.earlierRecordsUnavailable,
    earlierRecordsPruned: history.earlierRecordsPruned === true, retention: { ...retention },
    ...(oldest !== undefined && start > 0 ? { nextBefore: oldest.messageId } : {}),
  }
}
