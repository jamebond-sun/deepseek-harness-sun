/**
 * 基于 JSON-RPC stdio 的 automation-only Agent Client Protocol 服务器。
 *
 * 该 bridge 把可持久化的 harness 会话暴露给受信任的程序化客户端。它承载标准配置、
 * MCP 挂载、提示词内容、已提交的语义更新、取消与一次性权限决策；
 * 呈现与人类交互功能仍由 harness 的 UI 模块负责。
 *
 * @module @deepseek-ai/dsh-acp
 */

import type { Context } from '@deepseek-ai/cordis'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import Schema from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { errorChain } from '@deepseek-ai/dsh-llm'
import {
  agent as createAcpAgentApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type AgentContext,
  type AuthenticateRequest,
  type CancelNotification,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SessionNotification,
  type Stream,
} from '@agentclientprotocol/sdk'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
// 副作用类型导入：通过声明合并引入下方应答的 approval waterfall。
import type {} from '@deepseek-ai/dsh-user-approval'
import { supportsAcpImagePrompts } from './content.ts'
import { AcpMcpConfigError } from './mcp.ts'
import { AcpModelConfigError } from './model-control.ts'
import { AcpSession } from './session.ts'

const DEFAULT_SESSION_LIST_PAGE_SIZE = 100

export const name = 'acp'
/** 标准 automation 控制所需的核心服务。 */
export const inject = ['agents', 'llm', 'sessionPersistence', 'sessions']

/** 在 SDK 线上错误消息中保留无效参数详情。 */
function invalidParams(detail: string): RequestError {
  return RequestError.invalidParams(undefined, detail)
}

/** 保留失败轮次详情；普通处理程序的错误会变成通用的线上内部错误。 */
function internalError(detail: string): RequestError {
  return RequestError.internalError(undefined, detail)
}

/** 插件配置：每个由 ACP 创建的 agent 所使用的提供方/模型选择。 */
export interface AcpConfig {
  /** 创建 agent 时使用的提供方路由。 */
  provider?: string
  /** 创建 agent 时使用的模型名称。 */
  model?: string
  /** 单次 session/list 分页返回的最大摘要数。 */
  sessionListPageSize?: number
  /** 仅运行期使用的传输覆盖；生产环境使用 stdio。 */
  stream?: Stream
}

export const Config: Schema<AcpConfig> = Schema.object({
  provider: Schema.string(),
  model: Schema.string(),
  sessionListPageSize: Schema.natural().min(1).default(DEFAULT_SESSION_LIST_PAGE_SIZE),
})

/**
 * 挂载 automation-only ACP 服务器。
 * @param ctx - 携带 agent 工厂与会话事件的 Cordis 上下文。
 * @param config - 初始提供方/模型选择以及可选的测试传输。
 */
