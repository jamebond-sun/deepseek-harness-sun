/** Session Remote 拥有者：冷读取、显式 Agent 命令与实时控制状态。 */

import { hostname } from 'node:os'
import { resolve } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { errorChain, ReasoningEffortId, type MessageSource } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-client-file-upload'
import { canOpenNativePath, nativeFileManager, nativeFileApplications, openNativeFileApplication, openNativeAssociatedPath, revealNativePath } from '@deepseek-ai/dsh-native-command'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import { SessionQueryError, type SessionObservation } from '@deepseek-ai/dsh-session-query'
import { Remote, RemoteError, TypertRemoteService, principalOf } from '@deepseek-ai/dsh-typert-protocol'
import { canonicalClientTimeZone } from '@deepseek-ai/dsh-util-time'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-api-remote-access'
import {
  ApiSessionAgentController,
  inspectApiSession,
  type ApiSessionAgentResult,
} from './agent.ts'
import { SessionCommandController, hasPromptContent } from './commands.ts'
import { SessionControlController } from './control.ts'
import { SessionHistoryController } from './history.ts'
import { SessionFileReferences } from './file-references.ts'
import { ApiSessionList } from './list.ts'
import { buildModelCatalog, hasProviderApiKey } from './catalog.ts'
import { installModelSelectionProjection } from './model-selection-projection.ts'
import { SessionSkillCatalog } from './skill-catalog.ts'
import { SessionMediaReferences } from './media-references.ts'
import { ArchivedSessionGate } from './archived-session-gate.ts'
import type {
  ModelCatalog,
  SessionWorkspacePathApplication,
  SessionAddress,
  SessionAttachmentRequest,
  SessionAttachmentValue,
  SessionCancelRequest,
  SessionCancelValue,
  SessionControlFrame,
  SessionCreateRequest,
  SessionCreateValue,
  SessionFollowFrame,
  SessionFollowRequest,
  SessionForkRequest,
  SessionForkValue,
  SessionListRequest,
  SessionListValue,
  SessionOpenWorkspacePathRequest,
  SessionOpenWorkspacePathValue,
  SessionPage,
  SessionPageRequest,
  SessionPromptRequest,
  SessionPromptValue,
  SessionRenameRequest,
  SessionRenameValue,
  SessionSearchRequest,
  SessionSearchValue,
  SessionSelectModelRequest,
  SessionSelectModelValue,
  SessionProjectionsRequest,
  SessionProjectionsValue,
  SessionProjectionValues,
  SessionUpdateQueueRequest,
  SessionUpdateQueueValue,
} from './types.ts'

export type * from './types.ts'
export { ApiSessionNotFound } from './agent.ts'
export { SessionFileReferences } from './file-references.ts'
export { SessionSkillCatalog } from './skill-catalog.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host Session 业务 API 与 Remote 命名空间拥有者。 */
    sessionController: SessionController
  }
}

/**
 * 读取历史地址所指名的 Session 资源：Session 本身，或
 * subagent 地址所读取其对话记录的子 Session。
 * @param request - 携带持久化地址的历史请求。
 * @returns 该读取需要访问权限的 Session。
 */
function addressedSession(request: { readonly address: SessionAddress }): SessionId {
  return request.address.kind === 'session' ? request.address.sessionId : request.address.childSessionId
}

/** Session Controller 部署策略。 */
export interface Config {
  /** 覆盖平台桌面打开器检测。 */
  readonly nativeOpen?: boolean
  /** 在完整行之间让出前，列表工作的正整数毫秒数。 */
  readonly listWorkSliceMs?: number
}

/** 应用 schema 默认值之后的部署策略。 */
type ResolvedConfig = Config & { readonly listWorkSliceMs: number }

/** 可被直接单元测试替换的 Host 集成。 */
export interface SessionControllerInternals {
  /** 原生默认应用程序移交。 */
  readonly openPath?: (path: string, signal: AbortSignal) => Promise<void>
  /** 原生文件关联查询。 */
  readonly fileApplications?: typeof nativeFileApplications
  /** 显式已注册应用程序移交。 */
  readonly openFileApplication?: typeof openNativeFileApplication
  /** 原生文件管理器移交。 */
  readonly revealPath?: (path: string, signal: AbortSignal) => Promise<void>
  /** 原生移交可用性探测。 */
  readonly canOpenPath?: () => boolean
}

