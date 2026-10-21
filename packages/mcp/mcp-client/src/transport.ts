/**
 * 传输工厂：根据插件已解析的配置创建对应的 MCP 传输。stdio 会派生子进程
 * （并对凭据做清洗）；Streamable HTTP 则连接到 URL。
 *
 * @module
 */

import type { Transport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { Config } from './index.ts'

/**
 * 子进程接缝提供的、已清洗过的父进程环境（丢弃凭据形状的名称与过期的
 * `DSH_*` 名称），再叠加配置显式指定的 env。实际的派生由 MCP SDK 负责，
 * 因此本传输复用的是清洗定义，而不是派生路径。
 */
function buildChildEnv(extra: Record<string, string>): Record<string, string> {
  return { ...scrubbedParentEnv(), ...extra }
}

/**
 * 根据已解析的插件配置创建 MCP 传输。
 *
 * @param config - 以 `transport` 作为判别式的已解析插件配置。
 * @returns 已准备好连接的 MCP Transport（stdio 或 Streamable HTTP）。
 */
export function createTransport(config: Config): Transport {
  switch (config.transport) {
    case 'stdio':
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: buildChildEnv(config.env),
        cwd: config.cwd,
      })
    case 'streamable-http':
      return new StreamableHTTPClientTransport(
        new URL(config.url),
        { requestInit: { headers: config.headers } },
      )
  }
}
