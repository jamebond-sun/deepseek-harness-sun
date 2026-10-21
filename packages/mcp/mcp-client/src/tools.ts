/**
 * 工具桥接：发现 MCP 工具，把它们以确定性的、服务端限定的公开名注册到 harness
 * 的 ToolRuntime 上，并在服务端的工具列表变化时处理重新同步。
 *
 * 命名约定（见 mcp-client 的 Agent Note「Naming invariants」）：每个 MCP 工具
 * 都有稳定身份 `(serverName, rawName)`；模型可见的公开名是
 * `mcp__<serverName>__<rawName>`，并按 DeepSeek 函数名约束归一化。只有原始名会
 * 出现在线路上（`tools/call`）；公开名从不被反解以还原原始名。
 *
 * @module
 */

import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { specTypeSchemas, type Client, type ImageContent } from '@modelcontextprotocol/client'
import type { Context } from '@deepseek-ai/cordis'
import { isImageAdmissionError } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageAttachmentRef, ImageMediaType, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** 与工具桥接相关的、已解析的选项。 */
export interface ToolBridgeOptions {
  /** 注册表冲突是被包容，还是让本次同步失败。 */
  registrationFailure: 'contain' | 'throw'
  serverName: string
  toolCallTimeoutMs: number
}

/** 一个同步世代的状态：按公开名索引的当前 disposer 集合。 */
export type ToolDisposers = Map<string, () => void>

/** 暴露给 PTC 模式的规范化 MCP 结果，且不丢弃协议块。 */
export type McpResult<Structured extends JsonValue = JsonValue> = {
  content: JsonValue[]
  structuredContent?: Structured
}

/**
 * DeepSeek 函数名约定：最长 64 个字符。属于线路协议常量，不是配置项。
 */
const MAX_PUBLIC_NAME_LENGTH = 64

/** DeepSeek 函数名约定：只允许 `[A-Za-z0-9_-]`。 */
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g

/** 发生有损归一化时，追加在末尾的身份 SHA-256 哈希的十六进制字符数。 */
const HASH_LENGTH = 12

/** 持久化附件 vocabulary 所支持的位图格式。 */
const IMAGE_MEDIA_TYPES: readonly ImageMediaType[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]

/** 规范的 RFC 4648 base64，不含空白字符与 URL-safe 变体。 */
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/**
 * 推导单个 MCP 工具的模型可见公开名。
 *
 * 关于 `(serverName, rawName)` 的确定性纯函数：理想情况就是原样输出的
 * `mcp__<serverName>__<rawName>`。当字符替换或按 DeepSeek 函数名约定
 * （64 字符、`[A-Za-z0-9_-]`）截断改变了名字时，会追加身份的 12 位十六进制
 * SHA-256 哈希，使不同的 MCP 身份永不坍缩为同一个公开名。
 *
 * @param serverName - 来自插件配置的稳定本地命名空间。
 * @param rawName - MCP 服务端自己的工具名。
 * @returns 全局唯一的、模型可见的 ToolRuntime 名称。
 */
export function publicToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}

/**
 * 把 MCP 服务端的工具列表同步进 harness 的 ToolRuntime。
 *
 * 两个阶段让切换保持安全：
 *
 * 1. 抓取：由 SDK 聚合 `tools/list`，并以公开名构建完整的下一代
 *    `ToolDefinition`。此处任何失败（网络错误或重复的原始名）都会 reject，
 *    并保持上一代注册原封不动。
 * 2. 切换：销毁上一代，注册新一代。此处出现注册表冲突，只可能是外部注册占用了
 *    本服务端的 `mcp__<serverName>__` 命名空间——部分世代会被回滚（本服务端
 *    零个工具）并记录日志。初始的严格同步可以把冲突向上传播，让其所属事务被
 *    拒绝；普通客户端与后续的重新同步则返回空 map。
 *
 * @param client - 已连接的 MCP Client 实例，用于列出并调用工具。
 * @param ctx - 提供 `tools` 服务用于注册的 Cordis 上下文。
 * @param opts - 桥接选项：服务端命名空间与单次调用超时。
 * @param previous - 上一个同步世代的 disposer map；在切换阶段被销毁
 *   （且仅在抓取阶段成功之后）。
 * @returns 已注册的公开工具名到其注销 disposer 的映射——即本服务端持有的
 *   在线注册的精确集合。
 */
