// Session 在创建后保持常驻，使其打开的 Remote 源在屏幕外继续运行。

import type { Context } from '@deepseek-ai/cordis'
import type { InboxState, InboxTarget } from '@deepseek-ai/dsh-agent/types'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { AttachmentIdType, FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { UserMessage } from '@deepseek-ai/dsh-llm/types'
import { SessionLogOffset, SessionSeq, type SessionId } from '@deepseek-ai/dsh-session/types'
import { SessionEventStream } from '../transport.ts'
import type { SessionJournalChange } from '../transport.ts'
import type {
  PromptContentPart,
  QueueAction,
  SessionAddress,
  SessionAssistantStreamBaseline,
  SessionProjectionBaseline,
  SessionRequestId,
} from '../../types.ts'
import type {
  BeginSubmissionInput, PendingSubmissionRetirement, SessionFace, SubmissionHandle,
} from '../contract/session.ts'
import type {
  OpenState, PendingSubmission, PromptError, SessionSnapshot,
} from '../contract/snapshot.ts'
import { MutableSessionEventSource } from '../contract/events.ts'
import type {
  SessionEventLike, SessionEventLikeEntry, SessionLiveEventEntry,
} from '../contract/events.ts'
import { Notifier } from './notifier.ts'
import { isRemoteFailure } from '@deepseek-ai/dsh-api-gateway/client'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionRemotes } from './remotes.ts'
import { ProjectionValueStore } from './projection-store.ts'
import type { ProjectionsBaseline } from './projection-store.ts'
import { resolvedClientTimeZone } from '../time-zone.ts'
import {
  ClientAssistantStream,
  type ClientAssistantStreamResult,
} from './assistant-stream.ts'

function projectionsBaseline(value: SessionProjectionBaseline): ProjectionsBaseline {
  return {
    ...value,
    asOfSeq: value.asOfSeq === -1 ? -1 : SessionSeq(value.asOfSeq),
  }
}

/** 普通历史窗口的最小消息数。 */
export const PAGE_MESSAGES = 50

const HISTORY_PAGE_OPTIONS = { maxMessages: 500, turnWindow: { minMessages: PAGE_MESSAGES, minTurns: 2 } }

/** turn 跳转循环回溯期间每页的最小消息数。 */
export const JUMP_PAGE_MESSAGES = 200

const JUMP_PAGE_OPTIONS = {
  ...HISTORY_PAGE_OPTIONS,
  turnWindow: { ...HISTORY_PAGE_OPTIONS.turnWindow, minMessages: JUMP_PAGE_MESSAGES },
}

interface PendingHistory {
  beforeSeq: SessionLogOffset
  hasMore: boolean
  readonly pages: (readonly SessionEventLikeEntry[])[]
}

/** Manager 持有的、观察 Session 对象本地状态边缘的观察者。 */
export interface SessionOptions {
  /** 目录发现的地址，选择非激活的 subagent 传输层。 */
  address?: SubagentAddress
  /** 确切的直接父级 Agent 是否在 Host 摘要中可用；未知前缺失。 */
  parentAvailable?: boolean
  /**
   * 把每条被接纳的提示词发布给 Manager，包括本 Session
   * 对象被替换之后。接纳会转换展示状态，但不能证明
   * 一个 turn 已开始或已到达持久化历史。
   */
  onEngaged?(session: Session): void
  /**
   * 要采纳的 Manager 持有投影值存储（帧经由 manager 路由，
   * 值的生命周期长于实例化）；省略时 Session 拥有
   * 私有存储（裸对象层构造）。
   */
  projections?: ProjectionValueStore
}

/**
 * 拥有某个 session 的事件窗口、生命周期状态与可观察
 * 快照。React 绑定保持在此数据层之外。功能包只看到
 * {@link SessionFace} 切片（ISession 动词 + 快照源）；其余公开成员
 * 是 Session Controller 内部实现。
 */
