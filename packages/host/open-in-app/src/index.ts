/**
 * open-in-app 的宿主部分：在组合的 `webServer` 上提供三条路由，分别服务已解析的应用程序
 * 目录、各应用的图标，以及浏览器拆分按钮（`@deepseek-ai/dsh-client-ui-open-in-app`）所
 * 提交到的启动端点。
 *
 * 安全只在一处落地，就在这里。每条路由都先向组合的 `connection` 服务请求一次拒绝判定
 * （`requestRejection`）：它的 Host/Origin 栅栏可抵御 DNS rebinding 与跨站调用，其浏览器
 * 身份认证（登录令牌 cookie）在任何解析结果、图标或启动动作可被触达之前就把每个调用方
 * 挡在门外。在这道栅栏之上，open 路由还在线上校验其请求体：`application/json` 媒体类型、
 * 64 KiB 上限、字符串形式的 `app`/`path` 字段、一个已解析且可用的目录 id，以及一个指向
 * 已存在目录的绝对路径。
 *
 * 目录解析是惰性的，每个插件生命周期内在首个需要它的请求上解析一次，结果是一张已校验
 * 启动器的映射表：apps 路由提供其键，open 路由启动其值，因此一次点击、展开菜单或页面
 * 重载都不会重跑检测。某次启动若发现其可执行文件已消失（`ENOENT`），则让该条目失效并
 * 重新解析一次。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAbsolute } from 'node:path'
import { stat } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-subprocess'
import { launchedThroughSsh, launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import { OPEN_IN_APP_CATALOG, type OpenInAppApp } from './catalog.ts'
import {
  launchResolved, resolveLaunch, resolveOpenInAppApps,
  type OpenInAppInternals, type OpenInAppResolvedLaunch,
} from './resolver.ts'
import { extractAppIcon, type OpenInAppIcon } from './icons.ts'
import { internals } from './internals.ts'
import {
  OPEN_IN_APP_APPS_PATH, OPEN_IN_APP_ICON_PREFIX_PATH, OPEN_IN_APP_OPEN_PATH,
} from './shared.ts'

export type * from './shared.ts'

/** Cordis 函数插件名。 */
export const name = 'open-in-app'
/** 路由载体、守卫每条路由的信任栅栏，以及 PATH 解析器。 */
export const inject = ['webServer', 'connection', 'subprocess']

/** open-in-app 宿主配置。 */
export interface Config {
  /**
   * 目录解析用宿主命令（`xcode-select`、Windows 注册表读取）的单条命令时限，单位为毫秒。
   */
  readonly probeTimeoutMs: number
  /**
   * 图标提取用宿主命令（macOS 上的 `plutil`/`sips`，Windows 上的 PowerShell 提取）的单条
   * 命令时限，单位为毫秒。
   */
  readonly iconTimeoutMs: number
  /**
   * 每次启动的早期失败观察窗口，单位为毫秒：窗口关闭时仍在运行的启动器算作已启动并继续
   * 运行，因此它限定的是 open 路由持有一次成功启动多久，而不是一个应用程序可以存活多久。
   */
  readonly launchWatchMs: number
}

const boundedMs = (): z<number> => z.number().step(1).min(1).max(600_000).required()

export const Config: z<Config> = z.object({
  probeTimeoutMs: boundedMs(),
  iconTimeoutMs: boundedMs(),
  launchWatchMs: boundedMs(),
})

/** 此处消费的信任接口；完整类型由浏览器侧的 connection 包拥有。 */
interface OpenInAppConnection {
  requestRejection(request: { readonly headers: IncomingMessage['headers'] }): 401 | 403 | undefined
}

/** 组合中的 connection 服务（在本地给出类型：其包属于浏览器侧）。 */
function connectionOf(ctx: Context): OpenInAppConnection {
  return Reflect.get(ctx, 'connection') as OpenInAppConnection
}