/** 支撑生成的 `ctx.remote.session` 命名空间的 Host 服务。 */
export class SessionController extends TypertRemoteService {
  static inject = [
    'agentDefaultModel',
    'agents',
    'attachments',
    'fileUploads',
    'fs',
    'llm',
    'remoteAccess',
    'sessions',
    'sessionProjections',
    'sessionQuery',
    'typert',
    'workspaceRegistry',
  ]

  static Config: z<Config, ResolvedConfig> = z.object({
    nativeOpen: z.boolean(),
    listWorkSliceMs: z.natural().min(1).default(16),
  })

  private readonly agents: ApiSessionAgentController
  private readonly commands: SessionCommandController
  private readonly controlState: SessionControlController
  private readonly history: SessionHistoryController
  private readonly listState: ApiSessionList
  private readonly openPath: (path: string, signal: AbortSignal) => Promise<void>
  private readonly fileApplications: typeof nativeFileApplications
  private readonly openFileApplication: typeof openNativeFileApplication
  private readonly revealPath: (path: string, signal: AbortSignal) => Promise<void>
  private readonly canOpenPath: () => boolean
  private readonly promotions = new Set<Promise<void>>()

  /**
   * @param ctx - 包含 Session 能力组合的 Host 上下文。
   * @param config - 原生打开器与列表调度的部署策略。
   * @param internals - 可被直接单元测试替换的 Host 集成。
   */
  constructor(ctx: Context, config: Config, internals: SessionControllerInternals = {}) {
    super(ctx, 'sessionController', { namespace: 'session' })
    ctx.typert.resources.register('session', { field: 'sessionId' })
    const resolved = SessionController.Config(config)
    installModelSelectionProjection(ctx)
    this.agents = new ApiSessionAgentController(ctx)
    this.commands = new SessionCommandController(ctx, this.agents, process.cwd())
    ctx.effect(() => ctx.fileUploads.registerAgentResolver(async (sessionId) => {
      const result = await this.agents.resolveAgent(sessionId)
      if ('error' in result) throw result.error
      return result.agent
    }), 'session-controller: file-upload Agent resolver')
    this.controlState = new SessionControlController(ctx)
    // 在 history 之前注册，使逆序拆除在等待已接纳的激活之前
    // 先关闭每个跟随者。
    ctx.effect(() => async () => {
      await Promise.allSettled([...this.promotions])
    }, 'session-controller.promotions')
    this.history = new SessionHistoryController(ctx, (observation) => { this.promote(observation) })
    this.listState = new ApiSessionList(ctx, resolved.listWorkSliceMs)
    this.fileApplications = internals.fileApplications ?? nativeFileApplications
    this.openFileApplication = internals.openFileApplication ?? openNativeFileApplication
    this.openPath = internals.openPath ?? openNativeAssociatedPath
    this.revealPath = internals.revealPath ?? revealNativePath
    this.canOpenPath = internals.canOpenPath
      ?? (() => config.nativeOpen ?? (internals.openPath !== undefined || canOpenNativePath()))
    ctx.plugin(SessionFileReferences)
    ctx.plugin(SessionMediaReferences)
    ctx.plugin(SessionSkillCatalog)
    // 已归档的 Session 或其 subagent 后代在恢复之前不运行任何模型步骤；
    // 它仍在运行的工作由响应 Workspace 注册表归档准入事件的
    // 拥有者停止。
    ctx.plugin(ArchivedSessionGate)

    ctx.on('session/created', (session) => {
      ctx.emit('api-session/added', this.listState.summaryFor(session))
    })
    ctx.on('session/disposed', (session) => {
      ctx.emit('api-session/removed', session.id)
    })
    const publishAgentAvailability = ({ agent }: { agent: Agent }): undefined => {
      if (ctx.sessions.get(agent.id) === agent.session) {
        ctx.emit('api-session/added', this.listState.summaryFor(agent.session))
      }
    }
    ctx.on('agent/created', publishAgentAvailability)
    ctx.on('agent/disposed', publishAgentAvailability)
    ctx.on('agent/status', ({ agent, status }) => {
      ctx.emit('api-session/status', agent.id, status === 'running')
    })
    ctx.on('agent/error', ({ agent, error }) => {
      ctx.emit('api-session/error', agent.id, errorChain(error))
    })
    ctx.on('session/event', (session, event) => {
      if (event.type === 'request/header') {
        const agent = ctx.agents.get(session.id)
        if (agent?.session === session) this.agents.consumeSelection(
          agent,
          event.data.header.config.provider,
          event.data.header.config.model,
          event.data.header.config.reasoningEffort,
        )
      }
      if (event.type !== 'user/message' || event.data.source.kind !== 'user') return
      ctx.emit('api-session/activity', session.id, event.time)
    })
  }

