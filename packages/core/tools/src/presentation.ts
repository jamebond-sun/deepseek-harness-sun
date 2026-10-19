/**
 * 工具渲染意图词汇表：工具通过 `ToolDefinition.presentCall`/`ToolDefinition.presentResult`
 * 声明的提供方中立类型，用于说明其某次调用在 UI（编辑器的工具调用卡片、
 * CLI 日志行）中如何渲染。
 * @module @deepseek-ai/dsh-tools/src/presentation
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/**
 * 工具调用的类别，UI 用它选择图标或样式。提供方中立的词汇表让工具描述自身
 * 而不依赖特定客户端；默认为 `other`。
 */
export type ToolCallKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'fetch' | 'other'

/**
 * 工具读取或修改的文件位置，使具备能力的 UI 能"跟随"——在工具运行时高亮
 * 或跳转到该文件（及行）。`path` 是工具操作的对象（面向模型的路径）；
 * `line` 是可选的聚焦行号（1 起，例如读取的偏移）。
 */
export interface FileLocation {
  path: string
  line?: number
}

/**
 * 工具即将做出的单文件变更，供渲染内联差异的 UI 使用。新建文件时 `oldText`
 * 为 `null`（没有可对比的内容）；覆盖写入也使用 `null`，因为调用时呈现器
 * 无法访问文件先前内容。
 */
export interface FileDiff {
  path: string
  /** 先前内容；新建文件或覆盖写入时为 `null`（调用时无法获得先前内容）。 */
  oldText: string | null
  /** 变更后的内容。 */
  newText: string
}

/**
 * 提供方中立的待处理调用展示。工具声明一个带标签的意图；UI 桥接层映射它
 * 而不特判工具名。
 */
export type ToolCallView = GenericCallView | TerminalCallView | DiffCallView

/**
 * 默认卡片：带标题的工具调用行，含可选类别图标、醒目的原始输入、额外的
 * 内容块和可跟随的文件位置。调用不是终端或差异的工具都使用它。
 */
export interface GenericCallView {
  card: 'generic'
  /**
   * 人类可读、始终可见的标签，描述本次调用做什么。保持简短——UI 将其作为
   * 卡片标题 / 日志行展示。
   */
  title: string
  /** 用于图标/样式的类别；省略时默认为 `other`。 */
  kind?: ToolCallKind
  /**
   * 在详情/展开视图中展示的醒目输入（例如后台任务 id）。省略则不显示；
   * 字符串原样渲染，对象渲染为格式化 JSON。除非读者确实需要，否则不是
   * 完整的原始参数对象。
   */
  rawInput?: unknown
  /**
   * 面向 UI 的内容块，与标题一起显示在待处理调用上。省略则不显示。UI 将
   * 这些映射为自己的内容块。
   */
  content?: ContentBlock[]
  /** 本次调用读取/修改的文件，供编辑器跟随。不触及文件的调用省略此项。 */
  locations?: FileLocation[]
}

/**
 * 本身就是在工作目录中运行的 shell 命令的调用：具备能力的 UI 将其渲染为
 * 终端卡片（以 cwd 开头，命令作为标题，实时/事后输出来自
 * {@link TerminalResultView}）；不具备能力的 UI 回退为通用卡片，其主体是
 * 围栏化的命令输出。由调用为前台命令的工具设置（例如 `bash`）。
 */
export interface TerminalCallView {
  card: 'terminal'
  /** 命令，显示为终端卡片的标题 / 头行。 */
  title: string
  /**
   * 人类可读的一行摘要，说明命令做什么，渲染在终端卡片上方（卡片本身没有
   * 描述槽位）。无则省略。
   */
  description?: string
  /**
   * 命令运行的工作目录，显示为终端头部。绝对路径原样使用；相对路径由 UI
   * 桥接层相对 session 工作区解析（纯呈现器看不到 session cwd）。完全省略
   * 则由桥接层使用 session 工作区。
   */
  cwd?: string
}

/**
 * 创建或修改文件的调用，由具备能力的 UI 渲染为内联差异卡片。由调用写入/
 * 编辑文件的工具设置（例如 `write`、`edit`）。差异派生自调用参数（新建的
 * `oldText` 为 `null`）；工具在 `execute` 之后单独发出 {@link DiffResultView}
 * ——已应用的变更（带上下文的编辑/覆盖块，或新建时的整文件差异）。
 */