/** open 路由的请求体是极小的 JSON 对象；更大的一律视为恶意。 */
const MAX_BODY_BYTES = 64 * 1024

/** JSON 响应（no-store：可用性与启动结果都是实时事实）。 */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** 405，并带上该路由唯一支持的方法。 */
function sendMethodNotAllowed(res: ServerResponse, allow: 'GET' | 'POST'): void {
  res.statusCode = 405
  res.setHeader('allow', allow)
  res.end()
}

/** 把有界的请求体收集为 UTF-8 文本；超过上限时返回 null（流已被排空）。 */
async function readBoundedBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = []
  let size = 0
  // 未调用 setEncoding 的 http server 流总是给出 Buffer 分片。
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      // 排空剩余部分，使拒绝是一个可读的响应，而不是被切断的 socket。
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/** 在线上校验一个 open 路由请求体：含字符串 app/path 的 JSON 对象。 */
function parseOpenBody(text: string): { app: string; path: string } | null {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    // 吞掉解析错误：非 JSON 的请求体恰好就是 null 这一情况。
    return null
  }
  if (typeof body !== 'object' || body === null) return null
  const { app, path } = body as { app?: unknown; path?: unknown }
  return typeof app === 'string' && typeof path === 'string' ? { app, path } : null
}

/** 在 connection 信任栅栏之后注册 apps、icon 与 open 三条路由。 */
export function apply(ctx: Context, config: Config): void {
  const ssh = launchedThroughSsh(launchEnvironmentOf(ctx))
  /** 由组合的 PATH 解析器补全后的测试接缝事实。 */
  const catalogInternals = (): OpenInAppInternals => ({
    ssh,
    resolveExecutable: async (name) => {
      try {
        return await ctx.subprocess.resolveExecutable(name)
      } catch {
        // 吞掉 provider 的未找到拒绝：对检测而言，一个解析不到的名字只有一种含义——不可用。
        return null
      }
    },
    ...internals.catalog,
  })
  /** 惰性的、每个插件生命周期一次的解析；该映射即是可变的权威。 */
  let resolutions: Promise<Map<string, OpenInAppResolvedLaunch>> | undefined
  const availability = (): Promise<Map<string, OpenInAppResolvedLaunch>> =>
    resolutions ??= resolveOpenInAppApps(config.probeTimeoutMs, catalogInternals())
  /** 按应用缓存的图标 promise（null 表示解析为不可用）。 */
  const icons = new Map<string, Promise<OpenInAppIcon | null>>()
  const iconOf = (app: OpenInAppApp, resolved: OpenInAppResolvedLaunch): Promise<OpenInAppIcon | null> => {
    let cached = icons.get(app.id)
    if (cached === undefined) {
      cached = extractAppIcon(app, resolved, config.iconTimeoutMs, catalogInternals())
      icons.set(app.id, cached)
    }
    return cached
  }
  /**
   * 在一次可执行文件缺失的启动之后替换掉那条过期的解析结果：该条目（及其图标）重新解析
   * 一次；若某个条目已无法解析，则离开映射表，且下一次 apps 读取不再提供它。
   */
  const refreshResolution = async (app: OpenInAppApp): Promise<OpenInAppResolvedLaunch | undefined> => {
    const map = await availability()
    const fresh = await resolveLaunch(app, config.probeTimeoutMs, catalogInternals())
    icons.delete(app.id)
    if (fresh === null) {
      map.delete(app.id)
      return undefined
    }
    map.set(app.id, fresh)
    return fresh
  }
  /** 应答一个不受信任/未认证的请求；返回 true 表示它已被拒绝。 */
  const rejected = (req: IncomingMessage, res: ServerResponse): boolean => {
    const rejection = connectionOf(ctx).requestRejection(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: OPEN_IN_APP_APPS_PATH,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'GET') {
        sendMethodNotAllowed(res, 'GET')
        return
      }
      sendJson(res, 200, { apps: [...(await availability()).keys()] })
    },
  }), `open-in-app: GET ${OPEN_IN_APP_APPS_PATH}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: OPEN_IN_APP_ICON_PREFIX_PATH,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'GET') {
        sendMethodNotAllowed(res, 'GET')
        return
      }
      // Node 总是为服务端请求设置 url；String 把这一事实留在本地。
      const pathname = new URL(String(req.url), 'http://localhost').pathname
      const id = pathname.slice(OPEN_IN_APP_ICON_PREFIX_PATH.length).replace(/^\//, '')
      const noIcon = (): void => { sendJson(res, 404, { code: 'not-found', message: `no icon for ${id}` }) }
      const app = OPEN_IN_APP_CATALOG.find(entry => entry.id === id)
      if (app === undefined) {
        noIcon()
        return
      }
      const resolved = (await availability()).get(app.id)
      if (resolved === undefined) {
        noIcon()
        return
      }
      const icon = await iconOf(app, resolved)
      if (icon === null) {
        noIcon()
        return
      }
      res.statusCode = 200
      res.setHeader('content-type', icon.contentType)
      res.setHeader('cache-control', 'public, max-age=3600')
      res.end(icon.bytes)
    },
  }), `open-in-app: GET ${OPEN_IN_APP_ICON_PREFIX_PATH}/<id>`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: OPEN_IN_APP_OPEN_PATH,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'POST') {
        sendMethodNotAllowed(res, 'POST')
        return
      }
      // 请求体格式校验：essence 必须恰好是 application/json。
      // String(undefined) 是 'undefined'，永远不会匹配。
      const essence = String(req.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase()
      if (essence !== 'application/json') {
        sendJson(res, 415, { code: 'unsupported-media-type', message: 'content-type must be application/json' })
        return
      }
      let text: string | null
      try {
        text = await readBoundedBody(req)
      } catch {
        // 吞掉请求体中途的连接错误：已经没有可以精确回答的东西了。
        sendJson(res, 400, { code: 'bad-request', message: 'request body unreadable' })
        return
      }
      if (text === null) {
        sendJson(res, 413, { code: 'payload-too-large', message: 'request body is too large' })
        return
      }
      const parsed = parseOpenBody(text)
      if (parsed === null) {
        sendJson(res, 400, { code: 'bad-request', message: 'request body must be JSON with string "app" and "path"' })
        return
      }
      const app = OPEN_IN_APP_CATALOG.find(entry => entry.id === parsed.app)
      const resolved = app === undefined ? undefined : (await availability()).get(app.id)
      if (app === undefined || resolved === undefined) {
        sendJson(res, 400, { code: 'bad-request', message: `unknown or unavailable app: ${parsed.app}` })
        return
      }
      if (parsed.path === '' || !isAbsolute(parsed.path)) {
        sendJson(res, 400, { code: 'bad-request', message: 'path must be an absolute directory path' })
        return
      }
      let directory: boolean
      try {
        directory = (await stat(parsed.path)).isDirectory()
      } catch {
        // 吞掉 ENOENT/EACCES：两者都意味着没有可打开的目录。
        directory = false
      }
      if (!directory) {
        sendJson(res, 404, { code: 'not-found', message: `directory does not exist: ${parsed.path}` })
        return
      }
      let outcome = await launchResolved(resolved, parsed.path, config.launchWatchMs, catalogInternals())
      if (outcome === 'missing') {
        // 已校验的启动器消失了（解析之后被卸载）：刷新这一个条目，并用新的启动器重试一次。
        const fresh = await refreshResolution(app)
        outcome = fresh === undefined
          ? 'failed'
          : await launchResolved(fresh, parsed.path, config.launchWatchMs, catalogInternals())
      }
      if (outcome === 'launched') {
        sendJson(res, 200, { ok: true })
      } else {
        sendJson(res, 502, { code: 'launch-failed', message: `failed to launch ${app.id}` })
      }
    },
  }), `open-in-app: POST ${OPEN_IN_APP_OPEN_PATH}`)
}