export async function syncTools(
  client: Client,
  ctx: Context,
  opts: ToolBridgeOptions,
  previous: ToolDisposers,
): Promise<ToolDisposers> {
  // 阶段 1：在不触碰注册表的前提下抓取并构建下一代。
  const definitions = new Map<string, ToolDefinition>()
  const response = client.getServerCapabilities()?.tools === undefined
    ? { tools: [] }
    : await client.listTools(undefined, { cacheMode: 'refresh' })
  for (const tool of response.tools) {
    const publicName = publicToolName(opts.serverName, tool.name)
    if (definitions.has(publicName)) {
      throw new Error(
        `mcp-client(${opts.serverName}): server listed tool "${tool.name}" more than once — invalid tool list`,
      )
    }
    definitions.set(publicName, createMcpToolDefinition(ctx, {
      name: publicName,
      rawName: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      taskRequired: tool.execution?.taskSupport === 'required',
      call: (args, execution) => client.callTool(
        { name: tool.name, arguments: args },
        { signal: execution.signal, timeout: opts.toolCallTimeoutMs, toolDefinition: tool },
      ),
    }))
  }

  // 阶段 2：切换世代。
  for (const dispose of previous.values()) dispose()
  const disposers: ToolDisposers = new Map()
  try {
    for (const [publicName, definition] of definitions) {
      disposers.set(publicName, ctx.tools.register(definition))
    }
  } catch (error) {
    // `mcp__<serverName>__` 限定名上的冲突，意味着有外部注册占用了本服务端的
    // 命名空间。回滚，使模型看到的要么是完整的一代，要么一个都没有——绝不
    // 是部分集合。
    for (const dispose of disposers.values()) dispose()
    ctx.logger.error(`mcp-client(${opts.serverName}): tool registration failed, no tools registered: ${String(error)}`)
    if (opts.registrationFailure === 'throw') throw error
    return new Map()
  }
  return disposers
}

/** 从规范化内容中读取的字段，包含由策略负责的值替换。 */
interface McpContentBlock {
  type: string
  text?: string
  mimeType?: string
  data?: string
  name?: string
  uri?: string
}

/** 为一次确切的 ToolRuntime 执行预备好的异步富投影。 */
interface PreparedProjection {
  /** execute 在注册表物化之前返回的规范化 MCP 值。 */
  value: McpResult
  /** 最终确定之前应有的、同步的 output.render 投影。 */
  fallback: ContentBlock[]
  /** 在 execute 期间预备好的、已富集图片或显式拒绝的投影。 */
  content: ContentBlock[]
}

/** 保留受支持的已声明 schema；不受支持的 MCP 词汇回退为 JsonValue。 */
function supportedOutputSchema(candidate: unknown): JsonSchemaNode | undefined {
  if (candidate === undefined) return undefined
  try {
    assertSupportedJsonSchema(candidate)
    return candidate
  } catch {
    return undefined
  }
}

/** 一个上游 MCP 工具，以及获取其原始协议结果的回调。 */
export interface McpToolDefinitionOptions {
  /** 呈现给模型的 ToolRuntime 名称。 */
  name: string
  /** 用于结果诊断的上游名称。 */
  rawName: string
  /** 上游面向模型的描述。 */
  description: string
  /** 上游 JSON 输入 schema。 */
  inputSchema: Record<string, unknown>
  /** 已声明的结构化输出 schema（若存在）。 */
  outputSchema?: unknown
  /** 上游工具是否要求本桥接不支持的 task 执行扩展。 */
  taskRequired?: boolean
  /**
   * 从提供方获取一个原始 MCP 结果。
   * @param args - 经 ToolRuntime 准入的模型参数。
   * @param execution - 确切的 ToolRuntime 调用，包含其 Agent 与取消信号。
   * @returns 外部结果对象，在内容投影之前完成校验。
   */
  call(args: Record<string, unknown>, execution: ToolExecution): Promise<unknown>
}

/**
 * 把上游 MCP 工具适配为规范化取值与持久化图片内容。
 * 注册、提供方生命周期、截止时间与传输都由调用方负责。
 * @param ctx - 携带可选附件与模型服务的插件上下文。
 * @param options - 上游工具字段及其原始结果回调。
 * @returns 未注册的 ToolRuntime 定义。
 */
export function createMcpToolDefinition(
  ctx: Context,
  options: McpToolDefinitionOptions,
): ToolDefinition {
  const { name, rawName, description, inputSchema } = options
  const projections = new WeakMap<ToolExecution, PreparedProjection>()
  return {
    name,
    description,
    parameters: inputSchema,
    output: createOutput(rawName, supportedOutputSchema(options.outputSchema)),
    execute: createExecutor(ctx, options, projections),
    projectContent(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) {
      const projection = projections.get(exec)
      if (projection === undefined) return undefined
      projections.delete(exec)
      if (result.isError) return undefined
      if (!isDeepStrictEqual(result.value, projection.value)) return undefined
      if (!isDeepStrictEqual(result.content, projection.fallback)) return undefined
      return projection.content
    },
  }
}

