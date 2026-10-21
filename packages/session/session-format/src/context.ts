import type {
  SessionFormatEvent,
  SessionFormatEventRun,
  SessionFormatMigrationContext,
} from './types.ts'

/** 将紧凑 run 展开为保留事件的迁移输出上下文。 */
export class SessionFormatEventCollector implements SessionFormatMigrationContext {
  /** 本收集器按源顺序保留的事件。 */
  readonly values: SessionFormatEvent[] = []

  /**
   * 保留一个已确定事件。
   * @param event - 上游阶段发出的已确定事件。
   */
  emitEvent(event: SessionFormatEvent): void {
    this.values.push(event)
  }

  /**
   * 将一个紧凑 run 直接展开为保留事件。
   * @param run - 上游阶段发出的紧凑事件 run。
   */
  emitRun(run: SessionFormatEventRun): void {
    for (const event of run.expand()) this.values.push(event)
  }
}
