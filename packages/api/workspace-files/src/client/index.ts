/**
 * 浏览器侧：构建在 `remote.workspaceFiles` 之上的 `file` 资源提供方。
 *
 * `types.ts` 是 protocol 发布的内容，`change-feed.ts` 为每个 session 共享
 * 一个 Host `changes` 流，`provider.ts` 将它与 `stat` 转成值流，
 * 本模块只负责把它们装配进 `ctx.resources`。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import { ChangeFeed } from './change-feed.ts'
import { createFileResourceProvider } from './provider.ts'

export type { WorkspaceFileParams } from './types.ts'

/** 浏览器必需服务：资源模型、Remote 载体及其命名空间。 */
export const inject = ['resources', 'remote', 'remote.workspaceFiles']

/**
 * Client 插件体：为本插件生命周期注册 `file` 提供方。
 * @param ctx - 携带 `resources` 与 Remote 接口面的 client 根上下文。
 */
export function apply(ctx: ClientContext): void {
  const changes = new ChangeFeed(ctx.remote)
  const provider = createFileResourceProvider(ctx.remote, changes)
  ctx.effect(() => {
    const release = ctx.resources.register(provider)
    // 拆卸等待每个仍在关闭中的 session 流，使插件不留任何
    // Host 流在后台。
    return async () => {
      release()
      await changes.settle()
    }
  }, 'workspace-files: file resource provider')
}
