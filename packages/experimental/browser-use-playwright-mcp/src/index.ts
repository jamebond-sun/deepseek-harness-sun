/** 来自被固定的 Playwright MCP 服务器的 Chromium 浏览器工具。@module */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { BrowserMcpConfig, mountSessionMcp, validateBrowserMcpConfig } from '@deepseek-ai/dsh-experimental-browser-use-runtime/mcp'
import type {} from '@deepseek-ai/dsh-working-directory'

/** Playwright MCP 浏览器提供方的 Cordis 身份标识。 */
export const name = 'experimental-browser-use-playwright-mcp'

/** 为作用域化的 MCP 启动与提示就绪检查所需的服务。 */
export const inject = ['browserUse', 'agents', 'tools', 'systemPrompt', 'workingDirectory']

/** 固定的 Chromium 启动，或对既有浏览器的附加设置。 */
export type Config = BrowserMcpConfig

/** 在激活之前，校验启动或附加配置。 */
export const Config: typeof BrowserMcpConfig = BrowserMcpConfig

/**
 * 在每个活动 Session 的作用域中暴露 Playwright 的上游工具。
 * 被固定的 npm 服务器运行于当前 Node 可执行文件之下；浏览器状态不会由 DSH 持久化。
 * @param ctx - 提供浏览器使用、Agents 与工具的提供方上下文。
 * @param config - 已校验的浏览器选择，以及可选的工具有超时。
 */
export function apply(ctx: Context, config: Config): void {
  validateBrowserMcpConfig(config)
  const cli = join(dirname(fileURLToPath(import.meta.resolve('@playwright/mcp/package.json'))), 'cli.js')
  // 否则上游的环境选项可能会替换已配置的浏览器模式，或导入一个不相关的配置档。
  // 对于其解析器而言，空值等同于该选项不存在。
  const env = Object.fromEntries(Object.keys(process.env)
    .filter(key => key.toUpperCase().startsWith('PLAYWRIGHT_MCP_'))
    .map(key => [key, '']))
  const args = [cli, '--browser', 'chromium']
  if (config.mode === 'attach') {
    args.push('--cdp-endpoint', config.endpoint)
  } else {
    args.push('--isolated')
    if (config.headless) args.push('--headless')
    if (config.executablePath !== undefined) args.push('--executable-path', config.executablePath)
  }
  mountSessionMcp(ctx, {
    name: 'playwright-mcp',
    exclusive: config.mode === 'attach',
    command: process.execPath,
    args,
    env,
    ...config.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: config.toolCallTimeoutMs },
  })
}
