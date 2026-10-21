/** 内容块结构辅助函数。 @module @deepseek-ai/dsh-llm/content */

import type { ContentBlock, ImageBlock, LlmImageRequestBudget, ToolSchema, ToolUpdate, ToolHistory } from './types.ts'
import type { RequestMessage } from './types.ts'
import type { Message } from './message.ts'
import type {
  AttachmentStore, FileAttachmentRef, ImageAttachmentRef, ImageMediaType, RequestImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { assertNever } from '@deepseek-ai/dsh-util-values'

/** 模型工具可以用来读取一个已规范化附件的执行世界路径。 */
export interface ImageAttachmentAccess {
  /** 指向不可变的已规范化字节的绝对路径；调用方必须把它当作只读。 */
  readonlyPath: string
}

/**
 * 为一个持久化的图像引用解析当前执行世界的访问路径。
 * @param ref - 持久化的、已规范化的附件引用。
 * @returns 一个只读的执行世界路径，或当不可用时为 undefined。
 */
export type ImageAttachmentAccessResolver = (ref: ImageAttachmentRef) => ImageAttachmentAccess | undefined

/**
 * 把一个附件提供方的宿主对象位置桥接到已挂载的工具执行世界。
 * 消费者提供当前文件系统提供方的映射，而不让附件或 LLM 的定义依赖它。
 * @param attachments - 持有该已规范化附件对象的提供方。
 * @param mapHostPath - 把一个绝对宿主路径映射到当前工具执行世界。
 * @param ref - 持久化的、已规范化的附件引用。
 * @returns 一个只读的执行世界路径，或当任一方提供方没有暴露映射时为 undefined。
 * @throws 当该持久化引用无效时抛出一个附件错误。
 */
export function resolveImageAttachmentAccess(
  attachments: AttachmentStore,
  mapHostPath: (hostPath: string) => string | undefined,
  ref: ImageAttachmentRef,
): ImageAttachmentAccess | undefined {
  const hostPath = attachments.imageHostPath(ref)
  if (hostPath === undefined) return undefined
  const readonlyPath = mapHostPath(hostPath)
  return readonlyPath === undefined ? undefined : { readonlyPath }
}

function quoted(value: string): string {
  return JSON.stringify(value)
}

function imageIdentity(ref: ImageAttachmentRef): string {
  return ref.name === undefined
    ? String(ref.attachmentId)
    : `${quoted(ref.name)} (${ref.attachmentId})`
}

function extension(mediaType: ImageMediaType): string {
  switch (mediaType) {
    case 'image/png': return '.png'
    case 'image/jpeg': return '.jpg'
    case 'image/webp': return '.webp'
    case 'image/gif': return '.gif'
    default: return assertNever(mediaType, 'image extension')
  }
}

function normalizedAccessText(ref: ImageAttachmentRef, access: ImageAttachmentAccess): string {
  return ` Normalized copy (read-only; may be resized or re-encoded): ${quoted(access.readonlyPath)} (${ref.width}x${ref.height}px, ${ref.mediaType}).`
    + ' Source dimensions, format, and byte size may differ.'
    + ` Copy to a writable path ending in ${extension(ref.mediaType)} before editing.`
}

/**
 * 展示给一个无法接受某个持久化图像引用的模型的稳定文本。
 * @param ref - 被本次请求省略的、持久化的已规范化附件。
 * @returns 确定性的纯文本占位符。
 */
export function textOnlyImageText(ref: ImageAttachmentRef): string {
  const digest = String(ref.attachmentId).slice('sha256:'.length, 'sha256:'.length + 8)
  return `[image omitted because this model accepts text only; attachment sha256:${digest}]`
}

/**
 * 一张精确请求图像的、稳定的、面向模型的句柄。身份来自这次出现自己的
 * 持久化引用：请求版本是按附件 id 准备的，因此一个共享的版本
 * 可能服务于展示名称互不相同的若干次出现。
 * @param ref - 这次出现的、持久化的已规范化附件。
 * @param version - 显示在文本旁边的精确请求图像尺寸。
 * @param access - 为当前工具执行世界解析出的可选路径。
 * @returns 附件句柄与请求图像尺寸。
 */
export function requestImageHandleText(
  ref: ImageAttachmentRef,
  version: Pick<RequestImageAttachment, 'width' | 'height'>,
  access?: ImageAttachmentAccess,
): string {
  const preview = `Image ${imageIdentity(ref)}; request preview ${version.width}x${version.height}px.`
  return access === undefined
    ? `${preview} It may be resized or re-encoded; source dimensions, format, and byte size may differ.`
    : preview + normalizedAccessText(ref, access)
}

/**
 * 因请求限制而省略一张图像时使用的、稳定的按图像占位符。
 * @param ref - 被本次请求省略的、持久化的已规范化附件。
 * @param access - 由提供方为模型工具解析出的可选路径。
 * @returns 身份、已规范化元数据，以及可用的恢复路径。
 */
export function offloadedImageText(
  ref: ImageAttachmentRef,
  access?: ImageAttachmentAccess,
): string {
  const identity = `image omitted to fit request image limits; ${imageIdentity(ref)}.`
  if (access === undefined) {
    return `[${identity} No local normalized image path is available; ask the user to attach it again if needed.]`
  }
  return `[${identity}${normalizedAccessText(ref, access)}]`
}

/**
 * 当带类型的模型内容包含一个图像块时为 true。这是被每个图像策略
 * （能力门禁、纯文本序列化、压缩普查）共享的唯一图像遍历，
 * 因此消费者不可能静默地产生分歧。
 * @param content - 带类型的模型内容块。
 * @returns 是否存在任何一个块是图像。
 */
export function contentHasImage(content: readonly ContentBlock[]): boolean {
  return content.some(block => block.type === 'image')
}

/**
 * 当带类型的模型内容包含一个文件块时为 true。
 * 每次调用都读取当前内容，且不保留扫描结果。
 * @param content - 带类型的模型内容块。
 * @returns 是否存在任何一个块是文件。
 */
export function contentHasFile(content: readonly ContentBlock[]): boolean {
  for (const block of content) {
    if (block.type === 'file') return true
  }
  return false
}

/**
 * 一个持久化文件引用的、稳定的、面向模型的句柄：逐字存储的副本的地址，
 * 以及按需读取它的指令。这是提供方针对文件所会收到的唯一表示形式。
 * @param ref - 持久化的逐字文件引用。
 * @param readonlyPath - 已存储副本的执行世界路径，当可解析时。
 * @returns 指名该文件、其大小与其地址的确定性句柄文本。
 */
export function fileHandleText(ref: FileAttachmentRef, readonlyPath: string | undefined): string {
  const digest = String(ref.attachmentId).slice('sha256:'.length, 'sha256:'.length + 8)
  const identity = `File ${quoted(ref.name)} (${ref.bytes} bytes, sha256:${digest})`
  if (readonlyPath === undefined) {
    return `[${identity} was uploaded, but the current execution environment cannot access a readable path. Report that limitation if its contents are needed; do not claim to have read it.]`
  }
  return `[${identity}: verbatim read-only copy saved at ${quoted(readonlyPath)}. Read that path with your file tools when its contents are needed; copy it to a writable location before modifying it. When delegating file work, include this saved path in the delegation prompt; only subagents sharing this execution environment can read it.]`
}

/** 把每次文件出现替换为句柄文本。 */
function replaceFilesWithHandles(
  blocks: readonly ContentBlock[],
  resolvePath: (ref: FileAttachmentRef) => string | undefined,
): ContentBlock[] {
  let next: ContentBlock[] | undefined
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'file') {
      next ??= blocks.slice(0, index)
      next.push({ type: 'text', text: fileHandleText(block.attachment, resolvePath(block.attachment)) })
      continue
    }
    next?.push(block)
  }
  return next ?? blocks as ContentBlock[]
}