export class Session implements SessionFace {
  // ---- 窗口与派生状态（全部私有；快照是唯一的读取 API） ----
  private baseSeq = SessionLogOffset(0)
  private hasMore = false
  private openState: OpenState = 'cold'
  private openError: RemoteFailure | null = null
  private openPromise: Promise<void> | null = null
  /** 由流替换递增，以使进行中的 doOpen 失效。代际前移后，
   *  过期的一轮会丢弃所有写入。 */
  private openGeneration = 0
  private loadingOlder = false
  /** 正在运行的跳转循环的共享低水位目标；无跳转分页时为 null。 */
  private jumpTargetSeq: SessionSeq | null = null
  /** 正在运行的跳转循环的完成，由重新设定目标的调用方共享。 */
  private jumpPromise: Promise<void> | null = null
  private pendingHistory: PendingHistory | null = null
  private readonly stopObservingInbox: () => void
  private readonly assistantStream = new ClientAssistantStream()
  private running = false
  private address: SubagentAddress | undefined
  private parentAvailable: boolean | undefined
  /**
   * 粘性的发送标记，composerPhase 推导的私有输入：在
   * prompt() 的首个 await 之前同步置位，从不重置 —— 相位机的
   * blank → engaging 边沿（见 ComposerPhase）。
   */
  private promptAttempted = false
  /** 首条被接纳的提示词在其 turn 可观察前停留在 engaging 相位。 */
  private firstPromptPendingTurn = false
  /** New Session 展示状态；未知的裸 session 保守地从空白开始。 */
  private blankBit = true
  private removed = false
  private promptError: PromptError | null = null
  private lastAgentError: string | null = null
  /** 本地提交回显，按插入顺序（见 SessionSnapshot.pendingSubmissions）。 */
  private pendingSubmissions: readonly PendingSubmission[] = []
  /** 每条回显的落定状态；`retiring` 锁存首次观察，使
   *  Inbox 投影与其持久化事件不能同时退役同一条回显。 */
  private readonly submissionSettlements = new Map<SessionRequestId, {
    readonly placement: PendingSubmission['placement']
    /** 最近收到的 Inbox 位置；null 表示已从该队列移除。 */
    receipt?: {
      readonly target: InboxTarget
      readonly seq: number
      readonly index: number | null
      readonly attachments: readonly (ImageAttachmentRef | FileAttachmentRef)[]
    }
    /** 持久化接纳可能先于 Inbox 投影确认其认领。 */
    admitted?: readonly (ImageAttachmentRef | FileAttachmentRef)[]
    readonly onRetire?: ((retirement: PendingSubmissionRetirement) => void) | undefined
    retiring: boolean
  }>()
  /** 在本 Session 打开期间拥有按址分页/跟随的生命周期。 */
  private events: SessionEventStream | undefined

  /**
   * 每 session 的投影值存储（推送模型；见 session-projection
   * 子系统页，docs/subsystems/session-projection.md）：在 Host 上
   * 计算完成的整值，由尾页的 projections 块播种，由 Session Controller
   * 控制帧更新；按 Host 排序的写入在更高 seq 优先规则下合并，
   * 缓存的列表块让位于它们（projection-store.ts）。键通过
   * `projections.faceOf(key)` 读取（useProjection 解析门面）；会话内容
   * 快照从不携带投影值，也不存在客户端侧的领域折叠。
   * 经由 SessionManager 构造时由 Manager 持有（帧路由且
   * 存储的生命周期长于实例化，即 title-snapshot 的先例）；裸
   * 构造获得私有存储。
   */
  readonly projections: ProjectionValueStore

  /** 由 Conversation 组装消费的连续历史与实时尾部。 */
  readonly eventSource = new MutableSessionEventSource()
  private snapshotCache: SessionSnapshot
  private readonly notifier: Notifier
  /**
   * Agent 作用域的 cordis context，由 ClientSessions 铸出 scope 时
   * 绑定一次（Host Agent loopCtx 的 client 镜像）。Session 通过它
   * 分发自己的作用域事件；undefined 表示未绑定（裸对象层构造）
   * 或已被修剪 —— 两者都跳过依赖分发的行为而不是失败。
   */
  private actx: Context | undefined

  /**
   * @param sessionId - Host session 身份（client session 总是由 Host 诞生）。
   * @param remote - 本 session 调用的生成 Remote 命名空间。
   * @param options - 可选的 Manager 持有状态观察者。
   */
  constructor(
    readonly sessionId: SessionId,
    private readonly remote: SessionRemotes,
    private readonly options: SessionOptions = {},
  ) {
    this.projections = options.projections ?? new ProjectionValueStore()
    this.address = options.address
    this.parentAvailable = options.parentAvailable
    this.notifier = new Notifier(() => {
      this.snapshotCache = this.buildSnapshot()
    })
    this.snapshotCache = this.buildSnapshot()
    this.stopObservingInbox = this.projections.faceOf('inbox').subscribe(() => {
      this.observeSubmissionInbox()
    })
  }

  /**
   * 绑定由 ClientSessions 铸出的 Agent 作用域 context（单次写入；
   * 第二次绑定是接线错误并抛出）。在此绑定分界处方向保持单向：
   * 消费方仍然经由 `sessions.sessionOf` 到达 Session，
   * 而 Session 持有自己的分发点（Host Agent.loopCtx
   * 镜像）。
   * @param actx - 该 agent 的作用域 context。
   */
  bindScope(actx: Context): void {
    if (this.actx !== undefined) throw new Error(`session ${this.sessionId} already has a bound scope`)
    this.actx = actx
  }

  /** 在修剪时释放已绑定的 scope（稍后的重新绑定伴随一个新铸的 scope）。 */
  unbindScope(): void {
    this.actx = undefined
  }

  // ---- 操作 ----

