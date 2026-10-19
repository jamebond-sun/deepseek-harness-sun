/** 由 ACP 适配器负责的 ACP 线上内容准入与投影。@module */

import type { ContentBlock as AcpContentBlock } from '@agentclientprotocol/sdk'
import type { Context } from '@deepseek-ai/cordis'
import { isImageAdmissionError } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, ImageMediaType, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** ACP 图像块与核心附件词表共用的光栅格式。 */
const IMAGE_MEDIA_TYPES: readonly ImageMediaType[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]

/** 规范 RFC 4648 base64，排除空白字符与 URL 安全别名。 */
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/** 协议处理程序使用的内容准入失败类别。 */
export type AcpContentFailureKind = 'invalid' | 'internal'

/** 带稳定 ACP 请求失败类别、且不包含原始二进制载荷的错误。 */
export class AcpContentError extends Error {
  /** bridge 应报告无效参数还是内部失败。 */
  readonly kind: AcpContentFailureKind

  /**
   * @param message - 面向协议的安全详情，不含内联二进制数据。
   * @param kind - 请求失败类别。
   * @param options - 可选的诊断因果链。
   */
  constructor(message: string, kind: AcpContentFailureKind, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AcpContentError'
    this.kind = kind
  }
}

/** 将线上 MIME 字符串收窄到持久化光栅词表。 */
function imageMediaType(value: string): ImageMediaType | undefined {
  return IMAGE_MEDIA_TYPES.includes(value as ImageMediaType) ? value as ImageMediaType : undefined
}

/** 严格解码一个 ACP 内联图像，不接受 base64 别名。 */
function decodeImage(block: Extract<AcpContentBlock, { type: 'image' }>): SaveImageAttachment {
  const mediaType = imageMediaType(block.mimeType)
  if (mediaType === undefined) {
    throw new AcpContentError('image mimeType must be image/png, image/jpeg, image/webp, or image/gif', 'invalid')
  }
  if (!CANONICAL_BASE64.test(block.data)) {
    throw new AcpContentError('image data must be canonical base64', 'invalid')
  }
  const data = Buffer.from(block.data, 'base64')
  if (data.toString('base64') !== block.data) {
    throw new AcpContentError('image data must be canonical base64', 'invalid')
  }
  return { data, mediaType }
}

/** 解析精确的当前路由，并要求显式声明图像输入支持。 */
async function assertImageRoute(ctx: Context, route: ModelSelection | undefined, signal: AbortSignal): Promise<void> {
  const provider = route?.provider
  const model = route?.model
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) {
    throw new AcpContentError('the current model route could not be resolved for image input', 'invalid')
  }
  let info: Awaited<ReturnType<typeof llm.resolveModelInfo>>
  try {
    info = await llm.resolveModelInfo(provider, model, signal)
  } catch (error: unknown) {
    throw new AcpContentError('the current model route could not be verified for image input', 'internal', { cause: error })
  }
  if (info.inputModalities === undefined || !info.inputModalities.includes('image')) {
    throw new AcpContentError(`model "${model}" does not declare image input`, 'invalid')
  }
}

/**
 * 判断初始化时能否如实声明内联图像提示词支持。
 * 未知的服务、路由、能力或部署媒体支持一律视为否定。
 * @param ctx - 携带可选附件服务与模型服务的 bridge 上下文。
 * @param provider - 新建会话使用的已配置提供方路由。
 * @param model - 新建会话使用的已配置精确模型 id。
 * @returns 该 bridge 在初始化时能否接纳图像。
 */
export async function supportsAcpImagePrompts(
  ctx: Context,
  provider: string | undefined,
  model: string | undefined,
): Promise<boolean> {
  const attachments = ctx.get('attachments')
  const llm = ctx.get('llm')
  if (attachments === undefined || llm === undefined || provider === undefined || model === undefined) return false
  if (!attachments.imageLimits.mediaTypes.some(mediaType => IMAGE_MEDIA_TYPES.includes(mediaType))) return false
  try {
    const info = await llm.resolveModelInfo(provider, model)
    return info.inputModalities?.includes('image') === true
  } catch {
    return false
  }
}

/** 将一条基准 resource link 渲染为核心当前的文本词表。 */
function resourceLinkText(block: Extract<AcpContentBlock, { type: 'resource_link' }>): string {
  return `\n[resource_link name=${JSON.stringify(block.name)} uri=${JSON.stringify(block.uri)}]\n`
}

