/** 带可复用转换器与私有磁盘输入/输出的 Host LibreOffice kit 提供方。 */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, isAbsolute, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createConverter, type Converter, type ConverterOptions } from '@deepseek-ai/libreoffice-kit'
import z from '@deepseek-ai/schemastery'
import type { WorkspaceFileScope, WorkspaceFileStat } from '@deepseek-ai/dsh-api-workspace-files'
import type {} from '@deepseek-ai/dsh-fs'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { OfficeToPdfError } from './errors.ts'
import { OfficeToPdfGeneration, type OfficeSourceKey } from './identity.ts'
import type { OfficeExtension, OfficeToPdfRequest, OfficeToPdfResult, OfficeToPdfPriority, RenderedDocumentBytes } from './types.ts'
import { readPdf } from './output.ts'
import { ConversionQueue } from './queue.ts'

export * from './errors.ts'
export * from './identity.ts'
export * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 共享的 Office 转换与经授权的 workspace 文件渲染。 */
    officeToPdf: OfficeToPdf
  }
}

/** 提供方的并发与 kit 渲染/字体配置。 */
export interface Config {
  /** 最大同时转换数；已排队的调用方仍可取消。 */
  maxConcurrentConversions: number
  /** 等待源接纳的最大仅元数据作业数。 */
  maxQueuedJobs: number
  /** 最大未完成的转换读取器数。 */
  maxReaders: number
  /** 已接纳的源读取与转换所预留的最大字节数。 */
  maxSourceBytes: number
  /** 最大并发后台作业数；为零则拒绝推测性工作。 */
  maxBackgroundConversions: number
  /** 保留的最大内容寻址 PDF 数。 */
  maxCachedEntries: number
  /** 保留的最大 PDF 字节数。 */
  maxCachedBytes: number
  /** 保留到已缓存内容的最大源版本别名数。 */
  maxSourceEntries: number
  /** 转换截止时间（毫秒）；不含 DSH 队列。 */
  timeoutMs: number
  /** 最大授权的源字节数。 */
  maxInputBytes: number
  /** 最大完整 PDF 字节数。 */
  maxOutputBytes: number
  /** 导出的光栅图像 DPI。 */
  maxImageResolution: number
  /** 最大 OOXML ZIP 条目数。 */
  maxArchiveEntries: number
  /** 最大的声明未压缩 OOXML 字节总数。 */
  maxUncompressedBytes: number
  /** 绝对字体根目录；省略则使用 kit 的平台默认值。 */
  fontDirectories?: string[]
  /** 有序的字体系列偏好分组；省略则保留 kit 默认值。 */
  fontFallbacks?: string[][]
  /** 每个转换器索引的最大物理字体文件数。 */
  maxFontFiles: number
  /** 单个字体文件的最大字节数。 */
  maxFontFileBytes: number
  /** 一次转换所加载的原始字体最大字节数。 */
  maxLoadedFontBytes: number
}

/** 在提供方构造之前解析的部署默认值。 */
export const Config: z<Partial<Config>, Config> = z.object({
  maxConcurrentConversions: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(2),
  maxQueuedJobs: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(8),
  maxReaders: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(32),
  maxSourceBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(104857600),
  maxBackgroundConversions: z.natural().min(0).max(Number.MAX_SAFE_INTEGER).default(1),
  maxCachedEntries: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(8),
  maxCachedBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(134217728),
  maxSourceEntries: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(64),
  timeoutMs: z.natural().min(1).max(2_147_483_647).default(60_000),
  maxInputBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER - 1).default(50 * 1024 * 1024),
  maxOutputBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER - 1).default(100 * 1024 * 1024),
  maxImageResolution: z.natural().min(1).max(2_147_483_647).default(192),
  maxArchiveEntries: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(10_000),
  maxUncompressedBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(250 * 1024 * 1024),
  fontDirectories: z.array(z.string().min(1)).extra('default', undefined),
  fontFallbacks: z.array(z.array(z.string().pattern(/\S/)).min(2)).extra('default', undefined),
  maxFontFiles: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(20_000),
  maxFontFileBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(256 * 1024 * 1024),
  maxLoadedFontBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(512 * 1024 * 1024),
})

interface Slot {
  busy: boolean
  converter?: Promise<Converter>
}

/** 一个提供方生命周期拥有全部转换器、已排队调用与临时文件。 */
export class OfficeToPdf extends TypertRemoteService {
  static Config = Config
  /** 每当引擎、字体或转换配置被替换时都会变化。 */
  readonly generation: OfficeToPdfGeneration = OfficeToPdfGeneration(randomUUID())
  private readonly remoteLifetime = new AbortController()
  private readonly remoteRequests = new Set<Promise<RenderedDocumentBytes>>()
  private readonly slots: Slot[] = []
  private readonly queue: ConversionQueue
  private readonly options: ConverterOptions

