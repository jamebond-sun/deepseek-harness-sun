/**
 * 每个代码呈现面共享的「文件扩展名 → 语法高亮语言」单表：Client 端的
 * 文档 Code 预览与差异审阅，以及 Host 读工具的持久化 `lang` 提示。语言 id
 * 是 Client 高亮器的别名表所解析的语法 id，因此这里返回的语言会原样到达
 * `highlightLines`/`highlightToHtml`；表中之外的文件名，或指向高亮器未
 * 注册语言者，会以纯文本渲染。读工具持久化一个简短的 `lang` id，因此
 * {@link readLangHintForPath} 在本表之上投影简短 id：某一后缀会保持已记录
 * 会话已持有的值，而其他后缀则持久化语言的短名——对 `kotlin`、`swift`、
 * `yaml`、`json` 等而言，这等同于该语言的语法 id。
 * @module @deepseek-ai/dsh-util-code-language
 */

/**
 * 每个规范语言 id 所识别的扩展名。值为不带点的小写扩展名；id 命名的是
 * 语法而非显示标签。该集合涵盖了带行号代码视图或预览能从中获益的常见源
 * 码、配置、脚本、数据与标记类扩展；它刻意不是一个穷尽的 linguist 注册
 * 表。其 Shiki 语法不存在的扩展名，会映射到最近可用的语法（`properties`
 * 映射到 `ini`，后者的注册带有 `properties` 别名），或保持不列入。证书与
 * 锁类扩展名（`pem`、`crt`、`key`、`cer`、`lock`）保持不列入。预览注册表
 * 会将专用查看器排在 Code 之前，以便 CSV 默认使用 Spreadsheet 同时保留
 * 语法高亮。`makefile` 仅覆盖该后缀（`foo.makefile`）；无扩展名的 `Makefile`
 * 名称保持不列入。
 */
const LANGUAGE_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  typescript: ['ts', 'tsx', 'mts', 'cts'],
  javascript: ['js', 'jsx', 'mjs', 'cjs'],
  shellscript: ['sh', 'bash', 'zsh'],
  fish: ['fish'],
  json: ['json', 'jsonc', 'jsonl', 'ndjson', 'ipynb'],
  csv: ['csv'],
  python: ['py', 'pyw', 'pyi'],
  ruby: ['rb', 'rake', 'gemspec'],
  go: ['go'],
  rust: ['rs'],
  java: ['java'],
  c: ['c', 'h'],
  cpp: ['cc', 'cpp', 'cxx', 'hh', 'hpp', 'hxx'],
  csharp: ['cs'],
  kotlin: ['kt', 'kts'],
  swift: ['swift'],
  php: ['php'],
  yaml: ['yaml', 'yml'],
  toml: ['toml'],
  ini: ['ini', 'conf', 'cfg', 'properties'],
  dotenv: ['env'],
  log: ['log'],
  diff: ['diff', 'patch'],
  http: ['http'],
  markdown: ['md', 'markdown'],
  mdx: ['mdx'],
  rst: ['rst'],
  latex: ['tex', 'sty', 'cls'],
  bibtex: ['bib'],
  asciidoc: ['adoc'],
  html: ['html', 'htm', 'xhtml'],
  css: ['css'],
  scss: ['scss'],
  less: ['less'],
  sql: ['sql'],
  xml: ['xml', 'xsd', 'xsl', 'xslt', 'plist', 'svg'],
  lua: ['lua'],
  bat: ['bat', 'cmd'],
  powershell: ['ps1', 'psm1', 'psd1'],
  r: ['r'],
  julia: ['jl'],
  dart: ['dart'],
  scala: ['scala'],
  clojure: ['clj', 'cljs', 'edn'],
  erlang: ['erl', 'hrl'],
  elixir: ['ex', 'exs'],
  haskell: ['hs'],
  fsharp: ['fs', 'fsi', 'fsx'],
  vb: ['vb'],
  perl: ['pl', 'pm'],
  verilog: ['v'],
  'system-verilog': ['sv', 'svh'],
  graphql: ['graphql', 'gql'],
  proto: ['proto'],
  hcl: ['tf', 'tfvars', 'hcl'],
  nix: ['nix'],
  vue: ['vue'],
  svelte: ['svelte'],
  make: ['makefile', 'mk'],
  cmake: ['cmake'],
  groovy: ['gradle', 'groovy'],
}

/**
 * 小写扩展名到规范语言 id 的映射。用 Map 而非对象：扩展名是
 * `Object.prototype` 键（如 `foo.constructor`、`foo.__proto__`）的文件名
 * 必须查找失败，而不是解析到继承成员，否则会以非字符串的语言值抵达调用方。
 */
const LANGUAGES = new Map(Object.entries(LANGUAGE_EXTENSIONS)
  .flatMap(([language, extensions]) => extensions.map(extension => [extension, language] as const)))

/** 每个被识别的文件名后缀各一条；文档预览注册表用它来认领 Code 渲染的正文。 */
export const CODE_HIGHLIGHT_EXTENSIONS: readonly string[] = [...LANGUAGES.keys()]