/**
 * 将一个 ACP 提示词准入为有序、可持久化的核心内容。
 * 每个线上内容块与图像都会在有序图像批次开始写入之前完成校验；
 * 内容寻址写入成功后再取消，可能留下不可达对象，但绝不会入队迟到的用户消息。
 * @param ctx - 携带附件服务与模型服务的 bridge 上下文。
 * @param route - 固定到已接受提示词的模型选择。
 * @param prompt - 按线上顺序排列的不可信 ACP 提示词内容块。
 * @param imageEnabled - 初始化时声明的能力结果。
 * @param signal - 准入取消信号。
 * @returns 按线上顺序携带持久化图像引用的核心内容。
 */
export async function admitAcpPrompt(
  ctx: Context,
  route: ModelSelection | undefined,
  prompt: readonly AcpContentBlock[],
  imageEnabled: boolean,
  signal: AbortSignal,
): Promise<ContentBlock[]> {
  const images: SaveImageAttachment[] = []
  for (const block of prompt) {
    switch (block.type) {
      case 'text':
      case 'resource_link':
        break
      case 'image':
        if (!imageEnabled) throw new AcpContentError('inline image prompts were not advertised by this connection', 'invalid')
        images.push(decodeImage(block))
        break
      case 'audio':
        throw new AcpContentError('audio prompt content is not supported', 'invalid')
      case 'resource':
        throw new AcpContentError('embedded resource prompt content is not supported', 'invalid')
      /* v8 ignore next 2 -- ACP ContentBlock 是生成出来的封闭联合类型。 */
      default:
        throw new AcpContentError('unsupported ACP prompt content', 'invalid')
    }
  }

  let refs: readonly ImageAttachmentRef[] = []
  if (images.length > 0) {
    const attachments = ctx.get('attachments')
    if (attachments === undefined) throw new AcpContentError('no attachment store is mounted', 'invalid')
    await assertImageRoute(ctx, route, signal)
    signal.throwIfAborted()
    try {
      refs = await attachments.saveImages(images)
    } catch (error: unknown) {
      if (isImageAdmissionError(error)) {
        throw new AcpContentError(error.message, 'invalid', { cause: error })
      }
      throw new AcpContentError('unable to persist the prompt image batch', 'internal', { cause: error })
    }
    signal.throwIfAborted()
  }

  const content: ContentBlock[] = []
  let pendingText = ''
  let imageIndex = 0
  const flushText = (): void => {
    if (pendingText.length === 0) return
    content.push({ type: 'text', text: pendingText })
    pendingText = ''
  }
  for (const block of prompt) {
    switch (block.type) {
      case 'text':
        pendingText += block.text
        break
      case 'resource_link':
        pendingText += resourceLinkText(block)
        break
      case 'image': {
        flushText()
        const ref = refs[imageIndex++] as ImageAttachmentRef
        content.push({ type: 'image', attachment: ref })
        break
      }
      /* v8 ignore start -- 上方的校验阶段已在重建之前拒绝这两个标签。 */
      case 'audio':
      case 'resource':
        break
      /* v8 ignore stop */
      /* v8 ignore next 2 -- 已由第一个封闭联合 switch 校验。 */
      default:
        break
    }
  }
  flushText()
  if (!content.some(block => block.type === 'image' || (block.type === 'text' && block.text.trim().length > 0))) {
    throw new AcpContentError('empty prompt', 'invalid')
  }
  return content
}

/**
 * 将一个已提交的 assistant 内容块转换为 ACP 线上内容。
 * 图像在内联 base64 交付之前会重新读取并校验完整性；
 * 不支持的核心输出块不会进入 automation 线上协议。
 * @param ctx - 携带权威附件存储的 bridge 上下文。
 * @param block - 已提交的核心 assistant 内容块。
 * @returns ACP 文本/图像内容；非输出块返回 undefined。
 */
export async function assistantBlockToAcp(
  ctx: Context,
  block: ContentBlock,
): Promise<AcpContentBlock | undefined> {
  if (block.type === 'text') {
    return block.text.length === 0 ? undefined : { type: 'text', text: block.text }
  }
  if (block.type !== 'image') return undefined
  const attachments = ctx.get('attachments')
  if (attachments === undefined) {
    throw new AcpContentError('cannot deliver assistant image: no attachment store is mounted', 'internal')
  }
  let stored: Awaited<ReturnType<typeof attachments.readImage>>
  try {
    stored = await attachments.readImage(block.attachment)
  } catch (error: unknown) {
    throw new AcpContentError('cannot deliver assistant image: the attachment is unavailable or corrupt', 'internal', { cause: error })
  }
  return {
    type: 'image',
    data: Buffer.from(stored.data).toString('base64'),
    mimeType: stored.ref.mediaType,
  }
}
