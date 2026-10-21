/**
 * `dsh-resource://file/…` 地址文法：一个文件在侧边栏与资源模型中如何被命名，
 * 在构建与解析时不接触文件系统。
 * @module
 */

/**
 * 一个文件资源地址，处于两种作用域之一。
 *
 * 每个资源地址都是 `dsh-resource://<type>/…`，URI 的 host 命名资源协议；对于
 * `file`，路径以作用域开头：
 *
 * - `dsh-resource://file/session/<sessionId>/<path>` 按路径命名一个文件，相对于
 *   该 Session 的工作区根或绝对路径；Host 针对它为该 Session 持有的根解析它。
 * - `dsh-resource://file/absolute/<path>` 按绝对路径命名一个文件，并去掉前导
 *   `/`（`dsh-resource://file/absolute/home/ys/notes.txt`；Windows
 *   `dsh-resource://file/absolute/C:/x/y.txt`；UNC 路径保留一个空的首段，
 *   `dsh-resource://file/absolute//server/share/x.txt`）。它不携带 Session。
 *
 * 每个 id 与路径段都做组件编码，因此带有 `#`、`?` 或空格的名称能完好往返；
 * `:` 保持字面，以便盘符照写可读。
 */
export type FileAddress =
  | {
    readonly scope: 'session'
    /** 其 Host 工作区解析该路径的 Session。 */
    readonly sessionId: string
    /** 绝对的或工作区相对的 `/` 分隔路径；工作区根本身为空。 */
    readonly path: string
  }
  | {
    readonly scope: 'absolute'
    /** 绝对的 `/` 分隔路径：POSIX 上为 `/a/b`，Windows 盘符为 `C:/a/b`，UNC 路径为 `//server/share/a`。 */
    readonly path: string
  }

/** 每个文件地址都以之开头的 scheme 与类型。 */
const FILE_ADDRESS_PREFIX = 'dsh-resource://file/'

/** 编码一个 id 或路径段，为盘符保留字面的 `:`。 */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%3A/gi, ':')
}

/** 逐段编码一个 `/` 分隔的路径。 */
function encodePath(path: string): string {
  return path.split('/').map(encodeSegment).join('/')
}

/** 解码后的首个路径段是否为一个 Windows 盘符（`C:`）。 */
function isDriveSegment(segment: string | undefined): boolean {
  return segment !== undefined && /^[A-Za-z]:$/.test(segment)
}

/**
 * 构建通过一个 Session 读取的文件的地址。
 * @param sessionId - 其 Host 工作区解析该路径的 Session。
 * @param path - 绝对或工作区相对路径；反斜杠规范化为 `/`，前导 `./` 前缀被丢弃。
 * @returns `dsh-resource://file/session/<sessionId>/<path>` 地址。
 */
export function sessionFileAddress(sessionId: string, path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
  return `${FILE_ADDRESS_PREFIX}session/${encodeSegment(sessionId)}/${encodePath(normalized)}`
}

/**
 * 按绝对路径构建文件的地址。
 * @param path - 绝对路径；反斜杠规范化为 `/` 并去掉前导 `/`，但 UNC 路径
 *   （`\\server\share`）保留一个空的首段。
 * @returns `dsh-resource://file/absolute/<path>` 地址。
 */
export function absoluteFileAddress(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const unc = normalized.startsWith('//')
  const absolute = normalized.replace(/^\/+/, '')
  return `${FILE_ADDRESS_PREFIX}absolute/${unc ? '/' : ''}${encodePath(absolute)}`
}

/**
 * 把一个文件地址读回其组成部分，而不解析 `.` 或 `..`。
 * 查询与片段后缀被忽略；已编码的路径段被解码。
 * @param address - 一个候选地址。
 * @returns 组成部分，或当该字符串不是一个处于已知作用域、带有路径的
 *   `dsh-resource://file/` URI，或某段编码不合法时为 `undefined`。
 */
export function parseFileAddress(address: string): FileAddress | undefined {
  try {
    if (!address.startsWith(FILE_ADDRESS_PREFIX)) return undefined
    const end = address.search(/[?#]/)
    const [scope, ...rest] = address.slice(FILE_ADDRESS_PREFIX.length, end === -1 ? undefined : end).split('/')
    if (scope === 'session') {
      const [id, ...segments] = rest
      if (id === undefined || id === '' || segments.length === 0) return undefined
      return { scope, sessionId: decodeURIComponent(id), path: segments.map(decodeURIComponent).join('/') }
    }
    if (scope === 'absolute') {
      // 首段为空且后面还有内容，是 UNC 路径的 `//`；单独出现则不成路径。
      const unc = rest[0] === '' && rest.length > 1
      const segments = (unc ? rest.slice(1) : rest).map(decodeURIComponent)
      if (segments.length === 0 || segments[0] === '') return undefined
      if (unc) return { scope, path: `//${segments.join('/')}` }
      return { scope, path: isDriveSegment(segments[0]) ? segments.join('/') : `/${segments.join('/')}` }
    }
    return undefined
  } catch {
    // `decodeURIComponent` 在遇到畸形转义时抛出 URIError。
    return undefined
  }
}
