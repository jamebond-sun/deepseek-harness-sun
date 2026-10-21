/**
 * Host 注册导出路由所用的绝对路径名，以及浏览器寻址时使用的文档相对形式；
 * 参见 .agents/notes/implemented/architecture/2026-09-14-web-document-relative-app-routes.md。
 */

/** ZIP 下载路由的绝对注册路径。 */
export const SESSION_LOG_EXPORT_PATH = '/api/session.export'

/** {@link SESSION_LOG_EXPORT_PATH} 的浏览器相对形式。 */
export const SESSION_LOG_EXPORT_ROUTE = SESSION_LOG_EXPORT_PATH.slice(1)
