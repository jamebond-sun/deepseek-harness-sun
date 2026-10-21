/**
 * 规范化解析的公开 HTTP(S) 根路径，本 bundle 的 `publicUrl` 配置与其 CLI 启动提供者共用。
 * @module @deepseek-ai/dsh-web-app/public-url
 */

/**
 * 解析去除前缀代理部署所宣告的公开 HTTP(S) 根路径，拒绝 WHATWG URL 解析本身会
 * 接受的那些危险形式，然后把路径规范化为以 `/` 结尾。
 * @param value - 宣告的公开 HTTP(S) 根路径。
 * @param label - 出现在拒绝信息中的字段名或 CLI 标志名。
 * @returns 路径名以斜杠结尾的已解析 URL。
 * @throws 当该值不是可用的宣告根路径时抛出，并说明原因。
 */
export function parsePublicUrl(value: string, label = 'publicUrl'): URL {
  if (/[\u0000-\u0020\u007f]/u.test(value)) {
    throw new Error(`${label} must not contain ASCII whitespace or control characters`)
  }
  if (!/^https?:\/\//iu.test(value)) {
    throw new Error(`${label} must be an absolute http or https URL of the form http(s)://host[/prefix]`)
  }
  if (value.includes('?') || value.includes('#')) {
    throw new Error(`${label} must not include a query or fragment (? or #)`)
  }
  // userinfo 位于原始 authority 中（第一个路径斜杠之前）；authority 为空的形式
  // （`https://`、`https:///ui`、`http:///ui`）也在这里失败。
  const [authority = ''] = value.slice(value.indexOf('://') + 3).split(/[/\\]/, 1)
  if (authority === '') {
    throw new Error(`${label} must name a host after http:// or https://`)
  }
  if (authority.includes('@')) {
    throw new Error(`${label} must not include credentials (a username or password before @, including an empty user)`)
  }
  const url = URL.parse(value)
  if (url === null) throw new Error(`${label} must be an absolute http or https URL`)
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url
}
