/** 面向 Workspace 的适配器，服务于 Gateway 持有的快照流生命周期。 */

import type { Context } from '@deepseek-ai/cordis'
import {
  RemoteSnapshotStream,
  RemoteStreamCarrierError,
  type ClientRemote,
} from '@deepseek-ai/dsh-api-gateway/client'
import type { WorkspaceFollowFrame, WorkspaceFollowIncrement } from '../types.ts'
import type { WorkspaceFollowSink } from './model.ts'
import { ClientWorkspaceModel } from './model.ts'
import { WorkspaceController } from './service.ts'

export { ClientWorkspaceModel } from './model.ts'
export type {
  WorkspaceFollowSink, WorkspaceListPhase, WorkspaceRemote, WorkspaceSnapshot,
} from './model.ts'
export { WorkspaceArchiveError, WorkspaceController, WorkspaceCreateError } from './service.ts'
export type { IWorkspaces, WorkspaceSource } from './service.ts'
export type {
  SessionActivity, SessionActivityItem, SessionActivityKind, SessionActivityKindMap, WorkspaceId,
  WorkspaceView,
} from '../types.ts'

type WorkspaceBaselineFrame = Extract<WorkspaceFollowFrame, { type: 'baseline' }>

/** 为 Workspace 状态配置的 Gateway 持有快照流。 */
export type WorkspaceStateStream = RemoteSnapshotStream<
  WorkspaceBaselineFrame,
  WorkspaceFollowIncrement
>

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 不依赖 React 的 Client Workspace 状态与命令。 */
    workspaces: import('./service.ts').IWorkspaces
  }
}

/** 必需的 Client Remote 服务。 */
export const inject = ['remote', 'remote.workspace']

/**
 * 安装 Client Workspace 状态、命令与可重连的 follow 控制。
 * @param ctx - Client 根上下文。
 */
export function apply(ctx: Context): void {
  const model = new ClientWorkspaceModel(ctx.remote.workspace)
  new WorkspaceController(ctx, model)
  const control = createWorkspaceStateStream(ctx.remote, {
    accept: model,
    carrierFailed: () => { model.handleCarrierFailure() },
    failed: (error) => { model.handleStreamFailure(error) },
  })
  control.start()
  ctx.effect(
    () => async () => { await control.dispose() },
    'workspace-controller.client.control',
  )
}

/** Workspace 状态流使用的领域接收端。 */
export interface WorkspaceStateStreamOptions {
  /** 解码后的 Workspace 状态操作的去向。 */
  readonly accept: WorkspaceFollowSink
  /** 在重连前观察一次可重试的 carrier 丢失。 */
  readonly carrierFailed?: (error: RemoteStreamCarrierError) => void
  /** 发布终态业务或协议失败。 */
  readonly failed: (error: unknown) => void
}

/**
 * 创建可重连的 Workspace 状态流。
 * @param remote - 携带 Workspace 命名空间与流工厂的 Client Remote 接口面。
 * @param options - Workspace 状态去向。
 * @returns 未启动的流，由 Client Workspace 运行时持有。
 */
export function createWorkspaceStateStream(
  remote: ClientRemote,
  options: WorkspaceStateStreamOptions,
): WorkspaceStateStream {
  const stream = remote.$stream<WorkspaceFollowFrame>({
    name: 'Workspace state stream',
    open: signal => remote.workspace.follow(signal),
    ended: accepted => accepted
      ? new RemoteStreamCarrierError('Workspace state stream ended without a terminal result')
      : new Error('Workspace state stream ended before its opening snapshot'),
    ...(options.carrierFailed === undefined ? {} : { carrierFailed: options.carrierFailed }),
  })
  return new RemoteSnapshotStream<WorkspaceBaselineFrame, WorkspaceFollowIncrement>(stream, {
    name: 'Workspace state stream',
    isSnapshot: (frame): frame is WorkspaceBaselineFrame => frame.type === 'baseline',
    replace: (frame) => { options.accept.replaceBaseline(frame.value) },
    update: (frame) => { acceptIncrement(options.accept, frame) },
    failed: options.failed,
  })
}

function acceptIncrement(accept: WorkspaceFollowSink, frame: WorkspaceFollowIncrement): void {
  switch (frame.type) {
    case 'replace':
      accept.replaceBaseline(frame.value)
      return
    case 'upsert':
      accept.upsertView(frame.workspace)
      return
    case 'remove':
      accept.removeView(frame.workspaceId)
      return
    case 'order':
      accept.replaceOrder(frame.workspaceIds)
      return
    case 'archived':
      accept.replaceArchived(frame.archivedSessionIds)
      return
    case 'pinned':
      accept.replacePinned(frame.pinnedSessionIds)
      return
    /* v8 ignore next -- 生成的 Remote 编解码器已校验该封闭联合 */
    default:
      return assertNever(frame)
  }
}

/* v8 ignore next 3 -- 生成的 Remote 校验之后的封闭联合兜底 */
function assertNever(value: never): never {
  throw new Error(`unreachable Workspace increment: ${JSON.stringify(value)}`)
}