/**
 * 为每条模型路由把请求文件内容投影为确定性的句柄文本。
 * 与图像不同，没有任何提供方会原生地收到文件块，
 * 因此这一投影在请求装配中是无条件的。
 * @param messages - 完整的请求历史。
 * @param resolvePath - 解析某个引用当前执行世界的读取路径。
 * @returns 不含文件的原始列表，否则是带有句柄文本的浅层消息副本。
 */
export function projectFilesToText(
  messages: readonly Message[],
  resolvePath: (ref: FileAttachmentRef) => string | undefined,
): readonly Message[]
/**
 * 在混合的持久化输入与仅请求输入中投影文件内容。
 * @param messages - 完整的请求输入。
 * @param resolvePath - 解析某个引用的执行世界读取路径。
 * @returns 不含文件的原始输入，否则是带有句柄文本的副本。
 */
export function projectFilesToText(
  messages: readonly RequestMessage[],
  resolvePath: (ref: FileAttachmentRef) => string | undefined,
): readonly RequestMessage[]
export function projectFilesToText(
  messages: readonly RequestMessage[],
  resolvePath: (ref: FileAttachmentRef) => string | undefined,
): readonly RequestMessage[] {
  if (!messages.some(message => contentHasFile(message.content))) return messages
  return messages.map((message) => {
    const content = replaceFilesWithHandles(message.content, resolvePath)
    return content === message.content ? message : { ...message, content }
  })
}