/**
 * 语言级短 id 无法表达、但被持久化的 `lang` 值，以产生它们的后缀为键。其余
 * 情况回退到 {@link SHORT_BY_LANGUAGE}，因此只有某个后缀自身命名比其语言
 * 更好的标签才出现在此处。每个值都是已记录会话确切持有的字符串，且不得
 * 更改；每个后缀的字节级期望位于读消费方的测试中。
 */
const READ_LANG_BY_EXTENSION = new Map<string, string>([
  // 两种 JSX 风味保留各自的后缀；其他每个持久化值都是语言的短名，或比其
  // 语言命名得更好的扩展名（`tf` 而非 `hcl`、`gradle` 而非 `groovy`）。
  ['tsx', 'tsx'], ['jsx', 'jsx'],
  ['tf', 'tf'], ['tfvars', 'tfvars'], ['gradle', 'gradle'],
])

/**
 * 读卡片持久化的短 `lang` id，以规范语言 id 为键。键恰好是
 * {@link LANGUAGE_EXTENSIONS} 中的语言：在 {@link READ_LANG_BY_EXTENSION}
 * 尚未固定某后缀的值之处，此表提供该语言的短名（`powershell` 到 `ps1`、
 * `hcl` 到 `tf`、`system-verilog` 到 `sv`）而非语法 id。键是规范 id 而非
 * 不可信的扩展名，因此对象查找不会像扩展名表那样抵达 `Object.prototype`
 * 成员。
 */
const SHORT_BY_LANGUAGE: Readonly<Record<string, string>> = {
  typescript: 'ts',
  javascript: 'js',
  shellscript: 'sh',
  fish: 'fish',
  json: 'json',
  csv: 'csv',
  python: 'py',
  ruby: 'rb',
  go: 'go',
  rust: 'rs',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  csharp: 'cs',
  kotlin: 'kotlin',
  swift: 'swift',
  php: 'php',
  yaml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  dotenv: 'env',
  log: 'log',
  diff: 'diff',
  http: 'http',
  markdown: 'md',
  mdx: 'mdx',
  rst: 'rst',
  latex: 'tex',
  bibtex: 'bib',
  asciidoc: 'adoc',
  html: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  sql: 'sql',
  xml: 'xml',
  lua: 'lua',
  bat: 'bat',
  powershell: 'ps1',
  r: 'r',
  julia: 'jl',
  dart: 'dart',
  scala: 'scala',
  clojure: 'clj',
  erlang: 'erl',
  elixir: 'ex',
  haskell: 'hs',
  fsharp: 'fs',
  vb: 'vb',
  perl: 'pl',
  verilog: 'v',
  'system-verilog': 'sv',
  graphql: 'graphql',
  proto: 'proto',
  hcl: 'hcl',
  nix: 'nix',
  vue: 'vue',
  svelte: 'svelte',
  make: 'make',
  cmake: 'cmake',
  groovy: 'groovy',
}

function extensionForPath(path: string): string | undefined {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const base = path.slice(slash + 1)
  const dot = base.lastIndexOf('.')
  return dot < 0 ? undefined : base.slice(dot + 1).toLowerCase()
}

/**
 * 由文件名或路径推导语法高亮语言，大小写不敏感。扩展名是最终路径段中
 * 最后一个点之后的文本；前导点仍是分隔符，因此 `.env` 解析为 `dotenv`，
 * 而未列入的点文件（`.gitignore`）和无扩展名名称返回 `undefined`。两种
 * 路径分隔符都被识别，因此 `C:\\dir\\main.PS1` 与 `dir/main.ps1` 解析一致。
 * @param path - 已解码的文件名或路径。
 * @returns 规范语言 id，或不可识别/缺失后缀时的 `undefined`。
 */
export function languageForPath(path: string): string | undefined {
  const extension = extensionForPath(path)
  return extension === undefined ? undefined : LANGUAGES.get(extension)
}

/**
 * 由读取路径的扩展名推导 Host 读卡片持久化的 `lang` 提示。该值是语言的
 * 短名；对部分语言而言，该名称同时也是语法 id（`kotlin`、`swift`、`java`、
 * `yaml`、`json`），而 {@link READ_LANG_BY_EXTENSION} 会在后缀自身命名
 * 得更好的地方覆盖它（`tsx`、`tf`、`gradle`）。已记录会话持有的后缀会
 * 保留其持久化值。不可识别的后缀保持 `undefined`，因此卡片以纯文本渲染。
 * @param path - 读操作所报告的、面向模型的路径。
 * @returns 持久化的语言提示，或扩展名映射不到任何语言时的 `undefined`。
 */
export function readLangHintForPath(path: string): string | undefined {
  const extension = extensionForPath(path)
  if (extension === undefined) return undefined
  const canonical = LANGUAGES.get(extension)
  return canonical === undefined ? undefined : READ_LANG_BY_EXTENSION.get(extension) ?? SHORT_BY_LANGUAGE[canonical]
}