  /**
   * 注册一条本地提交回显（见 ISession 声明）。
   * 经由 markDirty 同步完成：回显出现在紧接着的下一个快照中，
   * 使会话能在调用方开始序列化之前渲染它。
   * @param input - 回显内容与可选的落定回调。
   * @returns 铸出的 {@link prompt} 身份加上提示词前的放弃路径。
   */
  beginSubmission(input: BeginSubmissionInput): SubmissionHandle {
    const requestId = randomUUID() as SessionRequestId
    const placement = this.running ? input.mode === 'steer' ? 'steering' : 'queued' : 'transcript'
    this.pendingSubmissions = [...this.pendingSubmissions, {
      requestId,
      placement,
      time: Date.now(),
      text: input.text,
      attachments: input.attachments,
    }]
    this.submissionSettlements.set(requestId, { placement, onRetire: input.onRetire, retiring: false })
    // blank → engaging 边沿在此翻转，先于 prompt()：composer
    // 停靠，回显在点击所在的那一帧渲染。
    this.promptAttempted = true
    this.notifier.markDirty()
    return { requestId, abandon: () => { this.retireFailedSubmission(requestId) } }
  }

  /**
   * 发送（queue/steer 原样透传）；失败落在快照的 promptError。
   * @param content - 文本、浏览器持有的临时图片上传与暂存文件凭据。
   * @param mode - queue 追加在当前 turn 之后；steer 打断当前 turn。
   * @param signal - 完整接纳往返的可选调用方取消。
   * @param requestId - 来自 {@link beginSubmission} 的身份；已识别的提示词失败会退役其回显。
   * @returns 提示词结果（失败时同时镜像进 promptError）。
   */
  async prompt(
    content: PromptContentPart[],
    mode: 'queue' | 'steer',
    signal?: AbortSignal,
    requestId?: SessionRequestId,
  ): Promise<RemoteResult<{ accepted: true }>> {
    this.promptError = null
    this.lastAgentError = null
    // 同步，在首个 await 之前：当调用方在导航之前发送（首次发送流程）时，
    // blank → engaging 边沿必须在该会话区域的第一帧就可见。
    this.promptAttempted = true
    if (this.blankBit) this.firstPromptPendingTurn = true
    this.notifier.markDirty()
    let result: RemoteResult<{ accepted: true }>
    if (this.address === undefined) {
      const clientTimeZone = resolvedClientTimeZone()
      result = await this.remote.session.prompt({
        requestId: requestId ?? randomUUID() as SessionRequestId,
        sessionId: this.sessionId,
        mode,
        content,
        clientTimeZone,
      }, signal)
    } else if (content.some(part => part.type === 'file')) {
      result = {
        ok: false,
        error: new RemoteError(
          'subagent/attachment-invalid',
          'subagent continuation does not accept files',
          { reason: 'SUBAGENT_FILE_UNSUPPORTED' },
        ),
      }
    } else {
      // 前面的分支在更窄的 subagent wire 类型被使用之前拒绝 file 部分；
      // 该数组不做过滤或重排。
      const routedContent = content as Exclude<PromptContentPart, { readonly type: 'file' }>[]
      const routed = await this.remote.subagents.prompt({
        requestId: requestId ?? randomUUID() as SessionRequestId,
        parentSessionId: this.address.parentSessionId,
        childSessionId: this.address.childSessionId,
        mode: 'continuable',
        delivery: mode,
        content: routedContent,
        clientTimeZone: resolvedClientTimeZone(),
      }, signal)
      result = routed.ok ? { ok: true, value: { accepted: true } } : routed
    }
    if (!result.ok) {
      if (requestId !== undefined) this.retireFailedSubmission(requestId)
      this.promptError = { op: 'send', error: result.error }
      this.notifier.markDirty()
      return result
    }
    // 被拒绝时必须让首条提示词保持空白并有资格复用 workspace。
    if (this.blankBit) {
      this.blankBit = false
      this.notifier.markDirty()
    }
    this.options.onEngaged?.(this)
    return result
  }

  /**
   * 把本 session 引用的一张图片解析为浏览器可消费的字节。
   * @param attachmentId - 在折叠的 session 日志中找到的不透明 id。
   * @returns 经鉴权的引用与解码后的字节。
   */
  async readAttachment(
    attachmentId: AttachmentIdType,
  ): Promise<RemoteResult<{ attachment: ImageAttachmentRef; data: Uint8Array }>> {
    const result = await this.remote.session.attachment({
      sessionId: this.sessionId,
      attachmentId,
    })
    if (!result.ok) return result
    const binary = atob(result.value.data)
    const data = Uint8Array.from(binary, char => char.charCodeAt(0))
    return { ok: true, value: { attachment: result.value.attachment, data } }
  }

  /** 对一个仍在排队的队列出现应用一次操作。 */
  async updateQueue(itemId: MessageId, action: QueueAction): Promise<RemoteResult<{ accepted: true }>> {
    return this.remote.session.updateQueue({ sessionId: this.sessionId, itemId, action })
  }