/** 原始图像字节的 base64 长度，含填充。 */
function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4
}

/**
 * 按消息顺序访问带类型内容中的每次图像出现。
 * @param content - 带类型的模型内容块。
 * @param visit - 每次出现调用一次。
 */
function visitImageBlocks(content: readonly ContentBlock[], visit: (block: ImageBlock) => void): void {
  for (const block of content) {
    if (block.type === 'image') visit(block)
  }
}

/** 把每次已卸载的出现替换为它的占位符。 */
function replaceOffloadedImages(
  blocks: readonly ContentBlock[],
  placeholder: (ref: ImageAttachmentRef) => string,
): ContentBlock[] {
  let next: ContentBlock[] | undefined
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'image' && block.offloaded === true) {
      next ??= blocks.slice(0, index)
      next.push({ type: 'text', text: placeholder(block.attachment) })
      continue
    }
    next?.push(block)
  }
  return next ?? blocks as ContentBlock[]
}

/**
 * 为一次请求把表面上已卸载的出现投影为确定性文本。已卸载集合是一个
 * 持久化的表面事实，因此每条路由发送同一个集合；只有占位文本由路由持有。
 * @param messages - 派生出来的请求历史。
 * @param placeholder - 为一个已卸载的附件构建模型可见的替换文本。
 * @returns 当没有任何东西被卸载时为原始列表，否则是带有占位符的浅层消息副本。
 */
export function projectOffloadedImages(
  messages: readonly Message[],
  placeholder: (ref: ImageAttachmentRef) => string,
): readonly Message[]
/**
 * 在混合的持久化输入与仅请求输入中投影已卸载的图像。
 * @param messages - 完整的请求输入。
 * @param placeholder - 一个已卸载附件的替换文本。
 * @returns 原始消息，或带有占位符的浅层副本。
 */
export function projectOffloadedImages(
  messages: readonly RequestMessage[],
  placeholder: (ref: ImageAttachmentRef) => string,
): readonly RequestMessage[]
export function projectOffloadedImages(
  messages: readonly RequestMessage[],
  placeholder: (ref: ImageAttachmentRef) => string,
): readonly RequestMessage[] {
  return messages.map((message) => {
    const content = replaceOffloadedImages(message.content, placeholder)
    return content === message.content ? message : { ...message, content }
  })
}

/**
 * 一旦超出预算，某条路由预算按其整数数量与字节步长所移除的、
 * 最早的被保留图像出现的数量。该结果只取决于已表示的长度，
 * 因此每条路由都以同样的方式指名这个数量。
 * @param lengths - 每个被保留出现的已表示字节长度，最早的在前。
 * @param budget - 数量/字节预算与移除步长；缺失时无上界。
 * @returns 要卸载多少个开头的出现。
 */
