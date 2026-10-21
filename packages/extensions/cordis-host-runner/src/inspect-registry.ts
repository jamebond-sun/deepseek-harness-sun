/** 面向模型可见、只读的 Cordis 能力查询的 Host 注册表。 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-gateway'
import { snapshotJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import type {
  CordisInspectMethodManifest, CordisInspectPlatform, CordisInspectProviderManifest,
  CordisInspectProviderView, CordisInspectQueryRequest, CordisInspectQueryResolution,
  CordisInspectRequestId, CordisInspectResolveAck,
} from './types.ts'

/** 提供给一次 Host inspect 查询的上下文。 */
export interface HostCordisInspectQueryContext {
  /** 工具调用取消。 */
  signal: AbortSignal
  /** 其作用域化运行时正被检视的 Agent。 */
  agent: Agent
}

/** 与自身可序列化清单配对的一份本地注册。 */
export interface HostCordisInspectProviderRegistration {
  /** 提供方与显式的方法目录。 */
  manifest: CordisInspectProviderManifest
  /** 执行一个已声明的方法。 */
  query(method: string, input: JsonValue | undefined, context: HostCordisInspectQueryContext): Promise<JsonValue>
}

interface PendingClientQuery {
  request: CordisInspectQueryRequest
  method: CordisInspectMethodManifest
  failure?: string
  settle(resolution: CordisInspectQueryResolution): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 用于 Cordis inspect 提供方与 Client 清单/查询路由的 Host 注册表。 */
    cordisInspect: CordisInspectRegistryService
  }
}

/** 两个面向模型的 inspect 工具背后的注册表与跨页面路由器。 */
export class CordisInspectRegistryService extends Service {
  private readonly providers = new Map<string, HostCordisInspectProviderRegistration>()
  private readonly pending = new Map<CordisInspectRequestId, PendingClientQuery>()
  private clientManifest: readonly CordisInspectProviderManifest[] | undefined
  private nextRequest = 1

  /**
   * 注册进程全局的 Host 注册表。
   * @param ctx - 拥有的 Host 上下文。
   * @param clientQueryTimeoutMs - 等待一次有效 Client 响应的最长时间，以毫秒计。
   */
  constructor(ctx: Context, private readonly clientQueryTimeoutMs: number) {
    super(ctx, 'cordisInspect')
    ctx.effect(() => () => {
      for (const pending of this.pending.values()) {
        pending.settle({ ok: false, reason: 'cancelled', message: 'Client inspect registry was disposed' })
      }
    }, 'cordis-inspect: pending queries')
  }

  /**
   * 注册一个 Host 提供方。
   * @param registration - 清单与本地查询处理器。
   * @returns 幂等的释放器。
   */
  register(registration: HostCordisInspectProviderRegistration): () => void {
    const manifest = validateManifest(registration.manifest)
    if (this.providers.has(manifest.id)) throw new Error(`Host Cordis inspect provider "${manifest.id}" is already registered`)
    const stored = { ...registration, manifest }
    this.providers.set(manifest.id, stored)
    return () => {
      if (this.providers.get(manifest.id) === stored) this.providers.delete(manifest.id)
    }
  }

  /**
   * 替换被镜像的 Client 提供方目录。
   * @param providers - 完整的 Client 清单快照。
   */
  syncClientManifest(providers: readonly CordisInspectProviderManifest[]): void {
    const ids = new Set<string>()
    const validated = providers.map((provider) => {
      const manifest = validateManifest(provider)
      if (ids.has(manifest.id)) throw new Error(`Client Cordis inspect manifest repeats provider "${manifest.id}"`)
      ids.add(manifest.id)
      return manifest
    })
    this.clientManifest = Object.freeze(validated)
  }

  /**
   * 返回已知的、完整的 Host 与 Client 提供方目录。
   * @returns Host 提供方在前，Client 提供方在后。
   */
  list(): CordisInspectProviderView[] {
    return [
      ...[...this.providers.values()].map(provider => view('host', provider.manifest)),
      ...(this.clientManifest ?? []).map(provider => view('client', provider)),
    ]
  }

  /**
   * 在其所属平台上执行一次提供方查询。
   * @param platform - Host 或 Client 运行时。
   * @param providerId - 从 {@link list} 中选出的提供方。
   * @param methodName - 已声明的方法名。
   * @param input - 可选的、无损的 JSON 输入。
   * @param agent - 发起请求的 Agent 与作用域。
   * @param signal - 工具调用取消。
   * @returns 提供方 JSON 数据；当 Gateway 没有活跃 Client 时 Client 查询会快速失败，
   * 且只为超时报告保留观察到的第一个失败诊断。
   */
  async query(
    platform: CordisInspectPlatform,
    providerId: string,
    methodName: string,
    input: JsonValue | undefined,
    agent: Agent,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    if (platform === 'host') {
      const registration = this.providers.get(providerId)
      if (registration === undefined) throw new Error(`Host Cordis inspect provider "${providerId}" is not registered`)
      const method = findMethod(registration.manifest, methodName)
      validateInput('Host', providerId, method, input)
      signal.throwIfAborted()
      const data = await registration.query(methodName, input, { agent, signal })
      signal.throwIfAborted()
      return validateOutput('Host', providerId, method, data)
    }
    return await this.queryClient(providerId, methodName, input, agent, signal)
  }

