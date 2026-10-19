/** Client scope 代际独立于 Host Agent 常驻地路由本地事件。 */
import { Context as CordisContext } from '@deepseek-ai/cordis'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TypertRemoteScopeApi } from '@deepseek-ai/dsh-typert-protocol'

/** 携带一个 Agent 身份及其作用域 Remote 命名空间的 Client Cordis Context。 */
export type AgentContext = Omit<Context, 'remote'> & {
  readonly remote: ClientRemote & TypertRemoteScopeApi<'agent'>
}

/** 由 {@link createScope} 写入的 context 标签。 */
const kScope = Symbol('dsh.client.scope')

interface ScopeIdentity {
  readonly sessionId: SessionId
}

/** 一个铸出的 Agent scope 及其释放分界。 */
export interface AgentScopeHandle {
  /**
   * 已打标签的 context：scope 持有的注册与作用域分发都经由它
   * （把它作为分发主体传入，会路由到本代际的已打标签监听器
   * 加上所有未打标签的监听器）。
   */
  ctx: AgentContext
  /** 支撑 fiber（dispose 会清理每个 scope 持有的注册）。 */
  fiber: Fiber
}

/** 支撑每个 Agent scope fiber 的共享 no-op 插件。 */
function agentScope(): void {}

/**
 * 在 `ctx` 下铸出一个 Agent scope：一个 no-op 插件 fiber，其 context
 * 携带 agent 标签与分发过滤器 —— 未打标签的监听器被全局接纳，
 * 已打标签的监听器仅对相同的 Client 代际生效。
 * 经由返回的 ctx 做出的注册随 fiber 释放。
 * @param ctx - scope fiber 挂载其下的 client 根 context。
 * @param key - 本代际携带的持久化 Session 身份。
 * @returns 已打标签的 context 及其支撑 fiber。
 */
export function createScope(ctx: Context, key: SessionId): AgentScopeHandle {
  const fiber = ctx.plugin(agentScope)
  const identity: ScopeIdentity = { sessionId: key }
  const scoped = fiber.ctx.extend({
    [kScope]: identity,
    [CordisContext.filter](listenerCtx: Context): boolean {
      const tag = scopeIdentityOf(listenerCtx)
      return tag === undefined || tag === identity
    },
  }) as AgentContext
  return {
    fiber,
    ctx: scoped,
  }
}

/**
 * 读取一个 context 继承的最近 agent 标签。
 * @param ctx - 任意 client context。
 * @returns 其 agent 身份（session id），或在根 context 上返回 undefined。
 */
export function scopeOf(ctx: Context): SessionId | undefined {
  return scopeIdentityOf(ctx)?.sessionId
}

/**
 * 读取一个 Client Context 继承的精确代际身份。
 * @param ctx - 作用域或根 Client Context。
 * @returns 代际身份，或在未打 scope 的 Context 上返回 undefined。
 */
export function scopeIdentityOf(ctx: Context): ScopeIdentity | undefined {
  return (ctx as Context & { [kScope]?: ScopeIdentity })[kScope]
}