function offloadedImagePrefixCount(
  lengths: readonly number[],
  budget: Pick<LlmImageRequestBudget, 'maxImages' | 'maxBytes' | 'countQuantum' | 'byteQuantum'>,
): number {
  const total = lengths.reduce((sum, bytes) => sum + bytes, 0)
  const excessCount = budget.maxImages === undefined ? 0 : Math.max(0, lengths.length - budget.maxImages)
  const excessBytes = budget.maxBytes === undefined ? 0 : Math.max(0, total - budget.maxBytes)
  if (excessCount === 0 && excessBytes === 0) return 0
  const countQuantum = budget.countQuantum ?? 1
  const byteQuantum = budget.byteQuantum ?? 1
  const removeCount = excessCount === 0 ? 0 : Math.ceil(excessCount / countQuantum) * countQuantum
  const removeBytes = excessBytes === 0 ? 0 : Math.ceil(excessBytes / byteQuantum) * byteQuantum
  let count = 0
  let removedBytes = 0
  for (const imageBytes of lengths) {
    const byteTargetMet = removeBytes === 0
      || (byteQuantum === 1 ? removedBytes >= removeBytes : removedBytes > removeBytes)
    if (count >= removeCount && byteTargetMet) break
    removedBytes += imageBytes
    count += 1
  }
  return count
}

/**
 * 在路由发送的确切字节长度之下，某个派生请求要放得进它的预算，
 * 一条路由还必须卸载多少个最早的被保留出现；当请求恰好放得下时为 0。
 * 一条路由会以携带这个数量的 `IMAGE_OFFLOAD_REQUIRED` 失败，
 * 而不是自己执行卸载。
 * @param messages - 携带表面上 `offloaded` 标记的派生请求历史。
 * @param budget - 路由表示形式、预算与移除步长。
 * @param versionBytes - 一次被保留出现的精确请求版本字节长度。
 * @returns 还需额外卸载多少个开头的被保留出现。
 */
export function requiredImageOffload(
  messages: readonly RequestMessage[],
  budget: Pick<LlmImageRequestBudget, 'representation' | 'maxBytes' | 'maxImages' | 'byteQuantum' | 'countQuantum'>,
  versionBytes: (block: ImageBlock) => number,
): number {
  const lengths: number[] = []
  for (const message of messages) {
    visitImageBlocks(message.content, (block) => {
      if (block.offloaded === true) return
      const bytes = versionBytes(block)
      lengths.push(budget.representation === 'base64' ? base64Length(bytes) : bytes)
    })
  }
  return offloadedImagePrefixCount(lengths, budget)
}

/** 为一个纯文本模型替换每次图像出现。 */
function replaceImagesForTextModel(blocks: readonly ContentBlock[]): ContentBlock[] {
  let next: ContentBlock[] | undefined
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'image') {
      next ??= blocks.slice(0, index)
      next.push({ type: 'text', text: textOnlyImageText(block.attachment) })
      continue
    }
    next?.push(block)
  }
  return next ?? blocks as ContentBlock[]
}

/**
 * 为一个精确的纯文本模型把请求图像内容投影为确定性文本。
 * @param messages - 完整的请求历史。
 * @returns 不含图像的原始列表，否则是带有稳定占位符的浅层消息副本。
 */
export function projectImagesForTextModel(messages: readonly Message[]): readonly Message[]
/**
 * 为一个纯文本模型在混合的持久化输入与仅请求输入中投影图像内容。
 * @param messages - 完整的请求输入。
 * @returns 不含图像的原始输入，否则是带有稳定占位符的副本。
 */
export function projectImagesForTextModel(messages: readonly RequestMessage[]): readonly RequestMessage[]
export function projectImagesForTextModel(messages: readonly RequestMessage[]): readonly RequestMessage[] {
  if (!messages.some(message => contentHasImage(message.content))) return messages
  return messages.map((message) => {
    const content = replaceImagesForTextModel(message.content)
    return content === message.content ? message : { ...message, content }
  })
}

/** 经过某条路由的工具更新投影之后的请求消息与工具。 */
export interface ProjectedToolUpdates {
  /** 只含本路由与本次声明系列所支持的那些 developer 更新的历史。 */
  readonly messages: readonly RequestMessage[]
  /** 提供方声明，在受支持时包含延迟加载的与保留下来的定义。 */
  readonly tools: readonly ToolSchema[] | undefined
}

function withoutDeveloperMessages(messages: readonly RequestMessage[]): readonly RequestMessage[] {
  const retained = messages.filter(message => message.role !== 'developer')
  return retained.length === messages.length ? messages : retained
}