  /**
   * 在 Host 保留待处理 inbox 工作的同时停止活跃 turn；失败
   * 落在 promptError（同一个错误条展示槽）。subagent 地址
   * 经由 `subagents.interruptByParent` 路由，其持久化的父级地址
   * 权威在没有存活的父级 Agent 时也能工作。
   * @returns 取消结果。
   */
  async cancel(): Promise<RemoteResult<{ accepted: true }>> {
    const address = this.address
    const result = address !== undefined
      ? await this.remote.subagents.interruptByParent(
        address.childSessionId,
        address.parentSessionId,
        'continuable',
      )
      : await this.remote.session.cancel({ sessionId: this.sessionId })
    if (!result.ok) {
      this.promptError = { op: 'stop', error: result.error }
      this.notifier.markDirty()
    }
    return result
  }

  /**
   * 重命名：与 contract session.rename 一一对应。成功时按存储的
   * 更高 seq 优先规则，从响应的 `{title, seq}` 落定 'title' 投影
   * 单元（稍后到达的推送帧是无操作的回放），
   * 使列表行与任何 useProjection('title') 读取者无需等待
   * 控制流的投影更新即可更新。
   * @param title - 原始标题文本（Host 规范化接纳）。
   * @returns 重命名结果（规范化后的已接纳标题 + 标题事件 seq）。
   */
  async rename(title: string): Promise<RemoteResult<{ title: string; seq: SessionSeq }>> {
    const result = await this.remote.session.rename({ sessionId: this.sessionId, title })
    if (!result.ok) return result
    const seq = SessionSeq(result.value.seq)
    this.projections.apply('title', result.value.title, seq)
    return { ok: true, value: { title: result.value.title, seq } }
  }

  /**
   * 针对此 session 的 agent 执行一行斜杠命令 —— 纯接纳语义
   * （Host 执行器持久化记录生命周期；结果渲染为 flow 节点，
   * 绝不作为响应回显）。
   * @param line - 完整的命令行，包含前导斜杠。
   * @returns 接纳结果。
   */
  async command(line: string): Promise<RemoteResult<{ matched: boolean }>> {
    const result = await this.remote.commands.execute(this.sessionId, line, [])
    if (!result.ok) return result
    return { ok: true, value: { matched: result.value !== undefined } }
  }

  /** 首次打开：拉取尾页（幂等 —— 进行中/已打开返回既有的 promise）。 */
  open(): Promise<void> {
    if (this.openState === 'open') return Promise.resolve()
    if (this.openPromise !== null) return this.openPromise
    const promise = this.doOpen(this.openGeneration).finally(() => {
      // 身份守卫：被取代的打开不得清空刚重新同步的 promise。
      if (this.openPromise === promise) this.openPromise = null
    })
    this.openPromise = promise
    return promise
  }

  /** 前插一页按 Turn 对齐的内容：至少 50 条消息和两个 Turn 起点，上限 500 条消息。 */
  async loadOlder(): Promise<void> {
    if (this.openState !== 'open' || !this.hasMore || this.loadingOlder) return
    const events = this.events
    if (events === undefined) return
    this.loadingOlder = true
    this.notifier.markDirty()
    try {
      await events.prepend({
        beforeSeq: this.baseSeq,
        ...HISTORY_PAGE_OPTIONS,
      })
    } catch (error) {
      if (!isRemoteFailure(error)) {
        console.error('[session-controller] loadOlder failed:', error)
      }
    } finally {
      this.loadingOlder = false
      this.notifier.markDirty()
    }
  }

  /** 跳转加载器：向更早方向分页，直到窗口覆盖 seq（见 ISession.loadThrough）。 */
  loadThrough(seq: SessionSeq): Promise<void> {
    if (this.openState !== 'open' || !this.hasMore || this.baseSeq <= seq) return Promise.resolve()
    if (this.jumpPromise !== null) {
      // 把正在运行的循环重新定向到请求的最低 seq。
      this.jumpTargetSeq = SessionSeq(Math.min(this.jumpTargetSeq ?? seq, seq))
      return this.jumpPromise
    }
    // 一次普通的单页拉取持有忙碌标志；跳转不在其后排队
    // （调用方在其落定后重试），且必须不留下任何目标 ——
    // 只有该循环的 finally 清除该字段，而这里不会启动循环。
    if (this.loadingOlder) return Promise.resolve()
    const events = this.events
    if (events === undefined) return Promise.resolve()
    const pending: PendingHistory = {
      beforeSeq: this.baseSeq,
      hasMore: this.hasMore,
      pages: [],
    }
    this.pendingHistory = pending
    this.jumpTargetSeq = seq
    this.loadingOlder = true
    this.notifier.markDirty()
    // 过期轮次守卫（doOpen 模式）：循环中途的一次重新同步会替换
    // 流代际；这一轮随即停止，而不是把新一代际朝其旧目标分页。
    const generation = this.openGeneration
    this.jumpPromise = (async () => {
      try {
        while (pending.hasMore && this.jumpTargetSeq !== null && pending.beforeSeq > this.jumpTargetSeq) {
          if (generation !== this.openGeneration) return
          const before = pending.beforeSeq
          await events.prepend({ beforeSeq: before, ...JUMP_PAGE_OPTIONS })
          // 无进展守卫：一页仍声称有更多历史的空页或丢弃页
          // 必须结束循环，而不是让它空转。
          if (pending.beforeSeq >= before) return
        }
      } catch (error) {
        if (!isRemoteFailure(error)) {
          console.error('[session-controller] loadThrough failed:', error)
        }
      } finally {
        this.jumpTargetSeq = null
        this.jumpPromise = null
        this.pendingHistory = null
        this.loadingOlder = false
        if (generation === this.openGeneration && pending.pages.length > 0) {
          this.prependWindow(pending.pages.reverse().flat(), pending.hasMore)
        }
        this.notifier.markDirty()
      }
    })()
    return this.jumpPromise
  }

