/**
 * 宿主路由与浏览器包（`@deepseek-ai/dsh-client-ui-open-in-app`）逐字共享的路由路径与线上
 * 载荷，以 `./shared` 子路径发布。浏览器安全：仅含常量与类型。每条路由都同时带有宿主注册
 * 的绝对路径名，以及浏览器寻址时使用的相对文档形式；见
 * .agents/notes/implemented/architecture/2026-09-14-web-document-relative-app-routes.md。
 */

/** 提供已探测到的应用程序 id 的 GET 路由路径。 */
export const OPEN_IN_APP_APPS_PATH = '/open-in-app/apps'

/** {@link OPEN_IN_APP_APPS_PATH} 的浏览器相对形式。 */
export const OPEN_IN_APP_APPS_ROUTE = OPEN_IN_APP_APPS_PATH.slice(1)

/** 按应用 id 提供单个 PNG 图标的 GET 前缀路径。 */
export const OPEN_IN_APP_ICON_PREFIX_PATH = '/open-in-app/icon'

/** {@link OPEN_IN_APP_ICON_PREFIX_PATH} 的浏览器相对形式。 */
export const OPEN_IN_APP_ICON_PREFIX_ROUTE = OPEN_IN_APP_ICON_PREFIX_PATH.slice(1)

/** 在某个工作区目录上启动某个应用程序的 POST 路由路径。 */
export const OPEN_IN_APP_OPEN_PATH = '/open-in-app/open'

/** {@link OPEN_IN_APP_OPEN_PATH} 的浏览器相对形式。 */
export const OPEN_IN_APP_OPEN_ROUTE = OPEN_IN_APP_OPEN_PATH.slice(1)

/** apps 路由的响应：探测为已安装的应用目录 id，按菜单顺序排列。 */
export interface OpenInAppAppsPayload {
  readonly apps: readonly string[]
}

/** open 路由的请求体。 */
export interface OpenInAppOpenPayload {
  readonly app: string
  readonly path: string
}
