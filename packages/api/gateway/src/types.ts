/**
 * 与载体无关的 Typert Gateway 请求、服务与错误契约。
 * @module @deepseek-ai/dsh-api-gateway/types
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PeerScope, RemoteUplinkWindow, TypertResourceReader } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteEventHostInfo } from './stream-protocol.ts'

/** 载体解码信封后的一条 Remote 方法请求。 */
export interface InvokeRemoteRequest {
  /** 生成的描述符所选定的 Remote 命名空间。 */
  readonly namespace: string
  /** 导出的 Service 方法名。 */
  readonly method: string
  /** 具名的 wire 值；字段必须与描述符完全匹配。 */
  readonly args: Readonly<Record<string, unknown>>
  /**
   * 此逻辑流的 Client 上行条目，通过 `invocation.uplink()` 交付给方法；
   * 缺省表示一个立即结束的可迭代对象。
   */
  readonly uplink?: AsyncIterable<unknown>
  /** 载体提供的帧容量；没有编码帧收件箱上限的载体则缺省。 */
  readonly uplinkWindow?: RemoteUplinkWindow | undefined
  /** 调用所代表的 Peer；每个载体与进程内调用方都显式指名。 */
  readonly peer: PeerScope
  /** 仅注入到支持取消的方法中的载体或直接调用方取消信号。 */
  readonly signal?: AbortSignal
}

/** 原样转发给 Client Remote 订阅者的一条 Host Cordis 通知。 */
export interface TypertRemoteEventFrame {
  /** 原始的 Host Cordis 事件名。 */
  readonly event: string
  /** 所有者为 JSON 传输校验后的事件原始参数列表。 */
  readonly args: readonly unknown[]
  /**
   * 参数所涉资源的读取器，按资源种类为键，
   * 并以参数作为位置参数调用。
   * 触及全局资源的通知则缺省或为空。
   */
  readonly resources?: Readonly<Record<string, TypertResourceReader>>
}

/** 用于投射一个作用域 Remote Event 的实时 Host 值。 */
export interface TypertRemoteEventContext {
  /** 拥有被转发瀑布的取消权的实时 Agent 上下文。 */
  readonly value: Context
  /** 瀑布请求直接携带的 Agent 对象。 */
  readonly subject: object
  /** 直接从作用域事件主体读取的 Agent 身份。 */
  readonly agentId: string
}

/** Client 瀑布返回的结果，或交还回 Host 链的委托。 */
export type TypertRemoteEventOutcome =
  | { readonly kind: 'result'; readonly value: unknown }
  | { readonly kind: 'next' }

/**
 * 应用事件源产出的一个作用域瀑布调用。
 * 仅由 Gateway 分配传输 id，
 * 并在 Client 给出结果或显式委托后解析后续动作。
 */
export interface TypertRemoteEventInvocation {
  /** 原始的 Host Cordis 事件名。 */
  readonly event: string
  /** 瀑布的 `next()` 回调之前唯一的请求参数。 */
  readonly request: object
  readonly context: TypertRemoteEventContext
  /** 以 Client 结果或 `next()` 恢复事件源的 Cordis 监听器。 */
  readonly resolve: (outcome: TypertRemoteEventOutcome) => void
  /** 在取消、传输失败或 Client 拒绝之后拒绝事件源的 Cordis 监听器。 */
  readonly reject: (reason: unknown) => void
}

/** 从唯一的 Remote Event 源接受的通知或作用域瀑布。 */
export type TypertRemoteEventDispatch = TypertRemoteEventFrame | TypertRemoteEventInvocation

/**
 * 为一个 Client 载体打开应用选定的事件流。
 * 工厂必须在返回前挂接所有增量的 Host 监听器；
 * Gateway 随后立即发布其就绪条目。
 * @param signal - 与 Client 流和注册共享的取消信号。
 * @returns 由通知与作用域瀑布调用组成的长生命周期流。
 */
export type TypertRemoteEventSource = (
  signal: AbortSignal,
) => AsyncIterable<TypertRemoteEventDispatch>

