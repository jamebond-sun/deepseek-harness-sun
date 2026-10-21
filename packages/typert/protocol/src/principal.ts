/**
 * 读取当前 Remote 调用的非所有者调用方。
 * @module @deepseek-ai/dsh-typert-protocol/principal
 */

import type { Principal, RemoteInvocation } from './types.ts'

/**
 * Remote 调用生产方在持久化输出上记录的身份。
 * @param invocation - `ctx.invocation`；Remote 调用之外为 `undefined`。
 * @returns 当调用方不是所有者时的主体；对于所有者以及 Remote 调用之外受信任的进程内代码返回 `undefined`。
 */
export function principalOf(invocation: RemoteInvocation | undefined): Principal | undefined {
  const principal = invocation?.peer.principal
  return principal?.kind === 'owner' ? undefined : principal
}
