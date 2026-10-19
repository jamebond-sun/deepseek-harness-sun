/**
 * 注册表发布之前，一个未发布 Session 的所有权。
 * @module @deepseek-ai/dsh-session/preparation
 */

import type { Session } from './index.ts'

/** provider 保留未发布状态的准备的选项。 */
export interface SessionPreparationOptions {
  /** Session 未发布时释放 provider 持有的状态。 */
  readonly release?: () => void
}

/**
 * 一个确切的未发布 Session 与使其保持可用的 provider 状态。
 * 释放是同步且幂等的。provider 自行决定释放时把 Session 归还缓存还是丢弃；
 * 发布可能在释放前消费该状态，使回调成为空操作。
 */
export class SessionPreparation implements Disposable {
  private released = false

  /** 用于设置与发布的确切 Session。 */
  readonly session: Session

  private constructor(
    session: Session,
    private readonly options: SessionPreparationOptions,
  ) {
    this.session = session
  }

  /**
   * 把一个未发布 Session 包进一个准备生命周期。
   * @param session - 确切的未发布 Session。
   * @param options - 可选的 provider 释放行为。
   * @returns 在发布或回滚之后释放的准备。
   */
  static create(session: Session, options?: SessionPreparationOptions): SessionPreparation {
    return new SessionPreparation(session, options ?? {})
  }

  /** 当本准备离开其调用方时，释放一次 provider 状态。 */
  [Symbol.dispose](): void {
    if (this.released) return
    this.released = true
    this.options.release?.()
  }
}
