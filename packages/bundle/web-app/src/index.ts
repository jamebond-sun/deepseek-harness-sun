/**
 * @deepseek-ai/dsh-web-app —— 浏览器界面 bundle 的运行时粘合插件，连同 bundle 补丁
 * （`cordis.patch.yml`，由 `dsh.bundle.patch` 清单字段声明）。该插件负责浏览器界面的
 * 粘合工作：它解析已构建的前端 dist（这是本 bundle 对 workspace 的了解，绝不由用户
 * 配置），在其上挂载 `frontend-static` 兜底所有者，注册 bash 可见的 web 运行时变量、
 * 进程 token URL 行与默认浏览器交接，并提供 `webApp` 服务。宣告的 `publicUrl` 会
 * 取代所发布的绑定地址 URL。非回环地址的 HTTP 绑定会触发暴露告警。应用的命令行值
 * 通过 bundle 补丁中的 `webStartup` 服务表达式送达。
 * @module @deepseek-ai/dsh-web-app
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { auditStartupEntries } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-client-connection'
import * as FrontendStatic from '@deepseek-ai/dsh-host-frontend-static'
import { bindUrlHost, isLoopbackHost } from '@deepseek-ai/dsh-host-webserver'
import { launchedThroughSsh, launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-shell-env'
import { parsePublicUrl } from './public-url.ts'

/** 本进程所服务的 Web GUI，由 `web-runtime` 行提供。 */
export interface WebApp {
  /**
   * 本 GUI 所宣告的 URL，同时用于 `DSH_WEB_URL` 与启动时的 URL 行。
   * @returns 已配置的 `publicUrl`，否则是监听器的 origin。
   */
  getAdvertisedUrl(): string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 本进程所服务的 Web GUI；未挂载 Web runtime 时缺省。 */
    webApp: WebApp
  }
}

/** 稳定的 Cordis 插件名。 */
export const name = 'web-app'

const ANNOUNCED_ROOTS = new WeakSet<Context>()

/** Web runtime 挂载之前所需的服务。 */
export const inject = ['webServer']

/** 插件配置：编排好的部署设置，加上每次调用时的命令行值。 */
export interface Config {
  /** 在 Loader 树装配完成之后允许默认浏览器交接；通过 SSH 启动会抑制它。 */
  openBrowser: boolean
  /** 激活时打印 URL 行；非交互式层可以关掉它。 */
  printUrl: boolean
  /**
   * 注册指名本 GUI 的 `DSH_WEB_URL` bash 变量。一次性非交互层在其用户不在 GUI 中时
   * 可以关掉它。
   */
  surfaceContext: boolean
  /**
   * 在打印、打开的 URL、`DSH_WEB_URL` 与 `webApp.getAdvertisedUrl()` 中宣告的规范
   * HTTP(S) 根路径，后者提供 agent 运行时上下文中的 Web GUI URL，例如
   * `https://app.example/ui/`，并规范化为以 `/` 结尾。它不配置路由或鉴权，
   * 参见[公开部署](../README.md#public-deployments)。
   * 缺省或 YAML `null` 表示宣告绑定地址的 URL。
   */
  publicUrl?: string
}

export const Config: z<Config> = z.object({
  openBrowser: z.boolean().default(true),
  printUrl: z.boolean().default(true),
  surfaceContext: z.boolean().default(true),
  publicUrl: z.transform(z.string(), value => parsePublicUrl(value).href),
})

/** 指名本 Web GUI 所宣告 URL 的环境变量。 */
const DSH_WEB_URL = 'DSH_WEB_URL' as const

const BROWSER_OPENER_MODULE = import.meta.resolve('open')

const BROWSER_OPENER_PROGRAM = `
try {
  const { default: open } = await import(${JSON.stringify(BROWSER_OPENER_MODULE)})
  const launcher = await open(process.argv[1])
  if (process.platform === 'win32') {
    // open 在 PowerShell 生成进程时才完成解析；在该启动器把 URL 交给 Windows 之前，
    // 保持对它的引用。
    const code = launcher.exitCode ?? await new Promise((resolve, reject) => {
      function onError(error) {
        launcher.off('close', onClose)
        reject(error)
      }
      function onClose(code) {
        launcher.off('error', onError)
        resolve(code)
      }
      launcher.ref()
      launcher.once('error', onError)
      launcher.once('close', onClose)
    })
    if (code !== 0) throw new Error('browser operating-system launcher exited with code ' + String(code))
  }
  process.exitCode = 0
} catch (error) {
  // 父进程会把这次退出转换为“手动打开 URL”的告警。
  console.error(error)
  process.exitCode = 1
}
`

/**
 * dist 位置属于本 bundle 对 workspace 的了解：锚定在前端包的清单上，而非可配置项。
 * 它是否存在要等到请求时才成为问题——兜底所有者按请求读取文件，因此某个页面从未走到
 * 兜底座位的组成（静态 worker 预览自带页面且不带 dist）在没有 dist 时也能启动。
 */
function resolveDistIndex(): string {
  const require = createRequire(import.meta.url)
  try {
    return join(dirname(require.resolve('@deepseek-ai/dsh-web-frontend/package.json')), 'dist', 'index.html')
  } catch {
    /* v8 ignore next 2 -- 仅当检出中缺少前端包时才可达 */
    throw new Error('web-app: @deepseek-ai/dsh-web-frontend is not resolvable from this composition')
  }
}

/** 启动受维护的平台打开器，且不转发 Harness 凭据。 */
function spawnBrowserLauncher(url: string): ChildProcess {
  return spawn(process.execPath, [
    '--input-type=module',
    '--eval', BROWSER_OPENER_PROGRAM,
    '--', url,
  ], {
    env: scrubbedParentEnv(),
    stdio: ['ignore', 'inherit', 'pipe'],
  })
}

