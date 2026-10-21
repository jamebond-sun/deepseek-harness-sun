/**
 * LSP 能力接缝的词汇表：规范化的请求、provider 与结果契约。仅含类型——{@link LspError} 的
 * 错误分类与 {@link LspProviderId} 的品牌工厂是运行时代码，位于 `index.ts`。位置与区间为
 * 从零开始的 UTF-16，与协议一致；面向模型的工具负责从 1 开始的光标约定。本接缝不暴露协议
 * 类型、进程或文档控制，也不提供通用 JSON-RPC 逃逸口——只有那四个语义操作。
 * @module @deepseek-ai/dsh-lsp/types
 */

import type { LspProviderId } from './brand.ts'

/**
 * 接缝与模型暴露的四个语义查询。一个封闭联合：新增操作会在接缝、各 provider 与工具之间
 * 形成编译期强制的变更。符号与调用层级不是这里的操作；它们需要不同的 schema。
 */
export type LspOperation = 'goToDefinition' | 'findReferences' | 'goToImplementation' | 'hover'

/** 线上约定中与 LSP 一致的、从零开始的 UTF-16 光标坐标。 */
export interface LspPosition {
  /** 从零开始的行号。 */
  readonly line: number
  /** 行内从零开始的 UTF-16 码元偏移。 */
  readonly character: number
}

/** 从零开始的 UTF-16 半开区间 `[start, end)`。 */
export interface LspRange {
  readonly start: LspPosition
  readonly end: LspPosition
}

/**
 * 调用方的规范化查询。每个字段都是必填的：`workspaceRoot` 由调用方提供，`languageId`
 * 来自 provider 注册（不在此处），而消费者自己负责超时与结果上限——因此没有字段需要
 * 实现层默认值，也不存在 `resolve()` 步骤。
 */
export interface LspQueryRequest {
  /** 要执行的语义查询。 */
  readonly operation: LspOperation
  /** 要查询的源文件（相对于 `workspaceRoot` 或绝对路径；由 provider 规范化）。 */
  readonly filePath: string
  /** 要查询的从零开始的 UTF-16 光标位置。 */
  readonly position: LspPosition
  /** provider 据以解析并建立索引的工作区根目录；必填，绝不做默认化。 */
  readonly workspaceRoot: string
}

/**
 * provider 收到的请求：调用方的 {@link LspQueryRequest} 加上接缝从 provider 的扩展名映射
 * 推导出的 `languageId`。该语言 id 只用于同步临时文档，不参与选择。
 */
export interface LspProviderQuery extends LspQueryRequest {
  /** `filePath` 对应的 LSP 语言 id，来自本 provider 的扩展名映射。 */
  readonly languageId: string
}

/** 一个已解析的位置：文档 URI 及其中的区间。 */
export interface LspLocation {
  /** 目标文档 URI（`file:` 或其他），原样来自服务端。 */
  readonly uri: string
  /** 目标文档中的区间。 */
  readonly range: LspRange
}

/** 规范化的悬停内容；该位置上没有悬停信息时为 `null`。 */
export interface LspHover {
  /** 规范化的悬停文本（markdown 或纯文本，由 provider 拼接）。 */
  readonly contents: string
  /** 悬停适用的区间，当服务端提供了该字段时。 */
  readonly range?: LspRange
}

/**
 * 封闭的结果联合。导航类操作（`goToDefinition`、`findReferences`、`goToImplementation`）
 * 归一为 `locations`；`hover` 归一为内容或 `null`。消费者对 `kind` 做穷尽的 `switch`，
 * 因此新增分支会在被处理之前就破坏编译。
 *
 * `locations` 分支携带 `resolvedWorkspaceUri`：provider 为请求的工作区根目录给出的规范
 * `file:` URI。调用方若要相对化位置 URI，必须使用它，而不能用宿主平台规则去解析请求中
 * 可能被符号链接化的进程路径；执行平台可能与调用方不同。
 */
export type LspQueryResult =
  | { readonly kind: 'locations'; readonly locations: readonly LspLocation[]; readonly resolvedWorkspaceUri: string }
  | { readonly kind: 'hover'; readonly hover: LspHover | null }

/**
 * 注册在 `ctx.lsp` 上的语言服务端后端。每个 provider 拥有一个稳定的 {@link
 * LspProviderId} 和一份扩展名到语言 id 的映射（小写、带前导点的键）。
 * `findReferences` 总是包含声明——provider 在内部强制执行这一点；调用方拿不到开关。
 */
export interface LspProvider {
  /** 稳定的 provider 身份，与扩展名映射一起被原子地预留。 */
  readonly id: LspProviderId
  /** 小写的带前导点扩展名 → LSP 语言 id（例如 `{ '.ts': 'typescript' }`）。 */
  readonly extensionToLanguage: Readonly<Record<string, string>>
  /**
   * 执行一次查询。接缝已完成本 provider 的选择并推导出 `languageId`。
   * @param request - 已解析的 provider 查询（调用方请求 + 推导出的语言 id）。
   * @param signal - 可选的取消信号；中止时 provider 自行停止其工作。
   * @returns 规范化的封闭联合结果。
   */
  query(request: LspProviderQuery, signal?: AbortSignal): Promise<LspQueryResult>
}

/**
 * LSP 能力接缝（`ctx.lsp`）。负责 provider 的注册/选择与规范化查询的执行；
 * 恰好暴露那四个操作，不提供协议逃逸口。
 */
export interface LspService {
  /**
   * 注册一个 provider，原子地预留其 id 和每一个规范化扩展名。任何冲突或非法输入都不会
   * 发布任何内容，并抛出 `LspError`；返回的 disposer 会释放全部预留。随调用方 fiber 一同销毁。
   * @param provider - 要注册的后端。
   * @returns 同步的 disposer，释放 id 与全部扩展名预留。
   */
  registerProvider(provider: LspProvider): () => void
  /**
   * 按文件扩展名选择 provider 并执行一次查询。选择是逐次查询的，与注册顺序无关；
   * 没有匹配项则抛出 `LspError` `LSP_UNAVAILABLE`。
   * @param request - 规范化的查询。
   * @param signal - 可选的取消信号，转发给被选中的 provider。
   * @returns 规范化的封闭联合结果。
   */
  query(request: LspQueryRequest, signal?: AbortSignal): Promise<LspQueryResult>
}