  /**
   * @param ctx - 拥有的 Host 上下文。
   * @param config - 已解析的渲染、字体与并发上限。
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'officeToPdf')
    if (config.fontDirectories?.some(path => !isAbsolute(path))) throw new Error('fontDirectories must contain absolute paths.')
    if (config.maxSourceBytes < config.maxInputBytes) throw new Error('maxSourceBytes must be at least maxInputBytes.')
    const { fontDirectories, fontFallbacks, timeoutMs, maxInputBytes, maxOutputBytes, maxImageResolution,
      maxArchiveEntries, maxUncompressedBytes, maxFontFiles, maxFontFileBytes, maxLoadedFontBytes } = config
    this.options = { timeoutMs, maxInputBytes, maxOutputBytes, maxImageResolution, maxArchiveEntries, maxUncompressedBytes,
      maxFontFiles, maxFontFileBytes, maxLoadedFontBytes,
      ...(fontDirectories === undefined ? {} : { fontDirectories }),
      ...(fontFallbacks === undefined ? {} : { fontFallbacks }),
    }
    this.queue = new ConversionQueue(config, this.generation, (bytes, extension, signal) => this.convertBytes(bytes, extension, signal))
    ctx.effect(() => async () => {
      this.remoteLifetime.abort()
      await this.queue.dispose()
      await Promise.allSettled(this.remoteRequests)
      const results = await Promise.allSettled(this.slots.map(async (slot) => {
        const converter = await slot.converter
        await converter?.dispose()
      }))
      const failures = results.filter(result => result.status === 'rejected')
      if (failures.length > 0) throw new AggregateError(failures.map((result): unknown => result.reason), 'LibreOffice converter disposal failed.')
    })
  }

  /**
   * 转换 Office 字节，但不修改源，也不写入 Session 事件。
   * @param request - 经授权的元数据与延迟的有界源读取。
   * @param signal - 调用方取消；提供方释放也会停止活跃工作。
   * @returns 转换与临时清理落定之后的、调用方拥有的 PDF 字节；被取消的读取器独立拒绝。
   * @throws {OfficeToPdfError} 无效输入、不可用输出或引擎失败；取消以其原因拒绝。
   */
  convert(request: OfficeToPdfRequest, signal?: AbortSignal): Promise<OfficeToPdfResult> {
    return this.queue.read(request, signal)
  }

  /**
   * 使用 Session 的普通文件系统授权读取并转换一个 Office 文件。
   * @param workspaceFileScope - 与 workspaceFiles 共享的 Session 头部查询。
   * @param path - 绝对或相对于 workspace 的 Office 路径。
   * @param priority - 前台预览或推测性的后台工作。
   * @param signal - 远程取消；释放也会取消未完成的读取与转换。
   * @returns 带有原始源标识与缺失字体系列的完整 PDF 字节。
   */
  @Remote
  async render(
    workspaceFileScope: WorkspaceFileScope, path: string, priority: OfficeToPdfPriority, signal: AbortSignal,
  ): Promise<RenderedDocumentBytes> {
    const upstream = AbortSignal.any([signal, this.remoteLifetime.signal])
    const operation = this.renderFile(workspaceFileScope, path, priority, upstream)
    this.remoteRequests.add(operation)
    try { return await operation } finally { this.remoteRequests.delete(operation) }
  }

  /**
   * 在复用 Client PDF 之前读取当前的渲染生成。
   * @param signal - 远程调用方取消。
   * @returns 提供方生命周期，会在渲染、字体或引擎配置变更时被替换。
   */
  @Remote('generation')
  getGeneration(signal: AbortSignal): OfficeToPdfGeneration { signal.throwIfAborted(); return this.generation }

