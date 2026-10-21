/**
 * 面向模型的 `read_image` 工具用于提交一个 PNG/JPEG/WebP/GIF 文件。没有扩展名的路径依据其
 * 文件签名识别，而附件服务的完整解码始终才是权威依据。已挂载的 `ctx.fs` 后端负责路径解析
 * 与读取访问；文件名只用来声明媒体类型。
 *
 * 这条路由门禁刻意比宿主的上传预检更严格。只有当确切的调用路由能够查看一次图片读取的结果时，
 * 该工具才有意义，因此能力未知时直接拒绝，而不是等到文件系统与附件的工作都做完之后再依赖
 * 适配层的失败来兜底。
 * @module @deepseek-ai/dsh-tool-fs/src/read-image
 */

import { basename, extname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { AttachmentError, AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'
import { resolveRegularReadTarget } from './read-target.ts'

/** `read_image` 接受的扩展名；附件服务处的魔数校验始终是权威依据。 */
const IMAGE_EXTENSIONS: Readonly<Record<string, ImageMediaType>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const

function matchesBytes(data: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (data.byteLength < offset + expected.length) return false
  return expected.every((byte, index) => data[offset + index] === byte)
}

function matchesAscii(data: Uint8Array, offset: number, value: string): boolean {
  if (data.byteLength < offset + value.length) return false
  for (let index = 0; index < value.length; index += 1) {
    if (data[offset + index] !== value.charCodeAt(index)) return false
  }
  return true
}

/**
 * 识别受支持图片文件签名所声明的媒体类型。
 * @param data - 通过当前文件系统后端读出的文件字节。
 * @returns 检测到的受支持媒体类型；其他字节时为 undefined。
 */
export function sniffImageMediaType(data: Uint8Array): ImageMediaType | undefined {
  if (matchesBytes(data, 0, PNG_SIGNATURE)) return 'image/png'
  if (matchesBytes(data, 0, JPEG_SIGNATURE)) return 'image/jpeg'
  if (matchesAscii(data, 0, 'GIF87a') || matchesAscii(data, 0, 'GIF89a')) return 'image/gif'
  if (matchesAscii(data, 0, 'RIFF') && matchesAscii(data, 8, 'WEBP')) return 'image/webp'
  return undefined
}

const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: true,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    name: { type: 'string' },
    originalDimensions: {
      type: 'object',
      additionalProperties: false,
      properties: {
        width: { type: 'integer', required: true },
        height: { type: 'integer', required: true },
      },
    },
  },
} as const

/** 由 `read_image` 输出模式声明的结构化结果。 */
export interface ImageReadValue {
  /** 文件系统提供者执行世界中的规范绝对路径。 */
  path: string
  image: {
    attachmentId: string
    mediaType: ImageMediaType
    bytes: number
    width: number
    height: number
    name?: string
    /** 规范化之前、已应用方向校正的文件尺寸；仅在存储层压缩过它时才存在。 */
    originalDimensions?: {
      width: number
      height: number
    }
  }
}

/**
 * 按扩展名把一个模型提供的路径映射到它所声明的图片媒体类型。
 * @param filePath - 原始的 `file_path` 参数（尚未解析）。
 * @returns 声明的媒体类型；路径没有表明自己是图片时为 undefined。
 */
export function imageMediaTypeForPath(filePath: string): ImageMediaType | undefined {
  return IMAGE_EXTENSIONS[extname(filePath).toLowerCase()]
}

/**
 * 为调用路由强制实施严格的图片能力门禁。解析会话最新的已路由 provider/model
 * （先取请求头配置，再取 agent 选项），并要求确切解析出的路由显式声明支持 `image` 输入。
 * @param ctx - 用于解析可选 `llm` 服务的插件上下文。
 * @param exec - 提供调用方 agent 的工具执行上下文。
 * @param requestedPath - 用于拒绝消息中的、尚未解析的原始路径。
 */
export async function assertImageCapableRoute(ctx: Context, exec: ToolExecution, requestedPath: string): Promise<void> {
  const routed = exec.agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? exec.agent?.options.provider
  const model = routed?.model ?? exec.agent?.options.model
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) {
    throw new Error(`cannot read "${requestedPath}" as an image: the current model route could not be resolved`)
  }
  const active = await llm.resolveModelInfo(provider, model, exec.signal)
  if (active.inputModalities === undefined || !active.inputModalities.includes('image')) {
    throw new Error(`cannot read "${requestedPath}" as an image: model "${model}" does not declare image input; switch to an image-capable model to read images`)
  }
}

