/**
 * Client 面：从 index 注入的访问快照开始，跟随
 * 调用方 Peer 的快照流，提供 `remoteAccess` Client
 * 服务——其 `source(kind, id, action)` 为任何已声明种类的
 * 资源作答——并在 global 资源上发布 `useRemoteAccess(action)`。
 * 领域 UI 适配器基于 `source()` 发布自己的资源 Hook。每个
 * 回答都是布尔值：owner 为 true，无快照或非 owner 流失败后为
 * false；无论回答如何，Host 都对每次调用强制执行。
 * @module @deepseek-ai/dsh-api-remote-access/client
 */

import type { Context } from '@deepseek-ai/cordis'
import remoteAccessRemote from '@deepseek-ai/dsh-api-remote-access/remote'
import { REMOTE_ACCESS_SNAPSHOT_KEY } from '../snapshot.ts'
import { mountAccess } from './mount.ts'
import { parseInjectedBaseline } from './state.ts'

export type {
  RemoteAccessAction, RemoteAccessEndpoint, RemoteAccessFrame, RemoteAccessGrant, RemoteAccessResource, TypertResourceKind,
} from '../types.ts'
export type { ClientRemoteAccess, RemoteEndpoint } from './mount.ts'

/** 必需的 Client 服务：Remote 挂载面与 Slot 注册表。 */
export const inject = ['remote', 'slots']

/**
 * 挂载生成的 `remoteAccess` 命名空间并发布访问 Hook。
 * @param ctx - Client 根上下文。
 * @returns 流停止后撤下该命名空间的释放器。
 */
export function apply(ctx: Context): Promise<() => Promise<void>> {
  return mountAccess(ctx, remoteAccessRemote, parseInjectedBaseline(Reflect.get(globalThis, REMOTE_ACCESS_SNAPSHOT_KEY)))
}
