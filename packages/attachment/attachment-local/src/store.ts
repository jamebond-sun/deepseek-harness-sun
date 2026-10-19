/** 内容寻址的、属主私有的本地附件存储。 */

import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { chmod, link, mkdir, open, readFile, unlink } from 'node:fs/promises'
import { dirname, join, parse, resolve } from 'node:path'
import {
  AttachmentError,
  AttachmentId,
} from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { normalizeImage } from './normalization.ts'
import type { NormalizationPolicy } from './normalization.ts'
import { detectImage, probeImage } from './image.ts'
import type { DetectedImage } from './image.ts'

const ID_PATTERN = /^sha256:([a-f0-9]{64})$/
const durableHomes = new Set<string>()

function digest(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function displayName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  // 手动剥离两种分隔符样式：POSIX 宿主把 `\` 当作普通字符，
  // 因此 path.basename 会保留 Windows 客户端的完整本地路径，
  // 并将其泄露到引用和 session 日志中。
  const leaf = value.slice(Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\')) + 1)
  const clean = leaf.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255)
  return clean === '' ? undefined : clean
}

function ensureReference(ref: ImageAttachmentRef): string {
  const match = ID_PATTERN.exec(String(ref.attachmentId))
  if (match?.[1] === undefined) throw new AttachmentError('Attachment reference is invalid.', 'INVALID_ATTACHMENT_REF')
  return match[1]
}

/**
 * 推导一个归一化附件的绝对不可变对象路径。
 * @param root - 绝对的 `DSH_HOME/attachments/v1` 根目录。
 * @param ref - 持久的归一化附件引用。
 * @returns 提供方本地路径，不读取对象本身。
 */
export function normalizedImagePath(root: string, ref: ImageAttachmentRef): string {
  const sha256 = ensureReference(ref)
  return join(root, 'objects', sha256.slice(0, 2), sha256)
}

async function inspectMetadata(
  data: Uint8Array,
  declaredMediaType: ImageAttachmentRef['mediaType'],
  limits: ImageAttachmentLimits,
): Promise<DetectedImage> {
  if (data.byteLength === 0) throw new AttachmentError('Image is empty.', 'INVALID_IMAGE')
  const detected = await detectImage(data, { maxPixels: limits.maxImagePixels, maxDimension: limits.maxImageDimension })
  if (detected.mediaType !== declaredMediaType) throw new AttachmentError('Declared image type does not match its bytes.', 'IMAGE_TYPE_MISMATCH')
  return detected
}

/**
 * 对一张图像执行完整准入策略而不触碰存储，包括归一化：
 * 若批次内所有成员都通过校验，发布阶段就不会再被归一化图像
 * 字节上限拒绝。
 * @param input - 编码字节与声明的元数据。
 * @param limits - 已解析的源准入策略。
 * @param policy - 已解析的归一化策略。
 * @returns 栅格完成解码且其归一化版本被证明符合目标后完成。
 */
export async function validateImageFile(
  input: SaveImageAttachment,
  limits: ImageAttachmentLimits,
  policy: NormalizationPolicy,
): Promise<void> {
  await prepareImageFile(input, limits, policy)
}

/** 完全准备好的归一化对象，在任何批次成员持久化之前经过校验。 */
export interface PreparedImageFile {
  /** 确定性的归一化字节，其摘要为 {@link ref.attachmentId}。 */
  data: Uint8Array
  /** 描述 {@link data} 的持久引用。 */
  ref: ImageAttachmentRef
}

/**
 * 解码、归一化并校验一张提交的图像，不触碰存储。
 * @param input - 提交的编码字节与声明的媒体类型。
 * @param limits - 源准入策略。
 * @param policy - 独立的归一化策略。
 * @returns 不可变的引用事实，以及随时可原子发布的字节。
 */
export async function prepareImageFile(
  input: SaveImageAttachment,
  limits: ImageAttachmentLimits,
  policy: NormalizationPolicy,
): Promise<PreparedImageFile> {
  if (input.data.byteLength > limits.maxImageBytes) {
    throw new AttachmentError('Image exceeds the configured byte limit.', 'IMAGE_TOO_LARGE')
  }
  const detected = await inspectMetadata(input.data, input.mediaType, limits)
  const normalized = await normalizeImage(input.data, detected, policy)
  const sha256 = digest(normalized.data)
  const name = displayName(input.name)
  const downscaled = detected.width !== normalized.width || detected.height !== normalized.height
  return {
    data: normalized.data,
    ref: {
      attachmentId: AttachmentId(`sha256:${sha256}`),
      mediaType: normalized.mediaType,
      width: normalized.width,
      height: normalized.height,
      bytes: normalized.data.byteLength,
      ...(name !== undefined ? { name } : {}),
      ...downscaled ? { originalDimensions: { width: detected.width, height: detected.height } } : {},
    },
  }
}

