/**
 * 发布由连接持有的 MCP 资源以及逐字的服务端指令。
 *
 * @module @deepseek-ai/dsh-mcp-client
 */

import type { Context } from '@deepseek-ai/cordis'
import type { McpResourceProvider } from '@deepseek-ai/dsh-mcp-resources'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** 供资源与提示词消费者使用的、由连接持有的值。 */
export interface ServerContext {
  /** 经由当前连接世代进行的资源访问。 */
  resources: McpResourceProvider
  /**
   * 读取最近一次成功连接的服务端所归集的指令。
   * @returns 逐字的提示词文本；当没有生效的服务端指令时为空字符串。
   */
  instructions(): string
}

/**
 * 把服务端上下文贡献给当前组合所启用的服务。
 * @param ctx - 服务端插件的注册作用域与 effect 持有者。
 * @param server - 已配置的服务端标识。
 * @param connection - 在线的资源操作与成功后的指令快照。
 */
export function registerServerContext(ctx: Context, server: string, connection: ServerContext): void {
  ctx.inject(['mcpResources'], (inner) => {
    inner.mcpResources.register(server, connection.resources)
  })
  ctx.inject(['systemPrompt'], (inner) => {
    inner.systemPrompt.section({
      name: `mcp:${server}`,
      order: inner.systemPrompt.getSectionOrder('MCP_SERVERS'),
      interpolate: false,
      text: () => connection.instructions(),
    })
  })
}