/** 拒绝该部署可接受集合之外的媒体类型，并在消息中指出出问题的路径。 */
function assertDeploymentAccepts(attachments: AttachmentStore, mediaType: ImageMediaType, displayPath: string): void {
  if (!attachments.imageLimits.mediaTypes.includes(mediaType)) {
    throw new Error(`cannot read "${displayPath}": ${mediaType} images are not accepted by this deployment`)
  }
}

/**
 * 把一个结构化的图片结果重新标记（品牌化）为 `ImageBlock` 所携带的持久化附件引用。
 * @param image - 来自输出模式的图片元数据。
 * @returns 带上标记的附件引用。
 */
export function imageRefFromValue(image: ImageReadValue['image']): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(image.attachmentId),
    mediaType: image.mediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    ...image.name === undefined ? {} : { name: image.name },
    ...image.originalDimensions === undefined ? {} : {
      originalDimensions: { ...image.originalDimensions },
    },
  }
}

/**
 * 把一次图片读取格式化为紧邻其图片块的、面向模型的信封。被缩小的读取会指明磁盘上的尺寸，
 * 以及把在附件图片上量得的坐标映射回原始文件的那个倍数。
 * @param displayPath - 由后端解析、渲染在信封 `<path>` 元素中的路径。
 * @param image - 待摘要的图片元数据。
 * @returns 面向模型的信封；图片本身由相邻的图片块承载。
 */
export function formatImageReadOutput(displayPath: string, image: ImageReadValue['image']): string {
  let scaled = ''
  if (image.originalDimensions !== undefined) {
    // 整数取整会让两个轴的比例略有差异，因此只有当两者取整到同一个值时，
    // 提示语才会给出单一倍数。
    const x = (image.originalDimensions.width / image.width).toFixed(2)
    const y = (image.originalDimensions.height / image.height).toFixed(2)
    const advice = x === y
      ? `multiply coordinates by ${x}`
      : `multiply x coordinates by ${x} and y coordinates by ${y}`
    scaled = ` (downscaled from ${image.originalDimensions.width}x${image.originalDimensions.height} px; ${advice} to locate features in the original file)`
  }
  return `<path>${displayPath}</path>
<type>image</type>
<content>
${image.mediaType} image, ${image.width}x${image.height} px, ${image.bytes} bytes${scaled}
</content>`
}

/**
 * 把一个结构化的图片读取投影为它的面向模型信封与图片本身。
 * @param value - 图片读取的结果。
 * @returns 原生派发与嵌套派发共用的两个内容块。
 */
function imageReadContent(value: ImageReadValue): ContentBlock[] {
  return [
    { type: 'text', text: formatImageReadOutput(value.path, value.image) },
    { type: 'image', attachment: imageRefFromValue(value.image) },
  ]
}

/**
 * 把 `read_image` 工具注册进给定的上下文。负责组合的插件持有附件这道闸：
 * `src/index.ts` 在 `ctx.inject(['attachments'], …)` 内部调用它，因此该工具只在挂载了
 * 持久化存储时才存在。执行时仍会为直接调用者复查 `ctx.get('attachments')`，
 * 并依据调用路由声明的图片输入做门禁。
 * @param ctx - 注册的作用域；执行时使用它的 `fs` 服务外加可选的
 *   `attachments`/`llm` 服务。
 */
