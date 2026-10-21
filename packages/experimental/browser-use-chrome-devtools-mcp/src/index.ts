/** 通过被固定的 Chrome DevTools MCP 服务器进行 Chromium 检查与自动化。@module */

import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { BrowserMcpConfig, mountSessionMcp, validateBrowserMcpConfig } from '@deepseek-ai/dsh-experimental-browser-use-runtime/mcp'
import type {} from '@deepseek-ai/dsh-working-directory'

/** Chrome DevTools MCP 浏览器提供方的 Cordis 身份标识。 */
export const name = 'experimental-browser-use-chrome-devtools-mcp'

/** 为作用域化的 MCP 启动与提示就绪检查所需的服务。 */
export const inject = ['browserUse', 'agents', 'tools', 'systemPrompt', 'workingDirectory']

/** 固定的 Chromium 启动，或对既有浏览器的附加设置。 */
export type Config = BrowserMcpConfig

/** 在激活之前，校验启动或附加配置。 */
export const Config: typeof BrowserMcpConfig = BrowserMcpConfig

/**
 * 通过每个活动 Session 各一个 MCP 进程，暴露 Chrome DevTools 的上游目录。
 * 被附加的浏览器仍由外部拥有；该服务器会禁用使用情况统计。
 * @param ctx - 提供浏览器使用、Agents 与工具的提供方上下文。
 * @param config - 已校验的浏览器选择，以及可选的工具有超时。
 */
export function apply(ctx: Context, config: Config): void {
  validateBrowserMcpConfig(config)
  const cli = fileURLToPath(import.meta.resolve('chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js'))
  const args = [cli, '--no-usage-statistics']
  if (config.mode === 'attach') {
    args.push(/^wss?:/u.test(config.endpoint) ? '--ws-endpoint' : '--browser-url', config.endpoint)
  } else {
    args.push('--isolated', `--headless=${String(config.headless)}`)
    if (config.executablePath !== undefined) args.push('--executable-path', config.executablePath)
  }
  mountSessionMcp(ctx, {
    name: 'chrome-devtools-mcp',
    exclusive: config.mode === 'attach',
    command: process.execPath,
    args,
    ...config.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: config.toolCallTimeoutMs },
  })
}