export interface DiffCallView {
  card: 'diff'
  /** 卡片头部（例如 `Write foo.txt`）。 */
  title: string
  /** 调用变更的每个文件一项。 */
  diffs: FileDiff[]
  /** 本次调用修改的文件，供编辑器跟随（通常是各差异的路径）。 */
  locations?: FileLocation[]
}

/**
 * 文件中一个带编号的行，是 {@link ReadResultView} 携带的单位，使具备能力的
 * UI 能渲染语法高亮、带行号的代码视图。`number` 是文件中的行号（1 起；
 * 位于 `offset` 之后的窗口保持文件自身编号，而非从 1 重新计数）；`text` 是
 * 不含行尾换行的行文本，已按读取工具的每行上限截断。
 */
export interface ReadFileLine {
  number: number
  text: string
}

/**
 * 工具希望已完成调用如何展示——`execute` 返回后的 *结果* 状态。镜像
 * {@link ToolCallView} 的 `card` 标签联合类型：UI 按 `card` 分派。让工具
 * 为 UI 重新格式化结果，区别于它从 `execute` 返回的面向模型文本。由
 * `ToolDefinition.presentResult` 返回；省略该方法则保留待处理标题并渲染
 * 原始结果内容。
 */
export type ToolResultView = GenericResultView | TerminalResultView | DiffResultView | SearchResultView | ReadResultView | WebResultView

/**
 * 默认的完成卡片：可选的替换标题与重新格式化的内容。省略字段则保留待处理
 * 标题 / 渲染原始结果内容。
 */
export interface GenericResultView {
  card: 'generic'
  /** 已完成调用的替换标题。省略则保留待处理状态的标题。 */
  title?: string
  /**
   * 面向 UI 的结果内容（harness {@link ContentBlock}），由面向模型的结果
   * 重新格式化而来。省略则让 UI 渲染原始结果内容。
   */
  content?: ContentBlock[]
}

/**
 * {@link TerminalCallView} 的完成状态：捕获的输出与退出状态。具备能力的 UI
 * 在终端卡片中渲染 `output` 并显示退出状态徽标；不具备能力的 UI 得到由
 * BRIDGE 从 `output` 派生的围栏 ```console 回退（工具不会双重编码）。
 */
export interface TerminalResultView {
  card: 'terminal'
  /** 已完成调用的替换标题。省略则保留待处理状态的标题。 */
  title?: string
  /** 捕获的命令输出（stdout+stderr，由工具决定如何合并）。 */
  output?: string
  /**
   * 进程退出码，适用于运行以退出（而非信号）结束的情况。让具备能力的 UI
   * 显示退出状态徽标。被信号杀死或未知时省略。
   */
  exitCode?: number
  /** 杀死进程的信号名（例如 `SIGTERM`）。与 `exitCode` 互斥。 */
  signal?: string
}

/**
 * 已完成的文件变更，渲染为内联差异卡片，是 {@link DiffCallView} 的结果期
 * 对应物。由于完成时的 UI 更新会替换待处理卡片内容，变更类工具即使重复
 * 调用期差异也返回它；否则原始结果文本会替换掉差异。
 */
export interface DiffResultView {
  card: 'diff'
  /** 已完成调用的替换标题。省略则保留待处理状态的标题。 */
  title?: string
  /** 要展示的变更，按文件顺序——已应用的带上下文块，或无先前镜像时的整文件差异。 */
  diffs: FileDiff[]
}

/** {@link SearchFileMatches} 组内的一条匹配行：其 1 起行号与文本。 */
export interface SearchLineMatch {
  /** 匹配在其文件内的 1 起行号。 */
  lineNumber: number
  /** 匹配行的文本，按工具呈现的形式（每行预览预算已应用）。 */
  line: string
}

/** {@link SearchMatchesResultView} 中一个文件的内容匹配组，按首次出现的文件顺序。 */
export interface SearchFileMatches {
  /** 匹配所属的文件（面向模型的展示路径）。 */
  path: string
  /** 该文件的匹配行，按输出顺序。 */
  matches: SearchLineMatch[]
}