  private promote(observation: SessionObservation): void {
    const sessionId = observation.header.id
    const task = (async () => {
      using ownedObservation = observation
      const result = await this.agents.resolveObservedAgent(ownedObservation)
      if ('error' in result) this.ctx.emit('api-session/error', sessionId, result.error.message)
    })().catch((error: unknown) => {
      this.ctx.logger.error(`session-controller: background activation for "${sessionId}" failed: ${errorChain(error)}`)
    })
    this.promotions.add(task)
    void task.finally(() => { this.promotions.delete(task) })
  }

  /**
   * 为另一个 Host API 域解析或恢复一个普通 Session。
   * @param sessionId - 其 Agent 拥有该操作的 Session 标识。
   * @returns 活跃 Agent 或稳定的 Session 域失败。
   */
  resolveAgent(sessionId: SessionId): Promise<ApiSessionAgentResult> {
    return this.agents.resolveAgent(sessionId)
  }

  /**
   * 检查一个已附加或已持久化的 Session，不激活其 Agent。
   * @param sessionId - 持久化 Session 标识。
   * @param signal - 持久化读取的可选调用方取消。
   * @returns 当前已附加状态，或持久化 header 与事件前缀。
   */
  inspect(
    sessionId: SessionId,
    signal?: AbortSignal,
  ): Promise<SessionInspection> {
    const attached = this.ctx.sessions.get(sessionId)
    if (attached !== undefined) {
      return Promise.resolve({
        meta: attached.header,
        inheritedEventCount: attached.inheritedEventCount,
        // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
        events: attached.snapshotEvents(),
      })
    }
    return inspectApiSession(this.ctx, sessionId, signal)
  }

  /**
   * 读取所有可见的 Session 行，不恢复 Agent。
   * @param _request - 保留的空列表请求。
   * @param signal - 持久化读取与摘要生成的取消。
   * @returns 按活动排序的可见 Session 摘要。
   */
  @Remote('list')
  async list(_request: SessionListRequest, signal: AbortSignal): Promise<SessionListValue> {
    const items = await this.listState.list(signal)
    return { items: items.filter(item => this.ctx.remoteAccess.allows({ kind: 'session', id: item.sessionId })) }
  }

  /**
   * 搜索可见的 Session 内容，不恢复 Agent。非拥有者只会收到其 Session
   * 通过 `allows()` 准入的命中；`hasMore` 描述的是该过滤之前的
   * 有界结果。
   * @param request - 字面消息内容查询。
   * @param signal - 列表与搜索读取的取消。
   * @returns 经授权的有界 Session 搜索结果。
   */
  @Remote('search')
  async search(request: SessionSearchRequest, signal: AbortSignal): Promise<SessionSearchValue> {
    const result = await this.listState.search(request.query, signal)
    return { ...result, items: result.items.filter(item => this.ctx.remoteAccess.allows({ kind: 'session', id: item.sessionId })) }
  }

  /**
   * 为新对话创建一个普通 Session，在命名空白 Session 仍可复用时复用它。
   * @param request - 可选的待复用空白 Session、位置与 Agent 预设。
   * @returns 创建或复用的 Session 标识，以及配置了预设时的该预设。
   */
  @Remote('create')
  create(request: SessionCreateRequest): Promise<SessionCreateValue> {
    return this.commands.create(request)
  }

  /**
   * 在显式恢复 Session 之后选择一个 Session 本地模型；在后台保存默认值。
   * @param request - Session 标识与请求的模型选择。
   * @returns 为该 Session 安装的规范化选择，不等待默认值持久化。
   */
  @Remote('selectModel')
  selectModel(request: SessionSelectModelRequest): Promise<SessionSelectModelValue> {
    return this.commands.selectModel(request)
  }

