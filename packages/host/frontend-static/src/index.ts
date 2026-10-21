/**
 * @deepseek-ai/dsh-host-frontend-static —— 基于 webserver 回退座位的 SPA dist 服务器：以
 * 显式的 index 入口服务构建好的前端目录。dist 根与配置的 index 路径处会渲染出可读的
 * index；缺失的路径返回 404；越出 dist 根的目录穿越返回 403；未知扩展名以 octet-stream
 * 发送；非 GET/HEAD 返回 405。每个 index 响应先通过 Connection 的浏览器身份认证，再经过
 * webserver 的 index 渲染（先是结构化注入行，然后是原始钩子）。非 index 的静态资源保持
 * 公开。dist 的位置属于组合应用的 workspace 知识，因此 `distIndex` 通常通过 `!!js`
 * 表达式提供，绝不应由某个部署硬编码。
 * @module @deepseek-ai/dsh-host-frontend-static
 */

import type { ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** 稳定的 Cordis 插件名。 */
export const name = 'frontend-static'

/** 在占用带身份认证的回退座位之前所必需的服务。 */
export const inject = ['webServer', 'connection']

/** 插件配置：dist 锚点。 */
export interface Config {
  /** dist 根内 index.html 的绝对路径。 */
  distIndex: string
}

export const Config: z<Config> = z.object({
  distIndex: z.string().required(),
})

const HTML_MIME = 'text/html; charset=utf-8'

const MIME: Record<string, string> = {
  '.html': HTML_MIME,
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  // 打包后的 VFS 镜像。以其自身字节发送，绝不带 Content-Encoding：worker 自行解压消息体，
  // 而传输层的编码会让它去解压一个已被解码过的归档。
  '.gz': 'application/gzip',
}

const STATIC_MISS_CODES: ReadonlySet<string | undefined> = new Set([
  'ENOENT',
  'EISDIR',
  'ENOTDIR',
])

/**
 * 从 dist 根处理一个 GET/HEAD 静态请求。
 * @param pathname - 请求解码后的 URL pathname。
 * @param res - 要写入的 node:http 响应。
 * @param distRoot - 绝对的 dist 根目录（由调用方解析）。
 * @param distIndex - distRoot 内 index.html 的绝对路径。
 * @param authorizeIndex - 在读取 index 字节之前对其进行身份认证。
 * @param renderIndex - 为 dist 根与配置的 index 路径生成 index.html 消息体（结构化注入
 * 渲染）。
 */
export async function serveStatic(
  pathname: string, res: ServerResponse, distRoot: string, distIndex: string,
  authorizeIndex: () => boolean,
  renderIndex: () => Promise<string>,
): Promise<void> {
  const target = resolve(normalize(join(distRoot, pathname)))
  // 目录穿越拒绝：目标必须是 distRoot 本身（`/`）或位于其下。这里用 `sep` 而不是 '/'：
  // resolve() 在 Windows 上产出反斜杠路径，而 '/' 后缀会把每个合法子路径都判为穿越。
  if (target !== distRoot && !target.startsWith(distRoot + sep)) {
    res.writeHead(403)
    res.end()
    return
  }
  let body: string | Buffer
  let type: string
  try {
    if (target === distRoot || target === distIndex) {
      if (!authorizeIndex()) return
      body = await renderIndex()
      type = HTML_MIME
    } else {
      body = await readFile(target)
      type = MIME[extname(target)] ?? 'application/octet-stream'
    }
  } catch (error) {
    // 只有目标不存在或不是文件才是 404；其他文件系统失败交给 webserver 的请求失败处理。
    if (!STATIC_MISS_CODES.has((error as NodeJS.ErrnoException).code)) throw error
    res.writeHead(404)
    res.end()
    return
  }
  res.writeHead(200, { 'content-type': type })
  res.end(body)
}

/**
 * 占用 webserver 回退座位并服务 dist。
 * @param ctx - 携带 webServer 服务的插件 context。
 * @param config - 已校验的 {@link Config}。
 */
export function apply(ctx: Context, config: Config): void {
  const distIndex = config.distIndex
  const distRoot = dirname(distIndex)
  // 在所有 index 变换之后插入，使 base 先于每个资源引用。
  const renderIndex = async (): Promise<string> => {
    const body = ctx.webServer.renderIndex(await readFile(distIndex, 'utf8'))
    return body.replace(/<head(?:\s[^>]*)?>/i, open => `${open}<base href="./">`)
  }
  ctx.effect(() => ctx.webServer.registerFallback(async (req, res) => {
    // 非 GET/HEAD 且没有匹配的具名路由时为 405（仅回退语义：具名路由自行处理各自的方法）。
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    /* v8 ignore next -- node:http 总是为服务端请求设置 url */
    const rawPath = new URL(req.url ?? '/', 'http://x').pathname
    await serveStatic(
      decodeURIComponent(rawPath),
      res,
      distRoot,
      distIndex,
      () => ctx.connection.authorizeIndex(req, res),
      renderIndex,
    )
  }), 'frontend-static: fallback seat')
}