function toolDeclarations(
  tools: readonly ToolSchema[] | undefined,
  mode: ToolUpdate,
  history: ToolHistory,
): Map<string, ToolSchema> {
  const declarations = new Map(history.tools.map(tool => [tool.name, tool]))
  for (const update of history.updates) {
    for (const tool of update.additions) {
      if (!declarations.has(tool.name)) {
        // 较晚的新增项会在它们被记录的位置上启用这些定义。
        declarations.set(tool.name, { ...tool, deferLoading: true })
      }
    }
  }

  switch (mode) {
    case 'in-history':
      // 移除块在不丢弃其历史定义的前提下停用工具。
      return declarations
    case 'addition-only': {
      // 没有移除支持时，声明列表必须省略那些未激活的工具。
      const activeNames = new Set(tools?.map(tool => tool.name))
      for (const name of declarations.keys()) {
        if (!activeNames.has(name)) declarations.delete(name)
      }
      return declarations
    }
    /* v8 ignore next 2 -- 封闭联合的穷尽性保护 */
    default:
      return assertNever(mode)
  }
}

/**
 * 在不改动已记录的活跃工具的前提下，从按会话折叠的历史构造提供方声明。
 * 不受支持的路由与不完整的历史使用当前声明，且不带 developer 更新。
 * 被显式延迟加载的基线工具只有在其首次被保留的新增之后才变得可用。
 * @param messages - 完整的请求输入，或为一次辅助调用所选出的前缀。
 * @param tools - 当前活跃的工具 schema。
 * @param toolUpdate - 已解析路由的更新模式。
 * @param history - 从已提交的请求头与 developer 消息折叠出来的不可变状态。
 * @returns 提供方声明，以及相应过滤后的历史。
 */
export function projectToolUpdates(
  messages: readonly RequestMessage[],
  tools: readonly ToolSchema[] | undefined,
  toolUpdate: ToolUpdate | undefined,
  history?: ToolHistory,
): ProjectedToolUpdates {
  if (toolUpdate === undefined) {
    // 不受支持的路由需要立即可用的工具，且不需要更新消息。
    let immediateTools = tools
    if (tools?.some(tool => tool.deferLoading === true)) {
      immediateTools = tools.map(({ deferLoading: _loading, ...tool }) => tool)
    }
    return { messages: withoutDeveloperMessages(messages), tools: immediateTools }
  }

  if (history === undefined) {
    // 仅凭当前的 schema 无法解析过去那些更新所引用的定义。
    return { messages: withoutDeveloperMessages(messages), tools }
  }
  const messageIds = new Set(messages.flatMap(message => message.role === 'developer' ? [message.id] : []))
  if (history.updates.some(update => !messageIds.has(update.messageId))) {
    // 一个辅助前缀可能省略掉启用历史声明所必需的更新。
    return { messages: withoutDeveloperMessages(messages), tools }
  }

  const declarations = toolDeclarations(tools, toolUpdate, history)
  const updateIds = new Set(history.updates.map(update => update.messageId))
  // 被延迟加载的基线工具仍然需要它们的首次新增才能变得可用。
  const offered = new Set(history.tools.filter(tool => !tool.deferLoading).map(tool => tool.name))
  const projectedMessages: RequestMessage[] = []
  for (const message of messages) {
    if (message.role !== 'developer') {
      projectedMessages.push(message)
      continue
    }
    // 更早的声明系列不约束当前的工具集合。
    if (!updateIds.has(message.id)) continue

    const content = message.content.filter((block) => {
      switch (block.type) {
        case 'tool-addition':
          // 只有那些尚未可用的已声明工具才需要被启用。
          if (!declarations.has(block.toolName) || offered.has(block.toolName)) return false
          offered.add(block.toolName)
          return true
        case 'tool-removal':
          // 只支持新增的路由无法通过历史停用某个工具。
          if (toolUpdate !== 'in-history') return false
          return offered.delete(block.toolName)
        default:
          // 其他核心块与插件定义的块保留其内容与顺序。
          return true
      }
    })
    if (content.length === 0) continue
    if (content.length === message.content.length) {
      projectedMessages.push(message)
    } else {
      projectedMessages.push({ ...message, content })
    }
  }

  const unchanged = projectedMessages.length === messages.length
    && projectedMessages.every((message, index) => message === messages[index])
  return {
    messages: unchanged ? messages : projectedMessages,
    tools: [...declarations.values()],
  }
}
