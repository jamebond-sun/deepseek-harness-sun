/**
 * 本地宿主的纯协议转换：服务端能力允许什么，以及它的 `Location`/`LocationLink`/`Hover`
 * 负载如何归一化为接缝的封闭结果联合。无 I/O 也无进程状态——这里的每个函数都是纯变换，
 * fake-stdio 测试会精确地钉住它们。
 * @module @deepseek-ai/dsh-lsp-stdio/translate
 */

import type {
  LspHover,
  LspLocation,
  LspOperation,
  LspRange,
} from '@deepseek-ai/dsh-lsp'
import { LspError } from '@deepseek-ai/dsh-lsp'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type {
  WireHover,
  WireLocation,
  WireLocationLink,
  WireMarkedString,
  WireProviderCapability,
  WireRange,
  WireServerCapabilities,
  WireTextDocumentSyncKind,
} from './protocol.ts'

/**
 * 每个 LSP 操作对应的 `textDocument/*` 请求方法。
 * @param operation - 要映射的 LSP 操作。
 * @returns LSP 请求方法名。
 */
export function requestMethod(operation: LspOperation): string {
  switch (operation) {
    case 'goToDefinition': return 'textDocument/definition'
    case 'findReferences': return 'textDocument/references'
    case 'goToImplementation': return 'textDocument/implementation'
    case 'hover': return 'textDocument/hover'
    /* v8 ignore next -- 对封闭的 LspOperation 联合穷尽；不可达。 */
    default: return assertNever(operation, 'requestMethod')
  }
}

/** 支撑每个操作的 `ServerCapabilities` provider 字段。 */
function capabilityValue(capabilities: WireServerCapabilities, operation: LspOperation): WireProviderCapability {
  switch (operation) {
    case 'goToDefinition': return capabilities.definitionProvider
    case 'findReferences': return capabilities.referencesProvider
    case 'goToImplementation': return capabilities.implementationProvider
    case 'hover': return capabilities.hoverProvider
    /* v8 ignore next -- 对封闭的 LspOperation 联合穷尽；不可达。 */
    default: return assertNever(operation, 'capabilityValue')
  }
}

/** 当服务端发送 `true` 或选项对象（而非 `false`/缺省）时，认为该 provider 能力存在。 */
function supportsCapability(value: WireProviderCapability): boolean {
  if (value === undefined) return false
  if (typeof value === 'boolean') return value
  return true
}

/**
 * 服务端是否声明了所请求的操作。
 * @param capabilities - 服务端 `initialize` 返回的能力。
 * @param operation - 要检查的 LSP 操作。
 * @returns 对应的 provider 能力存在时为 true。
 */
export function supportsOperation(capabilities: WireServerCapabilities, operation: LspOperation): boolean {
  return supportsCapability(capabilityValue(capabilities, operation))
}

/**
 * 某个 `textDocumentSync` 取值是否允许本宿主依赖的临时 `didOpen`/`didClose`。
 * 旧式枚举形态对 `Full`/`Incremental` 隐含支持 open/close；选项形态则要求显式的
 * `openClose: true`，因为协议把缺省的 `openClose` 视为 false。
 * @param sync - 服务端声明的 `textDocumentSync` 能力。
 * @returns 支持临时 open/close 时为 true。
 */
export function supportsTransientOpen(sync: WireServerCapabilities['textDocumentSync']): boolean {
  if (sync === undefined) return false
  if (typeof sync === 'number') return isOpenCloseKind(sync)
  return sync.openClose === true
}

/** 旧式枚举：`Full`（1）或 `Incremental`（2）隐含 open/close 支持；`None`（0）不支持。 */
function isOpenCloseKind(kind: WireTextDocumentSyncKind): boolean {
  return kind === 1 || kind === 2
}

/**
 * 归一化协商出的位置编码。省略编码时默认为 `utf-16`；任何其他取值都是本宿主
 * 不支持的协议错误。
 * @param encoding - 服务端声明的 `positionEncoding`（若有）。
 * @returns 字符串 `'utf-16'`。
 * @throws Error 对任何非 `utf-16` 的编码。
 */
export function negotiatePositionEncoding(encoding: string | undefined): 'utf-16' {
  if (encoding === undefined || encoding === 'utf-16') return 'utf-16'
  throw new Error(`server negotiated unsupported position encoding "${encoding}"; this host requires utf-16`)
}

/** 把线上区间转换为接缝的区间（结构完全相同，只是重新整形为 `readonly`）。 */
function toRange(range: WireRange): LspRange {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  }
}

/** 判断一个记录是否是 `LocationLink`（有 `targetUri` + `targetSelectionRange`）。 */
function isLocationLink(value: Record<string, unknown>): boolean {
  return typeof value.targetUri === 'string' && isRange(value.targetSelectionRange)
}

/** 判断一个记录是否是 `Location`（有字符串 `uri` + 一个区间）。 */
function isLocation(value: Record<string, unknown>): boolean {
  return typeof value.uri === 'string' && isRange(value.range)
}