/**
 * 已完成的内容搜索（`grep`），渲染为匹配按文件分组的搜索卡片，使具备能力的
 * UI 能将每个文件列为含其匹配行的可展开组。`shape: 'matches'` 在
 * {@link SearchResultView} 内区分此变体与路径变体
 * （{@link SearchPathsResultView}）。判别字段是 `shape` 而非 `kind`，因此
 * 永远不会与图标选择桥接层从调用视图读取的 {@link ToolCallKind} `kind`
 * 冲突。
 */
export interface SearchMatchesResultView {
  card: 'search'
  shape: 'matches'
  /** 已完成调用的替换标题。省略则保留待处理状态的标题。 */
  title?: string
  /** 按文件分组的匹配行，按首次出现的文件顺序。 */
  files: SearchFileMatches[]
  /**
   * 工具是否截断了内联结果：`files` 只携带保留的匹配，而非搜索找到的每个
   * 匹配。UI 显示截断指示器，使其永远不会把部分组当作完整组展示。
   */
  truncated: boolean
  /** 截断前搜索找到的总匹配数（未 `truncated` 时等于保留数量）。 */
  total: number
}

/**
 * 已完成的路径搜索（`glob`），渲染为结果为扁平路径列表的搜索卡片。
 * `shape: 'paths'` 在 {@link SearchResultView} 内区分此变体与分组匹配变体
 * （{@link SearchMatchesResultView}）。
 */
export interface SearchPathsResultView {
  card: 'search'
  shape: 'paths'
  /** 已完成调用的替换标题。省略则保留待处理状态的标题。 */
  title?: string
  /** 发现的路径，按工具的结果顺序（`truncated` 时为保留的页）。 */
  paths: string[]
  /**
   * 工具是否截断了内联结果：`paths` 只携带保留的页，而非搜索找到的每个
   * 路径。UI 显示截断指示器，使其永远不会把部分列表当作完整列表展示。
   */
  truncated: boolean
  /** 截断前搜索找到的总路径数（未 `truncated` 时等于 `paths.length`）。 */
  total: number
}

/**
 * 已完成的搜索，渲染为搜索卡片，是发现工具（`grep`、`glob`）从
 * `presentResult` 返回的结果期视图。一个 `card: 'search'` 视图，含两个按
 * `shape` 区分的变体：按文件分组的内容匹配（{@link SearchMatchesResultView}）
 * 与扁平路径列表（{@link SearchPathsResultView}）。两者都携带
 * `truncated`/`total` 信号，使 UI 永远不会把截断结果当作完整结果展示。
 * 该视图不携带结果文本：没有搜索卡片的 UI 回退到原始 `tool/result` 内容。
 * 没有调用期对应物：搜索调用保持为 {@link GenericCallView}
 * （`kind: 'search'`），因为待处理状态没有可显示的匹配或路径——结构化
 * 形态只在 `execute` 之后存在。
 */
export type SearchResultView = SearchMatchesResultView | SearchPathsResultView

/**
 * 已完成的文件读取，由具备能力的 UI 渲染为带行号、可选语法高亮的代码视图。
 * 由调用读取文件文本的工具设置（例如 `read`）；待处理状态保持为
 * {@link GenericCallView}（`kind: 'read'`），因为调用在 `execute` 返回前
 * 不携带内容。结构化的 `lines`/`path`/`lang`/`totalLines` 字段无法仅从
 * 面向模型的结果文本重建，因此读取工具通过其 `output.presentationMeta`
 * （随 session 日志持久化）投影它们，`presentResult` 在实时与重放路径上
 * 都把该元数据收窄回此视图。不具备读取能力的 UI 回退到 `content`（去除了
 * 信封的面向模型文本），因此该视图退化为通用文本卡片。
 */