  /**
   * 为一个待定查询接受第一个有效的 Client 响应。
   * @param agent - 其 Session 拥有该查询的 Agent。
   * @param requestId - 待定 Client 查询标识。
   * @param resolution - Client 提供方的结果或失败。
   * @returns 确认；仅对一次能了结查询的成功，`accepted` 为真；只保留第一个失败诊断。
   */
  resolveClientQuery(
    agent: Agent,
    requestId: CordisInspectRequestId,
    resolution: CordisInspectQueryResolution,
  ): CordisInspectResolveAck {
    const pending = this.pending.get(requestId)
    if (pending === undefined || pending.request.agentId !== agent.id) return { accepted: false }
    // 一个失败的页面不得阻止另一个页面提供一个有效结果。
    if (!resolution.ok) {
      pending.failure ??= `${resolution.reason}: ${resolution.message}`
      return { accepted: false }
    }
    try {
      resolution = {
        ok: true,
        data: validateOutput('Client', pending.request.provider, pending.method, resolution.data),
      }
    } catch (error) {
      pending.failure ??= error instanceof Error ? error.message : String(error)
      return { accepted: false }
    }
    pending.settle(resolution)
    return { accepted: true }
  }

  private async queryClient(
    providerId: string,
    methodName: string,
    input: JsonValue | undefined,
    agent: Agent,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    const provider = this.clientManifest?.find(candidate => candidate.id === providerId)
    if (provider === undefined) throw new Error(`Client Cordis inspect provider "${providerId}" is not registered`)
    const method = findMethod(provider, methodName)
    validateInput('Client', providerId, method, input)
    signal.throwIfAborted()
    const gateway = this.ctx.get('typertGateway')
    if (gateway !== undefined && !gateway.hasLiveClient()) {
      throw new Error(`Client inspect query ${providerId}.${methodName} has no connected Harness page. Open or reconnect the Harness page, then retry.`)
    }
    const requestId = `inspect-${this.nextRequest++}` as CordisInspectRequestId
    const request: CordisInspectQueryRequest = {
      requestId,
      agentId: agent.id,
      provider: providerId,
      method: methodName,
      ...input === undefined ? {} : { input },
    }
    const result = new Promise<CordisInspectQueryResolution>((resolve) => {
      this.pending.set(requestId, {
        request,
        method,
        settle: (resolution) => {
          this.pending.delete(requestId)
          resolve(resolution)
          try {
            this.ctx.emit('cordis/inspect-query-resolved', { requestId })
          } catch (error) {
            console.error('[cordis-host-runner] notifying Client inspect completion failed:', error)
          }
        },
      })
    })
    const onAbort = (): void => {
      this.pending.get(requestId)?.settle({
        ok: false,
        reason: 'cancelled',
        message: `Client inspect query ${providerId}.${methodName} was cancelled`,
      })
    }
    const timer = setTimeout(() => {
      const pending = this.pending.get(requestId)
      if (pending === undefined) return
      const detail = pending.failure === undefined
        ? 'Open or reconnect the Harness page, then retry.'
        : `Client failure: ${pending.failure}`
      pending.settle({
        ok: false,
        reason: 'provider-error',
        message: `Client inspect query ${providerId}.${methodName} timed out after ${this.clientQueryTimeoutMs}ms. ${detail}`,
      })
    }, this.clientQueryTimeoutMs)
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      if (signal.aborted) onAbort()
      else this.ctx.emit('cordis/inspect-query', request)
      const resolution = await result
      if (!resolution.ok) throw new Error(`${providerId}.${methodName}: ${resolution.message}`)
      return resolution.data
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      this.pending.delete(requestId)
    }
  }
}

function view(platform: CordisInspectPlatform, manifest: CordisInspectProviderManifest): CordisInspectProviderView {
  return { platform, ...manifest, methods: [...manifest.methods] }
}

function validateManifest(manifest: CordisInspectProviderManifest): CordisInspectProviderManifest {
  if (manifest.id.trim() === '') throw new Error('Cordis inspect provider id must not be empty')
  if (manifest.description.trim() === '') throw new Error(`Cordis inspect provider "${manifest.id}" needs a description`)
  const names = new Set<string>()
  const methods = manifest.methods.map((method) => {
    if (method.name.trim() === '') throw new Error(`Cordis inspect provider "${manifest.id}" has an empty method name`)
    if (names.has(method.name)) throw new Error(`Cordis inspect provider "${manifest.id}" repeats method "${method.name}"`)
    if (method.description.trim() === '') throw new Error(`Cordis inspect method ${manifest.id}.${method.name} needs a description`)
    assertSupportedJsonSchema(method.inputSchema)
    assertSupportedJsonSchema(method.outputSchema)
    names.add(method.name)
    return Object.freeze({ ...method })
  })
  return Object.freeze({ ...manifest, methods: Object.freeze(methods) })
}

function findMethod(manifest: CordisInspectProviderManifest, name: string): CordisInspectMethodManifest {
  const method = manifest.methods.find(candidate => candidate.name === name)
  if (method === undefined) throw new Error(`Cordis inspect provider "${manifest.id}" has no method "${name}"`)
  return method
}

function validateInput(
  platform: 'Host' | 'Client',
  provider: string,
  method: CordisInspectMethodManifest,
  input: JsonValue | undefined,
): void {
  const violations = validateJsonSchemaValue(method.inputSchema as JsonSchemaNode, input ?? {}, 'input')
  if (violations.length > 0) throw new Error(`${platform} Cordis inspect ${provider}.${method.name} rejected input: ${violations.join('; ')}`)
}

function validateOutput(
  platform: 'Host' | 'Client',
  provider: string,
  method: CordisInspectMethodManifest,
  data: JsonValue,
): JsonValue {
  const snapshot = snapshotJsonValue(data)
  if (snapshot === undefined) throw new Error(`${platform} Cordis inspect ${provider}.${method.name} returned a non-JSON value`)
  const violations = validateJsonSchemaValue(method.outputSchema as JsonSchemaNode, snapshot, 'output')
  if (violations.length > 0) throw new Error(`${platform} Cordis inspect ${provider}.${method.name} returned invalid output: ${violations.join('; ')}`)
  return snapshot
}