/** 构建规范化结果 schema 以及既有的 Native 文本投影。 */
function createOutput(rawName: string, structuredSchema: JsonSchemaNode | undefined): ToolDefinition['output'] {
  return {
    schema: {
      type: 'object',
      properties: {
        content: { type: 'array', items: {} },
        structuredContent: structuredSchema ?? {},
      },
      required: structuredSchema === undefined ? ['content'] : ['content', 'structuredContent'],
      additionalProperties: false,
    },
    render(_args: unknown, value: JsonValue) {
      const result = value as McpResult
      return [{ type: 'text', text: extractText(result.content, rawName) }]
    },
  }
}

/**
 * 调用由调用方持有的原始结果回调，并预备规范化内容。
 * MCP 的 isError 结果会在图片存储之前 reject，以便 ToolRuntime 记录失败。
 */
function createExecutor(
  ctx: Context,
  options: McpToolDefinitionOptions,
  projections: WeakMap<ToolExecution, PreparedProjection>,
): ToolDefinition['execute'] {
  const { rawName, taskRequired } = options
  return async (args: unknown, exec: ToolExecution) => {
    if (taskRequired) {
      throw new Error(`Tool "${rawName}" requires task-based execution, which this bridge does not support`)
    }
    // agent loop 传入的是 `JSON.parse(model_arguments)`，通常是对象；但如果模型
    // 行为异常（输出裸的字符串/数字/null），它可以是任意 JSON 值。回退为 {}
    // 能让 MCP 服务端给出具体的「缺少必填参数」错误，供模型从中学习。
    const argsObj = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
    const parsed = specTypeSchemas.CallToolResult['~standard'].validate(await options.call(argsObj, exec))
    if (parsed.issues !== undefined) {
      throw new Error(`Tool "${rawName}" returned an invalid MCP result: ${parsed.issues.map(issue => issue.message).join('; ')}`)
    }
    const result = parsed.value

    const content = result.content as unknown as JsonValue[]
    const text = extractText(content, rawName)

    // MCP isError → 抛错，使 ToolRuntime 为模型产出 isError 结果。
    if (result.isError === true) {
      throw new Error(text)
    }

    const value: McpResult = {
      content,
      ...result.structuredContent !== undefined
        ? { structuredContent: result.structuredContent as JsonValue }
        : {},
    }
    if (containsImage(content)) {
      const fallback: ContentBlock[] = [{ type: 'text', text: extractText(content, rawName) }]
      const projected = await prepareImageProjection(ctx, exec, content, rawName)
      projections.set(exec, { value, fallback, content: projected })
    }
    return value
  }
}

/** 一个不可信的 MCP 内容数组是否包含已声明的图片块。 */
function containsImage(content: JsonValue[]): boolean {
  return content.some(value => isRecord(value) && value.type === 'image')
}

/** 把一个 JSON 值窄化为字符串键对象。 */
function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 把已声明的 MIME 字符串窄化为持久化图片 vocabulary。 */
function isImageMediaType(value: string): value is ImageMediaType {
  return IMAGE_MEDIA_TYPES.includes(value as ImageMediaType)
}

/** 解码一张待投影的图片，不接受 base64 变体。 */
function decodeImage(block: ImageContent): SaveImageAttachment {
  if (!isImageMediaType(block.mimeType)) {
    throw new Error('the declared media type is not PNG, JPEG, WebP, or GIF')
  }
  if (!CANONICAL_BASE64.test(block.data)) {
    throw new Error('the image data is not canonical base64')
  }
  const data = Buffer.from(block.data, 'base64')
  if (data.toString('base64') !== block.data) {
    throw new Error('the image data is not canonical base64')
  }
  return { data, mediaType: block.mimeType }
}

/**
 * 为携带图片的结果解析当前生效的模型路由与持久化存储。
 * @param ctx - 带有可选服务的插件上下文。
 * @param exec - 确切的工具执行，其 agent 提供最新的路由。
 * @returns 在确切证得图片能力为正之后的附件存储。
 */
async function resolveImageAdmission(ctx: Context, exec: ToolExecution): Promise<AttachmentStore> {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) throw new Error('no attachment store is mounted')
  const routed = exec.agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? exec.agent?.options.provider
  const model = routed?.model ?? exec.agent?.options.model
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) {
    throw new Error('the current model route could not be resolved')
  }
  let info: Awaited<ReturnType<typeof llm.resolveModelInfo>>
  try {
    info = await llm.resolveModelInfo(provider, model, exec.signal)
  } catch {
    throw new Error('the current model route could not be verified')
  }
  if (info.inputModalities === undefined || !info.inputModalities.includes('image')) {
    throw new Error(`model "${model}" does not declare image input`)
  }
  if (exec.signal.aborted) throw new Error('the tool call was canceled before image storage')
  return attachments
}

