/** 在 CDP 或 Stagehand 初始化能够等待或失败之前，先拥有 Chromium。 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Browser, ChromeReleaseChannel, CDP_WEBSOCKET_ENDPOINT_REGEX, computeSystemExecutablePath, launch } from '@puppeteer/browsers'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { NativeBrowserConfig } from './native.ts'

/** 独立于 Stagehand Worker、由其自身拥有的 Chromium 进程与配置档。 */
export interface OwnedChromium {
  /** 由这一确切进程报告的 CDP 端点。 */
  endpoint: string
  /** 杀死所拥有的进程树，等待子进程关闭，并移除其配置档。 */
  close(): Promise<void>
}

/**
 * 以经过清理的环境与操作系统分配的调试端口启动 Chromium。
 * @param config - 可执行文件、窗口可见性与启动截止时限。
 * @param signal - 在调用方取得浏览器所有权之前的取消信号。
 * @returns 其调试端点就绪之后的、被拥有的浏览器。
 */
export async function launchChromium(config: NativeBrowserConfig, signal: AbortSignal): Promise<OwnedChromium> {
  signal.throwIfAborted()
  const executablePath = config.executablePath
    ?? computeSystemExecutablePath({ browser: Browser.CHROME, channel: ChromeReleaseChannel.STABLE })
  const profile = await mkdtemp(join(tmpdir(), 'dsh-stagehand-chrome-'))
  let browser: ReturnType<typeof launch> | undefined
  let closed: Promise<void> | undefined
  let closing: Promise<void> | undefined
  const close = () => closing ??= (async () => {
    browser?.kill()
    await closed
    await rm(profile, { recursive: true, force: true })
  })()
  const abort = () => { void close().catch(() => {}) }
  try {
    signal.throwIfAborted()
    browser = launch({
      executablePath,
      args: [
        '--remote-debugging-port=0', '--enable-unsafe-extension-debugging', '--remote-allow-origins=*',
        '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`,
        ...config.headless ? ['--headless=new'] : [],
        'about:blank',
      ],
      env: scrubbedParentEnv(), handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
    })
    // 失败的派生会先发射 error 再 close，而不会先 exit；Process.hasClosed 只等待 exit。
    const child = browser.nodeProcess
    closed = new Promise<void>((resolve) => { child.once('close', () => { resolve() }) })
    signal.addEventListener('abort', abort, { once: true })
    const endpoint = await browser.waitForLineOutput(CDP_WEBSOCKET_ENDPOINT_REGEX, config.operationTimeoutMs)
    signal.throwIfAborted()
    return { endpoint, close }
  } catch (error) {
    await close()
    signal.throwIfAborted()
    throw error
  } finally {
    signal.removeEventListener('abort', abort)
  }
}