/** 把一个 URL 交给操作系统的默认浏览器。 */
async function openBrowser(url: string): Promise<void> {
  const launcher = spawnBrowserLauncher(url)
  let launcherStderr = ''
  launcher.stderr?.setEncoding('utf8')
  launcher.stderr?.on('data', (chunk: string) => { launcherStderr += chunk })
  await new Promise<void>((resolve, reject) => {
    function onError(error: Error): void {
      launcher.off('close', onClose)
      reject(error)
    }
    function onClose(code: number | null): void {
      launcher.off('error', onError)
      if (code !== 0) {
        const firstLine = launcherStderr.trim().split(/\r?\n/u)[0]
        const reason = firstLine === undefined || firstLine === ''
          ? `browser launcher exited with code ${String(code)}`
          : firstLine.replace(/^(?:[A-Za-z]*Error):\s*/u, '')
        reject(new Error(reason))
        return
      }
      if (launcherStderr !== '') process.stderr.write(launcherStderr)
      resolve()
    }
    launcher.once('error', onError)
    launcher.once('close', onClose)
  })
}

/** 已构建 dist 与原生浏览器交接的测试钩子；生产环境从不修改它们。 */
export const internals: {
  resolveDistIndex: () => string
  openBrowser: (url: string) => Promise<void>
} = { resolveDistIndex, openBrowser }

/**
 * 挂载 Web runtime：dist 服务、bash 运行时变量、URL 行与默认浏览器交接。
 * @param ctx - 承载 webServer 服务的插件上下文。
 * @param config - 已校验的 {@link Config}。
 */
export function apply(ctx: Context, config: Config): void {
  // schema 只校验已出现的字符串；显式的 YAML `null` 会绕过字符串转换到达此处，
  // 表示未设置。
  const publicUrl = config.publicUrl ?? undefined
  const boundHost = ctx.webServer.host
  if (publicUrl === undefined && bindUrlHost(boundHost) === undefined) {
    throw new Error(
      `web-app: bind address ${JSON.stringify(boundHost)} carries an interface zone id, which no URL can express;`
      + ' pass --public-url with the root browsers actually reach it through',
    )
  }
  if (ctx.webServer.protocol === 'http:' && !isLoopbackHost(boundHost)) {
    console.warn(`dsh web: listening on ${boundHost} over plain HTTP; restrict this port to a trusted proxy or network`)
  }
  // 绑定 URL 属于本机。在 SSH 下，操作者通过一个本进程无法推导出的本地转发地址
  // 访问它。
  const handoffBrowser = config.openBrowser && !launchedThroughSsh(launchEnvironmentOf(ctx))
  /** 所宣告的根路径：规范的 `publicUrl`，或监听器自身的 origin。 */
  const appRootUrl = (): string => publicUrl ?? ctx.webServer.getOrigin()
  ctx.provide('webApp', { getAdvertisedUrl: appRootUrl } satisfies WebApp)
  ctx.plugin(FrontendStatic, { distIndex: internals.resolveDistIndex() })
  if (config.surfaceContext) {
    ctx.inject(['shellEnv'], (runtimeCtx) => {
      runtimeCtx.shellEnv.register({
        name: 'web-runtime',
        variables: {
          [DSH_WEB_URL]: { description: 'Advertised URL of the DeepSeek Harness Web GUI serving this session.' },
        },
        resolve: () => ({ [DSH_WEB_URL]: appRootUrl() }),
      })
    })
  }
  if (config.printUrl || handoffBrowser) {
    ctx.inject(['connection'], (connectionCtx) => {
      // URL 行与浏览器交接都是就绪信号：监控方一观察到该行就发起 RPC，而浏览器一打开
      // 就请求页面。二者都不能在诸如 /api 路由所有者等兄弟行仍在挂载时执行。先等待
      // Loader 装配完成；不带 Loader 的手工构造树本身已经是完整的树。
      const announceReady = (): void => {
        if (ANNOUNCED_ROOTS.has(connectionCtx.root)) return
        const webUrl = appRootUrl()
        const authenticatedUrl = connectionCtx.connection.authenticatedUrl(webUrl)
        ANNOUNCED_ROOTS.add(connectionCtx.root)
        if (config.printUrl) {
          console.log(`dsh web: ${authenticatedUrl}`)
        }
        if (handoffBrowser) {
          console.log('dsh web: opening the default browser; pass --no-open to disable')
          void internals.openBrowser(authenticatedUrl).catch((error: unknown) => {
            const reason = error instanceof Error ? error.message : String(error)
            console.error(`web-app: could not open the default browser because ${reason}; use the dsh web URL printed at startup`)
          })
        }
      }
      // 本行自身的激活可能早于某个兄弟行的失败。应用通过等待其 Loader 树来掌握就绪
      // 时机，在不带 Loader 的手工构造树中则立即宣告。
      const settled = connectionCtx.get('loader')?.await()
      if (settled === undefined) announceReady()
      else {
        void settled.then(async () => {
          await auditStartupEntries(connectionCtx.root, 'dsh web', () => {})
          // 启动过程中树可能已被 dispose（过早收到 SIGTERM）；为一个已死服务打印
          // URL 行或打开浏览器标签只会造成误导，而读取已拆解的服务会把一次干净的
          // 关闭变成崩溃。
          if (connectionCtx.get('webServer') !== undefined
            && connectionCtx.get('connection') !== undefined) announceReady()
        }).catch(() => {
          // 失败诊断由启动流程负责；就绪状态保持未发布。
        })
      }
    })
  }
}