export function apply(ctx: Context, config: AcpConfig): void {
  // ACP 处理程序在本插件的注入作用域之外执行，因此在 apply 期间捕获注入的服务，
  // 而不是在回调中延迟读取。
  const persistence = ctx.sessionPersistence
  const logger = ctx.logger
  const sessionListPageSize = resolveSessionListPageSize(config.sessionListPageSize)
  const sessions = new Map<SessionId, AcpSession>()
  const activating = new Set<SessionId>()
  let closed = false
  let imagePromptEnabled = false

  /** 返回 bridge 拥有的 agent 记录，并拒绝 id 相同的冒充者。 */
  const ownedRecord = (agent: Parameters<AcpSession['owns']>[0]): AcpSession | undefined => {
    const record = sessions.get(agent.session.id)
    return record?.owns(agent) === true ? record : undefined
  }

  const assertOpen = (): void => {
    if (closed) throw internalError('the ACP bridge has been disposed')
  }

  const requireSession = (sessionId: SessionId): AcpSession => {
    const record = sessions.get(sessionId)
    if (record === undefined) throw invalidParams(`unknown session: ${sessionId}`)
    return record
  }

  /** 发送一条有序协议更新，同时收敛仅由传输产生的失败。 */
  const notify = async (notification: SessionNotification): Promise<void> => {
    try {
      await conn.notify(methods.client.session.update, notification)
    /* v8 ignore start -- ACP SDK 会收敛通知处理程序的失败；只有传输写入失败会到达此保护分支。 */
    } catch (error: unknown) {
      logger.warn(`acp: session/update failed: ${String(error)}`)
    }
    /* v8 ignore stop */
  }

  ctx.on('session/event', (session, event) => {
    const record = sessions.get(session.header.id)
    if (record?.ownsSession(session) === true) record.onSessionEvent(session, event)
  })

  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    ownedRecord(agent)?.onInboxClaimed(message, turn)
  })

  ctx.on('agent/error', ({ agent, error }) => {
    ownedRecord(agent)?.onAgentError(error)
  })

  ctx.on('agent/status', ({ agent, status }) => {
    ownedRecord(agent)?.onAgentStatus(status)
  })

  ctx.on('llm/adapters-updated', () => {
    for (const record of sessions.values()) record.topologyChanged()
  })

  // 权限请求是面向 dsh-subagent-acp 等 ACP 客户端的机器策略通道。bridge 只提供
  // 一次性选项，绝不从未知的客户端响应推断持久授权。
  ctx.on('approval/request', (request, next) => {
    const record = ownedRecord(request.agent)
    if (record === undefined || request.callId === undefined) return next()
    const callId = request.callId
    return record.drainUpdates().then(() => {
      const params: RequestPermissionRequest = {
        sessionId: record.agent.session.id,
        toolCall: { toolCallId: callId },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      }
      return conn.request(methods.client.session.requestPermission, params)
    }).then(({ outcome }) => {
      if (outcome.outcome === 'cancelled') return 'cancelled'
      return outcome.optionId === 'allow-once' ? 'allowed-once' : 'rejected'
    })
  })

  const implementation = {
    async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
      // 单版本 agent：规范中的“若支持则使用相同版本，否则使用最新支持版本”，
      // 都归结为本服务器唯一的版本。
      imagePromptEnabled = await supportsAcpImagePrompts(ctx, config.provider, config.model)
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: 'deepseek-harness-acp', version: '0.0.1' },
        agentCapabilities: {
          mcpCapabilities: { http: true },
          promptCapabilities: { image: imagePromptEnabled, audio: false, embeddedContext: false },
          sessionCapabilities: { close: {}, list: {}, resume: {} },
        },
        authMethods: [],
      }
    },

    authenticate(_params: AuthenticateRequest): Promise<void> {
      return Promise.resolve()
    },

    async newSession(params: NewSessionRequest, signal: AbortSignal): Promise<NewSessionResponse> {
      assertOpen()
      validateWorkspaceParams(params)
      const sessionId = brandString<SessionId>(randomUUID())
      // 不做 preset 组合：ACP bundle 把面向模型的行保留在 host plane，因此该 agent
      // 从全局层读取它们。配置了 roster 的部署必须在此先加入一个
      // （@deepseek-ai/dsh-agent-preset-registry README，“Composing a child agent”）。
      let record: AcpSession
      try {
        record = await AcpSession.create(ctx, {
          sessionId,
          cwd: params.cwd,
          mcpServers: params.mcpServers,
          agentOptions: agentOptions(config),
          fallbackSelection: initialSelection(config),
          signal,
          notify,
        })
      } catch (error: unknown) {
        if (error instanceof AcpMcpConfigError) throw invalidParams(error.message)
        throw error
      }
      /* v8 ignore next 4 -- 真实的 stdio 关闭可能与进行中的创建竞争。 */
      if (closed) {
        await record.close('connection closed during session/new')
        throw internalError('connection closed during session/new')
      }
      sessions.set(sessionId, record)
      try {
        const configOptions = await record.configOptions(signal)
        assertOpen()
        // 已挂载日志写入器的 flush 会把空会话持久化落盘。
        await ctx.sessions.flush(record.agent.session)
        assertOpen()
        return { sessionId, configOptions }
      } catch (error: unknown) {
        sessions.delete(sessionId)
        await record.close('session/new activation failed')
        throw error
      }
    },

    async resumeSession(params: ResumeSessionRequest, signal: AbortSignal): Promise<ResumeSessionResponse> {
      assertOpen()
      validateWorkspaceParams(params)
      const sessionId = brandString<SessionId>(params.sessionId)
      if (sessions.has(sessionId) || activating.has(sessionId) || ctx.sessions.get(sessionId) !== undefined) {
        throw invalidParams(`session is already active: ${sessionId}`)
      }
      activating.add(sessionId)
      return (async (): Promise<ResumeSessionResponse> => {
        const persisted = (await persistence.stat(sessionId, { signal }))?.header
        if (persisted === undefined || persisted.origin === 'subagent' || persisted.parentSession !== undefined) {
          throw invalidParams(`session is not resumable: ${sessionId}`)
        }
        if (!await sameDirectory(persisted.cwd, params.cwd)) {
          throw invalidParams(`session cwd does not match: ${params.cwd}`)
        }
        let record: AcpSession
        try {
          record = await AcpSession.resume(ctx, {
            sessionId,
            cwd: params.cwd,
            mcpServers: params.mcpServers ?? [],
            agentOptions: agentOptions(config),
            fallbackSelection: initialSelection(config),
            signal,
            notify,
          })
        } catch (error: unknown) {
          if (error instanceof AcpMcpConfigError) throw invalidParams(error.message)
          throw error
        }
        /* v8 ignore start -- 持久化 header 已在恢复之前检查；工厂会恢复同一个 header。 */
        if (!await sameDirectory(record.agent.session.header.cwd, params.cwd)) {
          await record.close('session/resume cwd mismatch')
          throw invalidParams(`session cwd does not match: ${params.cwd}`)
        }
        /* v8 ignore stop */
        /* v8 ignore next 4 -- 真实的 stdio 关闭可能与进行中的恢复竞争。 */
        if (closed) {
          await record.close('connection closed during session/resume')
          throw internalError('connection closed during session/resume')
        }
        sessions.set(sessionId, record)
        try {
          return { configOptions: await record.configOptions(signal) }
        } catch (error: unknown) {
          sessions.delete(sessionId)
          await record.close('session/resume option discovery failed')
          throw error
        }
      })().finally(() => { activating.delete(sessionId) })
    },

    async listSessions(params: ListSessionsRequest, signal: AbortSignal): Promise<ListSessionsResponse> {
      assertOpen()
      if (params.cwd !== undefined && params.cwd !== null && !isAbsolute(params.cwd)) {
        throw invalidParams(`cwd must be an absolute path: ${params.cwd}`)
      }
      let cursor: SessionListCursor | undefined
      try {
        cursor = decodeSessionListCursor(params.cursor)
      } catch (error: unknown) {
        throw invalidParams((error as Error).message)
      }
      const listed = await persistence.list({ signal })
      const filtered = await Promise.all(listed.map(async ({ header }) => {
        if (
          sessions.has(header.id)
            || activating.has(header.id)
            || ctx.sessions.get(header.id) !== undefined
            || header.origin === 'subagent'
            || header.parentSession !== undefined
            || header.cwd === undefined
            || !isAbsolute(header.cwd)
        ) return undefined
        if (params.cwd !== undefined && params.cwd !== null && !await sameDirectory(header.cwd, params.cwd)) {
          return undefined
        }
        return { sessionId: header.id, cwd: header.cwd, createdAt: header.createdAt }
      }))
      const entries = filtered
        .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
        .sort((left, right) => right.createdAt - left.createdAt || compareSessionIds(left.sessionId, right.sessionId))
      const remaining = cursor === undefined
        ? entries
        : entries.filter(entry => isAfterSessionListCursor(entry, cursor))
      const page = remaining.slice(0, sessionListPageSize)
      const next = remaining.length > page.length ? page.at(-1) : undefined
      return {
        sessions: page.map(({ sessionId, cwd }) => ({ sessionId, cwd })),
        ...next === undefined ? {} : { nextCursor: encodeSessionListCursor(next) },
      }
    },

    async setSessionConfigOption(
      params: SetSessionConfigOptionRequest,
      signal: AbortSignal,
    ): Promise<SetSessionConfigOptionResponse> {
      assertOpen()
      const record = requireSession(brandString<SessionId>(params.sessionId))
      try {
        return { configOptions: await record.setConfig(params.configId, params.value, signal) }
      } catch (error: unknown) {
        if (error instanceof AcpModelConfigError) throw invalidParams(error.message)
        throw error
      }
    },

    async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
      assertOpen()
      const sessionId = brandString<SessionId>(params.sessionId)
      const record = requireSession(sessionId)
      try {
        await record.close('ACP session closed')
      } catch (error: unknown) {
        throw internalError(`session close failed: ${errorChain(error)}`)
      } finally {
        if (sessions.get(sessionId) === record) sessions.delete(sessionId)
      }
      return {}
    },

    async prompt(params: PromptRequest, requestSignal: AbortSignal): Promise<PromptResponse> {
      assertOpen()
      const record = requireSession(brandString<SessionId>(params.sessionId))
      return record.prompt(params, imagePromptEnabled, requestSignal)
    },

    cancel(params: CancelNotification): Promise<void> {
      sessions.get(brandString<SessionId>(params.sessionId))?.cancel()
      return Promise.resolve()
    },
  }

  /* v8 ignore next 4 -- 生产 stdio 接线；测试注入 config.stream。 */
  const stream: Stream = config.stream ?? ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  )
  const app = createAcpAgentApp({ name: 'deepseek-harness-acp' })
    .onRequest(methods.agent.initialize, ({ params }) => implementation.initialize(params))
    .onRequest(methods.agent.authenticate, async ({ params }) => {
      await implementation.authenticate(params)
      return {}
    })
    .onRequest(methods.agent.session.new, ({ params, signal }) => implementation.newSession(params, signal))
    .onRequest(methods.agent.session.list, ({ params, signal }) => implementation.listSessions(params, signal))
    .onRequest(methods.agent.session.resume, ({ params, signal }) => implementation.resumeSession(params, signal))
    .onRequest(methods.agent.session.close, ({ params }) => implementation.closeSession(params))
    .onRequest(methods.agent.session.setConfigOption, ({ params, signal }) => implementation.setSessionConfigOption(params, signal))
    .onRequest(methods.agent.session.prompt, ({ params, signal }) => implementation.prompt(params, signal))
    .onNotification(methods.agent.session.cancel, ({ params }) => implementation.cancel(params))
  const connection = app.connect(stream)
  const conn: AgentContext = connection.client

  let quiescing: Promise<void> | undefined
  const quiesce = (): Promise<void> => {
    if (quiescing !== undefined) return quiescing
    closed = true
    const records = [...sessions.values()]
    // AcpSession.close 在第一个 await 之前同步取消，因此每个拥有的提示词都会在
    // 任何后代或持久化 drain 阻塞之前停止。
    quiescing = (async () => {
      const disposals = await Promise.allSettled(records.map(record => record.close('ACP bridge disposed')))
      for (const record of records) {
        /* v8 ignore next -- closed 会阻止并发处理程序；每个已捕获的记录在此循环之前保持映射。 */
        if (sessions.get(record.agent.session.id) === record) sessions.delete(record.agent.session.id)
      }
      const failures: unknown[] = []
      for (const result of disposals) {
        if (result.status === 'rejected') failures.push(result.reason as unknown)
      }
      if (failures.length > 0) {
        // 生产消费方会通过 `String` 记录此 AggregateError，而它只渲染 message。
        // 把每个会话的诊断信息（包括嵌套 cause 与 aggregate 成员）都嵌入该 message。
        const detail = failures.map(failure => errorChain(failure)).join('; ')
        throw new AggregateError(
          failures,
          `ACP agent teardown failed for ${failures.length} session(s): ${detail}`,
        )
      }
    })()
    return quiescing
  }

  /* v8 ignore start -- 生产传输拒绝与销毁失败。 */
  void connection.closed
    .catch((error: unknown) => {
      logger.warn(`acp: connection closed with an error: ${String(error)}`)
    })
    .then(quiesce)
    .catch((error: unknown) => {
      logger.warn(`acp: connection-close teardown failed: ${String(error)}`)
    })
  /* v8 ignore stop */

  ctx.effect(() => quiesce, 'acp.connection')
}

