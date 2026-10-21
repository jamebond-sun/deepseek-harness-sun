/** 在精确的实时 Lead Session 日志之上的、序列化后的 Team 事务。 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEventMap, SessionId } from '@deepseek-ai/dsh-session'
import type { TeamEventType, TeamState } from './projection.ts'

type AppendTeamEvent = <T extends TeamEventType>(type: T, data: SessionEventMap[T]) => void
type MutableTeamEventType = 'team/member' | 'team/task'

/** 持有每个 Lead 的事务顺序，以及已提交的 Team 事件发布。 */
export class TeamJournal {
  private readonly tails = new Map<SessionId, Promise<void>>()

  /**
   * @param ctx - 注入了 Session 服务的 Team 服务上下文。
   * @param onCommit - 在 Team 事件刷新成功之后进行的同步通知。
   */
  constructor(
    private readonly ctx: Context,
    private readonly onCommit: (root: Agent) => void,
  ) {}

  /**
   * 为某个精确的实时 Lead 读取权威的 Team 状态。
   * @param root - 精确的实时 Team Lead。
   * @returns 由该 Lead 的 Team id 选定的、当前的投影状态。
   */
  state(root: Agent): TeamState {
    const projection = this.ctx.sessionProjections.stateOf(root.session, 'agentTeam')
    if (projection === undefined) throw new Error('Agent Teams projection is not registered')
    if (projection.failure !== undefined) throw new Error(projection.failure)
    return projection
  }

  /**
   * 序列化某个 Lead 的异步变更操作。
   * @param rootId - 选定事务队列的 Lead Session 身份。
   * @param operation - 完整的读取-检查-追加操作。
   * @returns 该操作的结果。
   */
  async transact<T>(rootId: SessionId, operation: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(rootId) ?? Promise.resolve()
    const run = prior.then(operation, operation)
    const tail = run.then(() => undefined, () => undefined)
    this.tails.set(rootId, tail)
    try {
      return await run
    } finally {
      if (this.tails.get(rootId) === tail) this.tails.delete(rootId)
    }
  }

  /**
   * 追加并对某个 root 拥有的 Team 事件做检查点，然后才发布。
   * @param root - 拥有该事件的 Session 的、精确的实时 Lead。
   * @param type - Team 事件判别标签。
   * @param data - 与该事件类型相关联的载荷。
   */
  async appendAndFlush<T extends MutableTeamEventType>(
    root: Agent,
    type: T,
    data: SessionEventMap[T],
  ): Promise<void> {
    // Team 事件永远不会进入对话界面。这个更窄的本地能力移除了
    // Session.append 的有条件 surface 参数，同时保留了事件键/载荷的关联。
    const append = root.session.append.bind(root.session) as unknown as AppendTeamEvent
    append(type, data)
    await this.ctx.sessions.flush(root.session)
    this.onCommit(root)
  }
}