/** 两种位置形态共用的结构化区间守卫。 */
function isRange(value: unknown): value is WireRange {
  if (value === null || typeof value !== 'object') return false
  const range = value as Record<string, unknown>
  return isPosition(range.start) && isPosition(range.end)
}

/** 结构化位置守卫。 */
function isPosition(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const position = value as Record<string, unknown>
  return isProtocolCoordinate(position.line) && isProtocolCoordinate(position.character)
}

/** 判断一个线上坐标是否是合法的非负整数。 */
function isProtocolCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/**
 * 把一个导航结果（`Location`、`Location[]`、`LocationLink[]` 或 `null`）归一化为接缝的
 * locations。`Location` 直接映射；`LocationLink` 映射 `targetUri` + `targetSelectionRange`。
 * @param payload - 原始的 `textDocument/definition|references|implementation` 结果。
 * @returns 归一化后的位置（`null`/`[]` 时为空数组）。
 * @throws Error 当某个元素既不是 `Location` 也不是 `LocationLink` 时。
 */
export function normalizeLocations(payload: unknown): LspLocation[] {
  if (payload === null) return []
  if (payload === undefined) throw malformedResponse('LSP navigation result was missing')
  const elements = Array.isArray(payload) ? payload : [payload]
  const locations: LspLocation[] = []
  for (const element of elements) {
    if (element === null || typeof element !== 'object') {
      throw malformedResponse('LSP navigation result contained a non-object entry')
    }
    const record = element as Record<string, unknown>
    if (isLocationLink(record)) {
      const link = record as unknown as WireLocationLink
      locations.push({ uri: link.targetUri, range: toRange(link.targetSelectionRange) })
    } else if (isLocation(record)) {
      const location = record as unknown as WireLocation
      locations.push({ uri: location.uri, range: toRange(location.range) })
    } else {
      throw malformedResponse('LSP navigation result contained neither a Location nor a LocationLink')
    }
  }
  return locations
}

/** 渲染一个 `MarkedString`（字符串形态原样；对象形态渲染为带语言标签的围栏代码块）。 */
function renderMarkedString(value: WireMarkedString): string {
  if (typeof value === 'string') return value
  return `\`\`\`${value.language}\n${value.value}\n\`\`\``
}

/**
 * 把一个 `Hover`（或 `null`）归一化为接缝的 hover。`MarkupContent` 取它的 `value`；
 * 字符串 `MarkedString` 原样使用；带语言标签的 `MarkedString` 变成围栏代码块；
 * 数组则用一个空行连接其各个渲染片段。面向模型的工具负责完整结果上限。
 * @param payload - 原始的 `textDocument/hover` 结果。
 * @returns 归一化的 hover，没有内容时为 `null`。
 * @throws Error 当负载是非 null 的非对象，或结构上非法的 hover 时。
 */
export function normalizeHover(payload: unknown): LspHover | null {
  if (payload === null) return null
  if (payload === undefined) throw malformedResponse('LSP hover result was missing')
  if (typeof payload !== 'object') throw malformedResponse('LSP hover result was not an object')
  const hover = payload as WireHover
  const contents = renderHoverContents(hover.contents)
  if (contents === '') return null
  const range = hover.range
  if (range === undefined) return { contents }
  if (!isRange(range)) throw malformedResponse('LSP hover result contained a malformed range')
  return { contents, range: toRange(range) }
}

/** 把三种 `Hover.contents` 编码渲染成一个字符串（输入是不可信的线上数据）。 */
function renderHoverContents(contents: unknown): string {
  if (contents === null || contents === undefined) {
    throw malformedResponse('LSP hover result had no contents')
  }
  if (typeof contents === 'string') return contents
  if (Array.isArray(contents)) {
    return contents.map((value) => {
      if (isMarkedString(value)) return renderMarkedString(value)
      throw malformedResponse('LSP hover contents contained a malformed MarkedString')
    }).join('\n\n')
  }
  if (typeof contents !== 'object') {
    throw malformedResponse('LSP hover contents were not MarkupContent, MarkedString, or an array')
  }
  const record = contents as Record<string, unknown>
  if (record.kind === 'markdown' || record.kind === 'plaintext') {
    if (typeof record.value !== 'string') {
      throw malformedResponse('LSP hover MarkupContent value was not a string')
    }
    return record.value
  }
  if (typeof record.language === 'string' && typeof record.value === 'string') {
    return renderMarkedString({ language: record.language, value: record.value })
  }
  throw malformedResponse('LSP hover contents were not MarkupContent, MarkedString, or an array')
}

/** 判断一个不可信的值是否是 `MarkedString` 的两种形态之一。 */
function isMarkedString(value: unknown): value is WireMarkedString {
  if (typeof value === 'string') return true
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.language === 'string' && typeof record.value === 'string'
}

/** 为畸形的服务端结果负载创建稳定的结构化错误。 */
function malformedResponse(message: string): LspError {
  return new LspError(message, 'LSP_MALFORMED_RESPONSE')
}