/**
 * 使目录的目录项持久化（对只读目录句柄执行 fsync）。
 * 若文件的目录项从未落盘，仅同步文件本身无法在崩溃后存留，
 * 因此在报告持久引用之前先同步发布目录。
 */
async function syncDirectory(path: string): Promise<void> {
  /* v8 ignore next -- Windows 无法打开目录句柄；该平台上的目录项持久性由 NTFS 元数据日志保障。 */
  if (process.platform === 'win32') return
  /* v8 ignore start -- Windows 无法执行目录 fsync；POSIX 行为测试覆盖这一对等行为。 */
  const handle = await open(path, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  /* v8 ignore stop */
}

/**
 * 创建一棵私有目录树，并把每一级祖先目录项持久化到调用方担保的
 * 持久边界。遍历刻意忽略 mkdir 报告的"新建"结果：并发的首次保存
 * 可能创建了某一级目录而本进程只是观测到它，因此"已存在"不等于
 * "已持久化"——该目录项在创建方可能仍未同步，一旦崩溃就会丢掉
 * session 检查点已引用的目录。重复同步已持久的目录项无害；
 * 跳过未同步的则不行。
 * @param path - 要创建的绝对路径目录。
 * @param boundary - 调用方担保已持久的绝对路径祖先目录。
 */
async function ensureDurableDirectory(path: string, boundary: string): Promise<void> {
  const target = resolve(path)
  const stop = resolve(boundary)
  await mkdir(target, { recursive: true, mode: 0o700 })
  await chmod(target, 0o700)
  let level = target
  while (level !== stop) {
    const parent = dirname(level)
    await syncDirectory(parent)
    /* v8 ignore next -- 文件系统根防护：调用方传入的边界是 path 的祖先，因此遍历会先到达它。 */
    if (parent === level) return
    level = parent
  }
}

/**
 * 为本进程建立证明：DSH_HOME 目录项以及文件系统根之下的每一级祖先
 * 都已持久化。仅仅存在并不足够：并发进程可能已创建该目录，
 * 但尚未同步其父目录。
 */
async function ensureDurableHome(path: string): Promise<string> {
  const home = resolve(path)
  if (!durableHomes.has(home)) {
    await ensureDurableDirectory(home, parse(home).root)
    durableHomes.add(home)
  }
  return home
}

/**
 * 在版本化附件根目录下发布一个已校验的归一化图像。
 * @param root - 绝对的 `DSH_HOME/attachments/v1` 根目录。
 * @param prepared - 确定性的归一化字节与引用。
 * @returns 持久的内容寻址归一化图像引用。
 */
export async function commitPreparedImageFile(
  root: string,
  prepared: PreparedImageFile,
): Promise<ImageAttachmentRef> {
  const normalized = prepared.data
  const sha256 = ensureReference(prepared.ref)
  if (digest(normalized) !== sha256 || normalized.byteLength !== prepared.ref.bytes) {
    throw new AttachmentError('Prepared attachment bytes do not match their reference.', 'ATTACHMENT_CORRUPT')
  }
  await publishImmutableObject(root, normalizedImagePath(root, prepared.ref), normalized, sha256)
  return prepared.ref
}

/**
 * 在版本化附件根目录下发布一个不可变的内容寻址对象：暂存写入、fsync、
 * 硬链接到位、经摘要校验的 EEXIST 去重、只读模式，以及从目标父目录
 * 到（不含）`root` 的持久目录项。
 * @param root - 绝对的 `DSH_HOME/attachments/v1` 根目录。
 * @param target - `root` 之下的绝对最终对象路径。
 * @param data - 确切的对象字节，其摘要为 `sha256`。
 * @param sha256 - 去重时存储字节必须匹配的十六进制摘要。
 */
export async function publishImmutableObject(
  root: string,
  target: string,
  data: Uint8Array,
  sha256: string,
): Promise<void> {
  const staged = await stageImmutableObject(root, (function* (): Iterable<Uint8Array> {
    yield data
  })())
  if (staged.sha256 !== sha256) {
    await removeTemporary(staged.path)
    throw new AttachmentError('Attachment bytes do not match their publication digest.', 'ATTACHMENT_CORRUPT')
  }
  await publishStagedObject(root, target, staged)
}

/** 将一个不可变对象流式写入磁盘时产生的摘要与字节数。 */
export interface StreamedImmutableObject {
  readonly sha256: string
  readonly bytes: number
}

/**
 * 将一个不可变对象从有界分块流式写入暂存文件，然后在摘要推导的
 * 目标路径发布，无需在内存中收集完整对象。
 * @param root - 绝对的 `DSH_HOME/attachments/v1` 根目录。
 * @param data - 按顺序的确切对象字节。
 * @param targetFor - 由完成的摘要与字节数推导最终绝对目标路径。
 * @param signal - 可选的取消信号，作用于源读取与存储写入。
 * @returns 已发布对象的摘要与确切字节数。
 */
export async function publishImmutableObjectStream(
  root: string,
  data: AsyncIterable<Uint8Array>,
  targetFor: (sha256: string, bytes: number) => string,
  signal?: AbortSignal,
): Promise<StreamedImmutableObject> {
  const staged = await stageImmutableObject(root, data, signal)
  let target: string
  try {
    target = targetFor(staged.sha256, staged.bytes)
  } catch (error) {
    /* v8 ignore start -- 本地 target 回调用本函数的摘要构造一个已校验的引用。 */
    await removeTemporary(staged.path)
    throw error
    /* v8 ignore stop */
  }
  await publishStagedObject(root, target, staged)
  return { sha256: staged.sha256, bytes: staged.bytes }
}

/**
 * 为一个已存在的不可变对象发布另一个持久的硬链接名称。
 * @param root - 绝对的版本化附件根目录。
 * @param source - `root` 之下已存在的内容寻址对象。
 * @param target - `root` 之下的新别名。
 * @param sha256 - 目标已存在竞态下期望的对象摘要。
 */
export async function publishImmutableAlias(
  root: string,
  source: string,
  target: string,
  sha256: string,
): Promise<void> {
  const parent = dirname(target)
  try {
    const boundary = await ensureDurableHome(dirname(dirname(resolve(root))))
    await ensureDurableDirectory(parent, boundary)
    try {
      await link(source, target)
    } catch (error) {
      /* v8 ignore next -- 私有的同文件系统目录使 EEXIST 成为唯一可恢复的链接竞态。 */
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      if (await digestFile(target) !== sha256) {
        throw new AttachmentError('Stored attachment failed integrity verification.', 'ATTACHMENT_CORRUPT')
      }
    }
    await chmod(target, 0o400)
    const stop = resolve(root)
    for (let level = parent; level !== stop; level = dirname(level)) {
      await syncDirectory(level)
      /* v8 ignore next -- 文件系统根防护：目标位于 root 之下，因此遍历会先到达 `stop`。 */
      if (dirname(level) === level) break
    }
  } catch (error) {
    if (error instanceof AttachmentError) throw error
    throw new AttachmentError('Unable to persist attachment.', 'ATTACHMENT_WRITE_FAILED', { cause: error })
  }
}

interface StagedImmutableObject extends StreamedImmutableObject {
  readonly path: string
  readonly boundary: string
}

async function stageImmutableObject(
  root: string,
  data: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  signal?: AbortSignal,
): Promise<StagedImmutableObject> {
  const staging = join(root, 'tmp')
  // 每个进程针对文件系统根为 DSH_HOME 本身建立一次证明。
  // 每个进程独立执行该证明，因此观测到另一个进程创建的目录
  // 绝不会被误认为持久化发布。
  const boundary = await ensureDurableHome(dirname(dirname(resolve(root))))
  await ensureDurableDirectory(staging, boundary)
  const temporary = join(staging, randomUUID())
  let handle
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    const hash = createHash('sha256')
    let bytes = 0
    for await (const chunk of data) {
      signal?.throwIfAborted()
      await handle.writeFile(chunk)
      hash.update(chunk)
      bytes += chunk.byteLength
    }
    signal?.throwIfAborted()
    await handle.sync()
    signal?.throwIfAborted()
    await handle.close()
    handle = undefined
    return { path: temporary, boundary, sha256: hash.digest('hex'), bytes }
  } catch (error) {
    /* v8 ignore next -- 仅当写入、同步或关闭失败时描述符才会保持打开。 */
    if (handle !== undefined) await handle.close().catch(
      /* v8 ignore next -- 关闭失败会被进入清理流程的存储操作所取代。 */
      () => {},
    )
    await removeTemporary(temporary)
    if (error instanceof AttachmentError || signal?.aborted === true) throw error
    throw new AttachmentError('Unable to persist attachment.', 'ATTACHMENT_WRITE_FAILED', { cause: error })
  }
}

