/**
 * 结构化 index 注入：插件以带类型的行（row）贡献给启动 HTML，而不是用 `tapIndex` 做原始
 * 字符串变换。行是纯 JSON 可序列化的数据，因为同一张表要喂给两个渲染器：服务形态把行渲染
 * 进 index.html 文本（{@link renderIndexInjections}），而静态 worker 部署则通过启动载荷把
 * 同样的行发给页面侧的解释器。任何无法表达为一行的东西仍留在 `tapIndex` 上，它在行渲染
 * 之后运行。
 */

/** 渲染后的行所落入的文档区域：起始 head 标签或 body 标签之后。 */
export type IndexInjectionPlacement = 'head' | 'body'

/** 一条结构化 index 注入行。 */
export type IndexInjection =
  /** 把一个 JSON 可序列化的值赋给某个 `globalThis` 属性，排在后面的 script 行之前。 */
  | { kind: 'global'; name: string; value: unknown }
  /** 内联的经典脚本。`text` 不得包含 `</script`，否则会提前闭合该元素。 */
  | { kind: 'script'; placement: IndexInjectionPlacement; text: string }
  /**
   * 外部经典脚本，按表顺序执行：服务形态下是解析器阻塞标签，worker 形态下则是被 await 的
   * 取回并执行（其加载器会解析诸如 `plugins/...` 这类仅 worker 可见的引用）。
   */
  | { kind: 'script-src'; placement: IndexInjectionPlacement; src: string }
  /** 对外部经典脚本的建议性预加载；静态 worker 可以忽略它。 */
  | { kind: 'script-preload'; src: string }
  /** head 中的一个 `<style>` 元素。`text` 不得包含 `</style`，否则会提前闭合该元素。 */
  | { kind: 'style'; text: string }
  /** 原始标记片段。 */
  | { kind: 'html'; placement: IndexInjectionPlacement; html: string }

/** 在把行值放入带引号的 HTML 属性之前对其进行转义。 */
function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function assertNever(row: never): never {
  throw new Error(`webserver: unknown index injection row ${JSON.stringify(row)}`)
}

/** 把一行连同其放置位置渲染为标记。 */
function renderRow(row: IndexInjection): { placement: IndexInjectionPlacement; markup: string } {
  switch (row.kind) {
    case 'global': {
      // 在 JSON 中转义 `<`，使行所控制的字符串无法跳出该 script 元素。
      const name = JSON.stringify(row.name).replaceAll('<', '\\u003c')
      const value = row.value === undefined
        ? 'undefined'
        : JSON.stringify(row.value).replaceAll('<', '\\u003c')
      return { placement: 'head', markup: `<script>globalThis[${name}] = ${value}</script>` }
    }
    case 'script':
      return { placement: row.placement, markup: `<script>${row.text}</script>` }
    case 'script-src':
      return { placement: row.placement, markup: `<script src="${escapeHtmlAttribute(row.src)}"></script>` }
    case 'script-preload':
      return { placement: 'head', markup: `<link rel="preload" as="script" href="${escapeHtmlAttribute(row.src)}">` }
    case 'style':
      return { placement: 'head', markup: `<style>${row.text}</style>` }
    case 'html':
      return { placement: row.placement, markup: row.html }
    default:
      return assertNever(row)
  }
}

/** 把 `markup` 插入 `html` 的 `at` 位置。 */
function splice(html: string, at: number, markup: string): string {
  return `${html.slice(0, at)}${markup}${html.slice(at)}`
}

/**
 * 收尾脚本，用于结算启动就绪的 deferred（`__DSH_BOOT_READY__`）：客户端入口在读取任何
 * 注入状态之前会 await 它的 `.promise`。哪一侧先运行就由哪一侧创建该 deferred（`??=`），
 * 因此异步应用这张表的引导过程会在入口模块之前装上它，并在最后一行之后结算它；下面的
 * 服务形态用一条语句创建并 resolve 它，因为每一行都已经在文档文本中了。
 */
const READY_MARKUP = '<script>(globalThis.__DSH_BOOT_READY__ ??= Promise.withResolvers()).resolve()</script>'

/**
 * 把各行渲染进一个 index.html 消息体：head 行紧跟在起始 head 标签之后，body 行紧跟在起始
 * body 标签之后，每组按表顺序排列，而启动就绪的收尾脚本位于最后一个 body 行之后。
 * @param html - 原始 index.html 消息体。
 * @param rows - 收集到的注入表。
 * @returns 渲染了每一行的 html。
 */
export function renderIndexInjections(html: string, rows: readonly IndexInjection[]): string {
  let head = ''
  let body = ''
  for (const row of rows) {
    const rendered = renderRow(row)
    if (rendered.placement === 'head') head += rendered.markup
    else body += rendered.markup
  }
  body += READY_MARKUP
  let out = html
  if (head !== '') {
    const open = /<head(?:\s[^>]*)?>/i.exec(out)
    // 无头（headless）夹具页面可能没有 <head>；前置追加可以让这些行排在文档的每个脚本之前。
    out = open === null ? `${head}${out}` : splice(out, open.index + open[0].length, head)
  }
  if (body !== '') {
    const open = /<body(?:\s[^>]*)?>/i.exec(out)
    // 没有 body 的片段把行接在末尾，那里 HTML 解析器已经合成出了一个 body。
    out = open === null ? `${out}${body}` : splice(out, open.index + open[0].length, body)
  }
  return out
}