  /** 在地址替换后重建一个已打开的历史源。
   *  先使任何进行中的打开失效；投影状态属于独立重连的控制流，
   *  保持原样不动。 */
  async resync(): Promise<void> {
    if (this.openState === 'cold') return // 从未打开：没有窗口可重建（doOpen 同步翻转到 'loading'，因此 cold 蕴含没有进行中的打开）
    this.openGeneration++
    const events = this.events
    this.events = undefined
    await events?.dispose()
    this.openPromise = null
    this.openState = 'cold'
    this.openError = null
    this.baseSeq = SessionLogOffset(0)
    this.notifier.markDirty()
    await this.open()
  }

  // ---- 订阅 API（useSyncExternalStore 直接接线） ----

  /**
   * uSES 订阅入口。
   * @param listener - 变更回调。
   * @returns 取消订阅函数。
   */
  subscribe(listener: () => void): () => void {
    return this.notifier.subscribe(listener)
  }

  /**
   * 缓存的 Session 快照（脏且无监听器时惰性重建）。
   * @returns 缓存的引用（直到下一次刷新前保持稳定）。
   */
  getSnapshot(): SessionSnapshot {
    this.notifier.ensureFresh()
    return this.snapshotCache
  }

  // ---- 仅 Manager 入口（@internal；UI 绝不调用） ----

  /**
   * 来自 Host 流的 running 位中继（列表条目与快照保持一致）。
   * @param running - 新的 running 状态。
   */
  handleRunning(running: boolean): void {
    // running 转换展示状态，而不确立持久化的 turn 历史。
    if (running && this.blankBit) {
      this.blankBit = false
      this.notifier.markDirty()
    }
    if (running) this.firstPromptPendingTurn = false
    if (this.running === running) return
    this.running = running
    this.notifier.markDirty()
  }

  /**
   * 安装或清除目录发现的传输层地址。变更后的地址会经由其新历史
   * 路由重建一个已打开的窗口。
   * @param address - 直接父级/子级地址，或普通传输层时为 undefined。
   * @param parentAvailable - 最新的确切父级可用性提示，或目录读取前为 undefined。
   */
  configureSubagent(address: SubagentAddress | undefined, parentAvailable?: boolean): void {
    const same = this.address?.parentSessionId === address?.parentSessionId
      && this.address?.childSessionId === address?.childSessionId
      && this.address?.mode === address?.mode
    this.address = address
    this.parentAvailable = parentAvailable
    if (!same && this.openState !== 'cold') void this.resync()
    else this.notifier.markDirty()
  }

  /**
   * 仅从目录刷新更新父级可用性提示。
   * @param available - 确切的直接父级是否存活。
   */
  handleSubagentParentAvailable(available: boolean): void {
    if (this.parentAvailable === available) return
    this.parentAvailable = available
    this.notifier.markDirty()
  }

  /**
   * 应用 Manager 的有效展示空白值，并与当前 `sessionListMetadata`
   * 投影进一步调和。本地发送尝试与当前 running 状态阻止重新置空；
   * 仅凭先前一次 false 摘要则不能。Manager 跨 Session 对象替换
   * 保留接纳与更早的 running 观察。
   * @param blank - Manager 调和后的 New Session 展示状态。
   */
  handleBlank(blank: boolean): void {
    blank = blank && this.projections.values().sessionListMetadata?.blank !== false
    if (blank === this.blankBit) return
    if (blank && (this.promptAttempted || this.running)) return
    this.blankBit = blank
    this.notifier.markDirty()
  }

  /** `api-session/removed` 中继：在保留常驻实例的同时给快照打标记。 */
  handleRemoved(): void {
    this.removed = true
    this.notifier.markDirty()
  }

  /**
   * `api-session/error` 中继：没有 turn 位置的实时失败的出口。
   * @param message - 字符串化后的错误。
   */
  handleAgentError(message: string): void {
    this.lastAgentError = message
    this.notifier.markDirty()
  }

