/** 用于只读 Cordis 能力提供方的浏览器侧注册表。 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  CordisInspectProviderManifest, CordisInspectQueryRequest, CordisInspectQueryResolution,
  CordisInspectRequestId, SessionId,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** 提供给 Client 巡检提供方查询的上下文。 */
export interface ClientCordisInspectQueryContext {
  /** 由 Host 广播的取消信号。 */
  signal: AbortSignal
  /** 发起该查询的模型所属会话。 */
  sessionId: SessionId
}

/** 与可序列化清单并列保留的 Client 提供方注册项。 */
export interface ClientCordisInspectProviderRegistration {
  /** 提供方及其显式查询目录。 */
  manifest: CordisInspectProviderManifest
  /** 执行一个已声明的只读方法。 */
  query(method: string, input: JsonValue | undefined, context: ClientCordisInspectQueryContext): Promise<JsonValue>
}

/** Client 注册表所需的远程操作。 */
export interface ClientCordisInspectHost {
  /** 替换 Host 镜像的 Client 清单。 */
  sync(providers: readonly CordisInspectProviderManifest[]): Promise<void>
  /** 提交一条查询结果；首个被接受的页面胜出。 */
  resolve(
    sessionId: SessionId,
    requestId: CordisInspectRequestId,
    resolution: CordisInspectQueryResolution,
  ): Promise<void>
}

/** Client 提供方注册表、清单发布器与实时查询分发器。 */
export class ClientCordisInspectRegistry {
  private readonly providers = new Map<string, ClientCordisInspectProviderRegistration>()
  private readonly active = new Map<CordisInspectRequestId, AbortController>()
  private publishQueued = false
  private syncChain = Promise.resolve()

  /** @param host - 折叠后的清单与查询结果传输层。 */
  constructor(private readonly host: ClientCordisInspectHost) {}

  /**
   * 注册一个 Client 提供方并发布一份新的完整清单。
   * @param registration - 提供方清单与本地处理器。
   * @returns 幂等的释放器。
   */
  register(registration: ClientCordisInspectProviderRegistration): () => void {
    const { manifest } = registration
    if (manifest.id.trim() === '') throw new Error('Client Cordis inspect provider id must not be empty')
    if (this.providers.has(manifest.id)) throw new Error(`Client Cordis inspect provider "${manifest.id}" is already registered`)
    const names = new Set<string>()
    for (const method of manifest.methods) {
      if (names.has(method.name)) throw new Error(`Client Cordis inspect provider "${manifest.id}" repeats method "${method.name}"`)
      names.add(method.name)
    }
    this.providers.set(manifest.id, registration)
    this.publish()
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      if (this.providers.get(manifest.id) === registration) {
        this.providers.delete(manifest.id)
        this.publish()
      }
    }
  }

  /** 发布当前的完整清单，重连后亦如此。 */
  publish(): void {
    if (this.publishQueued) return
    this.publishQueued = true
    queueMicrotask(() => {
      this.publishQueued = false
      const manifests = [...this.providers.values()].map(provider => provider.manifest)
      this.syncChain = this.syncChain.then(async () => {
        await this.host.sync(manifests)
      }).catch((error: unknown) => {
        console.error('[cordis-client-runner] syncing inspect providers failed:', error)
      })
    })
  }

  /**
   * 执行并应答一次 Host 广播的查询。
   * @param request - 从 Host 收到的精确提供方查询与会话关联。
   * @returns 在首个本地结果已回传 Host 之后。
   */
  async query(request: CordisInspectQueryRequest): Promise<void> {
    if (this.active.has(request.requestId)) return
    const controller = new AbortController()
    this.active.set(request.requestId, controller)
    let resolution: CordisInspectQueryResolution
    try {
      const provider = this.providers.get(request.provider)
      if (provider === undefined) {
        resolution = { ok: false, reason: 'provider-missing', message: `Client inspect provider "${request.provider}" is unavailable` }
      } else if (!provider.manifest.methods.some(method => method.name === request.method)) {
        resolution = { ok: false, reason: 'method-missing', message: `Client inspect provider "${request.provider}" has no method "${request.method}"` }
      } else {
        const data = await provider.query(request.method, request.input, {
          signal: controller.signal,
          sessionId: request.agentId,
        })
        resolution = controller.signal.aborted
          ? { ok: false, reason: 'cancelled', message: 'Client inspect query was cancelled' }
          : { ok: true, data }
      }
    } catch (error) {
      resolution = controller.signal.aborted
        ? { ok: false, reason: 'cancelled', message: 'Client inspect query was cancelled' }
        : { ok: false, reason: 'provider-error', message: error instanceof Error ? error.message : String(error) }
    } finally {
      this.active.delete(request.requestId)
    }
    if (controller.signal.aborted) return
    await this.host.resolve(request.agentId, request.requestId, resolution)
  }

  /**
   * 在另一页面已应答或 Tool 调用结束后，取消本地工作。
   * @param requestId - 不再可应答的查询关联。
   */
  close(requestId: CordisInspectRequestId): void {
    this.active.get(requestId)?.abort()
    this.active.delete(requestId)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 用于预定义前 Cordis 能力发现的浏览器侧注册表。 */
    cordisInspect: ClientCordisInspectRegistry
  }
}

/**
 * 将注册表作为一个普通 Client 服务提供。
 * @param ctx - 接收该服务的 Client Cordis 上下文。
 * @param registry - 待发布的页面本地巡检注册表。
 */
export function provideClientCordisInspect(ctx: Context, registry: ClientCordisInspectRegistry): void {
  ctx.provide('cordisInspect', registry)
}
