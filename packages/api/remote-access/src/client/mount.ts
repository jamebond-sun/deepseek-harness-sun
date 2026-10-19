/**
 * Client 访问挂载：跟随调用方 Peer 的访问快照，提供
 * `remoteAccess` Client 服务，并发布 global 资源的 `useRemoteAccess` Hook。
 * 入口模块提供生成的 `remoteAccess` 贡献，因此
 * spec 挂载一个假的。
 * @module @deepseek-ai/dsh-api-remote-access/src/client/mount
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import {
  RemoteSnapshotStream,
  RemoteStreamCarrierError,
  type ClientRemote,
} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-remote-access/remote'
import type { HostObservable, RootStandardSourceContribution } from '@deepseek-ai/dsh-client-ui-slots'
// 仅类型：SlotRegistry（`ctx.slots`）的合并。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { TypertRemoteContribution, TypertRemoteMap, TypertResourceKind } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteAccessFrame } from '../types.ts'
import { ClientAccessState, type Baseline } from './state.ts'

/** Client Remote 命名空间声明的每个端点。 */
export type RemoteEndpoint = Extract<keyof TypertRemoteMap, string>

/** 基于调用方 Peer 快照的 Client 访问回答；它从不发起请求。 */
export interface ClientRemoteAccess {
  /**
   * 当前 Peer 可否在一个资源上调用 `action`。
   * owner 为 true；无 baseline 以及非 owner 流失败后为
   * false；否则取决于该资源的授予是否列出该动作。
   * @param kind - `TypertResourceMap` 中声明的资源种类。
   * @param id - 资源身份。
   * @param action - 调用方将发起的端点动作。
   * @returns 此 `(kind, id, action)` 的身份稳定布尔源。
   */
  source(kind: TypertResourceKind, id: string, action: string): HostObservable<boolean>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 面向调用方 Peer 的 Client 访问回答。 */
    remoteAccess: ClientRemoteAccess
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface GlobalStandardProps {
    /** 当前 Peer 可否在 global 资源上调用 `action`。 */
    useRemoteAccess: (action: RemoteEndpoint) => boolean
  }
}

type IncrementFrame = Exclude<RemoteAccessFrame, { type: 'baseline' }>

/** 构建于一个快照持有者之上的 `remoteAccess` Client 服务。 */
class ClientRemoteAccessService extends Service implements ClientRemoteAccess {
  /**
   * @param ctx - 提供本服务的 Client 上下文。
   * @param state - 回答每个源的快照持有者。
   */
  constructor(ctx: Context, private readonly state: ClientAccessState) {
    super(ctx, 'remoteAccess')
  }

  source(kind: TypertResourceKind, id: string, action: string): HostObservable<boolean> {
    return this.state.resource(kind, id, action)
  }
}

/**
 * 挂载 `remoteAccess` 命名空间，跟随访问快照，提供
 * `remoteAccess` Client 服务，并发布 global 资源的 `useRemoteAccess` Hook。
 * 回答从页面注入的 baseline 开始，没有则为 false，
 * 此后跟随流的帧。
 * @param ctx - 注入 `remote` 与 `slots` 的 Client 根上下文。
 * @param contribution - 生成的 `remoteAccess` Remote 贡献。
 * @param initial - 页面注入的开场 baseline，在流连接之前读取。
 * @returns 流停止后撤下该命名空间的释放器。
 */
export async function mountAccess(
  ctx: Context,
  contribution: TypertRemoteContribution,
  initial?: Baseline,
): Promise<() => Promise<void>> {
  const state = new ClientAccessState(initial)
  new ClientRemoteAccessService(ctx, state)
  ctx.slots.provideRoot({
    keyedHooks: { remoteAccess: action => state.global(action) },
  } satisfies RootStandardSourceContribution)
  const unmount = await ctx.remote.$mount(contribution)
  const follow = ctx.inject(['remote.remoteAccess'], (remoteCtx) => {
    const control = createAccessStream(remoteCtx.remote, state, remoteCtx.logger)
    control.start()
    remoteCtx.effect(() => async () => { await control.dispose() }, 'remote-access.client.follow')
  })
  return async () => {
    await follow.dispose()
    await unmount()
  }
}

/**
 * 创建可重连的访问快照流。carrier 丢失时流重连期间保留
 * 最后一个快照；终态失败时保留 owner 的回答，
 * 并把非 owner 的回答变为 false。
 */
function createAccessStream(
  remote: ClientRemote,
  state: ClientAccessState,
  logger: Context['logger'],
): RemoteSnapshotStream<Baseline, IncrementFrame> {
  const stream = remote.$stream<RemoteAccessFrame>({
    name: 'Remote access stream',
    open: signal => remote.remoteAccess.follow(signal),
    ended: accepted => accepted
      ? new RemoteStreamCarrierError('Remote access stream ended without a terminal result')
      : new Error('Remote access stream ended before its opening snapshot'),
  })
  return new RemoteSnapshotStream<Baseline, IncrementFrame>(stream, {
    name: 'Remote access stream',
    isSnapshot: (frame): frame is Baseline => frame.type === 'baseline',
    replace: (frame) => { state.replace(frame) },
    update: (frame) => { state.update(frame) },
    failed: (error) => {
      // 终态失败后只有非 owner 的回答变为 false，因此只有其报告指名恢复方式。
      if (state.owner) logger.error('access snapshot stream failed; owner access answers are unaffected', error)
      else logger.error('access snapshot stream failed; reload the page to reconnect', error)
      state.unavailable()
    },
  })
}
