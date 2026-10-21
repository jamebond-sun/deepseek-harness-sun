/**
 * Host 侧会话日志下载：流式产出一个 ZIP 归档，其中的文件是各会话的逻辑会话日志
 * 以及每一个被引用的附件。每份日志都通过持久化的读取句柄读取，并在此序列化为
 * 规范的 JSONL——一行头部，随后每个经过校验的事件一行——因此每个后端
 * （JSONL、SQLite 以及未来的实现）导出的结果完全一致。根日志使用当前代次的规范
 * 名称 `session[.vN].jsonl`；每个子代理后代使用 `subagents/<id>/session[.vN].jsonl`；
 * 任何被包含的日志所引用的每张图片位于 `media/<attachmentId>.<ext>`（按内容寻址，
 * 因此一个归档中不会重复出现共享的图片）；每个普通文件位于
 * `files/<prefix>/<digest>/<name>`，并从附件存储流式读出。不写入清单文件。
 * 在读取每个 live 会话的日志之前，SessionStore 的 flush 屏障会让当前的内存日志
 * 变得持久；冷会话不需要该屏障。请求中止与响应消费方取消共用同一个生产者信号，
 * 并终止正在活动的压缩器。
 * 压缩在宿主机上借助 fflate 的流式 Zip API 完成，因此归档字节是增量产生的，
 * 宿主机绝不会把整个归档放在一个缓冲区里；只要响应队列达到其字节高水位线，
 * 生产过程就等待消费方拉取，这样慢消费方会把累积量限制在固定的 64 KiB
 * 响应队列加上一次同步 fflate push 之内。
 * @module
 */