async function publishStagedObject(
  root: string,
  target: string,
  staged: StagedImmutableObject,
): Promise<void> {
  const parent = dirname(target)
  try {
    await ensureDurableDirectory(parent, staged.boundary)
    try {
      await link(staged.path, target)
    } catch (error) {
      /* v8 ignore next -- 私有的同文件系统目录使 EEXIST 成为唯一可恢复的链接竞态。 */
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      if (await digestFile(target) !== staged.sha256) {
        throw new AttachmentError('Stored attachment failed integrity verification.', 'ATTACHMENT_CORRUPT')
      }
    }
    // Windows 在硬链接之间共享只读属性，一旦设置便拒绝解除任一名称的
    // 链接，因此先丢弃暂存名称。
    await unlink(staged.path)
    // 对新对象而言目标仍是唯一的链接；当去重路径观测到已存在的对象时，
    // 这一步也会恢复只读模式。
    await chmod(target, 0o400)
    // 在引用进入 session 检查点之前，持久化目标目录项并关闭所有并发
    // 创建父目录的窗口。去重路径会重复这些同步，因为它可能在另一个
    // 写入方到达自身持久化边界之前观测到其链接。
    const stop = resolve(root)
    for (let level = parent; level !== stop; level = dirname(level)) {
      await syncDirectory(level)
      /* v8 ignore next -- 文件系统根防护：目标位于 root 之下，因此遍历会先到达 `stop`。 */
      if (dirname(level) === level) break
    }
  } catch (error) {
    await removeTemporary(staged.path)
    if (error instanceof AttachmentError) throw error
    throw new AttachmentError('Unable to persist attachment.', 'ATTACHMENT_WRITE_FAILED', { cause: error })
  }
}

