/** Host Workspace Remote 属主：显式命令与重连安全的状态。 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-api-remote-access'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { WorkspaceCommands } from './commands.ts'
import { DirectoryPickerController } from './directory-picker.ts'
import { WorkspaceFeed, workspaceView } from './feed.ts'
import { defaultWorkspaceDirectory, validateDocumentsDirectory } from './default-directory.ts'
import type {
  WorkspaceArchiveSessionRequest,
  WorkspaceArchiveValue,
  WorkspaceBaseline,
  WorkspaceCreateRequest,
  WorkspaceCreateValue,
  WorkspaceDeleteRequest,
  WorkspaceDeleteValue,
  WorkspaceFollowFrame,
  WorkspaceId,
  WorkspaceInsertBeforeRequest,
  WorkspaceInsertSessionBeforeRequest,
  WorkspaceOrderValue,
  WorkspacePinSessionRequest,
  WorkspacePinValue,
  WorkspaceRenameRequest,
  WorkspaceUnarchiveSessionRequest,
  WorkspaceUnpinSessionRequest,
  WorkspaceValue,
} from './types.ts'

export type * from './types.ts'
export { DirectoryPickerController } from './directory-picker.ts'

/** Host 账户的首次使用目录策略。 */
export interface Config {
  /** 以完全限定路径覆盖系统 Documents 目录。 */
  documentsDirectory?: string
  /** 操作系统 Documents 查询的最长时长（毫秒）。 */
  documentsLookupTimeoutMs?: number
}

/** 应用 schema 默认值后的目录策略。 */
type ResolvedConfig = Config & { documentsLookupTimeoutMs: number }

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host Workspace 业务 API 与 Remote 命名空间属主。 */
    workspaceController: WorkspaceController
  }
}

/** 支撑生成的 `ctx.remote.workspace` 命名空间的 Host 服务。 */
export class WorkspaceController extends TypertRemoteService {
  static inject = ['remoteAccess', 'typert', 'workspaceRegistry']

  static Config: z<Config, ResolvedConfig> = z.object({
    documentsDirectory: z.string(),
    documentsLookupTimeoutMs: z.natural().min(1).default(10_000),
  })

  private readonly config: ResolvedConfig
  private readonly commands: WorkspaceCommands
  private readonly feed: WorkspaceFeed

  /**
   * @param ctx - 包含 Workspace 注册表的 Host 上下文。
   * @param config - 首次使用目录策略。
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'workspaceController', { namespace: 'workspace' })
    ctx.typert.resources.register('workspace', { field: 'workspaceId' })
    this.config = WorkspaceController.Config(config)
    if (this.config.documentsDirectory !== undefined) validateDocumentsDirectory(this.config.documentsDirectory)
    this.commands = new WorkspaceCommands(ctx)
    this.feed = new WorkspaceFeed(ctx)
    // 本包是其承载的两个 Remote 属主的 Loader 入口：目录选择接缝是
    // 抽象的，自身从不是入口。该子插件保持挂起，直到组合出选择
    // 后端，因此没有选择后端的 Host 不注册选择命名空间，
    // 而不是应答一个无法服务的动词。
    ctx.plugin(DirectoryPickerController)
  }

  /**
   * 在一个现有目录上创建或幂等地解析一个 Workspace。
   * @param request - 要注册的目录路径。
   * @returns Workspace 以及本次调用是否创建了它。
   */
  @Remote('create')
  create(request: WorkspaceCreateRequest): Promise<WorkspaceCreateValue> {
    return this.commands.create(request)
  }

  /**
   * 在首次使用启动期间初始化或复用默认 Workspace。目录名是固定的，
   * 因此 Host 从不重命名或迁移已有的默认项；其初始标题就是该名称，
   * 浏览器消费方以阅读者语言为其显示标签。
   * @param signal - 调用方生命周期；取消原生目录查询。
   * @returns 持久 Workspace，首次使用初始化不符合条件时为 undefined；不创建任何 Session 或消息。
   */
  @Remote('initializeDefault')
  async initializeDefault(signal: AbortSignal): Promise<WorkspaceValue | undefined> {
    const workspace = await this.ctx.workspaceRegistry.initializeDefault(async () => {
      const timeout = AbortSignal.timeout(this.config.documentsLookupTimeoutMs)
      return await defaultWorkspaceDirectory(
        this.config.documentsDirectory, AbortSignal.any([signal, timeout]),
      )
    })
    return workspace === undefined ? undefined : { workspace: workspaceView(workspace) }
  }

  /**
   * 将一个 Workspace 重命名为唯一的非空标题。
   * @param request - Workspace 身份与拟用标题。
   * @returns 更新后的 Workspace 投影。
   */
  @Remote('rename')
  rename(request: WorkspaceRenameRequest): Promise<WorkspaceValue> {
    return this.commands.rename(request)
  }

  /**
   * 移除一个 Workspace 注册，同时保留其文件与 Session。
   * @param request - 要移除的 Workspace 身份。
   * @returns 删除确认。
   */
  @Remote('delete')
  delete(request: WorkspaceDeleteRequest): Promise<WorkspaceDeleteValue> {
    return this.commands.delete(request)
  }

  /**
   * 在注册表展示顺序中移动一个 Workspace。
   * @param request - 被移动的 Workspace 与可选锚点。
   * @returns 变更后的完整 Workspace 顺序。
   */
  @Remote('insertBefore')
  insertBefore(request: WorkspaceInsertBeforeRequest): Promise<WorkspaceOrderValue> {
    return this.commands.insertBefore(request)
  }