import { Zip, ZipDeflate } from 'fflate'
import type { Context } from '@deepseek-ai/cordis'
import type {
  AttachmentStore, FileAttachmentRef, ImageAttachmentRef,
} from '@deepseek-ai/dsh-attachment'
import type { SessionLineageNode, SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { sessionFormatLogFilename } from '@deepseek-ai/dsh-session-format'
import type { SessionEvent, SessionHeader, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import type { SessionHandle, SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'

/** 会话日志导出所接受的合法 fflate DEFLATE 级别。 */
export type SessionLogCompressionLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9

/** Session 导出配置省略压缩级别时使用的平衡默认值。 */
export const DEFAULT_SESSION_LOG_COMPRESSION_LEVEL: SessionLogCompressionLevel = 6

/** 会话日志导出所需的服务（live 会话存储是可选的）。 */
export interface SessionLogExportDeps {
  readonly sessionQuery: SessionQueryEngine | undefined
  readonly sessionPersistence: SessionPersistence | undefined
  readonly attachments: AttachmentStore | undefined
  readonly sessions: SessionStore | undefined
}

/** 收窄到流式读取真正会用到的、已挂载的那些导出服务。 */
export interface SessionLogExportReady {
  readonly sessionQuery: SessionQueryEngine
  readonly sessionPersistence: SessionPersistence
  readonly attachments: AttachmentStore
  readonly sessions: SessionStore | undefined
}

/**
 * 解析日志导出所需的持久化、session-query 与附件服务。
 * @param ctx - 已组合完成的宿主机上下文。
 * @returns 导出服务（部署未挂载时为 undefined）。
 */
export function sessionLogExportDeps(ctx: Context): SessionLogExportDeps {
  return {
    sessionQuery: ctx.get('sessionQuery'),
    sessionPersistence: ctx.get('sessionPersistence'),
    attachments: ctx.get('attachments'),
    sessions: ctx.get('sessions'),
  }
}

/**
 * 在读取某个当前 live 会话的逻辑日志之前，立刻通过该存储权威的持久化屏障
 * 把它刷出。冷会话或不存在的 id 没有需要刷出的内存工作。
 * @param deps - 导出服务，包含可选的 live 会话存储。
 * @param id - 其产物即将被读取的会话。
 * @param signal - 在 flush 屏障前后都会被观察到的可选取消信号。
 */
export async function flushLiveSessionLog(
  deps: Pick<SessionLogExportDeps, 'sessions'>,
  id: SessionId,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  const sessions = deps.sessions
  if (sessions === undefined) return
  const session = sessions.get(id)
  if (session === undefined) return
  await sessions.flush(session)
  signal?.throwIfAborted()
}

/** 一个被导出的文件：一份序列化的会话日志，或一个被引用的附件对象。 */
export type SessionLogZipEntry =
  | { readonly path: string; readonly content: string }
  | { readonly path: string; readonly data: Uint8Array }
  | { readonly path: string; readonly chunks: AsyncIterable<Uint8Array> }

/** 当前代次中，每份被导出会话日志的规范基础文件名。 */
export const SESSION_LOG_FILENAME = sessionFormatLogFilename(SESSION_FORMAT_VERSION)

/**
 * 把一个会话的逻辑日志序列化为规范的 JSONL 文本：一行头部，随后每个事件一行，
 * 并以换行结尾。
 * @param header - 会话的不可变头部。
 * @param events - 按 seq 顺序排列的、经过校验的已提交事件。
 * @returns JSONL 文本。
 */
export function serializeSessionLog(
  header: SessionHeader,
  events: readonly SessionEvent[],
): string {
  // 与当前 v2 的物理头部保持一致。继承而来的切点已由 `events` 中带标签的
  // session/end-seed 事件表示；磁盘上必须有 `delegationDepth`，
  // 因此顶层省略该深度时取 0。
  /* jscpd:ignore-start -- 有意镜像 JSONL 后端的 `toHeaderLine`：
     导出的文本就是规范的 v2 物理头部行，而这个与后端无关的包
     不能依赖某一个后端的实现。 */
  const lines = [JSON.stringify({
    type: 'session',
    version: header.version,
    id: header.id,
    createdAt: header.createdAt,
    ...header.cwd !== undefined ? { cwd: header.cwd } : {},
    ...header.parentSession !== undefined ? { parentSession: header.parentSession } : {},
    isSeeded: header.isSeeded,
    ...header.origin !== undefined ? { origin: header.origin } : {},
    delegationDepth: header.delegationDepth ?? 0,
    ...header.agentPreset !== undefined ? { agentPreset: header.agentPreset } : {},
  })]
  /* jscpd:ignore-end */
  for (const event of events) lines.push(JSON.stringify(event))
  return `${lines.join('\n')}\n`
}

/**
 * 通过一个读取句柄读取某个会话完整的逻辑日志并将其序列化。该读取只观察已提交的
 * 日志——持久化绝不返回被截断的尾部——并且在一次已完成的 flush 之后的句柄读取
 * 至少能观察到被刷出的前缀。
 * @param persistence - 已挂载的持久化后端。
 * @param id - 要读取的会话。
 * @param signal - 转发给 open 与 read 的可选取消信号。
 * @returns 序列化后的 JSONL 文本；会话不存在时为 `undefined`。
 */
export async function readSessionLogText(
  persistence: SessionPersistence,
  id: SessionId,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const options = signal === undefined ? {} : { signal }
  let handle: SessionHandle
  try {
    handle = await persistence.open(id, 'read', options)
  } catch (error) {
    // 缺失由 `open` 判定；其他任何失败（损坏、格式不受支持、I/O、取消）都保持响亮失败。
    if (error instanceof SessionPersistenceNotFoundError) return undefined
    throw error
  }
  try {
    const { events } = await handle.read(0, undefined, options)
    return serializeSessionLog(handle.header, events)
  } finally {
    await handle.close()
  }
}

/** 每种受支持的位图媒体类型对应的 zip 扩展名。 */
const MEDIA_TYPE_EXTENSIONS: Record<ImageAttachmentRef['mediaType'], string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/**
 * 一个媒体对象的 zip 路径：按不透明的附件 id 做内容寻址，这样共享的图片只落一次，
 * 且日志中的 id 无需清单即可映射回归档条目。
 * @param ref - 来自会话日志的持久引用。
 * @returns 归档路径。
 */
function mediaEntryPath(ref: ImageAttachmentRef): string {
  return `media/${String(ref.attachmentId)}.${MEDIA_TYPE_EXTENSIONS[ref.mediaType]}`
}

/** 保留某个已存储文件引用的摘要与名称的归档路径。 */
function fileEntryPath(ref: FileAttachmentRef): string {
  const digest = String(ref.attachmentId).replace(/^sha256:/u, '')
  const name = ref.name.replace(/[\\/\u0000-\u001f\u007f]/gu, '_')
  const safeName = name === '.' || name === '..' || name === '' ? 'file' : name
  return `files/${digest.slice(0, 2)}/${digest}/${safeName}`
}

/**
 * 从一个已声明的 V4 内容数组中收集直接的附件分块。
 * @param content - 事件或消息的内容数组。
 * @param images - 以附件 id 为键的图片去重表。
 * @param files - 以附件 id 与存储名为键的文件去重表。
 */
function collectAttachmentRefs(
  content: unknown,
  images: Map<string, ImageAttachmentRef>,
  files: Map<string, FileAttachmentRef>,
): void {
  if (!Array.isArray(content)) return
  for (const value of content) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const block = value as { type?: unknown; attachment?: unknown }
    if (block.type === 'image' && typeof block.attachment === 'object' && block.attachment !== null) {
      const ref = block.attachment as ImageAttachmentRef
      images.set(String(ref.attachmentId), ref)
    }
    if (block.type === 'file' && typeof block.attachment === 'object' && block.attachment !== null) {
      const ref = block.attachment as FileAttachmentRef
      files.set(`${String(ref.attachmentId)}\u0000${ref.name}`, ref)
    }
  }
}

/**
 * 只从已声明的第一方内容字段与已完成的 Assistant 分块中收集引用。
 * 未知事件与无关的载荷字段保持不透明。
 * @param event - 一个已解析的 JSONL 事件对象。
 * @param images - 以附件 id 为键的图片去重表。
 * @param files - 以附件 id 与存储名为键的文件去重表。
 */
function collectEventAttachmentRefs(
  event: unknown,
  images: Map<string, ImageAttachmentRef>,
  files: Map<string, FileAttachmentRef>,
): void {
  if (typeof event !== 'object' || event === null || Array.isArray(event)) return
  const row = event as { type?: unknown; data?: unknown }
  const data = row.data
  if (typeof data !== 'object' || data === null) return
  const carrier = data as {
    content?: unknown
    message?: { content?: unknown }
    inserted?: unknown
    summary?: unknown
    rawOutput?: unknown
    stream?: Array<{ type?: unknown; chunk?: { type?: unknown; block?: unknown } }>
  }
  switch (row.type) {
    case 'user/message': case 'tool/ptc-dispatch':
      collectAttachmentRefs(carrier.content, images, files)
      return
    case 'system/message': case 'developer/message': case 'tool/result': case 'team/message/queued':
      collectAttachmentRefs(carrier.message?.content, images, files)
      return
    case 'agent/inbox/spliced': {
      const messages = carrier.inserted
      if (!Array.isArray(messages)) return
      for (const message of messages as readonly unknown[]) {
        if (typeof message !== 'object' || message === null || Array.isArray(message)) continue
        collectAttachmentRefs((message as { readonly content?: unknown }).content, images, files)
      }
      return
    }
    case 'compaction/summary':
      collectAttachmentRefs(carrier.summary, images, files)
      collectAttachmentRefs(carrier.rawOutput, images, files)
      return
    case 'assistant/message':
      collectAttachmentRefs(carrier.message?.content, images, files)
      break
    case 'assistant/attempt': break
    default: return
  }
  if (carrier.stream !== undefined) {
    for (const record of carrier.stream) {
      if (record.type === 'chunk' && record.chunk?.type === 'block-end') {
        collectAttachmentRefs([record.chunk.block], images, files)
      }
    }
  }
}

/**
 * 收集某份已存储产物文本所指明的、互不重复的附件引用。
 * 解析失败的行无法引用附件，会被跳过（无论如何，产物文本本身都逐字导出）。
 * @param content - 已存储的产物文本。
 * @returns 图片与文件的去重表。
 */
function attachmentRefsInArtifact(content: string): {
  readonly images: Map<string, ImageAttachmentRef>
  readonly files: Map<string, FileAttachmentRef>
} {
  const images = new Map<string, ImageAttachmentRef>()
  const files = new Map<string, FileAttachmentRef>()
  for (const line of content.split('\n')) {
    if (line === '') continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    collectEventAttachmentRefs(event, images, files)
  }
  return { images, files }
}

/**
 * 由不可信的会话 id 生成一个安全的 zip 路径片段。会话 id 由宿主机控制，
 * 但品牌类型允许任意非空字符串，因此 `../`、点片段与分隔符字符会在
 * 影响归档条目之前被中和。不同的 id 可能折叠到同一个片段上
 * （宿主机铸造的 UUID 不可能发生 id 冲突，因此不保留唯一性后缀）。
 * @param id - 原始会话 id。
 * @returns 对文件系统安全的单个路径片段。
 */
function safeSessionIdSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_')
}

/**
 * 某个根会话的导出归档文件名。
 * @param sessionId - 根会话 id（会被净化为单个安全路径片段）。
 * @returns 该会话导出归档所用的附件文件名。
 */
export function sessionLogZipFilename(sessionId: string): string {
  return `dsh-session-${safeSessionIdSegment(sessionId)}.zip`
}

/**
 * 按 zip 顺序产出导出条目：首先是预先加载的根日志，然后按谱系顺序产出每个子代理
 * 后代（live 时先刷出，在被产出之前才通过持久化读取句柄读取，消费方前进后即丢弃），
 * 最后是被包含的日志所引用的每个互不重复的附件。图片作为有界的已存储对象被读取
 * 并校验；普通文件则保持经由 ZIP 写入器流式处理。除根之外，宿主机最多同时持有
 * 一份后代日志、一张图片和一个文件分块。
 * @param deps - 已挂载的导出服务（调用方在此之前已对缺失情况返回 500）。
 * @param rootContent - 已序列化的根日志（由调用方读取，这样在流式开始之前
 * 会话缺失的分支就能干净地应答）。
 * @param sessionId - 根会话 id。
 * @param includeDescendants - 是否包含每个子代理后代。
 * @param signal - 转发给谱系、持久化与附件读取的可选取消信号。
 * @returns 按 zip 顺序排列的导出条目。
 */
export async function* sessionLogZipEntries(
  deps: SessionLogExportReady,
  rootContent: string,
  sessionId: SessionId,
  includeDescendants: boolean,
  signal?: AbortSignal,
): AsyncGenerator<SessionLogZipEntry> {
  const media = new Map<string, ImageAttachmentRef>()
  const files = new Map<string, FileAttachmentRef>()
  const rememberAttachments = (content: string): void => {
    const refs = attachmentRefsInArtifact(content)
    for (const [id, ref] of refs.images) media.set(id, ref)
    for (const [id, ref] of refs.files) files.set(id, ref)
  }
  rememberAttachments(rootContent)
  yield { path: SESSION_LOG_FILENAME, content: rootContent }
  if (includeDescendants) {
    const seen = new Set<SessionId>([sessionId])
    const collect = async function* (
      nodes: readonly SessionLineageNode[],
    ): AsyncGenerator<SessionLogZipEntry> {
      for (const node of nodes) {
        signal?.throwIfAborted()
        const id = node.session.header.id
        if (seen.has(id)) continue
        seen.add(id)
        await flushLiveSessionLog(deps, id, signal)
        const content = await readSessionLogText(deps.sessionPersistence, id, signal)
        signal?.throwIfAborted()
        if (content === undefined) {
          throw new Error(`subagent "${id}" has no stored log`)
        }
        rememberAttachments(content)
        yield {
          path: `subagents/${safeSessionIdSegment(id)}/${SESSION_LOG_FILENAME}`,
          content,
        }
        yield* collect(node.descendants)
      }
    }
    const lineage = await deps.sessionQuery.traceSession(sessionId, signal)
    signal?.throwIfAborted()
    yield* collect(lineage.descendants)
  }
  for (const ref of media.values()) {
    signal?.throwIfAborted()
    const stored = await deps.attachments.readImage(ref, signal)
    signal?.throwIfAborted()
    yield { path: mediaEntryPath(ref), data: stored.data }
  }
  for (const ref of files.values()) {
    signal?.throwIfAborted()
    yield {
      path: fileEntryPath(ref),
      chunks: deps.attachments.readFileStream(ref, signal),
    }
  }
}

/** 一次 zip push 携带多少码元的会话日志文本（限制编码内存）。 */
const PUSH_CHUNK_CODE_UNITS = 1 << 16

/** 一次 zip push 携带多少字节的媒体数据（限制内存；图片本身已有大小上限）。 */
const PUSH_CHUNK_BYTES = 1 << 16

/** 在 ZIP 生产过程等待拉取之前，响应流保留的字节容量。 */
const RESPONSE_HIGH_WATER_MARK_BYTES = 1 << 16

/** 一个只在 ReadableStream 拉取恢复容量时才被释放的生产者等待者。 */
class ResponseCapacityGate {
  private releasePending: (() => void) | undefined

  /**
   * 等待响应队列出现正的字节容量，或等待取消生效。
   * @param controller - 其 desiredSize 决定容量的响应控制器。
   * @param signal - 请求/消费方合并后的取消信号。
   */
  async wait(
    controller: ReadableStreamDefaultController<Uint8Array>,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted()
    if (controller.desiredSize === null || controller.desiredSize > 0) return
    await new Promise<void>((resolve) => {
      const release = (): void => {
        this.releasePending = undefined
        signal.removeEventListener('abort', release)
        resolve()
      }
      this.releasePending = release
      signal.addEventListener('abort', release, { once: true })
    })
    signal.throwIfAborted()
  }

  /** 在消费方拉取之后释放当前的生产者等待者。 */
  pulled(): void {
    this.releasePending?.()
  }
}

/**
 * 把某个媒体对象的字节按有界分块推入 deflate 流，像产物路径那样在分块之间
 * 等待消费方容量。
 * @param deflate - 该 zip 条目的 deflate 流。
 * @param data - 已存储的图片字节。
 * @param controller - 响应队列控制器。
 * @param capacity - 由拉取驱动的响应容量闸门。
 * @param signal - 取消信号；被中止时抛出。
 */
async function pushBinaryChunks(
  deflate: ZipDeflate,
  data: Uint8Array,
  controller: ReadableStreamDefaultController<Uint8Array>,
  capacity: ResponseCapacityGate,
  signal: AbortSignal,
): Promise<void> {
  let offset = 0
  do {
    signal.throwIfAborted()
    const end = Math.min(offset + PUSH_CHUNK_BYTES, data.byteLength)
    const finalChunk = end >= data.byteLength
    deflate.push(data.subarray(offset, end), finalChunk)
    offset = end
    await capacity.wait(controller, signal)
  } while (offset < data.byteLength)
}

/** 推送一个流式文件条目，不保留其完整的字节序列。 */
async function pushStreamChunks(
  deflate: ZipDeflate,
  chunks: AsyncIterable<Uint8Array>,
  controller: ReadableStreamDefaultController<Uint8Array>,
  capacity: ResponseCapacityGate,
  signal: AbortSignal,
): Promise<void> {
  for await (const chunk of chunks) {
    signal.throwIfAborted()
    if (chunk.byteLength === 0) continue
    deflate.push(chunk, false)
    await capacity.wait(controller, signal)
  }
  signal.throwIfAborted()
  deflate.push(new Uint8Array(), true)
  await capacity.wait(controller, signal)
}

/**
 * 把某个产物的文本按有界分块推入 deflate 流，绝不把一个代理对拆到分块边界两侧
 * （孤立的高代理项会被重新编码为 U+FFFD，从而静默损坏被导出的产物）。
 * @param deflate - 该 zip 条目的 deflate 流。
 * @param content - 规范的会话日志文本。
 * @param controller - 响应队列控制器。
 * @param capacity - 由拉取驱动的响应容量闸门。
 * @param signal - 取消信号；被中止时抛出。
 */
async function pushArtifactChunks(
  deflate: ZipDeflate,
  content: string,
  controller: ReadableStreamDefaultController<Uint8Array>,
  capacity: ResponseCapacityGate,
  signal: AbortSignal,
): Promise<void> {
  const encoder = new TextEncoder()
  let offset = 0
  let finalChunk: boolean
  do {
    signal.throwIfAborted()
    let end = Math.min(offset + PUSH_CHUNK_CODE_UNITS, content.length)
    if (end < content.length && end - offset > 1) {
      // 当边界落在代理对内部时回退一个码元：这样该代理对会完整地开始下一个分块。
      const last = content.charCodeAt(end - 1)
      if (last >= 0xd800 && last <= 0xdbff) end -= 1
    }
    finalChunk = end >= content.length
    deflate.push(encoder.encode(content.slice(offset, end)), finalChunk)
    offset = end
    await capacity.wait(controller, signal)
  } while (!finalChunk)
}

/**
 * 以 WHATWG ReadableStream 的形式流式输出一个会话日志 ZIP。根日志在调用本函数之前
 * 已由调用方读取并序列化（根缺失或服务缺失会在产生任何字节之前干净地应答）；
 * 随后每个条目在被产出时就按有界分块被编码与 deflate，因此归档字节是增量到达的。
 * 读取失败的后代会让流出错（响亮失败，绝不静默少导出）。
 * @param deps - 已挂载的导出服务（调用方在此之前已对缺失情况返回 500）。
 * @param rootContent - 已序列化的根日志（第一个 zip 条目）。
 * @param sessionId - 根会话 id。
 * @param includeDescendants - 是否包含每个子代理后代。
 * @param compressionLevel - 每个 ZIP 条目所用的、经过校验的 fflate DEFLATE 级别。
 * @param signal - 与响应消费方取消合并后的请求取消信号。
 * @returns zip 字节流。
 */
export function streamSessionLogZip(
  deps: SessionLogExportReady,
  rootContent: string,
  sessionId: SessionId,
  includeDescendants: boolean,
  compressionLevel: SessionLogCompressionLevel,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const consumerAbort = new AbortController()
  const producerSignal = AbortSignal.any([signal, consumerAbort.signal])
  let zip: Zip | undefined
  let zipTerminated = false
  const capacity = new ResponseCapacityGate()
  const terminateZip = (): void => {
    if (zip === undefined || zipTerminated) return
    zipTerminated = true
    zip.terminate()
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      // fflate 每产生一个压缩分块就同步调用该回调，因此单次 push 可能在慢消费方
      // 之前入队；一旦字节队列已满，容量闸门会在两次 push 之间等待拉取，
      // 把累积量限制在队列高水位线加上一次同步 push 之内。
      const archive = new Zip((error, data, final) => {
        /* v8 ignore next 3 -- fflate 只报告内部 zip 失败，对合法输入不可达 */
        if (error) {
          controller.error(error)
          return
        }
        /* v8 ignore next -- fflate 可能产出空分块；测试中无法控制 */
        if (data.byteLength > 0) controller.enqueue(data)
        if (final) controller.close()
      })
      zip = archive
      void (async () => {
        try {
          for await (const entry of sessionLogZipEntries(deps, rootContent, sessionId, includeDescendants, producerSignal)) {
            const deflate = new ZipDeflate(entry.path, { level: compressionLevel })
            archive.add(deflate)
            if ('content' in entry) {
              await pushArtifactChunks(deflate, entry.content, controller, capacity, producerSignal)
            } else if ('data' in entry) {
              await pushBinaryChunks(deflate, entry.data, controller, capacity, producerSignal)
            } else {
              await pushStreamChunks(deflate, entry.chunks, controller, capacity, producerSignal)
            }
          }
          archive.end()
        } catch (error) {
          // 流中途的失败（后代缺失、取消、读取错误）必须让下载失败，
          // 而不是交付一个被截断的归档。
          /* v8 ignore next -- 有类型的后端以 Error reject，而在 Node 中 DOMException 也是 Error */
          terminateZip()
          controller.error(error instanceof Error ? error : new Error(String(error)))
        }
      })()
    },
    pull() {
      capacity.pulled()
    },
    cancel(reason) {
      consumerAbort.abort(
        reason instanceof Error ? reason : new Error('session log export stream cancelled'),
      )
      terminateZip()
    },
  }, {
    highWaterMark: RESPONSE_HIGH_WATER_MARK_BYTES,
    size: chunk => chunk.byteLength,
  })
}