async function digestFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) hash.update(chunk)
  return hash.digest('hex')
}

async function removeTemporary(path: string): Promise<void> {
  await unlink(path).catch(
    /* v8 ignore next -- 链接成功后，清理可能观测到已被移除的暂存名称。 */
    (cleanupError: unknown) => {
      /* v8 ignore next -- 除暂存名称不存在之外的任何清理失败都必须保持可见。 */
      if (!(cleanupError instanceof Error && 'code' in cleanupError && cleanupError.code === 'ENOENT')) throw cleanupError
    },
  )
}

/**
 * 对一张图像解码并归一化一次，然后发布准备好的对象。
 * @param root - 绝对的 `DSH_HOME/attachments/v1` 根目录。
 * @param input - 提交的编码字节与声明的媒体类型。
 * @param limits - 已解析的源准入策略。
 * @param policy - 已解析的归一化策略。
 * @returns 持久的内容寻址归一化图像引用。
 */
export async function saveImageFile(
  root: string,
  input: SaveImageAttachment,
  limits: ImageAttachmentLimits,
  policy: NormalizationPolicy,
): Promise<ImageAttachmentRef> {
  return commitPreparedImageFile(root, await prepareImageFile(input, limits, policy))
}

/**
 * 读取并校验一个内容寻址图像。
 * @param root - 绝对的 `DSH_HOME/attachments/v1` 根目录。
 * @param ref - 记录在 session 日志中的引用。
 * @param signal - 可选的取消信号，作用于文件系统与校验工作。
 * @returns 校验通过的字节与引用。
 * @throws 中止时抛出信号原因，校验失败时抛出 AttachmentError。
 */
export async function readImageFile(
  root: string,
  ref: ImageAttachmentRef,
  signal?: AbortSignal,
): Promise<StoredImageAttachment> {
  signal?.throwIfAborted()
  const sha256 = ensureReference(ref)
  let data: Uint8Array
  try {
    data = new Uint8Array(await readFile(normalizedImagePath(root, ref), { signal }))
  } catch (error) {
    signal?.throwIfAborted()
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new AttachmentError('Attachment object is missing.', 'ATTACHMENT_NOT_FOUND')
    throw new AttachmentError('Unable to read image attachment.', 'ATTACHMENT_READ_FAILED', { cause: error })
  }
  signal?.throwIfAborted()
  if (digest(data) !== sha256) throw new AttachmentError('Stored attachment failed integrity verification.', 'ATTACHMENT_CORRUPT')
  // 摘要证明这些字节正是准入阶段完整解码的字节，因此读取路径只需
  // 重新推导头部字段（无需栅格解码，历史回放也不会产生按请求
  // 放大的像素开销）。
  const metadata = await probeImage(data)
  signal?.throwIfAborted()
  if (metadata.mediaType !== ref.mediaType || data.byteLength !== ref.bytes
    || metadata.width !== ref.width || metadata.height !== ref.height) {
    throw new AttachmentError('Stored attachment metadata does not match its reference.', 'ATTACHMENT_CORRUPT')
  }
  return { ref, data }
}