/**
 * 根据插件配置构建 per-agent 选项，不为缺失的可选字段赋值。
 * @param config - ACP 提供方/模型配置。
 * @returns 仅包含已配置的字段。
 */
function agentOptions(config: AcpConfig): { provider?: string; model?: string } {
  return {
    ...config.provider !== undefined ? { provider: config.provider } : {},
    ...config.model !== undefined ? { model: config.model } : {},
  }
}

/** 两个部署字段都存在时的初始会话选择。 */
function initialSelection(config: AcpConfig): ModelSelection | undefined {
  return config.provider === undefined || config.model === undefined
    ? undefined
    : { provider: config.provider, model: config.model }
}

interface SessionListCursor {
  createdAt: number
  sessionId: string
}

/** 解析并校验部署方拥有的会话分页上限。 */
function resolveSessionListPageSize(value: number | undefined): number {
  const resolved = value ?? DEFAULT_SESSION_LIST_PAGE_SIZE
  /* v8 ignore start -- Cordis 会应用正整数 Config schema；此处保护直接调用 apply 的调用方。 */
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error('acp: sessionListPageSize must be a positive safe integer')
  }
  /* v8 ignore stop */
  return resolved
}

/** 解码不透明的 keyset 游标，不为客户端元数据赋予含义。 */
function decodeSessionListCursor(value: string | null | undefined): SessionListCursor | undefined {
  if (value === undefined || value === null) return undefined
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('session/list cursor is invalid')
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    const createdAt: unknown = Array.isArray(decoded) ? decoded[0] : undefined
    const sessionId: unknown = Array.isArray(decoded) ? decoded[1] : undefined
    if (
      !Array.isArray(decoded)
      || decoded.length !== 2
      || typeof createdAt !== 'number'
      || !Number.isSafeInteger(createdAt)
      || createdAt < 0
      || typeof sessionId !== 'string'
      || sessionId.length === 0
    ) throw new Error('invalid cursor fields')
    const canonical = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url')
    if (canonical !== value) throw new Error('non-canonical cursor')
    return { createdAt, sessionId }
  } catch (_invalidCursor) {
    throw new Error('session/list cursor is invalid')
  }
}

