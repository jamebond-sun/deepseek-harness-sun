/** 逐字节保留的内容寻址本地文件存储。@module @deepseek-ai/dsh-attachment-local/file-store */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { AttachmentError, AttachmentId } from '@deepseek-ai/dsh-attachment'
import type {
  FileAttachmentRef, SaveFileAttachment, SaveFileStreamAttachment,
} from '@deepseek-ai/dsh-attachment'
import {
  publishImmutableAlias, publishImmutableObject, publishImmutableObjectStream,
} from './store.ts'

const FILE_ID_PATTERN = /^sha256:([a-f0-9]{64})$/
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu

function isWindowsDeviceName(name: string): boolean {
  const dot = name.indexOf('.')
  const stem = (dot < 0 ? name : name.slice(0, dot)).replace(/[. ]+$/u, '')
  return WINDOWS_DEVICE_NAME.test(stem)
}

function utf8Prefix(value: string, maxBytes: number): string {
  let bytes = 0
  let prefix = ''
  for (const character of Buffer.from(value).toString('utf8')) {
    const characterBytes = Buffer.byteLength(character)
    if (bytes + characterBytes > maxBytes) break
    prefix += character
    bytes += characterBytes
  }
  return prefix
}

/**
 * 将调用方的显示名称净化为安全的存储叶名称。两种分隔符样式都被手动剥离：
 * POSIX 宿主把 `\` 当作普通字符，因此 path.basename 会保留 Windows
 * 客户端的完整本地路径，并将其泄露到引用和 session 日志中。
 * Windows 拒绝出现在文件名中的字符替换为 `_`，使一个引用在
 * 每个受支持的宿主上都保持有效。
 * @param value - 调用方声明的显示名称，可能是完整的客户端路径。
 * @returns 在每个受支持文件系统上都可安全存储的非空叶名称。
 */
export function fileLeafName(value: string | undefined): string {
  if (value === undefined) return 'file'
  const leaf = value.slice(Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\')) + 1)
  let clean = leaf
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .trim()
    .replace(/[. ]+$/u, '')
  if (isWindowsDeviceName(clean)) clean = `_${clean}`
  clean = utf8Prefix(clean, 255).replace(/[. ]+$/u, '')
  return clean === '' || clean === '.' || clean === '..' ? 'file' : clean
}

function ensureFileReference(ref: FileAttachmentRef): string {
  const match = FILE_ID_PATTERN.exec(String(ref.attachmentId))
  if (match?.[1] === undefined || ref.name !== fileLeafName(ref.name)) {
    throw new AttachmentError('File attachment reference is invalid.', 'INVALID_ATTACHMENT_REF')
  }
  return match[1]
}

/**
 * 推导一个已存储文件的绝对不可变对象路径。摘要充当目录名，
 * 净化后的显示名称保持为存储叶名称，为模型和用户提供以真实
 * 文件名结尾的路径。
 * @param root - 绝对的 `DSH_HOME/attachments/v1` 根目录。
 * @param ref - 来自 session 日志或上传回执的持久文件引用。
 * @returns 提供方本地路径，不读取对象本身。
 * @throws 引用摘要或名称无效时抛出 AttachmentError。
 */
export function storedFilePath(root: string, ref: FileAttachmentRef): string {
  const sha256 = ensureFileReference(ref)
  return join(root, 'files', sha256.slice(0, 2), sha256, ref.name)
}

/** 同一摘要下所有显示名称共享的规范对象路径。 */
function storedFileObjectPath(root: string, sha256: string): string {
  return join(root, 'file-objects', sha256.slice(0, 2), sha256)
}

/**
 * 在版本化附件根目录下逐字节提交一个文件。
 * @param root - 绝对的 `DSH_HOME/attachments/v1` 根目录。
 * @param input - 确切的字节与可选的显示名称。
 * @returns 持久的内容寻址文件引用。
 */
export async function saveFileVerbatim(
  root: string,
  input: SaveFileAttachment,
): Promise<FileAttachmentRef> {
  const sha256 = createHash('sha256').update(input.data).digest('hex')
  const ref: FileAttachmentRef = {
    attachmentId: AttachmentId(`sha256:${sha256}`),
    name: fileLeafName(input.name),
    bytes: input.data.byteLength,
  }
  const objectPath = storedFileObjectPath(root, sha256)
  await publishImmutableObject(root, objectPath, input.data, sha256)
  await publishImmutableAlias(root, objectPath, storedFilePath(root, ref), sha256)
  return ref
}

/**
 * 在版本化附件根目录下从有界分块逐字节提交一个文件。
 * @param root - 绝对的 `DSH_HOME/attachments/v1` 根目录。
 * @param input - 按序的确切字节、可选取消信号与显示名称。
 * @returns 持久的内容寻址文件引用。
 */
export async function saveFileStreamVerbatim(
  root: string,
  input: SaveFileStreamAttachment,
): Promise<FileAttachmentRef> {
  const name = fileLeafName(input.name)
  const stored = await publishImmutableObjectStream(
    root,
    input.data,
    sha256 => storedFileObjectPath(root, sha256),
    input.signal,
  )
  const ref: FileAttachmentRef = {
    attachmentId: AttachmentId(`sha256:${stored.sha256}`),
    name,
    bytes: stored.bytes,
  }
  input.signal?.throwIfAborted()
  await publishImmutableAlias(
    root,
    storedFileObjectPath(root, stored.sha256),
    storedFilePath(root, ref),
    stored.sha256,
  )
  input.signal?.throwIfAborted()
  return ref
}

/**
 * 以有界分块读取一个已存储文件，并校验其字节数与摘要。
 * @param root - 绝对的 `DSH_HOME/attachments/v1` 根目录。
 * @param ref - 来自 session 日志的持久文件引用。
 * @param signal - 可选的取消信号，作用于文件系统读取。
 * @returns 按序的确切存储字节；完整性失败在最后一个分块之后拒绝。
 */
export async function* readFileStreamVerbatim(
  root: string,
  ref: FileAttachmentRef,
  signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
  signal?.throwIfAborted()
  const sha256 = ensureFileReference(ref)
  const stream = createReadStream(storedFilePath(root, ref), {
    highWaterMark: 1 << 16,
    ...(signal === undefined ? {} : { signal }),
  })
  const hash = createHash('sha256')
  let bytes = 0
  try {
    for await (const chunk of stream) {
      signal?.throwIfAborted()
      const data = chunk as Buffer
      hash.update(data)
      bytes += data.byteLength
      yield data
    }
  } catch (error) {
    signal?.throwIfAborted()
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new AttachmentError('File attachment object is missing.', 'ATTACHMENT_NOT_FOUND')
    }
    throw new AttachmentError('Unable to read file attachment.', 'ATTACHMENT_READ_FAILED', { cause: error })
  } finally {
    stream.destroy()
  }
  signal?.throwIfAborted()
  if (bytes !== ref.bytes || hash.digest('hex') !== sha256) {
    throw new AttachmentError('Stored file attachment failed integrity verification.', 'ATTACHMENT_CORRUPT')
  }
}
