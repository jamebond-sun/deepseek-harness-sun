/**
 * 这个通用宿主读写所涉及的 LSP 线上类型子集：initialize 能力，四个请求结果
 * （`Location`、`LocationLink`、`Hover`），以及用于判定是否支持临时打开的
 * `textDocumentSync` 形态。仅含类型。真实服务端负载中缺失的字段保持可选；
 * 转换层会把它们归一化进接缝的封闭联合。
 * @module @deepseek-ai/dsh-lsp-stdio/protocol
 */

/** 线上的从零开始 UTF-16 位置（协议的 `Position`）。 */
export interface WirePosition {
  readonly line: number
  readonly character: number
}

/** 线上区间（`Range`）。 */
export interface WireRange {
  readonly start: WirePosition
  readonly end: WirePosition
}

/** `Location`：文档 URI 加一个区间。 */
export interface WireLocation {
  readonly uri: string
  readonly range: WireRange
}

/** `LocationLink`：目标 uri 加要聚焦的选择区间。 */
export interface WireLocationLink {
  readonly targetUri: string
  readonly targetSelectionRange: WireRange
  readonly targetRange?: WireRange
}

/** `MarkupContent` 悬停正文（`markdown` 或 `plaintext`）。 */
export interface WireMarkupContent {
  readonly kind: 'markdown' | 'plaintext'
  readonly value: string
}

/** `MarkedString` 的对象形态（`{ language, value }`）；字符串形态就是一个裸 `string`。 */
export interface WireMarkedStringObject {
  readonly language: string
  readonly value: string
}

/** 一个 `MarkedString`：原始字符串或带语言标签的代码块。 */
export type WireMarkedString = string | WireMarkedStringObject

/** `Hover`：contents 可为协议三种编码中的任意一种，外加一个可选区间。 */
export interface WireHover {
  readonly contents: WireMarkupContent | WireMarkedString | readonly WireMarkedString[]
  readonly range?: WireRange
}

/** `textDocumentSync` 的旧式枚举形态（`0` None、`1` Full、`2` Incremental）。 */
export type WireTextDocumentSyncKind = 0 | 1 | 2

/** `textDocumentSync` 的选项形态（`{ openClose, change }`）。 */
export interface WireTextDocumentSyncOptions {
  readonly openClose?: boolean
  readonly change?: WireTextDocumentSyncKind
}

/** `ServerCapabilities.provider` 槽位：布尔值或选项对象（两者都表示“支持”）。 */
export type WireProviderCapability = boolean | Record<string, unknown> | undefined

/** 本宿主会检查的 `ServerCapabilities` 字段。 */
export interface WireServerCapabilities {
  readonly positionEncoding?: string
  readonly textDocumentSync?: WireTextDocumentSyncKind | WireTextDocumentSyncOptions
  readonly definitionProvider?: WireProviderCapability
  readonly referencesProvider?: WireProviderCapability
  readonly implementationProvider?: WireProviderCapability
  readonly hoverProvider?: WireProviderCapability
}

/** `initialize` 结果的信封。 */
export interface WireInitializeResult {
  readonly capabilities: WireServerCapabilities
}
