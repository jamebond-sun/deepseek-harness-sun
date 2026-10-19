/** 将标准 ACP MCP 服务器声明转换为 Agent 作用域的 DSH MCP 客户端。 */

import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { validateHeaderName, validateHeaderValue } from 'node:http'
import { isAbsolute } from 'node:path'
import type { McpServer } from '@agentclientprotocol/sdk'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'

const VALID_SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/

/** 可由调用方纠正的 MCP 声明失败。 */
export class AcpMcpConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AcpMcpConfigError'
  }
}

/**
 * 在 Agent 发布之前，校验并挂载单个会话的完整标准 MCP 服务器列表。
 * @param agentCtx - 拥有 MCP 客户端与工具的未发布 Agent 作用域。
 * @param servers - 稳定的 ACP stdio 或 HTTP 服务器声明。
 * @param sessionCwd - stdio 服务器使用的规范主工作区。
 */
export async function mountAcpMcpServers(
  agentCtx: Context,
  servers: readonly McpServer[],
  sessionCwd: string,
): Promise<void> {
  const configs = resolveMcpConfigs(servers, sessionCwd)
  for (const config of configs) await agentCtx.plugin(McpClient, config)
}

/** 转换稳定的 stdio/HTTP ACP 传输，并拒绝其他所有传输。 */
function resolveMcpConfigs(servers: readonly McpServer[], sessionCwd: string): McpClient.Config[] {
  const names = new Set<string>()
  return servers.map((server, index) => {
    const serverName = normalizeServerName(server.name)
    if (names.has(serverName)) {
      throw new AcpMcpConfigError(`mcpServers contains duplicate normalized name: ${serverName}`)
    }
    names.add(serverName)
    if (!('type' in server)) {
      if (!isAbsolute(server.command)) {
        throw new AcpMcpConfigError(`mcpServers[${index}].command must be an absolute path`)
      }
      const env = entriesToRecord(server.env, `mcpServers[${index}].env`, 'environment')
      const config = validateClientConfig(index, () => McpClient.Config({
        transport: 'stdio',
        serverName,
        command: server.command,
        args: server.args,
        env,
        cwd: sessionCwd,
        failOnStartupError: true,
      }))
      return { ...config, env }
    }
    if (server.type === 'http') {
      assertHttpUrl(server.url, `mcpServers[${index}].url`)
      const headers = entriesToRecord(server.headers, `mcpServers[${index}].headers`, 'header')
      const config = validateClientConfig(index, () => McpClient.Config({
        transport: 'streamable-http',
        serverName,
        url: server.url,
        headers,
        failOnStartupError: true,
      }))
      return { ...config, headers }
    }
    throw new AcpMcpConfigError(`mcpServers[${index}] transport ${server.type} is not supported`)
  })
}

/** 转换有序的 ACP 名称/值条目，不静默接受重复键。 */
function entriesToRecord(
  entries: readonly { name: string; value: string }[],
  field: string,
  kind: 'environment' | 'header',
): Record<string, string> {
  // 合法的环境变量名与 header 名可以包含 "__proto__"；使用 null 原型
  // 可让该条目保持为数据，而不会触发 Object.prototype 的 setter。
  const result = Object.create(null) as Record<string, string>
  const names = new Set<string>()
  for (const entry of entries) {
    if (kind === 'header') {
      try {
        validateHeaderName(entry.name)
        validateHeaderValue(entry.name, entry.value)
      } catch (_invalidHeader) {
        throw new AcpMcpConfigError(`${field} contains an invalid header entry`)
      }
    } else if (
      entry.name.length === 0
      || entry.name.includes('=')
      || entry.name.includes('\0')
      || entry.value.includes('\0')
    ) {
      throw new AcpMcpConfigError(`${field} contains an invalid environment entry`)
    }
    const identity = kind === 'header' ? entry.name.toLowerCase() : entry.name
    if (names.has(identity)) throw new AcpMcpConfigError(`${field} contains duplicate name: ${entry.name}`)
    names.add(identity)
    result[entry.name] = entry.value
  }
  return result
}

/** 根据 ACP 中人类可读的服务器名生成稳定的 DSH 工具命名空间。 */
function normalizeServerName(name: string): string {
  if (name.trim().length === 0 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new AcpMcpConfigError('mcpServers contains an invalid server name')
  }
  if (VALID_SERVER_NAME.test(name)) return name
  const slug = name.normalize('NFKD')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 20) || 'server'
  const digest = createHash('sha256').update(name).digest('hex').slice(0, 8)
  return `${slug}_${digest}`.slice(0, 32)
}

/** 要求使用稳定的 Streamable HTTP 传输 URL scheme。 */
function assertHttpUrl(value: string, field: string): void {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol')
  } catch (_invalidUrl) {
    throw new AcpMcpConfigError(`${field} must be an absolute HTTP(S) URL`)
  }
}

/** 将现有 MCP 提供方的 schema 错误映射为 ACP 无效参数错误。 */
function validateClientConfig(index: number, parse: () => McpClient.Config): McpClient.Config {
  try {
    return parse()
  } catch (error: unknown) {
    /* v8 ignore next -- Schemastery 校验以 Error 实例拒绝。 */
    const detail = error instanceof Error ? error.message : String(error)
    throw new AcpMcpConfigError(`mcpServers[${index}] is invalid: ${detail}`)
  }
}