  /**
   * 停止该 Session 的实时 Remote 源。
   * @returns 当 Remote 迭代器完成清理时。
   */
  async dispose(): Promise<void> {
    this.stopObservingInbox()
    // 未落定的回显以失败退役，使其持有者能恢复或释放浏览器资源；
    // 已接纳的回显保留其被观察到的结果。
    for (const [requestId, settlement] of [...this.submissionSettlements]) {
      if (settlement.admitted !== undefined) this.scheduleObservedRetirement(requestId, settlement.admitted)
      else this.retireFailedSubmission(requestId)
    }
    this.openGeneration++
    const events = this.events
    this.events = undefined
    await events?.dispose()
  }

  // ---- 私有 ----

  /** @param generation - 启动时的 openGeneration；被取代的一轮不能在替换之后发布。 */
  private async doOpen(generation: number): Promise<void> {
    this.openState = 'loading'
    this.openError = null
    this.notifier.markDirty()
    const events = new SessionEventStream(this.remote, this.sessionAddress(), {
      publish: (change) => {
        if (generation !== this.openGeneration || this.events !== events) return
        this.acceptEventChange(change)
      },
      failed: (error) => {
        this.failEventStream(events, generation, error)
      },
    })
    this.events = events
    try {
      await events.open(HISTORY_PAGE_OPTIONS)
      if (generation !== this.openGeneration || this.events !== events) return
      this.openState = 'open'
    } catch (error) {
      if (generation !== this.openGeneration || this.events !== events) return
      if (!isRemoteFailure(error)) throw error
      this.events = undefined
      this.openState = 'error'
      this.openError = error
    } finally {
      if (generation === this.openGeneration) this.notifier.markDirty()
    }
  }

  /** 应用一个已由 Remote 流调和的连续日志更新。 */
  private acceptEventChange(change: SessionJournalChange): void {
    switch (change.type) {
      case 'replace':
        this.installWindow(
          change.entries,
          change.hasMore,
          change.page.projections === undefined ? undefined : projectionsBaseline(change.page.projections),
          change.page.assistantStream,
        )
        return
      case 'prepend':
        this.prependWindow(change.entries, change.hasMore)
        return
      case 'append':
        this.publishAssistantEntry(this.assistantStream.acceptDurable(change.entry))
        return
      case 'assistant-stream':
        this.publishAssistantEntry(this.assistantStream.acceptFrame(change.frame))
    }
  }

  /** 替换完整的连续窗口并应用页持有的投影元数据。 */
  private installWindow(
    entries: readonly SessionEventLikeEntry[],
    hasMore: boolean,
    projections?: ProjectionsBaseline,
    assistantStream?: SessionAssistantStreamBaseline,
  ): void {
    // 一页持久化的缺口修复页没有 assistant 基线。清除瞬态
    // attempt 会让持有的通知按一个原子的页/基线对重新打开跟随一次，
    // 而不是把它应用到无关的修复切口上。
    const visible = this.assistantStream.replace(entries, assistantStream)
    this.baseSeq = SessionLogOffset(entries[0]?.event.seq ?? 0)
    this.hasMore = hasMore
    if (this.pendingHistory !== null) {
      this.pendingHistory.beforeSeq = this.baseSeq
      this.pendingHistory.hasMore = hasMore
      this.pendingHistory.pages.length = 0
    }
    if (visible.some(entry => entry.event.type === 'turn/start')) this.firstPromptPendingTurn = false
    if (projections !== undefined) this.projections.seed(projections)
    this.eventSource.replace(visible, hasMore)
    // 新的跟随基线用 Host 持有的行替换已确认的乐观输入。
    // 有凭据背书的输入按接纳处理而非失败，即使其历史在窗口之外。
    if (projections !== undefined) {
      for (const [requestId, { receipt }] of this.submissionSettlements) {
        if (receipt !== undefined && receipt.seq <= projections.asOfSeq) {
          this.scheduleObservedRetirement(requestId, receipt.attachments)
        }
      }
    }
    for (const entry of visible) this.observeSubmissionEvent(entry.event)
    if (projections !== undefined) {
      const inbox = projections.values.inbox as InboxState | undefined
      for (const target of ['next-turn', 'next-step'] as const) {
        this.observeSubmissionInsertions(target, inbox?.[target] ?? [], 0, projections.asOfSeq)
      }
    }
    this.notifier.markDirty()
  }