export interface ReadResultView {
  card: 'read'
  /** 已完成调用的替换标题。省略则保留待处理状态的标题。 */
  title?: string
  /** 读取文件的路径（面向模型的路径；桥接层将其相对化）。 */
  path: string
  /**
   * 窗口请求的首行（1 起），即使 `lines` 为空也保留（字节上限低于首个选中
   * 行时得到空窗口），使 UI 知道窗口从哪里开始、续读从哪里恢复。
   */
  offset: number
  /** 返回窗口的行，按文件顺序，每行保留其文件行号。 */
  lines: ReadFileLine[]
  /** 文件的确切总行数，使 UI 能显示"显示 N/M"的提示。 */
  totalLines: number
  /**
   * 从文件扩展名派生的语法高亮语言提示（例如 `ts`、`py`）；扩展名不映射到
   * 任何已知语言时省略，使 UI 将各行渲染为纯文本。
   */
  lang?: string
  /**
   * 去除信封后的面向模型结果内容，供不具备读取能力的 UI 使用。省略则让
   * 这类 UI 渲染原始结果内容。
   */
  content?: ContentBlock[]
}

/**
 * 已完成 {@link WebSearchResultView} 中一个可引用的来源，是单个网页搜索来源
 * 的忠实投影。`dsh-web` 的 `WebSearchSource` 的展示投影：那个服务定义类型
 * 是权威的（core 不能依赖 web 服务定义，因此两者分开声明且必须同步演化）。
 * 网页工具通过 `output.presentationMeta` 投影此形态，因为渲染文本无法无损
 * 承载它（见 web-result-card Agent Note）；其 `presentResult` 读回它。
 */
export interface WebSource {
  /** 来源 URL。 */
  url: string
  /** 来源标题，当提供方返回了标题时。 */
  title?: string
  /** 简短摘录或摘要，当提供方返回了摘要时。 */
  snippet?: string
  /** 发布/抓取时间戳，提供方提供的 ISO-8601 字符串，存在时填写。 */
  publishedAt?: string
}

/**
 * 已完成的网页检索，由具备能力的 UI 渲染为结构化卡片。由从网络检索的网页
 * 工具设置（`web_search`、`web_fetch`）。一个 `kind` 标签联合类型承载两种
 * 形态，因为两者都是网页检索，UI 用同一组件族渲染它们；UI 按 `kind`
 * 分派。不具备能力的 UI 回退到原始 `tool/result` 内容（此视图不携带
 * `content` 副本——见 web-result-card Agent Note）。这是
 * `web_search`/`web_fetch` 调用的通用调用视图（`kind: 'search'`/`'fetch'`）
 * 的结果期对应物；这些工具保留其通用待处理卡片，只添加此完成卡片。
 *
 * 这里的 `kind` 字段是此联合类型自身的判别字段，不是
 * {@link ToolCallKind}：两个值刻意与工具的待处理 `ToolCallKind`
 * （`'search'`/`'fetch'`）一致，使调用与其结果读起来属同一类别，但新增
 * 分支是联合类型修改加一个消费方分支，而不是任意的 `ToolCallKind` 值。
 */
export type WebResultView = WebSearchResultView | WebFetchResultView

/**
 * `web_search` 调用的完成状态：模型引用的结构化来源、可选的提供方答案，
 * 以及来源列表是否被裁剪到结果上限。具备能力的 UI 将来源渲染为引用列表；
 * 不具备 `web` 能力的 UI 回退到原始 `tool/result` 内容。
 */
export interface WebSearchResultView {
  card: 'web'
  kind: 'search'
  /** 已完成调用的替换标题。省略则保留待处理状态的标题。 */
  title?: string
  /** 忠实的结构化来源——渲染文本无法无损承载的字段。 */
  sources: WebSource[]
  /** 提供方生成的答案文本，若有。 */
  answer?: string
  /** 网页服务为遵守结果上限而裁剪来源列表时为真。 */
  truncated: boolean
}

/**
 * `web_fetch` 调用的完成状态：抓取的 URL、其 HTTP 状态，以及内容是否被
 * 裁剪。正文在原始 `tool/result` 内容中已是 markdown，因此此卡片只承载
 * 检索摘要，不具备 `web` 能力的 UI 回退到该内容。
 */
export interface WebFetchResultView {
  card: 'web'
  kind: 'fetch'
  /** 已完成调用的替换标题。省略则保留待处理状态的标题。 */
  title?: string
  /** 允许的重定向之后的最终 URL。 */
  url: string
  /** 抓取响应的 HTTP 状态码。 */
  statusCode: number
  /**
   * 当提供方截断了已解码正文，或输出上限或转换前的来源裁剪削减了渲染文本
   * 时为真（面向模型文本反映的也是这一有效截断）。
   */
  truncated: boolean
}