export function applyReadImageTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'read_image',
    description: 'Read a PNG/JPEG/WebP/GIF file and return the image itself. '
      + 'Large images are downscaled automatically; do not install image libraries or create thumbnails to inspect an image.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to the image file, resolved by the filesystem backend.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true, description: 'Canonical absolute path in the filesystem execution world.' },
          image: IMAGE_VALUE_SCHEMA,
        },
      },
      render: (_args, value) => imageReadContent(value),
      // 只持久化已解析的路径。附件引用**不会**复制到这里：落定的 `content` 已经带着包含
      // 完整引用的图片块，因此再复制一份就等于对同一个事实留下两份记录 ——
      // 而且一个合法替换了内容的 `tools/post-execute` 钩子会把那份陈旧副本留在身后，
      // 从而展示出一张结果里早已不再返回的图片。路径需要自己独立的结构化记录，
      // 因为内容只把它作为面向模型的信封文本来承载，而客户端并不解析它。
      presentationMeta: (_args, value) => ({ path: value.path }),
    },
    // 内容寻址的附件写入是幂等的，因此对同一文件的并发读取不会冲突。
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')

      // 所有读取前的门禁都跑在任何文件系统 IO 之前，因此一次拒绝永远不会泄漏局部读取或
      // 附件写入。没有扩展名的路径不声明任何格式，所以只有它的格式检查与部署媒体类型
      // 检查需要等到拿到字节之后。
      const extension = extname(args.file_path).toLowerCase()
      const declared = imageMediaTypeForPath(args.file_path)
      if (declared === undefined && extension !== '') {
        throw new Error(`cannot read "${args.file_path}": the ${extension} extension does not declare a supported image format; read_image accepts PNG/JPEG/WebP/GIF files, including extension-less files in those formats`)
      }
      const attachments = ctx.get('attachments')
      if (attachments === undefined) {
        throw new Error(`cannot read "${args.file_path}" as an image: no attachment service is mounted`)
      }
      if (declared !== undefined) assertDeploymentAccepts(attachments, declared, args.file_path)
      await assertImageCapableRoute(ctx, exec, args.file_path)

      const { target, info } = await resolveRegularReadTarget(ctx, exec, args.file_path)

      // 工具结果是一条消息携带一张图片，因此除单图上限之外，
      // 每消息的聚合上限同样适用。
      const byteCap = Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes)
      const data = await ctx.fs.readBytes(target, exec.signal, byteCap)
      const mediaType = declared ?? sniffImageMediaType(data)
      if (mediaType === undefined) {
        throw new Error(`cannot read "${target.displayPath}": the file content is not a supported image format; read_image accepts PNG/JPEG/WebP/GIF`)
      }
      if (declared === undefined) assertDeploymentAccepts(attachments, mediaType, target.displayPath)
      // 返回之前先持久化：等到 tool/result 事件被追加时，
      // 图片块必须已经引用一个持久提交的对象。
      let ref: ImageAttachmentRef
      try {
        ref = await attachments.saveImage({ data, mediaType, name: basename(target.displayPath) })
      } catch (error: unknown) {
        if (!(error instanceof AttachmentError)) throw error
        // 尺寸类拒绝保持为可恢复的工具错误：一张尺寸过大的图片绝不能进入持久历史，
        // 否则它会混入之后每一次模型请求，绕过提供者侧的尺寸拒绝。
        if (error.code === 'IMAGE_DIMENSION_TOO_LARGE') {
          throw new Error(
            `cannot read "${target.displayPath}": at least one image side exceeds the ${attachments.imageLimits.maxImageDimension}px limit; downscale the image and read the smaller copy`,
            { cause: error },
          )
        }
        if (error.code === 'IMAGE_TOO_MANY_PIXELS') {
          throw new Error(
            `cannot read "${target.displayPath}": the image exceeds the ${attachments.imageLimits.maxImagePixels}-pixel decoded-size limit; downscale the image and read the smaller copy`,
            { cause: error },
          )
        }
        if (error.code === 'IMAGE_TOO_LARGE') {
          throw new Error(
            `cannot read "${target.displayPath}": the image cannot be stored within the deployment's byte limits; downscale the image and read the smaller copy`,
            { cause: error },
          )
        }
        if (error.code === 'ATTACHMENT_WRITE_FAILED' && /16-bit PNG/iu.test(error.message)) {
          throw new Error(
            `cannot read "${target.displayPath}": the 16-bit PNG could not be converted to the normalized 8-bit sRGB form; convert it to an 8-bit PNG/JPEG/WebP and retry`,
            { cause: error },
          )
        }
        if (error.code === 'INVALID_IMAGE' && declared === undefined) {
          throw new Error(
            `cannot read "${target.displayPath}": the bytes do not decode as a supported PNG/JPEG/WebP/GIF image; the file may be truncated or corrupt`,
            { cause: error },
          )
        }
        if (error.code !== 'IMAGE_TYPE_MISMATCH') throw error
        if (declared === undefined) {
          throw new Error(
            `cannot read "${target.displayPath}": the file signature claims ${mediaType}, but the bytes decode as a different image format; the file may be corrupt`,
            { cause: error },
          )
        }
        throw new Error(
          `cannot read "${target.displayPath}": the ${extension} extension declares ${mediaType}, but the bytes use a different image format; rename the file to match its actual format if it is PNG/JPEG/WebP/GIF, or convert it to one of those formats`,
          { cause: error },
        )
      }
      ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
      const value: ImageReadValue = {
        path: ctx.fs.processPath(target),
        image: {
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          ...ref.name === undefined ? {} : { name: ref.name },
          ...ref.originalDimensions === undefined ? {} : {
            originalDimensions: { ...ref.originalDimensions },
          },
        },
      }
      return value
    },
    // 纯展示：read 家族的一张通用卡片，带一个指向该图片文件的跟随位置。
    presentCall(args): GenericCallView {
      return {
        card: 'generic',
        title: `Read image ${args.file_path}`,
        kind: 'read',
        locations: [{ path: args.file_path }],
      }
    },
  }))
}