  private publishAssistantEntry(result: ClientAssistantStreamResult): void {
    if (result?.type === 'rebaseline') {
      const events = this.events
      queueMicrotask(() => {
        if (events !== undefined && this.events === events) events.restart()
      })
      return
    }
    if (result?.type === 'settlement') {
      this.eventSource.settleAssistant(result.attemptId, result.entry)
      this.observeSubmissionEvent(result.entry.event)
      this.notifier.markDirty()
      return
    }
    if (result?.type === 'abandonment') {
      this.eventSource.settleAssistant(result.attemptId)
      this.notifier.markDirty()
      return
    }
    if (result?.type === 'publish') {
      const changed = this.appendLive(result.entry)
      if (result.retireAttemptId !== undefined) this.eventSource.settleAssistant(result.retireAttemptId)
      if (changed || result.retireAttemptId !== undefined) this.notifier.markDirty()
    } else if (result?.type === 'transient') {
      this.eventSource.append(result.entry)
      this.notifier.markDirty()
    }
  }

  /** 前插一页经流校验的历史内容。 */
  private prependWindow(entries: readonly SessionEventLikeEntry[], hasMore: boolean): void {
    if (this.pendingHistory !== null) {
      const pending = this.pendingHistory
      pending.beforeSeq = entries[0] === undefined ? pending.beforeSeq : SessionLogOffset(entries[0].event.seq)
      pending.hasMore = hasMore
      pending.pages.push(entries)
      return
    }
    this.baseSeq = entries[0] === undefined ? this.baseSeq : SessionLogOffset(entries[0].event.seq)
    this.hasMore = hasMore
    this.eventSource.prepend(entries, hasMore)
  }

  /** 追加一条经流校验的实时事件。 */
  private appendLive(entry: SessionLiveEventEntry): boolean {
    const event = entry.event
    const awaitingFirstTurn = this.firstPromptPendingTurn
    if (event.type === 'turn/start') this.firstPromptPendingTurn = false
    this.eventSource.append(entry)
    // 在馈送追加之后：会话组装的动画帧已由上面的馈送订阅者注册，
    // 因此这里调度的回显退役帧总是在持久化节点可渲染之后运行。
    this.observeSubmissionEvent(event)
    return awaitingFirstTurn !== this.firstPromptPendingTurn
  }

  /** 即使插入与认领共享同一次投影通知，也要观察到持久化的接纳。 */
  private observeSubmissionEvent(event: SessionEventLike): void {
    if (this.submissionSettlements.size === 0) return
    if (event.type === 'agent/inbox/spliced') {
      const { target, start, removedCount = 0, inserted, outcome } = event.data
      for (const [requestId, settlement] of this.submissionSettlements) {
        const receipt = settlement.receipt
        if (receipt?.target !== target || receipt.index === null || receipt.seq >= event.seq) continue
        const removed = receipt.index >= start && receipt.index < start + removedCount
        if (removed && outcome === 'canceled') this.retireFailedSubmission(requestId)
        else settlement.receipt = {
          ...receipt,
          seq: event.seq,
          index: removed ? null : receipt.index < start ? receipt.index : receipt.index + inserted.length - removedCount,
        }
      }
      this.observeSubmissionInsertions(target, inserted, start, event.seq)
      for (const message of inserted) this.observeSubmissionMessage(message, false)
      return
    }
    if (event.type === 'request/context' || event.type === 'turn/end') {
      for (const [requestId, settlement] of this.submissionSettlements) {
        if (settlement.admitted === undefined && settlement.receipt?.index === null
          && settlement.receipt.seq < event.seq) this.retireFailedSubmission(requestId)
      }
      return
    }
    if (event.type === 'user/message') this.observeSubmissionMessage(event.data, true)
  }

  private observeSubmissionInsertions(target: InboxTarget, messages: readonly UserMessage[], start: number, seq: number): void {
    for (const [index, message] of messages.entries()) {
      const source = message.source
      if (source.kind !== 'user' || !('rpcId' in source)) continue
      const settlement = this.submissionSettlements.get(source.rpcId)
      if (settlement === undefined || settlement.placement === 'queued'
        || settlement.retiring || (settlement.receipt?.seq ?? -1) > seq) continue
      settlement.receipt = { target, seq, index: start + index, attachments: attachmentRefsIn(message.content) }
    }
  }

  private observeSubmissionMessage(message: UserMessage, admitted: boolean): void {
    const source = message.source
    if (source.kind !== 'user' || !('rpcId' in source)) return
    const settlement = this.submissionSettlements.get(source.rpcId)
    if (settlement === undefined || settlement.retiring) return
    if (!admitted) {
      if (settlement.placement === 'queued') this.scheduleObservedRetirement(source.rpcId, attachmentRefsIn(message.content))
      return
    }
    settlement.admitted = attachmentRefsIn(message.content)
    this.retireAdmittedSubmission(source.rpcId)
  }

  /** 仅在过期的 Inbox 行不再可能重新出现之后，才退役已接纳的 Chat 身份。 */
  private retireAdmittedSubmission(requestId: SessionRequestId): void {
    const settlement = this.submissionSettlements.get(requestId)
    if (settlement?.admitted === undefined) return
    const receipt = settlement.receipt
    if (receipt?.index === null
      && (this.projections.seqOf('inbox') ?? -1) < receipt.seq) return
    this.scheduleObservedRetirement(requestId, settlement.admitted)
  }

