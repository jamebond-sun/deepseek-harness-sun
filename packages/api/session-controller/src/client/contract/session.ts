/**
 * 对外的 session 门面。功能包永远看不到具体的 Session 类：组件通过
 * `useSession`（ObservableSnapshot 那一半）读取生命周期状态，编排代码
 * 只调用下面的行为动词 —— 除此之外没有别的。拓宽此接口就是
 * 显式拓宽功能包对一个 session 所能做的事情（以及每个测试 fixture
 * 必须桩化什么）；实现内部的入口（历史暂存、wire 帧分发）
 * 留在类上，在这里不可见。
 */
import type { AttachmentIdType, FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { PromptContentPart, QueueAction, SessionRequestId } from '../../types.ts'
import type { PendingSubmissionAttachment, SessionSnapshot } from './snapshot.ts'

/**
 * 一条本地提交回显离开快照的原因：`observed` 表示其持久化
 * `user/message` 事件或 Host 队列出现已到达（并带有按提示词顺序
 * 排列的被接纳附件引用），`failed` 表示提示词在接纳前被拒绝、
 * 抛错或被中止。
 */
export type PendingSubmissionRetirement =
  | {
    readonly reason: 'observed'
    readonly attachments: readonly (ImageAttachmentRef | FileAttachmentRef)[]
  }
  | { readonly reason: 'failed' }

/** 在提示词调用之前注册一条本地提交回显的输入。 */
export interface BeginSubmissionInput {
  /** 随后的提示词所使用的投递模式。 */
  readonly mode: 'queue' | 'steer'
  /** 与随后的提示词将要发送的完全一致的提示词文本。 */
  readonly text: string
  /** 与随后的提示词附件匹配的有序图片预览与持久化文件元数据。 */
  readonly attachments: readonly PendingSubmissionAttachment[]
  /** 回显退役时恰好触发一次的落定回调。 */
  readonly onRetire?: (retirement: PendingSubmissionRetirement) => void
}

/** 一条已注册的提交回显：其提示词必须携带的身份，以及提示词前的逃生通道。 */
export interface SubmissionHandle {
  /** 提示词 RPC 身份；传给 {@link ISession.prompt}。 */
  readonly requestId: SessionRequestId
  /** 当调用方无法到达 prompt() 时（序列化失败）以失败退役该回显；任何其他落定之后为 no-op。 */
  abandon(): void
}

/** 按键寻址的投影读取门面（useProjection 的解析路径；见 ProjectionValueStore）。 */
export interface ProjectionsFace {
  /**
   * 单个投影键的身份稳定裸可观察对象（缺席表示
   * 一个 `undefined` 快照，绝不是缺失的门面）。
   * @param key - 投影键。
   * @returns 该键的值门面。
   */
  faceOf(key: string): ObservableSnapshot<unknown>
}

/** 身份加上功能包可以在 session 上调用的行为动词。 */
export interface ISession {
  /** 该 session 的 Host 身份（agent id —— 同一坐标轴）。 */
  readonly sessionId: SessionId
  /** Host 计算的按键排列的投影值（useProjection 的席位）。 */
  readonly projections: ProjectionsFace
  /**
   * 在调用方序列化并发送提示词之前，同步地把一条本地提交回显
   * 注册进 `snapshot.pendingSubmissions`。Chat 回显持续到持久化
   * 接纳为止；transcript 身份还要等待 Inbox 认领水位线，
   * 使过期的队列行保持抑制。
   * 排队回显在队列接纳时退役。已识别的失败会使尚未到达
   * 持久化接纳的提交退役。
   * @param input - 回显内容与可选的落定回调。
   * @returns 铸出的 {@link prompt} 身份加上提示词前的放弃路径。
   */
  beginSubmission(input: BeginSubmissionInput): SubmissionHandle
  /**
   * 向 session 发送一条提示词。
   * @param content - 文本加上浏览器持有的临时图片上传。
   * @param mode - 'queue' 追加一个 turn；'steer' 打断正在运行的 turn。
   * @param signal - 完整接纳往返的可选调用方取消。
   * @param requestId - 来自 {@link beginSubmission} 的身份；已识别的提示词失败会退役其回显。
   * @returns 接纳，或业务错误（同时镜像到 snapshot.promptError）。
   */
  prompt(
    content: PromptContentPart[],
    mode: 'queue' | 'steer',
    signal?: AbortSignal,
    requestId?: SessionRequestId,
  ): Promise<RemoteResult<{ accepted: true }>>
  /**
   * 解析本 session 引用的一张持久化图片。
   * @param attachmentId - 在折叠的 session 日志中找到的不透明 id。
   * @returns 经鉴权的引用与解码后的字节。
   */
  readAttachment(
    attachmentId: AttachmentIdType,
  ): Promise<RemoteResult<{ attachment: ImageAttachmentRef; data: Uint8Array }>>
  /**
   * 对一个仍在排队的队列出现应用一次编辑、移除或 Steer 操作。
   * @param itemId - agent 持有的 inbox 出现身份。
   * @param action - 请求的队列操作。
   * @returns 接纳，或业务/传输层错误。
   */
  updateQueue(itemId: MessageId, action: QueueAction): Promise<RemoteResult<{ accepted: true }>>
  /**
   * 取消正在运行的 turn。待处理的排队工作保留，并在 Host 达到取消静息后
   * 按 FIFO 顺序恢复。
   * @returns 接纳，或业务错误。
   */
  cancel(): Promise<RemoteResult<{ accepted: true }>>
  /**
   * 重命名此 session（显式的用户标题；将其固定以防自动重新生成）。
   * @param title - 原始标题文本（Host 规范化接纳）。
   * @returns 规范化后的已接纳标题及其事件 seq，或业务错误。
   */
  rename(title: string): Promise<RemoteResult<{ title: string; seq: SessionSeq }>>
  /**
   * 将历史向前（更早方向）扩展至少 50 条消息和两个 Turn 起点，
   * 包括窗口开头处一个部分 Turn。即使无法达到这些下限，也在
   * 500 条消息或历史耗尽处停止。发布一次 prepend。
   * @returns 完成；失败落在 snapshot.openState/loadingOlder。
   */
  loadOlder(): Promise<void>
  /**
   * 向更早方向分页历史，直到窗口覆盖 `seq`（含）—— turn 跳转加载器。
   * 跳转分页期间重复调用会降低其共享目标并返回进行中的完成；
   * `snapshot.loadingOlder` 是整个跳转的忙碌信号。
   * 每一页使用与 loadOlder 相同的 Turn 对齐，最小 200 条消息。
   * 500 条消息的限制按页生效，而不是整个跳转。
   * 更早的页在完成时一起发布，包括后续失败之前已成功的页；
   * 实时事件保持独立可见。
   * @param seq - 窗口必须到达的持久化事件 seq（某个 turn 的 `turn/start` seq）。
   * @returns 一旦覆盖、耗尽、被取代或软失败即完成。
   */
  loadThrough(seq: SessionSeq): Promise<void>
  /**
   * 针对此 session 的 agent 执行一行斜杠命令 —— 纯接纳语义
   * （Host 执行器持久化记录生命周期）。
   * @param line - 完整的命令行，包含前导斜杠。
   * @returns 接纳结果，或 Remote 门面的错误分支。
   */
  command(line: string): Promise<RemoteResult<{ matched: boolean }>>
}

/**
 * 完整的对外门面：行为动词加上 Session 生命周期读取侧
 * （`useSession` hook 的来源）。这是 `SessionBinding.session`
 * 与 provide 通道携带的类型。
 */
export type SessionFace = ISession & ObservableSnapshot<SessionSnapshot>
