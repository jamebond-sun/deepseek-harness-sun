/**
 * `file` protocol 的资源元数据、导航参数、Client 错误，
 * 以及内部变更流通知。
 */
// 将基础的 `ResourceProtocolMap` 声明引入本程序，使下方的扩充
// 合并进它，而不是声明第二个同名接口。
import type {} from '@deepseek-ai/dsh-client-resources/client'
import type { WorkspaceFileStat } from '../types.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface ResourceProtocolMap {
    /**
     * 一个 workspace 文件的元数据，地址形如
     * `dsh-resource://file/session/<sessionId>/<path>`（绝对或 workspace 相对）。
     */
    file: WorkspaceFileStat
  }
}

/** 打开或导航 `file` 标签页时要求展示的内容；JSON 形状。 */
export interface WorkspaceFileParams {
  /** 要滚动到可视区的行号（从 1 开始）；缺省时不改变位置。 */
  readonly line?: number
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /**
     * 该地址不是提供方能识别的 scope 中的 `dsh-resource://file/` 地址：
     * `session/<sessionId>/<path>` 或 `absolute/<absolute path>`。
     * 由 Client 提供方抛出；Host 从不发出它。
     */
    'workspace-file/unsupported-address': { readonly address: string }
    /**
     * `absolute` 地址没有可用于授权 Host 调用的 Session。
     * 由 Client 提供方抛出；Host 从不发出它。Session 地址由 Host
     * 无需 Client Session 摘要即可解析。
     */
    'workspace-file/unknown-workspace': { readonly address: string }
  }
}

/** Host 报告的 Session 文件系统中的一次目标变更。 */
export type WorkspaceFileEdit =
  | { readonly kind: 'changed'; readonly version: string }
  | { readonly kind: 'absent' }

/** 一次目标变更，或重连后重新 stat 的请求。 */
export type WorkspaceFileNotice = WorkspaceFileEdit | { readonly kind: 'refresh' }