/** 为未被准入的图片块生成稳定的诊断文本。 */
function imageDiagnostic(block: McpContentBlock, reason: string): string {
  const mediaType = block.mimeType ?? 'unknown media type'
  return `[image unavailable: ${mediaType}; ${reason}; raw image data remains available to programmatic callers]`
}

/**
 * 解码、预检并持久化保存一个 MCP 结果中按序排列的图片批次。
 * 任何拒绝都会把每张图片投影为文本，同时为程序化调用方保留规范化的原始值。
 */
async function prepareImageProjection(
  ctx: Context,
  exec: ToolExecution,
  content: JsonValue[],
  toolName: string,
): Promise<ContentBlock[]> {
  const decoded: SaveImageAttachment[] = []
  const validationErrors = new Map<number, string>()
  const imageIndexes: number[] = []
  for (const [index, value] of content.entries()) {
    if (!isRecord(value) || value.type !== 'image') continue
    imageIndexes.push(index)
    try {
      decoded.push(decodeImage(value as unknown as ImageContent))
    } catch (error: unknown) {
      // decodeImage 拥有上面的每一处 throw，且始终产生 Error。
      validationErrors.set(index, (error as Error).message)
    }
  }
  if (validationErrors.size > 0) {
    return projectContent(content, toolName, (block, index) => ({
      type: 'text',
      text: imageDiagnostic(
        block,
        validationErrors.get(index) ?? 'another image in the same result was invalid',
      ),
    }))
  }

  let attachments: AttachmentStore
  try {
    attachments = await resolveImageAdmission(ctx, exec)
  } catch (error: unknown) {
    // resolveImageAdmission 包容提供方的失败，且只抛出 Error。
    const reason = (error as Error).message
    return projectContent(content, toolName, block => ({ type: 'text', text: imageDiagnostic(block, reason) }))
  }

  try {
    const refs = await attachments.saveImages(decoded)
    const byIndex = new Map(imageIndexes.map((index, offset) => [index, refs[offset] as ImageAttachmentRef] as const))
    return projectContent(content, toolName, (_block, index) => ({
      type: 'image',
      attachment: byIndex.get(index) as ImageAttachmentRef,
    }))
  } catch (error: unknown) {
    const reason = isImageAdmissionError(error)
      ? `image admission rejected the result: ${error.message}`
      : 'durable image storage rejected the result'
    return projectContent(content, toolName, block => ({
      type: 'text',
      text: imageDiagnostic(block, reason),
    }))
  }
}

/**
 * 从一个 MCP 内容数组中把文本抽取为单个字符串。
 * - text 块：以 '\n' 连接
 * - image/audio/resource 块：替换为占位符
 *
 * 由策略负责的规范化值替换，可能省略 MCP 线路上必填的字段。
 */
function extractText(mcpContent: JsonValue[], toolName: string): string {
  const content = projectContent(mcpContent, toolName)
  // 下面的默认图片投影器同样返回文本，因此这次本地调用不可能产出核心图片块。
  return content.map(block => (block as Extract<ContentBlock, { type: 'text' }>).text).join('\n')
}

/**
 * 把按序排列的 MCP 块投影为核心内容 vocabulary。
 * 类文本的片段按换行合并；被准入的图片会在其原始位置切分这些片段。
 */
function projectContent(
  mcpContent: JsonValue[],
  toolName: string,
  image: (block: McpContentBlock, index: number) => ContentBlock = block => ({
    type: 'text',
    text: imageDiagnostic(block, 'this result was not admitted to durable model context'),
  }),
): ContentBlock[] {
  const projected: ContentBlock[] = []
  const text: string[] = []
  const flushText = (): void => {
    if (text.length === 0) return
    projected.push({ type: 'text', text: text.splice(0).join('\n') })
  }

  for (const [index, value] of mcpContent.entries()) {
    if (!isRecord(value)) {
      text.push('[unsupported MCP content block: expected an object]')
      continue
    }
    const block = value as unknown as McpContentBlock
    switch (block.type) {
      case 'text':
        if (block.text !== undefined) text.push(block.text)
        break
      case 'image':
        flushText()
        projected.push(image(block, index))
        break
      case 'resource_link':
        if (block.name === undefined || block.uri === undefined) {
          text.push('[resource link unavailable: the MCP block is missing its name or URI]')
        } else {
          text.push(`Resource link: ${block.name} (${block.uri})`)
        }
        break
      case 'audio':
        text.push(`[audio result unsupported: ${block.mimeType ?? 'unknown media type'}; raw audio data remains available to programmatic callers]`)
        break
      case 'resource':
        text.push('[embedded resource unsupported; raw resource data remains available to programmatic callers]')
        break
      default:
        text.push(`[unsupported MCP content type: ${block.type}]`)
    }
  }
  flushText()
  return projected.length > 0
    ? projected
    : [{ type: 'text', text: `(${toolName} returned no model-visible content)` }]
}
