/**
 * 对外的 sessions 服务门面 —— 即 `ctx.sessions` 暴露给功能包的接口。
 * 传输层入口与实现内部细节保留在具体类上。拓宽此接口就是
 * 显式拓宽功能包对 sessions 领域所能做的事情。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { AgentContext } from '../scope.ts'
import type { SessionSearchResultItem } from '../sessions/manager.ts'
import type { SessionBinding, SessionListState } from '../sessions/service.ts'
import type { SessionFace } from './session.ts'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionReferenceSource } from '../index.ts'

export type { AgentContext } from '../scope.ts'

/** 已知 Session 身份或持久化直接父级 subagent 地址；地址不拥有生命周期。 */
export type SessionTarget = SessionId | SubagentAddress

/** 对某个精确 Client 代际的一次独立使用，不持有 Host Agent 所有权。 */
export interface SessionReference extends Disposable {
  readonly sessionId: SessionId
  /** 共享绑定；在引用释放或代际释放后访问会失败。 */
  readonly binding: SessionBinding
  /** 此引用可取消的等待，等待共享的首次 `Session.open()` 尝试落定。 */
  readonly ready: Promise<SessionBinding>
  /** 仅释放一次；最后一个引用会启动本地 scope 与历史的清理。 */
  release(): void
}

/** 一次获取的等待者的消费方身份与可选取消。 */
export interface SessionRetainOptions {
  readonly source: SessionReferenceSource
  readonly signal?: AbortSignal | undefined
}

/** 本地持有计数，独立于目录成员关系且从不持久化。 */
export interface SessionRetainInfo {
  readonly referenceCount: number
  /** 仅包含计数为正的来源；没有引用的来源不出现。 */
  readonly retainedBy: Readonly<Partial<Record<SessionReferenceSource, number>>>
}

/** 以 `ctx.sessions` 注入的 sessions 服务门面。 */
export interface ISessions {
  /** Host 目录与本地引用来源计数；导航由视图持有者负责。 */
  readonly list: ObservableSnapshot<SessionListState>
  /**
   * 保持一个精确的 Client 代际并启动其共享的首次历史打开。
   * @param target - 已知身份或持久化直接父级地址。
   * @param options - 必需的消费方来源与可选的独立等待者取消。
   * @returns 立即返回一个持有的引用；当首次打开尝试必须先落定时，await `reference.ready`。
   */
  retain(target: SessionTarget, options: SessionRetainOptions): SessionReference
  /**
   * 在回调落定期间持有一个引用，包括同步与异步失败。
   * @param target - 要获取的 Session。
   * @param options - 来源与获取取消。
   * @param operation - 仅在其返回值或 Promise 落定前使用引用的回调。
   * @returns 释放后的回调结果；获取与回调的失败原样传播。
   */
  using<T>(target: SessionTarget, options: SessionRetainOptions, operation: (reference: SessionReference) => T | Promise<T>): Promise<T>
  /**
   * 观察本地引用计数，而不保持引用、创建 scope 或打开历史。
   * 返回的来源在相同 id 的代际间保持稳定身份，并且在其最后一个
   * 订阅者离开后仍保持分配状态，直到 Client 根被释放。
   * @param id - 显式 Session 身份；不隐含 Host 上存在。
   * @returns 一个跨相同 id 代际稳定的只读来源，无存活代际时计数为零。
   */
  retainInfo(id: SessionId): ObservableSnapshot<SessionRetainInfo>
  /**
   * wire schema 固定的 `session.search` 结果上限，作为注入数据
   * 暴露给展示层。不是按连接的状态：每个传输层（包括 fixture）
   * 报告同一个数值。
   */
  readonly searchResultLimit: number
  /**
   * 在 Host 上为新会话创建一个 Session。Host 会在命名的空白 Session
   * 仍可复用时复用它，否则另创一个；Session 运行命名的 preset，
   * 未命名时使用 Host 默认值。
   * @param opts - 目标 workspace 或目录、可选的待复用空白 Session，以及可选的 Agent preset。
   * @returns Host 创建或复用的已编目身份；在借用其绑定前先持有它。
   */
  create(opts?: {
    workspaceId?: WorkspaceId
    cwd?: string
    sessionId?: SessionId
    agentPreset?: string
  }): Promise<SessionId>
  /**
   * 解析一个已发现的直接父级地址，而不打开它。
   * @param id - 可能被寻址的子级 id。
   * @returns 持有中的、目录派生的或未知模式的已列出地址，而不持有新的选择或 scope。
   */
  subagentAddress(id: SessionId): SubagentAddress | undefined

  /**
   * 读取投影而不启动迁移；重试失败或因迁移被推迟的读取。
   * @param sessionId - 要检查的 Session，不打开其会话内容。
   * @returns 当前刷新或新启动刷新的完成。
   */
  refreshProjections(sessionId: SessionId): Promise<void>

  /**
   * 刷新 Host 权威的 Session 列表。
   * @returns 当前刷新或新启动的 Session 列表刷新的完成。
   */
  refresh(): Promise<void>
  /**
   * 搜索 Host 可见的消息内容索引。结果保持请求局部；
   * 列表快照仍是元数据的权威。
   * @param query - 非空字面短语。
   * @param signal - 被取代搜索的取消信号。
   * @returns 有界结果，或业务/传输层错误。
   */
  search(
    query: string,
    signal: AbortSignal,
  ): Promise<RemoteResult<{ items: SessionSearchResultItem[]; hasMore: boolean }>>
  /**
   * 从源的一个精确且包含的前缀分叉会话；解析完成后子级
   * 被编目，可被显式持有。
   * @param opts - 源 session id、可选的精确包含边界
   *   seq（调用方已知的真实事件 seq；开放 turn 内部的切割
   *   由 Host 侧用合成收尾事件平衡，省略则选择
   *   最近已完成 turn 的前缀），以及是否在解析前递增
   *   继承的持久化标题。`onCreated` 在可选的重命名之前观察已编目的子级。
   * @returns 子级 session id。
   * @throws 当分叉失败时，或创建后请求的子级标题重命名失败时。
   */
  fork(opts: {
    sessionId: SessionId
    atSeq?: number
    increaseTitle?: boolean
    onCreated?: (childId: SessionId) => void
    /** False 拒绝源迁移；省略则保留 Host 默认值。 */
    allowMigration?: boolean
  }): Promise<SessionId>
  /**
   * 借用一个已保持的 Agent 作用域 Context 而不延长其生命周期。
   * @param id - session id。
   * @returns 存活的作用域 Context，或在没有已保持代际时返回 undefined。
   */
  scope(id: SessionId): AgentContext | undefined
  /**
   * 从一个 context 读取 Agent scope 标签（服务方法分界：获取
   * bundle 必须经由 ctx.sessions 到达 scope 解析）。
   * @param ctx - 任意 client context。
   * @returns session id，或在根 context 上返回 undefined。
   */
  scopeOf(ctx: Context): SessionId | undefined
  /**
   * 解析 Agent 作用域 context 背后的 session 门面。
   * @param ctx - 一个 Agent 作用域 context。
   * @returns 匹配的存活 Session，或对未打标签、外来或已结束代际返回 undefined。
   */
  sessionOf(ctx: Context): SessionFace | undefined
  /**
   * 借用一个已保持的 Session 绑定而不延长其生命周期。
   * @param id - session id。
   * @returns 存活的绑定，或在没有已保持代际时返回 undefined。
   */
  binding(id: SessionId): SessionBinding | undefined
}