  /**
   * 在一个 Workspace 内移动一个已归入的 Session。
   * @param request - Workspace、Session 与可选锚点身份。
   * @returns 更新后的 Workspace 投影。
   */
  @Remote('insertSessionBefore')
  insertSessionBefore(request: WorkspaceInsertSessionBeforeRequest): Promise<WorkspaceValue> {
    return this.commands.insertSessionBefore(request)
  }

  /**
   * 在 Workspace 分组界面隐藏一个已知 Session。
   * @param request - 要归档的 Session 身份。
   * @returns 变更后的完整归档集合。
   */
  @Remote('archiveSession')
  archiveSession(request: WorkspaceArchiveSessionRequest): Promise<WorkspaceArchiveValue> {
    return this.commands.archiveSession(request)
  }

  /**
   * 将一个已归档 Session 恢复到 Workspace 分组界面。
   * @param request - 要取消归档的 Session 身份。
   * @returns 变更后的完整归档集合。
   */
  @Remote('unarchiveSession')
  unarchiveSession(request: WorkspaceUnarchiveSessionRequest): Promise<WorkspaceArchiveValue> {
    return this.commands.unarchiveSession(request)
  }

  /**
   * 将一个已知未归档 Session 置于未置顶 Session 之前。
   * @param request - 要置顶的 Session 身份。
   * @returns 变更后的完整置顶集合，最近置顶的在前。
   */
  @Remote('pinSession')
  pinSession(request: WorkspacePinSessionRequest): Promise<WorkspacePinValue> {
    return this.commands.pinSession(request)
  }

  /**
   * 移除一个 Session 的置顶，而不改变其已保存的 Session 顺序。
   * @param request - 要取消置顶的 Session 身份。
   * @returns 变更后的完整置顶集合，最近置顶的在前。
   */
  @Remote('unpinSession')
  unpinSession(request: WorkspaceUnpinSessionRequest): Promise<WorkspacePinValue> {
    return this.commands.unpinSession(request)
  }

  /**
   * 流式发送完整 Workspace 基线，随后是有序增量。非属主只收到
   * `allows()` 允许的 Workspace 与 Session。当一个已交付的 Workspace
   * 在其下次变更或下次顺序变更时不再被允许，流会发送携带完整
   * 过滤状态的 `replace` 帧而非 `remove`，因为 Client 从不复活
   * 已移除的 Workspace；`remove` 帧报告一次删除，且只会到达
   * 接收过该 Workspace 的 Client。
   * @param signal - 生成取消。
   * @returns 基线，随后是有序 Workspace 增量。
   */
  @Remote({ mode: 'stream' })
  async *follow(signal: AbortSignal): AsyncIterable<WorkspaceFollowFrame> {
    const access = this.ctx.remoteAccess
    const visible = (workspaceId: WorkspaceId): boolean => access.allows({ kind: 'workspace', id: workspaceId })
    const sessions = (sessionIds: readonly SessionId[]): SessionId[] =>
      sessionIds.filter(sessionId => access.allows({ kind: 'session', id: sessionId }))
    /** 本生成已交付且尚未移除的 Workspace。 */
    const delivered = new Set<WorkspaceId>()
    /** `value` 中被允许的部分；它成为已交付集合。 */
    const filtered = (value: WorkspaceBaseline): WorkspaceBaseline => {
      const items = value.items.filter(item => visible(item.workspaceId))
      delivered.clear()
      for (const item of items) delivered.add(item.workspaceId)
      return {
        items: items.map(item => ({ ...item, sessionIds: sessions(item.sessionIds) })),
        archivedSessionIds: sessions(value.archivedSessionIds),
        pinnedSessionIds: sessions(value.pinnedSessionIds),
      }
    }
    for await (const frame of this.feed.follow(signal)) {
      switch (frame.type) {
        case 'baseline':
          yield { type: 'baseline', value: filtered(frame.value) }
          break
        case 'upsert': {
          const workspaceId = frame.workspace.workspaceId
          if (visible(workspaceId)) {
            delivered.add(workspaceId)
            yield { type: 'upsert', workspace: { ...frame.workspace, sessionIds: sessions(frame.workspace.sessionIds) } }
          } else if (delivered.has(workspaceId)) {
            yield { type: 'replace', value: filtered(this.feed.baseline()) }
          }
          break
        }
        case 'remove':
          if (delivered.delete(frame.workspaceId)) yield frame
          break
        case 'order':
          if (frame.workspaceIds.some(workspaceId => delivered.has(workspaceId) && !visible(workspaceId))) {
            yield { type: 'replace', value: filtered(this.feed.baseline()) }
          } else {
            yield { type: 'order', workspaceIds: frame.workspaceIds.filter(visible) }
          }
          break
        case 'archived':
          yield { type: 'archived', archivedSessionIds: sessions(frame.archivedSessionIds) }
          break
        case 'pinned':
          yield { type: 'pinned', pinnedSessionIds: sessions(frame.pinnedSessionIds) }
          break
        /* v8 ignore next -- 封闭的 follow 帧联合。 */
        default:
          assertNever(frame)
      }
    }
  }
}

/* v8 ignore next 3 -- 封闭联合的兜底。 */
function assertNever(value: never): never {
  throw new Error(`unreachable Workspace follow frame: ${JSON.stringify(value)}`)
}

export default WorkspaceController