  /**
   * 在未配置提供方 API 密钥时，于登录后选择第一个可用的账户模型。
   * @returns 在保存第一个可用模型或保留既有默认值之后。
   */
  @Remote
  async initializeDefaultModel(): Promise<void> {
    const provider = 'deepseek-account'
    if (await hasProviderApiKey(this.ctx)) return
    const catalog = await buildModelCatalog(this.ctx)
    const model = catalog.groups.find(group => group.id === provider)?.models[0]
    if (model === undefined) throw new RemoteError('session/provider-models-unavailable',
      `provider "${provider}" has no available models`, { provider })
    const selection = { provider, model: model.id,
      ...model.reasoning?.defaultEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(model.reasoning.defaultEffort) },
    }
    await this.ctx.agentDefaultModel.saveSelection(selection)
  }

  /**
   * 为 Host 生成的选择器描述每个当前可路由的模型。
   * @returns 按提供方分组的模型、部署默认值，以及相互隔离的提供方失败。
   */
  @Remote('modelCatalog')
  modelCatalog(): Promise<ModelCatalog> {
    return buildModelCatalog(this.ctx)
  }

  /**
   * 报告此部署能否将 Session 工作区路径交给原生桌面。
   * @returns 当匹配的打开操作可用时为 true。
   */
  @Remote
  canOpenWorkspacePath(): boolean {
    return this.canOpenPath()
  }

  /**
   * 描述为经过身份验证的文件操作路由提供服务的桌面。
   * @returns Host 名、配置的可用性，以及平台特定的文件管理器行为。
   */
  workspaceDesktop(): { name: string; available: boolean; fileManager: 'finder' | 'explorer' | 'directory' | null } {
    const fileManager = nativeFileManager()
    return { name: hostname(), available: fileManager !== null && this.canOpenPath(), fileManager }
  }

  /**
   * 通过组合的文件系统验证一个路径，并在 Host 桌面上打开它。
   * @param request - 尽力完成 Session 工作区解析后的路径。
   * @param signal - 调用方生命周期；中止会终止原生命令。
   * @returns 原生打开器接受该路径后的确认。
   * @throws RemoteError 当请求无效、没有已验证的 Host 映射、被取消或打开器失败时。
   */
  @Remote('openWorkspacePath')
  async openWorkspacePath(
    request: SessionOpenWorkspacePathRequest,
    signal: AbortSignal,
  ): Promise<SessionOpenWorkspacePathValue> {
    try {
      const path = await this.verifyDesktopPath(request.path, signal)
      if (request.action === 'reveal') await this.revealPath(path, signal)
      else if (request.application !== undefined) await this.openFileApplication(path, request.application, signal)
      else await this.openPath(path, signal)
      return { opened: true }
    } catch (error: unknown) {
      if (signal.aborted) throw new RemoteError('gateway/cancelled', 'path open was aborted', {})
      if (error instanceof RemoteError) throw error
      throw new RemoteError(
        'gateway/internal',
        'path open failed',
        {},
        { cause: error },
      )
    }
  }

  /**
   * 在提供服务的桌面上查询当前文件处理程序，不激活 Agent。
   * @param request - Host 文件系统语法的文件路径。
   * @param signal - 调用方生命周期，传播到文件系统与桌面查询。
   * @returns 操作系统应用程序名称、图标与默认选择；桌面打开不可用时为空。
   * @throws RemoteError 当路径无效、查询被取消或原生发现失败时。
   */
  @Remote('workspacePathApplications')
  async workspacePathApplications(
    request: { readonly path: string }, signal: AbortSignal,
  ): Promise<readonly SessionWorkspacePathApplication[]> {
    if (!this.canOpenPath()) return []
    try {
      const path = await this.verifyDesktopPath(request.path, signal)
      return await this.fileApplications(path, signal)
    } catch (error: unknown) {
      if (signal.aborted) throw new RemoteError('gateway/cancelled', 'application query was aborted', {})
      if (error instanceof RemoteError) throw error
      throw new RemoteError('gateway/internal', 'file application query failed', {}, { cause: error })
    }
  }

  private async verifyDesktopPath(path: string, signal: AbortSignal): Promise<string> {
    if (path.length === 0) throw new RemoteError('gateway/bad-request', 'A non-empty file path is required', {})
    signal.throwIfAborted()
    const hostPath = resolve(path)
    const { fs } = this.ctx
    const mapped = fs.processPathFromHostPath(hostPath)
    if (mapped === undefined || fs.processPath(await fs.resolve(mapped, { signal })) !== hostPath) {
      throw new RemoteError('gateway/bad-request', 'Path has no verified Host path', {})
    }
    signal.throwIfAborted()
    return hostPath
  }

  /**
   * 在显式恢复一个 Session 之后重命名它。
   * @param request - Session 标识与建议的标题。
   * @returns 被接受的标题与持久化事件序列。
   */
  @Remote('rename')
  rename(request: SessionRenameRequest): Promise<SessionRenameValue> {
    return this.commands.rename(request)
  }

  /**
   * 将一个冷可读的精确事件前缀分叉为新 Session。省略的
   * 边界选择最新的已完成回合前缀；开放切点会收到合成的
   * 分叉收尾事件。
   * @param request - 源 Session、可选的精确含端点事件边界，以及迁移预检选择。
   * @returns 新 Session 的标识。
   */
  @Remote('fork')
  async fork(request: SessionForkRequest): Promise<SessionForkValue> {
    if (request.allowMigration === false && this.ctx.sessions.get(request.sessionId) === undefined) {
      const stored = await this.ctx.get('sessionPersistence')?.stat(request.sessionId)
      if (stored?.formatStatus === 'migration-required' && this.ctx.sessions.get(request.sessionId) === undefined) {
        throw new RemoteError('session/migration-required', 'Open the source Session to complete migration before forking', {
          sessionId: request.sessionId,
        })
      }
    }
    return this.commands.fork(request)
  }

  /**
   * 在显式恢复其 Session 之后接纳一条提示词。
   * @param request - Session 标识、提示词内容、来源元数据与投递模式。
   * @param signal - 提示词接纳开始之前的调用方取消。
   * @returns Agent 已接受该提示词的确认。
   */
  @Remote('prompt')
  async prompt(request: SessionPromptRequest, signal: AbortSignal): Promise<SessionPromptValue> {
    signal.throwIfAborted()
    if (!hasPromptContent(request.content)) {
      throw new RemoteError('gateway/bad-request', 'prompt content must include non-whitespace text or an attachment', {})
    }
    const clientTimeZone = request.clientTimeZone === undefined
      ? undefined
      : canonicalClientTimeZone(request.clientTimeZone)
    if (request.clientTimeZone !== undefined && clientTimeZone === undefined) {
      throw new RemoteError(
        'session/invalid-time-zone',
        'clientTimeZone must be UTC or a valid IANA Area/Location name',
        { value: request.clientTimeZone },
      )
    }
    // 仅当调用方不是拥有者时才记录它，因此拥有者的消息保留其确切来源。
    const principal = principalOf(this.ctx.invocation)
    const source: MessageSource = {
      kind: 'user',
      rpcId: request.requestId,
      ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
      ...(principal === undefined ? {} : { principal }),
    }
    return this.commands.prompt(request, source)
  }

  /**
   * 读取一张已被证明可从被寻址 Session 日志到达的图片。
   * @param request - 用于授权的 Session 与附件标识。
   * @returns 持久化附件引用与 base64 编码的字节。
   */
  @Remote('attachment')
  attachment(request: SessionAttachmentRequest): Promise<SessionAttachmentValue> {
    return this.commands.attachment(request)
  }

  /**
   * 变更一个仍待处理的队列条目，先恢复冷 Agent。
   * @param request - Session、队列项与请求的变更。
   * @returns 队列变更已应用的确认。
   */
  @Remote('updateQueue')
  updateQueue(request: SessionUpdateQueueRequest): Promise<SessionUpdateQueueValue> {
    return this.commands.updateQueue(request)
  }

  /**
   * 取消一个活跃的 Agent 回合，不丢弃其待处理的收件箱。
   * @param request - 其活跃 Agent 回合被取消的 Session。
   * @returns 已请求取消的确认。
   */
  @Remote('cancel')
  cancel(request: SessionCancelRequest): SessionCancelValue {
    return this.commands.cancel(request)
  }

  /**
   * 读取一个冷安全、按消息对齐的 Session 历史页。
   * @param request - 持久化地址、向后游标与页预算。
   * @param signal - 持久化读取的取消。
   * @returns 一个按时间顺序的页。
   */
  @Remote({ name: 'page', resources: { session: addressedSession } })
  page(request: SessionPageRequest, signal: AbortSignal): Promise<SessionPage> {
    return this.history.page(request, signal)
  }

  /**
   * 从开场或恢复游标起跟随一个 Session 日志。
   * @param request - 持久化地址与调用方已持有的最后已提交序列。
   * @param signal - 由 Remote 流载体拥有的取消。
   * @returns 完整的开场快照，其后是无间隙的持久化事件
   *   帧与可选的无游标 assistant 流帧。
   */
  @Remote({ mode: 'stream', resources: { session: addressedSession } })
  follow(request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame> {
    return this.history.follow(request, signal)
  }

  /**
   * 读取精确投影，仅在需要迁移时返回缓存提示。
   * @param request - 需要其当前值的 Session。
   * @param signal - Session 读取的取消。
   * @returns sequenced 基线、迁移被推迟时的缓存提示，或不存在时为 null。
   */
  @Remote('projections')
  async projections(request: SessionProjectionsRequest, signal: AbortSignal): Promise<SessionProjectionsValue> {
    const { sessionId } = request
    if (sessionId.length === 0) {
      throw new RemoteError('gateway/bad-request', 'sessionId must not be empty', {})
    }
    try {
      signal.throwIfAborted()
      const live = this.liveProjections(sessionId)
      if (live !== undefined) return live
      const stored = await this.ctx.get('sessionPersistence')?.stat(sessionId, { signal })
      signal.throwIfAborted()
      const attached = this.liveProjections(sessionId)
      if (attached !== undefined) return attached
      if (stored === undefined) return null
      if (stored.formatStatus === 'migration-required') {
        const cached = this.ctx.get('sessionProjectionCache')?.cachedSnapshot(stored.header)
        return { kind: 'migration-required', values: { ...cached?.values } as SessionProjectionValues }
      }
      using observation = await this.ctx.sessionQuery.observeSession(sessionId, { signal })
      const projections = observation.projections
      if (projections === undefined) {
        throw new RemoteError('session/projections-unavailable', 'Session projections are unavailable', {})
      }
      return { kind: 'sequenced', asOfSeq: projections.asOfSeq, values: projections.values as SessionProjectionValues }
    } catch (error: unknown) {
      if (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
        return this.liveProjections(sessionId) ?? null
      }
      if (signal.aborted || (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_ABORTED')) {
        throw new RemoteError('gateway/cancelled', 'Session projection read was cancelled', {}, { cause: error })
      }
      if (error instanceof RemoteError) throw error
      throw new RemoteError('gateway/internal', 'Session projection read failed', {}, { cause: error })
    }
  }

  private liveProjections(
    sessionId: SessionId,
  ): Extract<SessionProjectionsValue, { readonly kind: 'sequenced' }> | undefined {
    const session = this.ctx.sessions.get(sessionId)
    if (session === undefined) return undefined
    const snapshot = this.ctx.sessionProjections.snapshot(session)
    return { kind: 'sequenced', asOfSeq: snapshot.asOfSeq, values: snapshot.values as SessionProjectionValues }
  }

  /**
   * 流式传输完整的实时控制基线及其后的替换帧。
   * @param signal - 由 Remote 流载体拥有的取消。
   * @returns 一个完整基线及其后的实时替换帧。
   */
  @Remote({ mode: 'stream' })
  async *control(signal: AbortSignal): AsyncIterable<SessionControlFrame> {
    for await (const frame of this.controlState.control(signal)) {
      switch (frame.type) {
        case 'baseline': {
          const projections = Object.fromEntries(Object.entries(frame.value.projections)
            .filter(([sessionId]) => this.ctx.remoteAccess.allows({ kind: 'session', id: sessionId as SessionId })))
          yield { type: 'baseline', value: { ...frame.value, projections } }
          break
        }
        case 'projection':
          if (this.ctx.remoteAccess.allows({ kind: 'session', id: frame.sessionId })) yield frame
          break
        /* v8 ignore next -- closed control-frame union. */
        default:
          assertNever(frame)
      }
    }
  }


}

export { buildModelCatalog }
export default SessionController
