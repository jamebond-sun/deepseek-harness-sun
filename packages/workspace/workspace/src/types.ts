/**
 * 工作区实体的公共类型词汇表：`WorkspaceId` 品牌以及
 * `Workspace` 消费者接口。仅有类型——`WorkspaceId` 工厂
 * 位于 `index.ts`（本文件不含运行时代码）。
 * @module @deepseek-ai/dsh-workspace/src/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TypertResource } from '@deepseek-ai/dsh-typert-protocol'

/**
 * 标识一条工作区记录。是生成的 uuid，而非路径：路径
 * 规范化会重写路径，而引用锚点必须保持稳定。
 */
export type WorkspaceId = Branded<'WorkspaceId'>

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertResourceMap {
    /** 一个工作区；Workspace Controller 注册其默认的 `workspaceId` 线字段。 */
    workspace: TypertResource<WorkspaceId>
  }

  interface RemoteErrorDetailsMap {
    /** 没有任何注册携带该工作区身份。 */
    'workspace/not-found': { readonly workspaceId: WorkspaceId }
  }
}

/**
 * 一个 `workspace/session-activity` 监听器可能报告的活动族。本包
 * 不声明任何族：每个提供方从其 Host 与 Client 两面都导入的模块中
 * 合并自身的键，因此渲染这些族的消费者看到的正好是其程序所编译的键，
 * 并对任何其他键回退到通用描述。已发布的提供方合并 `turn`（Agent
 * 注册表）、`job`（任务注册表接缝）、`subagent`（Subagent
 * 运行时）以及 `schedule`（Schedule 插件）。
 */
export interface SessionActivityKindMap {}

/** 一个活动族键。 */
export type SessionActivityKind = keyof SessionActivityKindMap

/** 一个具有逐项身份的族中的一项活动。 */
export interface SessionActivityItem {
  /** 族特定的身份：会话 id、任务 id 或计划 id。 */
  readonly id: string
  /** 当族携带一个显示标签时的展示标签（任务标签、子代理标签）。 */
  readonly label?: string
}

/**
 * 一个会话被计为活动（可被归档接纳）的一条理由。具有逐项身份的族
 * 会列出其条目，以便调用方指明必须停止的内容。
 */
export interface SessionActivity {
  readonly kind: SessionActivityKind
  /** 该族的活动条目；对于没有逐项身份的族（`turn`）则不存在。 */
  readonly items?: readonly SessionActivityItem[]
}

/**
 * 一个工作区：一个位于现有目录之上的稳定 id、一个显示标题，以及
 * 一个有序的会话候选记账。成员资格会将头部 cwd 与
 * 工作区路径进行校验，但当其完全限定的 cwd 缺失时保留已有的记账。
 * 消费者只能看到此接口；实现保持私有。
 */
export interface Workspace {
  /** 稳定的记录 id（生成的 uuid）。 */
  readonly id: WorkspaceId

  /**
   * 规范化目录路径：创建时给定路径的 `fs.realpath`
   * （末尾斜杠、`..` 以及符号链接均已被解析）。此后从不被重写，
   * 即使目录消失也是如此（见 {@link status}）。
   */
  readonly path: string

  /** 显示标题。默认为路径的最后一段，或文件系统根自身的拼写；允许重复。 */
  readonly title: string

  /** ISO-8601 创建时刻，在创建时盖戳且从不被重写。 */
  readonly createdAt: string

  /** 最后一次持久化变更的 ISO-8601 时刻（创建也算一次）。 */
  readonly updatedAt: string

  /**
   * 经头部校验、按手动拥有顺序的会话：新会话在附加时被前置，
   * 显式重排经由 `insertSessionBefore`，且活动从不重新排序。持久化的候选
   * 记账会被同步过滤：缺失的头部、无效的 cwd 值以及规范化的 cwd
   * 不匹配都绝不会被返回。一个完全限定的 cwd，若其 realpath 或目录
   * stat 以 ENOENT 失败，会保留已有的候选（包括悬空的符号链接）；
   * 其他文件系统失败则不会。后续的变更会剪枝被过滤掉的候选，
   * 而非缺失目录的候选。这不会接纳新会话，也不会重建目录。
   */
  readonly sessionIds: readonly SessionId[]

  /**
   * 持久化地替换显示标题。
   * @param title - 新标题；任意字符串，允许跨工作区重复。
   * @returns 在持久化之后的解析结果。
   */
  setTitle(title: string): Promise<void>

  /**
   * 将一个会话前置到本工作区的候选记账。已计入的 id
   * 会在不写入的情况下解析，除了每次被接受的变更都会执行的
   * 持久化过滤候选剪枝。一个新 id 的、活动的或已持久化的
   * 头部 cwd 必须解析为一个等于 {@link path} 的现有目录；
   * 未知的 id、缺失或无效的 cwd 值，以及不匹配都会在不写入的情况下拒绝。
   * @param sessionId - 要记录的会话。
   * @returns 在持久化之后的解析结果。
   */
  attachSession(sessionId: SessionId): Promise<void>

  /**
   * 在手动顺序中移动一个已计入的会话，类似 DOM 的 insertBefore：
   * 给定锚点时该会话落在其之前，未给定时追加到末尾。
   * 只有被移动的 id 会改变位置。不在记账中的会话或锚点
   * 会在不写入的情况下拒绝；移动到当前位置的
   * 操作会在不写入的情况下解析，除了每次被接受的变更都会执行的
   * 持久化过滤候选剪枝；在域写入链上决定。
   * @param sessionId - 要移动的已计入会话。
   * @param beforeSessionId - 要插入其前的已计入锚点；省略则追加。
   * @returns 在持久化之后的解析结果。
   */
  insertSessionBefore(sessionId: SessionId, beforeSessionId?: SessionId): Promise<void>

  /**
   * 从本工作区的记账中移除一个会话。幂等：不在记账上的 id
   * 会在不写入的情况下解析，除了每次被接受的变更都会执行的
   * 持久化过滤候选剪枝；与附加一样在域写入链上决定。
   * 从不会触碰会话自身的存储日志。
   * @param sessionId - 要移除的会话。
   * @returns 在持久化之后的解析结果。
   */
  detachSession(sessionId: SessionId): Promise<void>

  /**
   * 实时的、未缓存的目录检查：{@link path} 当前是否存在且
   * 为目录。缺失的目录从不会变更记录——目录可能只是被临时移动。
   * @returns 目录存在时为 `'ok'`，否则为 `'missing-dir'`。
   */
  status(): Promise<'ok' | 'missing-dir'>
}