  private async renderFile(
    scope: WorkspaceFileScope, path: string, priority: OfficeToPdfPriority, signal: AbortSignal,
  ): Promise<RenderedDocumentBytes> {
    try {
      signal.throwIfAborted()
      const extension = extname(path).slice(1).toLowerCase()
      if (extension !== 'doc' && extension !== 'docx' && extension !== 'xls'
        && extension !== 'xlsx' && extension !== 'ppt' && extension !== 'pptx') {
        throw new OfficeToPdfError('unsupported-format', 'The path must end in doc, docx, xls, xlsx, ppt, or pptx.')
      }
      const files = this.ctx.get('workspaceFiles')
      const fs = this.ctx.get('fs')
      if (files === undefined || fs === undefined) throw new OfficeToPdfError('unavailable', 'Office file rendering requires workspaceFiles and fs.')
      const authorized = await files.readBytes(scope, path, { range: { offset: 0, length: 1 } }, signal)
      const source = await files.stat(scope, path, signal)
      const assertUnchanged = (current: WorkspaceFileStat): void => {
        if (current.absolutePath !== source.absolutePath || current.version !== source.version) {
          throw new OfficeToPdfError('source-changed', 'The source changed.')
        }
      }
      assertUnchanged(authorized)
      signal.throwIfAborted()
      const result = await this.convert({ extension, priority, source: {
        key: brandString<OfficeSourceKey>(JSON.stringify([scope.sessionId, scope.workspaceRoot, source.absolutePath])),
        version: source.version, ...(source.bytes === undefined ? {} : { bytes: source.bytes }),
        read: async (upstream, maxBytes) => {
          const target = await fs.resolve(source.absolutePath, { signal: upstream })
          const info = await fs.stat(target, upstream)
          if (info === undefined || info.type !== 'file') throw new OfficeToPdfError('source-changed', 'The source changed.')
          assertUnchanged({ absolutePath: fs.processPath(target), version: info.version })
          const bytes = await fs.readBytes(target, upstream, maxBytes).catch(async (cause: unknown) => {
            if (typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'FS_TOO_LARGE') {
              assertUnchanged(await files.stat(scope, path, upstream))
              throw new OfficeToPdfError('input-too-large', 'The source exceeds the reserved byte capacity.', { cause })
            }
            throw cause
          })
          upstream.throwIfAborted()
          const after = await files.stat(scope, path, upstream)
          assertUnchanged(after)
          return { bytes, version: source.version }
        },
      } }, signal)
      signal.throwIfAborted()
      return { absolutePath: source.absolutePath, version: source.version,
        offset: 0, eof: true, bytes: result.pdf.byteLength, data: result.pdf,
        missingFonts: result.missingFonts, generation: result.generation }
    } catch (cause) {
      if (signal.aborted) throw new RemoteError('gateway/cancelled', 'The document preview was cancelled.', {}, { cause })
      if (cause instanceof OfficeToPdfError) {
        throw new RemoteError('document-render/failed', 'Office conversion failed.', { reason: cause.code }, { cause })
      }
      throw cause
    }
  }

  private async convertBytes(bytes: Uint8Array, extension: OfficeExtension, signal: AbortSignal): Promise<Pick<OfficeToPdfResult, 'pdf' | 'missingFonts'>> {
    signal.throwIfAborted()
    let slot = this.slots.find(candidate => !candidate.busy)
    if (slot === undefined) { slot = { busy: false }; this.slots.push(slot) }
    slot.busy = true
    let directory: string | undefined
    try {
      if (slot.converter === undefined) {
        slot.converter = createConverter(this.options).catch((error: unknown) => {
          delete slot.converter
          throw error
        })
      }
      const converter = await slot.converter
      signal.throwIfAborted()
      directory = await mkdtemp(join(tmpdir(), 'dsh-office-to-pdf-'))
      const inputPath = join(directory, `source.${extension}`)
      const outputPath = join(directory, 'converted.pdf')
      await writeFile(inputPath, bytes, { flag: 'wx', mode: 0o600, signal })
      signal.throwIfAborted()
      const result = await converter.render({ inputPath, outputPath }, signal)
      signal.throwIfAborted()
      let pdf: Uint8Array
      try { pdf = await readPdf(outputPath, this.config.maxOutputBytes, signal) }
      catch (cause) {
        if (cause instanceof OfficeToPdfError) throw cause
        throw new OfficeToPdfError('invalid-output', 'The converter PDF could not be read.', { cause })
      }
      signal.throwIfAborted()
      return { pdf, missingFonts: result.missingFonts }
    } catch (cause) {
      signal.throwIfAborted()
      if (cause instanceof OfficeToPdfError) throw cause
      const code = typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined
      switch (code) {
        case 'input-too-large': case 'output-too-large': case 'invalid-document': case 'unsupported-format':
        case 'invalid-output': case 'timeout': case 'unavailable':
          throw new OfficeToPdfError(code, 'LibreOffice conversion failed.', { cause })
        default: throw new OfficeToPdfError('failed', 'LibreOffice conversion failed.', { cause })
      }
    } finally {
      try { if (directory !== undefined) await rm(directory, { recursive: true, force: true }) }
      finally { slot.busy = false }
    }
  }
}

export default OfficeToPdf