  /** Inbox 接纳使排队的回显退役；其水位线完成已接纳的 Chat 交接。 */
  private observeSubmissionInbox(): void {
    if (this.submissionSettlements.size === 0) return
    const inbox = this.projections.get('inbox') as InboxState | undefined
    if (inbox === undefined) return
    const seq = this.projections.seqOf('inbox')
    for (const target of ['next-turn', 'next-step'] as const) {
      if (seq !== undefined) this.observeSubmissionInsertions(target, inbox[target], 0, seq)
      for (const message of inbox[target]) this.observeSubmissionMessage(message, false)
    }
    for (const requestId of this.submissionSettlements.keys()) this.retireAdmittedSubmission(requestId)
  }

  /**
   * 锁存一次被观察的落定，并在一个动画帧之后移除该回显。该延迟
   * 使回显在快照中保留到持久化节点（其组装帧先注册）可渲染的
   * 那一帧；渲染时的 rpcId 去重会隐藏这一帧的重叠。
   */
  private scheduleObservedRetirement(
    requestId: SessionRequestId,
    attachments: readonly (ImageAttachmentRef | FileAttachmentRef)[],
  ): void {
    const settlement = this.submissionSettlements.get(requestId)
    if (settlement === undefined || settlement.retiring) return
    settlement.retiring = true
    scheduleFrame(() => { this.finishSubmission(requestId, { reason: 'observed', attachments }) })
  }

  /** 立即移除一条未落定的回显（提示词被拒绝、中止或释放）。 */
  private retireFailedSubmission(requestId: SessionRequestId): void {
    const settlement = this.submissionSettlements.get(requestId)
    if (settlement === undefined || settlement.retiring || settlement.admitted !== undefined) return
    settlement.retiring = true
    this.finishSubmission(requestId, { reason: 'failed' })
  }

  /** 唯一的移除点：丢弃回显、发布，然后通知持有者。 */
  private finishSubmission(requestId: SessionRequestId, retirement: PendingSubmissionRetirement): void {
    const settlement = this.submissionSettlements.get(requestId)
    /* v8 ignore next -- retiring 在每次调度前锁存，因此一个落定绝不会完成两次。 */
    if (settlement === undefined) return
    this.submissionSettlements.delete(requestId)
    this.pendingSubmissions = this.pendingSubmissions.filter(echo => echo.requestId !== requestId)
    this.notifier.markDirty()
    settlement.onRetire?.(retirement)
  }

  /** 仅在本流仍拥有该 Session 时发布一个终结性的后台失败。 */
  private failEventStream(events: SessionEventStream, generation: number, error: unknown): void {
    if (generation !== this.openGeneration || this.events !== events) return
    if (!isRemoteFailure(error)) throw error
    this.openGeneration++
    this.events = undefined
    this.openPromise = null
    this.openState = 'error'
    this.openError = error
    void events.dispose()
    this.notifier.markDirty()
  }

  private buildSnapshot(): SessionSnapshot {
    const identity = this.projections.values().subagent
    return {
      sessionId: this.sessionId,
      pendingSubmissions: this.pendingSubmissions,
      running: this.running,
      subagent: this.address === undefined
        ? null
        : {
          address: this.address.mode === 'unknown' && identity != null
            ? { ...this.address, mode: identity.mode }
            : this.address,
          ...(this.parentAvailable === undefined ? {} : { parentAvailable: this.parentAvailable }),
        },
      removed: this.removed,
      openState: this.openState,
      openError: this.openError,
      hasMore: this.hasMore,
      loadingOlder: this.loadingOlder,
      promptError: this.promptError,
      blank: this.blankBit,
      lastAgentError: this.lastAgentError,
      promptAttempted: this.promptAttempted,
      awaitingFirstTurn: this.firstPromptPendingTurn,
    }
  }

  private sessionAddress(): SessionAddress {
    return this.address === undefined
      ? { kind: 'session', sessionId: this.sessionId }
      : { kind: 'subagent', ...this.address }
  }
}

/** 在下一个动画帧上运行一次回调，或在没有帧时钟的环境用宏任务。 */
function scheduleFrame(fn: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => { fn() })
  else setTimeout(fn, 0)
}

/** 一个按结构读取的内容块列表中的附件引用，按块顺序。 */
function attachmentRefsIn(content: unknown): readonly (ImageAttachmentRef | FileAttachmentRef)[] {
  if (!Array.isArray(content)) return []
  const refs: Array<ImageAttachmentRef | FileAttachmentRef> = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const candidate = block as { readonly type?: unknown; readonly attachment?: unknown }
    if ((candidate.type === 'image' || candidate.type === 'file')
      && typeof candidate.attachment === 'object' && candidate.attachment !== null) {
      refs.push(candidate.attachment as ImageAttachmentRef | FileAttachmentRef)
    }
  }
  return refs
}