/** 将最后返回的排序键编码为不透明的续页令牌。 */
function encodeSessionListCursor(entry: SessionListCursor): string {
  return Buffer.from(JSON.stringify([entry.createdAt, entry.sessionId]), 'utf8').toString('base64url')
}

/** 判断条目在最新优先的列表顺序中是否位于游标之后。 */
function isAfterSessionListCursor(entry: SessionListCursor, cursor: SessionListCursor): boolean {
  return entry.createdAt < cursor.createdAt
    || (entry.createdAt === cursor.createdAt && compareSessionIds(entry.sessionId, cursor.sessionId) > 0)
}

/** 按稳定的 UTF-8 字节比较不透明会话 id，与进程 locale 无关。 */
function compareSessionIds(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

/** 拒绝 automation 约定之外的工作区特性。 */
function validateWorkspaceParams(params: { cwd: string; additionalDirectories?: string[] | null }): void {
  if (!isAbsolute(params.cwd)) throw invalidParams(`cwd must be an absolute path: ${params.cwd}`)
  if (
    params.additionalDirectories !== undefined
    && params.additionalDirectories !== null
    && params.additionalDirectories.length > 0
  ) {
    throw invalidParams('additionalDirectories is not supported')
  }
}

/** 已存在的目录按物理标识比较，缺失的路径按字面比较。 */
async function sameDirectory(left: string | undefined, right: string): Promise<boolean> {
  if (left === undefined) return false
  try {
    const [realLeft, realRight] = await Promise.all([realpath(left), realpath(right)])
    return realLeft === realRight
  } catch (_unresolvablePath) {
    return resolve(left) === resolve(right)
  }
}