/** 面向载体的访问入口，用于打开已解码的 Remote 流及其稳定失败。 */
export interface TypertGatewayWireStream {
  /**
   * 从 wire 端点与载荷打开一个逻辑流。
   * @param endpoint - 规范的 Remote 端点或 Gateway 自有的流名称。
   * @param payload - 已解码的载体载荷。
   * @param uplink - 逻辑流中 Client 到 Host 的条目；Gateway 自有的端点在打开时即返回其迭代器，
   * 因此载体直接丢弃这些条目而不缓冲。
   * @param peer - 该流所代表的 Peer；必填，绝不默认。
   * @param signal - 逻辑流的取消信号。
   * @returns 校验后的流值。
   */
  readonly open: (
    endpoint: string,
    payload: unknown,
    uplink: AsyncIterable<unknown>,
    peer: PeerScope,
    signal: AbortSignal,
  ) => Promise<AsyncIterable<unknown>>

  /**
   * 将流失败转换为对载体安全的 Remote 失败字段。
   * @param error - 打开或消费流时抛出的失败。
   * @returns 供 Client 使用的稳定 code、message 与 details。
   */
  readonly failure: (error: unknown) => {
    readonly code: string
    readonly message: string
    readonly details: object
  }
}

/** 在业务执行之前或之后发出的稳定基础设施与边界失败。 */
export type TypertGatewayErrorCode =
  | 'gateway/ambiguous-endpoint'
  | 'gateway/arguments-invalid'
  | 'gateway/binding-invalid'
  | 'gateway/context-failed'
  | 'gateway/context-not-found'
  | 'gateway/context-unavailable'
  | 'gateway/definition-unavailable'
  | 'gateway/input-invalid'
  | 'gateway/interactions-forbidden'
  | 'gateway/invocation-unavailable'
  | 'gateway/lookup-failed'
  | 'gateway/lookup-not-found'
  | 'gateway/lookup-unavailable'
  | 'gateway/method-unavailable'
  | 'gateway/peer-disposed'
  | 'gateway/protocol'
  | 'gateway/provider-mismatch'
  | 'gateway/result-invalid'
  | 'gateway/service-unavailable'
  | 'gateway/signature-invalid'
  | 'gateway/uplink-overflow'

/** 供 Connection 适配器消费的 Host 分发器。 */
export interface TypertGateway {
  /** 由 WebSocket 与进程内传输共享的载体适配器。 */
  readonly wireStream: TypertGatewayWireStream

  /**
   * 检查是否存在活跃的 owner Client 事件流，它是唯一能应答被转发瀑布的一类。
   * @returns 是否有 owner 流处于打开且未被取消的状态。
   */
  hasLiveClient(): boolean

  /**
   * 注册应用选定的转发事件源。
   * @param source - 由 Remote 装配安装的流工厂。
   * @param host - 包含在每个 Client 代起始帧中的稳定 Host 事实。
   * @returns 释放器，移除该确切的源并取消其活跃流。
   */
  registerRemoteEvents(
    source: TypertRemoteEventSource,
    host: RemoteEventHostInfo,
  ): () => Promise<void>

  /**
   * 调用一个活跃的 Remote 方法，不假设载体或响应信封。
   * @param request - 已解码的端点与具名 wire 参数。
   * @returns 未做输出解码的业务结果。
   * @throws {@link TypertGatewayError} 表示分发、提供方或边界失败；查找策略与业务错误保留其自身身份。
   */
  invoke(request: InvokeRemoteRequest): Promise<unknown>

  /**
   * 打开一个活跃的流式 Remote 方法，不假设物理载体。
   * @param request - 已解码的端点、具名 wire 参数，以及载体存在时的 Client 上行。
   * @returns 一个支持取消的业务结果可迭代对象。
   */
  stream(request: InvokeRemoteRequest): Promise<AsyncIterable<unknown>>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 处理 Typert Remote 调用的 Host 分发器。 */
    typertGateway: TypertGateway
  }
}
